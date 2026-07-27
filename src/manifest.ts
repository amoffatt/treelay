/** Manifest loading — SPEC §2. */

import { readFileSync, existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Manifest } from "./types.js";

const MANIFEST_NAMES = ["treelay.json", "treelay.yaml", "treelay.yml"];

/**
 * Load the manifest for a layer directory. Looks for a standalone
 * `treelay.{json,yaml,yml}`, then falls back to a `"treelay"` key in
 * `package.json`. Returns an empty manifest if none is found (a plain
 * directory is a valid, parent-less layer).
 */
export function loadManifest(dir: string): Manifest {
  for (const name of MANIFEST_NAMES) {
    const file = join(dir, name);
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8");
      return (name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as Manifest;
    }
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      treelay?: Manifest;
      name?: string;
    };
    if (pkg.treelay) {
      // package.json `name` is a fallback; an explicit treelay.name wins.
      return { ...(pkg.name !== undefined ? { name: pkg.name } : {}), ...pkg.treelay };
    }
  }

  return {};
}

/** Whether a directory is writable (false ⇒ promotion targets exclude it, §8). */
export function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    // node_modules installs are writable on disk but should be treated as
    // read-only sources; callers layer that policy on top of this check.
    return true;
  } catch {
    return false;
  }
}
