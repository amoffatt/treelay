/**
 * Local refs that are wrong should say so — reported from a multi-product tree
 * whose layers all live in `<name>/_layer/`.
 *
 * Two findings, one cause. A ref naming the *enclosing* directory instead of the
 * `_layer/` inside it resolved to a valid parent-less layer whose content was
 * the entire subtree: files that were never layer content shipped, and the real
 * layer's files landed one directory deep. Nothing reported it — the tree
 * compiled, `validate` passed, and the file count was plausible. It was hit
 * twice by accident in one afternoon, because the refs are five `../` long and
 * the depth changes when a layer moves.
 *
 * So: a declared ref to a directory with no manifest is an error, and refs can
 * be written from the repo root instead of counting `../`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import { validate } from "../src/validate.js";
import { explain, formatExplanation } from "../src/explain.js";
import { MissingManifestError } from "../src/errors.js";
import { parseRef } from "../src/refs.js";
import { findRepoRoot } from "../src/workspace.js";
import { writeTree, manifest } from "./helpers/tree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-refs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Their tree shape: content in `_layer/`, junk beside it. */
function probeTree(parentRef: string): string {
  writeTree(join(root, "base", "_layer"), {
    "treelay.json": manifest({ name: "base" }),
    "hello.txt": "from base layer\n",
  });
  writeFileSync(join(root, "base", "junk.txt"), "NOT layer content\n");
  return writeTree(join(root, "leaf", "_layer"), {
    "treelay.json": manifest({ name: "leaf", parents: [parentRef] }),
    "leaf.txt": "leaf\n",
  });
}

describe("a declared ref that lands one level above a layer is an error", () => {
  it("names the ref and suggests the layer it contains", () => {
    const leaf = probeTree("../../base"); // missing the /_layer suffix
    expect(() => resolve(leaf)).toThrow(MissingManifestError);
    try {
      resolve(leaf);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("../../base");
      expect(msg).toContain("did you mean");
      expect(msg).toContain("../../base/_layer");
    }
  });

  it("does not silently compose the enclosing directory", () => {
    const leaf = probeTree("../../base");
    // Resolution fails before compile is ever reached, so nothing is written.
    expect(() => compile(resolve(leaf), { destDir: join(root, "out") })).toThrow(
      MissingManifestError,
    );
    // The failure mode being guarded: junk.txt shipping and hello.txt landing
    // at _layer/hello.txt. Nothing should have been written at all.
    expect(existsSync(join(root, "out", "junk.txt"))).toBe(false);
    expect(existsSync(join(root, "out", "_layer", "hello.txt"))).toBe(false);
  });

  it("resolves cleanly once the ref names the real layer", () => {
    const leaf = probeTree("../../base/_layer");
    const graph = resolve(leaf);
    expect(graph.layers.map((l) => l.manifest.name)).toEqual(["base", "leaf"]);
  });

  it("still allows a bare directory the user named directly", async () => {
    // `compile <dir>` on a plain directory stays valid — the user pointed at it,
    // so there is no typo to catch.
    const bare = writeTree(join(root, "bare"), { "a.txt": "a\n" });
    const graph = resolve(bare);
    expect(graph.layers).toHaveLength(1);
    await compile(graph, { destDir: join(root, "out2") });
    expect(existsSync(join(root, "out2", "a.txt"))).toBe(true);
  });

  it("still allows a manifest-less parent holding only content", async () => {
    // The documented "a plain directory is a valid, parent-less layer" case.
    // It is not the typo signature, so it resolves — but it is marked.
    writeTree(join(root, "content"), { "shared.txt": "shared\n" });
    const leaf = writeTree(join(root, "leaf4"), {
      "treelay.json": manifest({ name: "leaf4", parents: ["../content"] }),
    });
    const graph = resolve(leaf);
    expect(graph.layers).toHaveLength(2);
    expect(graph.layers[0]!.manifestless).toBe(true);
    expect(graph.layers[1]!.manifestless).toBeUndefined();

    await compile(graph, { destDir: join(root, "out3") });
    expect(existsSync(join(root, "out3", "shared.txt"))).toBe(true);
  });

  it("validate warns about it, and --strict makes it fail", async () => {
    writeTree(join(root, "content2"), { "shared.txt": "shared\n" });
    const leaf = writeTree(join(root, "leaf5"), {
      "treelay.json": manifest({ name: "leaf5", parents: ["../content2"] }),
    });

    const report = await validate(leaf);
    expect(report.issues.map((i) => i.code)).toContain("manifestless-layer");
    expect(report.ok).toBe(true);

    expect((await validate(leaf, { strict: true })).ok).toBe(false);
  });

  it("accepts a layer declared only through package.json", () => {
    mkdirSync(join(root, "pkgbase"), { recursive: true });
    writeFileSync(
      join(root, "pkgbase", "package.json"),
      JSON.stringify({ name: "pkgbase", treelay: {} }),
    );
    writeFileSync(join(root, "pkgbase", "x.txt"), "x\n");
    const leaf = writeTree(join(root, "leaf2"), {
      "treelay.json": manifest({ name: "leaf2", parents: ["../pkgbase"] }),
    });
    expect(() => resolve(leaf)).not.toThrow();
  });

  it("catches the same mistake in a mixin, not just a parent", () => {
    writeTree(join(root, "mixbase", "_layer"), {
      "treelay.json": manifest({ name: "mixbase" }),
    });
    writeFileSync(join(root, "mixbase", "stray.txt"), "stray\n");
    const leaf = writeTree(join(root, "leaf3"), {
      "treelay.json": manifest({ name: "leaf3", mixins: ["../mixbase"] }),
    });
    expect(() => resolve(leaf)).toThrow(MissingManifestError);
  });
});

