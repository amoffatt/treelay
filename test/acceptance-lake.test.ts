/**
 * Acceptance: the autom-lake / soredi-azure shape, end to end.
 *
 * This is the consumer treelay is being built against, and it exercises step 9
 * the way a real repo does rather than the way a unit test does:
 *
 *  - a four-deep layer chain, `core → edo → state → client`;
 *  - an `npm-packages` tree **mounted** into every composed build at
 *    `packages/`, fetched from git;
 *  - the leaf **holding that mount back** at an older commit while its parents
 *    float on a branch — the thing that has to work when a downstream project
 *    is not ready for the latest packages;
 *  - compiling into a gitignored `build/` **inside** the source repo (§7);
 *  - and the vendored tree behaving as ordinary substrate: layers above it can
 *    append to and tombstone files inside the mount.
 *
 * Everything runs against a `file://` remote in a temp directory with
 * `TREELAY_CACHE_DIR` redirected — no network, no shared cache.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "../src/compile.js";
import { explain } from "../src/explain.js";
import { readLock } from "../src/lockfile.js";
import { canonicalRef } from "../src/refs.js";
import { readState } from "../src/state.js";
import { MountError } from "../src/resolve.js";
import { makeRepo, gitAvailable, type Repo } from "./helpers/git-fixture.js";
import { writeTree, manifest, readText } from "./helpers/tree.js";
import { GIT_REFS, gitRef, resolveWith } from "./helpers/step9.js";

const LIVE = GIT_REFS && gitAvailable();

let root: string;
let priorCache: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-lake-"));
  priorCache = process.env["TREELAY_CACHE_DIR"];
  process.env["TREELAY_CACHE_DIR"] = join(root, "cache");
});
afterEach(() => {
  if (priorCache === undefined) delete process.env["TREELAY_CACHE_DIR"];
  else process.env["TREELAY_CACHE_DIR"] = priorCache;
  rmSync(root, { recursive: true, force: true });
});

/** The shared npm-packages remote: an older release, then a newer one. */
function packagesRemote(): { repo: Repo; held: string } {
  const repo = makeRepo(join(root, "npm-packages"), {
    "core-utils/index.ts": "export const VERSION = 1;\n",
    "legacy/index.ts": "export const LEGACY = true;\n",
  });
  const held = repo.head();
  repo.commit({
    "core-utils/index.ts": "export const VERSION = 2;\n",
    "brand-new/index.ts": "export const NEW = true;\n",
  });
  return { repo, held };
}

/**
 * The core → edo → state → client chain.
 *
 * `state` floats the packages mount on `main`; `client` (the leaf) holds the
 * same mount path back at `held`. Mount paths merge by ordinary precedence, so
 * the leaf's ref is the one that gets fetched.
 */
function lakeLayers(repo: Repo, held: string): string {
  writeTree(join(root, "core"), {
    "treelay.json": manifest({ name: "core" }),
    "config.json": JSON.stringify({ tier: "core", telemetry: true }, null, 2) + "\n",
    "core-only.txt": "core\n",
  });
  writeTree(join(root, "edo"), {
    "treelay.json": manifest({ name: "edo", parents: ["../core"] }),
    "config.json": JSON.stringify({ tier: "edo" }, null, 2) + "\n",
  });
  writeTree(join(root, "state"), {
    "treelay.json": manifest({
      name: "state",
      parents: ["../edo"],
      mounts: { packages: gitRef(repo, "main") },
    }),
    "config.json": JSON.stringify({ region: "westeurope" }, null, 2) + "\n",
  });
  return writeTree(join(root, "client"), {
    "treelay.json": manifest({
      name: "client",
      parents: ["../state"],
      mounts: { packages: gitRef(repo, held) },
    }),
    "config.json": JSON.stringify({ tier: "client" }, null, 2) + "\n",
  });
}

