/**
 * Layer reference syntax — SPEC §2 ("Referencing layers") and §3.
 *
 * Three origins distinguished purely by shape: a local path, a git repo at a
 * commit-ish, an npm package. This suite pins the grammar (including the
 * canonical spelling two equivalent refs must share, since that is the
 * lockfile key), and pins that anything unparseable **fails loudly** rather
 * than being silently treated as one of the three.
 *
 * Parsing is live today. Actually *fetching* a remote ref is step 9's second
 * half, so those tests gate on {@link GIT_REFS}/{@link NPM_REFS} and go live
 * on their own — see `test/helpers/step9.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { parseRef, canonicalRef, pinnedRef, isLocalRef, isCommitSha, InvalidRefError } from "../src/refs.js";
import type { GitRef, NpmRef } from "../src/refs.js";
import { resolveRef } from "../src/resolve.js";
import { makeRepo, gitAvailable } from "./helpers/git-fixture.js";
import { writeTree, manifest, readText } from "./helpers/tree.js";
import {
  GIT_REFS,
  NPM_REFS,
  gitRef,
  npmRef,
  assertShimsMatchGrammar,
} from "./helpers/step9.js";

const HAS_GIT = gitAvailable();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-refs-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Parse and assert the kind, so the cast below is checked rather than assumed. */
function asGit(ref: string): GitRef {
  const parsed = parseRef(ref);
  expect(parsed.kind).toBe("git");
  return parsed as GitRef;
}
function asNpm(ref: string): NpmRef {
  const parsed = parseRef(ref);
  expect(parsed.kind).toBe("npm");
  return parsed as NpmRef;
}

describe("ref parsing — local paths", () => {
  it("recognizes relative, absolute and explicit `file:` paths", () => {
    expect(parseRef("../base")).toMatchObject({ kind: "local", path: "../base" });
    expect(parseRef("./base")).toMatchObject({ kind: "local", path: "./base" });
    expect(parseRef("/srv/layers/base")).toMatchObject({
      kind: "local",
      path: "/srv/layers/base",
    });
    expect(parseRef("file:./base")).toMatchObject({ kind: "local", path: "./base" });
  });

  it("recognizes a Windows drive path as local, not as a package name", () => {
    // `C:\layers\base` has neither a leading dot nor a POSIX root, so without
    // an explicit rule it would fall through to the npm branch and be
    // "resolved" as a package called `C:\layers\base`.
    expect(parseRef("C:\\layers\\base").kind).toBe("local");
  });

  it("keeps the raw spelling for round-tripping", () => {
    expect(parseRef("../base").raw).toBe("../base");
    expect(canonicalRef("../base")).toBe("../base");
  });

  it("agrees with isLocalRef", () => {
    expect(isLocalRef("../base")).toBe(true);
    expect(isLocalRef("@acme/base")).toBe(false);
    expect(isLocalRef("github:acme/base#v1")).toBe(false);
  });
});

describe("ref parsing — git", () => {
  it("expands the github: shorthand to an https clone URL", () => {
    const ref = asGit("github:acme/base#v2");
    expect(ref.url).toBe("https://github.com/acme/base.git");
    expect(ref.committish).toBe("v2");
  });

  it("does not double-suffix a github: shorthand already ending in .git", () => {
    expect(asGit("github:acme/base.git#v2").url).toBe("https://github.com/acme/base.git");
  });

  it("defaults a missing committish to HEAD", () => {
    expect(asGit("github:acme/base").committish).toBe("HEAD");
    expect(asGit("git+https://host/o/r.git").committish).toBe("HEAD");
  });

  it("accepts explicit transports: https, ssh and file", () => {
    expect(asGit("git+https://host/o/r.git#main").url).toBe("https://host/o/r.git");
    expect(asGit("git+ssh://git@host/o/r.git#main").url).toBe("ssh://git@host/o/r.git");
    expect(asGit("git+file:///srv/repos/pkgs.git#v1").url).toBe(
      "file:///srv/repos/pkgs.git",
    );
  });

  it("accepts a bare URL only when it unambiguously names a repository", () => {
    expect(asGit("https://host/o/r.git#v1").url).toBe("https://host/o/r.git");
    // Without `.git` or a `git+` prefix the transport is a guess — and guessing
    // wrong means a network fetch nobody asked for.
    expect(() => parseRef("https://host/o/r#v1")).toThrow(InvalidRefError);
  });

  it("carries ?path= as the subdirectory forming the layer root", () => {
    // The monorepo-of-layers case: one repo, many layers inside it.
    const ref = asGit("git+https://host/o/r.git?path=core/_layer#v1");
    expect(ref.subdir).toBe("core/_layer");
    expect(ref.committish).toBe("v1");
  });

  it("recognizes a full SHA as already-immutable", () => {
    const sha = "0".repeat(40);
    expect(isCommitSha(sha)).toBe(true);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("v1.2.0")).toBe(false);
    expect(asGit(`git+https://host/o/r.git#${sha}`).committish).toBe(sha);
  });
});

