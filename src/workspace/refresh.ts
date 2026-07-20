// Refresh-on-read — the shared pre-answer step of the graph-data-consuming
// commands (SPEC 13.3): `ids`, `show`, `coverage`, `impact`, `review`
// (every subcommand), and `query`.
//
// SPEC 13.3: read results never come from stale data. When graph data is
// missing or does not match the current sources and configuration, these
// commands refresh it — writing exactly what `xspec build` would write,
// except that no TypeScript or Markdown is generated or removed and the
// recorded derived-file paths are left unchanged — before answering. When
// the current sources fail `build` validation, they report the validation
// errors and exit 1 without answering and without modifying anything: a
// failed refresh, like a failed build (SPEC 12.1), leaves every derived
// file and all graph data unmodified.
//
// `check` never uses this step: it never refreshes and reports staleness
// instead (SPEC 13.3, 14.10) — it composes `analyzeWorkspace` and the
// core predicate itself. `build` regenerates rather than refreshes
// (SPEC 12.1). `rename`/`move` carry their own precedence rules (SPEC
// 12.0) and regenerate as `build` does (SPEC 6.4, 6.5).
//
// IMPLEMENTATION (Architecture): this workspace-layer module owns the I/O —
// the analysis pipeline (./pipeline.ts), the store load and the one write
// (./graph-data.ts) — and takes the refresh content and the staleness
// predicate from the pure core (core/graph-data.ts over core/build.ts:
// "what `xspec build` would write" is `computeBuildOutputs`' graph data,
// so refresh and build agree by construction, byte for byte — SPEC 12.0).

import { computeBuildOutputs } from "../core/build.js";
import type { Finding } from "../core/findings.js";
import type { GraphData } from "../core/graph-data.js";
import {
  GRAPH_DATA_PATH,
  graphDataMatchesCurrent,
  refreshedGraphData,
} from "../core/graph-data.js";
import type { LoadedWorkspace } from "./config.js";
import { loadGraphData, writeGraphData } from "./graph-data.js";
import type { WorkspaceAnalysis } from "./pipeline.js";
import { analyzeWorkspace } from "./pipeline.js";
import { symlinkWritePathFindings } from "./writes.js";

/** The outcome of the SPEC 13.3 pre-answer step. */
export type WorkspacePreparation =
  | {
      /**
       * The workspace is valid and the stored graph data now matches the
       * current sources and configuration — refreshed if it did not
       * (SPEC 13.3). Answer from `analysis`.
       */
      readonly kind: "ready";
      readonly analysis: WorkspaceAnalysis;
      /** The graph data as stored — current snapshot, retained record. */
      readonly graphData: GraphData;
    }
  | {
      /**
       * SPEC 13.3: the current sources fail `build` validation (or the
       * needed refresh write is refused, SPEC 14.22) — the command reports
       * these findings as its report (standard output, SPEC 12.0) and
       * exits 1 without answering; nothing was modified.
       */
      readonly kind: "findings";
      readonly findings: readonly Finding[];
    }
  | {
      /**
       * SPEC 14.14/12.0: discovery-level configuration errors — usage
       * class, diagnostics on standard error, exit 2, nothing modified,
       * and with `--json` an empty standard output.
       */
      readonly kind: "configuration";
      readonly errors: readonly Finding[];
    };

/**
 * The shared pre-answer step (SPEC 13.3): analyze the current workspace;
 * on validation findings or configuration errors, fail without modifying
 * anything; otherwise ensure the stored graph data matches the current
 * sources and configuration — refreshing it if missing or mismatched,
 * writing exactly what `xspec build` would write except that no TypeScript
 * or Markdown is generated or removed and the recorded derived-file paths
 * are left unchanged — and hand back the analysis to answer from.
 */
export async function prepareWorkspaceForRead(
  workspace: LoadedWorkspace,
): Promise<WorkspacePreparation> {
  const analysis = await analyzeWorkspace(workspace);
  if (analysis.configurationErrors.length > 0) {
    return { kind: "configuration", errors: analysis.configurationErrors };
  }
  if (analysis.findings.length > 0) {
    // SPEC 13.3: current sources fail build validation — report, exit 1,
    // answer nothing, modify nothing (the store has not even been read).
    return { kind: "findings", findings: analysis.findings };
  }

  const stored = await loadGraphData(workspace.root);
  // What `xspec build` would write for the current sources and
  // configuration (SPEC 13.3): the same pure derivation `build` runs
  // (SPEC 12.1), so the refreshed bytes match a real build's byte for byte
  // (SPEC 12.0 determinism). Only its graph data is consumed — the refresh
  // generates and removes no TypeScript or Markdown.
  const build = computeBuildOutputs(
    workspace.configuration,
    analysis.specs,
    analysis.graph,
    analysis.textModel,
    analysis.hashes,
    stored.data,
  ).graphData;

  if (graphDataMatchesCurrent(stored.bytes, stored.data, build)) {
    // Matching data is served as is — no write, nothing modified.
    return {
      kind: "ready",
      analysis,
      graphData: refreshedGraphData(stored.data, build),
    };
  }

  // SPEC 14.22: the refresh writes exactly one path; a symbolic link at a
  // workspace-relative directory component refuses the write, reported
  // before anything is modified — the command cannot answer from stale
  // data (SPEC 13.3), so it fails with the finding (exit 1).
  const writeFindings = await symlinkWritePathFindings(workspace.root, [
    GRAPH_DATA_PATH,
  ]);
  if (writeFindings.length > 0) {
    return { kind: "findings", findings: writeFindings };
  }

  const graphData = refreshedGraphData(stored.data, build);
  await writeGraphData(workspace.root, graphData);
  return { kind: "ready", analysis, graphData };
}
