/**
 * `treelay.lock` — resolved lineage and pinned revisions (SPEC §3, §9).
 *
 * The lockfile sits beside the **leaf layer's manifest** and is committed to
 * version control. It answers one question: *what exactly was materialized?* A
 * manifest says `#main`; the lock says which commit `main` was when the tree was
 * last resolved, plus an integrity hash of the content that produced.
 *
 * Note the division of labour with `<dest>/.treelay/lock.json` (§7): that file
 * records what a *destination* was built from, and is regenerated on every
 * compile. `treelay.lock` records what the *source composition* pins to, and
 * changes only when a ref is added or deliberately advanced.
 *
 * Serialization is deterministic — sorted keys throughout, fixed field order,
 * two-space indent, trailing newline — so re-running `treelay lock` on an
 * unchanged tree produces a byte-identical file and never shows up in a diff.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteRefKind } from "./refs.js";

/** Filename of the source-side lockfile, beside the leaf manifest. */
export const LOCKFILE_NAME = "treelay.lock";

/** Bumped when the on-disk shape changes incompatibly. */
export const LOCKFILE_VERSION = 1;

/** One pinned layer reference. */
export interface LockEntry {
  kind: RemoteRefKind;
  /** Clone URL (git) or package name (npm). */
  source: string;
  /** The mutable thing that was asked for: branch, tag, or semver range. */
  requested: string;
  /** The immutable revision it resolved to: commit SHA, or exact version. */
  resolved: string;
  /** `sha256:…` over the materialized tree — detects a tampered cache. */
  integrity: string;
  /** Subdirectory of the fetched tree used as the layer root, if any. */
  path?: string;
  /**
   * Which layers asked for this ref, as paths relative to the lockfile (local
   * layers) or canonical refs (remote ones). Sorted. Purely informational, but
   * it is what makes a held-back pin explainable months later.
   */
  requestedBy?: string[];
}

/** The parsed lockfile. */
export interface TreelayLock {
  lockfileVersion: number;
  /** Canonical ref → what it pinned to. */
  refs: Record<string, LockEntry>;
}

/** An empty, valid lock — what a tree with no remote refs serializes to. */
export function emptyLock(): TreelayLock {
  return { lockfileVersion: LOCKFILE_VERSION, refs: {} };
}

/** Absolute path of the lockfile for a leaf layer directory. */
export function lockfilePath(leafDir: string): string {
  return join(leafDir, LOCKFILE_NAME);
}

/** Raised when a lockfile exists but cannot be used. */
export class LockfileError extends Error {
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "LockfileError";
  }
}

/** Read the lockfile beside a leaf layer, or an empty lock when there is none. */
export function readLock(leafDir: string): TreelayLock {
  const file = lockfilePath(leafDir);
  if (!existsSync(file)) return emptyLock();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new LockfileError(file, `not valid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LockfileError(file, "expected a JSON object");
  }

  const lock = parsed as Partial<TreelayLock>;
  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    throw new LockfileError(
      file,
      `lockfileVersion ${String(lock.lockfileVersion)} was written by a different ` +
        `version of treelay (this one writes ${LOCKFILE_VERSION}). Delete it and ` +
        `re-run \`treelay lock\` to regenerate.`,
    );
  }
  return { lockfileVersion: LOCKFILE_VERSION, refs: lock.refs ?? {} };
}

/**
 * Render a lock to its canonical text.
 *
 * Field order is fixed rather than alphabetical because these files are read by
 * humans during incident review: what was asked for, then what it became.
 */
export function serializeLock(lock: TreelayLock): string {
  const refs: Record<string, LockEntry> = {};
  for (const key of Object.keys(lock.refs).sort()) {
    const e = lock.refs[key]!;
    refs[key] = {
      kind: e.kind,
      source: e.source,
      requested: e.requested,
      resolved: e.resolved,
      integrity: e.integrity,
      ...(e.path !== undefined ? { path: e.path } : {}),
      ...(e.requestedBy?.length ? { requestedBy: [...e.requestedBy].sort() } : {}),
    };
  }
  return JSON.stringify({ lockfileVersion: lock.lockfileVersion, refs }, null, 2) + "\n";
}

/** Write the lock beside a leaf layer. Returns true when the bytes changed. */
export function writeLock(leafDir: string, lock: TreelayLock): boolean {
  const file = lockfilePath(leafDir);
  const text = serializeLock(lock);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  writeFileSync(file, text);
  return true;
}

/** Do two locks pin the same things to the same revisions? */
export function locksEqual(a: TreelayLock, b: TreelayLock): boolean {
  return serializeLock(a) === serializeLock(b);
}
