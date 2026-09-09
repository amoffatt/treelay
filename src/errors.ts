/** Error types used across treelay. */

/** A cycle was found in the parents/mixins graph (§3). */
export class CycleError extends Error {
  constructor(public readonly path: string[]) {
    super(`Inheritance cycle detected: ${path.join(" → ")}`);
    this.name = "CycleError";
  }
}

/** C3 could not produce a consistent linearization (§3). */
export class InconsistentHierarchyError extends Error {
  constructor(message: string) {
    super(`Inconsistent hierarchy: ${message}`);
    this.name = "InconsistentHierarchyError";
  }
}

/** A patch/merge could not be applied cleanly (§5). */
export class MergeConflictError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`Merge conflict in ${file}: ${message}`);
    this.name = "MergeConflictError";
  }
}

/**
 * An op was authored against an inherited file that no lower layer produces (§4).
 *
 * Deliberately *not* a {@link MergeConflictError}: nothing conflicted. The
 * prerequisite is simply absent, and the remedy is different — ship the whole
 * file, or find out what renamed or tombstoned the one you meant to modify.
 *
 * The failure mode this exists to prevent is absence, which is the hardest
 * thing to notice: an `append` with nothing to append to used to produce a file
 * containing only the fragment, so a rename upstream silently shipped documents
 * that start halfway through.
 */
export class OrphanOpError extends Error {
  constructor(
    public readonly file: string,
    public readonly op: string,
    /** The op's own source file within its layer, for a pointable message. */
    public readonly source?: string,
  ) {
    super(
      `Nothing to ${op} in ${file}: no lower layer produces that file, so this ` +
        `${op} has nothing to apply to — it was never created, or a tombstone ` +
        `removed it.\n` +
        (source ? `  declared by: ${source}\n` : "") +
        `An op modifies an inherited file; with no inheritance there is no ` +
        `super() to call. Ship the full file instead of a fragment, or check ` +
        `whether an ancestor renamed or removed ${file}.`,
    );
    this.name = "OrphanOpError";
  }
}

/**
 * A `parents`/`mixins` ref resolved to a directory that declares no layer (§2).
 *
 * Without this, such a ref quietly became a parent-less layer whose content was
 * the entire directory — so a ref missing its `_layer/` suffix shipped files
 * that were never layer content and put the real layer's files one directory
 * deep, with no error, no warning, and a plausible file count. The remedy is
 * usually visible in the ref itself, so the message shows it.
 */
export class MissingManifestError extends Error {
  constructor(
    ref: string,
    dir: string,
    candidates: readonly string[],
    declaredIn?: string,
  ) {
    const suggestions = candidates
      .map((c) => `    ${ref.replace(/\/+$/, "")}/${c}`)
      .join("\n");
    super(
      `Layer "${ref}" has no manifest, but contains one (resolved to ${dir}).\n` +
        (declaredIn ? `  declared in: ${declaredIn}\n` : "") +
        `  did you mean:\n${suggestions}\n` +
        `Composing "${ref}" would overlay that entire directory — every sibling ` +
        `of the real layer, with the layer's own files nested one level deep. ` +
        `That is almost always a ref that is one level too shallow.`,
    );
    this.name = "MissingManifestError";
  }
}

/** Placeholder for not-yet-built functionality during scaffolding. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}
