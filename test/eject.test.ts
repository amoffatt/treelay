/**
 * `eject` — severing a destination's template link (SPEC §7, §9).
 *
 * The thing worth pinning is the asymmetry: the composed files must survive
 * untouched, and the state must be gone completely enough that `update` stops
 * recognising the directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import { eject, formatEject, NotEjectableError } from "../src/eject.js";
import { hasState, STATE_DIR } from "../src/state.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-eject-"));
});
afterEach(() => {
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

/** Compile a two-layer template into `<root>/out` and return the destination. */
async function destination(): Promise<string> {
  layer("base", { "a.txt": "from base\n", "nested/b.txt": "nested\n" });
  const leaf = layer("leaf", {
    "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    "c.txt": "from leaf\n",
  });
  const dest = join(root, "out");
  await compile(resolve(leaf), { destDir: dest, values: {} });
  return dest;
}

describe("eject", () => {
  it("removes the state directory and leaves every composed file in place", async () => {
    const dest = await destination();
    expect(hasState(dest)).toBe(true);

    const result = eject(dest);

    expect(result.removed).toBe(true);
    expect(existsSync(join(dest, STATE_DIR))).toBe(false);
    expect(hasState(dest)).toBe(false);
    // The whole point: the output is untouched.
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("from base\n");
    expect(readFileSync(join(dest, "c.txt"), "utf8")).toBe("from leaf\n");
    expect(readFileSync(join(dest, "nested/b.txt"), "utf8")).toBe("nested\n");
  });

  it("reports the template it was tracking and the layers behind it", async () => {
    const dest = await destination();
    const result = eject(dest, { dryRun: true });

    expect(result.source).toMatch(/leaf$/);
    expect(result.lineage.length).toBe(2); // base + leaf
    expect(result.tracked).toEqual(["a.txt", "c.txt", "nested/b.txt"]);
  });

  it("removes nothing on a dry run", async () => {
    const dest = await destination();

    const result = eject(dest, { dryRun: true });

    expect(result.removed).toBe(false);
    expect(existsSync(join(dest, STATE_DIR))).toBe(true);
    expect(hasState(dest)).toBe(true);
  });

  it("separates files you created from files the template owns", async () => {
    const dest = await destination();
    writeFileSync(join(dest, "mine.txt"), "hand-written\n");

    const result = eject(dest, { dryRun: true });

    expect(result.tracked).not.toContain("mine.txt");
    // The manifest only records paths compile knew about, so a file created
    // afterwards is simply absent — it is neither tracked nor at risk.
    expect(existsSync(join(dest, "mine.txt"))).toBe(true);
  });

  it("refuses a directory that was never compiled", () => {
    const plain = join(root, "not-a-destination");
    mkdirSync(plain, { recursive: true });

    expect(() => eject(plain)).toThrow(NotEjectableError);
    // The message has to say why, since "no state" and "wrong path" look the
    // same from the outside.
    expect(() => eject(plain)).toThrow(/no \.treelay state/);
  });

  it("is not silently repeatable — a second eject fails loud", async () => {
    const dest = await destination();
    eject(dest);
    expect(() => eject(dest)).toThrow(NotEjectableError);
  });

  it("formats a summary that names the consequence", async () => {
    const dest = await destination();

    const preview = formatEject(eject(dest, { dryRun: true }), dest);
    expect(preview).toContain("Would eject");
    expect(preview).toContain("--dry-run");

    const done = formatEject(eject(dest), dest);
    expect(done).toContain("Ejected");
    expect(done).toContain("treelay update` no longer works");
  });
});
