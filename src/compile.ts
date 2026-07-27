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

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";

import { NotImplementedError } from "./errors.js";
import { renderString, templateTarget, DEFAULT_TEMPLATE_SUFFIX } from "./render.js";
import {
  isSidecar,
  sidecarTarget,
  parseSidecar,
  desugarSuffix,
  SIDECAR_SUFFIX,
} from "./sidecar.js";
import { strategyFor, deepMerge, applyMergePatch, applyJsonPatch } from "./merge/index.js";
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

/** Globs never materialized into the output (manifest + reserved dirs). */
const ALWAYS_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  ".treelay/**",
  "**/.treelay/**",
  "**/treelay.json",
  "**/treelay.yaml",
  "**/treelay.yml",
];

/** One accumulated output file as it builds up across the layer stack. */
interface FileEntry {
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
  base?: string;
}

/** Does this string contain Liquid markup worth rendering? */
function needsRender(s: string): boolean {
  return s.includes("{{") || s.includes("{%");
}

function hash(data: Buffer): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Materialize a resolved graph into a destination directory. */
export async function compile(
  graph: ResolvedGraph,
  options: CompileOptions,
): Promise<CompileResult> {
  const values = options.values ?? {};
  const acc = new Map<string, FileEntry>();

  for (const layer of graph.layers) {
    await applyLayer(layer, acc, values);
  }

  // Materialize + collect provenance and baseline.
  const result: CompileResult = { files: {} };
  const baseline: Record<string, string> = {};
  const manifest: TreelayState["manifest"] = {};

  for (const [rel, entry] of acc) {
    const abs = join(options.destDir, rel);
    ensureDir(abs);
    writeFileSync(abs, entry.data);
    result.files[rel] = {
      fromLayer: entry.fromLayer,
      strategy: entry.strategy,
      owned: false,
      ...(entry.patchedFrom.length ? { patchedFrom: entry.patchedFrom } : {}),
    };
    baseline[rel] = hash(entry.data);
    manifest[rel] = { owned: false, fromLayer: entry.fromLayer };
  }

  const state: TreelayState = {
    lock: lockFromGraph(graph),
    answers: values,
    baseline,
    manifest,
  };
  writeState(options.destDir, state, graph.variables);

  return result;
}

/** Apply a single layer's files, then its ops, onto the accumulator. */
async function applyLayer(
  layer: Layer,
  acc: Map<string, FileEntry>,
  values: Values,
): Promise<void> {
  const suffix = layer.manifest.templateSuffix ?? DEFAULT_TEMPLATE_SUFFIX;
  const renderAllText = layer.manifest.render === "all-text";
  const arrays = layer.manifest.arrays ?? "replace";

  const entries = fg.sync("**/*", {
    cwd: layer.dir,
    dot: true,
    onlyFiles: true,
    ignore: [...ALWAYS_IGNORE, ...(layer.manifest.ignore ?? [])],
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
      throw new NotImplementedError(
        `unified-diff patch via merge glob for "${target}" (§5, build step 5)`,
      );
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

    case "patch":
      // Unified-diff 3-way merge is build step 5 (§5).
      throw new NotImplementedError(
        `unified-diff 3-way patch for "${op.target}" (§5, build step 5)`,
      );
  }
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
