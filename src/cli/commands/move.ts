// `xspec move <old-file> <new-file>` /
// `xspec move <file>#<id> <target-file>#<new-id>` (SPEC 6.5).
//
// The file form relocates a source file: IDs unchanged, identities changed
// only in their file part; the moved file's own import specifiers and other
// files' imports of its generated module rewritten so all references
// resolve; the full mapping appended to the journal (SPEC 6.1); finishing
// regeneration exactly as `xspec build` (SPEC 12.1, 6.4) — which cannot
// fail, because move only ever rewrites a valid workspace. The form is
// selected by the origin argument: an origin containing `#` names a section
// (the second form), a bare origin names a file.
//
// Outcome precedence (SPEC 6.5, 6.4, 12.0, 13.5, 14):
//
// 1. Workspace exclusivity (SPEC 13.5): `move` is a mutating command — while
//    another one runs, it fails promptly with a usage error (exit 2)
//    modifying nothing; with `--test-hold <path>`, the hold file is created
//    immediately after acquiring exclusivity and before modifying anything,
//    and the command proceeds only once it has been deleted.
// 2. Configuration errors (SPEC 14.14): usage class, exit 2, preceding all
//    source analysis.
// 3. Argument existence (SPEC 6.5 → 12.0): a nonexistent origin file (either
//    form) or origin ID is a usage error (exit 2) — checked before source
//    validation, so it is reported even when the sources also fail build
//    validation. One exception (SPEC 12.0, 14): an origin ID inside an
//    unparseable origin file (14.20) is masked — the validation findings are
//    reported and the command exits 1.
// 4. Valid-workspace precondition (SPEC 6.5 → 6.4): when the current
//    workspace fails the validations of `xspec build`, the move refuses
//    (exit 1) before modifying anything, reporting those findings.
// 5. Move-specific refusals (SPEC 6.5), each exit 1 before modifying
//    anything — for the file form: a destination path that is not valid
//    UTF-8, contains `#`, is not a well-formed workspace-relative path,
//    already exists, belongs to no configured spec group, belongs to a code
//    group as well (14.14), would be excluded as a derived-file path (13.4),
//    or lacks the `.mdx` extension (14.19).
// 6. The rewritten workspace is re-validated in memory — realizing "all
//    rewritten references resolve" and the no-new-cycles rule — and the
//    complete write set passes the SPEC 14.22 symlink check; any finding
//    refuses (exit 1) before modifying anything.
//
// The section form's rewrite engine is not built yet (FIX_PLAN T28): past
// the shared checks above it refuses (exit 1) modifying nothing.
//
// Success writes the rewritten sources, removes the origin, appends the
// journal entry, and regenerates; the report is the (empty) findings list —
// with `--json`, the single JSON document (SPEC 12.0).

import * as path from "node:path";
import { computeBuildOutputs } from "../../core/build.js";
import { compareBytes } from "../../core/bytes.js";
import { canonicalJson } from "../../core/canonical-json.js";
import type { Configuration } from "../../core/config.js";
import type {
  DiscoveredSource,
  SourceClassification,
} from "../../core/discovery.js";
import type { ExitCode, Finding } from "../../core/findings.js";
import { JOURNAL_PATH, serializeJournalEntry } from "../../core/journal.js";
import type { MoveFilePlan } from "../../core/move.js";
import { planMoveFile } from "../../core/move.js";
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
} from "../../workspace/pipeline.js";
import { classifyOccupant } from "../../workspace/writes.js";
import {
  removeSourceFile,
  symlinkWritePathFindings,
  writeSourceFile,
} from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import { isValidUtf8ArgumentValue } from "../args.js";
import type { CliWriter, CommandContext } from "../io.js";
import { emitConfigurationErrors, emitFindingsReport } from "../report.js";
import { testHoldSpecOf, usageError } from "./common.js";

/**
 * SPEC 6.5/12.0: a refused move is a validation failure — exit 1, the
 * refusal report on standard output (SPEC 12.0: reports are standard-output
 * content; with `--json`, one JSON document as the entire standard output).
 */
function emitRefusal(
  json: boolean,
  stdout: CliWriter,
  message: string,
): ExitCode {
  if (json) {
    stdout.write(canonicalJson({ refused: { command: "move", message } }));
  } else {
    stdout.write(`move refused: ${message}\n`);
  }
  return 1;
}

