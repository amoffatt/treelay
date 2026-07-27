/** Recursive deep merge for structured files — SPEC §4. */

import type { ArrayPolicy } from "../types.js";

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `over` onto `base`. Objects merge recursively; arrays follow the
 * `arrays` policy. Default `replace` because concat surprises people (§4).
 */
export function deepMerge(
  base: Json,
  over: Json,
  arrays: ArrayPolicy = "replace",
): Json {
  if (Array.isArray(base) && Array.isArray(over)) {
    switch (arrays) {
      case "concat":
        return [...base, ...over];
      case "replace":
        return over;
      case "by-key":
        // TODO(§4): merge array elements by a key field once the key is specced.
        return over;
    }
  }

  if (isObject(base) && isObject(over)) {
    const result: Record<string, Json> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      result[k] = k in base ? deepMerge(base[k], v, arrays) : v;
    }
    return result;
  }

  // Scalars, or mismatched shapes: the higher layer wins.
  return over;
}
