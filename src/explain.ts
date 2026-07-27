/**
 * `explain` — per-file provenance across the layer stack (SPEC §9, §12 step 7).
 *
 * The debugging story for a system whose whole job is "this file came from
 * somewhere non-obvious": for every output path, which layers contributed, via
 * which strategy, in what precedence order, and which one won.
 *
 * Read-only. It walks the same enumeration as `compile` (see `layer-files.ts`)
 * and mirrors its accumulation bookkeeping — `winner`/`strategy`/`patchedFrom`
 * are defined to match `CompileResult.files[path]` exactly, and a test asserts
 * that equivalence so the two cannot drift apart silently.
 *
 * Unlike compile, explain never throws on a not-yet-implemented strategy: a
 * unified-diff patch is *described* rather than applied, so `explain` stays
 * useful precisely where a build is failing.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { enumerateLayer, mountTarget, type LayerEntry } from "./layer-files.js";
import { parseSidecar } from "./sidecar.js";
import { renderString } from "./render.js";
import { strategyFor } from "./merge/index.js";
import { resolve as resolveGraph, resolveRef } from "./resolve.js";
import { readState, hasState } from "./state.js";
import type {
  Layer,
  MergeStrategy,
  ResolvedGraph,
  SidecarOpKind,
  Values,
} from "./types.js";

/** Why a layer is in the stack (§1, §3). */
export type LayerRole = "parent" | "mixin" | "self" | "mount";

/** What a contribution did to the accumulating file. */
export type ContributionAction =
  | "create"
  | "replace"
  | "deep-merge"
  | "append"
  | "prepend"
  | "delete"
  | "merge"
  | "patch";

/** A layer's position and identity within the resolved stack. */
export interface LayerSummary {
  id: string;
  name: string;
  role: LayerRole;
  /** 1-based position, lowest precedence first. */
  position: number;
  writable: boolean;
  /** Canonical ref this layer was fetched from (§3); absent for local layers. */
  ref?: string;
  /** Exact revision materialized — commit SHA or package version. */
  revision?: string;
  /** Subpath a mounted layer's files are re-rooted under (§3). */
  mountPath?: string;
}

/** One layer's contribution to one output path. */
export interface Contribution {
  layer: string;
  name: string;
  role: LayerRole;
  position: number;
  /** Source file within the layer that produced this contribution. */
  source: string;
  action: ContributionAction;
  /** How the file would be combined at this step (§4). */
  strategy: MergeStrategy;
  kind: LayerEntry["kind"];
  /** Recorded base hash from a sidecar, enabling true 3-way merge (§5). */
  base?: string;
  /** True when a `when:` guard evaluated falsy and the op was skipped (§4). */
  skipped?: boolean;
  /** Human note (unsupported strategy, unrendered path, …). */
  note?: string;
}

/** The full provenance of one output path. */
export interface FileExplanation {
  path: string;
  /** In precedence order, lowest → highest. */
  contributions: Contribution[];
  /** Whether the file survives to the output (false ⇒ tombstoned). */
  present: boolean;
  /** Layer id whose content won — mirrors `CompileResult.files[path].fromLayer`. */
  winner?: string;
  /** Winning strategy — mirrors `CompileResult.files[path].strategy`. */
  strategy?: MergeStrategy;
  /** Layers whose patches/merges were folded in — mirrors `patchedFrom`. */
  patchedFrom: string[];
  /** True for a destination file with no template origin (user-owned, §7). */
  owned?: boolean;
}

/** The whole composition, explained. */
export interface ExplainResult {
  layers: LayerSummary[];
  /** Keyed by output path, insertion-ordered by path. */
  files: Record<string, FileExplanation>;
}

export interface ExplainOptions {
  /** Variable values used to render templated paths and `when:` guards (§6). */
  values?: Values;
  /** A destination nested inside a layer, pruned from the walk (§7). */
  destDir?: string;
}

