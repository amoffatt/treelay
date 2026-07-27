#!/usr/bin/env node
/**
 * treelay CLI — SPEC §9.
 *
 * Thin shell over the library: every command is a thin wrapper over an API
 * entry point, so anything worth testing lives in the module behind it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { resolve } from "./resolve.js";
import { resolveValues } from "./variables.js";
import { compile } from "./compile.js";
import { update, planUpdate } from "./update.js";
import { explain, explainDest, formatExplanation } from "./explain.js";
import { status, promote, extract, formatStatus } from "./reflux.js";
import { eject, formatEject } from "./eject.js";
import { validate, formatValidation } from "./validate.js";
import { watch, formatWatchEvent } from "./watch.js";
import { lockCommand } from "./lock-command.js";
import { hasState, readState, sourceOf } from "./state.js";
import { lockfilePath } from "./lockfile.js";
import { formatDrift } from "./drift.js";
import type { Values } from "./types.js";

// The published version has exactly one home: package.json. `../package.json`
// resolves to the package root from both `src/cli.ts` and the bundled
// `dist/cli.js`, so dev and install agree without a build-time substitution.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command();

program
  .name("treelay")
  .description(
    "Compose directory trees from parents and mixins, materialize them, " +
      "and keep the output linked for two-way updates.",
  )
  .version(version);

/** Parse repeated `--set k=v` flags into an object. */
function collectSet(value: string, previous: Record<string, string> = {}) {
  const eq = value.indexOf("=");
  if (eq === -1) throw new Error(`--set expects k=v, got "${value}"`);
  previous[value.slice(0, eq)] = value.slice(eq + 1);
  return previous;
}

program
  .command("plan")
  .argument("[dir]", "leaf overlay directory", ".")
  .option("--frozen-lockfile", "fail on any ref treelay.lock does not pin")
  .description("print the linearized layer order; write nothing")
  .action((dir: string, opts: { frozenLockfile?: boolean }) => {
    const graph = resolve(dir, opts.frozenLockfile ? { frozen: true } : {});
    console.log("Layers (lowest → highest precedence):");
    graph.layers.forEach((l, i) => {
      const marks = [
        l.mountPath ? `mounted at ${l.mountPath}/` : undefined,
        l.origin?.revision ? `pinned ${shortRev(l.origin.revision)}` : undefined,
      ].filter(Boolean);
      const suffix = marks.length ? `  [${marks.join(", ")}]` : "";
      console.log(`  ${i + 1}. ${l.manifest.name ?? l.id}${suffix}`);
    });
    const vars = Object.keys(graph.variables);
    if (vars.length) console.log(`Variables: ${vars.join(", ")}`);
    if (graph.lockDirty) {
      console.error(
        `\ntreelay.lock is out of date — run \`treelay lock ${dir}\` to record ` +
          `the revisions this plan resolved.`,
      );
    }
  });

/** Abbreviate a commit SHA for display; package versions pass through. */
function shortRev(rev: string): string {
  return /^[0-9a-f]{40}$/i.test(rev) ? rev.slice(0, 12) : rev;
}

program
  .command("lock")
  .argument("[dir]", "leaf overlay directory", ".")
  .option("--check", "verify the lockfile is complete and current; write nothing")
  .option("--update", "re-resolve moving refs to their current upstream revision")
  .option("--drift", "report refs whose upstream has moved (network)")
  .description("resolve every layer ref and pin it in treelay.lock")
  .action((dir: string, opts: { check?: boolean; update?: boolean; drift?: boolean }) => {
    const result = lockCommand(dir, opts);
    for (const line of result.output) console.log(line);
    for (const line of result.errors) console.error(line);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  });