describe("ref parsing — npm", () => {
  it("splits a scoped name from its range without eating the scope's @", () => {
    expect(asNpm("@acme/base@^2")).toMatchObject({ name: "@acme/base", range: "^2" });
    expect(asNpm("@acme/base")).toMatchObject({ name: "@acme/base", range: "*" });
  });

  it("handles unscoped names and exact versions", () => {
    expect(asNpm("base")).toMatchObject({ name: "base", range: "*" });
    expect(asNpm("base@1.2.3")).toMatchObject({ name: "base", range: "1.2.3" });
  });

  it("accepts the explicit npm: prefix", () => {
    expect(asNpm("npm:@acme/base@^2")).toMatchObject({ name: "@acme/base", range: "^2" });
  });

  it("carries ?path= for a layer inside a package", () => {
    expect(asNpm("@acme/layers@^1?path=node-base").subdir).toBe("node-base");
  });
});

describe("ref parsing — malformed refs fail loudly", () => {
  const bad: Array<[string, RegExp]> = [
    ["", /empty/i],
    ["   ", /empty/i],
    ["git+", /no URL/i],
    ["git+#main", /no URL/i],
    ["npm:", /no package name/i],
    ["npm:@acme/base?path=../escape", /\.\./],
    ["https://host/o/r#v1", /git\+/],
  ];

  it.each(bad)("rejects %j", (ref, reason) => {
    expect(() => parseRef(ref)).toThrow(InvalidRefError);
    expect(() => parseRef(ref)).toThrow(reason);
  });

  it("quotes the offending ref so the error is actionable", () => {
    // A manifest can hold a dozen refs; an error that does not say which one
    // it choked on sends the reader hunting.
    try {
      parseRef("npm:");
      expect.unreachable("expected parseRef to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRefError);
      expect((err as InvalidRefError).ref).toBe("npm:");
      expect((err as Error).message).toContain('"npm:"');
    }
  });

  it("is pure — parsing touches neither the network nor the disk", () => {
    // Nothing here exists. Parsing must still succeed: fetching is a separate
    // step, and `explain`/`plan` parse refs without ever wanting the bytes.
    expect(() => parseRef("git+https://nonexistent.invalid/o/r.git#main")).not.toThrow();
    expect(() => parseRef("../does/not/exist")).not.toThrow();
    expect(() => parseRef("@no/such-package@^9")).not.toThrow();
  });
});

describe("canonicalRef — one spelling per lock entry", () => {
  it("collapses the github: shorthand onto its expanded form", () => {
    // Two manifests writing the same layer two ways must share one lock entry,
    // or the same content gets fetched and pinned twice under two keys.
    expect(canonicalRef("github:acme/base#v2")).toBe(
      canonicalRef("git+https://github.com/acme/base.git#v2"),
    );
  });

  it("collapses bare and npm:-prefixed package specs", () => {
    expect(canonicalRef("@acme/base@^2")).toBe(canonicalRef("npm:@acme/base@^2"));
  });

  it("keeps distinct revisions and subdirs distinct", () => {
    expect(canonicalRef("github:acme/base#v1")).not.toBe(canonicalRef("github:acme/base#v2"));
    expect(canonicalRef("github:acme/base?path=a#v1")).not.toBe(
      canonicalRef("github:acme/base?path=b#v1"),
    );
  });

  it("is idempotent — canonicalizing a canonical ref is a no-op", () => {
    for (const ref of [
      "github:acme/base#v2",
      "@acme/base@^2",
      "git+ssh://git@host/o/r.git?path=core#main",
    ]) {
      const once = canonicalRef(ref);
      expect(canonicalRef(once)).toBe(once);
    }
  });
});

describe("pinnedRef — the immutable spelling the lock records", () => {
  it("replaces a git committish with the resolved SHA", () => {
    const sha = "a".repeat(40);
    const pinned = pinnedRef(asGit("git+https://host/o/r.git#main"), sha);
    expect(pinned).toBe(`git+https://host/o/r.git#${sha}`);
    expect(asGit(pinned).committish).toBe(sha);
    expect(isCommitSha(asGit(pinned).committish)).toBe(true);
  });

  it("replaces an npm range with the exact version", () => {
    const pinned = pinnedRef(asNpm("@acme/base@^2"), "2.3.1");
    expect(pinned).toBe("npm:@acme/base@2.3.1");
    expect(asNpm(pinned).range).toBe("2.3.1");
  });

  it("preserves the subdirectory through pinning", () => {
    // Losing `?path=` here would silently re-root the layer at the repo top on
    // the next resolve — a whole different tree, from a ref that looks pinned.
    const pinned = pinnedRef(asGit("git+https://host/o/r.git?path=core#main"), "b".repeat(40));
    expect(asGit(pinned).subdir).toBe("core");
  });
});

describe("resolveRef — local paths", () => {
  it("resolves relative to the referring layer, not the process cwd", () => {
    writeTree(join(root, "base"), { "a.txt": "base\n" });
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(resolveRef("../base", leaf)).toBe(resolvePath(root, "base"));
  });

  it("fails loudly, naming the ref, when the directory is missing", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(() => resolveRef("../nope", leaf)).toThrow(/\.\.\/nope/);
  });

  it("fails loudly when the ref points at a file rather than a directory", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    writeFileSync(join(root, "notadir"), "x");
    expect(() => resolveRef("../notadir", leaf)).toThrow(/notadir/);
  });

  it("keeps the test shims aligned with the parser's grammar", () => {
    assertShimsMatchGrammar();
  });
});

