/**
 * Variable declaration merge + value resolution — SPEC §6.
 *
 * Declarations merge across the linearized stack (parents < mixins < self),
 * producing one merged questionnaire for the whole composition. Values are then
 * resolved lowest → highest: declared default → answers file → prompts → CLI/env.
 */

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parse as parseYaml } from "yaml";
import { createEngine } from "./render.js";
import type { Layer, ResolvedGraph, VariableDecl, VariableType, Values } from "./types.js";

/**
 * A stdout proxy whose echo can be silenced part-way through a prompt.
 *
 * readline echoes keystrokes through its `output` stream, so muting that stream
 * while a `secret` is typed is what keeps the value off the screen and out of
 * scrollback. The prompt text is written before muting begins, so the question
 * stays visible while the answer does not.
 */
export class MaskableOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream = process.stdout) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    done();
  }
}

/**
 * Merge variable declarations across layers (lowest → highest precedence).
 * Same-named declarations merge per-key, so a child can override just the
 * `default` while inheriting the parent's `prompt`/`type`.
 */
export function mergeVariableDecls(
  layers: Layer[],
): Record<string, VariableDecl> {
  const merged: Record<string, VariableDecl> = {};
  for (const layer of layers) {
    const vars = layer.manifest.variables ?? {};
    for (const [name, decl] of Object.entries(vars)) {
      merged[name] = { ...merged[name], ...decl };
    }
  }
  return merged;
}

/** Options controlling how values are sourced. */
export interface ResolveValuesOptions {
  /** Pre-supplied answers (e.g. loaded from `.treelay/answers.json`). */
  answers?: Values;
  /** CLI `--set k=v` overrides (highest precedence before computed). */
  set?: Values;
  /** Whether to prompt interactively for missing, prompt-able variables. */
  prompt?: boolean;
}

/** Sentinel: a render that referenced a not-yet-resolved variable. */
const DEFER = Symbol("defer");

/** Coerce a raw value (often a string from `--set` or a render) to its type. */
function coerce(type: VariableType, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  switch (type) {
    case "string":
    case "path":
      return String(raw);
    case "number": {
      if (typeof raw === "number") return raw;
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      return raw === "true" || raw === "1" || raw === "yes";
    case "json":
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    case "yaml":
      return typeof raw === "string" ? parseYaml(raw) : raw;
  }
}

/** A render result is falsy when it's empty or an explicit false-ish literal. */
function isFalsy(rendered: string): boolean {
  const t = rendered.trim();
  return t === "" || t === "false";
}

/**
 * Resolve final variable values for a graph (§6 steps 3–4): collect from
 * defaults/answers/overrides, prompt for the rest, then evaluate computed and
 * templated defaults in dependency order via a fixpoint over the declarations.
 */
export async function resolveValues(
  graph: ResolvedGraph,
  options: ResolveValuesOptions = {},
): Promise<Values> {
  const engine = createEngine();
  const decls = graph.variables;
  const values: Values = {};

  // Strictly render a template against the values resolved so far; a reference to
  // a not-yet-resolved variable throws under strictVariables → treat as DEFER so
  // the fixpoint retries it on a later pass.
  const tryRender = async (tmpl: string): Promise<string | typeof DEFER> => {
    try {
      return await engine.parseAndRender(tmpl, values);
    } catch {
      return DEFER;
    }
  };

  // Render a declaration's default (templated when a string, literal otherwise).
  const evalDefault = async (
    decl: VariableDecl,
  ): Promise<unknown | typeof DEFER> => {
    if (typeof decl.default !== "string") return decl.default;
    const r = await tryRender(decl.default);
    if (r === DEFER) return DEFER;
    return coerce(decl.type, r);
  };

  // Provided values: answers (low) then --set (high). Coerce declared ones.
  const provided: Values = { ...options.answers, ...options.set };
  for (const [name, raw] of Object.entries(provided)) {
    values[name] = decls[name] ? coerce(decls[name]!.type, raw) : raw;
  }

  const resolved = new Set(Object.keys(provided).filter((n) => decls[n]));
  let pending = Object.keys(decls).filter((n) => !resolved.has(n));

  // Set up prompting lazily so non-interactive runs never touch stdin.
  let rl: ReturnType<typeof createInterface> | undefined;
  let out: MaskableOutput | undefined;
  const promptVar = async (
    name: string,
    decl: VariableDecl,
    fallback: unknown,
  ): Promise<unknown> => {
    if (!rl) {
      out = new MaskableOutput();
      rl = createInterface({
        input: process.stdin,
        output: out,
        // readline infers `terminal` from `output.isTTY`, which a proxy stream
        // does not have. Without this it would disable echo and line editing
        // even in a real terminal.
        terminal: process.stdout.isTTY === true,
      });
    }
    const hint = decl.choices ? ` ${JSON.stringify(decl.choices)}` : "";
    const def = fallback !== undefined ? ` [${String(fallback)}]` : "";
    // `question` writes the prompt synchronously, so muting straight afterwards
    // hides the typed answer without hiding the question.
    const pendingAnswer = rl.question(`${decl.prompt}${hint}${def} `);
    if (decl.secret && out) out.muted = true;
    const answer = (await pendingAnswer).trim();
    if (decl.secret && out) {
      out.muted = false;
      out.write("\n"); // stand in for the newline the echoed Enter would have shown
    }
    return answer === "" ? fallback : coerce(decl.type, answer);
  };

  try {
    let guard = pending.length + 1;
    while (pending.length && guard-- > 0) {
      const next: string[] = [];
      let progressed = false;

      for (const name of pending) {
        const decl = decls[name]!;

        // `when` falsy ⇒ the variable is skipped entirely (left undefined).
        if (decl.when !== undefined) {
          const w = await tryRender(decl.when);
          if (w === DEFER) { next.push(name); continue; }
          if (isFalsy(w)) { resolved.add(name); progressed = true; continue; }
        }

        // Computed: always derived from its (templated) default, never prompted.
        if (decl.computed) {
          if (decl.default === undefined) {
            throw new Error(`computed variable "${name}" has no default`);
          }
          const r = await evalDefault(decl);
          if (r === DEFER) { next.push(name); continue; }
          values[name] = r; resolved.add(name); progressed = true; continue;
        }

        const fallback =
          decl.default !== undefined ? await evalDefault(decl) : undefined;
        if (fallback === DEFER) { next.push(name); continue; }

        if (decl.prompt !== undefined && options.prompt) {
          values[name] = await promptVar(name, decl, fallback);
        } else if (fallback !== undefined) {
          values[name] = fallback;
        } else {
          // No default and either no prompt or prompting disabled: unresolved.
          next.push(name);
          continue;
        }
        resolved.add(name); progressed = true;
      }

      pending = next;
      if (!progressed) break;
    }
  } finally {
    rl?.close();
  }

  if (pending.length) {
    throw new Error(
      `Cannot resolve variables: ${pending.join(", ")} ` +
        `(no value/default, or a dependency cycle among defaults)`,
    );
  }

  // Validation: enum membership + `validate` expressions (render "" when valid).
  for (const [name, decl] of Object.entries(decls)) {
    if (!(name in values)) continue;
    if (decl.choices && !decl.choices.includes(values[name])) {
      throw new Error(
        `Invalid ${name}: ${JSON.stringify(values[name])} not in ` +
          JSON.stringify(decl.choices),
      );
    }
    if (decl.validate) {
      const msg = (await engine.parseAndRender(decl.validate, values)).trim();
      if (msg) throw new Error(`Invalid ${name}: ${msg}`);
    }
  }

  return values;
}
