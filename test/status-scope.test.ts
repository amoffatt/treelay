/**
 * What `status` chooses to talk about — SPEC §8.
 *
 * Reported from a tree that had been worked in: `status` walked every file in
 * the destination, so `node_modules/`, `.venv/` and `__pycache__/` all read as
 * local additions. 75,321 lines of output with the one real finding
 * (`M package-lock.json`) on line 75,295. Separately, following the npm
 * workspace symlink at `node_modules/<self>` reported the app's own files a
 * second time under a path that does not really contain them.
 *
 * The fix has a trap in it, which is most of what these tests defend: ignore
 * rules must apply to *local additions only*. A file the template produced into
 * a gitignored directory is still tracked, and hiding its edits would be the
 * same silent omission one level down.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "../src/compile.js";
import { resolve } from "../src/resolve.js";
import { status, promote } from "../src/reflux.js";
import { dependencyManifests } from "../src/update.js";
import { buildIgnoreFilter } from "../src/gitignore.js";
import { writeTree, manifest } from "./helpers/tree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-status-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dest = () => join(root, "out");
const paths = (changes: { path: string }[]) => changes.map((c) => c.path);

/** A compiled destination, then worked in the way a real one is. */
async function workedTree(extra: Record<string, string> = {}): Promise<void> {
  const src = writeTree(join(root, "layer"), {
    "treelay.json": manifest({ name: "layer" }),
    "app.txt": "hello\n",
    ".gitignore": "node_modules/\n.venv/\n__pycache__/\n",
    ...extra,
  });
  await compile(resolve(src), { destDir: dest() });
}

describe("status ignores what the destination's .gitignore ignores", () => {
  beforeEach(async () => {
    await workedTree();
    writeTree(join(dest(), "node_modules", "pkg"), {
      "a.js": "a\n",
      "b.js": "b\n",
    });
    writeTree(join(dest(), ".venv", "lib"), { "site.py": "s\n" });
    writeTree(join(dest(), "__pycache__"), { "m.pyc": "m\n" });
    writeFileSync(join(dest(), "real-local.txt"), "mine\n");
  });

  it("leaves the one real finding visible", async () => {
    const changes = await status(dest());
    expect(paths(changes)).toEqual(["real-local.txt"]);
  });

  it("counts what it left out rather than hiding the omission", async () => {
    const skipped = { ignored: 0 };
    await status(dest(), { skipped });
    expect(skipped.ignored).toBe(4);
  });

  it("--all restores the full listing", async () => {
    const changes = await status(dest(), { all: true });
    expect(paths(changes)).toContain("node_modules/pkg/a.js");
    expect(paths(changes)).toContain(".venv/lib/site.py");
    expect(paths(changes)).toContain("real-local.txt");
  });
});

describe("ignore rules never hide a file the template produced", () => {
  it("still reports an edit inside a gitignored directory", async () => {
    // The klamath shape: a tree compiled into a directory git ignores.
    await workedTree({
      "build/out.txt": "generated\n",
      ".gitignore": "build/\nnode_modules/\n",
    });
    writeFileSync(join(dest(), "build", "out.txt"), "edited by hand\n");

    const changes = await status(dest());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "build/out.txt", kind: "modified" });
  });

  it("still reports a deletion inside a gitignored directory", async () => {
    await workedTree({ "build/out.txt": "generated\n", ".gitignore": "build/\n" });
    rmSync(join(dest(), "build", "out.txt"));

    const changes = await status(dest());
    expect(changes).toMatchObject([{ path: "build/out.txt", kind: "deleted" }]);
  });
});

describe("status does not walk out of the tree it is scanning", () => {
  it("does not follow a workspace symlink back into the project", async () => {
    await workedTree();
    // The reported shape: node_modules/<self> → the destination itself.
    mkdirSync(join(dest(), "node_modules"), { recursive: true });
    symlinkSync(dest(), join(dest(), "node_modules", "self"), "dir");
    // And a link pointing clean outside the destination.
    const outside = writeTree(join(root, "outside"), { "secret.txt": "s\n" });
    symlinkSync(outside, join(dest(), "linked-out"), "dir");

    const changes = await status(dest(), { all: true });
    for (const p of paths(changes)) {
      expect(p).not.toContain("node_modules/self/");
      expect(p).not.toContain("linked-out/");
    }
  });
});

