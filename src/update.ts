/**
 * Living-template update — SPEC §7.
 *
 * Reloads saved answers (prompting only for newly-introduced variables),
 * recompiles `theirs`, and three-way merges against the baseline (`base`) and
 * the working copy (`ours`), then rewrites the baseline.
 *
 * The whole resolution is computed before anything is written. `update` touches
 * a project the user has been working in, so a failure partway through must
 * leave that project exactly as it was rather than half-updated.
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { composeFiles, summarize, type FileEntry } from "./compile.js";
import { hashContent } from "./hash.js";
import { mergeText3 } from "./merge/patch.js";
import { mergeStructured3 } from "./merge/structured.js";
import { resolve } from "./resolve.js";
import { parseStructured, stringifyStructured, structuredFormat } from "./serde.js";
import {
  readState,
  readBaselineFile,
  writeState,
  lockFromGraph,
  ensureDir,
  sourceOf,
  type TreelayState,
} from "./state.js";
import { resolveValues } from "./variables.js";
import type { Values, VariableDecl } from "./types.js";

/** How each file was resolved. */
export type Resolution =
  | "take-theirs"
  | "keep-ours"
  | "merged"
  | "conflict"
  | "delete"
  /** All three sides agree — nothing to do. Lets a no-op update say so. */
  | "unchanged";

export interface UpdateOptions {
  /**
   * How conflicts are surfaced:
   * - `markers` (default) — write the merged file with diff3 conflict markers.
   * - `rej` — leave the working file untouched and drop the incoming version
   *   beside it as `<file>.rej`, for projects where a file must stay parseable.
   */
  onConflict?: "markers" | "rej";
  /** CLI `--set k=v` overrides applied over saved answers. */
  set?: Record<string, unknown>;
  /** Prompt for variables the new template version introduced (default true). */
  prompt?: boolean;
}

export interface UpdatePlan {
  /** Per file: the resolution that update would apply. */
  files: Record<string, Resolution>;
  /** Paths that could not be merged cleanly. */
  conflicts: string[];
  /** Variables the new template version introduced and now has answers for. */
  newVariables: string[];
}

/** One file's decided outcome, held in memory until the whole plan is known. */
interface Decision {
  path: string;
  resolution: Resolution;
  /** Content to write at `path`, when the resolution produces one. */
  write?: Buffer;
  /** Content to write at `path.rej` (conflict, `rej` mode). */
  rej?: Buffer;
  /** Remove the file from the working tree. */
  remove?: boolean;
}

/** A NUL byte is the usual signal that text merging would be meaningless. */
function isBinary(data: Buffer): boolean {
  return data.includes(0);
}

/**
 * Merge one file's three versions.
 *
 * Text merging runs first even for JSON/YAML, because it preserves the file's
 * formatting and comments. Only when it conflicts do we retry structurally,
 * where two sides editing unrelated keys merge cleanly regardless of how close
 * those keys sit in the file — at the cost of reserializing (§7).
 */
function mergeOne(
  path: string,
  base: string,
  ours: string,
  theirs: string,
): { clean: boolean; text: string } {
  const text = mergeText3({ base, ours, theirs });
  if (text.clean) return text;

  if (structuredFormat(path)) {
    try {
      const merged = mergeStructured3(
        parseStructured(path, base),
        parseStructured(path, ours),
        parseStructured(path, theirs),
      );
      if (merged.clean) {
        return { clean: true, text: stringifyStructured(path, merged.value) };
      }
    } catch {
      // Unparseable on some side (often because a previous update left markers
      // in it) — the text merge's conflict output stands.
    }
  }
  return text;
}

/** Compute every file's outcome without touching the working tree. */
async function planFrom(
  destDir: string,
  options: UpdateOptions,
): Promise<{
  decisions: Decision[];
  plan: UpdatePlan;
  theirs: Map<string, FileEntry>;
  values: Values;
  state: TreelayState;
  lineage: string[];
  variables: Record<string, VariableDecl>;
}> {
  const state = readState(destDir);
  const src = sourceOf(state);
  if (!src) {
    throw new Error(
      `${destDir}: .treelay/lock.json records no lineage, so there is no ` +
        `template to update from. Recompile with \`treelay compile <src> ${destDir}\`.`,
    );
  }
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(
      `${destDir}: the template it was compiled from is gone (${src}). ` +
        `Restore it, or recompile from its new location.`,
    );
  }

  const graph = resolve(src);

  // Saved answers are pre-supplied, so `resolveValues` only prompts for
  // variables the new template version added (§7).
  const newVariables = Object.keys(graph.variables).filter(
    (name) => !(name in state.answers),
  );
  const values = await resolveValues(graph, {
    answers: state.answers,
    ...(options.set ? { set: options.set } : {}),
    prompt: options.prompt !== false,
  });

  const theirs = await composeFiles(graph, values, destDir);

  const decisions: Decision[] = [];
  const files: Record<string, Resolution> = {};
  const conflicts: string[] = [];

  const paths = [
    ...new Set([...Object.keys(state.baseline), ...theirs.keys()]),
  ].sort();

  for (const path of paths) {
    const decision = decide(destDir, path, state, theirs, options);
    decisions.push(decision);
    files[path] = decision.resolution;
    if (decision.resolution === "conflict") conflicts.push(path);
  }

  return {
    decisions,
    plan: { files, conflicts, newVariables },
    theirs,
    values,
    state,
    lineage: lockFromGraph(graph).lineage,
    variables: graph.variables,
  };
}

