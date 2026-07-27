/**
 * Core type definitions for treelay.
 *
 * See SPEC.md — these mirror the manifest (§2), merge semantics (§4), the
 * `.treelay` sidecar (§4), variables (§6), and the programmatic API (§10).
 */

import type { TreelayLock } from "./lockfile.js";

/** A reference to another layer: local path, npm spec, or git spec. */
export type LayerRef = string;

/**
 * Where a layer's content came from, once resolved (§3).
 *
 * Local layers are edited in place; fetched ones live in the content-addressed
 * cache at an exact revision and are read-only by construction — which is also
 * what disqualifies them as promotion targets (§8).
 */
export interface LayerOrigin {
  kind: "local" | "git" | "npm";
  /** Canonical ref (lockfile key). Absent for the leaf and plain local layers. */
  ref?: string;
  /** Exact revision materialized: commit SHA or package version. */
  revision?: string;
  /** `sha256:…` over the materialized tree, as recorded in the lock. */
  integrity?: string;
}

/** Per-file merge strategy (§4). */
export type MergeStrategy =
  | "replace"
  | "deep-merge"
  | "patch"
  | "append"
  | "prepend"
  | "delete";

/**
 * A `.treelay` sidecar's `op:` (§4). Distinct from `MergeStrategy`: `merge` here
 * is a *structured patch* (RFC 7386/6902) onto the inherited file, whereas the
 * strategy `deep-merge` merges two whole files when the same path exists in
 * multiple layers.
 */
export type SidecarOpKind =
  | "replace"
  | "patch"
  | "merge"
  | "append"
  | "prepend"
  | "delete";

/** How `deep-merge` treats arrays (§4). */
export type ArrayPolicy = "replace" | "concat" | "by-key";

/** Whether non-suffixed text files are rendered (§6). */
export type RenderMode = "suffix" | "all-text";

/** The declared type of a template variable (§6). */
export type VariableType =
  | "string"
  | "number"
  | "boolean"
  | "json"
  | "yaml"
  | "path";

/** A single variable declaration in a manifest (§6). */
export interface VariableDecl {
  type: VariableType;
  /** Prompt text; omit to never prompt (pure default/computed). */
  prompt?: string;
  /** Default value; may itself be a Liquid template string. */
  default?: unknown;
  /** Optional enum of allowed values. */
  choices?: unknown[];
  /** Liquid expression — when falsy, the question and value are skipped. */
  when?: string;
  /** Liquid template that renders to "" when valid, else the error message. */
  validate?: string;
  /** Masked input; excluded from the persisted answers file. */
  secret?: boolean;
  /** Derived from other variables; never prompted. */
  computed?: boolean;
}

/** The `treelay.json` manifest (or `"treelay"` key in package.json) — §2. */
export interface Manifest {
  name?: string;
  /** Inherit-only; not compilable as a leaf. */
  abstract?: boolean;
  parents?: LayerRef[];
  mixins?: LayerRef[];
  /**
   * Trees vendored into the composed output at a fixed subpath (§3).
   *
   * `{ "packages": "git+file:///srv/packages.git#v1.2.0" }` materializes that
   * repo at `packages/` in every compiled tree. Mount *paths* merge across the
   * graph by ordinary layer precedence, so a leaf can hold one back at an older
   * ref while its parents float — a ref override, not a separate mechanism.
   */
  mounts?: Record<string, LayerRef>;
  ignore?: string[];
  /** glob → strategy defaults. */
  merge?: Record<string, MergeStrategy>;
  arrays?: ArrayPolicy;
  /** Suffix that marks a file for rendering (default ".tmpl"). */
  templateSuffix?: string;
  render?: RenderMode;
  variables?: Record<string, VariableDecl>;
}

