/**
 * The `treelay lock` command, as a function (SPEC §3, §9).
 *
 * Lives here rather than inline in `cli.ts` because the interesting part is not
 * the printing — it is *which mode writes*, and *what exits non-zero*. `--check`
 * must never be able to fix the thing it is checking, and `--drift` must fail a
 * CI job. Both are behaviours worth a test, and neither is testable from inside
 * an action handler that calls `process.exit`.
 *
 * The command returns its output instead of printing it, so `cli.ts` stays the
 * thin shell it claims to be.
 */

import { resolve, type ResolveOptions } from "./resolve.js";
import { lockfilePath, writeLock } from "./lockfile.js";
import { checkDrift, formatDrift, hasDrift } from "./drift.js";

export interface LockCommandOptions extends ResolveOptions {
  /** Verify the lock is complete and current; write nothing. */
  check?: boolean;
  /** Re-resolve moving refs to their current upstream revision. */
  update?: boolean;
  /** Report refs whose upstream has moved. Needs the network. */
  drift?: boolean;
}

export interface LockCommandResult {
  /** Lines destined for stdout. */
  output: string[];
  /** Lines destined for stderr. */
  errors: string[];
  /** What the process should exit with: 0 unless a check failed. */
  exitCode: number;
  /** Whether the lockfile on disk was actually rewritten. */
  wrote: boolean;
  /** Canonical refs pinned, sorted. */
  refs: string[];
}

/** Abbreviate a commit SHA for display; package versions pass through. */
export function shortRev(rev: string): string {
  return /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 12) : rev;
}

export function lockCommand(
  dir: string,
  options: LockCommandOptions = {},
): LockCommandResult {
  const { check, update, drift, ...resolveOptions } = options;

  const graph = resolve(dir, {
    ...resolveOptions,
    // `--check` resolves in the normal mode and then refuses to write, rather
    // than resolving frozen: it is reporting on the lock, not relying on it.
    ...(update ? { updateRefs: true } : {}),
  });

  const entries = Object.entries(graph.lock?.refs ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const result: LockCommandResult = {
    output: [],
    errors: [],
    exitCode: 0,
    wrote: false,
    refs: entries.map(([ref]) => ref),
  };

  if (check) {
    if (graph.lockDirty) {
      result.errors.push(
        `${lockfilePath(dir)} is out of date.\n` +
          `Run \`treelay lock ${dir}\` and commit the result.`,
      );
      // Returns early: listing the pins underneath a failure reads as though
      // the command succeeded.
      return { ...result, exitCode: 1 };
    }
    result.output.push(`treelay.lock is up to date (${entries.length} pinned ref(s)).`);
  } else if (graph.lock && graph.lockDir) {
    result.wrote = writeLock(graph.lockDir, graph.lock);
    result.output.push(
      result.wrote
        ? `Wrote ${lockfilePath(dir)} — ${entries.length} pinned ref(s).`
        : `treelay.lock already current (${entries.length} pinned ref(s)).`,
    );
  }

  for (const [ref, entry] of entries) {
    result.output.push(
      `  ${ref}\n    → ${shortRev(entry.resolved)}  ${entry.integrity.slice(0, 21)}…`,
    );
  }

  if (drift) {
    const reports = checkDrift(graph);
    result.output.push(formatDrift(reports) || "\nAll pinned refs match their upstream.");
    // Non-zero so a scheduled job can notice an upstream has moved.
    if (hasDrift(reports)) result.exitCode = 1;
  }

  return result;
}
