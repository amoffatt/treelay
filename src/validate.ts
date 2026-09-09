/**
 * `validate` — one command that answers "will this compile?" (SPEC §9, §12).
 *
 * The four questions from §9: does the graph linearize, do the patches apply,
 * are there unresolved conflicts, and does the lock still describe reality.
 *
 * Every other command fails at the *first* problem, because it is trying to
 * produce something and cannot continue past a broken layer. Validate is trying
 * to produce a *report*, so it collects instead: an issue never stops the run,
 * it only stops the checks that genuinely cannot proceed without it. Finding
 * out about a cycle, then a bad patch, then stale pins across three runs is a
 * worse experience than seeing all three at once.
 */

import { resolve, type ResolveOptions } from "./resolve.js";
import { resolveValues } from "./variables.js";
import { composeToMemory } from "./verify.js";
import { checkDrift, formatDrift, hasDrift } from "./drift.js";
import { lockfilePath } from "./lockfile.js";
import {
  describeOrphanOps,
  describeReplacements,
  describeDroppedArrays,
  emptyAudit,
  type ComposeAudit,
} from "./audit.js";
import type { ResolvedGraph, Values } from "./types.js";

/** What a finding means for the build. */
export type IssueSeverity = "error" | "warning";

export type IssueCode =
  | "cycle"
  | "hierarchy"
  | "resolve-failed"
  | "lock-stale"
  | "drift"
  | "variables-unresolved"
  | "merge-conflict"
  | "compose-failed"
  /** An op modifies a file no lower layer produces (§4) — compile would fail. */
  | "orphan-op"
  /** A layer discards an ancestor's file at the same path, undeclared (§4). */
  | "shadowed-replace"
  /** A layer's array discards an ancestor's elements under `replace` (§4). */
  | "dropped-array";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  /** What to do about it, when there is a specific next step. */
  remedy?: string;
}

export interface ValidationReport {
  /** True when nothing at `error` severity was found. Warnings do not fail. */
  ok: boolean;
  issues: ValidationIssue[];
  /** Layers resolved, once resolution succeeded. */
  layerCount?: number;
  /** Files the composition would produce, once it got that far. */
  fileCount?: number;
  /** Checks that could not run, and why — so a clean report is not misread. */
  skipped: string[];
}

export interface ValidateOptions extends ResolveOptions {
  /** Values to compose with, as `compile` would receive them. */
  values?: Values;
  /** Probe upstreams for movement. Off by default: it needs the network. */
  drift?: boolean;
  /**
   * Suppress the same-path replacement check (§4).
   *
   * For a tree where wholesale override *is* the design. Prefer declaring the
   * intent per-path with a manifest `merge` glob, which this check already
   * honours — a blanket flag also hides the replacements nobody meant.
   */
  allowReplace?: boolean;
  /**
   * Treat every warning as an error, so `validate` exits non-zero.
   *
   * The CI posture. Replacements and stale pins are warnings by default because
   * they are legitimate often enough that failing on them would train people to
   * pass `--no-verify`; a repo that has decided otherwise says so once, here.
   */
  strict?: boolean;
}

/** Run every check that can run, and report what could not. */
export async function validate(
  srcDir: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const skipped: string[] = [];
  const {
    values: given,
    drift: probeDrift,
    allowReplace,
    strict,
    ...resolveOptions
  } = options;

  // ── 1. Does the graph linearize, and can every ref be materialized? ──
  let graph: ResolvedGraph;
  try {
    graph = resolve(srcDir, resolveOptions);
  } catch (err) {
    issues.push(classifyResolveError(err));
    // Nothing downstream is meaningful without a layer stack.
    skipped.push("patches and conflicts (the graph did not resolve)");
    skipped.push("lockfile freshness (the graph did not resolve)");
    return { ok: false, issues, skipped };
  }

  // ── 2. Is the committed lock still what this tree resolves to? ──
  if (graph.lockDirty) {
    issues.push({
      severity: "warning",
      code: "lock-stale",
      message: `${lockfilePath(srcDir)} does not match what this tree resolves to.`,
      remedy: `Run \`treelay lock ${srcDir}\` and commit the result.`,
    });
  }

  // ── 3. Do the patches apply and the merges land without conflict? ──
  // Composition is where patch failures and merge conflicts surface, so it
  // doubles as both checks. It needs values, which may not be available.
  let values: Values | undefined;
  try {
    values = await resolveValues(graph, { ...(given ? { set: given } : {}), prompt: false });
  } catch (err) {
    issues.push({
      severity: "warning",
      code: "variables-unresolved",
      message: message(err),
      remedy:
        "Pass --answers or --set so validate can render and compose the tree; " +
        "without values it cannot check patches or conflicts.",
    });
    skipped.push("patches and conflicts (no values to render with)");
  }

  if (values) {
    // Compose in `collect` mode: an orphan op is what `compile` fails on, but
    // failing on the first one would report a single defect where a report of
    // all of them is the whole point of this command.
    const audit = emptyAudit();
    try {
      const files = await composeToMemory(graph, values, undefined, {
        onOrphanOp: "collect",
        audit,
      });
      auditIssues(issues, audit, allowReplace);
      return finish(issues, skipped, graph, files.size, probeDrift, srcDir, strict);
    } catch (err) {
      // A conflict aborts the compose partway, so whatever the audit gathered
      // before it is still true and still worth saying.
      auditIssues(issues, audit, allowReplace);
      issues.push(classifyComposeError(err));
    }
  }

  return finish(issues, skipped, graph, undefined, probeDrift, srcDir, strict);
}

