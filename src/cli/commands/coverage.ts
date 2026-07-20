// `xspec coverage` (SPEC 8.2): coverage reports over the configured
// profiles.
//
// `coverage` runs all profiles; `coverage <name>` runs one — an unknown
// profile named in arguments is a usage error, exit 2 (SPEC 12.0), checked
// against the configuration before source analysis like the configuration
// errors of 14.14 (the pattern of `query nodes --group`). The answer comes
// from the refreshed graph (SPEC 13.3, via cli/prepare.ts).
//
// The report carries, per profile: counts of required, covered, uncovered,
// and ignored nodes; the identity of every covered, uncovered, and ignored
// node; one shortest covering path per covered node (SPEC 12.0 byte tie
// rule); and each ignored node's exclusion reasons — all that apply, in the
// fixed SPEC 8.2 order. With `--check`, the command exits 1 if any required
// node is uncovered — a findings outcome (SPEC 12.0) whose report is still
// the standard-output content; the information never changes with the flag.
// `--json` emits the same information as the single JSON document.

import type { JsonObject } from "../../core/canonical-json.js";
import type { CoverageProfile } from "../../core/config.js";
import type { ProfileCoverage } from "../../core/coverage.js";
import { evaluateCoverageProfile } from "../../core/coverage.js";
import type { ExitCode } from "../../core/findings.js";
import type { Invocation } from "../args.js";
import { flagPresent } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { emitDocument, usageError } from "./common.js";

/** One profile's report as JSON data (SPEC 8.2: the same information). */
function profileJson(result: ProfileCoverage): JsonObject {
  return {
    name: result.name,
    // SPEC 8.2: counts of required, covered, uncovered, and ignored nodes.
    counts: {
      required: result.requiredCount,
      covered: result.covered.length,
      uncovered: result.uncovered.length,
      ignored: result.ignored.length,
    },
    covered: result.covered.map((row) => ({
      identity: row.identity,
      path: [...row.path],
    })),
    uncovered: [...result.uncovered],
    ignored: result.ignored.map((row) => ({
      identity: row.identity,
      reasons: [...row.reasons],
    })),
  };
}

/**
 * The human report (SPEC 8.2, 12.0: the same information as the JSON form):
 * per profile the counts, every covered node with its covering path, every
 * uncovered identity, and every ignored identity with its reasons in the
 * fixed order. Byte-deterministic: graph content and static text only.
 */
function renderCoverageHuman(results: readonly ProfileCoverage[]): string {
  let out = "";
  for (const result of results) {
    out += `profile ${result.name}\n`;
    out +=
      `  required: ${String(result.requiredCount)}, ` +
      `covered: ${String(result.covered.length)}, ` +
      `uncovered: ${String(result.uncovered.length)}, ` +
      `ignored: ${String(result.ignored.length)}\n`;
    out += `  covered:\n`;
    for (const row of result.covered) {
      out += `    ${row.identity}\n`;
      out += `      path: ${row.path.join(" -> ")}\n`;
    }
    out += `  uncovered:\n`;
    for (const identity of result.uncovered) {
      out += `    ${identity}\n`;
    }
    out += `  ignored:\n`;
    for (const row of result.ignored) {
      out += `    ${row.identity}: ${row.reasons.join("; ")}\n`;
    }
  }
  return out;
}

/** The `coverage` command handler (SPEC 8.2). */
export async function coverageCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { stdout, stderr } = context;
  const { configuration } = context.workspace;

  // SPEC 8.2/12.0: `coverage <name>` runs one profile; an unknown profile
  // name is a usage error. A configuration-level check, preceding source
  // analysis like its 14.14 counterparts.
  let profiles: readonly CoverageProfile[] = configuration.coverage;
  if (invocation.positionals.length > 0) {
    const name = invocation.positionals[0];
    const named = configuration.coverage.find(
      (candidate) => candidate.name === name,
    );
    if (named === undefined) {
      return usageError(
        stderr,
        invocation.command,
        `unknown profile '${name}' — no configured coverage profile has ` +
          `that name (SPEC 8.2, 7.4, 12.0)`,
      );
    }
    profiles = [named];
  }

  // SPEC 13.3: refresh-on-read, then answer.
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }
  const { analysis } = prepared;

  const results = profiles.map((profile) =>
    evaluateCoverageProfile(analysis.graph, configuration, profile),
  );

  if (invocation.json) {
    emitDocument(stdout, { profiles: results.map(profileJson) });
  } else {
    stdout.write(renderCoverageHuman(results));
  }

  // SPEC 8.2: with `--check`, exit 1 if any required node is uncovered —
  // over exactly the profiles this invocation ran. Without it, coverage is
  // informational: exit 0 (SPEC 12.0).
  if (
    flagPresent(invocation, "--check") &&
    results.some((result) => result.uncovered.length > 0)
  ) {
    return 1;
  }
  return 0;
}
