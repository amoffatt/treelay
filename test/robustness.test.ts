/**
 * Consumer-driven robustness — shapes the autom-lake / soredi-azure restructure
 * puts treelay through that the unit tests do not:
 *
 *  a. layers vendored as **git submodule checkouts** (a `.git` *file*, not dir)
 *  b. compiling into a `build/` directory **nested inside** the source tree
 *  c. **large** trees (thousands of files across a multi-layer chain)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import { explain } from "../src/explain.js";
import { SelfCompileError, listLayerFiles } from "../src/layer-files.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-robust-"));
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

describe("robustness — .git is never composed (§4 built-in tombstone)", () => {
  it("excludes a submodule gitlink FILE at a layer root", async () => {
    // A `git submodule` checkout carries a `.git` *file* holding `gitdir: …`,
    // not a directory. Publishing it produces a tree git reads as a broken
    // submodule, so it must never reach the output.
    const leaf = layer("leaf", {
      ".git": "gitdir: ../../.git/modules/npm-packages\n",
      "real.txt": "content",
    });

    const dest = join(root, "out");
    const result = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(result.files)).toEqual(["real.txt"]);
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("excludes a submodule gitlink FILE nested inside a vendored directory", async () => {
    // The autom-lake shape: an npm-packages submodule vendored into the tree.
    const leaf = layer("leaf", {
      "vendor/npm-packages/.git": "gitdir: ../../.git/modules/npm-packages\n",
      "vendor/npm-packages/package.json": JSON.stringify({ name: "vendored" }),
    });

    const dest = join(root, "out");
    const result = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(result.files)).toEqual(["vendor/npm-packages/package.json"]);
    expect(existsSync(join(dest, "vendor/npm-packages/.git"))).toBe(false);
  });

  it("excludes the contents of a real .git DIRECTORY", async () => {
    const leaf = layer("leaf", {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/config": "[core]\n",
      "real.txt": "content",
    });

    const dest = join(root, "out");
    const result = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(result.files)).toEqual(["real.txt"]);
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("still composes .gitignore and .gitmodules — only `.git` itself is excluded", async () => {
    const leaf = layer("leaf", {
      ".git": "gitdir: elsewhere\n",
      ".gitignore": "dist\n",
      ".gitmodules": '[submodule "x"]\n',
    });

    const dest = join(root, "out");
    const result = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(result.files).sort()).toEqual([".gitignore", ".gitmodules"]);
  });

  it("excludes .git from an inherited parent layer too", async () => {
    layer("base", { ".git": "gitdir: ../.git/modules/base\n", "b.txt": "b" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "l.txt": "l",
    });

    const result = await compile(resolve(leaf), { destDir: join(root, "out") });
    expect(Object.keys(result.files).sort()).toEqual(["b.txt", "l.txt"]);
  });

  it("hides .git from explain as well as compile", async () => {
    const leaf = layer("leaf", { ".git": "gitdir: x\n", "real.txt": "c" });
    const result = await explain(resolve(leaf));
    expect(Object.keys(result.files)).toEqual(["real.txt"]);
  });
});

describe("robustness — destination nested inside the source tree (§7)", () => {
  it("does not re-consume its own output when dest is a descendant of the leaf", async () => {
    // autom-lake compiles into a gitignored build/ *inside* the source repo.
    // The first compile is safe by construction (enumeration precedes writing);
    // the second is where self-inclusion would bite.
    const leaf = layer("leaf", { "a.txt": "a", "nested/b.txt": "b" });
    const dest = join(leaf, "build");

    await compile(resolve(leaf), { destDir: dest });
    const second = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(second.files).sort()).toEqual(["a.txt", "nested/b.txt"]);
    expect(existsSync(join(dest, "build"))).toBe(false);
  });

  it("stays stable across repeated recompiles", async () => {
    const leaf = layer("leaf", { "a.txt": "a" });
    const dest = join(leaf, "build");

    await compile(resolve(leaf), { destDir: dest });
    await compile(resolve(leaf), { destDir: dest });
    const third = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(third.files)).toEqual(["a.txt"]);
  });

  it("prunes a dest nested inside an inherited parent layer", async () => {
    const base = layer("base", { "b.txt": "b" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "l.txt": "l",
    });
    const dest = join(base, "out");

    await compile(resolve(leaf), { destDir: dest });
    const second = await compile(resolve(leaf), { destDir: dest });

    expect(Object.keys(second.files).sort()).toEqual(["b.txt", "l.txt"]);
  });

  it("fails loudly when the destination IS a layer root", async () => {
    const leaf = layer("leaf", { "a.txt": "a" });
    await expect(compile(resolve(leaf), { destDir: leaf })).rejects.toThrow(
      SelfCompileError,
    );
    await expect(compile(resolve(leaf), { destDir: leaf })).rejects.toThrow(
      /Compiling a layer into itself/,
    );
  });

  it("leaves enumeration untouched when the dest is outside the layer", () => {
    const leaf = layer("leaf", { "a.txt": "a" });
    const outside = join(root, "elsewhere");
    const graph = resolve(leaf);
    expect(listLayerFiles(graph.layers[0]!, outside)).toEqual(["a.txt"]);
  });
});

describe("robustness — large trees", () => {
  it(
    "compiles a ~2.4k-file, three-layer chain correctly and in sane time",
    async () => {
      const PER_LAYER = 800;
      const names = ["big-base", "big-mid", "big-leaf"];

      // Each layer owns 800 unique files; every 10th path is shared with the
      // layer below so the merge path (not just the copy path) is exercised.
      for (const [i, name] of names.entries()) {
        const files: Record<string, string> = {};
        for (let n = 0; n < PER_LAYER; n++) {
          files[`pkg${n % 20}/mod${n}.ts`] = `export const v${n} = "${name}";\n`;
          if (n % 10 === 0 && i > 0) {
            files[`shared/overlap${n}.txt`] = `${name}\n`;
          }
        }
        if (i > 0) {
          files["treelay.json"] = JSON.stringify({
            name,
            parents: [`../${names[i - 1]}`],
          });
        }
        layer(name, files);
      }

      const started = performance.now();
      const result = await compile(resolve(join(root, "big-leaf")), {
        destDir: join(root, "big-out"),
      });
      const elapsed = performance.now() - started;

      // 800 unique module paths (identical across layers, so they overwrite)
      // plus 80 shared overlap files contributed by the two upper layers.
      expect(Object.keys(result.files).length).toBe(PER_LAYER + 80);

      // The highest layer wins every contested path.
      expect(result.files["pkg0/mod0.ts"]?.fromLayer).toBe(join(root, "big-leaf"));
      expect(result.files["shared/overlap0.txt"]?.fromLayer).toBe(join(root, "big-leaf"));

      // Generous ceiling — this is a smoke test for pathological slowness
      // (accidental O(n²) rescans), not a benchmark.
      expect(elapsed).toBeLessThan(30_000);
    },
    60_000,
  );
});