/** Mutable per-path state while walking the stack — mirrors compile's FileEntry. */
interface Live {
  strategy: MergeStrategy;
  fromLayer: string;
  patchedFrom: string[];
}

/** Classify each layer by why it is in the stack. */
export function summarizeLayers(graph: ResolvedGraph): LayerSummary[] {
  const self = graph.layers[graph.layers.length - 1];
  const mixinDirs = new Set<string>();
  if (self) {
    for (const ref of self.manifest.mixins ?? []) {
      try {
        mixinDirs.add(resolveRef(ref, self.dir));
      } catch {
        // Unresolvable mixin refs (npm/git, pending §2) simply stay unclassified.
      }
    }
  }

  return graph.layers.map((layer, i) => ({
    id: layer.id,
    name: displayName(layer),
    role: layer.mountPath
      ? "mount"
      : layer === self
        ? "self"
        : mixinDirs.has(layer.dir)
          ? "mixin"
          : "parent",
    position: i + 1,
    writable: layer.writable,
    ...(layer.origin?.ref ? { ref: layer.origin.ref } : {}),
    ...(layer.origin?.revision ? { revision: layer.origin.revision } : {}),
    ...(layer.mountPath ? { mountPath: layer.mountPath } : {}),
  }));
}

function displayName(layer: Layer): string {
  // A fetched layer's directory is a cache path, which says nothing useful; its
  // manifest name, or failing that its ref, is what a reader recognizes.
  if (layer.manifest.name) return layer.manifest.name;
  if (layer.mountPath) return `${layer.mountPath}/`;
  return layer.origin?.ref ?? basename(layer.dir);
}

/** Render a path through Liquid, tolerating missing values (explain is read-only). */
async function tryRenderPath(
  path: string,
  values: Values,
): Promise<{ path: string; note?: string }> {
  if (!path.includes("{{") && !path.includes("{%")) return { path };
  try {
    return { path: await renderString(path, values) };
  } catch {
    // `plan`-style usage without answers: describe the template, don't fail.
    return { path, note: "path left unrendered (no value for its variables)" };
  }
}

/** Explain every output path produced by a resolved graph. */
export async function explain(
  graph: ResolvedGraph,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  const values = options.values ?? {};
  const summaries = summarizeLayers(graph);
  const live = new Map<string, Live>();
  const history = new Map<string, Contribution[]>();
  const deleted = new Set<string>();

  const record = (target: string, c: Contribution) => {
    const list = history.get(target);
    if (list) list.push(c);
    else history.set(target, [c]);
  };

  for (const [i, layer] of graph.layers.entries()) {
    const summary = summaries[i]!;
    const arrays = layer.manifest.arrays ?? "replace";
    void arrays; // array policy affects bytes, not provenance
    const entries = enumerateLayer(layer, options.destDir);

    // Two passes per layer, matching compile: plain files first, then ops.
    const ops: LayerEntry[] = [];

    for (const entry of entries) {
      if (entry.kind !== "file") {
        ops.push(entry);
        continue;
      }

      const rendered = await tryRenderPath(entry.rawTarget, values);
      if (rendered.path.trim() === "") continue; // conditional file dropped (§6 step 7)
      const target = mountTarget(layer, rendered.path);

      const strategy = strategyFor(target, layer.manifest.merge);
      const existing = live.get(target);
      const base: Omit<Contribution, "action"> = {
        layer: layer.id,
        name: summary.name,
        role: summary.role,
        position: summary.position,
        source: entry.source,
        strategy,
        kind: entry.kind,
        ...(rendered.note ? { note: rendered.note } : {}),
      };

      if (!existing) {
        live.set(target, { strategy, fromLayer: layer.id, patchedFrom: [] });
        deleted.delete(target);
        record(target, { ...base, action: "create" });
        continue;
      }

      switch (strategy) {
        case "replace":
          existing.fromLayer = layer.id;
          existing.strategy = strategy;
          record(target, { ...base, action: "replace" });
          break;
        case "deep-merge":
          existing.patchedFrom.push(existing.fromLayer);
          existing.fromLayer = layer.id;
          existing.strategy = strategy;
          record(target, { ...base, action: "deep-merge" });
          break;
        case "append":
        case "prepend":
          existing.patchedFrom.push(layer.id);
          record(target, { ...base, action: strategy });
          break;
        case "delete":
          live.delete(target);
          deleted.add(target);
          record(target, { ...base, action: "delete" });
          break;
        case "patch":
          record(target, {
            ...base,
            action: "patch",
            note: "unified-diff patch via merge glob (§5) — described, not applied",
          });
          break;
      }
    }

    for (const entry of ops) {
      await explainOp(entry, layer, summary, values, live, deleted, record);
    }
  }

  // Assemble, sorted by path for stable output.
  const files: Record<string, FileExplanation> = {};
  for (const path of [...history.keys()].sort()) {
    const state = live.get(path);
    files[path] = {
      path,
      contributions: history.get(path)!,
      present: state !== undefined,
      patchedFrom: state?.patchedFrom ?? [],
      ...(state ? { winner: state.fromLayer, strategy: state.strategy } : {}),
    };
  }

  return { layers: summaries, files };
}

