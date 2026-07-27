import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolve } from "../src/resolve.js";
import { resolveValues } from "../src/variables.js";
import { compile } from "../src/compile.js";
import { readState } from "../src/state.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-compile-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `files` (relative path → contents) under `<root>/<layer>`. */
function layer(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Compile `leafDir` into a fresh dest and return the dest path. */
async function build(leafDir: string, values: Record<string, unknown> = {}) {
  const dest = join(root, "out");
  const graph = resolve(leafDir);
  await compile(graph, { destDir: dest, values });
  return dest;
}

const read = (dest: string, rel: string) => readFileSync(join(dest, rel), "utf8");

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("compile — precedence & strategies", () => {
  it("higher layers replace inherited plain files, lower-only files survive", async () => {
    layer("base", { "a.txt": "base-a", "keep.txt": "from-base" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "a.txt": "leaf-a",
    });
    const dest = await build(leaf);
    expect(read(dest, "a.txt")).toBe("leaf-a");
    expect(read(dest, "keep.txt")).toBe("from-base");
  });

  it("deep-merges JSON across layers (objects merge, child wins scalars)", async () => {
    layer("base", {
      "pkg.json": JSON.stringify({ name: "base", scripts: { build: "tsc" } }),
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "pkg.json": JSON.stringify({ name: "leaf", scripts: { test: "vitest" } }),
    });
    const dest = await build(leaf);
    expect(JSON.parse(read(dest, "pkg.json"))).toEqual({
      name: "leaf",
      scripts: { build: "tsc", test: "vitest" },
    });
  });
});

describe("compile — rendering (suffix opt-in)", () => {
  it("renders *.tmpl content and strips the suffix; copies others byte-for-byte", async () => {
    const leaf = layer("leaf", {
      "greeting.txt.tmpl": "Hello {{ name }}",
      "raw.txt": "literal {{ name }}",
    });
    const dest = await build(leaf, { name: "World" });
    expect(read(dest, "greeting.txt")).toBe("Hello World");
    expect(read(dest, "raw.txt")).toBe("literal {{ name }}");
    expect(existsSync(join(dest, "greeting.txt.tmpl"))).toBe(false);
  });

  it("renders templated path segments", async () => {
    const leaf = layer("leaf", { "{{ svc }}/index.ts.tmpl": "export const x = 1" });
    const dest = await build(leaf, { svc: "api" });
    expect(read(dest, "api/index.ts")).toBe("export const x = 1");
  });

  it("drops a file whose rendered name is empty (conditional file)", async () => {
    const leaf = layer("leaf", { "{{ fname }}.tmpl": "secret" });
    const dest = await build(leaf, { fname: "" });
    // Nothing materialized except the .treelay state dir.
    expect(existsSync(join(dest, ".tmpl"))).toBe(false);
    const state = readState(dest);
    expect(Object.keys(state.manifest)).toEqual([]);
  });
});

describe("compile — sidecar & suffix ops", () => {
  it("appends via .append suffix sugar", async () => {
    layer("base", { ".gitignore": "node_modules\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      ".gitignore.append": "dist\n",
    });
    const dest = await build(leaf);
    expect(read(dest, ".gitignore")).toBe("node_modules\ndist\n");
  });

  it("tombstones an inherited file via .delete", async () => {
    layer("base", { "README.md": "# base" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "README.md.delete": "",
    });
    const dest = await build(leaf);
    expect(existsSync(join(dest, "README.md"))).toBe(false);
  });

  it("applies a structured merge sidecar (RFC 7386)", async () => {
    layer("base", { "config.json": JSON.stringify({ name: "svc", debug: true }) });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "config.json.treelay": "op: merge\nmerge:\n  port: 3000\n  debug: null\n",
    });
    const dest = await build(leaf);
    // `port` added, `debug: null` removes the key, `name` preserved.
    expect(JSON.parse(read(dest, "config.json"))).toEqual({ name: "svc", port: 3000 });
  });

  it("skips an op whose `when` renders falsy", async () => {
    layer("base", { ".env": "A=1\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      ".env.treelay": "op: append\nwhen: \"{{ useDocker }}\"\nrender: true\ncontent: \"B=2\\n\"\n",
    });
    const off = await build(leaf, { useDocker: false });
    expect(read(off, ".env")).toBe("A=1\n");
  });
});

describe("compile — state", () => {
  it("writes lock, answers, baseline, and manifest", async () => {
    layer("base", { "a.txt": "x" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "b.txt": "y",
    });
    const dest = await build(leaf, { name: "World" });
    const state = readState(dest);
    expect(state.lock.lineage.length).toBe(2); // base + leaf
    expect(state.answers).toEqual({ name: "World" });
    expect(Object.keys(state.baseline).sort()).toEqual(["a.txt", "b.txt"]);
    expect(state.baseline["a.txt"]).toMatch(/^sha256:/);
    expect(state.manifest["b.txt"]).toMatchObject({ owned: false });
  });

  it("keeps secret variables out of everything written to disk", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        variables: {
          svc: { type: "string" },
          token: { type: "string", secret: true },
        },
      }),
      "a.txt": "x",
    });

    const dest = await build(leaf, { svc: "billing", token: "hunter2" });

    expect(readState(dest).answers).toEqual({ svc: "billing" });
    // Asserted over the whole state directory rather than answers.json alone:
    // a secret leaking into the baseline or manifest would be just as bad, and
    // this keeps the guarantee true if the state layout changes.
    for (const file of walk(join(dest, ".treelay"))) {
      expect(readFileSync(file, "utf8")).not.toContain("hunter2");
    }
  });

  it("does not materialize manifest files into the output", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf" }),
      "real.txt": "content",
    });
    const dest = await build(leaf);
    expect(existsSync(join(dest, "treelay.json"))).toBe(false);
    expect(read(dest, "real.txt")).toBe("content");
  });
});
