/**
 * `watch` — recompile a template into a destination as its sources change
 * (SPEC §9, §12 step 10).
 *
 * The loop is deliberately a full re-`resolve` plus re-`compile`, not an
 * incremental update. Editing a manifest can change the *graph* — add a parent,
 * reorder mixins, move a mount — so anything cached from the previous pass may
 * already be wrong. Composition is cheap relative to how often a human saves a
 * file, and a watch loop that is subtly stale is worse than one that is simply
 * slower.
 *
 * Only **local** layers are watched. Fetched git and npm layers are pinned to a
 * revision and cannot change underneath a build without the lock changing too,
 * so watching the cache would be watching something that is immutable by
 * construction.
 */

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { relative, resolve as resolvePath, isAbsolute, sep } from "node:path";

import { resolve, type ResolveOptions } from "./resolve.js";
import { compile } from "./compile.js";
import { resolveValues } from "./variables.js";
import { hasState, readState, sourceOf, STATE_DIR } from "./state.js";
import type { Values } from "./types.js";

/** Something the watch loop wants the caller to know about. */
export type WatchEvent =
  | { kind: "ready"; roots: string[] }
  | { kind: "compiled"; files: number; ms: number; trigger?: string }
  | { kind: "failed"; error: Error; trigger?: string };

export interface WatchOptions extends ResolveOptions {
  /** Values to compose with, as `compile` would receive them. */
  values?: Values;
  /**
   * How long to wait for the filesystem to settle before recompiling.
   * Editors write, rename and touch in bursts; without this a single save
   * triggers several builds.
   */
  debounceMs?: number;
  /**
   * Poll for changes instead of using native filesystem events.
   *
   * Native events do not cross some boundaries — network shares, Docker bind
   * mounts, a few virtualised filesystems — where a watcher silently never
   * fires. Polling is slower and busier, but it works everywhere.
   */
  usePolling?: boolean;
  /** How often to poll, when polling. */
  pollIntervalMs?: number;
  /** Progress callback; the CLI prints these. */
  onEvent?: (event: WatchEvent) => void;
}

export interface WatchHandle {
  /** Local layer directories being watched. */
  roots: string[];
  /** Stop watching. Safe to call more than once. */
  close: () => Promise<void>;
  /** Recompile now, as a change would. Exposed for tests and manual triggers. */
  trigger: () => Promise<void>;
}

/** Raised when the destination belongs to a different template. */
export class WatchTargetError extends Error {
  constructor(destDir: string, existing: string, incoming: string) {
    super(
      `${destDir} was compiled from ${existing}, not ${incoming}. Watching it ` +
        `would overwrite that project's files. Pick an empty destination.`,
    );
    this.name = "WatchTargetError";
  }
}

/** True when `child` is `parent` or sits underneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Directories worth watching: every local layer, minus any that the
 * destination would sit on top of.
 */
function watchRoots(layerDirs: string[], destDir: string): string[] {
  const roots: string[] = [];
  for (const dir of layerDirs) {
    if (isInside(dir, destDir) && dir === destDir) continue; // never watch the output itself
    if (!roots.some((r) => isInside(r, dir))) {
      // Drop any root this new one subsumes, then add it.
      for (let i = roots.length - 1; i >= 0; i--) {
        if (isInside(dir, roots[i]!)) roots.splice(i, 1);
      }
      roots.push(dir);
    }
  }
  return roots.sort();
}

/**
 * Start watching `srcDir`'s local layers and recompiling into `destDir`.
 *
 * Resolves once up front so a broken graph fails immediately rather than on the
 * first save, and returns a handle the caller closes to stop.
 */
