/**
 * Composition audit — the destructive and fabricating operations (SPEC §4).
 *
 * Regression cover for a production carve that found treelay's quiet paths: a
 * descendant's `.gitignore` silently discarding its ancestor's Terraform ignore
 * rules, and an `.append` with nothing to append to fabricating the file from
 * the fragment alone. Both failure modes are *absence* — every tree still
 * compiled, every test still passed, the content was simply not there.
 *
 * The invariant these tests defend: an operation that destroys or fabricates
 * content is never silent. Either it fails, or something reports it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile, composeFiles } from "../src/compile.js";
import { resolve } from "../src/resolve.js";
import { validate, formatValidation } from "../src/validate.js";
import { emptyAudit, auditIsClean } from "../src/audit.js";
import { OrphanOpError, MergeConflictError } from "../src/errors.js";
import { writeTree, manifest } from "./helpers/tree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-audit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const layer = (name: string, files: Record<string, string>): string =>
  writeTree(join(root, name), files);

const dest = () => join(root, "out");
const read = (rel: string) => readFileSync(join(dest(), rel), "utf8");
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

/** The reported fixture: a base layer's ignore rules and a descendant's own. */
function gitignoreTree(leafManifest: Record<string, unknown> = {}): string {
  layer("base", {
    "treelay.json": manifest({ name: "base" }),
    ".gitignore": "*.tfstate\n**/secrets.tfvars\n",
  });
  return layer("child", {
    "treelay.json": manifest({
      name: "child",
      parents: ["../base"],
      ...leafManifest,
    }),
    ".gitignore": "dist/\n",
  });
}

describe("same-path replacement is reported (§4)", () => {
  it("still replaces — the strategy is unchanged, only the silence is fixed", async () => {
    const leaf = gitignoreTree();
    await compile(resolve(leaf), { destDir: dest() });

    // Documenting the behaviour that surprised a reader of the SPEC table: a
    // descendant's .gitignore does NOT concatenate onto its ancestor's.
    expect(read(".gitignore")).toBe("dist/\n");
  });

  it("names the winner, the loser and the source file", async () => {
    const leaf = gitignoreTree();
    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });

    expect(audit.replacements).toEqual([
      { path: ".gitignore", by: "child", over: "base", source: ".gitignore" },
    ]);
    expect(auditIsClean(audit)).toBe(false);
  });

  it("validate warns without failing, so it stays usable as a merge gate", async () => {
    const report = await validate(gitignoreTree());

    expect(codes(report.issues)).toEqual(["shadowed-replace"]);
    expect(report.issues[0]?.severity).toBe("warning");
    expect(report.ok).toBe(true);

    const text = formatValidation(report, "leaf");
    expect(text).toContain(".gitignore");
    expect(text).toContain("child replaces base");
    // The remedy has to name the way out, or the warning is just noise.
    expect(text).toContain(".append");
  });

  it("--strict promotes it to an error for repos that want the tighter gate", async () => {
    const report = await validate(gitignoreTree(), { strict: true });

    expect(report.ok).toBe(false);
    expect(report.issues[0]?.severity).toBe("error");
    // The printed report and the exit status must never disagree.
    expect(formatValidation(report, "leaf")).toContain("1 error(s)");
  });

  it("--allow-replace suppresses the check entirely", async () => {
    const report = await validate(gitignoreTree(), { allowReplace: true });

    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a manifest `merge` glob declares the intent and is not reported", async () => {
    // The author has said "replace this path" in the manifest. A warning nobody
    // can silence legitimately is a warning everyone learns to ignore.
    const leaf = gitignoreTree({ merge: { ".gitignore": "replace" } });
    const report = await validate(leaf);

    expect(report.issues).toEqual([]);
  });

  it("a declared `append` glob concatenates, and is not a replacement", async () => {
    const leaf = gitignoreTree({ merge: { ".gitignore": "append" } });
    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });

    expect(read(".gitignore")).toBe("*.tfstate\n**/secrets.tfvars\ndist/\n");
    expect(audit.replacements).toEqual([]);
  });

  it("a sidecar `op: replace` is explicit, so it is not reported", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "app.conf": "from base\n",
    });
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "app.conf.treelay": "op: replace\ncontent: |\n  from child\n",
    });

    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });

    expect(read("app.conf")).toBe("from child\n");
    expect(audit.replacements).toEqual([]);
  });

  it("does not report a deep-merge, which loses nothing", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "cfg.json": '{"a":1}\n',
    });
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "cfg.json": '{"b":2}\n',
    });

    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });

    expect(JSON.parse(read("cfg.json"))).toEqual({ a: 1, b: 2 });
    expect(audit.replacements).toEqual([]);
  });

  it("says nothing about a tree where no path is shadowed", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "a.txt": "base\n",
    });
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "b.txt": "child\n",
    });

    const report = await validate(leaf);
    expect(report.issues).toEqual([]);
  });
});

