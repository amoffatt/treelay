/**
 * Structural findings from a composition — SPEC §4.
 *
 * Composition can do two things that destroy or fabricate content while every
 * command downstream reports success:
 *
 *   - **replacement** — a higher layer ships a file at a path a lower layer also
 *     ships, and the lower layer's content is discarded wholesale;
 *   - **orphan op** — an `append`/`prepend`/`patch`/`merge` whose target no
 *     lower layer produces, so there is nothing to operate on.
 *
 * Both failure modes are *absence*, which is the hardest thing to notice: the
 * tree still compiles, the tests still pass, the content is simply not there.
 * That is what makes them worth a first-class report rather than a footnote.
 *
 * Findings are collected by `composeFiles` while it merges, so they describe
 * what actually happened rather than re-deriving it from what was declared —
 * one traversal, one implementation, nothing for `explain` and `compile` to
 * disagree about. `validate` turns them into issues; `compile` prints a pointer.
 */

import type { SidecarOpKind } from "./types.js";

/**
 * A higher layer's file wholly discarding a lower layer's at the same path.
 *
 * Only *undeclared* replacements are recorded. A manifest `merge` glob naming
 * the path, or a `.treelay` sidecar with `op: replace`, is the author saying
 * "I mean to replace this" — a warning nobody can silence legitimately is a
 * warning everyone learns to ignore.
 */
export interface Replacement {
  /** Output path whose inherited content was discarded. */
  path: string;
  /** Display name of the layer whose content survives. */
  by: string;
  /** Display name of the layer whose content was discarded. */
  over: string;
  /** The winning layer's source file, so the finding is pointable. */
  source: string;
}

/** An op whose target no lower layer produces (§4). */
export interface OrphanOp {
  /** The inherited file the op claims to modify. */
  path: string;
  op: SidecarOpKind;
  /** Display name of the layer that declared the op. */
  by: string;
  /** The op's source file within that layer. */
  source: string;
}

/** Everything a compose noticed about its own structure. */
export interface ComposeAudit {
  replacements: Replacement[];
  /**
   * Orphan ops seen while composing.
   *
   * Only populated under `onOrphanOp: "collect"`. The default is to throw on the
   * first one, because a build that ships a document starting halfway through is
   * worse than a build that fails.
   */
  orphanOps: OrphanOp[];
}

/** A fresh collector, ready to be handed to `composeFiles`. */
export const emptyAudit = (): ComposeAudit => ({
  replacements: [],
  orphanOps: [],
});

/** True when a compose found nothing structurally surprising. */
export const auditIsClean = (audit: ComposeAudit): boolean =>
  audit.replacements.length === 0 && audit.orphanOps.length === 0;

/** One indented line per replacement, in composition order. */
export function describeReplacements(
  replacements: readonly Replacement[],
): string {
  const width = Math.max(0, ...replacements.map((r) => r.path.length));
  return replacements
    .map((r) => `  ${r.path.padEnd(width)}  ${r.by} replaces ${r.over}`)
    .join("\n");
}

/** One indented line per orphan op, in composition order. */
export function describeOrphanOps(orphans: readonly OrphanOp[]): string {
  const width = Math.max(0, ...orphans.map((o) => o.source.length));
  return orphans
    .map(
      (o) =>
        `  ${o.source.padEnd(width)}  ${o.op} onto ${o.path}, which no lower layer produces`,
    )
    .join("\n");
}
