/**
 * Living-template update — SPEC §7.
 *
 * Reloads saved answers (prompting only for newly-introduced variables),
 * recompiles `theirs`, and three-way merges against the baseline (`base`) and
 * the working copy (`ours`), then rewrites the baseline.
 */

import { NotImplementedError } from "./errors.js";

export interface UpdateOptions {
  /** How conflicts are surfaced. */
  onConflict?: "markers" | "rej";
  /** CLI `--set k=v` overrides applied over saved answers. */
  set?: Record<string, unknown>;
}

export interface UpdatePlan {
  /** Per file: the resolution that update would apply. */
  files: Record<
    string,
    "take-theirs" | "keep-ours" | "merged" | "conflict" | "delete"
  >;
}

/** Dry-run: compute the per-file 3-way resolution without writing (§10). */
export async function planUpdate(_destDir: string): Promise<UpdatePlan> {
  throw new NotImplementedError("planUpdate");
}

/** Apply a template update into an existing destination. */
export async function update(
  _destDir: string,
  _options: UpdateOptions = {},
): Promise<UpdatePlan> {
  // TODO(§7): reload answers → prompt new vars → recompile theirs → per-file
  // 3-way (base/ours/theirs) → write results → rewrite baseline.
  throw new NotImplementedError("update");
}
