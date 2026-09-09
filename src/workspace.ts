/**
 * Locating the repo root that `//` refs resolve against — SPEC §2.
 *
 * A monorepo of layers has no way to say "this path, from the top". Every
 * intra-repo ref is relative to the manifest's own directory, so a layer six
 * directories deep writes `../../../../../packages/core/_layer` — five `..`
 * that nobody can verify by eye, that all change when a layer is filed one
 * level deeper, and that differ per leaf for the same target.
 *
 * Worse, an over-shooting relative ref lands on *some* real directory rather
 * than failing, which is how a mistyped ref becomes a silently wrong tree. A
 * root-relative ref either resolves to the intended layer or does not exist.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Markers that identify a repo/workspace root, in priority order.
 *
 * `.git` covers the overwhelming majority and needs no setup. The explicit
 * marker exists for trees that are not a git checkout (a vendored export, a
 * worktree assembled by a build) — without it those trees would have no way to
 * use `//` at all.
 */
export const ROOT_MARKERS = ["treelay.root.json", ".git"] as const;

/**
 * The nearest ancestor of `from` (inclusive) that looks like a repo root, or
 * `undefined` if there is none.
 *
 * Nearest rather than outermost: nested checkouts are real, and a layer inside
 * a submodule means paths from *that* repo's top, which is the root a reader of
 * that manifest is thinking in.
 */
export function findRepoRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    if (ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