describe("--modified-only", () => {
  it("reports edits to template files and nothing else", async () => {
    await workedTree();
    writeFileSync(join(dest(), "app.txt"), "edited\n");
    writeFileSync(join(dest(), "brand-new.txt"), "new\n");

    expect(paths(await status(dest(), { modifiedOnly: true }))).toEqual(["app.txt"]);
    // Without it, the local addition is still reported.
    expect(paths(await status(dest()))).toContain("brand-new.txt");
  });
});

describe("nested .gitignore files, as git applies them", () => {
  const filter = (files: Record<string, string>) =>
    buildIgnoreFilter("/x", Object.keys(files), (rel) => files[rel]!);

  it("scopes a nested file to its own subtree", () => {
    const f = filter({ "pkg/.gitignore": "dist/\n" });
    expect(f.ignores("pkg/dist/a.js")).toBe(true);
    expect(f.ignores("other/dist/a.js")).toBe(false);
  });

  it("lets a nested negation re-include what the root excluded", () => {
    const f = filter({ ".gitignore": "*.log\n", "keep/.gitignore": "!important.log\n" });
    expect(f.ignores("a.log")).toBe(true);
    expect(f.ignores("keep/important.log")).toBe(false);
  });

  it("reports how many sources it read", () => {
    expect(filter({ ".gitignore": "a\n", "p/.gitignore": "b\n" }).sources).toBe(2);
  });
});

describe("dependency manifests are named when update rewrites them", () => {
  it("picks out manifests across ecosystems and ignores ordinary files", () => {
    expect(
      dependencyManifests([
        "package.json",
        "src/app/package.json",
        "requirements-dev.txt",
        "pyproject.toml",
        "Cargo.lock",
        "go.mod",
        "README.md",
        "src/index.ts",
        "packages.txt",
      ]),
    ).toEqual([
      "package.json",
      "src/app/package.json",
      "requirements-dev.txt",
      "pyproject.toml",
      "Cargo.lock",
      "go.mod",
    ]);
  });

  it("returns nothing when an update touched no manifest", () => {
    expect(dependencyManifests(["README.md", "src/a.ts"])).toEqual([]);
  });
});

describe("blast radius can block a promotion instead of reporting it", () => {
  /** A shared base with two dependent leaves — the multi-tenant shape. */
  async function sharedBase(): Promise<string> {
    writeTree(join(root, "base"), {
      "treelay.json": manifest({ name: "base" }),
      "shared.txt": "shared\n",
    });
    for (const name of ["tenant-a", "tenant-b"]) {
      writeTree(join(root, name), {
        "treelay.json": manifest({ name, parents: ["../base"] }),
      });
    }
    const leaf = join(root, "tenant-a");
    await compile(resolve(leaf), { destDir: dest() });
    writeFileSync(join(dest(), "shared.txt"), "edited\n");
    return leaf;
  }

  it("refuses over the ceiling and writes nothing", async () => {
    await sharedBase();
    const changes = await status(dest());

    await expect(
      promote(dest(), changes, { to: "base", maxBlastRadius: 0, searchRoot: root }),
    ).rejects.toThrow(/max-blast-radius/);

    // Refused before the transaction, so the layer is untouched.
    expect(readFileSync(join(root, "base", "shared.txt"), "utf8")).toBe("shared\n");
  });

  it("allows the same promotion under a ceiling that accommodates it", async () => {
    await sharedBase();
    const changes = await status(dest());

    const result = await promote(dest(), changes, {
      to: "base",
      maxBlastRadius: 10,
      searchRoot: root,
    });
    expect(result.landed).toHaveLength(1);
    expect(readFileSync(join(root, "base", "shared.txt"), "utf8")).toBe("edited\n");
  });

  it("still reports the radius when no ceiling is set — the default is unchanged", async () => {
    await sharedBase();
    const changes = await status(dest());
    const result = await promote(dest(), changes, { to: "base", searchRoot: root });
    expect(result.blastRadius.dependents.length).toBeGreaterThan(0);
    expect(result.blastRadiusWarning).toBeTruthy();
  });
});
