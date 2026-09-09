/**
 * Honouring a destination's `.gitignore` when scanning it — SPEC §8.
 *
 * `status` walks the destination to find files the template did not produce.
 * In a tree anyone has actually worked in, most of those files are build
 * output: `node_modules/`, `.venv/`, `__pycache__/`. One report put the single
 * real finding on line 75,295 of 75,321 — the signal was present and unusable.
 *
 * Git already knows which files are not worth mentioning, and the destination
 * almost always says so in a file sitting right there. Reading it is cheaper
 * and more accurate than any list treelay could maintain.
 */

import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import ignore, { type Ignore } from "ignore";

/** Directories never worth scanning, whatever the destination's rules say. */
export const NEVER_SCAN = ["**/.git/**"];

/**
 * A matcher over destination-relative POSIX paths.
 *
 * Built from every `.gitignore` in the tree, each scoped to its own directory —
 * a nested `.gitignore` governs its subtree only, as git does. Rules are tested
 * from the outermost matching file inwards, so a deeper file's negation can
 * re-include what an ancestor excluded.
 */
export interface IgnoreFilter {
  ignores(relPath: string): boolean;
  /** How many `.gitignore` files contributed, for reporting. */
  sources: number;
}

/** A filter that ignores nothing — the `--all` case, kept as a real object. */
export const ALLOW_ALL: IgnoreFilter = { ignores: () => false, sources: 0 };

/**
 * Build a filter from the `.gitignore` files among `relPaths`.
 *
 * Takes the already-walked file list rather than walking again: the caller has
 * just enumerated the tree, and a second traversal could disagree with the
 * first about what is there.
 */
export function buildIgnoreFilter(
  destDir: string,
  relPaths: readonly string[],
  readFile: (rel: string) => string = (rel) =>
    readFileSync(posix.join(destDir, rel), "utf8"),
): IgnoreFilter {
  const scoped: { prefix: string; matcher: Ignore }[] = [];

  for (const rel of relPaths) {
    if (posix.basename(rel) !== ".gitignore") continue;
    let body: string;
    try {
      body = readFile(rel);
    } catch {
      continue; // Unreadable is not ignorable; scanning it is the safe default.
    }
    const dir = dirname(rel);
    scoped.push({
      prefix: dir === "." ? "" : `${dir}/`,
      matcher: ignore().add(body),
    });
  }

  // Outermost first, so nested rules are applied after — and therefore win.
  scoped.sort((a, b) => a.prefix.length - b.prefix.length);

  return {
    sources: scoped.length,
    ignores(relPath: string): boolean {
      let ignored = false;
      for (const { prefix, matcher } of scoped) {
        if (prefix !== "" && !relPath.startsWith(prefix)) continue;
        const sub = relPath.slice(prefix.length);
        if (sub === "") continue;
        // `ignore` reports only positive matches, so a negation shows up as a
        // previously-ignored path no longer matching its own scope's rules.
        if (matcher.ignores(sub)) ignored = true;
        else if (ignored && matcher.test(sub).unignored) ignored = false;
      }
      return ignored;
    },
  };
}
