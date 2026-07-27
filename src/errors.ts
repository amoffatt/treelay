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

/** Placeholder for not-yet-built functionality during scaffolding. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}
