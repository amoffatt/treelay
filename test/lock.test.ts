/**
 * `treelay.lock` — pinning, determinism, drift and the fetch cache (SPEC §3).
 *
 * The lock exists so a composition that resolved once resolves the same way
 * forever: a manifest says `#main`, the lock says which commit `main` *was*.
 * Two halves are tested here, and they gate separately.
 *
 *  - **Format** — serialization, reading, version guarding. Live today.
 *  - **Behaviour through compile** — a moving branch does not change a build,
 *    drift is reported rather than acted on, and two pins of one remote
 *    coexist. Gated on the fetch probe (`test/helpers/step9.ts`) so the suite
 *    sits in the run before fetching lands and goes live, unedited, when it
 *    does.
 *
 * Every fetch-backed test runs against a `file://` remote in a temp directory
 * with `TREELAY_CACHE_DIR` redirected, so nothing here touches the network or
 * the developer's real cache.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyLock,
  lockfilePath,
  locksEqual,
  readLock,
  serializeLock,
  writeLock,
  LockfileError,
  LOCKFILE_VERSION,
  type LockEntry,
  type TreelayLock,
} from "../src/lockfile.js";
import { canonicalRef } from "../src/refs.js";
import { compile } from "../src/compile.js";
import { explain, explainDest } from "../src/explain.js";
import { checkDrift, formatDrift, hasDrift } from "../src/drift.js";
import { planUpdate, update } from "../src/update.js";
import { makeRepo, gitAvailable, withRemoteOffline, type Repo } from "./helpers/git-fixture.js";
import { writeTree, manifest, readText } from "./helpers/tree.js";
import {
  GIT_REFS,
  NPM_REFS,
  gitRef,
  npmRef,
  resolveWith,
  lockBytes,
  requireLockBytes,
} from "./helpers/step9.js";

const HAS_GIT = gitAvailable();
const LIVE = GIT_REFS && HAS_GIT;

let root: string;
let priorCache: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-lock-"));
  priorCache = process.env["TREELAY_CACHE_DIR"];
  process.env["TREELAY_CACHE_DIR"] = join(root, "cache");
});
afterEach(() => {
  if (priorCache === undefined) delete process.env["TREELAY_CACHE_DIR"];
  else process.env["TREELAY_CACHE_DIR"] = priorCache;
  rmSync(root, { recursive: true, force: true });
});

/** A lock entry with the boring fields filled in. */
function entry(over: Partial<LockEntry> = {}): LockEntry {
  return {
    kind: "git",
    source: "https://host/o/r.git",
    requested: "main",
    resolved: "a".repeat(40),
    integrity: "sha256:deadbeef",
    ...over,
  };
}

// --------------------------------------------------------------------------
// Format — live today
// --------------------------------------------------------------------------

describe("treelay.lock — deterministic serialization", () => {
  it("sorts refs, so insertion order cannot show up in a diff", () => {
    // Two developers adding the same two refs in opposite orders must produce
    // the same file, or the lock generates merge conflicts for no reason.
    const a: TreelayLock = {
      lockfileVersion: LOCKFILE_VERSION,
      refs: { "npm:z@1": entry({ kind: "npm" }), "npm:a@1": entry({ kind: "npm" }) },
    };
    const b: TreelayLock = {
      lockfileVersion: LOCKFILE_VERSION,
      refs: { "npm:a@1": entry({ kind: "npm" }), "npm:z@1": entry({ kind: "npm" }) },
    };
    expect(serializeLock(a)).toBe(serializeLock(b));
    expect(locksEqual(a, b)).toBe(true);
    expect(serializeLock(a).indexOf("npm:a@1")).toBeLessThan(
      serializeLock(a).indexOf("npm:z@1"),
    );
  });

  it("sorts requestedBy, which is otherwise graph-walk order", () => {
    const lock: TreelayLock = {
      lockfileVersion: LOCKFILE_VERSION,
      refs: { r: entry({ requestedBy: ["../state", "../core", "../edo"] }) },
    };
    expect(serializeLock(lock)).toContain('"../core"');
    const text = serializeLock(lock);
    expect(text.indexOf("../core")).toBeLessThan(text.indexOf("../edo"));
    expect(text.indexOf("../edo")).toBeLessThan(text.indexOf("../state"));
  });

  it("orders fields for a human reading an incident: asked, then got", () => {
    const text = serializeLock({
      lockfileVersion: LOCKFILE_VERSION,
      refs: { r: entry() },
    });
    expect(text.indexOf('"requested"')).toBeLessThan(text.indexOf('"resolved"'));
    expect(text.indexOf('"resolved"')).toBeLessThan(text.indexOf('"integrity"'));
  });

  it("emits stable JSON: two-space indent, trailing newline", () => {
    const text = serializeLock(emptyLock());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`{\n  "lockfileVersion": ${LOCKFILE_VERSION},\n  "refs": {}\n}\n`);
  });

  it("omits absent optional fields rather than writing nulls", () => {
    const text = serializeLock({ lockfileVersion: LOCKFILE_VERSION, refs: { r: entry() } });
    expect(text).not.toContain('"path"');
    expect(text).not.toContain('"requestedBy"');
    expect(text).not.toContain("null");
  });
});

