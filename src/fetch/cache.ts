/**
 * Content-addressed cache for fetched layers (SPEC §3).
 *
 * Every fetched tree lands at a path derived from *what it is*, never from who
 * asked for it: `<root>/git/<repo-key>/rev/<commit>/`. Two layers pinning the
 * same commit share one checkout, a held-back pin coexists with a floating one
 * instead of fighting over a working directory, and the cache is safe to delete
 * at any time — worst case the next resolve re-fetches.
 *
 * `TREELAY_CACHE_DIR` overrides the location, which is how tests stay hermetic.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of the cache: `$TREELAY_CACHE_DIR`, else `~/.cache/treelay`. */
export function cacheRoot(override?: string): string {
  return (
    override ??
    process.env["TREELAY_CACHE_DIR"] ??
    join(homedir(), ".cache", "treelay")
  );
}

/**
 * A filesystem-safe, collision-resistant key for a remote location.
 *
 * The readable slug is there for humans poking at the cache; the hash suffix is
 * what actually guarantees uniqueness, since sanitizing a URL is lossy.
 */
export function locationKey(location: string): string {
  const slug =
    location
      .replace(/^[a-z+]+:\/\//i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "layer";
  const digest = createHash("sha256").update(location).digest("hex").slice(0, 16);
  return `${slug}-${digest}`;
}

/** Directory holding everything cached for one git remote. */
export function gitRepoDir(location: string, root?: string): string {
  return join(cacheRoot(root), "git", locationKey(location));
}

/** The bare mirror clone for a git remote — the fetch-once, read-many store. */
export function gitMirrorDir(location: string, root?: string): string {
  return join(gitRepoDir(location, root), "repo.git");
}

/** Extracted checkout of one exact commit. */
export function gitRevisionDir(
  location: string,
  revision: string,
  root?: string,
): string {
  return join(gitRepoDir(location, root), "rev", revision);
}

/** Create a directory, replacing any partial contents from a failed fetch. */
export function freshDir(dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ensure a directory exists without disturbing what is already in it. */
export function ensureCacheDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
