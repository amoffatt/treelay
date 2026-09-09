/**
 * Reported by a consumer composing Cloudflare Worker sites on 0.3.0.
 *
 * Two independent failures, both about a *declared* capability that isn't
 * really there:
 *
 *  - `.toml` is listed as deep-mergeable by the §4 table and matched by the
 *    STRUCTURED regex, but no TOML codec exists, so composing two layers dies.
 *  - a leaf array silently discards every inherited element, and nothing —
 *    not validate, not explain — says so.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "../src/compile.js";
import { resolve } from "../src/resolve.js";
import {
  structuredFormat,
  parseStructured,
  stringifyStructured,
  type StructuredFormat,
} from "../src/serde.js";
import { defaultStrategy } from "../src/merge/index.js";
import { validate } from "../src/validate.js";
import { emptyAudit } from "../src/audit.js";
import { explain, formatExplanation } from "../src/explain.js";
import { writeTree, manifest } from "./helpers/tree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-toml-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const layer = (name: string, files: Record<string, string>): string =>
  writeTree(join(root, name), files);

const dest = () => join(root, "out");
const read = (rel: string) => readFileSync(join(dest(), rel), "utf8");

/**
 * The class behind the TOML bug: a format may be routed to deep-merge only if a
 * codec can actually round-trip it. Pointed at every format, not just the one
 * that was broken — if `structuredFormat` ever gains an extension before its
 * codec, this fails rather than the user's compose.
 */
describe("every format claimed by structuredFormat has a working codec", () => {
  const SAMPLES: Record<StructuredFormat, string> = {
    json: "cfg.json",
    yaml: "cfg.yaml",
    toml: "cfg.toml",
  };

  const doc = {
    name: "site",
    nested: { a: 1, b: "two" },
    list: [{ binding: "DB", database_name: "core" }],
  };

  for (const [fmt, path] of Object.entries(SAMPLES)) {
    it(`round-trips ${fmt} through parse(stringify(x))`, () => {
      expect(structuredFormat(path)).toBe(fmt);
      expect(parseStructured(path, stringifyStructured(path, doc))).toEqual(doc);
    });

    it(`routes ${fmt} to deep-merge by default`, () => {
      expect(defaultStrategy(path)).toBe("deep-merge");
    });
  }

  it("does not claim a format it cannot parse", () => {
    for (const ext of ["ini", "xml", "conf", "properties", "hcl", "tf"]) {
      expect(structuredFormat(`cfg.${ext}`)).toBeUndefined();
      expect(defaultStrategy(`cfg.${ext}`)).toBe("replace");
    }
  });
});

describe("TOML is a real structured format, not an advertised one", () => {
  it("deep-merges a base and leaf wrangler.toml", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "wrangler.toml": [
        'name = "base-site"',
        'compatibility_date = "2025-01-01"',
        "",
        "[vars]",
        'ENV = "dev"',
        "",
      ].join("\n"),
    });
    const leaf = layer("leaf", {
      "treelay.json": manifest({ name: "leaf", parents: ["../base"] }),
      "wrangler.toml": ['name = "leaf-site"', "", "[vars]", 'TIER = "pro"', ""].join(
        "\n",
      ),
    });

    await compile(resolve(leaf), { destDir: dest() });

    const out = read("wrangler.toml");
    expect(out).toContain('name = "leaf-site"');
    // The whole point of deep-merge: the base's keys survive the leaf's file.
    expect(out).toContain('compatibility_date = "2025-01-01"');
    expect(out).toContain('ENV = "dev"');
    expect(out).toContain('TIER = "pro"');
  });

  it("round-trips array-of-tables", async () => {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "wrangler.toml": [
        'name = "site"',
        "",
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "core"',
        "",
      ].join("\n"),
    });
    const leaf = layer("leaf", {
      "treelay.json": manifest({ name: "leaf", parents: ["../base"] }),
      "wrangler.toml": ['account_id = "abc"', ""].join("\n"),
    });

    await compile(resolve(leaf), { destDir: dest() });

    const out = read("wrangler.toml");
    expect(out).toContain("[[d1_databases]]");
    expect(out).toContain('binding = "DB"');
    expect(out).toContain('account_id = "abc"');
  });
});

