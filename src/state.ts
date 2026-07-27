/**
 * Destination `.treelay/` state — SPEC §7.
 *
 * Written into the compiled destination so the template link survives: the
 * lockfile (resolved lineage), persisted answers (deterministic re-render),
 * the baseline (merge base for update & reflux), and the generated/owned map.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedGraph, VariableDecl, Values } from "./types.js";

export const STATE_DIR = ".treelay";

export interface TreelayState {
  lock: LockFile;
  answers: Values;
  /** relative path → content hash of what the template last produced. */
  baseline: Record<string, string>;
  /** relative path → whether the template owns it (vs user-created). */
  manifest: Record<string, { owned: boolean; fromLayer: string }>;
}

export interface LockFile {
  /**
   * Layer ids/refs lowest → highest precedence at last compile. The last entry
   * is the leaf — this is how `update <dest>` rediscovers its source template
   * without being told where it came from.
   */
  lineage: string[];
  /** Resolved version refs per layer (npm/git), for drift detection. */
  versions: Record<string, string>;
}

export const statePaths = (destDir: string) => ({
  dir: join(destDir, STATE_DIR),
  lock: join(destDir, STATE_DIR, "lock.json"),
  answers: join(destDir, STATE_DIR, "answers.json"),
  baseline: join(destDir, STATE_DIR, "baseline.json"),
  /** Content snapshot of the last template output — the diff3 merge base (§7). */
  baselineDir: join(destDir, STATE_DIR, "baseline"),
  manifest: join(destDir, STATE_DIR, "manifest.json"),
});

/**
 * The leaf template a destination was compiled from, recovered from the lock.
 * Returns undefined for a lockfile with no lineage (nothing to update against).
 */
export function sourceOf(state: TreelayState): string | undefined {
  return state.lock.lineage[state.lock.lineage.length - 1];
}

/** Whether a destination already carries treelay state (⇒ `update`, not compile). */
export function hasState(destDir: string): boolean {
  return existsSync(statePaths(destDir).lock);
}

/**
 * Drop `secret` variables from the answers before persisting (§6/§7): secrets
 * are masked input and must never be written to disk.
 */
function stripSecrets(
  values: Values,
  decls: Record<string, VariableDecl>,
): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values)) {
    if (decls[k]?.secret) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Persist the state artifacts into `<destDir>/.treelay/`.
 *
 * `snapshot` is the exact content the template just produced. It is stored
 * alongside the hash index because the two answer different questions: the hash
 * cheaply decides *whether* a file changed, but only the content can serve as
 * the merge base when both the template and the user changed it (§7). Passing
 * it replaces any previous snapshot wholesale, so files the template no longer
 * produces don't linger as stale merge bases.
 */
export function writeState(
  destDir: string,
  state: TreelayState,
  decls: Record<string, VariableDecl>,
  snapshot?: ReadonlyMap<string, Buffer>,
): void {
  const paths = statePaths(destDir);
  mkdirSync(paths.dir, { recursive: true });
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  writeFileSync(paths.lock, json(state.lock));
  writeFileSync(paths.answers, json(stripSecrets(state.answers, decls)));
  writeFileSync(paths.baseline, json(state.baseline));
  writeFileSync(paths.manifest, json(state.manifest));

  if (snapshot) {
    rmSync(paths.baselineDir, { recursive: true, force: true });
    for (const [rel, data] of snapshot) {
      const abs = join(paths.baselineDir, rel);
      ensureDir(abs);
      writeFileSync(abs, data);
    }
  }
}

/**
 * Read one file's baseline content — the merge base for `update` (§7).
 * Undefined when the destination predates snapshotting or never had the file.
 */
export function readBaselineFile(
  destDir: string,
  rel: string,
): Buffer | undefined {
  const abs = join(statePaths(destDir).baselineDir, rel);
  return existsSync(abs) ? readFileSync(abs) : undefined;
}

/** Read back persisted state (used by update/status/reflux). */
export function readState(destDir: string): TreelayState {
  const paths = statePaths(destDir);
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  return {
    lock: read(paths.lock),
    answers: read(paths.answers),
    baseline: read(paths.baseline),
    manifest: read(paths.manifest),
  };
}

/** Build a lockfile from a resolved graph (versions filled in once npm/git land). */
export function lockFromGraph(graph: ResolvedGraph): LockFile {
  return {
    lineage: graph.layers.map((l) => l.id),
    versions: {},
  };
}

/** Ensure a file's parent directory exists before writing it. */
export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
