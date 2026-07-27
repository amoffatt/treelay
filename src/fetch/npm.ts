/**
 * npm-backed layers (SPEC §3).
 *
 * An overlay *is* a normal npm package (§2), so treelay resolves npm refs the
 * way any Node program resolves a dependency: through the installed
 * `node_modules` tree, starting at the layer that declared the ref.
 *
 * **treelay deliberately does not install anything.** Package installation is
 * already owned by a tool with a lockfile, an integrity model, a registry
 * configuration and an offline cache; shipping a second, worse copy of that
 * inside a composition engine would mean two lockfiles disagreeing about the
 * same tree. treelay's job is to record *which* version composition consumed,
 * and to fail clearly when the package is not installed at all.
 *
 * The consequence worth naming: an npm layer's exact version is whatever the
 * package manager put on disk. `treelay.lock` pins what was used and
 * {@link liveNpmVersion} reports when the installed tree has since moved, but
 * reproducing an old pin is `npm ci`'s job, not treelay's.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { satisfies, validRange } from "semver";

import { hashTree } from "../hash.js";
import type { NpmRef } from "../refs.js";

/** Raised when an npm layer cannot be resolved from the installed tree. */
export class NpmResolveError extends Error {
  constructor(
    public readonly packageName: string,
    message: string,
  ) {
    super(`npm layer ${packageName}: ${message}`);
    this.name = "NpmResolveError";
  }
}

/**
 * Locate an installed package's root directory, searching up from `fromDir`.
 *
 * Node's own resolver is only the *fallback* here, because it returns the
 * realpath of what it finds. Layer directories are compared as strings all over
 * treelay — nested-destination pruning (§7), promotion targets (§8) — and a
 * resolver that silently canonicalizes symlinks would hand back a path in a
 * different shape from every local layer beside it. Walking `node_modules`
 * ourselves keeps the path in the caller's frame of reference, and as a bonus
 * sidesteps packages whose `exports` map hides `./package.json`.
 */
function packageDir(ref: NpmRef, fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ref.name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) break;
  }

  // Not in any plain node_modules — defer to Node (workspaces, PnP shims).
  try {
    const require = createRequire(join(fromDir, "package.json"));
    return dirname(require.resolve(`${ref.name}/package.json`));
  } catch {
    throw new NpmResolveError(
      ref.name,
      `not installed under ${fromDir}. treelay resolves npm layers from ` +
        `node_modules rather than installing them — run your package manager ` +
        `first (e.g. \`npm install ${ref.name}\`).`,
    );
  }
}

/** The version currently installed for an npm ref, or undefined if absent. */
export function liveNpmVersion(ref: NpmRef, fromDir: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageDir(ref, fromDir), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve and materialize an npm layer.
 *
 * "Materialize" is a no-op copy here — the installed package already *is* the
 * tree, and duplicating it into the cache would only create a second thing to
 * keep in sync. The integrity hash is taken over the installed content, so a
 * reinstall that changes the bytes still shows up as drift.
 */
export function materializeNpm(
  ref: NpmRef,
  fromDir: string,
): { dir: string; revision: string; integrity: string } {
  const pkgRoot = packageDir(ref, fromDir);
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  const version = pkg.version ?? "0.0.0";

  if (ref.range !== "*" && validRange(ref.range) && !satisfies(version, ref.range)) {
    throw new NpmResolveError(
      ref.name,
      `installed version ${version} does not satisfy "${ref.range}". ` +
        `Update the dependency, or relax the ref in treelay.json.`,
    );
  }

  const root = ref.subdir ? join(pkgRoot, ref.subdir) : pkgRoot;
  if (!existsSync(root)) {
    throw new NpmResolveError(
      ref.name,
      `subdirectory "${ref.subdir}" does not exist in ${pkgRoot}`,
    );
  }
  return { dir: root, revision: version, integrity: hashTree(root) };
}
