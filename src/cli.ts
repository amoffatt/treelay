#!/usr/bin/env node
/**
 * treelay CLI — SPEC §9.
 *
 * Thin shell over the library. Commands are wired to their API entry points;
 * unimplemented ones surface a clear "not implemented yet" until built (§12).
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { resolve } from "./resolve.js";
import { resolveValues } from "./variables.js";
import { compile } from "./compile.js";
import { hasState } from "./state.js";
import type { Values } from "./types.js";

const program = new Command();

program
  .name("treelay")
  .description(
    "Compose directory trees from parents and mixins, materialize them, " +
      "and keep the output linked for two-way updates.",
  )
  .version("0.0.0");

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
  .description("print the linearized layer order; write nothing")
  .action((dir: string) => {
    const graph = resolve(dir);
    console.log("Layers (lowest → highest precedence):");
    graph.layers.forEach((l, i) =>
      console.log(`  ${i + 1}. ${l.manifest.name ?? l.id}`),
    );
    const vars = Object.keys(graph.variables);
    if (vars.length) console.log(`Variables: ${vars.join(", ")}`);
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
  .description("materialize template → destination (first run = instantiate)")
  .action(
    async (
      src: string,
      dest: string,
      opts: { set?: Values; answers?: string; prompt?: boolean },
    ) => {
      if (hasState(dest)) {
        console.error(
          `treelay compile: ${dest} already has .treelay state — use ` +
            `\`treelay update ${dest}\` to pull template changes in.`,
        );
        process.exit(2);
      }
      const graph = resolve(src);
      const values = await resolveValues(graph, {
        ...(opts.answers ? { answers: loadAnswers(opts.answers) } : {}),
        ...(opts.set ? { set: opts.set } : {}),
        prompt: opts.prompt !== false,
      });
      const result = await compile(graph, { destDir: dest, values });
      const n = Object.keys(result.files).length;
      console.log(`Compiled ${n} file${n === 1 ? "" : "s"} → ${dest}`);
    },
  );

program
  .command("update")
  .argument("<dest>", "destination directory")
  .option("--set <k=v>", "override a saved answer", collectSet)
  .description("re-render with saved answers and 3-way merge into the project")
  .action(() => notImplemented("update"));

program
  .command("status")
  .argument("<dest>", "destination directory")
  .description("list changes vs baseline, annotated with producing layer")
  .action(() => notImplemented("status"));

program
  .command("promote")
  .argument("<dest>", "destination directory")
  .argument("[files...]", "files to promote")
  .option("--to <layer>", "target layer (auto-suggested if omitted)")
  .option("--interactive", "choose a target per change")
  .option("--dry-run", "show what each target would gain; write nothing")
  .description("push instance edits up into a layer")
  .action(() => notImplemented("promote"));

program
  .command("extract")
  .argument("<dest>", "destination directory")
  .argument("[files...]", "files to extract")
  .requiredOption("--as <path>", "path for the new overlay layer")
  .option("--mixin", "wire the new layer in as a mixin")
  .description("capture instance edits as a new overlay layer")
  .action(() => notImplemented("extract"));

program
  .command("explain")
  .argument("<dir>", "leaf overlay directory")
  .argument("<file>", "file to trace")
  .description("trace which layers touched a file, in order")
  .action(() => notImplemented("explain"));

program
  .command("validate")
  .argument("[dir]", "leaf overlay directory", ".")
  .description("check for cycles, failing patches, conflicts, lock drift")
  .action(() => notImplemented("validate"));

program
  .command("watch")
  .argument("<src>", "leaf overlay directory")
  .argument("<dest>", "destination directory")
  .description("recompile on change")
  .action(() => notImplemented("watch"));

program
  .command("eject")
  .argument("<dest>", "destination directory")
  .description("flatten and drop .treelay state (sever the template link)")
  .action(() => notImplemented("eject"));

function notImplemented(cmd: string): never {
  console.error(`treelay ${cmd}: not implemented yet (see SPEC.md §12 build order)`);
  process.exit(2);
}

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
