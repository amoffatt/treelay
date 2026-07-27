/**
 * Compile pipeline — SPEC §6 (the eight steps) and §7 (state).
 *
 *   resolve graph → merge var decls → resolve values → eval computed →
 *   render each layer → merge rendered layers per-file → drop empty-named
 *   files → materialize + persist state.
 *
 * Render-then-merge: a child's op is authored against the parent's *rendered*
 * output, so each layer is rendered before the merge step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";

import { MergeConflictError } from "./errors.js";
import { hashContent } from "./hash.js";
import { applyPatch3Way } from "./merge/patch.js";
import { renderString, templateTarget, DEFAULT_TEMPLATE_SUFFIX } from "./render.js";
import {
  isSidecar,
  sidecarTarget,
  parseSidecar,
  desugarSuffix,
  SIDECAR_SUFFIX,
} from "./sidecar.js";
import { strategyFor, deepMerge, applyMergePatch, applyJsonPatch } from "./merge/index.js";
import { ALWAYS_IGNORE, destExclusions } from "./layer-files.js";
import { parseStructured, stringifyStructured } from "./serde.js";
import {
  writeState,
  lockFromGraph,
  ensureDir,
  type TreelayState,
} from "./state.js";
import type {
  CompileResult,
  Layer,
  MergeStrategy,
  ResolvedGraph,
  SidecarOp,
  SidecarOpKind,
  Values,
} from "./types.js";

export interface CompileOptions {
  destDir: string;
  /** Final variable values (from `resolveValues`). */
  values?: Values;
}


/**
 * One accumulated output file as it builds up across the layer stack. Also the
 * public shape of an in-memory composition (see {@link composeFiles}).
 */
export interface FileEntry {
  data: Buffer;
  strategy: MergeStrategy;
  fromLayer: string;
  patchedFrom: string[];
}

/** A normalized operation on an inherited file (from a sidecar or suffix sugar). */
interface Op {
  kind: SidecarOpKind;
  target: string;
  when?: string;
  render: boolean;
  content?: string;
  merge?: unknown;
  jsonPatch?: unknown[];
  /** Recorded base hash — drift detector for `patch` ops (§5). */
  base?: string;
  /** Recorded base content — enables true diff3 under drift (§5). */
  baseContent?: string;
}

/** Does this string contain Liquid markup worth rendering? */
function needsRender(s: string): boolean {
  return s.includes("{{") || s.includes("{%");
}

/**
 * Compose a graph into an in-memory file map, writing nothing.
 *
 * This is the whole pipeline minus materialization, split out because `update`
 * (§7) needs the *would-be* output to merge against a project that already
 * exists — recompiling straight onto disk would destroy the very edits it is
 * trying to preserve.
 *
 * `destDir` is only used to prune a destination nested inside the source tree,
 * so a compose is safe to run with the real destination path.
 */
export async function composeFiles(
  graph: ResolvedGraph,
  values: Values = {},
  destDir?: string,
): Promise<Map<string, FileEntry>> {
  const acc = new Map<string, FileEntry>();
  for (const layer of graph.layers) {
    await applyLayer(layer, acc, values, destDir);
  }
  return acc;
}

/** Provenance + baseline bookkeeping derived from a composition. */
export function summarize(acc: ReadonlyMap<string, FileEntry>): {
  result: CompileResult;
  baseline: Record<string, string>;
  manifest: TreelayState["manifest"];
} {
  const result: CompileResult = { files: {} };
  const baseline: Record<string, string> = {};
  const manifest: TreelayState["manifest"] = {};

  for (const [rel, entry] of acc) {
    result.files[rel] = {
      fromLayer: entry.fromLayer,
      strategy: entry.strategy,
      owned: false,
      ...(entry.patchedFrom.length ? { patchedFrom: entry.patchedFrom } : {}),
    };
    baseline[rel] = hashContent(entry.data);
    manifest[rel] = { owned: false, fromLayer: entry.fromLayer };
  }
  return { result, baseline, manifest };
}

/** Materialize a resolved graph into a destination directory. */
export async function compile(
  graph: ResolvedGraph,
  options: CompileOptions,
): Promise<CompileResult> {
  const values = options.values ?? {};
  const acc = await composeFiles(graph, values, options.destDir);

  // Compose fully before writing anything: a conflict partway through must not
  // leave a half-built destination behind (§5).
  const { result, baseline, manifest } = summarize(acc);
  const snapshot = new Map<string, Buffer>();

  for (const [rel, entry] of acc) {
    const abs = join(options.destDir, rel);
    ensureDir(abs);
    writeFileSync(abs, entry.data);
    snapshot.set(rel, entry.data);
  }

  const state: TreelayState = {
    lock: lockFromGraph(graph),
    answers: values,
    baseline,
    manifest,
  };
  writeState(options.destDir, state, graph.variables, snapshot);

  return result;
}

