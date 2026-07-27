/**
 * Template rendering via LiquidJS — SPEC §6.
 *
 * LiquidJS is chosen for safety: layers arrive as third-party npm packages, so
 * the engine must not allow arbitrary code execution or filesystem/network
 * access. We construct the engine with file-system access disabled; a template
 * can only read the resolved variable values.
 */

import { Liquid } from "liquidjs";
import type { Values } from "./types.js";

export const DEFAULT_TEMPLATE_SUFFIX = ".tmpl";

/** A sandboxed Liquid engine — no includes/layouts from disk. */
export function createEngine(): Liquid {
  return new Liquid({
    // No `root`/`fs` ⇒ `{% include %}`/`{% render %}` from disk is unavailable.
    strictVariables: true,
    strictFilters: true,
  });
}

const engine = createEngine();

/** Render a single template string with the given values. */
export async function renderString(
  template: string,
  values: Values,
): Promise<string> {
  return engine.parseAndRender(template, values);
}

/**
 * Decide whether a file path should be rendered, and return its output name.
 * Suffix opt-in (default): only `*.tmpl` files render, with the suffix stripped.
 */
export function templateTarget(
  path: string,
  suffix: string = DEFAULT_TEMPLATE_SUFFIX,
): { render: boolean; outPath: string } {
  if (path.endsWith(suffix)) {
    return { render: true, outPath: path.slice(0, -suffix.length) };
  }
  return { render: false, outPath: path };
}
