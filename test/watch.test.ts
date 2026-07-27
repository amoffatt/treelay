/**
 * `watch` — the recompile-on-change loop (SPEC §9, §12 step 10).
 *
 * Filesystem events are inherently racy, so the deterministic behaviour (what a
 * rebuild produces, what is refused, what is watched) is driven through the
 * handle's `trigger`, and exactly one test proves that a real write actually
 * reaches the watcher. That keeps the suite fast and stable without letting the
 * interesting claim — "it notices" — go unproven.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { watch, formatWatchEvent, WatchTargetError, type WatchEvent, type WatchHandle } from "../src/watch.js";

let root: string;
const open: WatchHandle[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-watch-"));
});
afterEach(async () => {
  // A leaked watcher keeps the event loop alive and hangs the run.
  await Promise.all(open.splice(0).map((h) => h.close()));
  rmSync(root, { recursive: true, force: true });
});

function layer(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** Start a watcher and register it for teardown. */
async function start(src: string, dest: string, events: WatchEvent[] = []) {
  const handle = await watch(src, dest, {
    debounceMs: 20,
    onEvent: (e) => events.push(e),
  });
  open.push(handle);
  return handle;
}

/** Poll until `check` passes, or fail after `ms`. */
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met within ${ms}ms`);
}

const out = (dest: string, rel: string) => readFileSync(join(dest, rel), "utf8");

describe("watch", () => {
  it("compiles once on start, before any change arrives", async () => {
    layer("base", { "a.txt": "one\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = join(root, "out");
    const events: WatchEvent[] = [];

    await start(leaf, dest, events);

    expect(out(dest, "a.txt")).toBe("one\n");
    expect(events.filter((e) => e.kind === "compiled")).toHaveLength(1);
    expect(events.some((e) => e.kind === "ready")).toBe(true);
  });

  it("picks up an edit to a parent layer on rebuild", async () => {
    const base = layer("base", { "a.txt": "one\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = join(root, "out");
    const handle = await start(leaf, dest);

    writeFileSync(join(base, "a.txt"), "two\n");
    await handle.trigger();

    expect(out(dest, "a.txt")).toBe("two\n");
  });

  it("re-resolves the graph, so a manifest edit changes the layer stack", async () => {
    layer("base", { "a.txt": "from base\n" });
    layer("other", { "a.txt": "from other\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = join(root, "out");
    const handle = await start(leaf, dest);
    expect(out(dest, "a.txt")).toBe("from base\n");

    // Re-point the leaf at a different parent. An incremental loop that cached
    // the stack would keep composing the old one.
    writeFileSync(
      join(leaf, "treelay.json"),
      JSON.stringify({ name: "leaf", parents: ["../other"] }),
    );
    await handle.trigger();

    expect(out(dest, "a.txt")).toBe("from other\n");
  });

  it("notices a real filesystem write", { timeout: 30_000 }, async () => {
    const base = layer("base", { "a.txt": "one\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = join(root, "out");
    const events: WatchEvent[] = [];

    // Polling rather than native events: this is the one test that depends on
    // the watcher actually firing, and macOS FSEvents can lag by seconds when
    // the whole suite is running in parallel. Polling trades speed for a
    // deterministic bound, which is the right trade for a correctness claim.
    const handle = await watch(leaf, dest, {
      debounceMs: 20,
      usePolling: true,
      pollIntervalMs: 25,
      onEvent: (e) => events.push(e),
    });
    open.push(handle);

    writeFileSync(join(base, "a.txt"), "changed\n");

    await waitFor(() => events.filter((e) => e.kind === "compiled").length >= 2, 20_000);
    expect(out(dest, "a.txt")).toBe("changed\n");
  });

  it("applies declared defaults instead of rendering variables empty", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        templateSuffix: ".tmpl",
        variables: { svc: { type: "string", default: "billing" } },
      }),
      "a.txt.tmpl": "{{ svc }}\n",
    });
    const dest = join(root, "out");

    await start(leaf, dest);

    // Handing raw values straight to compile would skip §6 resolution and
    // render this as an empty string.
    expect(out(dest, "a.txt")).toBe("billing\n");
  });

  it("lets supplied values override a default", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        templateSuffix: ".tmpl",
        variables: { svc: { type: "string", default: "billing" } },
      }),
      "a.txt.tmpl": "{{ svc }}\n",
    });
    const dest = join(root, "out");

    const handle = await watch(leaf, dest, { debounceMs: 20, values: { svc: "payments" } });
    open.push(handle);

    expect(out(dest, "a.txt")).toBe("payments\n");
  });

  it("starts watching a layer added to the graph after startup", async () => {
    layer("added", { "new.txt": "arrived\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf" }),
    });
    const dest = join(root, "out");
    const handle = await start(leaf, dest);

    expect(handle.roots).not.toContain(join(root, "added"));

    writeFileSync(
      join(leaf, "treelay.json"),
      JSON.stringify({ name: "leaf", parents: ["../added"] }),
    );
    await handle.trigger();

    // Without re-syncing, edits to a newly-declared parent would go unnoticed.
    expect(handle.roots).toContain(join(root, "added"));
    expect(out(dest, "new.txt")).toBe("arrived\n");
  });

  it("keeps watching after a build fails", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../gone"] }),
    });
    const dest = join(root, "out");
    const events: WatchEvent[] = [];

    // A missing parent is a normal intermediate state while editing, so the
    // first build fails and the watcher still comes up.
    const handle = await start(leaf, dest, events);

    expect(events.some((e) => e.kind === "failed")).toBe(true);
    expect(events.some((e) => e.kind === "ready")).toBe(true);

    layer("gone", { "a.txt": "recovered\n" });
    await handle.trigger();

    expect(out(dest, "a.txt")).toBe("recovered\n");
  });

  it("refuses a destination compiled from a different template", async () => {
    layer("base", { "a.txt": "x\n" });
    const first = layer("first", {
      "treelay.json": JSON.stringify({ name: "first", parents: ["../base"] }),
    });
    const second = layer("second", {
      "treelay.json": JSON.stringify({ name: "second", parents: ["../base"] }),
    });
    const dest = join(root, "out");

    const handle = await start(first, dest);
    await handle.close();
    open.length = 0;

    await expect(watch(second, dest, { debounceMs: 20 })).rejects.toThrow(WatchTargetError);
  });

  it("does not watch the destination, even nested inside the source", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf" }),
      "a.txt": "x\n",
    });
    // The §7 shape: compiling into a directory inside the layer being watched.
    const dest = join(leaf, "build");
    const events: WatchEvent[] = [];
    const handle = await start(leaf, dest, events);

    const before = events.filter((e) => e.kind === "compiled").length;
    await handle.trigger();

    // If the output fed the watcher, that rebuild would cascade indefinitely.
    await new Promise((r) => setTimeout(r, 250));
    expect(events.filter((e) => e.kind === "compiled").length).toBe(before + 1);
  });

  it("stops rebuilding once closed", async () => {
    const base = layer("base", { "a.txt": "one\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = join(root, "out");
    const events: WatchEvent[] = [];
    const handle = await start(leaf, dest, events);

    await handle.close();
    open.length = 0;
    const after = events.length;

    writeFileSync(join(base, "a.txt"), "ignored\n");
    await new Promise((r) => setTimeout(r, 300));

    expect(events.length).toBe(after);
    expect(out(dest, "a.txt")).toBe("one\n");
  });
});

describe("formatWatchEvent", () => {
  it("renders each event kind", () => {
    expect(formatWatchEvent({ kind: "ready", roots: ["/a", "/b"] })).toContain("2 layer(s)");
    expect(formatWatchEvent({ kind: "compiled", files: 3, ms: 12 })).toContain("3 file(s)");
    expect(
      formatWatchEvent({ kind: "compiled", files: 1, ms: 5, trigger: "/x/a.txt" }),
    ).toContain("← /x/a.txt");
    expect(
      formatWatchEvent({ kind: "failed", error: new Error("boom") }),
    ).toContain("Build failed: boom");
  });
});
