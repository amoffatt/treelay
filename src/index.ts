/**
 * treelay — public API.
 *
 * An inheritance/composition system for directory trees. See SPEC.md.
 */

export * from "./types.js";
export {
  CycleError,
  InconsistentHierarchyError,
  MergeConflictError,
  NotImplementedError,
} from "./errors.js";

export { c3Linearize } from "./c3.js";
export { resolve, resolveRef } from "./resolve.js";
export { loadManifest } from "./manifest.js";
export { mergeVariableDecls, resolveValues } from "./variables.js";
export { renderString, templateTarget, createEngine } from "./render.js";
export {
  parseSidecar,
  isSidecar,
  sidecarTarget,
  desugarSuffix,
} from "./sidecar.js";
export { strategyFor, defaultStrategy, deepMerge } from "./merge/index.js";
export { compile } from "./compile.js";
export {
  ALWAYS_IGNORE,
  SelfCompileError,
  classifyEntry,
  destExclusions,
  enumerateLayer,
  listLayerFiles,
} from "./layer-files.js";
export {
  explain,
  explainDest,
  explainFile,
  formatExplanation,
  summarizeLayers,
} from "./explain.js";
export { update, planUpdate } from "./update.js";
export { status, promote, extract } from "./reflux.js";
