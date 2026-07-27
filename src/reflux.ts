/**
 * Reflux — pushing instance edits back up the graph — SPEC §8.
 *
 * `status` lists changes vs baseline annotated with the producing layer;
 * `promote` pushes selected changes into a chosen (or auto-suggested) layer;
 * `extract` captures them as a brand-new overlay. Both end with a round-trip
 * recompile-and-verify and refuse read-only or shadowed targets.
 */

import { NotImplementedError } from "./errors.js";
import type { Change, LayerRef } from "./types.js";

/** List changes in a destination vs its baseline, with provenance (§8). */
export async function status(_destDir: string): Promise<Change[]> {
  throw new NotImplementedError("status");
}

export interface PromoteOptions {
  /** Target layer to promote into; if omitted, auto-suggest from provenance. */
  to?: LayerRef;
  /** Recompile and assert byte-identity after promoting (default true). */
  verify?: boolean;
}

/**
 * Promote changes up into a target layer. Throws on precedence-shadowing,
 * read-only targets, or a failed round-trip verification (§8 guards). Generates
 * a `.treelay` sidecar with the recorded base when emitting a patch.
 */
export async function promote(
  _destDir: string,
  _changes: Change[],
  _options: PromoteOptions = {},
): Promise<void> {
  throw new NotImplementedError("promote");
}

export interface ExtractOptions {
  /** Path for the new overlay layer. */
  as: string;
  /** Wire it into the leaf's `mixins` (vs leaving it free-standing). */
  asMixin?: boolean;
}

/** Capture changes as a new overlay layer (§8). */
export async function extract(
  _destDir: string,
  _changes: Change[],
  _options: ExtractOptions,
): Promise<void> {
  throw new NotImplementedError("extract");
}