describe("an op with no inherited file fails (§4)", () => {
  /** A base layer that ships something, but not the op's target. */
  const baseWithout = () =>
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "other.txt": "keep\n",
    });

  it("refuses an orphan .append instead of fabricating the file", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.append": "ORPHAN\n",
    });

    // The regression: this used to compile and produce a doc.md containing only
    // the fragment, so a rename in the base layer shipped every downstream tree
    // a document beginning mid-sentence.
    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.toThrow(OrphanOpError);
  });

  it("names the target and the fragment that declared it", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.append": "ORPHAN\n",
    });

    await expect(compile(resolve(leaf), { destDir: dest() })).rejects.toThrow(
      /doc\.md\.append/,
    );
  });

  it("refuses an orphan .prepend", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.prepend": "ORPHAN\n",
    });

    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.toThrow(OrphanOpError);
  });

  it("refuses an orphan structured `op: merge`", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "cfg.json.treelay": "op: merge\nmerge:\n  a: 1\n",
    });

    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.toThrow(OrphanOpError);
  });

  it("is not a MergeConflictError — nothing conflicted, the base is absent", async () => {
    // The remedy differs (ship the file / find the rename, vs. fix the patch),
    // so `validate` must be able to tell the two apart.
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.append": "ORPHAN\n",
    });

    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.not.toBeInstanceOf(MergeConflictError);
  });

  it("still allows an append onto a file the same layer ships", async () => {
    // Files are applied before ops within a layer, so this has a base.
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md": "OWN\n",
      "doc.md.append": "MORE\n",
    });

    await compile(resolve(leaf), { destDir: dest() });
    expect(read("doc.md")).toBe("OWN\nMORE\n");
  });

  it("leaves a tombstone for an absent file alone — it loses nothing", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "ghost.txt.delete": "",
    });

    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });
    expect(auditIsClean(audit)).toBe(true);
  });

  it("leaves a sidecar `op: replace` on an absent file alone — it is a create", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "new.txt.treelay": "op: replace\ncontent: |\n  fresh\n",
    });

    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });
    expect(read("new.txt")).toBe("fresh\n");
    expect(auditIsClean(audit)).toBe(true);
  });

  it("skips a `when:`-guarded orphan op rather than failing on it", async () => {
    // The op never runs, so it has no missing prerequisite to complain about.
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.treelay": 'op: append\nwhen: "false"\ncontent: "x\\n"\n',
    });

    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });
    expect(auditIsClean(audit)).toBe(true);
  });

  it("validate reports every orphan at once, not just the first", async () => {
    // compile fails on the first; validate is producing a report, not a tree.
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.append": "A\n",
      "notes.md.prepend": "B\n",
      "cfg.json.treelay": "op: merge\nmerge:\n  a: 1\n",
    });

    const report = await validate(leaf);

    expect(codes(report.issues)).toEqual(["orphan-op"]);
    expect(report.issues[0]?.severity).toBe("error");
    expect(report.ok).toBe(false);

    const text = formatValidation(report, "leaf");
    for (const source of ["doc.md.append", "notes.md.prepend", "cfg.json.treelay"]) {
      expect(text).toContain(source);
    }
    expect(text).toContain("3 op(s)");
  });

  it("collect mode skips the op rather than fabricating the file", async () => {
    baseWithout();
    const leaf = layer("child", {
      "treelay.json": manifest({ name: "child", parents: ["../base"] }),
      "doc.md.append": "ORPHAN\n",
    });

    const audit = emptyAudit();
    const files = await composeFiles(resolve(leaf), {}, undefined, {
      onOrphanOp: "collect",
      audit,
    });

    expect(files.has("doc.md")).toBe(false);
    expect(audit.orphanOps).toEqual([
      { path: "doc.md", op: "append", by: "child", source: "doc.md.append" },
    ]);
  });

  it("catches a composed document whose base layer renamed its file", async () => {
    // The concrete scenario: a deploy guide split as core's DEPLOYMENT.md plus
    // per-layer fragments. Renaming core's file used to ship four deployments a
    // guide starting mid-sentence.
    layer("core", {
      "treelay.json": manifest({ name: "core" }),
      "DEPLOY.md": "# Deploying\n", // renamed from DEPLOYMENT.md
    });
    const leaf = layer("service", {
      "treelay.json": manifest({ name: "service", parents: ["../core"] }),
      "DEPLOYMENT.md.append": "## Platform notes\n",
    });

    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.toThrow(/DEPLOYMENT\.md/);
  });
});

