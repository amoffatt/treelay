/** Per-file merge strategy dispatch — SPEC §4. */

import picomatch from "picomatch";
import type { MergeStrategy } from "../types.js";

export { deepMerge } from "./deepMerge.js";
export { applyPatch3Way } from "./patch.js";
export { applyMergePatch, applyJsonPatch } from "./structured.js";

const STRUCTURED = /\.(json|ya?ml|toml)$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i;

/**
 * Default strategy for a path when no manifest glob or sidecar specifies one:
 * structured files deep-merge, binaries replace, everything else replaces (text
 * gets patch/append only via explicit sidecar/suffix).
 */
export function defaultStrategy(path: string): MergeStrategy {
  if (STRUCTURED.test(path)) return "deep-merge";
  if (BINARY.test(path)) return "replace";
  return "replace";
}

/** Resolve the strategy for a path given the manifest `merge` globs (§4). */
export function strategyFor(
  path: string,
  globs: Record<string, MergeStrategy> = {},
): MergeStrategy {
  for (const [glob, strategy] of Object.entries(globs)) {
    if (picomatch.isMatch(path, glob)) return strategy;
  }
  return defaultStrategy(path);
}
