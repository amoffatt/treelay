/**
 * `validate` — the pre-flight check (SPEC §9).
 *
 * The behaviour that matters is not any single check but the *collecting*: a
 * warning must not mask an error, an error must not hide the checks that still
 * ran, and a check that could not run has to say so rather than passing by
 * omission.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { validate, formatValidation } from "../src/validate.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-validate-"));
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

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validate", () => {
  it("passes a healthy composition and counts what it checked", async () => {
    layer("base", { "a.txt": "base\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      "b.txt": "leaf\n",
    });

    const report = await validate(leaf);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.layerCount).toBe(2);
    expect(report.fileCount).toBe(2);
  });

  it("reports a cycle as an error and says the rest went unchecked", async () => {
    layer("a", { "treelay.json": JSON.stringify({ name: "a", parents: ["../b"] }) });
    layer("b", { "treelay.json": JSON.stringify({ name: "b", parents: ["../a"] }) });

    const report = await validate(join(root, "a"));

    expect(report.ok).toBe(false);
    expect(codes(report.issues)).toEqual(["cycle"]);
    // A cycle makes every downstream check impossible; saying so is the point.
    expect(report.skipped.join(" ")).toMatch(/did not resolve/);
    expect(report.layerCount).toBeUndefined();
  });

  it("reports a missing parent as a resolution error", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../nope"] }),
    });

    const report = await validate(leaf);

    expect(report.ok).toBe(false);
    expect(codes(report.issues)).toEqual(["resolve-failed"]);
  });

  it("warns without failing when variables have no values to render with", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        templateSuffix: ".tmpl",
        variables: { svc: { type: "string", prompt: "Service?" } },
      }),
      "a.txt.tmpl": "{{ svc }}\n",
    });

    const report = await validate(leaf);

    // Missing answers is a fact about the invocation, not a defect in the
    // template — so it warns, and the run still succeeds.
    expect(report.ok).toBe(true);
    expect(codes(report.issues)).toContain("variables-unresolved");
    expect(report.skipped.join(" ")).toMatch(/no values to render with/);
    expect(report.fileCount).toBeUndefined();
  });

  it("checks patches and conflicts once values are supplied", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        name: "leaf",
        templateSuffix: ".tmpl",
        variables: { svc: { type: "string", prompt: "Service?" } },
      }),
      "a.txt.tmpl": "{{ svc }}\n",
    });

    const report = await validate(leaf, { values: { svc: "billing" } });

    expect(report.ok).toBe(true);
    expect(codes(report.issues)).not.toContain("variables-unresolved");
    expect(report.fileCount).toBe(1);
  });

  it("surfaces a patch that no longer applies as an error", async () => {
    layer("base", { "cfg.txt": "totally different content\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
      // A unified diff whose context does not exist in the parent.
      "cfg.txt.patch": [
        "--- a/cfg.txt",
        "+++ b/cfg.txt",
        "@@ -1,2 +1,2 @@",
        " expected first line",
        "-expected second",
        "+replacement",
        "",
      ].join("\n"),
    });

    const report = await validate(leaf);

    expect(report.ok).toBe(false);
    expect(codes(report.issues)).toContain("merge-conflict");
    // The graph itself was fine — this is a composition failure, not a
    // resolution one, and the report has to keep those apart.
    expect(report.layerCount).toBe(2);
  });

  it("warns when the lockfile no longer matches the tree", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf" }),
      "a.txt": "x\n",
      // A lock claiming a pin this tree does not have.
      "treelay.lock": JSON.stringify(
        {
          lockfileVersion: 1,
          refs: {
            "git+https://example.invalid/r.git#v1": {
              kind: "git",
              source: "https://example.invalid/r.git",
              requested: "v1",
              resolved: "0".repeat(40),
              integrity: "sha256:0",
            },
          },
        },
        null,
        2,
      ),
    });

    const report = await validate(leaf);

    expect(codes(report.issues)).toContain("lock-stale");
    // Stale pins are a housekeeping problem, not a broken build.
    expect(report.ok).toBe(true);
  });

  it("says drift went unchecked unless asked, since it needs the network", async () => {
    const leaf = layer("leaf", { "treelay.json": JSON.stringify({ name: "leaf" }) });

    const report = await validate(leaf);

    expect(report.skipped.join(" ")).toMatch(/upstream drift/);
    expect(codes(report.issues)).not.toContain("drift");
  });
});

describe("formatValidation", () => {
  it("states the all-clear with what was covered", async () => {
    layer("base", { "a.txt": "base\n" });
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({ name: "leaf", parents: ["../base"] }),
    });

    const text = formatValidation(await validate(leaf), leaf);

    expect(text).toContain("is valid");
    expect(text).toContain("2 layer(s)");
    // Even a clean report lists what it did not check.
    expect(text).toContain("not checked:");
  });

  it("leads with errors and prints the remedy", async () => {
    layer("a", { "treelay.json": JSON.stringify({ name: "a", parents: ["../b"] }) });
    layer("b", { "treelay.json": JSON.stringify({ name: "b", parents: ["../a"] }) });

    const text = formatValidation(await validate(join(root, "a")), join(root, "a"));

    expect(text).toContain("✗ cycle:");
    expect(text).toContain("cannot be its own ancestor");
    expect(text).toContain("1 error(s)");
  });
});
