/**
 * Capability probes and format shims for the step-9 suite.
 *
 * Step 9 (npm/git layer resolution + `treelay.lock`) is being implemented in
 * parallel with these tests. The tests are written against SPEC §2/§3, not
 * against the implementation, which leaves two problems to solve here:
 *
 *  1. **They must not break the shared suite before the interface lands, and
 *     must start exercising it the moment it does, without being edited.**
 *     Hence a *behavioural* probe rather than a hand-flipped flag: ask
 *     `resolveRef` whether it still answers "not implemented yet". When step 9
 *     lands, the probe flips on its own and the gated suites go live.
 *  2. **Ref syntax is not frozen.** SPEC §2 names three forms — a local path,
 *     an npm spec, and `github:acme/base#tag` — but says nothing about how an
 *     arbitrary git URL (like the `file://` remotes these tests use) is
 *     spelled. {@link gitRef} and {@link npmRef} are the single place that
 *     guess. If step 9 settles on a different grammar, this file changes and
 *     the suites do not.
 *
 * Same reasoning for {@link lockPath}: the tests assert lock *behaviour*
 * (determinism, pinning, drift) almost entirely through composed output, so
 * they need to know where the lock lives but not what is inside it.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRef } from "../../src/resolve.js";
import { NotImplementedError } from "../../src/errors.js";

/** True once `resolveRef` stops answering "not implemented" for `ref`. */
function implemented(ref: string): boolean {
  try {
    resolveRef(ref, tmpdir());
    return true;
  } catch (err) {
    // Any *other* failure (bad URL, missing package, clone error) means the
    // code path exists and ran — which is exactly what the probe asks.
    return !(err instanceof NotImplementedError);
  }
}

/** Whether git-referenced layers resolve yet (SPEC §2, build order step 9). */
export const GIT_REFS = implemented("github:acme/base#v1");

/** Whether npm-referenced layers resolve yet (SPEC §2, build order step 9). */
export const NPM_REFS = implemented("@acme/base");

/**
 * A git layer ref pointing at a local `file://` remote at a given revision.
 *
 * The `<url>#<rev>` shape follows the `github:acme/base#tag` form in SPEC §2;
 * the `git+` prefix follows npm's own URL grammar, which treelay already
 * borrows for package specs.
 */
export function gitRef(repo: { url: string }, rev: string): string {
  return `git+${repo.url}#${rev}`;
}

/** An npm layer ref, optionally carrying a version range (SPEC §2). */
export function npmRef(name: string, range?: string): string {
  return range ? `${name}@${range}` : name;
}

/** Where a leaf's lockfile lives (SPEC §3 — "`treelay.lock` records …"). */
export const lockPath = (leafDir: string) => join(leafDir, "treelay.lock");

/** Raw lock bytes, or undefined when the leaf has no lock yet. */
export function readLock(leafDir: string): Buffer | undefined {
  const file = lockPath(leafDir);
  return existsSync(file) ? readFileSync(file) : undefined;
}

/** Lock bytes, failing loudly when absent — for tests that require one. */
export function requireLock(leafDir: string): Buffer {
  const lock = readLock(leafDir);
  if (!lock) {
    throw new Error(
      `expected a lockfile at ${lockPath(leafDir)} after compile — ` +
        `if step 9 puts it elsewhere, update lockPath() in test/helpers/step9.ts`,
    );
  }
  return lock;
}
