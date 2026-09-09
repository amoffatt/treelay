/**
 * Array merge policy for `deep-merge` — SPEC §4, closing the `by-key` item
 * left open in §11.
 *
 * `replace` is still the default, because concat surprises people. But replace
 * on an array is the one deep-merge outcome that *destroys* inherited content:
 * a leaf adding a single entry to an inherited list discards every element
 * beneath it, and the surrounding object keys merge normally so the file looks
 * merged. That is why a drop is reported (see {@link DroppedArray}) rather than
 * being left to the reader to notice.
 *
 * `by-key` exists for the lists that are really keyed sets — migration
 * journals, database bindings, route tables — where every layer legitimately
 * contributes entries and identity lives in a field rather than an index.
 */

import picomatch from "picomatch";
import type { ArrayPolicy, ArrayRule, ArraysConfig } from "../types.js";

/** The policy applied when a manifest says nothing (§4). */
export const DEFAULT_ARRAY_RULE: ArrayRule = { policy: "replace" };

/**
 * Resolve the array rule for a path. A bare policy string applies to every
 * file; a map is matched glob-by-glob in declaration order, like `merge`.
 */
export function arrayRuleFor(
  path: string,
  config: ArraysConfig | undefined,
): ArrayRule {
  if (config === undefined) return DEFAULT_ARRAY_RULE;
  if (typeof config === "string") return { policy: config };
  for (const [glob, rule] of Object.entries(config)) {
    if (picomatch.isMatch(path, glob)) {
      return typeof rule === "string" ? { policy: rule } : rule;
    }
  }
  return DEFAULT_ARRAY_RULE;
}

/** An inherited array wholly discarded by a higher layer's array (§4). */
export interface DroppedArray {
  /**
   * JSON Pointer to the array within the file, so a finding points at
   * `/entries` rather than just naming the file.
   */
  pointer: string;
  /** How many inherited elements were discarded. */
  dropped: number;
}

/** RFC 6901 escaping — `~` and `/` are the only characters that need it. */
const escapeToken = (token: string): string =>
  token.replace(/~/g, "~0").replace(/\//g, "~1");

export const childPointer = (parent: string, token: string): string =>
  `${parent}/${escapeToken(token)}`;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge two arrays by a key field: elements sharing a key value are deep-merged
 * in place, and elements the base lacks are appended in the higher layer's
 * order.
 *
 * Elements that are not objects, or that lack the key, cannot be identified
 * across layers. Appending them (rather than dropping or guessing) keeps the
 * operation non-destructive, which is the whole reason `by-key` exists.
 */
export function mergeByKey(
  base: readonly unknown[],
  over: readonly unknown[],
  key: string,
  mergeElement: (b: unknown, o: unknown) => unknown,
): unknown[] {
  const identify = (el: unknown): string | undefined =>
    isObject(el) && el[key] !== undefined ? JSON.stringify(el[key]) : undefined;

  const result = [...base];
  const indexByKey = new Map<string, number>();
  base.forEach((el, i) => {
    const id = identify(el);
    // First occurrence wins, so a base that already contains duplicates merges
    // deterministically instead of depending on iteration order.
    if (id !== undefined && !indexByKey.has(id)) indexByKey.set(id, i);
  });

  for (const el of over) {
    const id = identify(el);
    const at = id === undefined ? undefined : indexByKey.get(id);
    if (at === undefined) {
      if (id !== undefined) indexByKey.set(id, result.length);
      result.push(el);
    } else {
      result[at] = mergeElement(result[at], el);
    }
  }
  return result;
}

/** Sort by the key field ascending; numbers numerically, everything else as text. */
export function sortByKey(elements: readonly unknown[], key: string): unknown[] {
  return [...elements].sort((a, b) => {
    const av = isObject(a) ? a[key] : undefined;
    const bv = isObject(b) ? b[key] : undefined;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv));
  });
}

export type { ArrayPolicy, ArrayRule, ArraysConfig };