describe("root-relative local refs", () => {
  /** A repo root is what `//` resolves against. */
  function repo(): string {
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  }

  it("parses `//path` as a local ref distinguishable by shape", () => {
    const parsed = parseRef("//packages/core/_layer");
    expect(parsed.kind).toBe("local");
    expect(parsed).toMatchObject({ rootRelative: true, path: "packages/core/_layer" });
  });

  it("leaves ordinary relative and absolute paths alone", () => {
    expect(parseRef("../base")).not.toHaveProperty("rootRelative");
    expect(parseRef("/abs/base")).not.toHaveProperty("rootRelative");
    expect(parseRef("../base")).toMatchObject({ kind: "local", path: "../base" });
  });

  it("finds the repo root from a nested directory", () => {
    repo();
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
  });

  it("resolves the same target from two different depths", () => {
    repo();
    writeTree(join(root, "packages", "core", "_layer"), {
      "treelay.json": manifest({ name: "core" }),
      "shared.txt": "shared\n",
    });

    const shallow = writeTree(join(root, "t1", "_layer"), {
      "treelay.json": manifest({
        name: "t1",
        parents: ["//packages/core/_layer"],
      }),
    });
    const deep = writeTree(join(root, "tenants", "a", "b", "_layer"), {
      "treelay.json": manifest({
        name: "deep",
        parents: ["//packages/core/_layer"],
      }),
    });

    // The identical ref string works at both depths — the point of the feature.
    for (const leaf of [shallow, deep]) {
      const graph = resolve(leaf);
      expect(graph.layers.map((l) => l.manifest.name)).toContain("core");
    }
  });

  it("fails with a pointable error when the target does not exist", () => {
    repo();
    const leaf = writeTree(join(root, "t2", "_layer"), {
      "treelay.json": manifest({ name: "t2", parents: ["//nope/_layer"] }),
    });
    // The secondary benefit they named: a root-relative ref that overshoots
    // cannot land on some unrelated real directory.
    expect(() => resolve(leaf)).toThrow(/Layer not found/);
  });

  it("explains itself when there is no repo root to resolve against", () => {
    const leaf = writeTree(join(root, "t3", "_layer"), {
      "treelay.json": manifest({ name: "t3", parents: ["//products/x/_layer"] }),
    });
    expect(() => resolve(leaf)).toThrow(/repo root/i);
  });
});

describe("explain distinguishes not-composed from not-there", () => {
  it("says a destination file with no template origin is user-owned", async () => {
    const src = writeTree(join(root, "src1"), {
      "treelay.json": manifest({ name: "src1" }),
      "a.txt": "a\n",
    });
    const out = join(root, "dest1");
    await compile(resolve(src), { destDir: out });
    writeFileSync(join(out, "mine.txt"), "mine\n");

    const text = formatExplanation(
      await explain(resolve(src), { destDir: out }),
      "mine.txt",
    );
    expect(text).toContain("user-owned");
  });

  it("says a path that exists nowhere is not there at all", async () => {
    const src = writeTree(join(root, "src2"), {
      "treelay.json": manifest({ name: "src2" }),
      "a.txt": "a\n",
    });
    const out = join(root, "dest2");
    await compile(resolve(src), { destDir: out });

    const text = formatExplanation(
      await explain(resolve(src), { destDir: out }),
      "ghost.txt",
    );
    expect(text).toContain("not in the destination");
    expect(text).not.toContain("user-owned");
  });
});
