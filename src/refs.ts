/**
 * Layer reference syntax — SPEC §2 ("Referencing layers") and §3.
 *
 * A ref names where a layer's content comes from. Three origins, distinguished
 * purely by shape so nothing has to be declared twice:
 *
 * ```
 *   ../base                                local path (relative or absolute)
 *   file:./base                            local path, explicit
 *   git+https://host/o/r.git#v1.2.0        git at a commit-ish
 *   git+ssh://git@host/o/r.git#main        git over ssh
 *   git+file:///srv/repos/pkgs.git#v1      git with a local remote (offline/tests)
 *   github:acme/base#v2                    shorthand for git+https://github.com/acme/base.git
 *   @acme/base@^2                          npm package, resolved through node_modules
 *   npm:@acme/base@^2                      npm, explicit
 * ```
 *
 * Any non-local form may carry `?path=<subdir>` to use a subdirectory of the
 * fetched tree as the layer root — the monorepo-of-layers case (`?path=core/_layer`).
 *
 * Parsing is pure and total: it never touches the network or the filesystem.
 * {@link canonicalRef} is the single normalized string used as a lockfile key,
 * so two spellings of the same thing cannot occupy two lock entries.
 */

import { isAbsolute } from "node:path";

/** Where a layer's bytes come from. */
export type RefKind = "local" | "git" | "npm";

/** A ref that is fetched and pinned — everything except a local path. */
export type RemoteRefKind = Exclude<RefKind, "local">;

interface BaseRef {
  /** The ref exactly as written in the manifest. */
  raw: string;
}

/** A path on this machine; never locked, never cached. */
export interface LocalRef extends BaseRef {
  kind: "local";
  /** The path portion, with any `file:` scheme stripped. */
  path: string;
}

/** A git repository at a commit-ish (branch, tag, or full SHA). */
export interface GitRef extends BaseRef {
  kind: "git";
  /** Clone URL, scheme included, `git+` prefix stripped. */
  url: string;
  /** Branch / tag / SHA as written. Defaults to `HEAD`. */
  committish: string;
  /** Subdirectory of the repo that forms the layer root. */
  subdir?: string;
}

/** An npm package, resolved through the installed `node_modules` tree. */
export interface NpmRef extends BaseRef {
  kind: "npm";
  /** Package name, scope included. */
  name: string;
  /** Semver range as written. Defaults to `*`. */
  range: string;
  /** Subdirectory of the package that forms the layer root. */
  subdir?: string;
}

export type ParsedRef = LocalRef | GitRef | NpmRef;

/** Refs that are fetched, cached and pinned in `treelay.lock`. */
export type RemoteRef = GitRef | NpmRef;

/** Raised when a ref cannot be parsed at all. */
export class InvalidRefError extends Error {
  constructor(
    public readonly ref: string,
    reason: string,
  ) {
    super(`Invalid layer reference "${ref}": ${reason}`);
    this.name = "InvalidRefError";
  }
}

