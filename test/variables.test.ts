import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { resolveValues, MaskableOutput } from "../src/variables.js";
import type { ResolvedGraph, VariableDecl } from "../src/types.js";

/** Build a minimal graph carrying only a merged variable schema. */
function graphWith(variables: Record<string, VariableDecl>): ResolvedGraph {
  return { layers: [], variables };
}

const opts = { prompt: false };

describe("resolveValues", () => {
  it("uses declared defaults, coercing to the declared type", async () => {
    const g = graphWith({
      port: { type: "number", default: 3000 },
      name: { type: "string", default: "svc" },
      on: { type: "boolean", default: true },
    });
    expect(await resolveValues(g, opts)).toEqual({ port: 3000, name: "svc", on: true });
  });

  it("lets --set override defaults and coerces string overrides", async () => {
    const g = graphWith({ port: { type: "number", default: 3000 } });
    const v = await resolveValues(g, { ...opts, set: { port: "8080" } });
    expect(v.port).toBe(8080);
  });

  it("answers sit below --set in precedence", async () => {
    const g = graphWith({ region: { type: "string", default: "us" } });
    const v = await resolveValues(g, {
      ...opts,
      answers: { region: "eu" },
      set: { region: "ap" },
    });
    expect(v.region).toBe("ap");
  });

  it("resolves templated defaults in dependency order (fixpoint)", async () => {
    const g = graphWith({
      org: { type: "string", default: "acme" },
      registry: { type: "string", default: "{{ org }}.registry.io" },
    });
    const v = await resolveValues(g, opts);
    expect(v.registry).toBe("acme.registry.io");
  });

  it("evaluates computed variables from their template", async () => {
    const g = graphWith({
      name: { type: "string", default: "svc" },
      slug: { type: "string", computed: true, default: "{{ name }}-prod" },
    });
    const v = await resolveValues(g, opts);
    expect(v.slug).toBe("svc-prod");
  });

  it("skips a variable whose `when` is falsy (left undefined)", async () => {
    const g = graphWith({
      useDocker: { type: "boolean", default: false },
      dockerTag: { type: "string", default: "latest", when: "{{ useDocker }}" },
    });
    const v = await resolveValues(g, opts);
    expect("dockerTag" in v).toBe(false);
  });

  it("rejects a value outside its choices", async () => {
    const g = graphWith({
      license: { type: "string", default: "GPL", choices: ["MIT", "Apache-2.0"] },
    });
    await expect(resolveValues(g, opts)).rejects.toThrow(/not in/);
  });

  it("fails loud on an unresolvable required variable (no default, no prompt)", async () => {
    const g = graphWith({ token: { type: "string", prompt: "Token?" } });
    await expect(resolveValues(g, opts)).rejects.toThrow(/Cannot resolve/);
  });

  it("surfaces a validate error message", async () => {
    const g = graphWith({
      name: {
        type: "string",
        default: "",
        validate: "{% if name == '' %}name is required{% endif %}",
      },
    });
    await expect(resolveValues(g, opts)).rejects.toThrow(/name is required/);
  });
});

describe("MaskableOutput", () => {
  /** Collect everything that reaches the underlying stream. */
  function sink() {
    const written: string[] = [];
    const target = new Writable({
      write(chunk, _enc, cb) {
        written.push(String(chunk));
        cb();
      },
    });
    return { target, text: () => written.join("") };
  }

  it("passes writes through while unmuted", () => {
    const { target, text } = sink();
    const out = new MaskableOutput(target);
    out.write("Password? ");
    expect(text()).toBe("Password? ");
  });

  it("swallows writes while muted, so a typed secret never reaches the terminal", () => {
    const { target, text } = sink();
    const out = new MaskableOutput(target);
    out.write("Password? ");
    out.muted = true;
    // What readline would echo, one keystroke at a time.
    for (const ch of "hunter2") out.write(ch);
    expect(text()).toBe("Password? ");
  });

  it("resumes after unmuting, so the next prompt is visible again", () => {
    const { target, text } = sink();
    const out = new MaskableOutput(target);
    out.muted = true;
    out.write("swallowed");
    out.muted = false;
    out.write("\nNext? ");
    expect(text()).toBe("\nNext? ");
  });
});