/** SPEC 6.5: refusals reported as findings (workspace validation, 14.22). */
function emitFindingsRefusal(
  json: boolean,
  stdout: CliWriter,
  findings: readonly Finding[],
): ExitCode {
  emitFindingsReport(json, stdout, findings);
  return 1;
}

/** The parsed shape of one `move` argument: a bare file, or `file#id`. */
interface MoveArgument {
  readonly file: string;
  /** The part after the first `#`; null for a bare file path. */
  readonly id: string | null;
}

/**
 * Split a `move` argument at its first `#` (SPEC 6.5, 1.5: discovered
 * source paths never contain `#`, so the first `#` separates file from ID).
 */
function parseMoveArgument(raw: string): MoveArgument {
  const hash = raw.indexOf("#");
  if (hash === -1) {
    return { file: raw, id: null };
  }
  return { file: raw.slice(0, hash), id: raw.slice(hash + 1) };
}

/**
 * Why `destination` is not a well-formed workspace-relative spec-source
 * path shape (SPEC 1.5: workspace-relative, `/`-separated, no `.`/`..`
 * segments — the shape every discovered source path has), or null when it
 * is. Checked before any filesystem probe, so a `..`-bearing argument never
 * resolves outside the workspace root.
 */
function destinationShapeProblem(destination: string): string | null {
  if (destination.length === 0) {
    return "it is empty";
  }
  if (destination.startsWith("/")) {
    return "it is not workspace-relative (SPEC 1.5, 12.0)";
  }
  for (const segment of destination.split("/")) {
    if (segment === "") {
      return "it has an empty path segment";
    }
    if (segment === "." || segment === "..") {
      return (
        `it has a ${JSON.stringify(segment)} path segment — discovered ` +
        `source paths are workspace-relative without "." or ".." (SPEC 1.5)`
      );
    }
  }
  return null;
}

const utf8Encoder = new TextEncoder();

/** The configured groups (spec or code) whose globs match `bytes` (SPEC 7). */
function matchingGroups(
  groups: Configuration["specGroups"],
  bytes: Uint8Array,
): string[] {
  const names: string[] = [];
  for (const group of groups) {
    if (group.globs.some((glob) => glob.matches(bytes))) {
      names.push(group.name);
    }
  }
  return names;
}

/**
 * SPEC 6.5: why the file-form destination must be refused, or null when it
 * is acceptable. Covers the destination-validity family — the path would
 * not be a valid discovered spec source after the move — plus the
 * destination-exists refusal; each reason is a validation refusal (exit 1),
 * never a usage error.
 */
