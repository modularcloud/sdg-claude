// `xspec rename <file> <old-id> <new-id>` (SPEC 6.4).
//
// Renames a requirement ID, rewrites descendant IDs by prefix replacement,
// rewrites every reference to the affected identities across all configured
// spec and code sources, appends the mapping to the journal (SPEC 6.1), and
// finishes by regenerating derived files exactly as `xspec build` does
// (SPEC 12.1) — which cannot fail, because rename only ever rewrites a
// valid workspace.
//
// Outcome precedence (SPEC 6.4, 12.0, 13.5, 14):
//
// 1. Workspace exclusivity (SPEC 13.5): `rename` is a mutating command —
//    while another one runs, it fails promptly with a usage error (exit 2)
//    modifying nothing; with `--test-hold <path>`, the hold file is created
//    immediately after acquiring exclusivity and before modifying anything,
//    and the command proceeds only once it has been deleted.
// 2. Configuration errors (SPEC 14.14): usage class, exit 2, preceding all
//    source analysis.
// 3. Argument existence (SPEC 6.4 → 12.0): a `<file>` that is not a
//    discovered spec source, or an old ID absent from the origin file, is a
//    usage error (exit 2) — checked before source validation, so it is
//    reported even when the sources also fail build validation. One
//    exception (SPEC 12.0, 14): an old ID inside an unparseable origin
//    file (14.20) is masked — the validation findings are reported and the
//    command exits 1.
// 4. Valid-workspace precondition (SPEC 6.4): when the current workspace
//    fails the validations of `xspec build`, the rename refuses (exit 1)
//    before modifying anything, reporting those findings.
// 5. New-ID validation (SPEC 6.4): the new ID must be valid (1.4), differ
//    from the old ID, collide with no existing ID, and keep the structural
//    parent rules (1.3); each failure refuses the rename (exit 1) before
//    modifying anything.
// 6. The rewritten workspace is re-validated in memory — realizing "all
//    rewritten references resolve" — and the complete write set passes the
//    SPEC 14.22 symlink check; any finding refuses (exit 1) before
//    modifying anything.
//
// Success writes the rewritten sources, appends the journal entry, and
// regenerates; the report is the (empty) findings list — with `--json`, the
// single JSON document (SPEC 12.0).

import { computeBuildOutputs } from "../../core/build.js";
import { canonicalJson } from "../../core/canonical-json.js";
import type { ExitCode, Finding } from "../../core/findings.js";
import { JOURNAL_PATH, serializeJournalEntry } from "../../core/journal.js";
import type { SpecSection } from "../../core/mdx.js";
import type { RenamePlan } from "../../core/rename.js";
import { planRename } from "../../core/rename.js";
import { executeBuildOutputs } from "../../workspace/build.js";
import type { LoadedWorkspace } from "../../workspace/config.js";
import { loadGraphData } from "../../workspace/graph-data.js";
import {
  appendJournalEntry,
  journalFromBytes,
  readJournalBytes,
} from "../../workspace/journal.js";
import { withMutationExclusivity } from "../../workspace/lock.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import {
  analyzeWorkspace,
  analyzeWorkspaceContent,
  workspaceInputsOf,
} from "../../workspace/pipeline.js";
import {
  symlinkWritePathFindings,
  writeSourceFile,
} from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import type { CliWriter, CommandContext } from "../io.js";
import { emitConfigurationErrors, emitFindingsReport } from "../report.js";
import { requirementIdProblem, testHoldSpecOf, usageError } from "./common.js";

/**
 * SPEC 6.4/12.0: a refused rename is a validation failure — exit 1, the
 * refusal report on standard output (SPEC 12.0: reports are standard-output
 * content; with `--json`, one JSON document as the entire standard output).
 */
function emitRefusal(
  json: boolean,
  stdout: CliWriter,
  message: string,
): ExitCode {
  if (json) {
    stdout.write(canonicalJson({ refused: { command: "rename", message } }));
  } else {
    stdout.write(`rename refused: ${message}\n`);
  }
  return 1;
}

/** SPEC 6.4: refusals reported as findings (workspace validation, 14.22). */
function emitFindingsRefusal(
  json: boolean,
  stdout: CliWriter,
  findings: readonly Finding[],
): ExitCode {
  emitFindingsReport(json, stdout, findings);
  return 1;
}

/**
 * SPEC 6.4 → 1.3: the renamed section keeps its place in the tree, so the
 * new ID must satisfy the structural parent rules at that place — the
 * parent's ID plus `"."` plus exactly one segment, or exactly one segment
 * for a top-level section. Returns the refusal message, or null when the
 * rule holds.
 */
