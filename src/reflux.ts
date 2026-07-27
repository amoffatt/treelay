/**
 * Reflux — pushing instance edits back up the graph — SPEC §8.
 *
 * `compile` is instantiation; reflux is "pull member up". `status` lists what
 * diverged from the baseline and blames the layer that produced it, `promote`
 * pushes a change into an existing ancestor, and `extract` factors it into a
 * brand-new overlay.
 *
 * Every write-back runs the three guards of §8:
 *
 *   1. **Precedence shadowing** — refuse a target a higher layer would override,
 *      because the change would silently vanish on the next recompile.
 *   2. **Round-trip verification** — recompile and assert the destination
 *      reproduces byte-for-byte, rolling back the layer writes if it doesn't.
 *   3. **Blast radius** — report which other layers and compiled destinations
 *      the target feeds before the change reaches them.
 *
 * Guards 1 and 2 divide the work: guard 1 catches the cases that provably
 * cannot work (a wholesale override sits above the target) with a precise,
 * actionable message; guard 2 catches everything subtler — partial merges,
 * append ordering, re-render losses — by simply checking whether the graph
 * reproduces reality.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { createPatch } from "diff";
import fg from "fast-glob";
import { stringify as stringifyYaml } from "yaml";

import { hashContent } from "./hash.js";
import { explain, type Contribution, type ExplainResult } from "./explain.js";
import { resolve as resolveGraph, resolveRef } from "./resolve.js";
import { STATE_DIR, readState, writeState, lockFromGraph } from "./state.js";
import { SIDECAR_SUFFIX } from "./sidecar.js";
import { parseStructured } from "./serde.js";
import { generateMergePatch } from "./merge/structured.js";
import { blastRadius, commonAncestor, describeBlastRadius } from "./blast-radius.js";
import { roundTripVerify, composeToMemory, describeMismatches } from "./verify.js";
import type { BlastRadius } from "./blast-radius.js";
import type {
  Change,
  Layer,
  LayerRef,
  ResolvedGraph,
  Values,
} from "./types.js";

/**
 * Actions that set a file's whole content. A contribution of this kind sitting
 * *above* a promotion target means the promoted bytes can never survive — the
 * definition of precedence shadowing (§8 guard 1).
 *
 * Partial actions (deep-merge, append, prepend, patch, merge) are deliberately
 * absent: they transform rather than discard, so whether the promotion survives
 * is a question only a real recompile can answer. Guard 2 answers it.
 */
const WHOLESALE_ACTIONS = new Set(["create", "replace", "delete"]);

/** Structured formats get a merge patch; everything else a unified diff (§5). */
const STRUCTURED = /\.(json|ya?ml|toml)$/i;

/** Everything reflux needs about a destination, loaded once. */
interface Context {
  destDir: string;
  srcDir: string;
  graph: ResolvedGraph;
  values: Values;
  explanation: ExplainResult;
  baseline: Record<string, string>;
  manifest: Record<string, { owned: boolean; fromLayer: string }>;
}

async function loadContext(destDir: string): Promise<Context> {
  const state = readState(destDir);
  const srcDir = state.lock.lineage[state.lock.lineage.length - 1];
  if (!srcDir) throw new Error(`Corrupt lockfile in ${destDir}: empty lineage.`);

  const graph = resolveGraph(srcDir);
  const explanation = await explain(graph, { values: state.answers, destDir });
  return {
    destDir,
    srcDir,
    graph,
    values: state.answers,
    explanation,
    baseline: state.baseline,
    manifest: state.manifest,
  };
}

/** Files currently in the destination, ignoring its `.treelay/` state dir. */
function destFiles(destDir: string): string[] {
  return fg
    .sync("**/*", {
      cwd: destDir,
      dot: true,
      onlyFiles: true,
      ignore: [`${STATE_DIR}/**`],
    })
    .sort();
}

const layerName = (layer: Layer) => layer.manifest.name ?? relative(dirname(layer.dir), layer.dir);

function layerById(graph: ResolvedGraph, id: string): Layer | undefined {
  return graph.layers.find((l) => l.id === id);
}

function nameOf(graph: ResolvedGraph, id: string): string {
  const layer = layerById(graph, id);
  return layer ? layerName(layer) : id;
}