describe.skipIf(!LIVE)("acceptance — the lake layer chain with a held-back mount", () => {
  it("vendors the leaf's pin, not the floating one its parent asked for", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    const dest = join(leaf, "build");

    await compile(resolveWith(leaf), { destDir: dest });

    // The held-back revision, verbatim.
    expect(readText(dest, "packages/core-utils/index.ts")).toBe(
      "export const VERSION = 1;\n",
    );
    // A file that only exists on `main` must not leak in: one mount path, one
    // winning ref, no blending of two checkouts.
    expect(existsSync(join(dest, "packages/brand-new/index.ts"))).toBe(false);
  });

  it("records exactly the vendored revision in treelay.lock", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    await compile(resolveWith(leaf), { destDir: join(leaf, "build") });

    const lock = readLock(leaf);
    const entries = Object.values(lock.refs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "git", resolved: held });
    // The ref the *losing* parent declared was never fetched, so it has no
    // business claiming a pin in a file that documents what was materialized.
    expect(lock.refs[canonicalRef(gitRef(repo, "main"))]).toBeUndefined();
  });

  it("keeps composing the held revision after the branch moves on", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    await compile(resolveWith(leaf), { destDir: join(leaf, "build") });

    repo.commit({ "core-utils/index.ts": "export const VERSION = 3;\n" });

    const second = join(root, "elsewhere");
    await compile(resolveWith(leaf), { destDir: second });
    expect(readText(second, "packages/core-utils/index.ts")).toBe(
      "export const VERSION = 1;\n",
    );
  });

  it("never lets the checkout's .git reach the composed tree", async () => {
    // A vendored `.git` publishes a tree git reads as a broken submodule (§4).
    // The fetch cache holds real checkouts, so this is the path where it would
    // most plausibly slip through.
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    const dest = join(leaf, "build");

    await compile(resolveWith(leaf), { destDir: dest });

    expect(existsSync(join(dest, "packages/.git"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("composes the chain itself in C3 order, leaf last", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    const dest = join(leaf, "build");

    await compile(resolveWith(leaf), { destDir: dest });

    const config = JSON.parse(readText(dest, "config.json"));
    expect(config).toEqual({
      tier: "client", // leaf wins
      telemetry: true, // survives from core
      region: "westeurope", // contributed by state
    });
    expect(readText(dest, "core-only.txt")).toBe("core\n");
  });

  it("compiles into a build/ directory inside the source repo without self-inclusion", async () => {
    // How the lake actually builds: `build/` is gitignored and lives in the
    // repo being composed. The destination is pruned from its own layer walk
    // (§7), so recompiling never vendors the previous run's output.
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    const dest = join(leaf, "build");

    await compile(resolveWith(leaf), { destDir: dest });
    await compile(resolveWith(leaf), { destDir: dest });

    expect(existsSync(join(dest, "build"))).toBe(false);
    expect(existsSync(join(dest, "packages/build"))).toBe(false);
    expect(readText(dest, "packages/core-utils/index.ts")).toBe(
      "export const VERSION = 1;\n",
    );
  });

  it("keeps a build/ out of a *different* destination when the leaf ignores it", async () => {
    // §7 prunes the destination currently being written. A build directory
    // left over from an earlier run is, to any other compile, just files in
    // the layer — so a project that builds to more than one place (CI and
    // local, say) has to say `ignore: ["build/**"]`. Pinned here because the
    // lake compiles inside its own source repo and would otherwise ship a
    // stale copy of itself.
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    writeTree(leaf, {
      "treelay.json": manifest({
        name: "client",
        parents: ["../state"],
        mounts: { packages: gitRef(repo, held) },
        ignore: ["build/**"],
      }),
    });

    await compile(resolveWith(leaf), { destDir: join(leaf, "build") });
    await compile(resolveWith(leaf), { destDir: join(root, "second") });

    expect(existsSync(join(root, "second", "build"))).toBe(false);
    expect(existsSync(join(root, "second", "packages/core-utils/index.ts"))).toBe(true);
  });
});

describe.skipIf(!LIVE)("acceptance — a mount is substrate, not a sealed unit", () => {
  it("lets a layer above the mount append to a vendored file", async () => {
    // Mounts sit at the bottom of the stack precisely so this works. If they
    // sat beside their declaring layer, whether this append applied would
    // depend on which ancestor won the ref.
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    writeTree(leaf, {
      "packages/core-utils/index.ts.append": "export const PATCHED = true;\n",
    });

    const dest = join(leaf, "build");
    await compile(resolveWith(leaf), { destDir: dest });

    expect(readText(dest, "packages/core-utils/index.ts")).toBe(
      "export const VERSION = 1;\nexport const PATCHED = true;\n",
    );
  });

  it("lets a layer above the mount tombstone a vendored file", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    writeTree(leaf, { "packages/legacy/index.ts.delete": "" });

    const dest = join(leaf, "build");
    await compile(resolveWith(leaf), { destDir: dest });

    expect(existsSync(join(dest, "packages/legacy/index.ts"))).toBe(false);
    expect(existsSync(join(dest, "packages/core-utils/index.ts"))).toBe(true);
  });

  it("marks the mount read-only and attributes its files to it", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);

    const graph = resolveWith(leaf);
    const mount = graph.layers.find((l) => l.mountPath === "packages");
    expect(mount).toBeDefined();
    expect(mount!.writable).toBe(false);
    // Substrate first: everything declared composes on top of it.
    expect(graph.layers.indexOf(mount!)).toBe(0);

    const why = await explain(graph, { values: {} });
    expect(why.layers.find((l) => l.mountPath === "packages")?.role).toBe("mount");
    expect(why.files["packages/core-utils/index.ts"]?.winner).toBe(mount!.id);
  });

  it("records the mount in the destination's lineage", async () => {
    const { repo, held } = packagesRemote();
    const leaf = lakeLayers(repo, held);
    const dest = join(leaf, "build");
    await compile(resolveWith(leaf), { destDir: dest });

    expect(readState(dest).lock.lineage).toContain("mount:packages");
  });
});

describe("acceptance — mount declarations that cannot mean anything are refused", () => {
  // These need no fetching: the paths are rejected before any ref is resolved,
  // so they run whether or not the fetch half has landed.
  const bad: Array<[string, string]> = [
    ["an absolute path", "/etc"],
    ["an escaping path", "../outside"],
    ["an empty path", ""],
  ];

  it.each(bad)("refuses %s", (_label, mountPath) => {
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf", mounts: { [mountPath]: "../vendor" } }),
    });
    writeTree(join(root, "vendor"), { "a.txt": "x\n" });
    expect(() => resolveWith(leaf)).toThrow(MountError);
  });

  it("refuses two mounts where one nests inside the other", () => {
    // `packages` and `packages/core` have no unambiguous owner: a file could
    // legitimately come from either tree, and precedence cannot say which.
    writeTree(join(root, "vendor"), { "a.txt": "x\n" });
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({
        name: "leaf",
        mounts: { packages: "../vendor", "packages/core": "../vendor" },
      }),
    });
    expect(() => resolveWith(leaf)).toThrow(MountError);
    expect(() => resolveWith(leaf)).toThrow(/nests inside/);
  });
});