async function fileDestinationProblem(
  workspace: LoadedWorkspace,
  destination: string,
): Promise<{ readonly problem: string } | { readonly specGroups: string[] }> {
  // SPEC 6.5 → 14.19: a destination that is not valid UTF-8 would not be a
  // valid discovered spec source. Node decodes non-UTF-8 argv bytes to
  // U+FFFD (see cli/args.ts), so U+FFFD marks an undecodable argument.
  if (!isValidUtf8ArgumentValue(destination)) {
    return {
      problem:
        `the destination path is not valid UTF-8 — a discovered source ` +
        `file's workspace-relative path must be valid UTF-8 (SPEC 6.5, 7, ` +
        `14.19)`,
    };
  }
  // SPEC 6.5 → 1.5/14.19: node identities reserve `#`.
  if (destination.includes("#")) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} contains "#", ` +
        `which node identities reserve (path#id) — it would not be a valid ` +
        `discovered spec source (SPEC 6.5, 1.5, 14.19)`,
    };
  }
  const shape = destinationShapeProblem(destination);
  if (shape !== null) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} is not a ` +
        `well-formed workspace-relative path: ${shape} (SPEC 6.5)`,
    };
  }
  // SPEC 6.5: refuse a file-form move whose destination file already
  // exists — whatever occupies the path (the exact self-move is refused
  // here too: its destination is the existing origin).
  const occupant = await classifyOccupant(
    path.join(workspace.root, ...destination.split("/")),
  );
  if (occupant !== "absent") {
    return {
      problem:
        `the destination file ${JSON.stringify(destination)} already ` +
        `exists — a file-form move refuses an existing destination ` +
        `(SPEC 6.5)`,
    };
  }
  const bytes = utf8Encoder.encode(destination);
  const specGroups = matchingGroups(workspace.configuration.specGroups, bytes);
  // SPEC 6.5: a path belonging to no configured spec group — a move never
  // takes a node out of the workspace.
  if (specGroups.length === 0) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} belongs to no ` +
        `configured spec group — a move never takes a node out of the ` +
        `workspace; choose a destination a spec group's globs match ` +
        `(SPEC 6.5, 7)`,
    };
  }
  // SPEC 6.5 → 14.14: belonging to a code group as well.
  const codeGroups = matchingGroups(workspace.configuration.codeGroups, bytes);
  if (codeGroups.length > 0) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} is matched by ` +
        `spec group "${specGroups[0]!}" and code group "${codeGroups[0]!}" ` +
        `alike — no file may belong to both a spec and a code group ` +
        `(SPEC 6.5, 7.2, 14.14)`,
    };
  }
  // SPEC 6.5 → 7.1/14.19: lacking the `.mdx` extension.
  if (!destination.endsWith(".mdx")) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} lacks the ` +
        `.mdx extension — every spec-group source must end ".mdx" ` +
        `(SPEC 6.5, 7.1, 14.19)`,
    };
  }
  // SPEC 13.4: derived-file paths are never sources — a file name
  // containing `.xspec.` or a path under `.xspec/` is excluded from every
  // group, so such a destination would never be discovered. (A configured
  // Markdown emit destination always ends ".md" and can never collide with
  // a ".mdx" destination.)
  const fileName = destination.slice(destination.lastIndexOf("/") + 1);
  if (fileName.includes(".xspec.") || destination.startsWith(".xspec/")) {
    return {
      problem:
        `the destination path ${JSON.stringify(destination)} is a ` +
        `derived-file path (a file name containing ".xspec." or a path ` +
        `under ".xspec/") — derived-file paths are never discovered as ` +
        `sources (SPEC 6.5, 13.4)`,
    };
  }
  return { specGroups };
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

/** The move operation, run under workspace exclusivity (SPEC 13.5). */
async function runMove(
  invocation: Invocation,
  context: CommandContext,
  originArg: string,
  destinationArg: string,
): Promise<ExitCode> {
  const { workspace, stdout, stderr } = context;

  // SPEC 6.5: the origin argument selects the form — a bare path is the
  // file form, `file#id` the section form.
  const origin = parseMoveArgument(originArg);
  const destination = parseMoveArgument(destinationArg);
  if (origin.id !== null && destination.id === null) {
    // A section origin with a bare-file destination matches neither form
    // (SPEC 6.5): a malformed invocation, a usage error (12.0).
    return usageError(
      stderr,
      invocation.command,
      `'${destinationArg}' names no target section — the forms are ` +
        `\`move <old-file> <new-file>\` and \`move <file>#<id> ` +
        `<target-file>#<new-id>\` (SPEC 6.5)`,
    );
  }

  const analysis = await analyzeWorkspace(workspace);

  // SPEC 14.14/12.0: configuration errors precede all source analysis —
  // usage class, exit 2, diagnostics on standard error, nothing modified.
  if (analysis.configurationErrors.length > 0) {
    emitConfigurationErrors(stderr, analysis.configurationErrors);
    return 2;
  }

  // SPEC 6.5 → 12.0: the argument existence checks precede source
  // validation. The origin file must name a discovered spec source
  // (workspace-relative, SPEC 12.0, 1.5; byte-wise comparison).
  if (
    !analysis.classification.specSources.some((s) => s.path === origin.file)
  ) {
    return usageError(
      stderr,
      invocation.command,
      `unknown file '${origin.file}' — the origin must name a discovered ` +
        `source file of a configured spec group, workspace-relative ` +
        `(SPEC 6.5, 12.0)`,
    );
  }

  // SPEC 12.0/14: an origin ID inside an unparseable origin file (14.20) is
  // masked — the origin was discovered but yielded no document, so the
  // validation findings are reported and the command exits 1. The file form
  // takes the same path: an unparseable origin fails build validation.
  const originSpec = analysis.specs.find(
    (s) => s.document.path === origin.file,
  );
  if (originSpec === undefined) {
    return emitFindingsRefusal(invocation.json, stdout, analysis.findings);
  }

  // SPEC 6.5 → 12.0: a nonexistent origin ID (section form) is a usage
  // error, checked before source validation.
  if (origin.id !== null) {
    const section = originSpec.document.sections.find(
      (s) => s.id === origin.id,
    );
    if (section === undefined) {
      return usageError(
        stderr,
        invocation.command,
        `unknown ID '${origin.id}' in '${origin.file}' — <id> must name an ` +
          `existing requirement ID of that file (SPEC 6.5, 12.0)`,
      );
    }
  }

  // SPEC 6.5 → 6.4: refuse, before modifying anything, when the current
  // workspace fails the validations of `xspec build` — move only ever
  // rewrites a valid workspace. The findings are the report (SPEC 12.0).
  if (analysis.findings.length > 0) {
    return emitFindingsRefusal(invocation.json, stdout, analysis.findings);
  }

  if (origin.id !== null) {
    // FIX_PLAN T28: the section form's extraction, text edits, reference
    // conversion, and import rewrites are not built yet. Refuse (exit 1)
    // modifying nothing, inside the SPEC 12.0 exit partition.
    return emitRefusal(
      invocation.json,
      stdout,
      `the section form of \`xspec move\` is not implemented in this build ` +
        `(SPEC 6.5)`,
    );
  }

  return runMoveFile(
    invocation,
    context,
    analysis,
    origin.file,
    destinationArg,
  );
}