/** Explain one sidecar/suffix op, mirroring compile's `applyOp` bookkeeping. */
async function explainOp(
  entry: LayerEntry,
  layer: Layer,
  summary: LayerSummary,
  values: Values,
  live: Map<string, Live>,
  deleted: Set<string>,
  record: (target: string, c: Contribution) => void,
): Promise<void> {
  let op: SidecarOpKind | undefined = entry.op;
  let baseHash: string | undefined;
  let when: string | undefined;

  if (entry.kind === "sidecar") {
    try {
      const sc = parseSidecar(readFileSync(join(layer.dir, entry.source), "utf8"));
      op = sc.op;
      baseHash = sc.base;
      when = sc.when;
    } catch (err) {
      record(mountTarget(layer, entry.rawTarget), {
        layer: layer.id,
        name: summary.name,
        role: summary.role,
        position: summary.position,
        source: entry.source,
        action: "replace",
        strategy: "replace",
        kind: entry.kind,
        skipped: true,
        note: `unreadable sidecar: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
  if (!op) return;

  const rendered = await tryRenderPath(entry.rawTarget, values);
  const target = mountTarget(layer, rendered.path);

  const contribution: Contribution = {
    layer: layer.id,
    name: summary.name,
    role: summary.role,
    position: summary.position,
    source: entry.source,
    action: op as ContributionAction,
    strategy: op === "merge" ? "deep-merge" : (op as MergeStrategy),
    kind: entry.kind,
    ...(baseHash ? { base: baseHash } : {}),
    ...(rendered.note ? { note: rendered.note } : {}),
  };

  if (when !== undefined) {
    let truthy = true;
    try {
      const w = (await renderString(when, values)).trim();
      truthy = !(w === "" || w === "false");
    } catch {
      truthy = false;
    }
    if (!truthy) {
      record(target, {
        ...contribution,
        skipped: true,
        note: `skipped: \`when: ${when}\` evaluated falsy`,
      });
      return;
    }
  }

  const existing = live.get(target);

  switch (op) {
    case "delete":
      live.delete(target);
      deleted.add(target);
      break;
    case "replace":
    case "append":
    case "prepend":
      if (existing) existing.patchedFrom.push("sidecar");
      else
        live.set(target, {
          strategy: op === "replace" ? "replace" : op,
          fromLayer: "sidecar",
          patchedFrom: [],
        });
      break;
    case "merge":
      if (existing) existing.patchedFrom.push("sidecar");
      else
        live.set(target, {
          strategy: "deep-merge",
          fromLayer: "sidecar",
          patchedFrom: [],
        });
      break;
    case "patch":
      contribution.note =
        "unified-diff 3-way patch (§5) — described, not applied" +
        (baseHash ? "" : "; no recorded base ⇒ best-effort apply");
      break;
  }

  record(target, contribution);
}