describe("the strictness does not break composes of partial stacks (§8)", () => {
  it("composes a truncated prefix that contains an .append without orphaning it", async () => {
    // Reflux composes `layers.slice(0, position - 1)` to find the text a patch is
    // authored against. Truncation can only orphan an op if it was already
    // orphaned: an op's base always comes from a *lower* layer, so any prefix
    // containing the op also contains its base. This is that invariant, stated so
    // it fails loudly rather than turning every promotion into an OrphanOpError.
    const stack = [
      layer("base", {
        "treelay.json": manifest({ name: "base" }),
        "notes.md": "BASE\n",
      }),
      layer("mid", {
        "treelay.json": manifest({ name: "mid", parents: ["../base"] }),
        "notes.md.append": "MID\n",
      }),
      layer("leaf", {
        "treelay.json": manifest({ name: "leaf", parents: ["../mid"] }),
      }),
    ];
    const graph = resolve(stack[2]!);
    expect(graph.layers).toHaveLength(3);

    // Every prefix of a valid stack must compose — including [base, mid], the one
    // that holds mid's append and the base file it applies to.
    for (let n = 1; n <= graph.layers.length; n++) {
      const prefix = { layers: graph.layers.slice(0, n), variables: {} };
      const files = await composeFiles(prefix, {});
      expect(files.has("notes.md")).toBe(true);
    }

    const full = await composeFiles(graph, {});
    expect(full.get("notes.md")?.data.toString("utf8")).toBe("BASE\nMID\n");
  });

  it("promotes a file cleanly while a sibling file carries an .append", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "app.conf": "from base\n",
      "notes.md": "BASE\n",
    });
    layer("mid", {
      "treelay.json": manifest({ name: "mid", parents: ["../base"] }),
      "notes.md.append": "MID\n",
    });
    const leaf = layer("leaf", {
      "treelay.json": manifest({ name: "leaf", parents: ["../mid"] }),
    });

    await compile(resolve(leaf), { destDir: dest() });
    const { status, promote } = await import("../src/reflux.js");
    const { writeFileSync } = await import("node:fs");

    writeFileSync(join(dest(), "app.conf"), "edited\n");
    const result = await promote(dest(), await status(dest()), { to: "leaf" });

    expect(result.verified).toBe(true);
  });
});

describe("multi-parent .append ordering is defined (§4)", () => {
  /** A diamond: base ships the file, two parents each append to it. */
  function diamond(parents: string[]): string {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "doc.md": "BASE\n",
    });
    layer("a", {
      "treelay.json": manifest({ name: "a", parents: ["../base"] }),
      "doc.md.append": "FROM-A\n",
    });
    layer("b", {
      "treelay.json": manifest({ name: "b", parents: ["../base"] }),
      "doc.md.append": "FROM-B\n",
    });
    return layer("leaf", {
      "treelay.json": manifest({ name: "leaf", parents }),
    });
  }

  it("follows linearization order, so the first-listed parent lands last", async () => {
    // Earlier in `parents` = higher precedence (C3, §3), and higher precedence
    // composes later — so a's fragment appends after b's.
    await compile(resolve(diamond(["../a", "../b"])), { destDir: dest() });
    expect(read("doc.md")).toBe("BASE\nFROM-B\nFROM-A\n");
  });

  it("reorders when `parents` is reordered — the manifest fully determines it", async () => {
    await compile(resolve(diamond(["../b", "../a"])), { destDir: dest() });
    expect(read("doc.md")).toBe("BASE\nFROM-A\nFROM-B\n");
  });
});
