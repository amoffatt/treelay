import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolve } from "../src/resolve.js";
import { compile } from "../src/compile.js";
import { update, planUpdate } from "../src/update.js";
import { mergeText3 } from "../src/merge/patch.js";
import { readState, statePaths } from "../src/state.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "treelay-update-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write/overwrite `files` under `<root>/<name>`; returns the layer dir. */
function layer(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const dest = () => join(root, "out");
const read = (rel: string) => readFileSync(join(dest(), rel), "utf8");
const exists = (rel: string) => existsSync(join(dest(), rel));
const edit = (rel: string, content: string) =>
  writeFileSync(join(dest(), rel), content);

/** Compile a leaf into the standard destination. */
async function first(leafDir: string, values: Record<string, unknown> = {}) {
  await compile(resolve(leafDir), { destDir: dest(), values });
}

const NEVER_PROMPT = { prompt: false } as const;

describe("update — pulling template changes down (§7)", () => {
  it("takes the new version when the instance never touched the file", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n", "other.txt": "keep\n" });
    await first(leaf);

    layer("leaf", { "app.txt": "v2\n" }); // template advances
    const plan = await update(dest(), NEVER_PROMPT);

    expect(read("app.txt")).toBe("v2\n");
    expect(plan.files["app.txt"]).toBe("take-theirs");
  });

  it("keeps local edits when the template did not change the file", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n", "note.md": "# doc\n" });
    await first(leaf);
    edit("app.txt", "locally edited\n");

    layer("leaf", { "note.md": "# doc v2\n" }); // unrelated template change
    const plan = await update(dest(), NEVER_PROMPT);

    expect(read("app.txt")).toBe("locally edited\n");
    expect(plan.files["app.txt"]).toBe("keep-ours");
    expect(read("note.md")).toBe("# doc v2\n");
  });

  it("merges when both sides changed different regions", async () => {
    const v1 = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
    const leaf = layer("leaf", { "app.txt": v1 });
    await first(leaf);

    edit("app.txt", v1.replace("line1\n", "LINE1-MINE\n")); // user edits the top
    layer("leaf", { "app.txt": v1.replace("line8\n", "LINE8-THEIRS\n") }); // template edits the bottom

    const plan = await update(dest(), NEVER_PROMPT);

    expect(plan.files["app.txt"]).toBe("merged");
    expect(read("app.txt")).toBe(
      v1.replace("line1\n", "LINE1-MINE\n").replace("line8\n", "LINE8-THEIRS\n"),
    );
    expect(plan.conflicts).toEqual([]);
  });

  it("never resurrects a file the user deleted when the template left it alone", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n", "keep.txt": "k\n" });
    await first(leaf);
    rmSync(join(dest(), "app.txt"));

    layer("leaf", { "keep.txt": "k2\n" });
    const plan = await update(dest(), NEVER_PROMPT);

    expect(exists("app.txt")).toBe(false);
    expect(plan.files["app.txt"]).toBe("keep-ours");
  });

  it("deletes a file the template dropped when the instance never touched it", async () => {
    const leaf = layer("leaf", { "gone.txt": "bye\n", "stay.txt": "hi\n" });
    await first(leaf);

    rmSync(join(root, "leaf", "gone.txt"));
    const plan = await update(dest(), NEVER_PROMPT);

    expect(exists("gone.txt")).toBe(false);
    expect(exists("stay.txt")).toBe(true);
    expect(plan.files["gone.txt"]).toBe("delete");
  });

  it("will not silently discard local work when the template drops the file", async () => {
    const leaf = layer("leaf", { "gone.txt": "bye\n" });
    await first(leaf);
    edit("gone.txt", "I still want this\n");

    rmSync(join(root, "leaf", "gone.txt"));
    const plan = await update(dest(), NEVER_PROMPT);

    expect(plan.conflicts).toContain("gone.txt");
  });

  it("leaves user-owned files completely alone", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n" });
    await first(leaf);
    writeFileSync(join(dest(), "mine.txt"), "personal\n");

    layer("leaf", { "app.txt": "v2\n" });
    const plan = await update(dest(), NEVER_PROMPT);

    expect(read("mine.txt")).toBe("personal\n");
    expect(plan.files["mine.txt"]).toBeUndefined();
  });
});

