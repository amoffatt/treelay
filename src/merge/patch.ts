/** Unified-diff 3-way merge — SPEC §5. */

import { NotImplementedError } from "../errors.js";

/**
 * Apply a unified diff onto `current` using a recorded `base` for true 3-way
 * merge. When `base` is provided, reconcile (base → current) against
 * (base → patched); otherwise fall back to best-effort apply.
 *
 * Returns the merged text, or throws MergeConflictError — never half-applies.
 */
export function applyPatch3Way(_args: {
  file: string;
  current: string;
  patch: string;
  base?: string;
}): string {
  // TODO(§5): use `diff`/`node-diff3` — diff3 merge when `base` is present,
  // else `Diff.applyPatch` with fail-loud on rejection.
  throw new NotImplementedError("applyPatch3Way");
}
