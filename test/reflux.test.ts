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
import { parse as parseYaml } from "yaml";

import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import { status, promote, extract, formatStatus } from "../src/reflux.js";
import { readState } from "../src/state.js";
import { hashContent } from "../src/hash.js";
import type { Change } from "../src/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-reflux-"));
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

/** Compile `leafDir` into `<root>/out` and return the destination path. */
async function build(leafDir: string, values: Record<string, unknown> = {}) {
  const dest = join(root, "out");
  await compile(resolve(leafDir), { destDir: dest, values });
  return dest;
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const write = (dir: string, rel: string, content: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

/** Pull one change out of `status` by path, failing loudly when absent. */
function changeFor(changes: Change[], path: string): Change {
  const hit = changes.find((c) => c.path === path);
  if (!hit) throw new Error(`no change for ${path} in ${changes.map((c) => c.path).join(", ")}`);
  return hit;
}

describe("reflux — status", () => {
  it("classifies modified, added and deleted against the baseline", async () => {
    layer("base", { "a.txt": "base-a\n", "gone.txt": "bye\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "b.txt": "leaf-b\n",
    });
    const dest = await build(leaf);

    write(dest, "a.txt", "edited\n");
    write(dest, "src/mine.ts", "export const mine = 1;\n");
    rmSync(join(dest, "gone.txt"));

    const changes = await status(dest);
    expect(changes.map((c) => [c.path, c.kind])).toEqual([
      ["a.txt", "modified"],
      ["gone.txt", "deleted"],
      ["src/mine.ts", "added"],
    ]);
  });

  it("annotates each change with the layer that produces it", async () => {
    layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    const [change] = await status(dest);
    expect(change?.producingLayer).toBe(join(root, "base"));
    expect(change?.owned).toBeUndefined();
  });

  it("marks a user-added file as owned with no producing layer", async () => {
    const leaf = layer("leaf", { "a.txt": "a\n" });
    const dest = await build(leaf);
    write(dest, "mine.txt", "local\n");

    const change = changeFor(await status(dest), "mine.txt");
    expect(change.owned).toBe(true);
    expect(change.producingLayer).toBeUndefined();
  });

  it("records the patch chain when a higher layer merges on top", async () => {
    layer("base", { "pkg.json": JSON.stringify({ name: "base" }) });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "pkg.json": JSON.stringify({ version: "1" }),
    });
    const dest = await build(leaf);
    write(dest, "pkg.json", JSON.stringify({ name: "base", version: "2" }));

    const change = changeFor(await status(dest), "pkg.json");
    expect(change.patchedBy).toEqual([join(root, "base")]);
  });

  it("excludes shadowed layers from the suggested targets", async () => {
    layer("base", { "a.txt": "base\n" });
    layer("mix", { "a.txt": "mixin\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        parents: ["../base"],
        mixins: ["../mix"],
      }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    // `base` is shadowed by `mix`, which replaces the same file above it.
    const change = changeFor(await status(dest), "a.txt");
    expect(change.targets).not.toContain(join(root, "base"));
    expect(change.targets).toContain(join(root, "mix"));
  });

  it("formats status as git-status-plus-blame", async () => {
    layer("base", { "a.txt": "base\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    const text = formatStatus(await status(dest), resolve(leaf));
    expect(text).toMatch(/M\s+a\.txt\s+← produced by base/);
  });
});

describe("reflux — promote", () => {
  it("rewrites the file in the ancestor that produces it, round-trip green", async () => {
    const base = layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");

    const result = await promote(dest, await status(dest), { to: "base" });

    expect(result.landed).toEqual([{ path: "a.txt", mode: "rewrite", wrote: "a.txt" }]);
    expect(result.verified).toBe(true);
    expect(read(base, "a.txt")).toBe("promoted\n");
    // The change now flows down by inheritance, so it is no longer local.
    expect(await status(dest)).toEqual([]);
  });

  it("auto-suggests the producing layer when no target is given", async () => {
    const base = layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");

    const result = await promote(dest, await status(dest));
    expect(result.target).toBe(base);
  });

  it("emits a patch sidecar recording both base and baseContent (§5)", async () => {
    // Promoting into a layer *above* the producer records only the delta.
    layer("base", { "a.txt": "one\ntwo\nthree\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "one\nTWO\nthree\n");

    const result = await promote(dest, await status(dest), { to: "leaf" });
    expect(result.landed[0]?.mode).toBe("patch");

    const sidecar = parseYaml(read(leaf, "a.txt.treelay")) as Record<string, unknown>;
    expect(sidecar.op).toBe("patch");
    expect(sidecar.base).toBe(hashContent("one\ntwo\nthree\n"));
    expect(sidecar.baseContent).toBe("one\ntwo\nthree\n");
    expect(String(sidecar.patch)).toContain("-two");
    expect(String(sidecar.patch)).toContain("+TWO");

    // And it round-trips: the recorded base is what the patch applies to.
    expect(result.verified).toBe(true);
    expect(await status(dest)).toEqual([]);
  });

  it("emits a structured merge sidecar for JSON rather than a line diff", async () => {
    layer("base", { "config.json": JSON.stringify({ name: "svc", port: 3000 }, null, 2) + "\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "config.json", JSON.stringify({ name: "svc", port: 8080 }, null, 2) + "\n");

    await promote(dest, await status(dest), { to: "leaf" });

    const sidecar = parseYaml(read(leaf, "config.json.treelay")) as Record<string, unknown>;
    expect(sidecar.op).toBe("merge");
    expect(sidecar.merge).toEqual({ port: 8080 });
    expect(sidecar.base).toMatch(/^sha256:/);
  });

  it("creates a new file in the target for a locally-added path", async () => {
    const base = layer("base", { "a.txt": "a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "src/new.ts", "export const n = 1;\n");

    const result = await promote(dest, await status(dest), { to: "base" });
    expect(result.landed[0]?.mode).toBe("create");
    expect(read(base, "src/new.ts")).toBe("export const n = 1;\n");
  });

  it("removes the source file when promoting a deletion into its sole producer", async () => {
    const base = layer("base", { "a.txt": "a\n", "keep.txt": "k\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    rmSync(join(dest, "a.txt"));

    const result = await promote(dest, await status(dest), { to: "base" });
    expect(result.landed[0]?.mode).toBe("tombstone");
    expect(existsSync(join(base, "a.txt"))).toBe(false);
    expect(read(base, "keep.txt")).toBe("k\n");
  });

  it("rewrites the baseline so a promoted change stops showing as local", async () => {
    layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");
    await promote(dest, await status(dest), { to: "base" });

    expect(readState(dest).baseline["a.txt"]).toBe(hashContent("promoted\n"));
  });
});

describe("reflux — guard 1: precedence shadowing", () => {
  it("refuses a target that a higher layer wholesale-overrides", async () => {
    const base = layer("base", { "a.txt": "base\n" });
    layer("mix", { "a.txt": "mixin\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        parents: ["../base"],
        mixins: ["../mix"],
      }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    await expect(promote(dest, await status(dest), { to: "base" })).rejects.toThrow(
      /Promoting a\.txt to base has no effect; mix overrides this file/,
    );
    // Refused before writing: the target layer is untouched.
    expect(read(base, "a.txt")).toBe("base\n");
  });

  it("names the layer to promote to instead", async () => {
    layer("base", { "a.txt": "base\n" });
    layer("mix", { "a.txt": "mixin\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        parents: ["../base"],
        mixins: ["../mix"],
      }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    await expect(promote(dest, await status(dest), { to: "base" })).rejects.toThrow(
      /Promote to mix or to the leaf instead/,
    );
  });

  it("allows the shadowing layer itself as a target", async () => {
    layer("base", { "a.txt": "base\n" });
    const mix = layer("mix", { "a.txt": "mixin\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        parents: ["../base"],
        mixins: ["../mix"],
      }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    const result = await promote(dest, await status(dest), { to: "mix" });
    expect(result.verified).toBe(true);
    expect(read(mix, "a.txt")).toBe("edited\n");
  });
});

describe("reflux — guard 2: round-trip verification", () => {
  it("rolls back when a higher layer transforms the promoted content", async () => {
    // `.append` is not a wholesale override, so guard 1 lets this through —
    // guard 2 is what catches that the graph cannot reproduce the working copy.
    const base = layer("base", { ".gitignore": "node_modules\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      ".gitignore.append": "dist\n",
    });
    const dest = await build(leaf);
    write(dest, ".gitignore", "REPLACED\n");

    await expect(promote(dest, await status(dest), { to: "base" })).rejects.toThrow(
      /Round-trip verification failed/,
    );
    // Rolled back: the layer is exactly as it was.
    expect(read(base, ".gitignore")).toBe("node_modules\n");
    expect(existsSync(join(base, ".gitignore.treelay"))).toBe(false);
  });

  it("reports which path failed to reproduce", async () => {
    layer("base", { ".gitignore": "node_modules\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      ".gitignore.append": "dist\n",
    });
    const dest = await build(leaf);
    write(dest, ".gitignore", "REPLACED\n");

    await expect(promote(dest, await status(dest), { to: "base" })).rejects.toThrow(
      /\.gitignore — content-differs/,
    );
  });

  it("leaves the baseline untouched when a promotion is rolled back", async () => {
    layer("base", { ".gitignore": "node_modules\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      ".gitignore.append": "dist\n",
    });
    const dest = await build(leaf);
    const before = readState(dest).baseline[".gitignore"];
    write(dest, ".gitignore", "REPLACED\n");

    await expect(promote(dest, await status(dest), { to: "base" })).rejects.toThrow();
    expect(readState(dest).baseline[".gitignore"]).toBe(before);
  });
});

describe("reflux — guard 3: blast radius", () => {
  it("reports sibling layers that inherit the target", async () => {
    layer("base", { "a.txt": "base\n" });
    // A sibling leaf inheriting the same base — the population a promote reaches.
    layer("sibling", {
      "treelay.json": JSON.stringify({ name: "sibling", parents: ["../base"] }),
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");

    const result = await promote(dest, await status(dest), { to: "base" });
    expect(result.blastRadius.dependents).toContain(join(root, "sibling"));
    expect(result.blastRadiusWarning).toMatch(/base is consumed beyond this project/);
    expect(result.blastRadiusWarning).toMatch(/1 other layer inherits it/);
  });

  it("reports other compiled destinations fed by the target", async () => {
    layer("base", { "a.txt": "base\n" });
    const other = layer("other", {
      "treelay.json": JSON.stringify({ name: "other", parents: ["../base"] }),
    });
    await compile(resolve(other), { destDir: join(root, "other-out") });

    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");

    const result = await promote(dest, await status(dest), { to: "base" });
    expect(result.blastRadius.destinations).toContain(join(root, "other-out"));
    expect(result.blastRadiusWarning).toMatch(/1 compiled destination includes it/);
  });

  it("says so plainly when nothing else consumes the target", async () => {
    layer("base", { "a.txt": "base\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "promoted\n");

    const result = await promote(dest, await status(dest), { to: "base" });
    expect(result.blastRadius.dependents).toEqual([]);
    expect(result.blastRadiusWarning).toMatch(/no other known consumers/);
  });
});

describe("reflux — extract", () => {
  it("creates a valid new layer, wires it as a mixin, and round-trips", async () => {
    layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "extracted\n");
    write(dest, "extra.txt", "new file\n");

    const result = await extract(dest, await status(dest), {
      as: "../house-style",
      asMixin: true,
    });

    const newLayer = join(root, "house-style");
    expect(result.layer).toBe(newLayer);
    expect(result.wired).toBe(true);
    expect(result.verified).toBe(true);

    // A valid layer: manifest plus the captured content.
    expect(JSON.parse(read(newLayer, "treelay.json"))).toEqual({ name: "house-style" });
    expect(read(newLayer, "a.txt")).toBe("extracted\n");
    expect(read(newLayer, "extra.txt")).toBe("new file\n");

    // Wired into the leaf at highest precedence.
    expect(JSON.parse(read(leaf, "treelay.json")).mixins).toEqual(["../house-style"]);

    // And the edits now come from the template, not from local drift.
    expect(await status(dest)).toEqual([]);
  });

  it("composes into the graph so a fresh compile reproduces the edits", async () => {
    layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "extracted\n");
    await extract(dest, await status(dest), { as: "../house-style", asMixin: true });

    const fresh = join(root, "fresh");
    await compile(resolve(leaf), { destDir: fresh });
    expect(read(fresh, "a.txt")).toBe("extracted\n");
  });

  it("captures a deletion as a tombstone in the new layer", async () => {
    layer("base", { "a.txt": "a\n", "b.txt": "b\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    rmSync(join(dest, "a.txt"));

    await extract(dest, await status(dest), { as: "../trimmed", asMixin: true });
    const sidecar = parseYaml(read(join(root, "trimmed"), "a.txt.treelay")) as { op: string };
    expect(sidecar.op).toBe("delete");
  });

  it("skips verification for a free-standing layer and says it is not wired", async () => {
    layer("base", { "a.txt": "base-a\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "extracted\n");

    const result = await extract(dest, await status(dest), { as: "../free" });
    expect(result.wired).toBe(false);
    expect(result.verified).toBe(false);
    // Not in the graph, so the edit is still local — the baseline must not lie.
    expect(await status(dest)).toHaveLength(1);
  });

  it("refuses to overwrite an existing layer", async () => {
    layer("base", { "a.txt": "a\n" });
    layer("taken", { "treelay.json": JSON.stringify({ name: "taken" }) });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });
    const dest = await build(leaf);
    write(dest, "a.txt", "edited\n");

    await expect(
      extract(dest, await status(dest), { as: "../taken", asMixin: true }),
    ).rejects.toThrow(/A layer already exists/);
  });
});
