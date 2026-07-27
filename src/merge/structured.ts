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
 * Produce the RFC 7386 merge patch turning `before` into `after` — the inverse
 * of {@link applyMergePatch}. Reflux (§8) uses it to record a promoted edit to a
 * structured file as a delta rather than a whole-file copy.
 */
export function generateMergePatch(before: unknown, after: unknown): unknown {
  return jsonMergePatch.generate(before, after);
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Do two RFC 7386 merge patches disagree? They conflict only where both touch
 * the *same* key with a different outcome; keys only one side changed compose
 * freely, which is exactly what makes structured merging beat line diffing for
 * config files.
 */
function patchesConflict(a: unknown, b: unknown): boolean {
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) {
      if (key in b && patchesConflict(a[key], b[key])) return true;
    }
    return false;
  }
  return JSON.stringify(a) !== JSON.stringify(b);
}

export interface StructuredMerge3Result {
  clean: boolean;
  /** The merged document; only meaningful when `clean`. */
  value: unknown;
}

/**
 * Three-way merge two structured documents by reconciling their *changes*
 * rather than their lines (§7).
 *
 * Line-based merging conflicts on edits that happen to sit near each other;
 * comparing `base → ours` and `base → theirs` as merge patches instead means
 * two sides adding different keys — the common case for `package.json` — merges
 * cleanly no matter where those keys landed in the file.
 */
export function mergeStructured3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): StructuredMerge3Result {
  const ourPatch = generateMergePatch(base, ours);
  const theirPatch = generateMergePatch(base, theirs);

  if (ourPatch === undefined) return { clean: true, value: theirs };
  if (theirPatch === undefined) return { clean: true, value: ours };
  if (patchesConflict(ourPatch, theirPatch)) return { clean: false, value: undefined };

  // Non-conflicting, so order is irrelevant; apply theirs then ours.
  return {
    clean: true,
    value: applyMergePatch(applyMergePatch(base, theirPatch), ourPatch),
  };
}