function structuralProblem(section: SpecSection, newId: string): string | null {
  const parentId = section.parent === null ? null : section.parent.id;
  if (parentId === null) {
    // A top-level section (its parent is the implicit root, SPEC 1.2) is
    // checked against the empty prefix: exactly one segment (SPEC 1.3).
    if (newId.includes(".")) {
      return (
        `the renamed section is top-level, so its ID must be exactly one ` +
        `segment (SPEC 1.3) — ${JSON.stringify(newId)} has more`
      );
    }
    return null;
  }
  const prefix = `${parentId}.`;
  if (!newId.startsWith(prefix) || newId.slice(prefix.length).includes(".")) {
    return (
      `the renamed section is nested inside ${JSON.stringify(parentId)}, so ` +
      `its ID must equal ${JSON.stringify(parentId)} plus "." plus exactly ` +
      `one segment (SPEC 1.3)`
    );
  }
  return null;
}

/** Concatenate byte arrays (the hypothetical post-append journal bytes). */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The rename operation, run under workspace exclusivity (SPEC 13.5). */
async function runRename(
  invocation: Invocation,
  context: CommandContext,
  file: string,
  oldId: string,
  newId: string,
): Promise<ExitCode> {
  const { workspace, stdout, stderr } = context;
  const analysis = await analyzeWorkspace(workspace);

  // SPEC 14.14/12.0: configuration errors precede all source analysis —
  // usage class, exit 2, diagnostics on standard error, nothing modified.
  if (analysis.configurationErrors.length > 0) {
    emitConfigurationErrors(stderr, analysis.configurationErrors);
    return 2;
  }

  // SPEC 6.4 → 12.0: the argument existence checks precede source
  // validation. `<file>` must name a discovered spec source
  // (workspace-relative, SPEC 12.0, 1.5; byte-wise comparison).
  if (!analysis.classification.specSources.some((s) => s.path === file)) {
    return usageError(
      stderr,
      invocation.command,
      `unknown file '${file}' — <file> must name a discovered source file ` +
        `of a configured spec group, workspace-relative (SPEC 6.4, 12.0)`,
    );
  }

  // SPEC 12.0/14: an old ID inside an unparseable origin file (14.20) is
  // masked — the origin was discovered but yielded no document, so the
  // validation findings are reported and the command exits 1.
  const origin = analysis.specs.find((s) => s.document.path === file);
  if (origin === undefined) {
    return emitFindingsRefusal(invocation.json, stdout, analysis.findings);
  }

  // SPEC 6.4 → 12.0: a nonexistent old ID is a usage error, checked before
  // source validation.
  const section = origin.document.sections.find((s) => s.id === oldId);
  if (section === undefined) {
    return usageError(
      stderr,
      invocation.command,
      `unknown ID '${oldId}' in '${file}' — <old-id> must name an existing ` +
        `requirement ID of that file (SPEC 6.4, 12.0)`,
    );
  }

  // SPEC 6.4: refuse, before modifying anything, when the current workspace
  // fails the validations of `xspec build` — rename only ever rewrites a
  // valid workspace. The findings are the report (SPEC 12.0).
  if (analysis.findings.length > 0) {
    return emitFindingsRefusal(invocation.json, stdout, analysis.findings);
  }

  // SPEC 6.4: validate the new ID — each failure refuses (exit 1), nothing
  // modified.
  if (newId === oldId) {
    return emitRefusal(
      invocation.json,
      stdout,
      `the new ID must differ from the old ID ${JSON.stringify(oldId)} ` +
        `(SPEC 6.4)`,
    );
  }
  const invalid = requirementIdProblem(newId);
  if (invalid !== null) {
    return emitRefusal(
      invocation.json,
      stdout,
      `the new ID ${JSON.stringify(newId)} is not a valid requirement ID: ` +
        `${invalid} (SPEC 1.4, 6.4)`,
    );
  }
  const structural = structuralProblem(section, newId);
  if (structural !== null) {
    return emitRefusal(invocation.json, stdout, `${structural} (SPEC 6.4)`);
  }
  if (origin.document.sections.some((s) => s.id === newId)) {
    return emitRefusal(
      invocation.json,
      stdout,
      `the new ID ${JSON.stringify(newId)} collides with an existing ID in ` +
        `'${file}' — IDs are unique within a source file (SPEC 1.3, 6.4)`,
    );
  }

  // The pure plan: the identity mapping, the journal entry, and the minimal
  // in-place rewrites of every affected source (SPEC 6.4, 6.1).
  const plan = planRename(analysis.specs, analysis.code, file, oldId, newId);

  // Re-validate the rewritten workspace in memory before touching anything
  // (SPEC 6.4: structural rules remain satisfied and all rewritten
  // references resolve; the finishing regeneration cannot fail). The
  // journal is modeled as it will stand after the append — hashes take the
  // journal as an input (SPEC 5.4), so the regenerated graph data matches a
  // fresh build of the rewritten workspace byte for byte (SPEC 6.4, 12.0).
  const rewritten = await reanalyzeRewritten(workspace, analysis, plan);
  if (rewritten.configurationErrors.length > 0) {
    // Unreachable: the configuration and file set are unchanged. Guarded so
    // a regression reports rather than corrupts.
    emitConfigurationErrors(stderr, rewritten.configurationErrors);
    return 2;
  }
  if (rewritten.findings.length > 0) {
    // SPEC 6.4: the rewrite would not leave a valid workspace — refuse with
    // the would-be findings, nothing modified.
    return emitFindingsRefusal(invocation.json, stdout, rewritten.findings);
  }

  // SPEC 6.4/12.1: the finishing regeneration's outputs, derived exactly as
  // `xspec build` derives them — over the rewritten analyses.
  const stored = await loadGraphData(workspace.root);
  const outputs = computeBuildOutputs(
    workspace.configuration,
    rewritten.specs,
    rewritten.graph,
    rewritten.textModel,
    rewritten.hashes,
    stored.data,
    // SPEC 13.3/6.4: the regenerated store records the rewritten workspace's
    // inputs — the rewritten source bytes and the journal as it will stand
    // after the append (reanalyzeRewritten models exactly those bytes).
    workspaceInputsOf(workspace, rewritten),
  );

  // SPEC 14.22: validate the complete write set — rewritten sources, the
  // journal, and every regenerated file — before modifying anything.
  const writeFindings = await symlinkWritePathFindings(workspace.root, [
    ...plan.rewrites.map((rewrite) => rewrite.path),
    JOURNAL_PATH,
    ...outputs.writePaths,
  ]);
  if (writeFindings.length > 0) {
    return emitFindingsRefusal(invocation.json, stdout, writeFindings);
  }

  // All validation passed — modify: rewrite the sources (atomic per file,
  // SPEC 13.5), append the mapping to the journal (SPEC 6.1, 6.4), and
  // regenerate derived files exactly as `xspec build` does (SPEC 6.4).
  for (const rewrite of plan.rewrites) {
    await writeSourceFile(workspace.root, rewrite.path, rewrite.content);
  }
  await appendJournalEntry(workspace.root, plan.entry);
  await executeBuildOutputs(workspace.root, outputs);

  if (invocation.json) {
    // SPEC 12.0: one JSON document as the entire standard output — the
    // successful rename's report is its (empty) findings list, as for
    // `build` (SPEC 12.1).
    emitFindingsReport(true, stdout, []);
  }
  return 0;
}

