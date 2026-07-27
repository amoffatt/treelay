/**
 * `.treelay` sidecar parsing & detection — SPEC §4.
 *
 * A `<targetPath>.treelay` file describes an operation on the inherited file:
 * the strategy, an optional base hash (enabling true 3-way merge, §5), an
 * optional `when:` guard, and the payload. This is the canonical, full-power
 * form; the filename suffixes (`.patch`/`.append`/`.delete`) are sugar that
 * desugar to one of these ops.
 */

import { parse as parseYaml } from "yaml";
import type { SidecarOp, SidecarOpKind } from "./types.js";

export const SIDECAR_SUFFIX = ".treelay";

/** Is this path a sidecar? (Distinct from the `.treelay/` state dir, §7.) */
export function isSidecar(path: string): boolean {
  return path.endsWith(SIDECAR_SUFFIX) && path !== SIDECAR_SUFFIX;
}

/** Map a sidecar path to the inherited file it operates on. */
export function sidecarTarget(path: string): string {
  return path.slice(0, -SIDECAR_SUFFIX.length);
}

/** Parse sidecar YAML into a validated op. */
export function parseSidecar(yaml: string): SidecarOp {
  const op = parseYaml(yaml) as SidecarOp;
  if (!op || typeof op.op !== "string") {
    throw new Error(`Invalid .treelay sidecar: missing "op"`);
  }
  return op;
}

/** Desugar a filename suffix convention into an equivalent sidecar op (§4). */
const SUFFIX_OPS: Record<string, SidecarOpKind> = {
  ".patch": "patch",
  ".append": "append",
  ".prepend": "prepend",
  ".delete": "delete",
};

/**
 * If `path` ends in a known merge suffix, return the desugared op and the
 * target path it applies to. A bare `.patch` has no recorded `base`, so it is
 * best-effort apply rather than true 3-way (§5).
 */
export function desugarSuffix(
  path: string,
): { op: SidecarOpKind; target: string } | undefined {
  for (const [suffix, op] of Object.entries(SUFFIX_OPS)) {
    if (path.endsWith(suffix)) {
      return { op, target: path.slice(0, -suffix.length) };
    }
  }
  return undefined;
}
