/**
 * Layer file enumeration & classification — the shared walk beneath both
 * `compile` (§6/§7) and `explain` (§9).
 *
 * Everything that decides *which* files in a layer participate in composition,
 * and *what kind* of contribution each one makes, lives here. Compile turns
 * those entries into bytes; explain turns them into provenance. Keeping the
 * walk in one place is what stops the two from disagreeing about what a layer
 * contains.
 */

import { relative, resolve as resolvePath } from "node:path";
import fg from "fast-glob";

import { isSidecar, sidecarTarget, desugarSuffix } from "./sidecar.js";
import { templateTarget, DEFAULT_TEMPLATE_SUFFIX } from "./render.js";
import type { Layer, SidecarOpKind } from "./types.js";

/**
 * Globs never materialized into the output.
 *
 * `.git` is excluded in **both** forms deliberately (§4, "built-in tombstone"):
 * `**\/.git/**` covers a normal repository directory's contents, while
 * `**\/.git` covers the *gitlink file* that a git **submodule** checkout carries
 * in place of a directory. A layer vendored as a submodule would otherwise
 * publish its gitlink into every compiled tree, producing output that git reads
 * as a broken submodule. `.gitignore`/`.gitmodules` are ordinary files and are
 * intentionally **not** matched by the exact-name `.git` glob.
 */
export const ALWAYS_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.git",
  ".treelay/**",
  "**/.treelay/**",
  "**/treelay.json",
  "**/treelay.yaml",
  "**/treelay.yml",
];

/** What sort of contribution a source file in a layer makes. */
export type EntryKind = "file" | "sidecar" | "suffix";

/** One classified source file within a layer. */
export interface LayerEntry {
  /** Path of the source file relative to the layer dir. */
  source: string;
  /** The path after stripping the template suffix (may still carry an op suffix). */
  inner: string;
  /** True when the source carried the template suffix (content renders, §6). */
  isTemplate: boolean;
  kind: EntryKind;
  /** For sidecar/suffix entries, the operation being performed. */
  op?: SidecarOpKind;
  /**
   * The output path this entry targets, *before* Liquid path rendering.
   * For ops this is the inherited file the op applies to.
   */
  rawTarget: string;
}

/**
 * Raised when a destination directory is a layer root itself — compiling a
 * layer on top of itself is degenerate, not merely awkward, so it fails loud
 * rather than half-consuming its own output.
 */
export class SelfCompileError extends Error {
  constructor(dir: string) {
    super(
      `Destination is a layer root: ${dir}\n` +
        `Compiling a layer into itself would overwrite the sources being read. ` +
        `Choose a destination outside the layer, or a subdirectory of it (e.g. ${dir}/build).`,
    );
    this.name = "SelfCompileError";
  }
}

/**
 * Extra ignore globs so a destination nested *inside* a layer never feeds its
 * own prior output back into the composition (§7).
 *
 * The autom-lake shape — compiling into a gitignored `build/` inside the source
 * repo — is explicitly supported: a destination that is a strict descendant of
 * a layer is pruned from that layer's walk. A destination that *is* the layer
 * root is rejected via {@link SelfCompileError}.
 */
export function destExclusions(layerDir: string, destDir?: string): string[] {
  if (!destDir) return [];
  const layerAbs = resolvePath(layerDir);
  const destAbs = resolvePath(destDir);
  if (destAbs === layerAbs) throw new SelfCompileError(layerAbs);

  const rel = relative(layerAbs, destAbs);
  // Outside the layer (or on another drive) ⇒ nothing to prune.
  if (rel === "" || rel.startsWith("..") || resolvePath(layerAbs, rel) !== destAbs) {
    return [];
  }
  const posix = rel.split("\\").join("/");
  return [posix, `${posix}/**`];
}

/** List the composable source files of a layer, lowest-level primitive. */
export function listLayerFiles(layer: Layer, destDir?: string): string[] {
  return fg
    .sync("**/*", {
      cwd: layer.dir,
      dot: true,
      onlyFiles: true,
      ignore: [
        ...ALWAYS_IGNORE,
        ...(layer.manifest.ignore ?? []),
        ...destExclusions(layer.dir, destDir),
      ],
    })
    .sort();
}

/**
 * Classify one source path into the contribution it makes.
 *
 * The template suffix is outermost (§6): strip and render first, then the inner
 * name decides whether this is a sidecar, suffix sugar, or a plain file.
 */
export function classifyEntry(source: string, templateSuffix: string): LayerEntry {
  const { render: isTemplate, outPath: inner } = templateTarget(source, templateSuffix);

  if (isSidecar(inner)) {
    return {
      source,
      inner,
      isTemplate,
      kind: "sidecar",
      rawTarget: sidecarTarget(inner),
    };
  }

  const sugar = desugarSuffix(inner);
  if (sugar) {
    return {
      source,
      inner,
      isTemplate,
      kind: "suffix",
      op: sugar.op,
      rawTarget: sugar.target,
    };
  }

  return { source, inner, isTemplate, kind: "file", rawTarget: inner };
}

/** Enumerate a layer's classified entries, in stable (sorted) order. */
export function enumerateLayer(layer: Layer, destDir?: string): LayerEntry[] {
  const suffix = layer.manifest.templateSuffix ?? DEFAULT_TEMPLATE_SUFFIX;
  return listLayerFiles(layer, destDir).map((rel) => classifyEntry(rel, suffix));
}