/** Load an answers file (JSON or YAML) into a values object. */
function loadAnswers(file: string): Values {
  const text = readFileSync(file, "utf8");
  return (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as Values;
}

program
  .command("compile")
  .argument("<src>", "leaf overlay directory")
  .argument("<dest>", "destination directory")
  .option("--set <k=v>", "set a variable", collectSet)
  .option("--answers <file>", "answers file to seed values")
  .option("--no-prompt", "do not prompt for missing variables")
  .option("--frozen-lockfile", "fail on any ref treelay.lock does not pin")
  .description("materialize template → destination (first run = instantiate)")
  .action(
    async (
      src: string,
      dest: string,
      opts: {
        set?: Values;
        answers?: string;
        prompt?: boolean;
        frozenLockfile?: boolean;
      },
    ) => {
      if (hasState(dest)) {
        console.error(
          `treelay compile: ${dest} already has .treelay state — use ` +
            `\`treelay update ${dest}\` to pull template changes in.`,
        );
        process.exit(2);
      }
      const graph = resolve(src, opts.frozenLockfile ? { frozen: true } : {});
      const values = await resolveValues(graph, {
        ...(opts.answers ? { answers: loadAnswers(opts.answers) } : {}),
        ...(opts.set ? { set: opts.set } : {}),
        prompt: opts.prompt !== false,
      });
      const gainedPins = graph.lockDirty;
      const result = await compile(graph, { destDir: dest, values });
      const n = Object.keys(result.files).length;
      console.log(`Compiled ${n} file${n === 1 ? "" : "s"} → ${dest}`);
      // Writing the source lockfile is a side effect on a tree the user may not
      // have expected this command to touch, so it is always announced.
      if (gainedPins) {
        console.log(`Recorded new pins in ${lockfilePath(src)} — commit it.`);
      }
    },
  );

program
  .command("update")
  .argument("<dest>", "destination directory")
  .option("--set <k=v>", "override a saved answer", collectSet)
  .option(
    "--on-conflict <mode>",
    "how to surface conflicts: markers | rej",
    "markers",
  )
  .option("--no-prompt", "do not prompt for newly-introduced variables")
  .option("--dry-run", "show what would change; write nothing")
  .option("--frozen-lockfile", "fail on any ref treelay.lock does not pin")
  .description("re-render with saved answers and 3-way merge into the project")
  .action(
    async (
      dest: string,
      opts: {
        set?: Values;
        onConflict?: string;
        prompt?: boolean;
        dryRun?: boolean;
        frozenLockfile?: boolean;
      },
    ) => {
      requireState(dest, "update");
      if (opts.onConflict !== "markers" && opts.onConflict !== "rej") {
        console.error(
          `treelay update: --on-conflict expects "markers" or "rej", got "${opts.onConflict}"`,
        );
        process.exit(2);
      }

      const options = {
        onConflict: opts.onConflict,
        ...(opts.set ? { set: opts.set } : {}),
        ...(opts.frozenLockfile ? { frozen: true } : {}),
        prompt: opts.prompt !== false,
      } as const;

      const plan = opts.dryRun
        ? await planUpdate(dest, options)
        : await update(dest, options);

      if (plan.newVariables.length) {
        console.log(`New variables: ${plan.newVariables.join(", ")}`);
      }

      // Drift is advisory and goes to stderr: this update composed from the
      // pinned revisions, and saying so must not be mistaken for a file change.
      const drift = formatDrift(plan.drift);
      if (drift) console.error(drift + "\n");

      // Only report files the working tree actually gained, lost, or had
      // rewritten. `keep-ours`/`unchanged` write nothing, and listing them every
      // run buries the handful that moved — and makes a no-op look like work.
      const mark: Record<string, string> = {
        "take-theirs": "U",
        merged: "M",
        conflict: "C",
        delete: "D",
      };
      const changed = Object.entries(plan.files).filter(([, r]) => r in mark);
      const kept = Object.values(plan.files).filter((r) => r === "keep-ours").length;

      if (!changed.length) {
        console.log("Already up to date.");
        if (kept) console.log(`(${kept} file(s) with local edits left as-is.)`);
        return;
      }

      for (const [path, r] of changed.sort()) {
        console.log(`  ${mark[r]}  ${path}${r === "conflict" ? "  ← conflict" : ""}`);
      }
      if (kept) console.log(`  … ${kept} file(s) with local edits left as-is.`);

      if (plan.conflicts.length) {
        console.error(
          `\n${plan.conflicts.length} conflict(s). ` +
            (opts.dryRun
              ? "Re-run without --dry-run to write them."
              : options.onConflict === "rej"
                ? "Your files are unchanged; incoming versions are in *.rej."
                : "Resolve the markers, then run `treelay update` again."),
        );
        process.exit(1);
      }
    },
  );

/** Load a destination's changes, narrowed to `files` when any were named. */
async function changesFor(dest: string, files: string[]) {
  requireState(dest, "status");
  const all = await status(dest);
  if (!files.length) return all;

  const selected = all.filter((c) => files.includes(c.path));
  const missing = files.filter((f) => !all.some((c) => c.path === f));
  if (missing.length) {
    console.error(
      `No change recorded for: ${missing.join(", ")}\n` +
        `Run \`treelay status ${dest}\` to see what diverged from the baseline.`,
    );
    process.exit(2);
  }
  return selected;
}

/** Exit with guidance when a directory carries no treelay state. */
function requireState(dest: string, cmd: string): void {
  if (hasState(dest)) return;
  console.error(
    `treelay ${cmd}: ${dest} has no .treelay state — it was not created by ` +
      `treelay. Use \`treelay compile <src> ${dest}\` first.`,
  );
  process.exit(2);
}

program
  .command("status")
  .argument("<dest>", "destination directory")
  .option("--json", "emit machine-readable JSON")
  .description("list changes vs baseline, annotated with producing layer")
  .action(async (dest: string, opts: { json?: boolean }) => {
    requireState(dest, "status");
    const changes = await status(dest);
    if (opts.json) {
      console.log(JSON.stringify(changes, null, 2));
      return;
    }
    const state = readState(dest);
    const src = sourceOf(state);
    console.log(formatStatus(changes, resolve(src!)));
  });

program
  .command("promote")
  .argument("<dest>", "destination directory")
  .argument("[files...]", "files to promote")
  .option("--to <layer>", "target layer (auto-suggested if omitted)")
  .option("--no-verify", "skip the round-trip recompile check (§8 guard 2)")
  .option("--dry-run", "show what each target would gain; write nothing")
  .description("push instance edits up into a layer")
  .action(
    async (
      dest: string,
      files: string[],
      opts: { to?: string; verify?: boolean; dryRun?: boolean },
    ) => {
      const changes = await changesFor(dest, files);
      if (!changes.length) {
        console.log("Nothing to promote — no changes vs baseline.");
        return;
      }

      if (opts.dryRun) {
        console.log(
          `Would promote ${changes.length} change(s)${opts.to ? ` into ${opts.to}` : ""}:`,
        );
        for (const c of changes) console.log(`  ${c.kind.padEnd(8)} ${c.path}`);
        return;
      }

      const result = await promote(dest, changes, {
        ...(opts.to ? { to: opts.to } : {}),
        verify: opts.verify !== false,
      });

      console.log(`Promoted into ${result.targetName}:`);
      for (const l of result.landed) {
        console.log(`  ${l.mode.padEnd(9)} ${l.path}  → ${l.wrote}`);
      }
      console.log(
        result.verified
          ? "Round-trip verified: the destination reproduces from the template."
          : "Round-trip verification skipped (--no-verify).",
      );
      // Guard 3 is advisory, but it is the one with consequences for other
      // people, so it goes to stderr where it will not be piped away silently.
      console.error(`\n${result.blastRadiusWarning}`);
    },
  );

program
  .command("extract")
  .argument("<dest>", "destination directory")
  .argument("[files...]", "files to extract")
  .requiredOption("--as <path>", "path for the new overlay layer")
  .option("--mixin", "wire the new layer in as a mixin")
  .option("--name <name>", "name for the new layer's manifest")
  .description("capture instance edits as a new overlay layer")
  .action(
    async (
      dest: string,
      files: string[],
      opts: { as: string; mixin?: boolean; name?: string },
    ) => {
      const changes = await changesFor(dest, files);
      if (!changes.length) {
        console.log("Nothing to extract — no changes vs baseline.");
        return;
      }

      const result = await extract(dest, changes, {
        as: opts.as,
        ...(opts.mixin ? { asMixin: true } : {}),
        ...(opts.name ? { name: opts.name } : {}),
      });

      console.log(`Extracted ${result.files.length} file(s) → ${result.layer}`);
      for (const f of result.files) console.log(`  ${f}`);
      if (result.wired) {
        console.log(`Wired in as a mixin of the leaf; round-trip verified.`);
      } else {
        console.error(
          `\nThe new layer is not wired into the graph, so these edits are still ` +
            `local. Add "${opts.as}" to the leaf's parents or mixins (or re-run ` +
            `with --mixin) to make them inherited.`,
        );
      }
    },
  );

program
  .command("explain")
  .argument("<dir>", "leaf overlay directory, or a compiled destination")
  .argument("[file]", "a single output path to trace (default: every file)")
  .option("--set <k=v>", "value used to render templated paths", collectSet)
  .option("--answers <file>", "answers file to seed values")
  .option("--json", "emit machine-readable JSON")
  .description("trace which layers touched a file, in order")
  .action(
    async (
      dir: string,
      file: string | undefined,
      opts: { set?: Values; answers?: string; json?: boolean },
    ) => {
      // A compiled destination explains itself from its own state (lineage +
      // saved answers); a source directory is resolved and explained directly.
      const result = hasState(dir)
        ? await explainDest(dir)
        : await explain(resolve(dir), {
            values: {
              ...(opts.answers ? loadAnswers(opts.answers) : {}),
              ...(opts.set ?? {}),
            },
          });

      if (opts.json) {
        const payload = file
          ? { layers: result.layers, files: pick(result.files, file) }
          : result;
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(formatExplanation(result, file));
      if (file && !result.files[file]) process.exit(1);
    },
  );

/** Narrow an explanation's file map to a single path (empty when absent). */
function pick<T>(files: Record<string, T>, path: string): Record<string, T> {
  const hit = files[path];
  return hit ? { [path]: hit } : {};
}

program
  .command("validate")
  .argument("[dir]", "leaf overlay directory", ".")
  .option("--set <k=v>", "value used to render the composition", collectSet)
  .option("--answers <file>", "answers file to seed values")
  .option("--drift", "also probe upstreams for movement (network)")
  .option("--frozen-lockfile", "fail on any ref treelay.lock does not pin")
  .option("--json", "emit machine-readable JSON")
  .description("check for cycles, failing patches, conflicts, lock drift")
  .action(
    async (
      dir: string,
      opts: {
        set?: Values;
        answers?: string;
        drift?: boolean;
        frozenLockfile?: boolean;
        json?: boolean;
      },
    ) => {
      const values = {
        ...(opts.answers ? loadAnswers(opts.answers) : {}),
        ...(opts.set ?? {}),
      };
      const report = await validate(dir, {
        ...(Object.keys(values).length ? { values } : {}),
        ...(opts.drift ? { drift: true } : {}),
        ...(opts.frozenLockfile ? { frozen: true } : {}),
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatValidation(report, dir));
      }
      // Warnings are reportable but not fatal, so a tree with stale pins still
      // exits 0 — otherwise `validate` could not be a merge gate.
      if (!report.ok) process.exit(1);
    },
  );

program
  .command("watch")
  .argument("<src>", "leaf overlay directory")
  .argument("<dest>", "destination directory")
  .option("--set <k=v>", "set a variable", collectSet)
  .option("--answers <file>", "answers file to seed values")
  .option("--debounce <ms>", "settle time before recompiling", "120")
  .option("--poll", "poll instead of using native events (network/Docker mounts)")
  .option("--frozen-lockfile", "fail on any ref treelay.lock does not pin")
  .description("recompile on change")
  .action(
    async (
      src: string,
      dest: string,
      opts: {
        set?: Values;
        answers?: string;
        debounce: string;
        poll?: boolean;
        frozenLockfile?: boolean;
      },
    ) => {
      const debounceMs = Number(opts.debounce);
      if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        console.error(`treelay watch: --debounce expects milliseconds, got "${opts.debounce}"`);
        process.exit(2);
      }
      const values = {
        ...(opts.answers ? loadAnswers(opts.answers) : {}),
        ...(opts.set ?? {}),
      };

      const handle = await watch(src, dest, {
        debounceMs,
        ...(opts.poll ? { usePolling: true } : {}),
        ...(Object.keys(values).length ? { values } : {}),
        ...(opts.frozenLockfile ? { frozen: true } : {}),
        onEvent: (event) => {
          // Failures go to stderr so piping the build log keeps them separable.
          const line = formatWatchEvent(event);
          if (event.kind === "failed") console.error(line);
          else console.log(line);
        },
      });

      // Watch is the one command that does not end on its own.
      const stop = () => {
        void handle.close().then(() => {
          console.log("\nStopped watching.");
          process.exit(0);
        });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  );

program
  .command("eject")
  .argument("<dest>", "destination directory")
  .option("--dry-run", "show what would be severed; remove nothing")
  .description("flatten and drop .treelay state (sever the template link)")
  .action((dest: string, opts: { dryRun?: boolean }) => {
    requireState(dest, "eject");
    const result = eject(dest, opts.dryRun ? { dryRun: true } : {});
    console.log(formatEject(result, dest));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
