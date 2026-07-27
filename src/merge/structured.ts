/** Structured patches for config files — SPEC §5. */

import { createRequire } from "node:module";
import type { Operation } from "fast-json-patch";

// Both libraries are CommonJS; Node's ESM named-import interop can't see their
// exports, so load them through createRequire (works at runtime and under test).
const require = createRequire(import.meta.url);
const { applyPatch: applyJsonPatchLib } =
  require("fast-json-patch") as typeof import("fast-json-patch");
const jsonMergePatch =
  require("json-merge-patch") as typeof import("json-merge-patch");

/**
 * Apply an RFC 7386 JSON Merge Patch. `null` values in the patch delete keys;
 * everything else recurses. The target is deep-cloned first so the caller's
 * value is never mutated (the underlying library mutates in place).
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  const clone = target === undefined ? undefined : structuredClone(target);
  return jsonMergePatch.apply(clone, patch);
}

/**
 * Apply an RFC 6902 JSON Patch (precise array/path ops). Non-mutating: returns
 * the new document and leaves the input untouched.
 */
export function applyJsonPatch(target: unknown, ops: unknown[]): unknown {
  const { newDocument } = applyJsonPatchLib(
    structuredClone(target),
    ops as Operation[],
    /* validateOperation */ true,
    /* mutateDocument */ false,
  );
  return newDocument;
}
