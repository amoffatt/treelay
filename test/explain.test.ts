import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import {
  explain,
  explainDest,
  explainFile,
  formatExplanation,
  summarizeLayers,
} from "../src/explain.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-explain-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write `files` (relative path → contents) under `<root>/<layer>`. */
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

describe("explain — layer summary", () => {
  it("labels parents, mixins, and self with precedence positions", () => {
    layer("base", { "a.txt": "a" });
    layer("mix", { "b.txt": "b" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        parents: ["../base"],
        mixins: ["../mix"],
      }),
    });

    const summaries = summarizeLayers(resolve(leaf));
    expect(summaries.map((l) => [l.name, l.role, l.position])).toEqual([
      ["base", "parent", 1],
      ["mix", "mixin", 2],
      ["leaf", "self", 3],
    ]);
  });
});

describe("explain — per-file provenance", () => {
  it("orders contributions lowest → highest and names the winner", async () => {
    layer("base", { "a.txt": "base" });
    layer("mid", {
      "treelay.json": JSON.stringify({ name: "mid", parents: ["../base"] }),
      "a.txt": "mid",
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../mid"] }),
      "a.txt": "leaf",
    });

    const file = await explainFile(resolve(leaf), "a.txt");
    expect(file?.contributions.map((c) => [c.name, c.action])).toEqual([
      ["base", "create"],
      ["mid", "replace"],
      ["leaf", "replace"],
    ]);
    expect(file?.present).toBe(true);
    expect(file?.winner).toBe(join(root, "leaf"));
    expect(file?.strategy).toBe("replace");
  });

  it("records deep-merge and folds the shadowed layer into patchedFrom", async () => {
    layer("base", { "pkg.json": JSON.stringify({ name: "base" }) });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "pkg.json": JSON.stringify({ version: "1" }),
    });

    const file = await explainFile(resolve(leaf), "pkg.json");
    expect(file?.contributions.map((c) => c.action)).toEqual(["create", "deep-merge"]);
    expect(file?.strategy).toBe("deep-merge");
    expect(file?.patchedFrom).toEqual([join(root, "base")]);
  });

  it("keeps a tombstoned file in the report, marked not present", async () => {
    layer("base", { "README.md": "# base" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "README.md.delete": "",
    });

    const file = await explainFile(resolve(leaf), "README.md");
    expect(file?.present).toBe(false);
    expect(file?.contributions.map((c) => [c.name, c.action])).toEqual([
      ["base", "create"],
      ["leaf", "delete"],
    ]);
  });

  it("marks a sidecar op skipped when its `when:` guard is falsy", async () => {
    layer("base", { ".env": "A=1\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      ".env.treelay":
        'op: append\nwhen: "{{ useDocker }}"\nrender: true\ncontent: "B=2\\n"\n',
    });

    const off = await explainFile(resolve(leaf), ".env", { values: { useDocker: false } });
    const skipped = off?.contributions.find((c) => c.kind === "sidecar");
    expect(skipped?.skipped).toBe(true);
    expect(off?.patchedFrom).toEqual([]);

    const on = await explainFile(resolve(leaf), ".env", { values: { useDocker: true } });
    expect(on?.contributions.find((c) => c.kind === "sidecar")?.skipped).toBeUndefined();
    expect(on?.patchedFrom).toEqual(["sidecar"]);
  });

  it("surfaces a sidecar's recorded base hash (enables 3-way, §5)", async () => {
    layer("base", { "config.json": JSON.stringify({ a: 1 }) });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "config.json.treelay": "op: merge\nbase: sha256:abc123def456789\nmerge:\n  b: 2\n",
    });

    const file = await explainFile(resolve(leaf), "config.json");
    expect(file?.contributions.at(-1)?.base).toBe("sha256:abc123def456789");
  });

  it("describes an unapplied unified-diff patch instead of throwing", async () => {
    // compile() still raises NotImplementedError here (§5, build step 5);
    // explain must stay usable precisely when the build is broken.
    layer("base", { "a.txt": "base\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "a.txt.patch": "@@ -1 +1 @@\n-base\n+leaf\n",
    });

    const file = await explainFile(resolve(leaf), "a.txt");
    const patch = file?.contributions.at(-1);
    expect(patch?.action).toBe("patch");
    expect(patch?.note).toMatch(/described, not applied/);
    expect(patch?.note).toMatch(/no recorded base/);
  });

  it("resolves templated paths with supplied values, and tolerates missing ones", async () => {
    const leaf = layer("leaf", { "{{ svc }}/index.ts.tmpl": "export {}" });

    const withValues = await explain(resolve(leaf), { values: { svc: "api" } });
    expect(Object.keys(withValues.files)).toEqual(["api/index.ts"]);

    const without = await explain(resolve(leaf));
    const [path] = Object.keys(without.files);
    expect(path).toBe("{{ svc }}/index.ts");
    expect(without.files[path!]?.contributions[0]?.note).toMatch(/unrendered/);
  });
});