/** Stack position of a layer, 1-based; 0 when it is not in the graph. */
function positionOf(graph: ResolvedGraph, id: string): number {
  return graph.layers.findIndex((l) => l.id === id) + 1;
}

/**
 * Contributions above `position` that would wholly override the file.
 * Empty means a promotion to that position is not *provably* futile.
 */
function shadowers(
  explanation: ExplainResult,
  path: string,
  position: number,
): Contribution[] {
  const file = explanation.files[path];
  if (!file) return [];
  return file.contributions.filter(
    (c) => c.position > position && !c.skipped && WHOLESALE_ACTIONS.has(c.action),
  );
}

// ---------------------------------------------------------------- status

/** List changes in a destination vs its baseline, with provenance (§8). */
export async function status(destDir: string): Promise<Change[]> {
  const ctx = await loadContext(destDir);
  const present = new Set(destFiles(destDir));
  const changes: Change[] = [];

  for (const [path, recorded] of Object.entries(ctx.baseline)) {
    if (!present.has(path)) {
      changes.push(annotate(ctx, { path, kind: "deleted" }));
      continue;
    }
    const actual = hashContent(readFileSync(join(destDir, path)));
    if (actual !== recorded) {
      changes.push(annotate(ctx, { path, kind: "modified" }));
    }
  }

  for (const path of present) {
    if (path in ctx.baseline) continue;
    changes.push(annotate(ctx, { path, kind: "added" }));
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Attach producing layer, patch chain, and viable promotion targets. */
function annotate(ctx: Context, change: Change): Change {
  const file = ctx.explanation.files[change.path];
  const producing = file?.winner ?? ctx.manifest[change.path]?.fromLayer;

  // A target is viable when it is writable and nothing above it would
  // wholesale-override the file (§8 guard 1) — the "where could this go"
  // question `status` exists to answer.
  const targets = ctx.graph.layers
    .filter((l) => l.writable)
    .filter((l) => shadowers(ctx.explanation, change.path, positionOf(ctx.graph, l.id)).length === 0)
    .map((l) => l.id);

  return {
    ...change,
    ...(producing ? { producingLayer: producing } : {}),
    ...(file?.patchedFrom.length ? { patchedBy: file.patchedFrom } : {}),
    ...(file ? {} : { owned: true }),
    targets,
  };
}

/** Render `status` output in the annotated form of SPEC §8. */
export function formatStatus(changes: Change[], graph: ResolvedGraph): string {
  if (changes.length === 0) return "No changes vs baseline.";
  const mark = { modified: "M", added: "A", deleted: "D" } as const;
  const width = Math.max(...changes.map((c) => c.path.length));

  return changes
    .map((c) => {
      const path = c.path.padEnd(width);
      if (!c.producingLayer) return `  A  ${path}  ← local-only (no template origin)`;
      const patched = c.patchedBy?.length
        ? `  (+ patched by ${c.patchedBy.map((id) => nameOf(graph, id)).join(", ")})`
        : "";
      return `  ${mark[c.kind]}  ${path}  ← produced by ${nameOf(graph, c.producingLayer)}${patched}`;
    })
    .join("\n");
}

// --------------------------------------------------------------- promote

/** How a promoted change was written into its target layer. */
export type LandingMode = "rewrite" | "patch" | "create" | "tombstone";

export interface LandedChange {
  path: string;
  mode: LandingMode;
  /** File written inside the target layer, relative to the layer root. */
  wrote: string;
}

export interface PromoteResult {
  /** Layer id promoted into. */
  target: string;
  targetName: string;
  landed: LandedChange[];
  verified: boolean;
  blastRadius: BlastRadius;
  /** Human-readable §8 guard 3 warning. */
  blastRadiusWarning: string;
}

export interface PromoteOptions {
  /** Target layer to promote into; if omitted, auto-suggest from provenance. */
  to?: LayerRef;
  /** Recompile and assert byte-identity after promoting (default true). */
  verify?: boolean;
  /** Root for the blast-radius scan (default: common ancestor of the graph). */
  searchRoot?: string;
}

/**
 * Promote changes up into a target layer. Throws on precedence-shadowing,
 * read-only targets, or a failed round-trip verification (§8 guards). Generates
 * a `.treelay` sidecar recording both `base` and `baseContent` when the change
 * lands as a patch rather than a rewrite (§5).
 */
export async function promote(
  destDir: string,
  changes: Change[],
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  if (changes.length === 0) throw new Error("promote: no changes given.");
  const ctx = await loadContext(destDir);

  const target = resolveTarget(ctx, changes, options.to);
  const position = positionOf(ctx.graph, target.id);

  if (!target.writable) {
    throw new Error(
      `Cannot promote into ${layerName(target)}: the layer is read-only.\n` +
        `Promote into a writable layer above it, or capture the change as a patch there (§8).`,
    );
  }

  // Guard 1 — precedence shadowing, checked for every path before writing any.
  for (const change of changes) {
    const blocked = shadowers(ctx.explanation, change.path, position);
    if (blocked.length) {
      const names = [...new Set(blocked.map((c) => c.name))].join(", ");
      throw new Error(
        `Promoting ${change.path} to ${layerName(target)} has no effect; ` +
          `${names} overrides this file at a higher precedence.\n` +
          `Promote to ${names} or to the leaf instead (§8 guard 1).`,
      );
    }
  }

  const tx = new LayerTransaction();
  let landed: LandedChange[];
  try {
    landed = [];
    for (const change of changes) {
      landed.push(await landChange(ctx, change, target, position, tx));
    }
  } catch (err) {
    tx.rollback();
    throw err;
  }

  // Guard 2 — round-trip verification against a freshly resolved graph, since
  // the layer we just wrote to may have changed what resolution produces.
  const verify = options.verify !== false;
  if (verify) {
    const regraph = resolveGraph(ctx.srcDir);
    const removed = changes.filter((c) => c.kind === "deleted").map((c) => c.path);
    const result = await roundTripVerify(destDir, regraph, ctx.values, {
      expectAbsent: removed,
    });
    if (!result.ok) {
      tx.rollback();
      throw new Error(
        `Round-trip verification failed after promoting to ${layerName(target)} — ` +
          `the recompiled template does not reproduce the working copy, so the ` +
          `promotion was rolled back (§8 guard 2):\n${describeMismatches(result.mismatches)}`,
      );
    }
    rebaseline(ctx, regraph, result.composed);
  }

  // Guard 3 — blast radius, reported (not enforced) once the change has landed.
  const searchRoot =
    options.searchRoot ?? commonAncestor([...ctx.graph.layers.map((l) => l.dir), destDir]);
  const radius = blastRadius(target.dir, {
    searchRoot,
    excludeDest: destDir,
    excludeLayer: ctx.srcDir,
  });

  return {
    target: target.id,
    targetName: layerName(target),
    landed,
    verified: verify,
    blastRadius: radius,
    blastRadiusWarning: describeBlastRadius(radius, layerName(target)),
  };
}

/** Pick the target layer: explicit `--to`, else the provenance suggestion. */
function resolveTarget(ctx: Context, changes: Change[], to?: LayerRef): Layer {
  if (to) {
    const dir = to.startsWith(".") || to.startsWith("/") ? resolveRef(to, ctx.srcDir) : to;
    const layer = ctx.graph.layers.find((l) => l.id === dir || layerName(l) === to);
    if (!layer) {
      const known = ctx.graph.layers.map((l) => layerName(l)).join(", ");
      throw new Error(`Unknown promotion target "${to}". Layers in this composition: ${known}.`);
    }
    return layer;
  }

  const suggestions = new Set(
    changes.map((c) => c.producingLayer ?? ctx.explanation.files[c.path]?.winner ?? ctx.srcDir),
  );
  if (suggestions.size > 1) {
    const names = [...suggestions].map((id) => nameOf(ctx.graph, id)).join(", ");
    throw new Error(
      `These changes come from different layers (${names}), so there is no single ` +
        `suggested target. Promote them separately, or pass an explicit target.`,
    );
  }
  const [only] = [...suggestions];
  const layer = layerById(ctx.graph, only!);
  if (!layer) throw new Error(`Suggested target ${only} is not part of the composition.`);
  return layer;
}

/** Write one change into the target layer, recording undo in `tx`. */
async function landChange(
  ctx: Context,
  change: Change,
  target: Layer,
  position: number,
  tx: LayerTransaction,
): Promise<LandedChange> {
  const file = ctx.explanation.files[change.path];

  if (change.kind === "deleted") {
    // When the target itself is the sole producer, removing its source file is
    // cleaner than layering a tombstone on top of the layer's own content.
    const own = file?.contributions.find((c) => c.layer === target.id);
    if (own && file!.contributions.length === 1) {
      tx.remove(join(target.dir, own.source));
      return { path: change.path, mode: "tombstone", wrote: own.source };
    }
    const sidecar = change.path + SIDECAR_SUFFIX;
    tx.write(join(target.dir, sidecar), stringifyYaml({ op: "delete" }));
    return { path: change.path, mode: "tombstone", wrote: sidecar };
  }

  const desired = readFileSync(join(ctx.destDir, change.path), "utf8");

  // The target already produces this file: rewrite its own source in place,
  // reusing the exact source path so a templated source does not gain a
  // duplicate plain-file sibling.
  const own = file?.contributions.find((c) => c.layer === target.id && c.kind === "file");
  if (own) {
    tx.write(join(target.dir, own.source), desired);
    return { path: change.path, mode: "rewrite", wrote: own.source };
  }

  // A lower layer produces it and the target does not: record only the delta,
  // so the target stays a focused overlay rather than a full copy.
  const inherited = await inheritedBelow(ctx, position, change.path);
  if (inherited !== undefined) {
    const sidecar = change.path + SIDECAR_SUFFIX;
    tx.write(
      join(target.dir, sidecar),
      buildPatchSidecar(change.path, inherited, desired),
    );
    return { path: change.path, mode: "patch", wrote: sidecar };
  }

  // Nothing below produces it — a genuinely new file for this layer.
  tx.write(join(target.dir, change.path), desired);
  return { path: change.path, mode: "create", wrote: change.path };
}

/**
 * The content a file has just *below* a given stack position — the base a
 * promoted patch is authored against.
 *
 * Composing the sub-stack through the real compiler is what keeps this honest:
 * it accounts for every merge, op and render that produced the inherited text,
 * rather than re-deriving it with a second implementation that could disagree.
 */
async function inheritedBelow(
  ctx: Context,
  position: number,
  path: string,
): Promise<string | undefined> {
  if (position <= 1) return undefined;
  const below: ResolvedGraph = {
    layers: ctx.graph.layers.slice(0, position - 1),
    variables: ctx.graph.variables,
  };
  const composed = await composeToMemory(below, ctx.values);
  return composed.get(path)?.toString("utf8");
}

/**
 * Build the sidecar for a patch-mode promotion.
 *
 * Both `base` and `baseContent` are recorded (§5): the hash detects that the
 * inherited file drifted, and the content is what lets diff3 actually reconcile
 * once it has. Reflux has the base text in hand, so there is no reason to emit
 * the weaker hash-only form that hand-authored sidecars are limited to.
 */
function buildPatchSidecar(path: string, base: string, desired: string): string {
  if (STRUCTURED.test(path)) {
    // Structured formats have no line drift, so a merge patch is strictly
    // better than a diff — but the hash still buys drift detection.
    return stringifyYaml({
      op: "merge",
      base: hashContent(base),
      merge: generateMergePatch(parseStructured(path, base), parseStructured(path, desired)),
    });
  }

  return stringifyYaml({
    op: "patch",
    base: hashContent(base),
    baseContent: base,
    patch: createPatch(path, base, desired, undefined, undefined, { context: 3 }),
  });
}

/**
 * Rewrite the baseline so a verified promotion counts as "from template" and
 * drops off the local-changes list (§8) — it now flows down by inheritance.
 */
function rebaseline(
  ctx: Context,
  graph: ResolvedGraph,
  composed: Map<string, Buffer>,
): void {
  const baseline: Record<string, string> = {};
  const manifest: Record<string, { owned: boolean; fromLayer: string }> = {};
  for (const [path, data] of composed) {
    baseline[path] = hashContent(data);
    manifest[path] = {
      owned: false,
      fromLayer: ctx.manifest[path]?.fromLayer ?? ctx.srcDir,
    };
  }
  writeState(
    ctx.destDir,
    { lock: lockFromGraph(graph), answers: ctx.values, baseline, manifest },
    graph.variables,
  );
}

// --------------------------------------------------------------- extract

export interface ExtractOptions {
  /** Path for the new overlay layer. */
  as: string;
  /** Wire it into the leaf's `mixins` (vs leaving it free-standing). */
  asMixin?: boolean;
  /** Name for the new layer's manifest (default: its directory name). */
  name?: string;
  /** Recompile and assert byte-identity afterwards (default true when wired). */
  verify?: boolean;
}

export interface ExtractResult {
  /** Absolute path of the new layer. */
  layer: string;
  name: string;
  files: string[];
  /** Whether the leaf was rewired to consume the new layer. */
  wired: boolean;
  verified: boolean;
}

/**
 * Capture changes as a new overlay layer (§8).
 *
 * A free-standing extraction (`asMixin: false`) deliberately skips round-trip
 * verification and leaves the baseline alone: the new layer is not in the graph
 * yet, so the destination provably *cannot* reproduce from it. Verifying would
 * fail by construction, and rewriting the baseline would falsely mark the edits
 * as inherited.
 */
export async function extract(
  destDir: string,
  changes: Change[],
  options: ExtractOptions,
): Promise<ExtractResult> {
  if (changes.length === 0) throw new Error("extract: no changes given.");
  const ctx = await loadContext(destDir);

  const layerDir = resolvePath(ctx.srcDir, options.as);
  if (existsSync(join(layerDir, "treelay.json"))) {
    throw new Error(`A layer already exists at ${layerDir}. Choose another path.`);
  }
  const name = options.name ?? layerDir.split("/").filter(Boolean).pop()!;

  const tx = new LayerTransaction();
  const written: string[] = [];
  try {
    tx.write(join(layerDir, "treelay.json"), JSON.stringify({ name }, null, 2) + "\n");

    for (const change of changes) {
      if (change.kind === "deleted") {
        const sidecar = change.path + SIDECAR_SUFFIX;
        tx.write(join(layerDir, sidecar), stringifyYaml({ op: "delete" }));
        written.push(sidecar);
        continue;
      }
      tx.write(
        join(layerDir, change.path),
        readFileSync(join(destDir, change.path), "utf8"),
      );
      written.push(change.path);
    }

    if (options.asMixin) wireMixin(ctx, options.as, tx);
  } catch (err) {
    tx.rollback();
    throw err;
  }

  const wired = options.asMixin === true;
  const shouldVerify = wired && options.verify !== false;
  let verified = false;

  if (shouldVerify) {
    const regraph = resolveGraph(ctx.srcDir);
    const removed = changes.filter((c) => c.kind === "deleted").map((c) => c.path);
    const result = await roundTripVerify(destDir, regraph, ctx.values, {
      expectAbsent: removed,
    });
    if (!result.ok) {
      tx.rollback();
      throw new Error(
        `Round-trip verification failed after extracting ${name} — rolled back ` +
          `(§8 guard 2):\n${describeMismatches(result.mismatches)}`,
      );
    }
    rebaseline(ctx, regraph, result.composed);
    verified = true;
  }

  return { layer: layerDir, name, files: written.sort(), wired, verified };
}

/** Append the new layer to the leaf manifest's `mixins`, highest precedence. */
function wireMixin(ctx: Context, ref: string, tx: LayerTransaction): void {
  const manifestPath = join(ctx.srcDir, "treelay.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Cannot wire the extracted layer in: ${ctx.srcDir} has no treelay.json. ` +
        `Extract without --mixin and add it by hand.`,
    );
  }
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { mixins?: string[] };
  const mixins = [...(manifest.mixins ?? []), ref];
  tx.write(manifestPath, JSON.stringify({ ...manifest, mixins }, null, 2) + "\n");
}

// ----------------------------------------------------------- transaction

/**
 * A minimal undo log for layer writes.
 *
 * Round-trip verification is only meaningful if a failure leaves nothing
 * behind — a half-written layer would be worse than no promotion at all, since
 * the next compile would pick it up.
 */
class LayerTransaction {
  private undo: Array<() => void> = [];

  write(path: string, content: string): void {
    const existed = existsSync(path);
    const previous = existed ? readFileSync(path) : undefined;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    this.undo.push(() => {
      if (previous !== undefined) writeFileSync(path, previous);
      else rmSync(path, { force: true });
    });
  }

  remove(path: string): void {
    if (!existsSync(path)) return;
    const previous = readFileSync(path);
    rmSync(path, { force: true });
    this.undo.push(() => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, previous);
    });
  }

  rollback(): void {
    for (const step of this.undo.reverse()) step();
    this.undo = [];
  }
}