describe("update — conflicts", () => {
  const v1 = "alpha\nbeta\ngamma\n";

  /** Set up a genuine overlapping conflict on the same line. */
  async function conflicting() {
    const leaf = layer("leaf", { "app.txt": v1 });
    await first(leaf);
    edit("app.txt", "alpha\nMINE\ngamma\n");
    layer("leaf", { "app.txt": "alpha\nTHEIRS\ngamma\n" });
  }

  it("writes diff3 markers in `markers` mode", async () => {
    await conflicting();
    const plan = await update(dest(), { ...NEVER_PROMPT, onConflict: "markers" });

    expect(plan.conflicts).toEqual(["app.txt"]);
    const out = read("app.txt");
    expect(out).toContain("<<<<<<<");
    expect(out).toContain(">>>>>>>");
    // Both sides plus the base are shown, so the user can see what changed.
    expect(out).toContain("MINE");
    expect(out).toContain("THEIRS");
    expect(out).toContain("beta");
  });

  it("leaves the file untouched and writes a .rej in `rej` mode", async () => {
    await conflicting();
    const plan = await update(dest(), { ...NEVER_PROMPT, onConflict: "rej" });

    expect(plan.conflicts).toEqual(["app.txt"]);
    expect(read("app.txt")).toBe("alpha\nMINE\ngamma\n"); // exactly ours
    expect(read("app.txt.rej")).toBe("alpha\nTHEIRS\ngamma\n"); // incoming
    expect(read("app.txt")).not.toContain("<<<<<<<");
  });

  it("writes nothing at all when the update cannot even be planned", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n" });
    await first(leaf);
    edit("app.txt", "precious local work\n");

    // Point the lock at a template that no longer exists.
    const lock = statePaths(dest()).lock;
    const parsed = JSON.parse(readFileSync(lock, "utf8"));
    parsed.lineage = [join(root, "does-not-exist")];
    writeFileSync(lock, JSON.stringify(parsed));

    await expect(update(dest(), NEVER_PROMPT)).rejects.toThrow(/is gone/);
    expect(read("app.txt")).toBe("precious local work\n");
  });

  it("merges structurally when a line merge would conflict on adjacent keys", async () => {
    // Both sides add a different key right after "name" — adjacent lines, so a
    // pure text merge conflicts, but the edits are semantically independent.
    const base = '{\n  "name": "svc"\n}\n';
    const ours = '{\n  "name": "svc",\n  "mine": 1\n}\n';
    const theirs = '{\n  "name": "svc",\n  "theirs": 2\n}\n';

    // Guard: if this ever merges cleanly as text, the structured path below is
    // no longer being exercised and this test would pass for the wrong reason.
    expect(mergeText3({ base, ours, theirs }).clean).toBe(false);

    const leaf = layer("leaf", { "config.json": base });
    await first(leaf);

    edit("config.json", ours);
    layer("leaf", { "config.json": theirs });

    const plan = await update(dest(), NEVER_PROMPT);

    expect(plan.files["config.json"]).toBe("merged");
    expect(JSON.parse(read("config.json"))).toEqual({
      name: "svc",
      mine: 1,
      theirs: 2,
    });
  });

  it("still conflicts when both sides set the same key differently", async () => {
    const leaf = layer("leaf", { "config.json": '{\n  "port": 3000\n}\n' });
    await first(leaf);

    edit("config.json", '{\n  "port": 8080\n}\n');
    layer("leaf", { "config.json": '{\n  "port": 9090\n}\n' });

    const plan = await update(dest(), NEVER_PROMPT);
    expect(plan.conflicts).toContain("config.json");
  });
});

describe("update — variables", () => {
  it("reuses saved answers and prompts only for newly-introduced variables", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        variables: { svc: { type: "string", default: "billing" } },
      }),
      "app.txt.tmpl": "service={{ svc }}\n",
    });
    await first(leaf, { svc: "billing" });

    // The new template version adds `region`, with a default so the
    // non-interactive path can still resolve it.
    layer("leaf", {
      "treelay.json": JSON.stringify({
        variables: {
          svc: { type: "string", default: "billing" },
          region: { type: "string", default: "westus2", prompt: "Region?" },
        },
      }),
      "app.txt.tmpl": "service={{ svc }}\nregion={{ region }}\n",
    });

    const plan = await update(dest(), NEVER_PROMPT);

    expect(plan.newVariables).toEqual(["region"]);
    expect(read("app.txt")).toBe("service=billing\nregion=westus2\n");
    // The answer is saved, so it is not "new" a second time.
    expect(readState(dest()).answers).toMatchObject({
      svc: "billing",
      region: "westus2",
    });
    expect((await planUpdate(dest())).newVariables).toEqual([]);
  });

  it("honours --set overrides over saved answers", async () => {
    const leaf = layer("leaf", {
      "treelay.json": JSON.stringify({
        variables: { svc: { type: "string", default: "billing" } },
      }),
      "app.txt.tmpl": "service={{ svc }}\n",
    });
    await first(leaf, { svc: "billing" });

    const plan = await update(dest(), { ...NEVER_PROMPT, set: { svc: "payments" } });

    expect(read("app.txt")).toBe("service=payments\n");
    expect(plan.files["app.txt"]).toBe("take-theirs");
    expect(readState(dest()).answers).toMatchObject({ svc: "payments" });
  });
});