/** Resolve a single path against base / ours / theirs (§7's case table). */
function decide(
  destDir: string,
  path: string,
  state: TreelayState,
  theirsMap: Map<string, FileEntry>,
  options: UpdateOptions,
): Decision {
  const baseHash = state.baseline[path];
  const theirsEntry = theirsMap.get(path);
  const abs = join(destDir, path);
  const ours = existsSync(abs) ? readFileSync(abs) : undefined;

  // The template no longer produces this file.
  if (!theirsEntry) {
    if (!ours) return { path, resolution: "unchanged" };
    if (baseHash !== undefined && hashContent(ours) === baseHash) {
      return { path, resolution: "delete", remove: true };
    }
    // Edited locally and removed upstream — dropping it would discard the
    // user's work silently, so make them decide.
    return conflictOver(path, ours, undefined, options);
  }

  const theirs = theirsEntry.data;

  // Newly introduced by the template.
  if (baseHash === undefined) {
    if (!ours) return { path, resolution: "take-theirs", write: theirs };
    if (ours.equals(theirs)) return { path, resolution: "unchanged" };
    // The user already had a file where the template now wants to put one.
    return conflictOver(path, ours, theirs, options);
  }

  if (!ours) {
    // Deleted locally. If the template didn't change it, respect the deletion.
    if (hashContent(theirs) === baseHash) return { path, resolution: "keep-ours" };
    return conflictOver(path, undefined, theirs, options);
  }

  const oursUnchanged = hashContent(ours) === baseHash;
  const theirsUnchanged = hashContent(theirs) === baseHash;

  if (oursUnchanged && theirsUnchanged) return { path, resolution: "unchanged" };
  if (oursUnchanged) return { path, resolution: "take-theirs", write: theirs };
  if (theirsUnchanged) return { path, resolution: "keep-ours" };
  if (ours.equals(theirs)) return { path, resolution: "unchanged" };

  // Both sides changed. Merge if we can read all three as text — and only if
  // the snapshot still matches the recorded hash, so a stale base becomes a
  // conflict rather than a silently wrong merge.
  const base = readBaselineFile(destDir, path, baseHash);
  if (!base || isBinary(base) || isBinary(ours) || isBinary(theirs)) {
    return conflictOver(path, ours, theirs, options);
  }

  const merged = mergeOne(
    path,
    base.toString("utf8"),
    ours.toString("utf8"),
    theirs.toString("utf8"),
  );
  if (merged.clean) {
    return { path, resolution: "merged", write: Buffer.from(merged.text, "utf8") };
  }
  return conflictOver(path, ours, theirs, options, Buffer.from(merged.text, "utf8"));
}

/**
 * Build a conflict decision honouring `onConflict`. In `markers` mode the
 * merged-with-markers text is written in place; in `rej` mode the working file
 * is left exactly as it is and the incoming version lands at `<path>.rej`.
 */
function conflictOver(
  path: string,
  ours: Buffer | undefined,
  theirs: Buffer | undefined,
  options: UpdateOptions,
  markers?: Buffer,
): Decision {
  if ((options.onConflict ?? "markers") === "rej") {
    return {
      path,
      resolution: "conflict",
      ...(ours ? {} : { write: Buffer.alloc(0) }),
      ...(theirs ? { rej: theirs } : { rej: Buffer.alloc(0) }),
    };
  }
  // Markers mode needs something to write; without a mergeable pair (a delete
  // conflict, or binary) fall back to the incoming version so the change is at
  // least visible, or keep ours when there is no incoming content.
  const write = markers ?? theirs ?? ours;
  return { path, resolution: "conflict", ...(write ? { write } : {}) };
}

/** Dry-run: compute the per-file 3-way resolution without writing (§10). */
export async function planUpdate(
  destDir: string,
  options: UpdateOptions = {},
): Promise<UpdatePlan> {
  // Never prompt on a dry run — a plan should not have side effects.
  const { plan } = await planFrom(destDir, { ...options, prompt: false });
  return plan;
}

/** Apply a template update into an existing destination. */
export async function update(
  destDir: string,
  options: UpdateOptions = {},
): Promise<UpdatePlan> {
  const { decisions, plan, theirs, values, variables, lineage } = await planFrom(
    destDir,
    options,
  );

  // Everything above is pure. Only now do we touch the project.
  for (const d of decisions) {
    const abs = join(destDir, d.path);
    if (d.remove) {
      rmSync(abs, { force: true });
      continue;
    }
    if (d.write) {
      ensureDir(abs);
      writeFileSync(abs, d.write);
    }
    if (d.rej) {
      ensureDir(abs);
      writeFileSync(abs + ".rej", d.rej);
    }
  }

  // The baseline records what the template last produced, which is `theirs`
  // regardless of how each merge landed. Advancing it unconditionally is what
  // makes a repeated update a no-op, and stops a conflict from being re-offered
  // every single time.
  const { baseline, manifest } = summarize(theirs);
  const snapshot = new Map<string, Buffer>();
  for (const [rel, entry] of theirs) snapshot.set(rel, entry.data);

  writeState(
    destDir,
    { lock: { lineage, versions: {} }, answers: values, baseline, manifest },
    variables,
    snapshot,
  );

  return plan;
}
