import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createPatch } from "diff";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { applyPatch3Way } from "../src/merge/patch.js";
import { MergeConflictError } from "../src/errors.js";
import { hashContent } from "../src/hash.js";
import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";

/** Build a unified diff turning `from` into `to`. */
const patchOf = (from: string, to: string) => createPatch("f", from, to, "", "");

const BASE = "one\ntwo\nthree\nfour\nfive\n";
const PATCHED = "one\ntwo\nINSERTED\nthree\nfour\nfive\n";

/** `n` numbered lines — long enough to exercise a patch's 3-line context window. */
const LINES = (n: number) =>
  Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";

describe("applyPatch3Way — without a recorded base (best-effort)", () => {
  it("applies cleanly when the content is unchanged", () => {
    const out = applyPatch3Way({ file: "f", current: BASE, patch: patchOf(BASE, PATCHED) });
    expect(out).toBe(PATCHED);
  });

  it("relocates a hunk that merely moved", () => {
    const drifted = "HEADER\nHEADER2\n" + BASE;
    const out = applyPatch3Way({
      file: "f",
      current: drifted,
      patch: patchOf(BASE, PATCHED),
    });
    expect(out).toBe("HEADER\nHEADER2\n" + PATCHED);
  });

  it("throws when the patch cannot be placed", () => {
    const unrelated = "totally\ndifferent\ncontent\n";
    expect(() =>
      applyPatch3Way({ file: "f", current: unrelated, patch: patchOf(BASE, PATCHED) }),
    ).toThrow(MergeConflictError);
  });

  it("accepts bare `@@` hunks with no ---/+++ headers (SPEC §4 sidecar form)", () => {
    const bare = "@@ -1,3 +1,4 @@\n one\n two\n+INSERTED\n three\n";
    const out = applyPatch3Way({ file: "f", current: BASE, patch: bare });
    expect(out).toBe(PATCHED);
  });

  it("rejects a payload that is not a unified diff", () => {
    expect(() =>
      applyPatch3Way({ file: "f", current: BASE, patch: "just some prose\n" }),
    ).toThrow(/no hunks/);
  });

  it("points at the hunk header when its line counts are miscounted", () => {
    // The header claims 5 lines; the body has 4. jsdiff calls this an "invalid
    // line", which sends people looking for a bad character instead.
    const miscounted =
      "@@ -1,5 +1,5 @@\n one\n two\n three\n-four\n+FOUR\n".replace("-1,5", "-1,9");
    expect(() =>
      applyPatch3Way({ file: "f", current: BASE, patch: miscounted }),
    ).toThrow(/counts must match/);
  });
});

describe("applyPatch3Way — with a recorded base (true three-way)", () => {
  it("returns the authored result when the content has not drifted", () => {
    const out = applyPatch3Way({
      file: "f",
      current: BASE,
      patch: patchOf(BASE, PATCHED),
      base: BASE,
    });
    expect(out).toBe(PATCHED);
  });

  it("merges when the inherited file drifted in a different region", () => {
    // The parent changed "five" → "FIVE"; the patch inserts near the top.
    const drifted = "one\ntwo\nthree\nfour\nFIVE\n";
    const out = applyPatch3Way({
      file: "f",
      current: drifted,
      patch: patchOf(BASE, PATCHED),
      base: BASE,
    });
    expect(out).toBe("one\ntwo\nINSERTED\nthree\nfour\nFIVE\n");
  });

  it("recovers drift inside the context window that a base-less apply rejects", () => {
    // The patch inserts after line8; its context window spans lines 5–11. The
    // parent then edited line5 — inside that window, so a flat apply can no
    // longer place the hunk, but the edits are separated by unchanged lines, so
    // the three-way reconcile reads them as independent.
    const long = LINES(12);
    const longPatched = long.replace("line8\n", "line8\nINSERTED\n");
    const drifted = long.replace("line5\n", "LINE5-CHANGED\n");
    const patch = patchOf(long, longPatched);

    expect(() => applyPatch3Way({ file: "f", current: drifted, patch })).toThrow(
      MergeConflictError,
    );

    const out = applyPatch3Way({ file: "f", current: drifted, patch, base: long });
    expect(out).toBe(drifted.replace("line8\n", "line8\nINSERTED\n"));
  });

  it("throws on a genuine overlapping conflict", () => {
    // Both the parent and the patch rewrote line 3.
    const drifted = "one\ntwo\nPARENT-EDIT\nfour\nfive\n";
    const patch = patchOf(BASE, "one\ntwo\nCHILD-EDIT\nfour\nfive\n");
    expect(() =>
      applyPatch3Way({ file: "f", current: drifted, patch, base: BASE }),
    ).toThrow(/three-way merge conflict/);
  });

  it("treats edits on immediately adjacent lines as a conflict (like git)", () => {
    // Parent changed line2; the patch inserts right after line2. With no
    // unchanged line between them, diff3 cannot order the two edits.
    const drifted = "one\nTWO-CHANGED\nthree\nfour\nfive\n";
    expect(() =>
      applyPatch3Way({
        file: "f",
        current: drifted,
        patch: patchOf(BASE, PATCHED),
        base: BASE,
      }),
    ).toThrow(/three-way merge conflict/);
  });

  it("flags an inconsistent sidecar when the patch does not fit its own base", () => {
    expect(() =>
      applyPatch3Way({
        file: "f",
        current: BASE,
        patch: patchOf(BASE, PATCHED),
        base: "unrelated\nbase\ncontent\n",
      }),
    ).toThrow(/its own recorded base/);
  });
});