const GITHUB_SHORTHAND = /^github:([^/#?]+)\/([^/#?]+?)(?:\.git)?(?=[#?]|$)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** Split a trailing `?path=…` and `#committish` off a ref body. */
function splitSuffixes(rest: string): {
  body: string;
  subdir?: string;
  committish?: string;
} {
  let body = rest;
  let committish: string | undefined;
  let subdir: string | undefined;

  const hash = body.indexOf("#");
  if (hash !== -1) {
    committish = body.slice(hash + 1);
    body = body.slice(0, hash);
  }
  const q = body.indexOf("?");
  if (q !== -1) {
    const params = new URLSearchParams(body.slice(q + 1));
    const p = params.get("path");
    if (p) subdir = normalizeSubdir(p);
    body = body.slice(0, q);
  }
  return {
    body,
    ...(subdir !== undefined ? { subdir } : {}),
    ...(committish !== undefined && committish !== "" ? { committish } : {}),
  };
}

/** Normalize a `?path=` value: posix, no leading/trailing slash, no escapes. */
function normalizeSubdir(p: string): string {
  const clean = p.split("\\").join("/").replace(/^\/+|\/+$/g, "");
  if (clean.split("/").includes("..")) {
    throw new InvalidRefError(p, "`path=` may not escape the fetched tree with `..`");
  }
  return clean;
}

/** Is this ref a local path (the only kind that is never fetched)? */
export function isLocalRef(ref: string): boolean {
  return parseRef(ref).kind === "local";
}

/** Parse a layer reference. Pure: no network, no filesystem. */
export function parseRef(ref: string): ParsedRef {
  const raw = ref.trim();
  if (raw === "") throw new InvalidRefError(ref, "empty reference");

  if (raw.startsWith("file:")) {
    return { kind: "local", raw, path: raw.slice("file:".length) };
  }
  if (raw.startsWith(".") || isAbsolute(raw) || WINDOWS_DRIVE.test(raw)) {
    return { kind: "local", raw, path: raw };
  }

  const gh = GITHUB_SHORTHAND.exec(raw);
  if (gh) {
    const { subdir, committish } = splitSuffixes(raw.slice(gh[0].length));
    return git(raw, `https://github.com/${gh[1]}/${gh[2]}.git`, committish, subdir);
  }

  if (raw.startsWith("git+")) {
    const { body, subdir, committish } = splitSuffixes(raw.slice("git+".length));
    if (body === "") throw new InvalidRefError(ref, "git ref has no URL");
    return git(raw, body, committish, subdir);
  }

  // A bare URL is git only when it is unambiguously a repository.
  if (raw.includes("://")) {
    const { body, subdir, committish } = splitSuffixes(raw);
    if (body.endsWith(".git")) return git(raw, body, committish, subdir);
    throw new InvalidRefError(
      ref,
      "URLs must be prefixed with `git+` (or end in `.git`) so the transport is explicit",
    );
  }

  const npmBody = raw.startsWith("npm:") ? raw.slice("npm:".length) : raw;
  const { body, subdir } = splitSuffixes(npmBody);
  return npm(raw, body, subdir);
}

function git(
  raw: string,
  url: string,
  committish: string | undefined,
  subdir: string | undefined,
): GitRef {
  return {
    kind: "git",
    raw,
    url,
    committish: committish ?? "HEAD",
    ...(subdir !== undefined ? { subdir } : {}),
  };
}

function npm(raw: string, body: string, subdir: string | undefined): NpmRef {
  // Scoped names carry a leading `@`, so look for the version separator after it.
  const at = body.indexOf("@", body.startsWith("@") ? 1 : 0);
  const name = at === -1 ? body : body.slice(0, at);
  const range = at === -1 ? "*" : body.slice(at + 1);
  if (name === "") throw new InvalidRefError(raw, "npm ref has no package name");
  return {
    kind: "npm",
    raw,
    name,
    range: range === "" ? "*" : range,
    ...(subdir !== undefined ? { subdir } : {}),
  };
}

/**
 * The normalized spelling of a ref — the lockfile key.
 *
 * Two manifests writing `github:acme/base#v2` and
 * `git+https://github.com/acme/base.git#v2` mean the same layer and must share
 * one lock entry, so the key is derived from the parsed shape rather than the
 * text. Local refs canonicalize to themselves; they are never locked.
 */
export function canonicalRef(ref: ParsedRef | string): string {
  const parsed = typeof ref === "string" ? parseRef(ref) : ref;
  const query = parsed.kind !== "local" && parsed.subdir ? `?path=${parsed.subdir}` : "";
  switch (parsed.kind) {
    case "local":
      return parsed.raw;
    case "git":
      return `git+${parsed.url}${query}#${parsed.committish}`;
    case "npm":
      return `npm:${parsed.name}@${parsed.range}${query}`;
  }
}

/**
 * The immutable spelling of a ref once resolved — what the lock pins to.
 *
 * `git+…#main` resolves to `git+…#<sha>`; `npm:pkg@^2` to `npm:pkg@2.3.1`.
 * Recording this (alongside the requested form) is what lets drift detection
 * say precisely *what moved*.
 */
export function pinnedRef(ref: RemoteRef, revision: string): string {
  const query = ref.subdir ? `?path=${ref.subdir}` : "";
  return ref.kind === "git"
    ? `git+${ref.url}${query}#${revision}`
    : `npm:${ref.name}@${revision}${query}`;
}

/** A 40-hex git object name — already immutable, so nothing to re-resolve. */
export function isCommitSha(committish: string): boolean {
  return /^[0-9a-f]{40}$/i.test(committish);
}
