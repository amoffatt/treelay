import { describe, it, expect } from "vitest";
import { c3Linearize } from "../src/c3.js";
import { CycleError, InconsistentHierarchyError } from "../src/errors.js";

/**
 * Graphs are expressed as `node → direct parents` maps. c3Linearize returns
 * MRO order: most-derived (the root) first, then ancestors high → low.
 */
function linearize(graph: Record<string, string[]>, root: string): string[] {
  return c3Linearize(root, (n) => graph[n] ?? []);
}

describe("c3Linearize", () => {
  it("handles a linear chain", () => {
    const g = { A: ["B"], B: ["C"], C: [] };
    expect(linearize(g, "A")).toEqual(["A", "B", "C"]);
  });

  it("resolves a diamond, applying the shared ancestor once and last", () => {
    // A → B, C ; B → D ; C → D
    const g = { A: ["B", "C"], B: ["D"], C: ["D"], D: [] };
    expect(linearize(g, "A")).toEqual(["A", "B", "C", "D"]);
  });

  it("preserves locally-declared parent order", () => {
    const g = { A: ["B", "C"], B: [], C: [] };
    expect(linearize(g, "A")).toEqual(["A", "B", "C"]);
  });

  it("matches Python's classic C3 example", () => {
    // O is the common root; the textbook example from the C3 paper.
    const g: Record<string, string[]> = {
      O: [],
      D: ["O"],
      E: ["O"],
      F: ["O"],
      B: ["D", "E"],
      C: ["D", "F"],
      A: ["B", "C"],
    };
    expect(linearize(g, "A")).toEqual(["A", "B", "C", "D", "E", "F", "O"]);
  });

  it("throws on a direct cycle", () => {
    const g = { A: ["B"], B: ["A"] };
    expect(() => linearize(g, "A")).toThrow(CycleError);
  });

  it("throws on a self-cycle", () => {
    const g = { A: ["A"] };
    expect(() => linearize(g, "A")).toThrow(CycleError);
  });

  it("throws when precedence is inconsistent", () => {
    // X → A, B ; Y → B, A — irreconcilable order for a common child.
    const g: Record<string, string[]> = {
      A: [],
      B: [],
      X: ["A", "B"],
      Y: ["B", "A"],
      Z: ["X", "Y"],
    };
    expect(() => linearize(g, "Z")).toThrow(InconsistentHierarchyError);
  });
});
