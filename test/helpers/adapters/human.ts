// H-3 output adapters — the human-report side. SPEC.md fixes the information
// content of human-readable reports, never their wording, so human output is
// asserted only for required information via robust matching (H-3): a test
// names the identities, paths, counts, and condition numbers a report must
// carry, and this module checks each is mentioned — never exact wording,
// never line formats. Missing required information fails loudly (a diagnosed
// test error, S-5), exactly like the JSON decoders beside this module.

import type { RunResult } from "../subprocess.js";
import { fail } from "../assertions.js";

/**
 * One required piece of information: a literal substring (identities, paths,
 * names, counts rendered as digits) or a pattern where a literal would
 * over- or under-match.
 */
export type Mention = string | RegExp;

function textOf(output: string | RunResult): string {
  return typeof output === "string" ? output : output.stdout;
}

function describeMention(mention: Mention): string {
  return typeof mention === "string"
    ? JSON.stringify(mention)
    : `pattern ${mention.toString()}`;
}

function mentionFound(text: string, mention: Mention): boolean {
  if (typeof mention === "string") return text.includes(mention);
  // A fresh lastIndex per test: global/sticky flags on a caller's pattern
  // must not make matching stateful across mentions.
  return new RegExp(mention.source, mention.flags.replace(/[gy]/g, "")).test(
    text,
  );
}

const EXCERPT_LIMIT = 2048;

function excerpt(text: string): string {
  if (text.length === 0) return "<empty>";
  const clipped = text.slice(0, EXCERPT_LIMIT);
  return text.length > EXCERPT_LIMIT
    ? `${JSON.stringify(clipped)}… (${String(text.length)} chars total)`
    : JSON.stringify(clipped);
}

/**
 * Assert a human report mentions every required piece of information
 * (robust matching, H-3). Accepts the report text or a RunResult (its
 * stdout — reports and findings are standard-output content, 12.0). Fails
 * diagnosed, listing every missing mention with an excerpt of the report.
 */
export function assertReportMentions(
  output: string | RunResult,
  mentions: readonly Mention[],
  context: string,
): void {
  if (mentions.length === 0) {
    fail(
      `${context}: assertReportMentions called with no mentions — a human-report assertion must name the required information it checks (H-3)`,
    );
  }
  const text = textOf(output);
  const missing = mentions.filter((mention) => !mentionFound(text, mention));
  if (missing.length === 0) return;
  const where =
    typeof output === "string"
      ? "report text"
      : `stdout of ${output.commandLine}`;
  fail(
    `${context}: required information missing from the human report (H-3: information presence, never exact wording).\n` +
      `Missing: ${missing.map(describeMention).join(", ")}\n` +
      `From ${where}: ${excerpt(text)}`,
  );
}

/**
 * A robust pattern for a SPEC.md 14 condition identity in a human report:
 * matches `14.2` as a standalone number, not inside `14.20` or `114.2`.
 * (A bare substring check cannot make this distinction.)
 */
export function conditionMention(condition: string): RegExp {
  if (!/^14\.[1-9][0-9]*$/.test(condition)) {
    fail(
      `conditionMention: ${JSON.stringify(condition)} is not a SPEC.md 14 condition identity ("14.<n>")`,
    );
  }
  const escaped = condition.replace(/\./g, "\\.");
  // Trailing: no further digit (`14.2` must not match inside `14.20`); a
  // trailing period is fine — reports may end a sentence with the number.
  return new RegExp(`(?:^|[^0-9.])${escaped}(?![0-9])`);
}
