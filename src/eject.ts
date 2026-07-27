/**
 * `eject` — sever a destination's link to its template (SPEC §7, §9).
 *
 * The composed files are already plain files on disk; the only thing binding a
 * destination to its template is `<dest>/.treelay/`. Ejecting removes that
 * directory and nothing else, so the output is untouched and the project simply
 * stops being a treelay instance.
 *
 * This is deliberately one-way. The baseline it deletes is the merge base that
 * makes `update` a three-way merge rather than a guess, and it cannot be
 * reconstructed from the output afterwards — the composed tree records what the
 * files *are*, not what the template last produced. Hence {@link EjectResult}
 * reporting what is about to be lost, and a dry run to see it first.
 */

import { rmSync } from "node:fs";
import { readState, statePaths, hasState, sourceOf } from "./state.js";

export interface EjectOptions {
  /** Report what would be severed; remove nothing. */
  dryRun?: boolean;
}

export interface EjectResult {
  /** The leaf template the destination was compiled from, when recorded. */
  source?: string;
  /** Layer ids lowest → highest precedence at the last compile. */
  lineage: string[];
  /** Output paths the template was tracking, and would no longer update. */
  tracked: string[];
  /** Paths present in the output that the template never owned. */
  userOwned: string[];
  /** False for a dry run; true once the state directory is gone. */
  removed: boolean;
}

/** Raised when a directory carries no treelay state to eject. */
export class NotEjectableError extends Error {
  constructor(destDir: string) {
    super(
      `${destDir} has no .treelay state — it is not a compiled destination, ` +
        `so there is no template link to sever.`,
    );
    this.name = "NotEjectableError";
  }
}

/**
 * Remove a destination's template link, leaving every composed file in place.
 *
 * Fails loud on a directory that was never compiled rather than silently
 * succeeding: "nothing to do" and "you pointed this at the wrong directory"
 * look identical to the caller otherwise.
 */
export function eject(destDir: string, options: EjectOptions = {}): EjectResult {
  if (!hasState(destDir)) throw new NotEjectableError(destDir);

  // Read before deleting: the report is the only record the user gets of what
  // the link was tracking.
  const state = readState(destDir);
  const entries = Object.entries(state.manifest);
  const source = sourceOf(state);

  const result: EjectResult = {
    ...(source !== undefined ? { source } : {}),
    lineage: state.lock.lineage,
    // `owned` marks a *user*-created file, so the template's own files are the
    // ones where it is false (§7).
    tracked: entries.filter(([, m]) => !m.owned).map(([path]) => path).sort(),
    userOwned: entries.filter(([, m]) => m.owned).map(([path]) => path).sort(),
    removed: false,
  };

  if (options.dryRun) return result;

  rmSync(statePaths(destDir).dir, { recursive: true, force: true });
  return { ...result, removed: true };
}

/** Human-readable summary of an eject (or of what one would do). */
export function formatEject(result: EjectResult, destDir: string): string {
  const lines: string[] = [];
  const verb = result.removed ? "Ejected" : "Would eject";

  lines.push(`${verb} ${destDir}.`);
  if (result.source) lines.push(`  was tracking: ${result.source}`);
  if (result.lineage.length) {
    lines.push(`  composed from ${result.lineage.length} layer(s)`);
  }
  lines.push(`  ${result.tracked.length} template-owned file(s) left in place`);
  if (result.userOwned.length) {
    lines.push(`  ${result.userOwned.length} file(s) you created, untouched`);
  }

  lines.push(
    result.removed
      ? `\n\`treelay update\` no longer works here. Re-linking means compiling ` +
          `the template into a fresh directory and copying your changes across.`
      : `\nNothing was removed. Re-run without --dry-run to sever the link.`,
  );
  return lines.join("\n");
}