/** The file form (SPEC 6.5), past the shared argument and precondition checks. */
async function runMoveFile(
  invocation: Invocation,
  context: CommandContext,
  analysis: WorkspaceAnalysis,
  originPath: string,
  destination: string,
): Promise<ExitCode> {
  const { workspace, stdout, stderr } = context;

  // SPEC 6.5: the destination refusals — each refuses (exit 1) before
  // modifying anything.
  const destinationResult = await fileDestinationProblem(
    workspace,
    destination,
  );
  if ("problem" in destinationResult) {
    return emitRefusal(invocation.json, stdout, destinationResult.problem);
  }

  // The pure plan: the identity mapping (file part only), the journal
  // entry, and the minimal import-specifier rewrites (SPEC 6.5, 6.1).
  const plan = planMoveFile(
    analysis.specs,
    analysis.code,
    originPath,
    destination,
  );

  // Re-validate the rewritten workspace in memory before touching anything
  // (SPEC 6.5: all rewritten references resolve, no import or dependency
  // cycle arises, and the finishing regeneration cannot fail). The journal
  // is modeled as it will stand after the append — hashes take the journal
  // as an input (SPEC 5.4), and the file form is pure (SPEC 6.2), so the
  // regenerated graph data matches a fresh build of the moved workspace
  // byte for byte (SPEC 6.5, 12.0).
  const rewritten = await reanalyzeMoved(
    workspace,
    analysis,
    plan,
    originPath,
    destination,
    destinationResult.specGroups,
  );
  if (rewritten.configurationErrors.length > 0) {
    // Unreachable: the destination was validated against the same group
    // rules discovery applies. Guarded so a regression reports rather than
    // corrupts.
    emitConfigurationErrors(stderr, rewritten.configurationErrors);
    return 2;
  }
  if (rewritten.findings.length > 0) {
    // SPEC 6.5: the rewrite would not leave a valid workspace — refuse with
    // the would-be findings, nothing modified.
    return emitFindingsRefusal(invocation.json, stdout, rewritten.findings);
  }

  // SPEC 6.5/6.4/12.1: the finishing regeneration's outputs, derived
  // exactly as `xspec build` derives them — over the rewritten analyses.
  // The stored record's paths for the origin's generated files are no
  // longer generated and become orphans, so no stale output (14.10)
  // remains.
  const stored = await loadGraphData(workspace.root);
  const outputs = computeBuildOutputs(
    workspace.configuration,
    rewritten.specs,
    rewritten.graph,
    rewritten.textModel,
    rewritten.hashes,
    stored.data,
  );

  // SPEC 14.22: validate the complete write set — rewritten sources (the
  // destination included), the journal, and every regenerated file — before
  // modifying anything.
  const writeFindings = await symlinkWritePathFindings(workspace.root, [
    ...plan.rewrites.map((rewrite) => rewrite.path),
    JOURNAL_PATH,
    ...outputs.writePaths,
  ]);
  if (writeFindings.length > 0) {
    return emitFindingsRefusal(invocation.json, stdout, writeFindings);
  }

  // All validation passed — modify: write the rewritten sources (atomic per
  // file, SPEC 13.5; the moved content lands at the destination), remove
  // the origin (SPEC 6.5: the file is relocated), append the mapping to the
  // journal (SPEC 6.1, 6.5), and regenerate derived files exactly as
  // `xspec build` does (SPEC 6.5, 6.4).
  for (const rewrite of plan.rewrites) {
    await writeSourceFile(workspace.root, rewrite.path, rewrite.content);
  }
  await removeSourceFile(workspace.root, originPath);
  await appendJournalEntry(workspace.root, plan.entry);
  await executeBuildOutputs(workspace.root, outputs);

  if (invocation.json) {
    // SPEC 12.0: one JSON document as the entire standard output — the
    // successful move's report is its (empty) findings list, as for
    // `build` (SPEC 12.1) and `rename` (SPEC 6.4).
    emitFindingsReport(true, stdout, []);
  }
  return 0;
}

