// `xspec check` (SPEC 12.2).
//
// Performs all build validations without accepting stale outputs — the
// analysis always parses the current sources (workspace/pipeline.ts), never
// answering from graph data — and additionally verifies:
//
// - generated files are content-identical to what the current sources and
//   configuration generate, and no recorded derived file remains at a path
//   no longer generated (SPEC 14.10, `check`-only; workspace/check.ts);
// - all dependency and text references resolve and are static, all
//   TypeScript spec references resolve, and no dependency or spec import
//   cycles exist (SPEC 14.5–14.9 — collected by the shared analysis);
// - the journal is well-formed and replayable with no conflicting mappings
//   (SPEC 14.13 — likewise);
// - no policy violations exist (SPEC 7.5 → 14.12, `check`-only;
//   core/policy.ts);
// - review sessions are not internally corrupt (SPEC 14.21, judged without
//   modifying anything; workspace/reviews.ts);
// - write paths a build would use traverse no symbolic link — reported
//   without writing (SPEC 14.22).
//
// `check` never refreshes (SPEC 13.3): it reports staleness instead of
// rewriting graph data, and it writes nothing whatsoever — every probe here
// is a read. Exits 1 on any finding; configuration validity is enforced at
// load by every command (SPEC 14.14) and is a usage error, not a finding.

import type { BuildOutputs } from "../../core/build.js";
import { computeBuildOutputs } from "../../core/build.js";
import type { ExitCode, Finding } from "../../core/findings.js";
import { evaluatePolicy } from "../../core/policy.js";
import { stalenessFindings } from "../../workspace/check.js";
import { loadGraphData } from "../../workspace/graph-data.js";
import {
  analyzeWorkspace,
  workspaceInputsOf,
} from "../../workspace/pipeline.js";
import { loadAllSessions } from "../../workspace/reviews.js";
import { symlinkWritePathFindings } from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import type { CommandContext } from "../io.js";
import { emitConfigurationErrors, emitFindingsReport } from "../report.js";

/** The `check` command handler (SPEC 12.2). */
export async function checkCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { workspace } = context;
  const analysis = await analyzeWorkspace(workspace);

  // SPEC 14.14/12.0: a discovery-level configuration error is a usage error
  // preceding all source analysis — exit 2, diagnostics on standard error,
  // and with `--json` an empty standard output.
  if (analysis.configurationErrors.length > 0) {
    emitConfigurationErrors(context.stderr, analysis.configurationErrors);
    return 2;
  }

  const findings: Finding[] = [...analysis.findings];

  // SPEC 14.10/14.22 — judged against the pure build derivation, which is
  // defined only for a workspace that passes build validation: with
  // findings present, "what the current sources and configuration
  // generate" is undefined and the validation errors mask staleness
  // (SPEC 14); the write set is equally undefined for 14.22.
  if (analysis.findings.length === 0) {
    const stored = await loadGraphData(workspace.root);
    const outputs: BuildOutputs = computeBuildOutputs(
      workspace.configuration,
      analysis.specs,
      analysis.graph,
      analysis.textModel,
      analysis.hashes,
      stored.data,
      workspaceInputsOf(workspace, analysis),
    );
    findings.push(
      ...(await stalenessFindings(workspace.root, outputs, stored)),
    );
    // SPEC 14.22: `check` reports a symbolic link in a write path without
    // writing — the same findings a `build` would refuse on.
    findings.push(
      ...(await symlinkWritePathFindings(workspace.root, outputs.writePaths)),
    );
  }

  // SPEC 7.5 → 14.12 (`check`-only): policy is evaluated over the workspace
  // graph — detectable, and therefore reported (SPEC 14), whether or not
  // other findings are present: every flagged edge is a resolved edge of
  // the current graph.
  findings.push(...evaluatePolicy(workspace.configuration, analysis.graph));

  // SPEC 14.21: review sessions are not internally corrupt — every session
  // is loaded read-only, in byte order of session name (SPEC 12.0), and
  // each corrupt one contributes its finding. Never modified (SPEC 13.4).
  for (const session of await loadAllSessions(workspace.root)) {
    if (session.state === "corrupt") {
      findings.push(session.finding);
    }
  }

  if (findings.length > 0) {
    // SPEC 12.2/12.0: exit 1 on any finding, the findings report on
    // standard output — with `--json`, the single JSON document.
    emitFindingsReport(invocation.json, context.stdout, findings);
    return 1;
  }
  if (invocation.json) {
    // SPEC 12.0: every command supports `--json`, emitting a single JSON
    // document — a clean check's report is its empty findings list.
    emitFindingsReport(true, context.stdout, []);
  }
  return 0;
}