/** A loaded layer: its resolved location plus parsed manifest. */
export interface Layer {
  /**
   * Stable identity. A local layer is identified by its absolute directory; a
   * fetched one by its canonical ref, so provenance stays meaningful across
   * machines whose caches sit in different places.
   */
  id: string;
  /** Absolute path to the layer's root directory (a cache path when fetched). */
  dir: string;
  manifest: Manifest;
  /** Whether the layer dir is writable (false for node_modules/git installs) — §8. */
  writable: boolean;
  /** Where the content came from; local with no ref when omitted. */
  origin?: LayerOrigin;
  /**
   * Subpath this layer's files are re-rooted under in the output (§3 mounts).
   * Absent for ordinary layers, which compose at the tree root.
   */
  mountPath?: string;
}

/**
 * The fully resolved composition: layers ordered lowest → highest precedence,
 * plus the merged variable schema across all of them (§3, §6).
 */
export interface ResolvedGraph {
  /** Lowest precedence first; the leaf/self is last. */
  layers: Layer[];
  /** Merged variable declarations across the whole graph (§6). */
  variables: Record<string, VariableDecl>;
  /**
   * Pinned revisions for every remote ref this graph touched, in memory.
   *
   * Resolution deliberately does not write it: `resolve` is called by read-only
   * commands too, and a lockfile appearing as a side effect of `explain` would
   * be a surprise. Callers that own the source tree (`compile`, `treelay lock`)
   * persist it when {@link ResolvedGraph.lockDirty} is set.
   *
   * Optional because a graph can also be *synthesized* — reflux builds partial
   * stacks to test shadowing (§8) — and a synthetic stack pins nothing.
   */
  lock?: TreelayLock;
  /** True when `lock` differs from what is on disk (entries added or advanced). */
  lockDirty?: boolean;
  /** Leaf directory the lockfile belongs beside. */
  lockDir?: string;
}

/** A `.treelay` sidecar operation on an inherited file (§4). */
export interface SidecarOp {
  op: SidecarOpKind;
  /**
   * Hash of the parent content the patch was authored against (§5). Detects
   * drift: when it still matches the inherited file, the patch is known to
   * apply exactly; when it doesn't, compile takes the reconciling path.
   */
  base?: string;
  /**
   * The parent content itself. A hash can detect drift but cannot reconstruct
   * the base, so this is what actually enables a *true* diff3 once the
   * inherited file has moved on. Reflux (§8) records it automatically.
   */
  baseContent?: string;
  /** Liquid expression; skip the op when falsy. */
  when?: string;
  /** Render the payload/result with variables (§6). */
  render?: boolean;
  /** Unified-diff payload for `op: patch`. */
  patch?: string;
  /** RFC 7386 JSON Merge Patch for `op: merge`. */
  merge?: unknown;
  /** RFC 6902 JSON Patch for `op: merge`. */
  jsonPatch?: unknown[];
  /** Literal payload for `op: append` / `prepend` / `replace`. */
  content?: string;
}

/** Where a compiled file came from, for `explain` (§10). */
export interface FileProvenance {
  /** Layer id that last produced/owned the content. */
  fromLayer: string;
  strategy: MergeStrategy;
  /** Layer ids whose patches/merges were applied, in order. */
  patchedFrom?: string[];
  /** True if user-created in the destination, not template-generated (§7). */
  owned: boolean;
}

/** Result of a compile (§10). */
export interface CompileResult {
  files: Record<string, FileProvenance>;
}

/** A resolved set of variable values keyed by name. */
export type Values = Record<string, unknown>;

/** The kind of change a destination file represents vs baseline (§8). */
export type ChangeKind = "modified" | "added" | "deleted";

/** A single change detected by `status` (§8). */
export interface Change {
  path: string;
  kind: ChangeKind;
  /** Layer id currently producing this file (undefined for user-added). */
  producingLayer?: string;
  /**
   * Writable layers this change could be promoted into, already filtered to
   * those a higher layer would not immediately shadow (§8 guard 1).
   */
  targets?: string[];
  /** Layers that patched/merged on top of the producer, in order. */
  patchedBy?: string[];
  /** True when the destination owns the file and no layer produces it (§7). */
  owned?: boolean;
}
