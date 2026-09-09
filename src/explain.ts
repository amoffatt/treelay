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
import { join, resolve as resolvePath } from "node:path";

import {
  displayName,
  enumerateLayer,
  mountTarget,
  type LayerEntry,
} from "./layer-files.js";
import { parseSidecar } from "./sidecar.js";
import { renderString } from "./render.js";
import { strategyFor } from "./merge/index.js";
import { resolve as resolveGraph } from "./resolve.js";
import { canonicalRef, parseRef } from "./refs.js";
import { readState, hasState } from "./state.js";
import { composeToMemory } from "./verify.js";
import { emptyAudit, type DroppedArray } from "./audit.js";
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
  /**
   * Arrays in this file whose inherited elements a higher layer discarded (§4).
   *
   * `patchedFrom` says a lower layer was folded in, which is true of the file's
   * object keys and false of any list `replace` threw away. Rather than judge
   * that a second time here, these come straight from the compose audit.
   */
  droppedArrays?: DroppedArray[];
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

  // Classification is done by *identity*, never by re-resolving. A remote ref
  // resolved a second time here could land on a different commit than the graph
  // was built from — and would hit the network to do it, in a read-only
  // command. A layer's id already is its absolute dir (local) or its canonical
  // ref (fetched), so matching against that is both exact and free.
  const mixinIds = new Set<string>();
  if (self) {
    for (const ref of self.manifest.mixins ?? []) {
      try {
        const parsed = parseRef(ref);
        mixinIds.add(
          parsed.kind === "local"
            ? resolvePath(self.dir, parsed.path)
            : canonicalRef(parsed),
        );
      } catch {
        // An unparseable ref simply stays unclassified; explain never throws.
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
        : mixinIds.has(layer.id)
          ? "mixin"
          : "parent",
    position: i + 1,
    writable: layer.writable,
    ...(layer.origin?.ref ? { ref: layer.origin.ref } : {}),
    ...(layer.origin?.revision ? { revision: layer.origin.revision } : {}),
    ...(layer.mountPath ? { mountPath: layer.mountPath } : {}),
  }));
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
    // Array policy affects bytes, not which layers contributed — except when
    // `replace` discards a list, which `droppedArrays` reports from the audit.
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
  const dropsByPath = await auditDroppedArrays(graph, values, options.destDir);

  const files: Record<string, FileExplanation> = {};
  for (const path of [...history.keys()].sort()) {
    const state = live.get(path);
    const drops = dropsByPath.get(path);
    files[path] = {
      path,
      contributions: history.get(path)!,
      present: state !== undefined,
      patchedFrom: state?.patchedFrom ?? [],
      ...(state ? { winner: state.fromLayer, strategy: state.strategy } : {}),
      ...(drops ? { droppedArrays: drops } : {}),
    };
  }

  return { layers: summaries, files };
}

/**
 * Compose once purely to collect dropped arrays, grouped by output path.
 *
 * Explaining is a diagnostic, so paying for a compose is worth a report that
 * cannot contradict what `compile` would actually do. A compose that fails has
 * nothing to say about discarded arrays — `validate` is where that failure gets
 * reported — so explanation continues without the annotation rather than
 * failing a read-only command.
 */
async function auditDroppedArrays(
  graph: ResolvedGraph,
  values: Values,
  destDir: string | undefined,
): Promise<Map<string, DroppedArray[]>> {
  const byPath = new Map<string, DroppedArray[]>();
  const audit = emptyAudit();
  try {
    await composeToMemory(graph, values, destDir, {
      onOrphanOp: "collect",
      audit,
    });
  } catch {
    return byPath;
  }
  for (const drop of audit.droppedArrays) {
    const list = byPath.get(drop.path);
    if (list) list.push(drop);
    else byPath.set(drop.path, [drop]);
  }
  return byPath;
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
      // Qualified, not omitted: the lower layer's keys really were folded in,
      // so claiming otherwise would be its own kind of wrong.
      const partial = file.droppedArrays?.length ? " (keys only — see below)" : "";
      lines.push(`  folded in: ${names.join(", ")}${partial}`);
    }
    for (const drop of file.droppedArrays ?? []) {
      lines.push(
        `  dropped: ${drop.dropped} inherited ` +
          `${drop.dropped === 1 ? "entry" : "entries"} at ${drop.pointer} ` +
          `(${drop.by} replaced ${drop.over}'s array)`,
      );
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
