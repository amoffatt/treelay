/**
 * Blast radius — SPEC §8 guard 3.
 *
 * "Promoting up reaches *every sibling* inheriting that layer — the intent, but
 * a footgun." Before a promote lands, report who else is downstream of the
 * target so the reach is a stated fact rather than a surprise on someone else's
 * next `update`.
 *
 * Two populations, found two different ways:
 *
 * - **dependents** — other *layers* declaring the target as a parent or mixin.
 *   Found by reading manifests. These inherit the change by composition.
 * - **destinations** — already-compiled *projects* whose lockfile lineage
 *   includes the target. Found by reading `.treelay/lock.json`. These are live
 *   deployments that will absorb the change when they next update.
 *
 * The search is bounded: reflux passes a root (normally the common ancestor of
 * the composition) rather than letting this wander the filesystem.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import fg from "fast-glob";

import { loadManifest } from "./manifest.js";
import { resolveRef } from "./resolve.js";
import { STATE_DIR } from "./state.js";
import type { LockFile } from "./state.js";

export interface BlastRadius {
  /** The layer being promoted into. */
  layer: string;
  searchRoot: string;
  /** Other layer dirs that declare the target as a parent or mixin. */
  dependents: string[];
  /** Compiled destination dirs whose lineage includes the target. */
  destinations: string[];
  /**
   * True when the scan may be incomplete — consumers can live outside the
   * search root, so "none found" is never proof of "none exist".
   */
  bounded: boolean;
}

export interface BlastRadiusOptions {
  /** Directory to scan. Consumers outside it are invisible to this scan. */
  searchRoot: string;
  /** Destination doing the promoting; excluded from `destinations`. */
  excludeDest?: string;
  /** Layer doing the promoting; excluded from `dependents`. */
  excludeLayer?: string;
  /** Directory depth to scan. Deep enough for a monorepo, bounded for sanity. */
  depth?: number;
}

const MANIFEST_GLOBS = [
  "**/treelay.json",
  "**/treelay.yaml",
  "**/treelay.yml",
  "**/package.json",
];

const SCAN_IGNORE = ["**/node_modules/**", "**/.git/**"];

/** Find every layer and compiled destination downstream of `layerDir`. */
export function blastRadius(
  layerDir: string,
  options: BlastRadiusOptions,
): BlastRadius {
  const target = resolvePath(layerDir);
  const searchRoot = resolvePath(options.searchRoot);
  const depth = options.depth ?? 8;

  const dependents = new Set<string>();
  const destinations = new Set<string>();

  for (const rel of fg.sync(MANIFEST_GLOBS, {
    cwd: searchRoot,
    dot: true,
    onlyFiles: true,
    deep: depth,
    ignore: SCAN_IGNORE,
  })) {
    const dir = resolvePath(searchRoot, dirname(rel));
    if (dir === target) continue;
    if (options.excludeLayer && dir === resolvePath(options.excludeLayer)) continue;

    const manifest = loadManifest(dir);
    const refs = [...(manifest.parents ?? []), ...(manifest.mixins ?? [])];
    for (const ref of refs) {
      let resolved: string;
      try {
        resolved = resolveRef(ref, dir);
      } catch {
        continue; // unresolvable (npm/git pending §2) — cannot be scored
      }
      if (resolved === target) dependents.add(dir);
    }
  }

  for (const rel of fg.sync(`**/${STATE_DIR}/lock.json`, {
    cwd: searchRoot,
    dot: true,
    onlyFiles: true,
    deep: depth + 1,
    ignore: SCAN_IGNORE,
  })) {
    const destDir = resolvePath(searchRoot, dirname(dirname(rel)));
    if (options.excludeDest && destDir === resolvePath(options.excludeDest)) continue;
    try {
      const lock = JSON.parse(readFileSync(join(searchRoot, rel), "utf8")) as LockFile;
      if (lock.lineage?.includes(target)) destinations.add(destDir);
    } catch {
      continue; // unreadable lockfile is not evidence of a consumer
    }
  }

  return {
    layer: target,
    searchRoot,
    dependents: [...dependents].sort(),
    destinations: [...destinations].sort(),
    bounded: true,
  };
}

/** A one-line warning in the shape SPEC §8 guard 3 asks for. */
export function describeBlastRadius(radius: BlastRadius, layerName: string): string {
  const n = radius.dependents.length;
  const d = radius.destinations.length;
  if (n === 0 && d === 0) {
    return `${layerName} has no other known consumers under ${radius.searchRoot}.`;
  }
  const parts: string[] = [];
  if (n) parts.push(`${n} other layer${n === 1 ? "" : "s"} inherit${n === 1 ? "s" : ""} it`);
  if (d) parts.push(`${d} compiled destination${d === 1 ? "" : "s"} include${d === 1 ? "s" : ""} it`);
  return (
    `${layerName} is consumed beyond this project — ${parts.join(", ")}. ` +
    `This edit reaches all of them on their next update.`
  );
}

/** The deepest directory containing every given path — a natural search root. */
export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return resolvePath(".");
  const split = paths.map((p) => resolvePath(p).split(sep));
  const first = split[0]!;
  let i = 0;
  while (i < first.length && split.every((parts) => parts[i] === first[i])) i++;
  return split[0]!.slice(0, i).join(sep) || sep;
}
