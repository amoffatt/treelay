import { describe, it, expect } from "vitest";
import { createPatch } from "diff";
import { applyPatch3Way } from "../src/merge/patch.js";
import { MergeConflictError } from "../src/errors.js";

/** Build a unified diff turning `from` into `to`. */
const patchOf = (from: string, to: string) => createPatch("f", from, to, "", "");

const BASE = "one\ntwo\nthree\nfour\nfive\n";
const PATCHED = "one\ntwo\nINSERTED\nthree\nfour\nfive\n";

/** `n` numbered lines — long enough to exercise a patch's 3-line context window. */
const LINES = (n: number) =>
  Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n") + "\n";

describe("applyPatch3Way — without a recorded base (best-effort)", () => {
  it("applies cleanly when the content is unchanged", () => {
    const out = applyPatch3Way({ file: "f", current: BASE, patch: patchOf(BASE, PATCHED) });
    expect(out).toBe(PATCHED);
  });

  it("relocates a hunk that merely moved", () => {
    const drifted = "HEADER\nHEADER2\n" + BASE;
    const out = applyPatch3Way({
      file: "f",
      current: drifted,
      patch: patchOf(BASE, PATCHED),
    });
    expect(out).toBe("HEADER\nHEADER2\n" + PATCHED);
  });

  it("throws when the patch cannot be placed", () => {
    const unrelated = "totally\ndifferent\ncontent\n";
    expect(() =>
      applyPatch3Way({ file: "f", current: unrelated, patch: patchOf(BASE, PATCHED) }),
    ).toThrow(MergeConflictError);
  });

  it("accepts bare `@@` hunks with no ---/+++ headers (SPEC §4 sidecar form)", () => {
    const bare = "@@ -1,3 +1,4 @@\n one\n two\n+INSERTED\n three\n";
    const out = applyPatch3Way({ file: "f", current: BASE, patch: bare });
    expect(out).toBe(PATCHED);
  });

  it("rejects a payload that is not a unified diff", () => {
    expect(() =>
      applyPatch3Way({ file: "f", current: BASE, patch: "just some prose\n" }),
    ).toThrow(/no hunks/);
  });
});

describe("applyPatch3Way — with a recorded base (true three-way)", () => {
  it("returns the authored result when the content has not drifted", () => {
    const out = applyPatch3Way({
      file: "f",
      current: BASE,
      patch: patchOf(BASE, PATCHED),
      base: BASE,
    });
    expect(out).toBe(PATCHED);
  });

  it("merges when the inherited file drifted in a different region", () => {
    // The parent changed "five" → "FIVE"; the patch inserts near the top.
    const drifted = "one\ntwo\nthree\nfour\nFIVE\n";
    const out = applyPatch3Way({
      file: "f",
      current: drifted,
      patch: patchOf(BASE, PATCHED),
      base: BASE,
    });
    expect(out).toBe("one\ntwo\nINSERTED\nthree\nfour\nFIVE\n");
  });

  it("recovers drift inside the context window that a base-less apply rejects", () => {
    // The patch inserts after line8; its context window spans lines 5–11. The
    // parent then edited line5 — inside that window, so a flat apply can no
    // longer place the hunk, but the edits are separated by unchanged lines, so
    // the three-way reconcile reads them as independent.
    const long = LINES(12);
    const longPatched = long.replace("line8\n", "line8\nINSERTED\n");
    const drifted = long.replace("line5\n", "LINE5-CHANGED\n");
    const patch = patchOf(long, longPatched);

    expect(() => applyPatch3Way({ file: "f", current: drifted, patch })).toThrow(
      MergeConflictError,
    );

    const out = applyPatch3Way({ file: "f", current: drifted, patch, base: long });
    expect(out).toBe(drifted.replace("line8\n", "line8\nINSERTED\n"));
  });

  it("throws on a genuine overlapping conflict", () => {
    // Both the parent and the patch rewrote line 3.
    const drifted = "one\ntwo\nPARENT-EDIT\nfour\nfive\n";
    const patch = patchOf(BASE, "one\ntwo\nCHILD-EDIT\nfour\nfive\n");
    expect(() =>
      applyPatch3Way({ file: "f", current: drifted, patch, base: BASE }),
    ).toThrow(/three-way merge conflict/);
  });

  it("treats edits on immediately adjacent lines as a conflict (like git)", () => {
    // Parent changed line2; the patch inserts right after line2. With no
    // unchanged line between them, diff3 cannot order the two edits.
    const drifted = "one\nTWO-CHANGED\nthree\nfour\nfive\n";
    expect(() =>
      applyPatch3Way({
        file: "f",
        current: drifted,
        patch: patchOf(BASE, PATCHED),
        base: BASE,
      }),
    ).toThrow(/three-way merge conflict/);
  });

  it("flags an inconsistent sidecar when the patch does not fit its own base", () => {
    expect(() =>
      applyPatch3Way({
        file: "f",
        current: BASE,
        patch: patchOf(BASE, PATCHED),
        base: "unrelated\nbase\ncontent\n",
      }),
    ).toThrow(/its own recorded base/);
  });
});

describe("applyPatch3Way — text fidelity", () => {
  it("preserves a missing trailing newline", () => {
    const from = "a\nb\nc";
    const to = "a\nb\nc\nd";
    const out = applyPatch3Way({ file: "f", current: from, patch: patchOf(from, to) });
    expect(out).toBe(to);
  });

  it("preserves CRLF-style content through a three-way merge", () => {
    const base = "a\r\nb\r\nc\r\n";
    const patched = "a\r\nb\r\nB2\r\nc\r\n";
    const out = applyPatch3Way({
      file: "f",
      current: base,
      patch: patchOf(base, patched),
      base,
    });
    expect(out).toBe(patched);
  });
});