describe("treelay.lock — reading and writing", () => {
  it("treats a missing lockfile as an empty one", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(readLock(leaf)).toEqual(emptyLock());
  });

  it("round-trips through disk unchanged", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    const lock: TreelayLock = {
      lockfileVersion: LOCKFILE_VERSION,
      refs: { "git+https://host/o/r.git#main": entry({ path: "core", requestedBy: ["."] }) },
    };
    expect(writeLock(leaf, lock)).toBe(true);
    expect(locksEqual(readLock(leaf), lock)).toBe(true);
  });

  it("does not rewrite an unchanged lockfile", () => {
    // A build that dirties the lock on every run makes `git status` useless and
    // teaches people to ignore it.
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    const lock: TreelayLock = { lockfileVersion: LOCKFILE_VERSION, refs: { r: entry() } };
    expect(writeLock(leaf, lock)).toBe(true);
    expect(writeLock(leaf, lock)).toBe(false);
  });

  it("fails loudly on a corrupt lockfile, naming the file", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    writeFileSync(lockfilePath(leaf), "{ not json");
    expect(() => readLock(leaf)).toThrow(LockfileError);
    expect(() => readLock(leaf)).toThrow(/treelay\.lock/);
  });

  it("refuses a lockfile from another treelay version, with a way out", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    writeFileSync(
      lockfilePath(leaf),
      JSON.stringify({ lockfileVersion: LOCKFILE_VERSION + 1, refs: {} }),
    );
    expect(() => readLock(leaf)).toThrow(LockfileError);
    expect(() => readLock(leaf)).toThrow(/treelay lock/);
  });

  it("refuses a lockfile that is not an object at all", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    writeFileSync(lockfilePath(leaf), "[]");
    expect(() => readLock(leaf)).toThrow(LockfileError);
  });
});

// --------------------------------------------------------------------------
// Behaviour through compile — gated on the fetch probe
// --------------------------------------------------------------------------

/** A remote whose `main` can be moved, plus the revision of its first state. */
function movingRemote(name = "remote"): { repo: Repo; v1: string } {
  const repo = makeRepo(join(root, name), {
    "treelay.json": manifest({ name }),
    "shared.txt": "v1\n",
  });
  return { repo, v1: repo.head() };
}

/** A leaf whose only parent is `repo` at `rev`. */
function leafOn(repo: Repo, rev: string, dir = "leaf"): string {
  return writeTree(join(root, dir), {
    "treelay.json": manifest({ name: "leaf", parents: [gitRef(repo, rev)] }),
    "leaf.txt": "leaf\n",
  });
}

describe.skipIf(!LIVE)("treelay.lock — pinning through compile", () => {
  it("writes a lock beside the leaf, pinning the branch to a commit", async () => {
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, "main");

    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    const lock = readLock(leaf);
    const key = canonicalRef(gitRef(repo, "main"));
    expect(lock.refs[key]).toMatchObject({
      kind: "git",
      requested: "main",
      resolved: v1,
    });
    expect(lock.refs[key]!.integrity).toMatch(/^sha256:/);
  });

  it("produces byte-identical locks for the same tree at two paths", async () => {
    // A lock is committed and shared between machines whose checkouts and
    // caches live in different places. An absolute path leaking into it turns
    // every teammate's build into a spurious diff.
    const { repo } = movingRemote();
    writeTree(join(root, "a", "base"), { "b.txt": "base\n" });
    writeTree(join(root, "a", "leaf"), {
      "treelay.json": manifest({
        name: "leaf",
        parents: ["../base", gitRef(repo, "main")],
      }),
    });
    cpSync(join(root, "a"), join(root, "b"), { recursive: true });

    await compile(resolveWith(join(root, "a", "leaf")), { destDir: join(root, "out-a") });
    await compile(resolveWith(join(root, "b", "leaf")), { destDir: join(root, "out-b") });

    expect(requireLockBytes(join(root, "a", "leaf")).toString()).toBe(
      requireLockBytes(join(root, "b", "leaf")).toString(),
    );
  });

  it("leaves the lock untouched when nothing changed", async () => {
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");

    await compile(resolveWith(leaf), { destDir: join(root, "out-1") });
    const first = requireLockBytes(leaf).toString();
    await compile(resolveWith(leaf), { destDir: join(root, "out-2") });

    expect(requireLockBytes(leaf).toString()).toBe(first);
  });

  it("does not lock local paths — they have no revision to pin", async () => {
    writeTree(join(root, "base"), { "b.txt": "base\n" });
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf", parents: ["../base"] }),
    });

    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    // Either no lockfile at all or an empty one is fine; a *pinned local path*
    // is not, since it would claim a reproducibility guarantee it cannot keep.
    const bytes = lockBytes(leaf);
    if (bytes) expect(readLock(leaf).refs).toEqual({});
  });
});

