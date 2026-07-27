/**
 * Upstream drift — has a ref moved since the lock pinned it? (SPEC §3, §9)
 *
 * Drift is *reported*, never acted on. A build whose lock says `abc123` keeps
 * producing `abc123` even after `main` advances; that is the entire point of
 * pinning. What treelay owes the user is that the divergence is visible —
 * `explain` annotates the layer, `update` says so before merging, and
 * `treelay lock --update` is the one command that advances a pin.
 *
 * The probe is best-effort by construction. Being offline, lacking credentials,
 * or having deleted the package makes the current revision *unknown*, which is
 * a distinct answer from "unchanged" and is presented as one.
 */

import { liveRevision } from "./fetch/index.js";
import type { TreelayLock } from "./lockfile.js";
import { parseRef, type RemoteRef } from "./refs.js";
import type { Layer, ResolvedGraph } from "./types.js";

/** Whether a pinned ref still matches its upstream. */
export type DriftStatus = "in-sync" | "moved" | "unknown" | "immutable";

/** One ref's drift verdict. */
export interface DriftReport {
  /** Canonical ref (the lockfile key). */
  ref: string;
  /** What was asked for — branch, tag, or semver range. */
  requested: string;
  /** The revision the lock pins, and what any build here materializes. */
  locked: string;
  /** What the ref points at now; undefined when it could not be determined. */
  current?: string;
  status: DriftStatus;
  /** Layers composed from this ref, for a message that names names. */
  layers: string[];
}

/** Has anything actually moved? (unknown is not drift — it is ignorance). */
export function hasDrift(reports: readonly DriftReport[]): boolean {
  return reports.some((r) => r.status === "moved");
}

/**
 * Check every pinned ref in a resolved graph against its upstream.
 *
 * Contacts the network once per distinct ref, so callers should treat it as an
 * explicit action rather than something to fold into a hot path.
 */
export function checkDrift(graph: ResolvedGraph, fromDir?: string): DriftReport[] {
  const lock = graph.lock;
  if (!lock) return [];

  const anchor = fromDir ?? graph.lockDir ?? process.cwd();
  const reports: DriftReport[] = [];

  for (const key of Object.keys(lock.refs).sort()) {
    const entry = lock.refs[key]!;
    const layers = graph.layers
      .filter((l: Layer) => l.origin?.ref === key)
      .map((l) => l.manifest.name ?? l.id);

    const parsed = parseRef(key) as RemoteRef;
    // A ref written as an exact commit or exact version cannot move; saying
    // "in sync" would imply we checked something that has no upstream question.
    const immutable =
      (parsed.kind === "git" && parsed.committish === entry.resolved) ||
      (parsed.kind === "npm" && parsed.range === entry.resolved);

    const current = immutable ? entry.resolved : liveRevision(parsed, anchor);
    const status: DriftStatus = immutable
      ? "immutable"
      : current === undefined
        ? "unknown"
        : current === entry.resolved
          ? "in-sync"
          : "moved";

    reports.push({
      ref: key,
      requested: entry.requested,
      locked: entry.resolved,
      ...(current !== undefined ? { current } : {}),
      status,
      layers,
    });
  }
  return reports;
}

/** Short revision for display; npm versions are already short. */
function short(rev: string): string {
  return /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 12) : rev;
}

/** Human-readable drift summary. Empty string when nothing has moved. */
export function formatDrift(reports: readonly DriftReport[]): string {
  const moved = reports.filter((r) => r.status === "moved");
  if (!moved.length) return "";

  const lines = moved.map((r) => {
    const who = r.layers.length ? `  (${r.layers.join(", ")})` : "";
    return (
      `  ${r.ref}\n` +
      `    pinned  ${short(r.locked)}\n` +
      `    ${r.requested} is now  ${short(r.current!)}${who}`
    );
  });
  return (
    `${moved.length} ref(s) have moved upstream since treelay.lock was written:\n` +
    lines.join("\n") +
    `\nThis build used the pinned revisions. Run \`treelay lock --update\` to advance them.`
  );
}
