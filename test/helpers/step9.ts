/**
 * Capability probes and ref shims for the step-9 suite.
 *
 * Step 9 (npm/git layer resolution + `treelay.lock`) lands in pieces: ref
 * *parsing* and the lock *format* are here, but nothing fetches yet. So the
 * suites split the same way — everything that can be asserted against the
 * parser and the serializer runs now, and everything that needs a real
 * checkout is gated on a **behavioural** probe rather than a hand-flipped
 * flag. Ask `resolveRef` whether it still answers "not implemented yet"; when
 * fetching lands, the gated suites go live on their own, unedited.
 *
 * {@link gitRef} and {@link npmRef} are the single place the suites spell a
 * ref. They are thin — the grammar is `src/refs.ts`'s, and
 * {@link assertShimsMatchGrammar} keeps them honest — but centralizing the
 * spelling means a grammar change touches one file, not four.
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, resolveRef } from "../../src/resolve.js";
import { NotImplementedError } from "../../src/errors.js";
import { parseRef } from "../../src/refs.js";
import { lockfilePath } from "../../src/lockfile.js";
import type { ResolvedGraph } from "../../src/types.js";

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

/** Whether git-referenced layers are *fetched* yet (SPEC §2, build order step 9). */
export const GIT_REFS = implemented("github:acme/base#v1");

/** Whether npm-referenced layers are *resolved* yet (SPEC §2, build order step 9). */
export const NPM_REFS = implemented("@acme/base");

/**
 * A git layer ref pointing at a local `file://` remote at a given revision.
 *
 * `git+<url>#<committish>` is the explicit-transport form from `src/refs.ts`;
 * `github:o/r#rev` is its shorthand, and is not used by these tests because
 * resolving it would require the network.
 */
export function gitRef(repo: { url: string }, rev: string, subdir?: string): string {
  return `git+${repo.url}${subdir ? `?path=${subdir}` : ""}#${rev}`;
}

/** An npm layer ref, optionally carrying a version range (SPEC §2). */
export function npmRef(name: string, range?: string): string {
  return range ? `${name}@${range}` : name;
}

/**
 * The options bag `resolve` grows once fetching lands (`src/fetch/index.ts`
 * already defines them for `fetchLayer`).
 *
 * This is the suite's one forward-looking cast, and it is deliberate: the
 * tests that use it are gated off until fetching exists, but they still have
 * to *typecheck* today, and `resolve` currently takes a single argument. When
 * the signature grows, the cast becomes redundant and can be deleted without
 * touching a single test.
 */
export interface ResolveOptions {
  /** Refuse refs the lock does not pin (CI posture). */
  frozen?: boolean;
  /** Re-resolve moving refs, advancing the lock. */
  updateRefs?: boolean;
  /** Cache root override; prefer `TREELAY_CACHE_DIR` where it reaches. */
  cacheDir?: string;
}

export const resolveWith = resolve as unknown as (
  srcDir: string,
  options?: ResolveOptions,
) => ResolvedGraph;

/** Raw lockfile bytes, or undefined when the leaf has none. */
export function lockBytes(leafDir: string): Buffer | undefined {
  const file = lockfilePath(leafDir);
  return existsSync(file) ? readFileSync(file) : undefined;
}

/** Lockfile bytes, failing loudly when absent — for tests that require one. */
export function requireLockBytes(leafDir: string): Buffer {
  const bytes = lockBytes(leafDir);
  if (!bytes) {
    throw new Error(`expected a lockfile at ${lockfilePath(leafDir)} after compile`);
  }
  return bytes;
}

/**
 * Assert the shims above still produce what `src/refs.ts` claims to parse.
 *
 * Called from the ref suite. Without it, a grammar change would turn every
 * gated test into a puzzling resolution failure instead of one clear error
 * pointing at this file.
 */
export function assertShimsMatchGrammar(): void {
  const git = parseRef(gitRef({ url: "file:///tmp/r" }, "main", "sub"));
  if (git.kind !== "git" || git.committish !== "main" || git.subdir !== "sub") {
    throw new Error(`gitRef() no longer matches the parser: ${JSON.stringify(git)}`);
  }
  const npm = parseRef(npmRef("@acme/base", "^2"));
  if (npm.kind !== "npm" || npm.name !== "@acme/base" || npm.range !== "^2") {
    throw new Error(`npmRef() no longer matches the parser: ${JSON.stringify(npm)}`);
  }
}
