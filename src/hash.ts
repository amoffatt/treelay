/**
 * Content hashing — the single source of truth for the `sha256:…` format used
 * by `.treelay` sidecar `base:` fields (§5) and the destination baseline (§7).
 */

import { createHash } from "node:crypto";

/** Hash content into the canonical `sha256:<hex>` form. */
export function hashContent(data: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** Whether `data` matches a recorded `sha256:…` hash. */
export function matchesHash(data: Buffer | string, recorded: string): boolean {
  return hashContent(data) === recorded.trim();
}