/** Explain a single output path; undefined when no layer touches it. */
export async function explainFile(
  graph: ResolvedGraph,
  path: string,
  options: ExplainOptions = {},
): Promise<FileExplanation | undefined> {
  const result = await explain(graph, options);
  return result.files[path];
}

/**
 * Explain a compiled destination (§7).
 *
 * The lockfile's lineage records absolute layer dirs lowest → highest, so its
 * last entry *is* the source root: a destination can reconstruct its own graph
 * and re-explain itself with the answers it was built from. Files the template
 * does not own are reported as user-owned rather than omitted.
 */
export async function explainDest(destDir: string): Promise<ExplainResult> {
  if (!hasState(destDir)) {
    throw new Error(
      `No .treelay state in ${destDir} — not a compiled destination. ` +
        `Point \`explain\` at a source layer directory instead.`,
    );
  }
  const state = readState(destDir);
  const src = state.lock.lineage[state.lock.lineage.length - 1];
  if (!src) throw new Error(`Corrupt lockfile in ${destDir}: empty lineage.`);

  const result = await explain(resolveGraph(src), {
    values: state.answers,
    destDir,
  });

  for (const [path, entry] of Object.entries(state.manifest)) {
    const file = result.files[path];
    if (file) file.owned = entry.owned;
  }
  return result;
}

/** Render an explanation as aligned, human-readable text. */
export function formatExplanation(
  result: ExplainResult,
  only?: string,
): string {
  const lines: string[] = [];

  lines.push("Layers (lowest → highest precedence):");
  for (const l of result.layers) {
    const marks = [
      l.mountPath ? `mounted at ${l.mountPath}/` : undefined,
      l.revision ? `pinned ${shortRevision(l.revision)}` : undefined,
      l.writable ? undefined : "read-only",
    ].filter(Boolean);
    const flags = marks.length ? `  [${marks.join(", ")}]` : "";
    lines.push(`  ${l.position}. ${l.name}  (${l.role})${flags}`);
  }
  lines.push("");

  const paths = only ? [only] : Object.keys(result.files);
  if (only && !result.files[only]) {
    lines.push(`No layer contributes to "${only}".`);
    return lines.join("\n");
  }

  for (const path of paths) {
    const file = result.files[path]!;
    const status = file.present
      ? `← ${nameOf(result, file.winner)} (${file.strategy})`
      : "← removed (tombstoned)";
    lines.push(`${path}  ${status}`);

    for (const c of file.contributions) {
      const marks = [
        c.skipped ? "skipped" : undefined,
        c.kind === "sidecar" ? "sidecar" : c.kind === "suffix" ? "suffix" : undefined,
        c.base ? `base ${c.base.slice(0, 14)}…` : undefined,
      ].filter(Boolean);
      const suffix = marks.length ? `  [${marks.join(", ")}]` : "";
      lines.push(
        `  ${c.position}. ${pad(c.name, 18)} ${pad(c.role, 7)} ${pad(c.action, 11)} ${c.source}${suffix}`,
      );
      if (c.note) lines.push(`       note: ${c.note}`);
    }

    if (file.patchedFrom.length) {
      const names = file.patchedFrom.map((id) => nameOf(result, id));
      lines.push(`  folded in: ${names.join(", ")}`);
    }
    if (file.owned) lines.push("  user-owned (not produced by the template)");
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/** Commit SHAs are abbreviated for display; package versions are already short. */
function shortRevision(rev: string): string {
  return /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 12) : rev;
}

function nameOf(result: ExplainResult, id?: string): string {
  if (!id) return "—";
  return result.layers.find((l) => l.id === id)?.name ?? id;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