describe.skipIf(!LIVE)("treelay.lock — a moved branch does not change a build", () => {
  it("keeps composing the pinned revision after upstream advances", async () => {
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, "main");

    const destA = join(root, "out-a");
    await compile(resolveWith(leaf), { destDir: destA });
    expect(readText(destA, "shared.txt")).toBe("v1\n");

    repo.commit({ "shared.txt": "v2\n" });

    // A *fresh* destination, so nothing about this is the destination's memory
    // — it is the source-side lock alone holding the build steady.
    const destB = join(root, "out-b");
    await compile(resolveWith(leaf), { destDir: destB });
    expect(readText(destB, "shared.txt")).toBe("v1\n");
    expect(readLock(leaf).refs[canonicalRef(gitRef(repo, "main"))]!.resolved).toBe(v1);
  });

  it("picks up the new revision only when asked to advance", async () => {
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out-a") });

    const v2 = repo.commit({ "shared.txt": "v2\n" });

    const dest = join(root, "out-b");
    await compile(resolveWith(leaf, { updateRefs: true }), { destDir: dest });

    expect(readText(dest, "shared.txt")).toBe("v2\n");
    expect(readLock(leaf).refs[canonicalRef(gitRef(repo, "main"))]!.resolved).toBe(v2);
  });

  it("refuses an unlocked ref when resolution is frozen", async () => {
    // The CI posture: a ref nobody committed a pin for is a failure, not a
    // silent lock update that makes the build unreproducible after the fact.
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    expect(existsSync(lockfilePath(leaf))).toBe(false);

    expect(() => resolveWith(leaf, { frozen: true })).toThrow(/treelay\.lock|frozen/i);
  });
});

describe.skipIf(!LIVE)("treelay.lock — drift is reported, never acted on", () => {
  it("reports a moved branch with both revisions", async () => {
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    const v2 = repo.commit({ "shared.txt": "v2\n" });

    const reports = checkDrift(resolveWith(leaf), leaf);
    expect(hasDrift(reports)).toBe(true);
    const moved = reports.find((r) => r.status === "moved");
    expect(moved).toMatchObject({ requested: "main", locked: v1, current: v2 });

    const text = formatDrift(reports);
    expect(text).toContain(v1.slice(0, 12));
    expect(text).toContain(v2.slice(0, 12));
    expect(text).toContain("treelay lock --update");
  });

  it("says nothing when the pin is still current", async () => {
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    const reports = checkDrift(resolveWith(leaf), leaf);
    expect(hasDrift(reports)).toBe(false);
    expect(formatDrift(reports)).toBe("");
  });

  it("calls an exact SHA immutable rather than in-sync", async () => {
    // "In sync" implies a question was asked of the remote. A pinned commit
    // has no such question, and conflating the two hides a real network check
    // that silently did not happen.
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, v1);
    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    const reports = checkDrift(resolveWith(leaf), leaf);
    expect(reports.map((r) => r.status)).toContain("immutable");
  });

  it("reports unknown, not in-sync, when the remote cannot be reached", async () => {
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out") });

    const reports = await withRemoteOffline(repo, () => checkDrift(resolveWith(leaf), leaf));
    expect(reports.map((r) => r.status)).toContain("unknown");
    expect(hasDrift(reports)).toBe(false);
  });

  it("names the layers composed from a moved ref", async () => {
    const { repo } = movingRemote("packages");
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out") });
    repo.commit({ "shared.txt": "v2\n" });

    const moved = checkDrift(resolveWith(leaf), leaf).find((r) => r.status === "moved");
    expect(moved!.layers.join(" ")).toContain("packages");
  });
});