/** Apply a single layer's files, then its ops, onto the accumulator. */
async function applyLayer(
  layer: Layer,
  acc: Map<string, FileEntry>,
  values: Values,
  destDir?: string,
): Promise<void> {
  const suffix = layer.manifest.templateSuffix ?? DEFAULT_TEMPLATE_SUFFIX;
  const renderAllText = layer.manifest.render === "all-text";
  const arrays = layer.manifest.arrays ?? "replace";

  const entries = fg.sync("**/*", {
    cwd: layer.dir,
    dot: true,
    onlyFiles: true,
    // A destination nested inside this layer is pruned so a recompile never
    // folds its own prior output back in (§7).
    ignore: [
      ...ALWAYS_IGNORE,
      ...(layer.manifest.ignore ?? []),
      ...destExclusions(layer.dir, destDir),
    ],
  });

  const ops: Op[] = [];

  for (const rel of entries.sort()) {
    const raw = readFileSync(join(layer.dir, rel));
    // The template suffix is outermost: strip-and-render first, then look at the
    // inner name to see whether it's a sidecar / suffix-op / plain file.
    const { render: isTmpl, outPath: inner } = templateTarget(rel, suffix);

    if (isSidecar(inner)) {
      ops.push(sidecarToOp(raw.toString("utf8"), inner, isTmpl, values));
      continue;
    }

    const sugar = desugarSuffix(inner);
    if (sugar) {
      ops.push({
        kind: sugar.op,
        target: await renderPath(sugar.target, values),
        render: isTmpl,
        content: raw.toString("utf8"),
      });
      continue;
    }

    // Plain file. Render the path always (when it has markup), the content only
    // when it opted in via the suffix (or the layer is render: all-text).
    const target = await renderPath(inner, values);
    if (target.trim() === "") continue; // conditional file dropped (§6 step 7)

    const doRenderContent = isTmpl || (renderAllText && looksTextual(inner));
    const data = doRenderContent
      ? Buffer.from(await renderString(raw.toString("utf8"), values), "utf8")
      : raw;

    mergeFile(acc, target, data, layer, arrays);
  }

  for (const op of ops) await applyOp(acc, op, values);
}

/** Render a relative path through Liquid when it carries markup. */
async function renderPath(path: string, values: Values): Promise<string> {
  return needsRender(path) ? renderString(path, values) : path;
}

/** Parse a sidecar's YAML (optionally rendered) into a normalized Op. */
function sidecarToOp(
  yamlText: string,
  innerPath: string,
  isTmpl: boolean,
  _values: Values,
): Op {
  const sc: SidecarOp = parseSidecar(yamlText);
  const op: Op = {
    kind: sc.op,
    target: sidecarTarget(innerPath),
    render: sc.render ?? false,
  };
  if (sc.when !== undefined) op.when = sc.when;
  if (sc.base !== undefined) op.base = sc.base;
  if (sc.baseContent !== undefined) op.baseContent = sc.baseContent;
  if (sc.content !== undefined) op.content = sc.content;
  if (sc.merge !== undefined) op.merge = sc.merge;
  if (sc.jsonPatch !== undefined) op.jsonPatch = sc.jsonPatch;
  if (sc.patch !== undefined) op.content = sc.patch; // unified-diff payload (§5)
  // `isTmpl` (the sidecar file itself was *.tmpl) is reserved for rendering the
  // YAML before parse; sidecars are rarely templated, so we keep it simple.
  void isTmpl;
  return op;
}

/** Merge a plain file's data into the accumulator under its target path. */
function mergeFile(
  acc: Map<string, FileEntry>,
  target: string,
  data: Buffer,
  layer: Layer,
  arrays: Layer["manifest"]["arrays"],
): void {
  const strategy = strategyFor(target, layer.manifest.merge);
  const existing = acc.get(target);

  if (!existing) {
    acc.set(target, { data, strategy, fromLayer: layer.id, patchedFrom: [] });
    return;
  }

  switch (strategy) {
    case "replace":
      existing.data = data;
      existing.fromLayer = layer.id;
      existing.strategy = strategy;
      break;
    case "deep-merge": {
      const merged = deepMerge(
        parseStructured(target, existing.data.toString("utf8")),
        parseStructured(target, data.toString("utf8")),
        arrays ?? "replace",
      );
      existing.data = Buffer.from(stringifyStructured(target, merged), "utf8");
      existing.patchedFrom.push(existing.fromLayer);
      existing.fromLayer = layer.id;
      existing.strategy = strategy;
      break;
    }
    case "append":
      existing.data = Buffer.concat([existing.data, data]);
      existing.patchedFrom.push(layer.id);
      break;
    case "prepend":
      existing.data = Buffer.concat([data, existing.data]);
      existing.patchedFrom.push(layer.id);
      break;
    case "delete":
      acc.delete(target);
      break;
    case "patch":
      // The glob declared this path's files to *be* unified diffs, so the
      // higher layer's content is a patch onto the inherited file. No recorded
      // base is possible here (a plain file carries no metadata), so this is
      // best-effort apply — the sidecar form exists for when that matters.
      existing.data = Buffer.from(
        applyPatch3Way({
          file: target,
          current: existing.data.toString("utf8"),
          patch: data.toString("utf8"),
        }),
        "utf8",
      );
      existing.strategy = "patch";
      existing.patchedFrom.push(layer.id);
      break;
  }
}

