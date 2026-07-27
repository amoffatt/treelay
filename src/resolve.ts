/**
 * Resolve a leaf overlay directory into an ordered, linearized layer stack
 * plus the merged variable schema — SPEC §3, §6.
 *
 * Precedence, lowest → highest: parents (C3-linearized) < mixins < self.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import { c3Linearize } from "./c3.js";
import { loadManifest, isWritable } from "./manifest.js";
import { mergeVariableDecls } from "./variables.js";
import { NotImplementedError } from "./errors.js";
import { readLock } from "./lockfile.js";
import type { Layer, LayerRef, ResolvedGraph } from "./types.js";

/** Resolve a leaf directory into its full composition. */
export function resolve(srcDir: string): ResolvedGraph {
  const root = isAbsolute(srcDir) ? srcDir : resolvePath(process.cwd(), srcDir);
  const cache = new Map<string, Layer>();

  const load = (dir: string): Layer => {
    const id = dir;
    const cached = cache.get(id);
    if (cached) return cached;
    const layer: Layer = {
      id,
      dir,
      manifest: loadManifest(dir),
      writable: isWritable(dir),
    };
    cache.set(id, layer);
    return layer;
  };

  const self = load(root);

  // C3 over the parents graph. parentsOf reads each layer's declared parents,
  // resolving refs to absolute layer dirs as it goes.
  const parentsOf = (layer: Layer): Layer[] =>
    (layer.manifest.parents ?? []).map((ref) => load(resolveRef(ref, layer.dir)));

  const mro = c3Linearize(self, parentsOf, (l) => l.id); // [self, ...ancestorsHighToLow]
  const parentsLowToHigh = mro.slice(1).reverse();

  // Mixins sit strictly above all parents, in declaration order (last = highest).
  // NOTE: a mixin's own parents are not yet flattened into the stack — TODO once
  // nested-mixin composition is specced out.
  const mixins = (self.manifest.mixins ?? []).map((ref) =>
    load(resolveRef(ref, self.dir)),
  );

  const layers = [...parentsLowToHigh, ...mixins, self];
  const variables = mergeVariableDecls(layers);

  return { layers, variables, lock: readLock(root), lockDirty: false, lockDir: root };
}

/**
 * Resolve a layer reference to an absolute directory.
 * Local paths are fully supported; npm/git resolution is pending (§2).
 */
export function resolveRef(ref: LayerRef, fromDir: string): string {
  if (ref.startsWith(".") || isAbsolute(ref)) {
    const dir = resolvePath(fromDir, ref);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`Layer not found: "${ref}" (resolved to ${dir})`);
    }
    return dir;
  }
  if (ref.startsWith("github:") || ref.includes("#")) {
    throw new NotImplementedError(`git layer resolution for "${ref}"`);
  }
  // Bare specifier ⇒ npm package (resolved through node_modules).
  throw new NotImplementedError(`npm layer resolution for "${ref}"`);
}
