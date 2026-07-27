/**
 * Round-trip verification — SPEC §8 guard 2.
 *
 * "After any promote/extract, recompile and assert the working copy is
 * byte-identical." This is the guard that makes reflux trustworthy: a promoted
 * edit is only accepted once the graph provably reproduces it, so merge-order
 * interactions surface as a loud failure instead of silent drift.
 *
 * The comparison is deliberately one-directional. Every path the template
 * produces must match the destination exactly; files the destination has but
 * the template does not are *user-owned* (§7) and are none of verification's
 * business. Without that asymmetry every unpromoted local file would read as a
 * failure.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fg from "fast-glob";

import { compile } from "./compile.js";
import { STATE_DIR } from "./state.js";
import type { ResolvedGraph, Values } from "./types.js";

/**
 * Compose a graph and return its output in memory, without touching any real
 * destination.
 *
 * TODO: `compile.ts` is growing a `composeFiles` in-memory API; swap this
 * throwaway-directory implementation for it once that lands, to avoid the
 * round-trip through disk.
 */
export async function composeToMemory(
  graph: ResolvedGraph,
  values: Values,
): Promise<Map<string, Buffer>> {
  const temp = mkdtempSync(join(tmpdir(), "treelay-verify-"));
  try {
    await compile(graph, { destDir: temp, values });
    const files = new Map<string, Buffer>();
    for (const rel of fg.sync("**/*", {
      cwd: temp,
      dot: true,
      onlyFiles: true,
      ignore: [`${STATE_DIR}/**`],
    })) {
      files.set(rel, readFileSync(join(temp, rel)));
    }
    return files;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export type MismatchKind =
  | "content-differs"
  | "missing-in-dest"
  | "should-have-been-removed";

export interface VerifyMismatch {
  path: string;
  kind: MismatchKind;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: VerifyMismatch[];
  /** The recomposed output, reusable as the new baseline on success. */
  composed: Map<string, Buffer>;
}

export interface VerifyOptions {
  /**
   * Paths a promotion intended to remove. Verification asserts the recompiled
   * template no longer produces them — otherwise a promoted tombstone that
   * failed to take would pass unnoticed, since the file is already gone from
   * the destination either way.
   */
  expectAbsent?: string[];
}

/** Recompile `graph` and assert `destDir` reproduces it byte-for-byte. */
export async function roundTripVerify(
  destDir: string,
  graph: ResolvedGraph,
  values: Values,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const composed = await composeToMemory(graph, values);
  const mismatches: VerifyMismatch[] = [];

  for (const [rel, expected] of composed) {
    const abs = join(destDir, rel);
    if (!existsSync(abs)) {
      mismatches.push({
        path: rel,
        kind: "missing-in-dest",
        detail: "the template produces this file but the destination lacks it",
      });
      continue;
    }
    const actual = readFileSync(abs);
    if (!actual.equals(expected)) {
      mismatches.push({
        path: rel,
        kind: "content-differs",
        detail:
          `recompiled output differs from the working copy ` +
          `(${expected.length} vs ${actual.length} bytes)`,
      });
    }
  }

  for (const rel of options.expectAbsent ?? []) {
    if (composed.has(rel)) {
      mismatches.push({
        path: rel,
        kind: "should-have-been-removed",
        detail: "the template still produces this file after the promotion",
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches, composed };
}

/** Render mismatches into a message suitable for a thrown error. */
export function describeMismatches(mismatches: VerifyMismatch[]): string {
  return mismatches
    .map((m) => `  ${m.path} — ${m.kind}: ${m.detail}`)
    .join("\n");
}
