/**
 * Fetching a remote layer, lock-aware (SPEC §3).
 *
 * One entry point sits between resolution and the per-transport fetchers, and
 * it is where the lockfile earns its keep:
 *
 * - **locked** — the lock already pins this ref → materialize *that* revision.
 *   No remote query, so a branch that has since moved cannot change the build.
 * - **unlocked** — resolve the ref live, materialize, and hand back an entry for
 *   the caller to record.
 * - **frozen** — an unlocked ref is an error, not a silent lock update. This is
 *   the CI posture: builds reproduce or they fail.
 *
 * Everything here is synchronous by design. Layer resolution is called from
 * `resolve()`, which the entire library and CLI treat as a plain function; making
 * it async to accommodate a subprocess would ripple through every caller for no
 * behavioural gain, since a build cannot proceed without its layers anyway.
 */

import { existsSync } from "node:fs";

import { hashTree } from "../hash.js";
import type { LockEntry, TreelayLock } from "../lockfile.js";
import type { RemoteRef } from "../refs.js";
import { canonicalRef } from "../refs.js";
import { liveGitRevision, materializeGit, resolveGitRevision } from "./git.js";
import { liveNpmVersion, materializeNpm } from "./npm.js";

export { GitFetchError, liveGitRevision } from "./git.js";
export { NpmResolveError, liveNpmVersion } from "./npm.js";
export { cacheRoot, locationKey } from "./cache.js";

/** Raised when a frozen resolve meets a ref the lockfile does not pin. */
export class LockMissingError extends Error {
  constructor(public readonly ref: string) {
    super(
      `${ref} is not in treelay.lock, and resolution is frozen. ` +
        `Run \`treelay lock\` and commit the result, or drop --frozen-lockfile.`,
    );
    this.name = "LockMissingError";
  }
}

/** Raised when cached content no longer matches the integrity the lock records. */
export class IntegrityError extends Error {
  constructor(ref: string, expected: string, actual: string) {
    super(
      `${ref}: cached content does not match treelay.lock.\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        `The cache entry has been modified or corrupted. Delete it (or the whole ` +
        `cache) and re-resolve.`,
    );
    this.name = "IntegrityError";
  }
}

export interface FetchOptions {
  /** Directory the ref was declared in — the anchor for npm resolution. */
  fromDir: string;
  /** Existing pins; consulted before any remote is contacted. */
  lock: TreelayLock;
  /** Refuse to resolve refs the lock does not already pin (CI). */
  frozen?: boolean;
  /** Re-resolve moving refs to their current revision, advancing the lock. */
  updateRefs?: boolean;
  /** Override the cache root (tests). */
  cacheDir?: string;
}

/** A materialized remote layer plus the lock entry describing it. */
export interface FetchedLayer {
  /** Canonical ref — the lockfile key. */
  ref: string;
  /** Absolute path of the layer root on disk. */
  dir: string;
  revision: string;
  integrity: string;
  entry: LockEntry;
  /** True when the lock gained or changed an entry because of this fetch. */
  changed: boolean;
}

/** Fetch (or reuse) a remote layer, honouring the lock. */
export function fetchLayer(ref: RemoteRef, options: FetchOptions): FetchedLayer {
  const key = canonicalRef(ref);
  const locked = options.updateRefs ? undefined : options.lock.refs[key];

  if (!locked && options.frozen) throw new LockMissingError(key);

  const { dir, revision, integrity } =
    ref.kind === "git"
      ? fetchGit(ref, locked?.resolved, options)
      : materializeNpm(ref, options.fromDir);

  // Integrity is only a corruption signal when both sides claim the *same*
  // revision. A different revision is drift — legitimate for npm, where the
  // installed tree is the package manager's to change — and is reported as
  // such rather than mistaken for a tampered cache.
  if (locked && locked.resolved === revision && locked.integrity !== integrity) {
    throw new IntegrityError(key, locked.integrity, integrity);
  }

  const entry: LockEntry = {
    kind: ref.kind,
    source: ref.kind === "git" ? ref.url : ref.name,
    requested: ref.kind === "git" ? ref.committish : ref.range,
    resolved: revision,
    integrity,
    ...(ref.subdir !== undefined ? { path: ref.subdir } : {}),
  };

  const changed =
    locked === undefined ||
    locked.resolved !== entry.resolved ||
    locked.integrity !== entry.integrity;

  return { ref: key, dir, revision, integrity, entry, changed };
}

/** Git: reuse a cached checkout when the lock already pins the revision. */
function fetchGit(
  ref: RemoteRef & { kind: "git" },
  lockedRevision: string | undefined,
  options: FetchOptions,
): { dir: string; revision: string; integrity: string } {
  const revision = lockedRevision ?? resolveGitRevision(ref, options.cacheDir);
  const { dir, integrity } = materializeGit(ref, revision, options.cacheDir);
  return { dir, revision, integrity };
}

/**
 * Re-hash a materialized layer. Used by `treelay lock --check` to notice a
 * cache that has been edited in place without re-fetching anything.
 */
export function verifyIntegrity(dir: string, expected: string): boolean {
  return existsSync(dir) && hashTree(dir) === expected;
}

/**
 * What a ref points at on the remote right now — the drift probe.
 *
 * Undefined means "could not tell" (offline, no credentials, package not
 * installed), never "unchanged": an advisory check that silently reports
 * in-sync when it could not look would be worse than saying nothing.
 */
export function liveRevision(ref: RemoteRef, fromDir: string): string | undefined {
  return ref.kind === "git" ? liveGitRevision(ref) : liveNpmVersion(ref, fromDir);
}