/**
 * Turn a compose's structural findings into issues (§4).
 *
 * Both of these are reports of *absence*, which every other command calls
 * success: an orphan op is an error because `compile` refuses to build it, while
 * a replacement is a warning because a higher layer winning wholesale is also a
 * documented, frequently-correct mechanism. `--strict` promotes the latter for
 * repos that have decided the invariant holds.
 */
function auditIssues(
  issues: ValidationIssue[],
  audit: ComposeAudit,
  allowReplace: boolean | undefined,
): void {
  if (audit.orphanOps.length) {
    const n = audit.orphanOps.length;
    issues.push({
      severity: "error",
      code: "orphan-op",
      message:
        `${n} op(s) modify a file no lower layer produces:\n` +
        describeOrphanOps(audit.orphanOps),
      remedy:
        "An op modifies an inherited file; with no inheritance there is nothing " +
        "to operate on. Ship the full file instead of a fragment, or check " +
        "whether an ancestor renamed or removed the target.",
    });
  }

  if (!allowReplace && audit.replacements.length) {
    const n = audit.replacements.length;
    issues.push({
      severity: "warning",
      code: "shadowed-replace",
      message:
        `${n} file(s) replace an ancestor's, discarding it:\n` +
        describeReplacements(audit.replacements),
      remedy:
        "Use `.append` to extend the inherited file instead, declare the intent " +
        'with a manifest `merge` glob ("path": "replace"), or pass ' +
        "--allow-replace if every one of these is deliberate.",
    });
  }

  if (audit.droppedArrays.length) {
    const n = audit.droppedArrays.length;
    const total = audit.droppedArrays.reduce((sum, d) => sum + d.dropped, 0);
    issues.push({
      severity: "warning",
      code: "dropped-array",
      message:
        `${n} array(s) discarded ${total} inherited element(s) under the ` +
        `replace policy:\n` +
        describeDroppedArrays(audit.droppedArrays),
      remedy:
        'Set `arrays` for these paths to {"policy": "by-key", "key": "<field>"} ' +
        'so every layer contributes entries, or "concat" for ordered lists. ' +
        "The file merged cleanly otherwise, which is what makes this quiet.",
    });
  }
}

/** Append the optional drift probe and assemble the report. */
function finish(
  issues: ValidationIssue[],
  skipped: string[],
  graph: ResolvedGraph,
  fileCount: number | undefined,
  probeDrift: boolean | undefined,
  srcDir: string,
  strict?: boolean,
): ValidationReport {
  if (probeDrift) {
    const reports = checkDrift(graph);
    if (hasDrift(reports)) {
      issues.push({
        severity: "warning",
        code: "drift",
        message: formatDrift(reports).trim(),
        remedy: `Run \`treelay lock ${srcDir} --update\` to advance the pins.`,
      });
    }
  } else {
    skipped.push("upstream drift (needs the network; pass --drift)");
  }

  // `--strict` rewrites severities rather than only the exit code, so the printed
  // report and the exit status can never disagree about what went wrong.
  const final = strict
    ? issues.map((i): ValidationIssue => ({ ...i, severity: "error" }))
    : issues;

  return {
    ok: !final.some((i) => i.severity === "error"),
    issues: final,
    layerCount: graph.layers.length,
    ...(fileCount !== undefined ? { fileCount } : {}),
    skipped,
  };
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Map a resolution failure onto a reportable issue. */
function classifyResolveError(err: unknown): ValidationIssue {
  const name = err instanceof Error ? err.name : "";
  if (name === "CycleError") {
    return {
      severity: "error",
      code: "cycle",
      message: message(err),
      remedy: "Break the loop: a layer cannot be its own ancestor.",
    };
  }
  if (name === "InconsistentHierarchyError") {
    return {
      severity: "error",
      code: "hierarchy",
      message: message(err),
      remedy:
        "Two layers demand incompatible orderings of the same ancestors. " +
        "Reorder the conflicting `parents` lists so they agree.",
    };
  }
  return { severity: "error", code: "resolve-failed", message: message(err) };
}

/** Map a composition failure onto a reportable issue. */
function classifyComposeError(err: unknown): ValidationIssue {
  if (err instanceof Error && err.name === "MergeConflictError") {
    return {
      severity: "error",
      code: "merge-conflict",
      message: message(err),
      remedy:
        "Either the patch no longer applies to the inherited file, or two " +
        "layers edit the same lines. `treelay explain <dir> <file>` shows who " +
        "touched it.",
    };
  }
  return { severity: "error", code: "compose-failed", message: message(err) };
}

/** Human-readable report; empty issue list produces the all-clear line. */
export function formatValidation(report: ValidationReport, srcDir: string): string {
  const lines: string[] = [];
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");

  for (const issue of [...errors, ...warnings]) {
    lines.push(`${issue.severity === "error" ? "✗" : "!"} ${issue.code}: ${issue.message}`);
    if (issue.remedy) lines.push(`    ${issue.remedy}`);
  }

  if (lines.length) lines.push("");

  const scope =
    report.layerCount === undefined
      ? ""
      : ` (${report.layerCount} layer(s)` +
        (report.fileCount === undefined ? "" : `, ${report.fileCount} file(s)`) +
        ")";

  lines.push(
    errors.length
      ? `${errors.length} error(s), ${warnings.length} warning(s) in ${srcDir}${scope}.`
      : warnings.length
        ? `No errors, ${warnings.length} warning(s) in ${srcDir}${scope}.`
        : `${srcDir} is valid${scope}.`,
  );

  // A clean report that quietly skipped half the checks is worse than a noisy
  // one, so what did not run is always stated.
  for (const s of report.skipped) lines.push(`  not checked: ${s}`);

  return lines.join("\n");
}
