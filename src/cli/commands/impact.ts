// `xspec impact --base <git-ref>` (SPEC 9, 9.1–9.3): impact analysis of the
// current workspace against a baseline git ref.
//
// Flow (SPEC 9, 6.3, 12.0, 13.3):
//
// 1. Resolve the baseline — reconstruct and validate the workspace content
//    at the ref and compute the journal replay (workspace/baseline.ts). A
//    baseline that cannot be read or reconstructed is a usage error, exit 2,
//    and baseline resolution precedes source validation (SPEC 12.0): the
//    usage error is reported even when the current sources also fail build
//    validation.
// 2. Refresh-on-read of the current workspace (SPEC 13.3, cli/prepare.ts):
//    validation findings report and exit 1, nothing answered.
// 3. Derive the SPEC 5.6 change categories (core/changes.ts) and the report
//    content (core/impact.ts), and render it — human or `--json`, the same
//    information (SPEC 12.0).
//
// `impact` is informational: it exits 0 whether or not differences exist
// (SPEC 9.3, 12.0). All output is byte-deterministic for identical input
// (SPEC 12.0): graph content, the resolved baseline commit (a function of
// the repository input), and static text only.

import type { JsonObject } from "../../core/canonical-json.js";
import { deriveChangeCategories } from "../../core/changes.js";
import type { ExitCode } from "../../core/findings.js";
import type {
  ImpactedCodeReportEntry,
  ImpactReportData,
  ImpactRequirementReportEntry,
} from "../../core/impact.js";
import { deriveImpactReport } from "../../core/impact.js";
import { resolveBaseline } from "../../workspace/baseline.js";
import type { Invocation } from "../args.js";
import { flagValue } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { emitDocument, usageError } from "./common.js";

/** One impacted-code entry as JSON data (SPEC 9.3: location, the minimized
 * witness edge — sourced at the location — and the witness path). */
function codeEntryJson(entry: ImpactedCodeReportEntry): JsonObject {
  return {
    location: entry.location,
    edge: { from: entry.location, to: entry.edgeTarget, kind: entry.edgeKind },
    path: [...entry.path],
  };
}

/** One requirement entry as JSON data (SPEC 9.1, 9.3). */
function requirementEntryJson(entry: ImpactRequirementReportEntry): JsonObject {
  return {
    nodes: [...entry.nodes],
    deleted: entry.deleted,
    categories: entry.categories.map((category) => ({
      category: category.category,
      attributedTo: [...category.attributedTo],
    })),
  };
}

/** The single JSON document of `impact --json` (SPEC 12.0, 9.3). */
function impactJson(commit: string, report: ImpactReportData): JsonObject {
  return {
    baseline: commit,
    requirements: report.requirements.map(requirementEntryJson),
    code: {
      direct: report.code.direct.map(codeEntryJson),
      transitive: report.code.transitive.map(codeEntryJson),
    },
  };
}

/** SPEC 5.6 listing order — the report's group order (SPEC 9.3). */
const CATEGORY_ORDER = [
  "changed",
  "metadata-changed",
  "descendant-changed",
  "upstream-changed",
] as const;

/**
 * The human report (SPEC 9.3, 12.0: the same information as the JSON form):
 * the resolved baseline commit, the requirement entries grouped by category
 * — a multi-category node's entry appears under each of its categories,
 * collapsed chains as one line — and the directly and transitively impacted
 * code, each with its witness edge and propagation path.
 */
function renderImpactHuman(commit: string, report: ImpactReportData): string {
  let out = `baseline ${commit}\n`;
  for (const category of CATEGORY_ORDER) {
    const rows: string[] = [];
    for (const entry of report.requirements) {
      const match = entry.categories.find(
        (candidate) => candidate.category === category,
      );
      if (match === undefined) continue;
      const nodes = entry.nodes.join(", ");
      const deleted = entry.deleted ? " (deleted)" : "";
      const attribution = match.attributedTo.join(", ");
      rows.push(`  ${nodes}${deleted} — attributed to: ${attribution}\n`);
    }
    if (rows.length === 0) continue;
    out += `${category}:\n${rows.join("")}`;
  }
  const groups = [
    ["directly impacted code", report.code.direct],
    ["transitively impacted code", report.code.transitive],
  ] as const;
  for (const [heading, entries] of groups) {
    if (entries.length === 0) continue;
    out += `${heading}:\n`;
    for (const entry of entries) {
      out +=
        `  ${entry.location} — via ${entry.edgeKind} ${entry.edgeTarget}; ` +
        `path: ${entry.path.join(" -> ")}\n`;
    }
  }
  return out;
}

/** The `impact` command handler (SPEC 9, 9.1–9.3). */
export async function impactCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const ref = flagValue(invocation, "--base");
  if (ref === undefined) {
    // Unreachable: the parser enforces the required flag (SPEC 9, 12.0).
    throw new Error("xspec internal error: impact without --base");
  }

  // SPEC 6.3/12.0: baseline resolution precedes source validation — an
  // unresolvable baseline is a usage error (exit 2, stderr) even when the
  // current sources also fail build validation.
  const resolution = await resolveBaseline(context.workspace, ref);
  if (!resolution.ok) {
    return usageError(context.stderr, invocation.command, resolution.message);
  }
  const { baseline } = resolution;

  // SPEC 13.3: refresh-on-read, then answer.
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }
  const { analysis } = prepared;

  // SPEC 9: compare the current workspace graph against the baseline graph,
  // identities mapped through the journal (SPEC 6.3, 5.4) — each side's
  // hashes computed with that side's journal (core/changes.ts).
  const changes = deriveChangeCategories(
    {
      graph: baseline.analysis.graph,
      hashes: baseline.analysis.hashes,
      journal: baseline.analysis.journal.journal,
    },
    {
      graph: analysis.graph,
      hashes: analysis.hashes,
      journal: analysis.journal.journal,
    },
  );
  const report = deriveImpactReport(
    changes,
    baseline.analysis.graph,
    analysis.graph,
    baseline.replay,
  );

  if (invocation.json) {
    emitDocument(context.stdout, impactJson(baseline.commit, report));
  } else {
    context.stdout.write(renderImpactHuman(baseline.commit, report));
  }
  // SPEC 9.3/12.0: informational — exit 0 whether or not differences exist.
  return 0;
}
