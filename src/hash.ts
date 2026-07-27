/**
 * Content hashing — the single source of truth for the `sha256:…` format used
 * by `.treelay` sidecar `base:` fields (§5) and the destination baseline (§7).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Hash content into the canonical `sha256:<hex>` form. */
export function hashContent(data: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Whether `data` matches a recorded `sha256:…` hash. */
export function matchesHash(data: Buffer | string, recorded: string): boolean {
  return hashContent(data) === recorded.trim();
}

/**
 * Hash a whole directory tree into one `sha256:…` — the lockfile's `integrity`.
 *
 * Deliberately independent of any VCS: it digests the *materialized content*,
 * which is the thing a build actually consumes. A git commit SHA already says
 * which revision was asked for; this says the bytes on disk still are that
 * revision, so a corrupted or hand-edited cache entry is caught rather than
 * silently compiled in.
 *
 * Paths are sorted and mixed into the digest alongside their content, so
 * renaming a file changes the hash even when the bytes are identical.
 */
export function hashTree(dir: string): string {
  const digest = createHash("sha256");
  for (const rel of listTreeFiles(dir)) {
    digest.update(rel);
    digest.update("\0");
    digest.update(createHash("sha256").update(readFileSync(join(dir, rel))).digest());
    digest.update("\n");
  }
  return "sha256:" + digest.digest("hex");
}

/**
 * Every file under `dir`, relative and sorted, with `.git` and `node_modules`
 * pruned.
 *
 * `.git` is excluded so the integrity of a checkout depends only on its
 * content — otherwise two materializations of the same commit would hash
 * differently because their object stores were packed differently.
 * `node_modules` is excluded because an installed package's dependencies are
 * the package manager's business, not part of the layer's identity, and hashing
 * them would make integrity depend on hoisting decisions.
 */
const TREE_HASH_PRUNE = new Set([".git", "node_modules"]);

function listTreeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (TREE_HASH_PRUNE.has(e.name)) continue;
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...listTreeFiles(join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
