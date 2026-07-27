/**
 * Tiny filesystem helpers shared by the step-9 suites.
 *
 * The older suites each carry a private `layer()` of their own; this is the
 * same idea hoisted, since three new files would otherwise copy it a fourth,
 * fifth and sixth time. Retrofitting the existing suites onto it is a separate,
 * mechanical change.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a `{ relative path → contents }` map under `dir`; returns `dir`. */
export function writeTree(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** Read a file as UTF-8 text. */
export const readText = (dir: string, rel: string): string =>
  readFileSync(join(dir, rel), "utf8");

/** A `treelay.json` body, pretty-printed the way a human would commit it. */
export const manifest = (body: Record<string, unknown>): string =>
  JSON.stringify(body, null, 2) + "\n";