/**
 * Analyze the rewritten workspace entirely in memory: the same classified
 * file set, sources served from the rewrite plan (unaffected ones from the
 * already-analyzed text), and the journal as it will stand after the append
 * (SPEC 6.4, 5.4).
 */
async function reanalyzeRewritten(
  workspace: LoadedWorkspace,
  analysis: WorkspaceAnalysis,
  plan: RenamePlan,
): Promise<WorkspaceAnalysis> {
  const encoder = new TextEncoder();
  const byPath = new Map<string, Uint8Array>();
  for (const spec of analysis.specs) {
    byPath.set(spec.document.path, encoder.encode(spec.document.text));
  }
  for (const code of analysis.code) {
    byPath.set(code.path, encoder.encode(code.text));
  }
  for (const rewrite of plan.rewrites) {
    byPath.set(rewrite.path, rewrite.content);
  }
  const currentJournal = await readJournalBytes(workspace.root);
  const entryLine = encoder.encode(serializeJournalEntry(plan.entry) + "\n");
  const journalBytes = concatBytes(
    currentJournal === null ? [entryLine] : [currentJournal, entryLine],
  );
  return analyzeWorkspaceContent(workspace.configuration, {
    classification: analysis.classification,
    readSource: (rel) => Promise.resolve(byPath.get(rel) ?? null),
    loadJournal: () => Promise.resolve(journalFromBytes(journalBytes)),
  });
}

/** The `rename` command handler (SPEC 6.4). */
export async function renameCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const [file, oldId, newId] = invocation.positionals;
  if (file === undefined || oldId === undefined || newId === undefined) {
    // Unreachable: the parser enforces the three positionals (SPEC 6.4).
    throw new Error("xspec internal error: rename without its arguments");
  }
  // SPEC 13.5: workspace exclusivity around the whole operation, with the
  // `--test-hold` seam immediately after acquisition; a workspace held by
  // another mutating command fails promptly as a usage error (12.0),
  // modifying nothing.
  const outcome = await withMutationExclusivity(
    context.workspace.root,
    testHoldSpecOf(invocation, context.cwd),
    () => runRename(invocation, context, file, oldId, newId),
  );
  if (!outcome.ok) {
    return usageError(context.stderr, invocation.command, outcome.usageMessage);
  }
  return outcome.value;
}
