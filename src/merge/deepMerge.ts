/** Recursive deep merge for structured files — SPEC §4. */

import type { ArrayRule } from "../types.js";
import {
  DEFAULT_ARRAY_RULE,
  childPointer,
  mergeByKey,
  sortByKey,
  type DroppedArray,
} from "./arrays.js";

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface DeepMergeOptions {
  rule?: ArrayRule;
  /**
   * Called whenever an inherited array is discarded wholesale. Deep-merge is
   * otherwise additive, so this is the only way content disappears without a
   * whole-file replacement — and the caller is the only one who knows which
   * file and which layers were involved.
   */
  onDropArray?: (drop: DroppedArray) => void;
}

/**
 * Deep-merge `over` onto `base`. Objects merge recursively; arrays follow the
 * rule's policy. Default `replace` because concat surprises people (§4).
 */
export function deepMerge(
  base: Json,
  over: Json,
  options: DeepMergeOptions = {},
): Json {
  const rule = options.rule ?? DEFAULT_ARRAY_RULE;
  return merge(base, over, rule, options.onDropArray, "");
}

function merge(
  base: Json,
  over: Json,
  rule: ArrayRule,
  onDrop: ((drop: DroppedArray) => void) | undefined,
  pointer: string,
): Json {
  if (Array.isArray(base) && Array.isArray(over)) {
    switch (rule.policy) {
      case "concat":
        return [...base, ...over];
      case "by-key": {
        // Without a key there is nothing to match elements on. Falling back to
        // replace would silently reintroduce the data loss by-key was chosen to
        // avoid, so this fails instead; `validate` catches it ahead of compile.
        if (!rule.key) {
          throw new Error(
            `arrays policy "by-key" needs a "key" naming the field that identifies ` +
              `an element (at ${pointer || "/"})`,
          );
        }
        const merged = mergeByKey(base, over, rule.key, (b, o) =>
          merge(b, o, rule, onDrop, pointer),
        );
        return rule.order === "key" ? sortByKey(merged, rule.key) : merged;
      }
      case "replace":
        if (base.length > 0) onDrop?.({ pointer: pointer || "/", dropped: base.length });
        return over;
    }
  }

  if (isObject(base) && isObject(over)) {
    const result: Record<string, Json> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      result[k] = k in base
        ? merge(base[k], v, rule, onDrop, childPointer(pointer, k))
        : v;
    }
    return result;
  }

  // Scalars, or mismatched shapes: the higher layer wins.
  return over;
}
