/**
 * The `treelay lock` command surface — modes and exit codes (SPEC §3, §9).
 *
 * `lock.test.ts` covers the lockfile itself: format, determinism, what compile
 * honours. This covers the *command*, whose contract is narrower and easy to
 * break by accident: which mode writes, which mode refuses to, and what exits
 * non-zero. A `--check` that quietly repaired the lock would still pass every
 * test in the other file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lockCommand, shortRev } from "../src/lock-command.js";
import { lockfilePath } from "../src/lockfile.js";
import { writeTree, manifest } from "./helpers/tree.js";
import { makeRepo, gitAvailable, type Repo } from "./helpers/git-fixture.js";
import { GIT_REFS, gitRef, resolveWith } from "./helpers/step9.js";

const LIVE = GIT_REFS && gitAvailable();

let root: string;
let priorCache: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-lockcmd-"));
  priorCache = process.env["TREELAY_CACHE_DIR"];
  process.env["TREELAY_CACHE_DIR"] = join(root, "cache");
});
afterEach(() => {
  if (priorCache === undefined) delete process.env["TREELAY_CACHE_DIR"];
  else process.env["TREELAY_CACHE_DIR"] = priorCache;
  rmSync(root, { recursive: true, force: true });
});

describe("lock command — local-only trees", () => {
  it("reports an up-to-date lock for a tree with nothing to pin", () => {
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf" }),
      "a.txt": "x\n",
    });

    const result = lockCommand(leaf, { check: true });

    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("up to date (0 pinned ref(s))");
    // Nothing to pin means nothing to write — a local-only tree should never
    // grow a lockfile it does not need.
    expect(existsSync(lockfilePath(leaf))).toBe(false);
  });

  it("pins nothing for local paths, which have no revision to pin", () => {
    writeTree(join(root, "base"), { "treelay.json": manifest({ name: "base" }) });
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf", parents: ["../base"] }),
    });

    const result = lockCommand(leaf);

    // An empty lockfile is permitted here (see lock.test.ts); what is not
    // permitted is an *entry* for a local path, which would claim a
    // reproducibility guarantee a working-copy path cannot keep.
    expect(result.refs).toEqual([]);
    if (existsSync(lockfilePath(leaf))) {
      expect(readFileSync(lockfilePath(leaf), "utf8")).toContain('"refs": {}');
    }
  });
});

describe("lock command — pinned refs", () => {
  const repo = (): { repo: Repo; first: string } => {
    const r = makeRepo(join(root, "remote"), { "a.txt": "one\n" });
    const first = r.head();
    return { repo: r, first };
  };

  const leafPinning = (ref: string): string =>
    writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf", parents: [ref] }),
    });

  it.skipIf(!LIVE)("writes the lock and lists what it pinned", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));

    const result = lockCommand(leaf);

    expect(result.wrote).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.refs).toHaveLength(1);
    expect(result.output.join("\n")).toContain(shortRev(first));
    expect(existsSync(lockfilePath(leaf))).toBe(true);
  });

  it.skipIf(!LIVE)("is a no-op the second time", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));
    lockCommand(leaf);

    const again = lockCommand(leaf);

    expect(again.wrote).toBe(false);
    expect(again.output.join("\n")).toContain("already current");
  });

  it.skipIf(!LIVE)("--check exits 1 on an unpinned ref and writes nothing", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));

    const result = lockCommand(leaf, { check: true });

    expect(result.exitCode).toBe(1);
    expect(result.errors.join("\n")).toContain("out of date");
    // The whole point of --check: it must not be able to fix what it checks.
    expect(existsSync(lockfilePath(leaf))).toBe(false);
  });

  it.skipIf(!LIVE)("--check does not list pins underneath a failure", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));

    const result = lockCommand(leaf, { check: true });

    // Printing the resolved pins after "out of date" reads like success.
    expect(result.output).toEqual([]);
  });

  it.skipIf(!LIVE)("--check passes once the lock is written", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));
    lockCommand(leaf);

    const result = lockCommand(leaf, { check: true });

    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("up to date (1 pinned ref(s))");
  });

  it.skipIf(!LIVE)("holds a branch pin steady until --update advances it", () => {
    const r = makeRepo(join(root, "remote"), { "a.txt": "one\n" });
    const leaf = leafPinning(gitRef(r, "main"));
    lockCommand(leaf);
    const pinned = readFileSync(lockfilePath(leaf), "utf8");

    r.commit({ "a.txt": "two\n" });

    // A plain run must not chase the branch...
    lockCommand(leaf);
    expect(readFileSync(lockfilePath(leaf), "utf8")).toBe(pinned);

    // ...and --update is the only thing that does.
    const updated = lockCommand(leaf, { update: true });
    expect(updated.wrote).toBe(true);
    expect(readFileSync(lockfilePath(leaf), "utf8")).not.toBe(pinned);
  });

  it.skipIf(!LIVE)("--drift exits 1 when an upstream has moved", () => {
    const r = makeRepo(join(root, "remote"), { "a.txt": "one\n" });
    const leaf = leafPinning(gitRef(r, "main"));
    lockCommand(leaf);

    r.commit({ "a.txt": "two\n" });
    const result = lockCommand(leaf, { drift: true });

    // Non-zero so a scheduled job notices, even though nothing is broken.
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toMatch(/moved/i);
  });

  it.skipIf(!LIVE)("--drift exits 0 when every pin matches", () => {
    const { repo: r, first } = repo();
    const leaf = leafPinning(gitRef(r, first));
    lockCommand(leaf);

    const result = lockCommand(leaf, { drift: true });

    expect(result.exitCode).toBe(0);
    expect(result.output.join("\n")).toContain("match their upstream");
  });
});

describe("lock command — cache concurrency", () => {
  it.skipIf(!LIVE)("two resolutions of one ref can run at once", async () => {
    const r = makeRepo(join(root, "remote"), { "a.txt": "shared\n" });
    const rev = r.head();
    const ref = gitRef(r, rev);

    const leaves = ["one", "two", "three", "four"].map((name) =>
      writeTree(join(root, name), {
        "treelay.json": manifest({ name, parents: [ref] }),
      }),
    );

    // Same ref, same cache directory, all in flight together — the case a
    // monorepo hits when several packages build in parallel. A half-written
    // checkout being handed to one of them would surface here.
    const graphs = await Promise.all(leaves.map(async (dir) => resolveWith(dir)));

    for (const graph of graphs) {
      const fetched = graph.layers.filter((l) => l.origin?.kind === "git");
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.origin?.revision).toBe(rev);
      expect(readFileSync(join(fetched[0]!.dir, "a.txt"), "utf8")).toBe("shared\n");
    }

    // One revision, one cache entry: concurrency must not duplicate it.
    const dirs = new Set(graphs.map((g) => g.layers.find((l) => l.origin?.kind === "git")!.dir));
    expect(dirs.size).toBe(1);
  });

  it.skipIf(!LIVE)("keeps two revisions of one remote apart under concurrency", async () => {
    const r = makeRepo(join(root, "remote"), { "a.txt": "one\n" });
    const older = r.head();
    r.commit({ "a.txt": "two\n" });
    const newer = r.head();

    const mk = (name: string, rev: string) =>
      writeTree(join(root, name), {
        "treelay.json": manifest({ name, parents: [gitRef(r, rev)] }),
      });

    const [a, b] = await Promise.all([
      Promise.resolve(resolveWith(mk("a", older))),
      Promise.resolve(resolveWith(mk("b", newer))),
    ]);

    const pick = (g: typeof a) => g.layers.find((l) => l.origin?.kind === "git")!;
    expect(readFileSync(join(pick(a).dir, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(pick(b).dir, "a.txt"), "utf8")).toBe("two\n");
    expect(pick(a).dir).not.toBe(pick(b).dir);
  });
});