describe("an array replace that drops inherited elements is reported (§4)", () => {
  /** Their case: a migration journal keyed on idx, both layers contributing. */
  const journal = (entries: unknown[]) =>
    JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2) + "\n";

  const base = { idx: 0, tag: "0000_init", when: 1 };
  const leafEntry = { idx: 1, tag: "0001_add_users", when: 2 };

  function journalTree(leafManifest: Record<string, unknown> = {}): string {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "meta/_journal.json": journal([base]),
    });
    return layer("leaf", {
      "treelay.json": manifest({
        name: "leaf",
        parents: ["../base"],
        ...leafManifest,
      }),
      "meta/_journal.json": journal([leafEntry]),
    });
  }

  it("still drops under the default replace policy — behaviour is unchanged", async () => {
    await compile(resolve(journalTree()), { destDir: dest() });
    const out = JSON.parse(read("meta/_journal.json"));
    expect(out.entries).toEqual([leafEntry]);
  });

  it("names the file, the pointer, the count and both layers", async () => {
    const audit = emptyAudit();
    await compile(resolve(journalTree()), { destDir: dest(), audit });

    expect(audit.droppedArrays).toEqual([
      {
        path: "meta/_journal.json",
        pointer: "/entries",
        dropped: 1,
        by: "leaf",
        over: "base",
        source: "meta/_journal.json",
      },
    ]);
  });

  it("validate reports it as its own code, not as valid", async () => {
    const report = await validate(journalTree());
    expect(report.issues.map((i) => i.code)).toContain("dropped-array");
  });

  it("by-key keeps every layer's entries, ordered by the key", async () => {
    const leaf = journalTree({
      arrays: { "meta/_journal.json": { policy: "by-key", key: "idx", order: "key" } },
    });
    const audit = emptyAudit();
    await compile(resolve(leaf), { destDir: dest(), audit });

    const out = JSON.parse(read("meta/_journal.json"));
    expect(out.entries).toEqual([base, leafEntry]);
    // Nothing was destroyed, so there is nothing to report.
    expect(audit.droppedArrays).toEqual([]);
  });

  it("by-key merges an entry both layers define rather than duplicating it", async () => {
    layer("base2", {
      "treelay.json": manifest({ name: "base2" }),
      "cfg.json": JSON.stringify({ routes: [{ id: "a", path: "/a", auth: true }] }),
    });
    const leaf = layer("leaf2", {
      "treelay.json": manifest({
        name: "leaf2",
        parents: ["../base2"],
        arrays: { "cfg.json": { policy: "by-key", key: "id" } },
      }),
      "cfg.json": JSON.stringify({ routes: [{ id: "a", path: "/alpha" }] }),
    });

    await compile(resolve(leaf), { destDir: dest() });
    expect(JSON.parse(read("cfg.json")).routes).toEqual([
      { id: "a", path: "/alpha", auth: true },
    ]);
  });

  it("fails loudly when by-key has no key rather than silently replacing", async () => {
    const leaf = journalTree({
      arrays: { "meta/_journal.json": { policy: "by-key" } },
    });
    await expect(
      compile(resolve(leaf), { destDir: dest() }),
    ).rejects.toThrow(/needs a "key"/);
  });
});

describe("explain does not claim a layer was folded in when its array was dropped", () => {
  const journal = (entries: unknown[]) =>
    JSON.stringify({ version: "7", entries }, null, 2) + "\n";

  function tree(leafManifest: Record<string, unknown> = {}): string {
    layer("base", {
      "treelay.json": manifest({ name: "base" }),
      "meta/_journal.json": journal([{ idx: 0, tag: "0000_init" }]),
    });
    return layer("leaf", {
      "treelay.json": manifest({ name: "leaf", parents: ["../base"], ...leafManifest }),
      "meta/_journal.json": journal([{ idx: 1, tag: "0001_users" }]),
    });
  }

  it("attaches the drop to the file it happened in", async () => {
    const result = await explain(resolve(tree()));
    const file = result.files["meta/_journal.json"]!;

    expect(file.patchedFrom.length).toBeGreaterThan(0);
    expect(file.droppedArrays).toEqual([
      {
        path: "meta/_journal.json",
        pointer: "/entries",
        dropped: 1,
        by: "leaf",
        over: "base",
        source: "meta/_journal.json",
      },
    ]);
  });

  it("qualifies the folded-in line rather than printing it bare", async () => {
    const text = formatExplanation(await explain(resolve(tree())));
    expect(text).toContain("folded in: base (keys only — see below)");
    expect(text).toContain("dropped: 1 inherited entry at /entries");
  });

  it("says nothing extra once by-key preserves the entries", async () => {
    const leaf = tree({
      arrays: { "meta/_journal.json": { policy: "by-key", key: "idx" } },
    });
    const text = formatExplanation(await explain(resolve(leaf)));
    expect(text).toContain("folded in: base");
    expect(text).not.toContain("keys only");
    expect(text).not.toContain("dropped:");
  });
});
