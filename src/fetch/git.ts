/**
 * Git-backed layers (SPEC §3).
 *
 * Two operations, deliberately separated because they have very different
 * costs and failure modes:
 *
 * - **resolve** — what commit does `#main` mean *right now*? Needs the remote.
 * - **materialize** — give me the tree at commit `abc123`. Needs only the cache
 *   once that commit has been fetched, and is what a locked build does.
 *
 * That split is the whole of "compile honours the lock": a locked build never
 * asks the first question, so a moved branch cannot change what it produces.
 *
 * Everything shells out to the user's `git`. Reimplementing the wire protocol
 * to save a process spawn would trade a well-tested dependency every developer
 * already has for a novel one that has to learn about proxies, credential
 * helpers, SSH agents and partial clones.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { hashTree } from "../hash.js";
import type { GitRef } from "../refs.js";
import { isCommitSha } from "../refs.js";
import {
  ensureCacheDir,
  freshDir,
  gitMirrorDir,
  gitRepoDir,
  gitRevisionDir,
} from "./cache.js";

/** Raised when a git operation fails, carrying git's own message. */
export class GitFetchError extends Error {
  constructor(
    public readonly url: string,
    message: string,
  ) {
    super(`git layer ${url}: ${message}`);
    this.name = "GitFetchError";
  }
}

/** Run git, returning trimmed stdout; stderr is folded into the thrown error. */
function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Never stop for credentials: a hung prompt inside a build is worse
        // than a clear "authentication failed".
        GIT_TERMINAL_PROMPT: "0",
        GIT_ADVICE: "0",
      },
    }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const detail = (e.stderr?.toString() ?? e.message ?? "").trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
}

/** Ensure the bare mirror for a remote exists; returns its path. */
function ensureMirror(url: string, cacheDir?: string): string {
  const mirror = gitMirrorDir(url, cacheDir);
  if (existsSync(join(mirror, "HEAD"))) return mirror;
  ensureCacheDir(gitRepoDir(url, cacheDir));
  try {
    git(["clone", "--mirror", "--quiet", url, mirror]);
  } catch (err) {
    // A half-written mirror would poison every later resolve.
    rmSync(mirror, { recursive: true, force: true });
    throw new GitFetchError(url, `clone failed — ${(err as Error).message}`);
  }
  return mirror;
}

/** Refresh a mirror from its remote (network). */
function updateMirror(url: string, mirror: string): void {
  try {
    git(["--git-dir", mirror, "fetch", "--prune", "--quiet", "origin", "+refs/*:refs/*"]);
  } catch (err) {
    throw new GitFetchError(url, `fetch failed — ${(err as Error).message}`);
  }
}

/** Does the mirror already contain this object? */
function hasCommit(mirror: string, committish: string): boolean {
  try {
    git(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `${committish}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a commit-ish to an exact commit SHA, fetching if needed.
 *
 * A full SHA is returned untouched only once we know the mirror has it — a
 * pinned build must still fail loudly if the commit has been garbage-collected
 * upstream, rather than materializing nothing.
 */
export function resolveGitRevision(ref: GitRef, cacheDir?: string): string {
  const mirror = ensureMirror(ref.url, cacheDir);

  // Tags and branches move; re-fetch before trusting a local answer. An
  // immutable SHA only needs a fetch when we don't already have the object.
  if (!isCommitSha(ref.committish) || !hasCommit(mirror, ref.committish)) {
    updateMirror(ref.url, mirror);
  }
  try {
    return git(["--git-dir", mirror, "rev-parse", `${ref.committish}^{commit}`]);
  } catch {
    throw new GitFetchError(
      ref.url,
      `no such revision "${ref.committish}". It may have been deleted, ` +
        `renamed, or never pushed.`,
    );
  }
}

/**
 * The revision a moving ref points to on the remote *right now*.
 *
 * Returns undefined when the remote cannot be reached — drift detection is an
 * advisory read, and being offline must degrade to "unknown" rather than fail a
 * build that is otherwise fully pinned.
 */
export function liveGitRevision(ref: GitRef): string | undefined {
  if (isCommitSha(ref.committish)) return ref.committish;
  try {
    const out = git(["ls-remote", ref.url, ref.committish]);
    const line = out.split("\n").find((l) => l.trim() !== "");
    return line?.split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

/**
 * Materialize an exact commit into the cache and return the layer root.
 *
 * The tree is extracted via `git archive`, so the result carries no `.git` at
 * all — a checkout that cannot leak a gitlink into a composed tree, and one
 * whose integrity hash depends only on content (§4's `.git` exclusion covers
 * the same hazard from the other side).
 */
export function materializeGit(
  ref: GitRef,
  revision: string,
  cacheDir?: string,
): { dir: string; integrity: string } {
  const dest = gitRevisionDir(ref.url, revision, cacheDir);
  const root = ref.subdir ? join(dest, ref.subdir) : dest;

  if (!existsSync(dest)) {
    const mirror = ensureMirror(ref.url, cacheDir);
    if (!hasCommit(mirror, revision)) updateMirror(ref.url, mirror);
    freshDir(dest);
    const tar = join(dest, ".treelay-archive.tar");
    try {
      git(["--git-dir", mirror, "archive", "--format=tar", "-o", tar, revision]);
      execFileSync("tar", ["-xf", tar, "-C", dest], { stdio: "ignore" });
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      throw new GitFetchError(
        ref.url,
        `could not extract ${revision.slice(0, 12)} — ${(err as Error).message}`,
      );
    } finally {
      rmSync(tar, { force: true });
    }
  }

  if (!existsSync(root)) {
    throw new GitFetchError(
      ref.url,
      `subdirectory "${ref.subdir}" does not exist at ${revision.slice(0, 12)}`,
    );
  }
  return { dir: root, integrity: hashTree(root) };
}
