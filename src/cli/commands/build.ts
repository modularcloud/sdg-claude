// `xspec build` (SPEC 12.1).
//
// Parses configured sources; validates section structure, IDs, tags, and
// references; resolves dependencies; generates TypeScript modules (13.1);
// optionally emits Markdown (13.2); and writes graph data (13.3). `build`
// does not evaluate policy: policy violations are `check` findings (7.5,
// 14.12), and build succeeds and regenerates output whether or not policy is
// satisfied — the pipeline collects no policy findings. Rebuilding
// regenerates every derived file and removes recorded derived files that the
// current sources and configuration no longer generate (13.3, 13.4). A build
// that fails — validation errors (exit 1, findings on standard output) or a
// configuration error (exit 2, diagnostics on standard error) — modifies
// nothing: every write happens strictly after all validation, including the
// SPEC 14.22 pre-write check over the complete write set.

import type { BuildOutputs } from "../../core/build.js";
import { computeBuildOutputs } from "../../core/build.js";
import type { ExitCode } from "../../core/findings.js";
import { executeBuildOutputs } from "../../workspace/build.js";
import { loadGraphData } from "../../workspace/graph-data.js";
import { analyzeWorkspace } from "../../workspace/pipeline.js";
import { symlinkWritePathFindings } from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import type { CommandContext } from "../io.js";
import { emitConfigurationErrors, emitFindingsReport } from "../report.js";

/** The `build` command handler (SPEC 12.1). */
export async function buildCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { workspace } = context;
  const analysis = await analyzeWorkspace(workspace);

  // SPEC 14.14/12.0: a discovery-level configuration error (a file matched
  // by both a spec and a code group, 7.2) is a usage error preceding all
  // source analysis — exit 2, diagnostics on standard error, nothing
  // modified, and with `--json` an empty standard output.
  if (analysis.configurationErrors.length > 0) {
    emitConfigurationErrors(context.stderr, analysis.configurationErrors);
    return 2;
  }

  const findings = [...analysis.findings];
  let outputs: BuildOutputs | null = null;
  if (findings.length === 0) {
    // Valid workspace: derive the complete output set (core), then validate
    // every write path before touching anything (SPEC 14.22: a symbolic
    // link at a workspace-relative directory component of a path xspec
    // writes refuses the write, reported before anything is modified).
    const stored = await loadGraphData(workspace.root);
    outputs = computeBuildOutputs(
      workspace.configuration,
      analysis.specs,
      analysis.graph,
      analysis.textModel,
      analysis.hashes,
      stored.data,
    );
    findings.push(
      ...(await symlinkWritePathFindings(workspace.root, outputs.writePaths)),
    );
  }

  if (findings.length > 0) {
    // SPEC 12.1/12.0: a failing build's validation errors are the report —
    // standard-output content, exit 1 — and the build modifies nothing.
    emitFindingsReport(invocation.json, context.stdout, findings);
    return 1;
  }

  // outputs is non-null here: it is computed exactly when the analysis had
  // no findings, and the 14.22 check added none.
  if (outputs === null) {
    throw new Error("xspec internal error: build outputs missing");
  }
  await executeBuildOutputs(workspace.root, outputs);
  if (invocation.json) {
    // SPEC 12.0: every command supports `--json`, emitting a single JSON
    // document — a successful build's report is its (empty) findings list.
    emitFindingsReport(true, context.stdout, []);
  }
  return 0;
}