/** Apply a sidecar/suffix operation onto the accumulator (§4). */
async function applyOp(
  acc: Map<string, FileEntry>,
  op: Op,
  values: Values,
): Promise<void> {
  if (op.when !== undefined) {
    const w = (await renderString(op.when, values)).trim();
    if (w === "" || w === "false") return; // conditional op skipped
  }

  const existing = acc.get(op.target);
  const content =
    op.content !== undefined && op.render
      ? await renderString(op.content, values)
      : op.content;

  switch (op.kind) {
    case "delete":
      acc.delete(op.target);
      return;

    case "replace": {
      const data = Buffer.from(content ?? "", "utf8");
      if (existing) {
        existing.data = data;
        existing.patchedFrom.push("sidecar");
      } else {
        acc.set(op.target, {
          data,
          strategy: "replace",
          fromLayer: "sidecar",
          patchedFrom: [],
        });
      }
      return;
    }

    case "append":
    case "prepend": {
      const add = Buffer.from(content ?? "", "utf8");
      const base = existing?.data ?? Buffer.alloc(0);
      const data =
        op.kind === "append"
          ? Buffer.concat([base, add])
          : Buffer.concat([add, base]);
      if (existing) {
        existing.data = data;
        existing.patchedFrom.push("sidecar");
      } else {
        acc.set(op.target, {
          data,
          strategy: op.kind,
          fromLayer: "sidecar",
          patchedFrom: [],
        });
      }
      return;
    }

    case "merge": {
      // Structured patch (RFC 7386 merge / RFC 6902 json-patch) onto the file.
      const baseData = existing
        ? parseStructured(op.target, existing.data.toString("utf8"))
        : {};
      const result = op.jsonPatch
        ? applyJsonPatch(baseData, op.jsonPatch)
        : applyMergePatch(baseData, op.merge ?? {});
      setStructured(acc, op, existing, result);
      return;
    }

    case "patch": {
      // A patch edits an inherited file; with nothing to inherit there is no
      // "super()" to call, so this is an authoring error, not a silent create.
      if (!existing) {
        throw new MergeConflictError(
          op.target,
          "patch has nothing to apply to — the file is not produced by any " +
            "lower layer (never created, or removed by a tombstone). " +
            "Ship the full file instead of a patch, or drop the tombstone.",
        );
      }
      const current = existing.data.toString("utf8");
      existing.data = Buffer.from(
        applyPatch3Way({
          file: op.target,
          current,
          patch: content ?? "",
          ...resolvePatchBase(op, current),
        }),
        "utf8",
      );
      existing.strategy = "patch";
      existing.patchedFrom.push("sidecar");
      return;
    }
  }
}

/**
 * Decide what base content (if any) a patch can be reconciled against (§5).
 *
 * - Explicit `baseContent` wins, and its hash is verified when `base` is also
 *   recorded — a mismatch means the sidecar contradicts itself.
 * - Otherwise a recorded `base` hash that still matches the inherited file
 *   proves the file has not drifted, so the file *is* the base and the patch is
 *   guaranteed to apply.
 * - A recorded hash that no longer matches means drift with no way to
 *   reconstruct the original, so we hand back no base: `applyPatch3Way` then
 *   relocates what it can and fails loud on the rest, rather than blindly
 *   applying a patch we know was authored against different content.
 */
function resolvePatchBase(op: Op, current: string): { base?: string } {
  if (op.baseContent !== undefined) {
    if (op.base !== undefined && hashContent(op.baseContent) !== op.base.trim()) {
      throw new MergeConflictError(
        op.target,
        `sidecar is inconsistent: \`baseContent\` hashes to ` +
          `${hashContent(op.baseContent)} but \`base\` records ${op.base}.`,
      );
    }
    return { base: op.baseContent };
  }
  if (op.base !== undefined && hashContent(current) === op.base.trim()) {
    return { base: current };
  }
  return {};
}

/** Write a structured (parsed) value back into the accumulator. */
function setStructured(
  acc: Map<string, FileEntry>,
  op: Op,
  existing: FileEntry | undefined,
  value: unknown,
): void {
  const data = Buffer.from(stringifyStructured(op.target, value), "utf8");
  if (existing) {
    existing.data = data;
    existing.patchedFrom.push("sidecar");
  } else {
    acc.set(op.target, {
      data,
      strategy: "deep-merge",
      fromLayer: "sidecar",
      patchedFrom: [],
    });
  }
}

/** Coarse text/binary guess by extension, for `render: all-text` mode. */
function looksTextual(path: string): boolean {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz|tar|exe|bin)$/i.test(
    path,
  );
}

// Re-exported for callers that need the sidecar suffix constant alongside compile.
export { SIDECAR_SUFFIX };