describe("update — baseline bookkeeping", () => {
  it("rewrites the baseline so a second update is a no-op", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n", "b.txt": "b1\n" });
    await first(leaf);

    layer("leaf", { "app.txt": "v2\n" });
    const firstRun = await update(dest(), NEVER_PROMPT);
    expect(firstRun.files["app.txt"]).toBe("take-theirs");

    const secondRun = await update(dest(), NEVER_PROMPT);
    expect(Object.values(secondRun.files).every((r) => r === "unchanged")).toBe(true);
    expect(secondRun.conflicts).toEqual([]);
    expect(read("app.txt")).toBe("v2\n");
  });

  it("snapshots baseline content so the next merge has a real base", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n" });
    await first(leaf);

    const snapshot = join(statePaths(dest()).baselineDir, "app.txt");
    expect(readFileSync(snapshot, "utf8")).toBe("v1\n");

    layer("leaf", { "app.txt": "v2\n" });
    await update(dest(), NEVER_PROMPT);
    expect(readFileSync(snapshot, "utf8")).toBe("v2\n");
  });

  it("drops files the template removed from the baseline and its snapshot", async () => {
    const leaf = layer("leaf", { "gone.txt": "bye\n", "stay.txt": "hi\n" });
    await first(leaf);
    rmSync(join(root, "leaf", "gone.txt"));

    await update(dest(), NEVER_PROMPT);

    const state = readState(dest());
    expect(state.baseline["gone.txt"]).toBeUndefined();
    expect(state.baseline["stay.txt"]).toBeDefined();
    expect(existsSync(join(statePaths(dest()).baselineDir, "gone.txt"))).toBe(false);
  });

  it("treats a stale baseline snapshot as no base rather than merging wrongly", async () => {
    // Any writer that advances baseline.json without refreshing the content
    // snapshot would otherwise have `update` merge against the wrong ancestor.
    const v1 = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
    const leaf = layer("leaf", { "app.txt": v1 });
    await first(leaf);

    // Corrupt the snapshot so it no longer matches the recorded hash.
    writeFileSync(
      join(statePaths(dest()).baselineDir, "app.txt"),
      "something else entirely\n",
    );

    edit("app.txt", v1.replace("line1\n", "MINE\n"));
    layer("leaf", { "app.txt": v1.replace("line8\n", "THEIRS\n") });

    const plan = await update(dest(), NEVER_PROMPT);

    // Without a trustworthy base this cannot be merged, so it must surface
    // rather than silently produce a merge against the wrong ancestor.
    expect(plan.files["app.txt"]).toBe("conflict");
  });

  it("does not re-offer a resolved conflict on the next update", async () => {
    const leaf = layer("leaf", { "app.txt": "alpha\nbeta\ngamma\n" });
    await first(leaf);
    edit("app.txt", "alpha\nMINE\ngamma\n");
    layer("leaf", { "app.txt": "alpha\nTHEIRS\ngamma\n" });

    expect((await update(dest(), NEVER_PROMPT)).conflicts).toEqual(["app.txt"]);

    // The user resolves the markers by hand.
    edit("app.txt", "alpha\nRESOLVED\ngamma\n");

    const second = await update(dest(), NEVER_PROMPT);
    expect(second.conflicts).toEqual([]);
    expect(second.files["app.txt"]).toBe("keep-ours");
    expect(read("app.txt")).toBe("alpha\nRESOLVED\ngamma\n");
  });
});

describe("planUpdate — dry run", () => {
  it("reports resolutions without touching the working tree", async () => {
    const leaf = layer("leaf", { "app.txt": "v1\n" });
    await first(leaf);
    edit("app.txt", "mine\n");
    layer("leaf", { "app.txt": "v2\n" });

    const plan = await planUpdate(dest());

    expect(plan.conflicts).toEqual(["app.txt"]);
    expect(read("app.txt")).toBe("mine\n"); // untouched
    expect(exists("app.txt.rej")).toBe(false);
  });
});
