/**
 * Unified-diff 3-way merge — SPEC §5.
 *
 * Two paths, chosen by whether the caller can supply the base *content* the
 * patch was authored against:
 *
 * - **base known** → reconstruct the author's intent (`base` → `patched`), then
 *   reconcile it against the drift the inherited file actually took
 *   (`base` → `current`) with a real diff3. This resolves cleanly far more
 *   often than a flat apply and produces honest conflicts when it can't.
 * - **base unknown** → best-effort apply onto `current`. jsdiff searches for
 *   each hunk's location, so hunks that merely *moved* still land; changed
 *   context is rejected rather than guessed at.
 *
 * Either way the function is all-or-nothing: it returns fully merged text or
 * throws `MergeConflictError`. It never returns partially-patched content.
 */

import { applyPatch, parsePatch } from "diff";
import { merge as diff3 } from "node-diff3";
import { MergeConflictError } from "../errors.js";

export interface Patch3WayArgs {
  /** Relative path, for error messages. */
  file: string;
  /** The inherited content the patch should land on. */
  current: string;
  /** Unified diff. Bare `@@` hunks are accepted (no `---`/`+++` headers). */
  patch: string;
  /**
   * The exact content the patch was authored against. When supplied, enables a
   * true 3-way merge; omit it for best-effort apply.
   */
  base?: string;
}

/**
 * Split text into lines losslessly — `fromLines(toLines(t)) === t` for all `t`,
 * including the trailing-newline case (which yields a final `""` element).
 */
function toLines(text: string): string[] {
  return text.split("\n");
}

function fromLines(lines: string[]): string {
  return lines.join("\n");
}

/** Reject an unparseable payload up front, with a clearer message than jsdiff's. */
function assertParseable(file: string, patch: string): void {
  let hunks = 0;
  try {
    hunks = parsePatch(patch).reduce((n, p) => n + p.hunks.length, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // jsdiff reports a header/body length mismatch as "contained invalid line",
    // which sends people hunting for a bad character instead of miscounted
    // hunk headers — the usual mistake when a patch is written by hand.
    const hint = /invalid line/i.test(message)
      ? "\nCheck the `@@ -old,COUNT +new,COUNT @@` header: the counts must match " +
        "the number of lines in the hunk body (context + removals for the first, " +
        "context + additions for the second)."
      : "";
    throw new MergeConflictError(
      file,
      `patch payload is not a valid unified diff — ${message}${hint}`,
    );
  }
  if (hunks === 0) {
    throw new MergeConflictError(
      file,
      "patch payload contains no hunks (expected unified-diff `@@` sections)",
    );
  }
}

/** A short preview of text, for error messages. */
function preview(text: string, maxLines = 20): string {
  const lines = toLines(text);
  return lines.length <= maxLines
    ? text
    : fromLines(lines.slice(0, maxLines)) + `\n… (${lines.length - maxLines} more lines)`;
}

/**
 * Apply a unified diff onto `current`, reconciling against `base` when known.
 *
 * Returns the merged text, or throws MergeConflictError — never half-applies.
 */
export function applyPatch3Way(args: Patch3WayArgs): string {
  const { file, current, patch, base } = args;
  assertParseable(file, patch);

  // No recorded base: best-effort apply. jsdiff relocates moved hunks; anything
  // it can't place is a rejection, and rejections are fatal (§5 "fail loud").
  if (base === undefined) {
    const applied = applyPatch(current, patch);
    if (applied === false) {
      throw new MergeConflictError(
        file,
        "patch does not apply to the inherited content and no base was recorded, " +
          "so it cannot be reconciled.\n" +
          "Record a `base:`/`baseContent:` in the sidecar to enable a three-way merge.\n" +
          `--- patch ---\n${preview(patch)}`,
      );
    }
    return applied;
  }

  // The patch is defined as a delta *from* `base`, so it must apply there. If it
  // doesn't, the sidecar itself is inconsistent — say so rather than blaming the
  // inherited file.
  const patched = applyPatch(base, patch);
  if (patched === false) {
    throw new MergeConflictError(
      file,
      "patch does not apply to its own recorded base — the sidecar is inconsistent " +
        "(`base`/`baseContent` does not match the patch payload).\n" +
        `--- patch ---\n${preview(patch)}`,
    );
  }

  // No drift: the inherited content is exactly what the patch was authored
  // against, so the author's intent is the answer.
  if (current === base) return patched;

  // Drift: reconcile (base → current) against (base → patched).
  const merged = diff3(toLines(current), toLines(base), toLines(patched));
  if (merged.conflict) {
    throw new MergeConflictError(
      file,
      "three-way merge conflict — the inherited file changed in the same region " +
        "the patch edits.\n" +
        "Re-author the patch against the current content, or resolve by hand.\n" +
        `--- conflict ---\n${preview(fromLines(merged.result as string[]))}`,
    );
  }
  return fromLines(merged.result as string[]);
}