describe("explain — agreement with compile", () => {
  it("reports the same winner/strategy/patchedFrom that compile records", async () => {
    // One composition exercising create, replace, deep-merge, append and a
    // structured sidecar merge. This is the anti-drift guard: explain mirrors
    // compile's bookkeeping, so any change to one must be mirrored in the other.
    layer("base", {
      "a.txt": "base",
      "pkg.json": JSON.stringify({ name: "base" }),
      ".gitignore": "node_modules\n",
      "keep.txt": "kept",
      "config.json": JSON.stringify({ debug: true }),
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "a.txt": "leaf",
      "pkg.json": JSON.stringify({ version: "1" }),
      ".gitignore.append": "dist\n",
      "config.json.treelay": "op: merge\nmerge:\n  port: 3000\n",
    });

    const graph = resolve(leaf);
    const compiled = await compile(graph, { destDir: join(root, "out") });
    const explained = await explain(graph);

    expect(Object.keys(explained.files).filter((p) => explained.files[p]!.present).sort())
      .toEqual(Object.keys(compiled.files).sort());

    for (const [path, prov] of Object.entries(compiled.files)) {
      const file = explained.files[path];
      expect(file, `explain is missing ${path}`).toBeDefined();
      expect(file!.winner, `winner for ${path}`).toBe(prov.fromLayer);
      expect(file!.strategy, `strategy for ${path}`).toBe(prov.strategy);
      expect(file!.patchedFrom, `patchedFrom for ${path}`).toEqual(prov.patchedFrom ?? []);
    }
  });
});

describe("explain — compiled destination", () => {
  it("reconstructs its graph and answers from .treelay state", async () => {
    layer("base", { "a.txt": "base" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "greeting.txt.tmpl": "Hello {{ name }}",
    });
    const dest = join(root, "out");
    await compile(resolve(leaf), { destDir: dest, values: { name: "World" } });

    const result = await explainDest(dest);
    // The templated path resolved, proving saved answers were reused.
    expect(Object.keys(result.files).sort()).toEqual(["a.txt", "greeting.txt"]);
    expect(result.files["a.txt"]?.owned).toBe(false);
    expect(result.layers.map((l) => l.role)).toEqual(["parent", "self"]);
  });

  it("refuses a directory with no treelay state", async () => {
    const plain = layer("plain", { "a.txt": "a" });
    await expect(explainDest(plain)).rejects.toThrow(/not a compiled destination/);
  });
});

describe("explain — formatting", () => {
  it("renders layers, winner, and contributions as text", async () => {
    layer("base", { "a.txt": "base" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "a.txt": "leaf",
    });

    const text = formatExplanation(await explain(resolve(leaf)), "a.txt");
    expect(text).toContain("Layers (lowest → highest precedence):");
    expect(text).toContain("1. base  (parent)");
    expect(text).toContain("2. leaf  (self)");
    expect(text).toMatch(/a\.txt\s+← leaf \(replace\)/);
  });

  it("says so plainly when nothing contributes to the requested path", async () => {
    const leaf = layer("leaf", { "a.txt": "x" });
    const text = formatExplanation(await explain(resolve(leaf)), "nope.txt");
    expect(text).toContain('No layer contributes to "nope.txt"');
  });
});
