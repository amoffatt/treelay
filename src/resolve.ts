/**
 * Resolve a leaf overlay directory into an ordered, linearized layer stack
 * plus the merged variable schema — SPEC §3, §6.
 *
 * Precedence, lowest → highest: mounts < parents (C3-linearized) < mixins < self.
 *
 * Resolution is synchronous even though it may clone repositories. Every caller
 * in the library and CLI treats `resolve` as a plain function, and a build
 * cannot proceed without its layers anyway, so there is nothing to overlap with
 * — the cost of going async would be paid by every consumer for no gain.
 */

import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import { c3Linearize } from "./c3.js";
import { loadManifest, isWritable } from "./manifest.js";
import { mergeVariableDecls } from "./variables.js";
import { fetchLayer } from "./fetch/index.js";
import { emptyLock, locksEqual, readLock, type TreelayLock } from "./lockfile.js";
import { canonicalRef, parseRef, type RemoteRef } from "./refs.js";
import type { Layer, LayerRef, ResolvedGraph } from "./types.js";

export interface ResolveOptions {
  /**
   * Refuse to resolve any ref the lockfile does not already pin. The CI
   * posture: a build either reproduces from what was committed, or it fails.
   */
  frozen?: boolean;
  /** Re-resolve moving refs to their current upstream revision. */
  updateRefs?: boolean;
  /** Ignore the lockfile entirely — resolve everything live, pin nothing. */
  noLock?: boolean;
  /** Override the fetch cache root (tests). */
  cacheDir?: string;
}

/** Raised when a `mounts` declaration cannot be materialized coherently. */
export class MountError extends Error {
  constructor(mountPath: string, reason: string) {
    super(`Invalid mount "${mountPath}": ${reason}`);
    this.name = "MountError";
  }
}

/** Mutable state threaded through one resolution. */
interface Context {
  root: string;
  options: ResolveOptions;
  cache: Map<string, Layer>;
  /** The lock as it stands on disk — what pinned revisions to honour. */
  existing: TreelayLock;
  /** The lock this resolution produces; only refs actually used appear. */
  next: TreelayLock;
}

/** Resolve a leaf directory into its full composition. */
export function resolve(srcDir: string, options: ResolveOptions = {}): ResolvedGraph {
  const root = isAbsolute(srcDir) ? srcDir : resolvePath(process.cwd(), srcDir);
  const existing = options.noLock ? emptyLock() : readLock(root);
  const ctx: Context = {
    root,
    options,
    cache: new Map(),
    existing,
    next: emptyLock(),
  };

  const self = loadLocal(ctx, root);

  // C3 over the parents graph. `parentsOf` resolves each layer's declared
  // parents — local or fetched — as it walks.
  const parentsOf = (layer: Layer): Layer[] =>
    (layer.manifest.parents ?? []).map((ref) => loadRef(ctx, ref, layer));

  const mro = c3Linearize(self, parentsOf, (l) => l.id); // [self, ...ancestorsHighToLow]
  const parentsLowToHigh = mro.slice(1).reverse();

  // Mixins sit strictly above all parents, in declaration order (last = highest).
  // NOTE: a mixin's own parents are not yet flattened into the stack — TODO once
  // nested-mixin composition is specced out.
  const mixins = (self.manifest.mixins ?? []).map((ref) => loadRef(ctx, ref, self));

  const declared = [...parentsLowToHigh, ...mixins, self];
  const mounts = resolveMounts(ctx, declared);

  const layers = [...mounts, ...declared];
  const variables = mergeVariableDecls(layers);

  return {
    layers,
    variables,
    lock: ctx.next,
    lockDirty: !options.noLock && !locksEqual(existing, ctx.next),
    lockDir: root,
  };
}

/**
 * Resolve the `mounts` declared across the stack into re-rooted layers (§3).
 *
 * Mount *paths* merge by ordinary layer precedence — the highest layer that
 * names `packages` decides which ref is used — which is what lets a leaf hold a
 * vendored tree back at an older pin while its parents float. There is nothing
 * package-specific about it: it is the same override rule as everything else.
 *
 * The resulting layers sit at the **bottom** of the stack, below every declared
 * layer. Vendored content is substrate: any layer, including the one that
 * declared the mount, must be able to patch or tombstone a file inside it, and
 * that only works if the mount is beneath them all. Placing a mount next to its
 * declaring layer would instead make an intermediate layer's patch depend on
 * which ancestor happened to win the ref.
 */