describe.skipIf(!LIVE)("drift reaches the surfaces people actually look at", () => {
  it("shows up in an update plan without moving the build", async () => {
    // `update` pulls *template* changes down; it is not a licence to change
    // which upstream revision the template was composed from. So the plan
    // reports the drift and merges the pinned content anyway.
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, "main");
    const dest = join(root, "out");
    await compile(resolveWith(leaf), { destDir: dest });

    const v2 = repo.commit({ "shared.txt": "v2\n" });

    const plan = await planUpdate(dest);
    expect(plan.drift.some((r) => r.status === "moved" && r.current === v2)).toBe(true);
    expect(readText(dest, "shared.txt")).toBe("v1\n");

    await update(dest);
    expect(readText(dest, "shared.txt")).toBe("v1\n");
    expect(readLock(leaf).refs[canonicalRef(gitRef(repo, "main"))]!.resolved).toBe(v1);
  });

  it("tells explain exactly which revision produced a file", async () => {
    // The other half of "surfaced": drift asks whether upstream moved, and
    // explain answers what *this* tree actually has — the question you ask
    // when a build behaves differently from a colleague's.
    const { repo, v1 } = movingRemote();
    const leaf = leafOn(repo, "main");

    const why = await explain(resolveWith(leaf), { values: {} });
    const fetched = why.layers.find((l) => l.ref?.startsWith("git+"));
    expect(fetched).toMatchObject({ revision: v1, writable: false });
  });
});

describe.skipIf(!LIVE)("fetch cache — content-addressed, so pins coexist", () => {
  it("materializes two revisions of one remote side by side", async () => {
    // The cache is keyed by *what the content is*, not by who asked. Keyed by
    // repo alone, the second pin would clobber the first's checkout and one of
    // these two files would vanish.
    const repo = makeRepo(join(root, "remote"), { "only-v1.txt": "first\n" });
    const v1 = repo.head();
    repo.commit({ "only-v1.txt": null, "only-v2.txt": "second\n" });
    const v2 = repo.head();

    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({
        name: "leaf",
        parents: [gitRef(repo, v1), gitRef(repo, v2)],
      }),
    });

    const dest = join(root, "out");
    await compile(resolveWith(leaf), { destDir: dest });

    expect(readText(dest, "only-v1.txt")).toBe("first\n");
    expect(readText(dest, "only-v2.txt")).toBe("second\n");

    const lock = readLock(leaf);
    expect(Object.keys(lock.refs)).toHaveLength(2);
  });

  it("serves a rebuild from cache with the remote gone", async () => {
    // Not a performance claim — the point is that a pinned build does not need
    // the network at all, which is what makes the lock a reproducibility
    // guarantee rather than a hint.
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out-a") });

    const dest = join(root, "out-b");
    await withRemoteOffline(repo, () =>
      compile(resolveWith(leaf), { destDir: dest }),
    );
    expect(readText(dest, "shared.txt")).toBe("v1\n");
  });

  it("keeps fetched layers out of the promotion path — they are read-only", () => {
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");

    const graph = resolveWith(leaf);
    const fetched = graph.layers.filter((l) => l.origin?.kind === "git");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.writable).toBe(false);
  });

  it("refuses a cache entry that no longer matches the recorded integrity", async () => {
    // The lock's integrity hash is the only thing standing between a pinned,
    // "reproducible" build and a cache someone edited in place.
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    await compile(resolveWith(leaf), { destDir: join(root, "out-a") });

    const cached = resolveWith(leaf).layers.find((l) => l.origin?.kind === "git")!;
    writeFileSync(join(cached.dir, "shared.txt"), "tampered\n");

    expect(() => resolveWith(leaf)).toThrow(/integrity|cache/i);
  });

  it("identifies a fetched layer by its canonical ref, not its cache path", async () => {
    // Cache paths differ per machine; provenance recorded in a destination has
    // to mean the same thing everywhere it is read.
    const { repo } = movingRemote();
    const leaf = leafOn(repo, "main");
    const dest = join(root, "out");
    await compile(resolveWith(leaf), { destDir: dest });

    const why = await explainDest(dest);
    const ids = why.layers.map((l) => l.id);
    expect(ids.some((id) => id.startsWith("git+"))).toBe(true);
    expect(ids.some((id) => id.includes("cache"))).toBe(false);
  });
});

describe.skipIf(!NPM_REFS)("treelay.lock — npm layers", () => {
  it("pins the exact installed version behind a semver range", async () => {
    // A range is a question, not an answer. What the lock has to record is the
    // version that actually composed, so a teammate whose node_modules resolved
    // differently sees a diff instead of a mystery.
    writeTree(join(root, "leaf", "node_modules", "@acme/base"), {
      "package.json": manifest({ name: "@acme/base", version: "2.3.1", treelay: {} }),
      "a.txt": "packaged\n",
    });
    const leaf = writeTree(join(root, "leaf"), {
      "treelay.json": manifest({ name: "leaf", parents: [npmRef("@acme/base", "^2")] }),
    });

    const dest = join(root, "out");
    await compile(resolveWith(leaf), { destDir: dest });

    expect(readText(dest, "a.txt")).toBe("packaged\n");
    const entries = Object.values(readLock(leaf).refs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "npm",
      source: "@acme/base",
      requested: "^2",
      resolved: "2.3.1",
    });
  });
});