export async function watch(
  srcDir: string,
  destDir: string,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const {
    values,
    debounceMs = 120,
    usePolling,
    pollIntervalMs,
    onEvent,
    ...resolveOptions
  } = options;
  const src = resolvePath(srcDir);
  const dest = resolvePath(destDir);

  // Watching a destination that belongs to some other template would silently
  // overwrite it, so that is refused before anything is written.
  if (hasState(dest)) {
    const existing = sourceOf(readState(dest));
    if (existing && resolvePath(existing) !== src) {
      throw new WatchTargetError(dest, existing, src);
    }
  }

  let watcher: FSWatcher | undefined;
  let roots: string[] = [src];

  /**
   * Bring the watched set in line with the graph we just resolved.
   *
   * The layer set is not fixed: adding a parent brings a directory into the
   * composition that was not being watched a moment ago, and without this the
   * next edit to it would go unnoticed.
   */
  const syncRoots = (dirs: string[]): void => {
    const next = watchRoots([src, ...dirs], dest);
    const added = next.filter((r) => !roots.includes(r));
    roots = next;
    if (added.length && watcher) watcher.add(added);
  };

  const build = async (trigger?: string): Promise<void> => {
    const started = Date.now();
    try {
      // Re-resolved every pass: a manifest edit can reshape the whole graph.
      const graph = resolve(src, resolveOptions);
      // Values go through the full §6 resolution so declared defaults and
      // computed variables apply, but never interactively: a watch loop that
      // blocks on a prompt stops being a watch loop.
      const composed = await resolveValues(graph, {
        ...(values ? { set: values } : {}),
        prompt: false,
      });
      const result = await compile(graph, { destDir: dest, values: composed });
      syncRoots(
        graph.layers.filter((l) => !l.origin || l.origin.kind === "local").map((l) => l.dir),
      );
      onEvent?.({
        kind: "compiled",
        files: Object.keys(result.files).length,
        ms: Date.now() - started,
        ...(trigger ? { trigger } : {}),
      });
    } catch (err) {
      // A broken intermediate state is normal while editing — a missing parent
      // mid-rename, a half-saved manifest — so a failed build reports and keeps
      // watching rather than tearing the loop down. The leaf stays watched, so
      // there is always somewhere to fix it from.
      onEvent?.({
        kind: "failed",
        error: err instanceof Error ? err : new Error(String(err)),
        ...(trigger ? { trigger } : {}),
      });
    }
  };

  await build();

  let timer: NodeJS.Timeout | undefined;
  let pending: string | undefined;
  let closed = false;

  watcher = chokidarWatch(roots, {
    ignoreInitial: true,
    ...(usePolling ? { usePolling: true } : {}),
    ...(pollIntervalMs !== undefined ? { interval: pollIntervalMs } : {}),
    // The output must never feed the loop that produces it, and neither should
    // the state directory compile itself writes on every pass.
    ignored: (path: string) =>
      isInside(dest, path) ||
      path.split(sep).includes(STATE_DIR) ||
      path.split(sep).includes("node_modules") ||
      path.split(sep).includes(".git"),
  });

  watcher.on("all", (_event, path: string) => {
    if (closed) return;
    pending ??= path;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const trigger = pending;
      pending = undefined;
      timer = undefined;
      void build(trigger);
    }, debounceMs);
  });

  await new Promise<void>((res) => watcher.once("ready", () => res()));
  onEvent?.({ kind: "ready", roots });

  return {
    // A getter, not a snapshot: `syncRoots` replaces the array when the graph
    // gains a layer, and a stale copy would misreport what is being watched.
    get roots() {
      return roots;
    },
    trigger: () => build(),
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}

/** One-line rendering of a watch event, for the CLI. */
export function formatWatchEvent(event: WatchEvent): string {
  switch (event.kind) {
    case "ready":
      return `Watching ${event.roots.length} layer(s). Ctrl-C to stop.`;
    case "compiled":
      return (
        `Compiled ${event.files} file(s) in ${event.ms}ms` +
        (event.trigger ? `  ← ${event.trigger}` : "")
      );
    case "failed":
      return `Build failed: ${event.error.message}`;
  }
}
