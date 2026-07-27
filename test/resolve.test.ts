/**
 * Layer-stack ordering — SPEC §3.
 *
 * C3 over `parents` has its own unit tests in `c3.test.ts`; this suite covers
 * the assembly *around* it: where mixins land relative to parents, and where a
 * mixin's own ancestry lands relative to both.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolve } from "../src/resolve.js";
import { CycleError } from "../src/errors.js";
import { writeTree, manifest } from "./helpers/tree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-resolve-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Declare a layer directory; `body` is its manifest. */
function layer(name: string, body: Record<string, unknown> = {}): string {
  return writeTree(join(root, name), {
    "treelay.json": manifest({ name, ...body }),
    [`${name}.txt`]: `${name}\n`,
  });
}

/** The composed stack, lowest → highest precedence, by layer name. */
function stack(leafDir: string): string[] {
  return resolve(leafDir).layers.map((l) => l.manifest.name ?? l.id);
}

describe("resolve — mixin ancestry", () => {
  it("flattens a mixin's own parents into the stack", () => {
    layer("base");
    layer("mixbase");
    layer("mix", { parents: ["../mixbase"] });
    const leaf = layer("leaf", { parents: ["../base"], mixins: ["../mix"] });

    // `mixbase` sits directly beneath its mixin, and the whole mixin group
    // stays above every one of the leaf's own parents (§3).
    expect(stack(leaf)).toEqual(["base", "mixbase", "mix", "leaf"]);
  });

  it("linearizes a mixin's ancestry rather than appending it flat", () => {
    layer("grand");
    layer("mid", { parents: ["../grand"] });
    layer("mix", { parents: ["../mid"] });
    const leaf = layer("leaf", { mixins: ["../mix"] });

    expect(stack(leaf)).toEqual(["grand", "mid", "mix", "leaf"]);
  });

  it("keeps each mixin's ancestry grouped beneath it, in declaration order", () => {
    layer("b1");
    layer("b2");
    layer("m1", { parents: ["../b1"] });
    layer("m2", { parents: ["../b2"] });
    const leaf = layer("leaf", { mixins: ["../m1", "../m2"] });

    // Later mixins win over earlier ones, so m2's group sits above m1's.
    expect(stack(leaf)).toEqual(["b1", "m1", "b2", "m2", "leaf"]);
  });

  it("applies a layer once when a mixin and the leaf share an ancestor", () => {
    layer("shared");
    layer("mix", { parents: ["../shared"] });
    const leaf = layer("leaf", { parents: ["../shared"], mixins: ["../mix"] });

    // The diamond rule from §3: one appearance, at its lowest position. If
    // `shared` were re-inserted above the leaf's parents it would start
    // overriding layers it is supposed to sit beneath.
    expect(stack(leaf)).toEqual(["shared", "mix", "leaf"]);
  });

  it("applies a shared ancestor once across two mixins", () => {
    layer("shared");
    layer("m1", { parents: ["../shared"] });
    layer("m2", { parents: ["../shared"] });
    const leaf = layer("leaf", { mixins: ["../m1", "../m2"] });

    expect(stack(leaf)).toEqual(["shared", "m1", "m2", "leaf"]);
  });

  it("fails loud on a cycle reached through a mixin's parents", () => {
    layer("a", { parents: ["../b"] });
    layer("b", { parents: ["../a"] });
    const leaf = layer("leaf", { mixins: ["../a"] });

    expect(() => resolve(leaf)).toThrow(CycleError);
  });

  it("leaves a mixin with no parents exactly where it was", () => {
    layer("base");
    layer("mix");
    const leaf = layer("leaf", { parents: ["../base"], mixins: ["../mix"] });

    expect(stack(leaf)).toEqual(["base", "mix", "leaf"]);
  });
});

describe("resolve — parents and mixins together", () => {
  it("orders mounts < parents < mixins < self", () => {
    layer("p1");
    layer("p2");
    layer("mix");
    const leaf = layer("leaf", {
      parents: ["../p1", "../p2"],
      mixins: ["../mix"],
    });

    // Parents follow Python's C3: the *first*-declared base is the most
    // derived, so `p1` outranks `p2` and therefore sits later in a
    // lowest → highest list. Mixins run the other way (last = highest).
    expect(stack(leaf)).toEqual(["p2", "p1", "mix", "leaf"]);
  });

  it("puts a mixin above every parent even when declared first", () => {
    layer("deep");
    layer("p", { parents: ["../deep"] });
    layer("mix");
    const leaf = layer("leaf", { mixins: ["../mix"], parents: ["../p"] });

    expect(stack(leaf)).toEqual(["deep", "p", "mix", "leaf"]);
  });
});
