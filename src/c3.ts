/**
 * C3 linearization (Python's MRO) over the `parents` graph — SPEC §3.
 *
 * This is the principled answer to multiple inheritance: it resolves diamonds
 * (a shared ancestor appears once, before its descendants), respects the local
 * order parents were declared in, and is monotonic. The naive alternative
 * (depth-first + last-wins dedupe) produces surprising orders in diamonds.
 *
 * Output is MRO order: most-derived first (root, then ancestors high → low
 * precedence). Callers that apply layers lowest-precedence-first should reverse
 * the ancestor portion. See `resolve.ts`.
 */

import { CycleError, InconsistentHierarchyError } from "./errors.js";

/**
 * Linearize `root` over a parent graph.
 *
 * @param root      the starting node
 * @param parentsOf returns the direct parents of a node, in declaration order
 * @param key       stable identity for a node (defaults to String)
 * @returns         MRO: `[root, ...ancestors]`, highest precedence first
 */
export function c3Linearize<T>(
  root: T,
  parentsOf: (node: T) => T[],
  key: (node: T) => string = (n) => String(n),
): T[] {
  const lin = (node: T, path: string[]): T[] => {
    const k = key(node);
    if (path.includes(k)) {
      throw new CycleError([...path, k]);
    }
    const parents = parentsOf(node);
    if (parents.length === 0) return [node];

    const nextPath = [...path, k];
    const sequences = parents.map((p) => lin(p, nextPath));
    // The list of direct parents preserves the locally-declared order.
    sequences.push([...parents]);

    return [node, ...merge(sequences, key)];
  };

  return lin(root, []);
}

/**
 * The C3 merge: repeatedly take the head of some sequence that does not appear
 * in the *tail* of any sequence, append it, and remove it from all heads.
 */
function merge<T>(sequences: T[][], key: (node: T) => string): T[] {
  const lists = sequences.map((s) => [...s]).filter((s) => s.length > 0);
  const result: T[] = [];

  while (lists.length > 0) {
    let candidate: T | undefined;

    for (const list of lists) {
      const head = list[0]!;
      const headKey = key(head);
      const inSomeTail = lists.some((other) =>
        other.slice(1).some((n) => key(n) === headKey),
      );
      if (!inSomeTail) {
        candidate = head;
        break;
      }
    }

    if (candidate === undefined) {
      const remaining = lists.map((l) => l.map(key).join(", ")).join(" | ");
      throw new InconsistentHierarchyError(
        `cannot linearize conflicting precedence among: ${remaining}`,
      );
    }

    result.push(candidate);
    const candidateKey = key(candidate);
    for (let i = lists.length - 1; i >= 0; i--) {
      const list = lists[i]!;
      if (list.length > 0 && key(list[0]!) === candidateKey) {
        list.shift();
      }
      if (list.length === 0) {
        lists.splice(i, 1);
      }
    }
  }

  return result;
}