/**
 * Analyze the moved workspace entirely in memory: the classification with
 * the origin's entry replaced by the destination (grouped exactly as
 * discovery would group it, SPEC 7), sources served from the rewrite plan
 * (the moved content at the destination, unaffected files from the
 * already-analyzed text), and the journal as it will stand after the append
 * (SPEC 6.5, 5.4).
 */
async function reanalyzeMoved(
  workspace: LoadedWorkspace,
  analysis: WorkspaceAnalysis,
  plan: MoveFilePlan,
  originPath: string,
  destination: string,
  destinationSpecGroups: readonly string[],
): Promise<WorkspaceAnalysis> {
  const encoder = new TextEncoder();
  const byPath = new Map<string, Uint8Array>();
  for (const spec of analysis.specs) {
    byPath.set(spec.document.path, encoder.encode(spec.document.text));
  }
  for (const code of analysis.code) {
    byPath.set(code.path, encoder.encode(code.text));
  }
  byPath.delete(originPath);
  for (const rewrite of plan.rewrites) {
    byPath.set(rewrite.path, rewrite.content);
  }
  // The post-move classification: the origin's entry replaced by the
  // destination, byte-ordered by path (SourceClassification's contract).
  const movedSource: DiscoveredSource = {
    path: destination,
    groups: destinationSpecGroups,
  };
  const classification: SourceClassification = {
    specSources: [
      ...analysis.classification.specSources.filter(
        (source) => source.path !== originPath,
      ),
      movedSource,
    ].sort((a, b) => compareBytes(a.path, b.path)),
    codeSources: analysis.classification.codeSources,
    findings: [],
  };
  const currentJournal = await readJournalBytes(workspace.root);
  const entryLine = encoder.encode(serializeJournalEntry(plan.entry) + "\n");
  const journalBytes = concatBytes(
    currentJournal === null ? [entryLine] : [currentJournal, entryLine],
  );
  return analyzeWorkspaceContent(workspace.configuration, {
    classification,
    readSource: (rel) => Promise.resolve(byPath.get(rel) ?? null),
    loadJournal: () => Promise.resolve(journalFromBytes(journalBytes)),
  });
}

/** The `move` command handler (SPEC 6.5). */
export async function moveCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const [originArg, destinationArg] = invocation.positionals;
  if (originArg === undefined || destinationArg === undefined) {
    // Unreachable: the parser enforces the two positionals (SPEC 6.5).
    throw new Error("xspec internal error: move without its arguments");
  }
  // SPEC 13.5: workspace exclusivity around the whole operation, with the
  // `--test-hold` seam immediately after acquisition; a workspace held by
  // another mutating command fails promptly as a usage error (12.0),
  // modifying nothing.
  const outcome = await withMutationExclusivity(
    context.workspace.root,
    testHoldSpecOf(invocation, context.cwd),
    () => runMove(invocation, context, originArg, destinationArg),
  );
  if (!outcome.ok) {
    return usageError(context.stderr, invocation.command, outcome.usageMessage);
  }
  return outcome.value;
}
