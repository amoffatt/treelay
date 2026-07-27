/**
 * Self-tests for the local-git harness.
 *
 * The step-9 suites use this harness to make claims about *which revision*
 * treelay resolved. Those claims are only worth as much as the fixture, so the
 * fixture gets its own tests: refs really move, tags really pin, two revisions
 * of one remote really coexist, and none of it touches the network or the
 * developer's git config.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeRepo,
  cloneAt,
  gitAvailable,
  withRemoteOffline,
} from "./helpers/git-fixture.js";

const HAS_GIT = gitAvailable();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-gitfix-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

describe.skipIf(!HAS_GIT)("git fixture harness", () => {
  it("records real, distinct commits", () => {
    const repo = makeRepo(join(root, "remote"), { "a.txt": "one\n" });
    const first = repo.head();
    const second = repo.commit({ "a.txt": "two\n" });

    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
    expect(repo.head()).toBe(second);
    expect(repo.head(`${second}^`)).toBe(first);
  });

  it("pins a tag while the branch it was cut from moves on", () => {
    const repo = makeRepo(join(root, "remote"), { "v.txt": "v1\n" });
    repo.tag("v1");
    repo.commit({ "v.txt": "v2\n" });

    cloneAt(repo.url, join(root, "at-tag"), "v1");
    cloneAt(repo.url, join(root, "at-main"), "main");

    expect(read(join(root, "at-tag"), "v.txt")).toBe("v1\n");
    expect(read(join(root, "at-main"), "v.txt")).toBe("v2\n");
  });

  it("lets two revisions of one remote coexist as separate checkouts", () => {
    // The shape behind the cache-correctness requirement: one remote, two
    // pins, both live at once. Distinct filenames per revision make it
    // impossible for one checkout to masquerade as the other.
    const repo = makeRepo(join(root, "remote"), { "only-v1.txt": "first\n" });
    const v1 = repo.head();
    repo.commit({ "only-v1.txt": null, "only-v2.txt": "second\n" });
    const v2 = repo.head();

    const a = join(root, "co-a");
    const b = join(root, "co-b");
    cloneAt(repo.url, a, v1);
    cloneAt(repo.url, b, v2);

    expect(existsSync(join(a, "only-v1.txt"))).toBe(true);
    expect(existsSync(join(a, "only-v2.txt"))).toBe(false);
    expect(existsSync(join(b, "only-v1.txt"))).toBe(false);
    expect(read(b, "only-v2.txt")).toBe("second\n");
  });

  it("produces a gitlink FILE, not a directory, for a submodule checkout", () => {
    // The klamath shape (an npm-packages submodule vendored into the tree)
    // and the reason SPEC §4 excludes `.git` in both forms. Asserted here so
    // the robustness suite's hand-written gitlink fixture stays faithful to
    // what git actually writes.
    const child = makeRepo(join(root, "child"), { "pkg.txt": "vendored\n" });
    const parent = makeRepo(join(root, "parent"), { "root.txt": "top\n" });
    parent.addSubmodule(child, "vendor/pkg");

    const gitlink = join(parent.dir, "vendor/pkg/.git");
    expect(statSync(gitlink).isFile()).toBe(true);
    expect(readFileSync(gitlink, "utf8")).toContain("gitdir:");
    expect(read(parent.dir, "vendor/pkg/pkg.txt")).toBe("vendored\n");
  });

  it("is hermetic: identical history yields an identical SHA", () => {
    // If the host's `~/.gitconfig` or the wall clock leaked in, these two
    // would diverge — and every "which revision did we get" assertion in the
    // step-9 suites would be resting on sand.
    const a = makeRepo(join(root, "a"), { "x.txt": "same\n" });
    const b = makeRepo(join(root, "b"), { "x.txt": "same\n" });
    expect(a.head()).toBe(b.head());
  });

  it("can take a remote offline and put it back", async () => {
    const repo = makeRepo(join(root, "remote"), { "a.txt": "one\n" });

    await withRemoteOffline(repo, () => {
      expect(() => cloneAt(repo.url, join(root, "nope"), "main")).toThrow();
    });

    cloneAt(repo.url, join(root, "yes"), "main");
    expect(read(join(root, "yes"), "a.txt")).toBe("one\n");
  });
});