describe("compile — patches through the layer stack (§4/§5)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "treelay-patch-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write `files` (relative path → contents) under `<root>/<name>`. */
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

  const dest = () => join(root, "out");

  async function build(leafDir: string, values: Record<string, unknown> = {}) {
    await compile(resolve(leafDir), { destDir: dest(), values });
    return dest();
  }

  const read = (d: string, rel: string) => readFileSync(join(d, rel), "utf8");

  it("applies a `.patch` suffix onto the inherited file", async () => {
    layer("base", { "app.txt": BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });
    expect(read(await build(leaf), "app.txt")).toBe(PATCHED);
    expect(existsSync(join(dest(), "app.txt.patch"))).toBe(false);
  });

  it("applies a sidecar patch and records `patch` as the strategy", async () => {
    layer("base", { "app.txt": BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.treelay": `op: patch\npatch: |\n${indent(patchOf(BASE, PATCHED))}`,
    });
    const result = await compile(resolve(leaf), { destDir: dest() });
    expect(read(dest(), "app.txt")).toBe(PATCHED);
    expect(result.files["app.txt"]?.strategy).toBe("patch");
  });

  it("relocates a hunk when the parent added lines above it (moved hunk)", async () => {
    // The parent ships a file with a preamble the patch was not authored against.
    layer("base", { "app.txt": "PREAMBLE\nADDED\n" + BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });
    expect(read(await build(leaf), "app.txt")).toBe("PREAMBLE\nADDED\n" + PATCHED);
  });

  it("takes the true three-way path when the recorded base hash no longer matches", async () => {
    // The parent drifted (line5 changed) since the patch was authored, so a flat
    // apply would be rejected. `baseContent` lets compile reconcile instead.
    const authored = LINES(12);
    const wanted = authored.replace("line8\n", "line8\nINSERTED\n");
    const drifted = authored.replace("line5\n", "LINE5-CHANGED\n");

    layer("base", { "app.txt": drifted });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.treelay":
        `op: patch\n` +
        `base: ${hashContent(authored)}\n` +
        `baseContent: |\n${indent(authored)}` +
        `patch: |\n${indent(patchOf(authored, wanted))}`,
    });

    expect(read(await build(leaf), "app.txt")).toBe(
      drifted.replace("line8\n", "line8\nINSERTED\n"),
    );
  });

  it("rejects a sidecar whose baseContent contradicts its recorded base hash", async () => {
    layer("base", { "app.txt": BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.treelay":
        `op: patch\n` +
        `base: ${hashContent("something else entirely\n")}\n` +
        `baseContent: |\n${indent(BASE)}` +
        `patch: |\n${indent(patchOf(BASE, PATCHED))}`,
    });
    await expect(build(leaf)).rejects.toThrow(/sidecar is inconsistent/);
  });

  it("fails the whole build on a genuine conflict, writing NO partial output", async () => {
    layer("base", { "app.txt": "totally\nunrelated\ncontent\n", "other.txt": "fine\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });

    await expect(build(leaf)).rejects.toThrow(MergeConflictError);
    // Nothing is materialized until every layer has merged, so a mid-compile
    // failure leaves the destination untouched — not even the clean files.
    expect(existsSync(dest())).toBe(false);
  });

  it("does not clobber an existing destination when a patch conflicts", async () => {
    layer("base", { "app.txt": "unrelated\ncontent\nhere\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });
    mkdirSync(dest(), { recursive: true });
    writeFileSync(join(dest(), "pre-existing.txt"), "untouched");

    await expect(build(leaf)).rejects.toThrow(MergeConflictError);
    expect(readdirSync(dest())).toEqual(["pre-existing.txt"]);
    expect(read(dest(), "pre-existing.txt")).toBe("untouched");
  });

  it("applies patches from multiple layers in precedence order", async () => {
    const start = "alpha\nbeta\ngamma\n";
    const afterMid = "alpha\nbeta\nMID\ngamma\n";
    const afterLeaf = "alpha\nLEAF\nbeta\nMID\ngamma\n";

    layer("base", { "app.txt": start });
    layer("mid", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(start, afterMid),
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../mid"] }),
      // Authored against mid's output, proving the lower patch landed first.
      "app.txt.patch": patchOf(afterMid, afterLeaf),
    });

    const result = await compile(resolve(leaf), { destDir: dest() });
    expect(read(dest(), "app.txt")).toBe(afterLeaf);
    expect(result.files["app.txt"]?.patchedFrom?.length).toBe(2);
  });

  it("patch then tombstone: the higher tombstone wins and the file is gone", async () => {
    layer("base", { "app.txt": BASE });
    layer("mid", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../mid"] }),
      "app.txt.delete": "",
    });
    expect(existsSync(join(await build(leaf), "app.txt"))).toBe(false);
  });

  it("tombstone then patch: patching a removed file fails loud", async () => {
    layer("base", { "app.txt": BASE });
    layer("mid", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.delete": "",
    });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../mid"] }),
      "app.txt.patch": patchOf(BASE, PATCHED),
    });
    await expect(build(leaf)).rejects.toThrow(/nothing to apply to/);
  });

  it("patches a file that no layer produces — fails loud rather than creating it", async () => {
    const leaf = layer("leaf", { "ghost.txt.patch": patchOf(BASE, PATCHED) });
    await expect(build(leaf)).rejects.toThrow(/nothing to apply to/);
  });

  it("renders a templated parent first, then patches the rendered output", async () => {
    // Render-then-merge: the patch is authored against what `.tmpl` produced,
    // not against the template source.
    const rendered = "name: billing\nport: 8080\nmode: dev\n";
    const wanted = "name: billing\nport: 8080\nmode: dev\nreplicas: 3\n";

    layer("base", { "svc.yaml.tmpl": "name: {{ svc }}\nport: {{ port }}\nmode: dev\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "svc.yaml.patch": patchOf(rendered, wanted),
    });

    const out = await build(leaf, { svc: "billing", port: 8080 });
    expect(read(out, "svc.yaml")).toBe(wanted);
  });

  it("renders the patch payload itself when the sidecar asks for it", async () => {
    const rendered = "one\ntwo\nthree\nfour\nfive\n";
    const wanted = "one\ntwo\nreplicas: 3\nthree\nfour\nfive\n";
    layer("base", { "app.txt": rendered });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.treelay":
        `op: patch\nrender: true\npatch: |\n` +
        indent(patchOf(rendered, "one\ntwo\nreplicas: {{ replicas }}\nthree\nfour\nfive\n")),
    });
    expect(read(await build(leaf, { replicas: 3 }), "app.txt")).toBe(wanted);
  });

  it("skips a patch whose `when` guard is falsy, leaving the inherited file", async () => {
    layer("base", { "app.txt": BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ parents: ["../base"] }),
      "app.txt.treelay":
        `op: patch\nwhen: "{{ enabled }}"\npatch: |\n${indent(patchOf(BASE, PATCHED))}`,
    });
    expect(read(await build(leaf, { enabled: false }), "app.txt")).toBe(BASE);
  });

  it("treats files matching a `patch` merge glob as diffs", async () => {
    layer("base", { "app.txt": BASE });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        parents: ["../base"],
        merge: { "app.txt": "patch" },
      }),
      "app.txt": patchOf(BASE, PATCHED),
    });
    expect(read(await build(leaf), "app.txt")).toBe(PATCHED);
  });
});

/** Indent a block for embedding as a YAML block scalar. */
function indent(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? "" : pad + l))
    .join("\n")
    .replace(/\n*$/, "\n");
}

describe("applyPatch3Way — text fidelity", () => {
  it("preserves a missing trailing newline", () => {
    const from = "a\nb\nc";
    const to = "a\nb\nc\nd";
    const out = applyPatch3Way({ file: "f", current: from, patch: patchOf(from, to) });
    expect(out).toBe(to);
  });

  it("preserves CRLF-style content through a three-way merge", () => {
    const base = "a\r\nb\r\nc\r\n";
    const patched = "a\r\nb\r\nB2\r\nc\r\n";
    const out = applyPatch3Way({
      file: "f",
      current: base,
      patch: patchOf(base, patched),
      base,
    });
    expect(out).toBe(patched);
  });
});
