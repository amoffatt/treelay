/** Per-file merge strategy dispatch — SPEC §4. */

import picomatch from "picomatch";
import type { MergeStrategy } from "../types.js";
import { structuredFormat } from "../serde.js";

export { deepMerge, type DeepMergeOptions } from "./deepMerge.js";
export {
  arrayRuleFor,
  mergeByKey,
  sortByKey,
  DEFAULT_ARRAY_RULE,
  type DroppedArray,
} from "./arrays.js";
export { applyPatch3Way } from "./patch.js";
export { applyMergePatch, applyJsonPatch } from "./structured.js";

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i;

/**
 * Default strategy for a path when no manifest glob or sidecar specifies one:
 * structured files deep-merge, binaries replace, everything else replaces (text
 * gets patch/append only via explicit sidecar/suffix).
 *
 * "Structured" is whatever {@link structuredFormat} can actually round-trip, so
 * a format can never be routed to deep-merge without a codec behind it.
 */
export function defaultStrategy(path: string): MergeStrategy {
  if (structuredFormat(path)) return "deep-merge";
  if (BINARY.test(path)) return "replace";
  return "replace";
}

/**
 * The strategy a manifest `merge` glob *declares* for a path, if any (§4).
 *
 * Split out from {@link strategyFor} because "replace, because the author said
 * so" and "replace, because that is the fallback" are the same byte-level
 * behaviour but opposite intents. Only the second is worth reporting when a
 * higher layer silently discards an ancestor's file, so the audit needs to tell
 * them apart — and matching globs in exactly one place is what keeps it honest.
 */
export function declaredStrategy(
  path: string,
  globs: Record<string, MergeStrategy> = {},
): MergeStrategy | undefined {
  for (const [glob, strategy] of Object.entries(globs)) {
    if (picomatch.isMatch(path, glob)) return strategy;
  }
  return undefined;
}

/** Resolve the strategy for a path given the manifest `merge` globs (§4). */
export function strategyFor(
  path: string,
  globs: Record<string, MergeStrategy> = {},
): MergeStrategy {
  return declaredStrategy(path, globs) ?? defaultStrategy(path);
}