describe.skipIf(!GIT_REFS || !HAS_GIT)("resolveRef — git", () => {
  it("materializes the layer at the requested committish", async () => {
    const repo = makeRepo(join(root, "remote"), { "a.txt": "v1\n" });
    repo.tag("v1");
    repo.commit({ "a.txt": "v2\n" });

    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    const atTag = resolveRef(gitRef(repo, "v1"), leaf);
    const atMain = resolveRef(gitRef(repo, "main"), leaf);

    expect(readText(atTag, "a.txt")).toBe("v1\n");
    expect(readText(atMain, "a.txt")).toBe("v2\n");
  });

  it("re-roots the layer at ?path= inside the repo", () => {
    const repo = makeRepo(join(root, "remote"), {
      "core/_layer/a.txt": "inner\n",
      "README.md": "outer\n",
    });
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });

    const dir = resolveRef(gitRef(repo, "main", "core/_layer"), leaf);
    expect(readText(dir, "a.txt")).toBe("inner\n");
  });

  it("fails loudly when the committish does not exist", () => {
    const repo = makeRepo(join(root, "remote"), { "a.txt": "v1\n" });
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(() => resolveRef(gitRef(repo, "no-such-tag"), leaf)).toThrow(/no-such-tag/);
  });
});

describe.skipIf(!NPM_REFS)("resolveRef — npm", () => {
  /** An installed package, as npm would have left it. */
  function installed(name: string, version: string, files: Record<string, string> = {}) {
    return writeTree(join(root, "leaf", "node_modules", name), {
      "package.json": manifest({ name, version, treelay: {} }),
      ...files,
    });
  }

  it("resolves a bare specifier through node_modules", () => {
    const pkg = installed("@acme/base", "2.3.1", { "a.txt": "packaged\n" });
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(resolveRef(npmRef("@acme/base"), leaf)).toBe(pkg);
  });

  it("accepts an installed version that satisfies the requested range", () => {
    installed("@acme/base", "2.3.1");
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(() => resolveRef(npmRef("@acme/base", "^2"), leaf)).not.toThrow();
  });

  it("fails loudly when the installed version does not satisfy the range", () => {
    // Composing the wrong major silently is exactly the class of bug the lock
    // exists to prevent; a mismatch has to be an error, not a shrug.
    installed("@acme/base", "1.0.0");
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(() => resolveRef(npmRef("@acme/base", "^2"), leaf)).toThrow(/@acme\/base/);
  });

  it("fails loudly when the package is not installed at all", () => {
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    expect(() => resolveRef(npmRef("@acme/missing"), leaf)).toThrow(/@acme\/missing/);
  });

  it("re-roots the layer at ?path= inside the package", () => {
    installed("@acme/layers", "1.0.0", { "node-base/a.txt": "inner\n" });
    const leaf = writeTree(join(root, "leaf"), { "treelay.json": manifest({}) });
    const dir = resolveRef("@acme/layers@^1?path=node-base", leaf);
    expect(readText(dir, "a.txt")).toBe("inner\n");
  });
});
