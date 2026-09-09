/**
 * Structured-file (de)serialization by extension — SPEC §4.
 *
 * Deep-merge and the sidecar `merge`/`jsonPatch` ops operate on parsed data, but
 * files live on disk as text. These helpers round-trip JSON and YAML while
 * preserving the source's indentation flavor as best as is reasonable.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type StructuredFormat = "json" | "yaml" | "toml";

/**
 * Detect the structured format of a path, or `undefined` if it isn't one.
 *
 * This is the *only* place an extension becomes a structured format. §4's
 * deep-merge dispatch derives its match from this function rather than keeping
 * a parallel regex: 0.3.0 shipped one that listed `.toml` while this codec did
 * not support it, so `.toml` advertised deep-merge and then threw on compose.
 */
export function structuredFormat(path: string): StructuredFormat | undefined {
  if (/\.json$/i.test(path)) return "json";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.toml$/i.test(path)) return "toml";
  return undefined;
}

/** Parse structured text into data, per the path's format. */
export function parseStructured(path: string, text: string): unknown {
  const fmt = structuredFormat(path);
  if (fmt === "json") return text.trim() === "" ? {} : JSON.parse(text);
  if (fmt === "yaml") return parseYaml(text) ?? {};
  if (fmt === "toml") return parseToml(text);
  throw new Error(`Not a structured file: ${path}`);
}

/** Serialize data back to text, per the path's format (JSON keeps 2-space indent). */
export function stringifyStructured(path: string, data: unknown): string {
  const fmt = structuredFormat(path);
  if (fmt === "json") return JSON.stringify(data, null, 2) + "\n";
  if (fmt === "yaml") return stringifyYaml(data);
  if (fmt === "toml") return stringifyToml(data as Record<string, unknown>) + "\n";
  throw new Error(`Not a structured file: ${path}`);
}
