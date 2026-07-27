/**
 * A hermetic local-git harness for the step-9 suite (npm/git layer refs).
 *
 * Everything here runs against `file://` remotes inside a temp directory: real
 * commits, branches that really move, tags that really pin, real submodules —
 * and no network whatsoever. Three things make it hermetic, and all three
 * matter for a suite whose whole subject is "which revision did we get":
 *
 *  - `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are nulled, so a developer's
 *    `~/.gitconfig` (commit signing, `init.defaultBranch`, hooks, aliases)
 *    cannot change what these tests observe.
 *  - `GIT_TERMINAL_PROMPT=0`, so a test that accidentally reaches for a real
 *    remote fails fast instead of hanging on a credential prompt.
 *  - Author/committer identity *and dates* are fixed, so the same tree
 *    produces the same commit SHA on every machine and every run. Tests never
 *    hard-code a SHA — but reproducibility makes a failure diffable rather
 *    than a mystery.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Fixed clock: commit N is stamped EPOCH + N seconds, so history is ordered. */
const EPOCH = 1_700_000_000;

/** Config that must hold regardless of the host's git installation. */
const HERMETIC_FLAGS = [
  "-c",
  "init.defaultBranch=main",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "advice.detachedHead=false",
  // git ≥2.38 refuses `file://` for submodules unless this is set. The whole
  // point of the harness is local remotes, so allow it explicitly.
  "-c",
  "protocol.file.allow=always",
];

const BASE_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "treelay tests",
  GIT_AUTHOR_EMAIL: "tests@treelay.invalid",
  GIT_COMMITTER_NAME: "treelay tests",
  GIT_COMMITTER_EMAIL: "tests@treelay.invalid",
};

/** Whether `git` is usable at all — suites gate on this rather than exploding. */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run git in `cwd`, surfacing stderr in the thrown message (execFileSync hides it). */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync("git", [...HERMETIC_FLAGS, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...BASE_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `git ${args.join(" ")} (in ${cwd}) failed:\n${e.stderr ?? e.message ?? err}`,
    );
  }
}

/**
 * A local git repository usable as a remote.
 *
 * The repo is a normal (non-bare) checkout: tests both edit it directly and
 * clone from it over `file://`. Nothing ever pushes back into it, so the
 * "cannot push to a checked-out branch" restriction never bites.
 */
export interface Repo {
  /** Absolute path to the working directory. */
  readonly dir: string;
  /** `file://…` URL — what a layer ref points at. */
  readonly url: string;
  /** Escape hatch for anything the typed surface doesn't cover. */
  git(...args: string[]): string;
  /** Write files (`null` deletes), commit, return the new SHA. */
  commit(files: Record<string, string | null>, message?: string): string;
  /** Tag `ref` (default HEAD); returns the tagged SHA. */
  tag(name: string, ref?: string): string;
  /** Create a branch at `ref` (default HEAD) without switching to it. */
  branch(name: string, ref?: string): string;
  /** Switch the working tree to `ref` (branch, tag, or SHA). */
  checkout(ref: string): void;
  /** Resolve `rev` (default HEAD) to a full SHA. */
  head(rev?: string): string;
  /** Add `child` as a submodule at `at`, and commit the gitlink. */
  addSubmodule(child: Repo, at: string, message?: string): string;
}

/**
 * Create a repository at `dir`, optionally with an initial commit.
 *
 * Passing `files` is the common case: a repo with no commits has no HEAD, and
 * almost every test wants something to reference immediately.
 */
export function makeRepo(dir: string, files?: Record<string, string>): Repo {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet"]);

  let clock = 0;
  const stamp = () => {
    const date = `${EPOCH + clock++} +0000`;
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  };

  const repo: Repo = {
    dir,
    url: pathToFileURL(dir).href,

    git: (...args) => git(dir, args),

    commit(files, message = `commit ${clock}`) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        if (content === null) {
          rmSync(abs, { force: true, recursive: true });
          continue;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "--quiet", "--allow-empty", "-m", message], stamp());
      return repo.head();
    },

    tag(name, ref = "HEAD") {
      git(dir, ["tag", name, ref], stamp());
      return repo.head(name);
    },

    branch(name, ref = "HEAD") {
      git(dir, ["branch", name, ref]);
      return repo.head(name);
    },

    checkout(ref) {
      git(dir, ["checkout", "--quiet", ref]);
    },

    head(rev = "HEAD") {
      return git(dir, ["rev-parse", rev]);
    },

    addSubmodule(child, at, message = `add submodule ${at}`) {
      git(dir, ["submodule", "add", "--quiet", child.url, at]);
      git(dir, ["commit", "--quiet", "-m", message], stamp());
      return repo.head();
    },
  };

  if (files) repo.commit(files, "initial");
  return repo;
}

/**
 * Clone `url` at `rev` into `dir` — the operation a git layer ref implies.
 *
 * Used by the harness's own tests to prove a `file://` remote behaves, and
 * available to tests that need a checkout treelay didn't produce.
 */
export function cloneAt(url: string, dir: string, rev: string): string {
  mkdirSync(dirname(dir), { recursive: true });
  git(dirname(dir), ["clone", "--quiet", url, dir]);
  git(dir, ["checkout", "--quiet", rev]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/**
 * Make a remote unreachable without destroying it, then restore it.
 *
 * This is how the suite proves treelay served a compile *from its cache*: take
 * the remote away, recompile, and see it succeed anyway. Renaming beats
 * deleting because the assertion is about treelay's behaviour, not about
 * whether the test can rebuild the fixture afterwards.
 */
export async function withRemoteOffline<T>(
  repo: Repo,
  fn: () => T | Promise<T>,
): Promise<T> {
  const parked = `${repo.dir}.offline`;
  if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
  renameSync(repo.dir, parked);
  try {
    return await fn();
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    renameSync(parked, repo.dir);
  }
}
