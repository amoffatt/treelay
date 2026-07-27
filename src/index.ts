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
export {
  strategyFor,
  defaultStrategy,
  deepMerge,
  applyPatch3Way,
  applyMergePatch,
  applyJsonPatch,
} from "./merge/index.js";
export { mergeText3, MERGE_LABELS } from "./merge/patch.js";
export { mergeStructured3 } from "./merge/structured.js";
export type {
  Patch3WayArgs,
  TextMerge3Args,
  TextMerge3Result,
} from "./merge/patch.js";
export { hashContent, matchesHash } from "./hash.js";
export { compile, composeFiles, summarize } from "./compile.js";
export type { FileEntry } from "./compile.js";
export {
  readState,
  writeState,
  readBaselineFile,
  statePaths,
  hasState,
  sourceOf,
  STATE_DIR,
} from "./state.js";
export type { TreelayState, LockFile } from "./state.js";
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
export type { UpdateOptions, UpdatePlan, Resolution } from "./update.js";
export { status, promote, extract, formatStatus } from "./reflux.js";
export type {
  PromoteOptions,
  PromoteResult,
  ExtractOptions,
  ExtractResult,
  LandedChange,
  LandingMode,
} from "./reflux.js";
export { roundTripVerify, composeToMemory, describeMismatches } from "./verify.js";
export type { VerifyResult, VerifyMismatch, MismatchKind } from "./verify.js";
export { blastRadius, describeBlastRadius, commonAncestor } from "./blast-radius.js";
export type { BlastRadius, BlastRadiusOptions } from "./blast-radius.js";

// --- Layer refs, fetching and pinning (§2, §3) ---
export {
  parseRef,
  canonicalRef,
  pinnedRef,
  isLocalRef,
  isCommitSha,
  InvalidRefError,
} from "./refs.js";
export type {
  RefKind,
  RemoteRefKind,
  ParsedRef,
  RemoteRef,
  LocalRef,
  GitRef,
  NpmRef,
} from "./refs.js";
export {
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  LockfileError,
  emptyLock,
  lockfilePath,
  readLock,
  writeLock,
  serializeLock,
  locksEqual,
} from "./lockfile.js";
export type { TreelayLock, LockEntry } from "./lockfile.js";
export {
  fetchLayer,
  liveRevision,
  verifyIntegrity,
  cacheRoot,
  locationKey,
  GitFetchError,
  NpmResolveError,
  LockMissingError,
  IntegrityError,
} from "./fetch/index.js";
export type { FetchedLayer, FetchOptions } from "./fetch/index.js";
export { checkDrift, hasDrift, formatDrift } from "./drift.js";
export type { DriftReport, DriftStatus } from "./drift.js";
export { MountError } from "./resolve.js";
export type { ResolveOptions } from "./resolve.js";
export { mountTarget } from "./layer-files.js";
export { hashTree } from "./hash.js";
