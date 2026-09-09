/** Manifest loading — SPEC §2. */

import {
  readFileSync,
  existsSync,
  accessSync,
  readdirSync,
  constants,
  type Dirent,
} from "node:fs";
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
/**
 * Does `dir` actually declare itself a layer?
 *
 * {@link loadManifest} answers `{}` for both "an empty manifest" and "no
 * manifest at all", which is the right default for a directory the user named
 * directly and the wrong one for a ref that was supposed to point at a layer.
 * Callers that need to tell those apart ask here — sharing `MANIFEST_NAMES` so
 * the two can never disagree about what counts.
 */
export function hasManifest(dir: string): boolean {
  if (MANIFEST_NAMES.some((name) => existsSync(join(dir, name)))) return true;

  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { treelay?: unknown };
    return pkg.treelay !== undefined;
  } catch {
    // An unparseable package.json is not a layer declaration; loadManifest will
    // raise the real error if this directory is used anyway.
    return false;
  }
}

/**
 * Immediate subdirectories of `dir` that declare themselves layers.
 *
 * The signature of the reported typo: a ref one level too shallow lands on the
 * directory *containing* the intended layer. A manifest-less directory that
 * holds a layer is therefore almost certainly not the layer that was meant,
 * whereas a manifest-less directory holding only content plausibly is.
 */
export function layerChildren(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && hasManifest(join(dir, e.name)))
    .map((e) => e.name)
    .sort();
}

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
