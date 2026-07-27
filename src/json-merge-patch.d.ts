/**
 * Ambient types for `json-merge-patch` (RFC 7386), which ships no declarations.
 * The package is CommonJS (`module.exports = { apply, generate, merge }`), so we
 * model it with `export =` and load it via `createRequire`.
 */
declare module "json-merge-patch" {
  const jsonMergePatch: {
    /** Apply `patch` onto `target`; `null` values delete keys. Mutates `target`. */
    apply(target: unknown, patch: unknown): unknown;
    /** Produce the merge patch that turns `before` into `after`. */
    generate(before: unknown, after: unknown): unknown;
    /** Merge two patches into one. */
    merge(a: unknown, b: unknown): unknown;
  };
  export = jsonMergePatch;
}
