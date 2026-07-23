// Findings-report rendering (SPEC 12.0, 14).
//
// IMPLEMENTATION (cross-cutting rules): reports are built as data (the
// Finding model, core/findings.ts) and rendered once per output form —
// human and JSON — by this CLI layer. SPEC 12.0: the report, findings
// included (a failing `build`'s validation errors and `check` findings are
// reports), is standard-output content; with `--json` the single JSON
// document is the entire standard output. Usage and configuration error
// messages (exit 2) are standard-error content; the exit-2 renderer for
// them lives here too so every command reports them identically.
//
// All rendering is byte-deterministic for identical findings (SPEC 12.0):
// static text, workspace-relative paths, and byte offsets only — no
// absolute paths, no wall clock, no environment-dependent content.

import { canonicalJson } from "../core/canonical-json.js";
import type { JsonObject, JsonValue } from "../core/canonical-json.js";
import type { ConditionNumber, Finding } from "../core/findings.js";
import { conditionName } from "../core/findings.js";
import type { CliWriter } from "./io.js";

/** The SPEC 14 condition identity of a finding (`3` → `"14.3"`). */
export function conditionIdentity(condition: ConditionNumber): string {
  return `14.${String(condition)}`;
}

/**
 * One finding as a human report line (SPEC 14: actionable — file, location,
 * and correction): `FILE:START-END: NAME (14.N): MESSAGE — CORRECTION`.
 * Location falls back to `line[:column]` when the finding carries no byte
 * range; both parts are omitted when absent.
 */
function renderFindingLine(finding: Finding): string {
  let location = "";
  if (finding.file !== undefined) {
    location = finding.file;
    if (finding.range !== undefined) {
      location += `:${String(finding.range.start)}-${String(finding.range.end)}`;
    } else if (finding.line !== undefined) {
      location += `:${String(finding.line)}`;
      if (finding.column !== undefined) {
        location += `:${String(finding.column)}`;
      }
    }
    location += ": ";
  }
  const label =
    `${conditionName(finding.condition)} ` +
    `(${conditionIdentity(finding.condition)})`;
  const correction =
    finding.correction === undefined ? "" : ` — ${finding.correction}`;
  return `${location}${label}: ${finding.message}${correction}\n`;
}

/**
 * The human findings report: one line per finding, in the given (already
 * deterministic) order, closed by a one-line count. Standard-output content
 * (SPEC 12.0).
 */
export function renderFindingsHuman(findings: readonly Finding[]): string {
  const lines = findings.map(renderFindingLine);
  const count = findings.length;
  lines.push(`${String(count)} finding${count === 1 ? "" : "s"}\n`);
  return lines.join("");
}

/** One finding as JSON data — the same information as the human line. */
function findingToJson(finding: Finding): JsonObject {
  return {
    condition: conditionIdentity(finding.condition),
    message: finding.message,
    correction: finding.correction,
    file: finding.file,
    location:
      finding.range === undefined
        ? undefined
        : { start: finding.range.start, end: finding.range.end },
    line: finding.line,
    column: finding.column,
    cycle: finding.cycle === undefined ? undefined : [...finding.cycle],
    // SPEC 7.5 → 14.12: a policy violation carries the rule name and the
    // offending edge; the JSON form holds the same information as the
    // human message (SPEC 12.0), structured.
    rule: finding.rule,
    edge:
      finding.edge === undefined
        ? undefined
        : {
            from: finding.edge.source,
            to: finding.edge.target,
            kind: finding.edge.kind,
          },
  };
}

/**
 * The findings report as the single JSON document of `--json` (SPEC 12.0:
 * same information as the human report; the canonical serializer keeps it
 * byte-deterministic). An empty findings list is the exit-0 document of a
 * command whose report is its findings (`build`, `check`).
 */
export function findingsReportJson(findings: readonly Finding[]): string {
  const document: JsonValue = { findings: findings.map(findingToJson) };
  return canonicalJson(document);
}

/**
 * Emit the findings report in the invocation's output form (SPEC 12.0): the
 * whole report on standard output — with `--json`, exactly one JSON
 * document.
 */
export function emitFindingsReport(
  json: boolean,
  stdout: CliWriter,
  findings: readonly Finding[],
): void {
  stdout.write(
    json ? findingsReportJson(findings) : renderFindingsHuman(findings),
  );
}

/**
 * SPEC 12.0/14.14: render one configuration-error finding as a diagnostic
 * line. Configuration errors are usage errors: the message is
 * standard-error content, and standard output stays empty.
 */
export function renderConfigurationError(finding: Finding): string {
  const location =
    finding.file === undefined
      ? ""
      : finding.line === undefined
        ? `${finding.file}: `
        : `${finding.file}:${String(finding.line)}: `;
  return `xspec: ${conditionName(finding.condition)}: ${location}${finding.message}\n`;
}

/**
 * Report configuration errors (SPEC 14.14) the way every command must: each
 * as a standard-error diagnostic line, standard output untouched (with
 * `--json`, the exit-2 error prevents emitting the single JSON document, so
 * standard output stays empty — SPEC 12.0). The caller exits 2.
 */
export function emitConfigurationErrors(
  stderr: CliWriter,
  findings: readonly Finding[],
): void {
  for (const finding of findings) {
    stderr.write(renderConfigurationError(finding));
  }
}