function resolveMounts(ctx: Context, declared: readonly Layer[]): Layer[] {
  // Lowest → highest, last writer wins, remembering who won so the ref resolves
  // relative to the right directory.
  const winners = new Map<string, { ref: LayerRef; from: Layer }>();
  for (const layer of declared) {
    for (const [path, ref] of Object.entries(layer.manifest.mounts ?? {})) {
      winners.set(normalizeMount(path), { ref, from: layer });
    }
  }
  if (!winners.size) return [];

  const paths = [...winners.keys()].sort();
  for (let i = 1; i < paths.length; i++) {
    const prev = paths[i - 1]!;
    if (paths[i]!.startsWith(prev + "/")) {
      throw new MountError(
        paths[i]!,
        `it nests inside mount "${prev}". Overlapping mounts have no ` +
          `unambiguous owner — give them disjoint paths.`,
      );
    }
  }

  return paths.map((path) => {
    const { ref, from } = winners.get(path)!;
    const base = loadRef(ctx, ref, from);
    return {
      ...base,
      // A mount is a distinct stack position, so it needs a distinct identity:
      // the same ref may legitimately be mounted at two paths.
      id: `mount:${path}`,
      mountPath: path,
      // Vendored trees are never promotion targets. Reflux maps output paths
      // back to layer paths, and a mounted layer's output paths carry a prefix
      // its sources do not — so it is read-only until that mapping exists (§8).
      writable: false,
    };
  });
}

/** Validate and normalize a mount path into a relative posix subpath. */
function normalizeMount(path: string): string {
  const clean = path.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") {
    throw new MountError(path, "a mount needs a non-empty subpath");
  }
  if (isAbsolute(clean) || clean.startsWith("/")) {
    throw new MountError(path, "mount paths are relative to the composed tree root");
  }
  if (clean.split("/").includes("..")) {
    throw new MountError(path, "mount paths may not escape the composed tree");
  }
  return clean;
}

/** Load a local layer directory, memoized by absolute path. */
function loadLocal(ctx: Context, dir: string): Layer {
  const cached = ctx.cache.get(dir);
  if (cached) return cached;
  const layer: Layer = {
    id: dir,
    dir,
    manifest: loadManifest(dir),
    writable: isWritable(dir),
    origin: { kind: "local" },
  };
  ctx.cache.set(dir, layer);
  return layer;
}

/** Resolve one declared reference from `from` into a loaded layer. */
function loadRef(ctx: Context, ref: LayerRef, from: Layer): Layer {
  const parsed = parseRef(ref);
  if (parsed.kind === "local") return loadLocal(ctx, resolveLocalRef(ref, from.dir));

  const key = canonicalRef(parsed);
  const cached = ctx.cache.get(key);
  if (cached) {
    recordRequester(ctx, key, from);
    return cached;
  }

  const fetched = fetchLayer(parsed as RemoteRef, {
    fromDir: from.dir,
    lock: ctx.existing,
    ...(ctx.options.frozen ? { frozen: true } : {}),
    ...(ctx.options.updateRefs ? { updateRefs: true } : {}),
    ...(ctx.options.cacheDir ? { cacheDir: ctx.options.cacheDir } : {}),
  });

  ctx.next.refs[key] = fetched.entry;
  recordRequester(ctx, key, from);

  const layer: Layer = {
    id: key,
    dir: fetched.dir,
    manifest: loadManifest(fetched.dir),
    // A cache checkout is shared by every project on the machine and is keyed
    // by an immutable revision. Editing it would silently change other builds,
    // so fetched layers are never promotion targets (§8).
    writable: false,
    origin: {
      kind: parsed.kind,
      ref: key,
      revision: fetched.revision,
      integrity: fetched.integrity,
    },
  };
  ctx.cache.set(key, layer);
  return layer;
}

/** Note which layer asked for a ref, for the lockfile's `requestedBy`. */
function recordRequester(ctx: Context, key: string, from: Layer): void {
  const entry = ctx.next.refs[key];
  if (!entry) return;
  // Local layers are recorded relative to the lockfile so the file stays
  // machine-independent and reviewable in a diff.
  const who =
    from.origin?.kind === "local" || from.origin === undefined
      ? relative(ctx.root, from.dir).split("\\").join("/") || "."
      : from.id;
  const list = new Set(entry.requestedBy ?? []);
  list.add(who);
  entry.requestedBy = [...list].sort();
}

/** Resolve a local path reference to an absolute directory. */
function resolveLocalRef(ref: LayerRef, fromDir: string): string {
  const parsed = parseRef(ref);
  const dir = resolvePath(fromDir, parsed.kind === "local" ? parsed.path : ref);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Layer not found: "${ref}" (resolved to ${dir})`);
  }
  return dir;
}

/**
 * Resolve a layer reference to an absolute directory on disk.
 *
 * Retained as the low-level entry point: local paths resolve directly, and
 * fetched refs are materialized into the cache and their root returned.
 */
export function resolveRef(
  ref: LayerRef,
  fromDir: string,
  options: ResolveOptions & { lock?: TreelayLock } = {},
): string {
  const parsed = parseRef(ref);
  if (parsed.kind === "local") return resolveLocalRef(ref, fromDir);
  return fetchLayer(parsed as RemoteRef, {
    fromDir,
    lock: options.lock ?? emptyLock(),
    ...(options.frozen ? { frozen: true } : {}),
    ...(options.updateRefs ? { updateRefs: true } : {}),
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
  }).dir;
}
