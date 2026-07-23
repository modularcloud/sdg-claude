// The review command family's shared session engine (SPEC 10.4, 10.7).
//
// IMPLEMENTATION (Architecture): the cli layer owns dispatch, rendering, and
// the exit-code taxonomy; the pure derivation machinery lives in the core
// (review.ts, review-state.ts, review-derive.ts, path-blocks.ts, audit.ts,
// coverage-session.ts) and the I/O in the workspace layer (reviews.ts,
// baseline.ts, refresh.ts). This module composes them into the one flow
// every session-naming subcommand shares:
//
// 1. Session-name validity (SPEC 10.1 → 12.0: any other name is a usage
//    error, exit 2).
// 2. Load the session (workspace/reviews.ts): an absent session is an
//    unknown session named in arguments — usage error, exit 2 (SPEC 10.7,
//    12.0); a corrupt one is reported as the 14.21 finding, exit 1,
//    modifying nothing (SPEC 10.1).
// 3. For a `path-blocks` session, resolve the recorded baseline commit
//    (SPEC 10.7: every later generator run uses the recorded parameters).
//    A baseline that cannot be resolved or reconstructed fails per 6.3 as a
//    usage error (exit 2), and baseline resolution precedes source
//    validation (SPEC 12.0) — so this runs before the refresh.
// 4. Refresh-on-read (SPEC 13.3, cli/prepare.ts): validation findings
//    report and exit 1, nothing answered, nothing modified.
// 5. Re-run the session's strategy generators with the recorded creation
//    parameters against the current workspace (SPEC 10.4, 10.7), replay the
//    recorded decompositions (SPEC 10.5), and derive the read-time view:
//    identities mapped forward through the journal (SPEC 10.4, 6.3),
//    effective statuses (read-time invalidation — a stale resolution is
//    reported `invalidated`, never persisted), blocked states over those
//    statuses (SPEC 10.3), and the presentation item order (10.5–10.7).
//
// The payload renderers below fix the self-contained text payload of
// SPEC 10.7 once, so `show`, `export`, and `next --json` can never disagree:
// every scope, context, and origin node under its current identity and
// presence, source ranges for present requirement nodes, the recorded
// `baseline`/`current` states, and text per item kind — a present node's
// text from the current graph, an absent node's from the most recent
// recorded state containing it (the derivation-time snapshots, else the
// item's baseline snapshots), and no text for a node contained in none or
// for a code-location scope.

import { generateAuditItems } from "../../core/audit.js";
import type { JsonObject } from "../../core/canonical-json.js";
import { canonicalJson } from "../../core/canonical-json.js";
import { generateCoverageSessionItems } from "../../core/coverage-session.js";
import type { ExitCode } from "../../core/findings.js";
import { generatePathBlocksItems } from "../../core/path-blocks.js";
import type {
  ItemKind,
  ItemStatus,
  ReviewItem,
  ReviewSession,
  SessionParameters,
} from "../../core/review.js";
import {
  isItemBlocked,
  recordedStateToJson,
  sessionNameProblem,
  sessionStrategy,
} from "../../core/review.js";
import type {
  DecompositionContentSource,
  GeneratedItem,
} from "../../core/review-derive.js";
import {
  currentContextSets,
  expandDecompositions,
  sortItemsByFileThenDocument,
  sortItemsPathBlocks,
} from "../../core/review-derive.js";
import type { BaselineDerivationSide } from "../../core/review-derive.js";
import type { ReviewStateInputs } from "../../core/review-state.js";
import {
  deriveEffectiveStatuses,
  journalSuffixMapper,
  mapSessionIdentitiesForward,
} from "../../core/review-state.js";
import type { ResolvedBaseline } from "../../workspace/baseline.js";
import { resolveBaseline } from "../../workspace/baseline.js";
import { loadSession } from "../../workspace/reviews.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import type { Invocation } from "../args.js";
import type { CliWriter, CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { emitFindingsReport } from "../report.js";
import { rangeJson, usageError } from "./common.js";

// ---------------------------------------------------------------------------
// Generator runs with recorded parameters (SPEC 10.4, 10.7)
// ---------------------------------------------------------------------------

/** One strategy-generator run, normalized across the three strategies. */
export interface SessionGenerationRun {
  /** The generated items, before decomposition replay (SPEC 10.5). */
  readonly items: readonly GeneratedItem[];
  /** The strategy's decomposition content (SPEC 10.7). */
  readonly contentSource: DecompositionContentSource;
  /**
   * SPEC 10.4/9.2: per code-location identity, the impact-edge target
   * identities — `path-blocks` only; the other strategies scope no code.
   */
  readonly impactTargets?: ReadonlyMap<string, readonly string[]>;
  /**
   * The recorded-baseline derivation side (SPEC 10.2: new items' `baseline`
   * states) — `path-blocks` only; an `audit`/`coverage` item's `baseline`
   * is the current graph's values at entry.
   */
  readonly baseline?: BaselineDerivationSide;
}

/**
 * Run the session's strategy generators with the recorded creation
 * parameters against the current workspace (SPEC 10.4, 10.7: the recorded
 * commit as the baseline, the recorded globs matched against the currently
 * discovered sources, nothing for `audit`). For `path-blocks` the caller
 * has already resolved the recorded baseline (`resolveRecordedBaseline`).
 */
export function runSessionGenerators(
  parameters: SessionParameters,
  analysis: WorkspaceAnalysis,
  baseline: ResolvedBaseline | undefined,
): SessionGenerationRun {
  switch (parameters.strategy) {
    case "path-blocks": {
      if (baseline === undefined) {
        throw new Error(
          "xspec internal error: a path-blocks generator run needs the " +
            "resolved recorded baseline (SPEC 10.7)",
        );
      }
      const generation = generatePathBlocksItems(
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
      return {
        items: generation.items,
        contentSource: generation.contentSource,
        impactTargets: generation.impactTargets,
        baseline: {
          graph: baseline.analysis.graph,
          hashes: baseline.analysis.hashes,
          textModel: baseline.analysis.textModel,
          replay: generation.replay,
        },
      };
    }
    case "audit": {
      // SPEC 10.7: an audit session records no creation parameters — its
      // generators run against the current workspace as it stands.
      const generation = generateAuditItems(analysis.graph);
      return {
        items: generation.items,
        contentSource: generation.contentSource,
      };
    }
    case "coverage": {
      const generation = generateCoverageSessionItems(
        analysis.graph,
        parameters.profile,
      );
      return {
        items: generation.items,
        contentSource: generation.contentSource,
      };
    }
  }
}

/** `ReviewStateInputs` over the current analysis and a generation run —
 * total for every stored item (an externally injected `code-impact` item in
 * a strategy without impact data reads an empty target set rather than
 * failing, keeping reads deterministic). */
export function generationStateInputs(
  analysis: WorkspaceAnalysis,
  generation: SessionGenerationRun,
): ReviewStateInputs {
  const impactTargets = generation.impactTargets;
  return {
    graph: analysis.graph,
    hashes: analysis.hashes,
    impactTargets: (location): readonly string[] =>
      impactTargets === undefined ? [] : (impactTargets.get(location) ?? []),
  };
}

// ---------------------------------------------------------------------------
// The read-time view (SPEC 10.4)
// ---------------------------------------------------------------------------

/** A session's read-time view: forward-mapped, invalidation applied. */
export interface SessionReadView {
  readonly name: string;
  /** Forward-mapped to current identities (SPEC 10.4, 6.3). */
  readonly session: ReviewSession;
  /** The decomposition-expanded generator run (SPEC 10.5, 10.7). */
  readonly expanded: readonly GeneratedItem[];
  readonly generation: SessionGenerationRun;
  /** SPEC 10.4: effective statuses — read-time invalidation applied. */
  readonly statuses: ReadonlyMap<string, ItemStatus>;
  /** SPEC 10.3: blocked states over the effective statuses. */
  readonly blocked: ReadonlyMap<string, boolean>;
  /** The session's items in presentation order (SPEC 10.5–10.7). */
  readonly ordered: readonly ReviewItem[];
  readonly analysis: WorkspaceAnalysis;
}

/**
 * Derive a session's read-time view (module header step 5). Nothing is
 * persisted: read-time invalidation is computed and reported, never written
 * (SPEC 10.4).
 */
export function buildSessionReadView(
  name: string,
  stored: ReviewSession,
  generation: SessionGenerationRun,
  analysis: WorkspaceAnalysis,
): SessionReadView {
  const journal = analysis.journal.journal;
  // SPEC 10.4/6.3: map every recorded identity forward through the journal
  // entries appended since the session was last written.
  const session = mapSessionIdentitiesForward(
    stored,
    journalSuffixMapper(journal, stored.journalLength),
    journal.entries.length,
  );
  // SPEC 10.5/10.7: the recorded decompositions replay over the generation.
  const expanded = expandDecompositions(
    generation.items,
    session.decompositions.map((decomposition) => decomposition.scope),
    analysis.graph,
    generation.contentSource,
  );
  const stateInputs = generationStateInputs(analysis, generation);
  // SPEC 10.4: effective statuses — a stale resolution reads `invalidated`.
  const statuses = deriveEffectiveStatuses(session.items, {
    state: stateInputs,
    currentContexts: currentContextSets(session.items, expanded),
  });
  // SPEC 10.3: blocked over the effective statuses — a blocker that became
  // invalidated re-blocks its dependents.
  const blocked = new Map<string, boolean>();
  for (const item of session.items) {
    blocked.set(
      item.id,
      isItemBlocked(item, (id) => statuses.get(id) ?? "unresolved"),
    );
  }
  // SPEC 10.5 (path-blocks total order), 10.6 (audit), 10.7 (coverage).
  const ordered =
    sessionStrategy(session) === "path-blocks"
      ? sortItemsPathBlocks(session.items, analysis.graph)
      : sortItemsByFileThenDocument(session.items, analysis.graph);
  return {
    name,
    session,
    expanded,
    generation,
    statuses,
    blocked,
    ordered,
    analysis,
  };
}

// ---------------------------------------------------------------------------
// The shared open flow (module header steps 1–5)
// ---------------------------------------------------------------------------

/** The open outcome: the view, or an already-emitted exit code. */
export type SessionOpenResult =
  | { readonly ok: true; readonly view: SessionReadView }
  | { readonly ok: false; readonly exit: ExitCode };

/**
 * Open a named session for a read (`status`, `next`, `show`, `export`) —
 * the module header's steps 1–5. Failures are fully reported here; the
 * caller returns `exit` unchanged. Mutating subcommands share steps 1–4
 * through `loadSessionForCommand` and run their own derivation.
 */
export async function openSessionForRead(
  name: string,
  invocation: Invocation,
  context: CommandContext,
): Promise<SessionOpenResult> {
  const loaded = await loadSessionForCommand(name, invocation, context);
  if (!loaded.ok) {
    return loaded;
  }
  const generation = runSessionGenerators(
    loaded.session.parameters,
    loaded.analysis,
    loaded.baseline,
  );
  return {
    ok: true,
    view: buildSessionReadView(
      name,
      loaded.session,
      generation,
      loaded.analysis,
    ),
  };
}

/** Steps 1–4 of the open flow: the stored session, the current analysis,
 * and — for a `path-blocks` session — the resolved recorded baseline. */
export interface LoadedSessionForCommand {
  readonly ok: true;
  readonly session: ReviewSession;
  readonly analysis: WorkspaceAnalysis;
  readonly baseline?: ResolvedBaseline;
}

export async function loadSessionForCommand(
  name: string,
  invocation: Invocation,
  context: CommandContext,
): Promise<
  LoadedSessionForCommand | { readonly ok: false; readonly exit: ExitCode }
> {
  // Step 1 — SPEC 10.1 → 12.0: an invalid session name is a usage error.
  const nameCheck = requireValidSessionName(name, invocation, context);
  if (nameCheck !== null) {
    return { ok: false, exit: nameCheck };
  }

  // Step 2 — load: absent = unknown session (usage, SPEC 10.7 → 12.0);
  // corrupt = the 14.21 finding, exit 1, modifying nothing (SPEC 10.1).
  const loaded = await loadSession(context.workspace.root, name);
  if (loaded.state === "absent") {
    return {
      ok: false,
      exit: unknownSessionError(name, invocation, context),
    };
  }
  if (loaded.state === "corrupt") {
    emitFindingsReport(invocation.json, context.stdout, [loaded.finding]);
    return { ok: false, exit: 1 };
  }

  // Step 3 — SPEC 10.7/6.3/12.0: resolve the recorded baseline before
  // source validation; failure is a usage error, nothing modified.
  let baseline: ResolvedBaseline | undefined;
  if (loaded.session.parameters.strategy === "path-blocks") {
    const resolution = await resolveBaseline(
      context.workspace,
      loaded.session.parameters.baseCommit,
    );
    if (!resolution.ok) {
      return {
        ok: false,
        exit: usageError(
          context.stderr,
          invocation.command,
          `the recorded baseline of session '${name}' cannot be ` +
            `reconstructed: ${resolution.message}`,
        ),
      };
    }
    baseline = resolution.baseline;
  }

  // Step 4 — refresh-on-read (SPEC 13.3): validation findings report and
  // exit 1; configuration errors exit 2 (already reported).
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return { ok: false, exit: prepared.exit };
  }
  return {
    ok: true,
    session: loaded.session,
    analysis: prepared.analysis,
    baseline,
  };
}

/** SPEC 10.1 → 12.0: report an invalid session name, or pass (null). */
export function requireValidSessionName(
  name: string,
  invocation: Invocation,
  context: CommandContext,
): ExitCode | null {
  const problem = sessionNameProblem(name);
  if (problem === null) {
    return null;
  }
  return usageError(context.stderr, invocation.command, problem);
}

/** SPEC 10.7 → 12.0: an unknown session named in arguments. */
export function unknownSessionError(
  name: string,
  invocation: Invocation,
  context: CommandContext,
): ExitCode {
  return usageError(
    context.stderr,
    invocation.command,
    `unknown session '${name}' — no session file ` +
      `.xspec/reviews/${name}.json exists; session names compare byte-wise ` +
      `and case-sensitively (SPEC 10.1, 10.7, 12.0)`,
  );
}

// ---------------------------------------------------------------------------
// Payload rendering (SPEC 10.7 — one payload rule for show/export/next)
// ---------------------------------------------------------------------------

/** Which text value a node presents in a payload role (SPEC 10.7). */
type TextSelection = "own" | "subtree" | "code";

/** SPEC 10.7: scope text per kind — subtree text for `subtree-coherence`
 * and `uncovered-requirement`, own text for the consistency kinds, none for
 * a code location. */
function scopeTextSelection(kind: ItemKind): TextSelection {
  switch (kind) {
    case "subtree-coherence":
    case "uncovered-requirement":
      return "subtree";
    case "parent-consistency":
    case "dependency-consistency":
    case "metadata-consistency":
      return "own";
    case "code-impact":
      return "code";
  }
}

/** SPEC 10.7: context text — own text where the context is an ancestor
 * chain (`subtree-coherence`, `uncovered-requirement`), subtree text
 * otherwise (branch children; dependency/metadata/code-impact targets). */
function contextTextSelection(kind: ItemKind): TextSelection {
  switch (kind) {
    case "subtree-coherence":
    case "uncovered-requirement":
      return "own";
    default:
      return "subtree";
  }
}

/**
 * SPEC 10.7: an absent node's text is its value in the most recent graph
 * state that contained it, among the item's `baseline` state and the states
 * under which mutating subcommands derived the item — the derivation-time
 * snapshots are rewritten per node at each derivation that finds it present,
 * so they are the most recent wherever they exist; a node contained in none
 * has no text.
 */
function absentNodeText(
  item: ReviewItem,
  identity: string,
  selection: TextSelection,
): string | undefined {
  const recorded = item.derivedTexts[identity] ?? item.baselineTexts[identity];
  if (recorded === undefined || selection === "code") {
    return undefined;
  }
  return selection === "own" ? recorded.ownText : recorded.subtreeText;
}

/**
 * One payload node (SPEC 10.7): identity, presence, the role's text, and —
 * for a present requirement node — its source range (1.7). A code location
 * (`selection === "code"`) enters as identity and presence alone.
 */
function nodeStateJson(
  view: SessionReadView,
  item: ReviewItem,
  identity: string,
  selection: TextSelection,
): JsonObject {
  if (selection === "code") {
    return {
      node: identity,
      present: view.analysis.graph.codeLocation(identity) !== undefined,
    };
  }
  const node = view.analysis.graph.requirementNode(identity);
  if (node !== undefined) {
    // SPEC 10.7: a present node's text is read from the current graph —
    // the expanded value of 1.6 — with its source range (1.7).
    return {
      node: identity,
      present: true,
      sourceRange: rangeJson(node.section.range),
      text:
        selection === "own"
          ? view.analysis.textModel.ownText(node.document, node.section)
          : view.analysis.textModel.subtreeText(node.document, node.section),
    };
  }
  return {
    node: identity,
    present: false,
    text: absentNodeText(item, identity, selection),
  };
}

/**
 * One origin entry (SPEC 10.7): a before/after pair of the node's own text
 * — before from the item's `baseline` state, after from the current graph;
 * the absent side of the pair is presented absent, with no text.
 */
function originEntryJson(
  view: SessionReadView,
  item: ReviewItem,
  identity: string,
): JsonObject {
  const recordedBaseline = item.baseline.nodes[identity];
  const before: JsonObject =
    recordedBaseline !== undefined && recordedBaseline.present
      ? { present: true, text: item.baselineTexts[identity]?.ownText }
      : { present: false };
  const node = view.analysis.graph.requirementNode(identity);
  const after: JsonObject =
    node === undefined
      ? { present: false }
      : {
          present: true,
          text: view.analysis.textModel.ownText(node.document, node.section),
        };
  return { node: identity, before, after };
}

/**
 * The full item document (SPEC 10.7: every field of 10.2, the blocked
 * state, and the self-contained text payload) — `show`'s whole document,
 * one element of `export`'s item list, and `next --json`'s `item` member.
 * Status is the effective one (SPEC 10.4: a stale resolution is never
 * reported as resolved); `baseline` and `current` report as recorded.
 */
export function itemDocument(
  view: SessionReadView,
  item: ReviewItem,
): JsonObject {
  const scopeSelection = scopeTextSelection(item.kind);
  return {
    id: item.id,
    kind: item.kind,
    status: view.statuses.get(item.id) ?? item.status,
    blocked: view.blocked.get(item.id) ?? false,
    blockedBy: [...item.blockedBy],
    reason: item.reason,
    note: item.note,
    scope: nodeStateJson(view, item, item.scope, scopeSelection),
    context: item.context.map((identity) =>
      nodeStateJson(view, item, identity, contextTextSelection(item.kind)),
    ),
    origin: item.origin.map((identity) =>
      originEntryJson(view, item, identity),
    ),
    baseline: recordedStateToJson(item.baseline),
    current: recordedStateToJson(item.current),
  };
}

/**
 * The item document rendered for human reading — the same information as
 * the JSON form (SPEC 12.0): every 10.2 field, the blocked state, and the
 * payload texts, in a stable indented layout.
 */
export function renderItemHuman(
  view: SessionReadView,
  item: ReviewItem,
): string {
  const document = itemDocument(view, item);
  let out = `item ${item.id}\n`;
  out += `  kind: ${item.kind}\n`;
  out += `  status: ${String(document["status"])}\n`;
  out += `  blocked: ${String(document["blocked"])}\n`;
  out += `  blockedBy: ${item.blockedBy.length === 0 ? "(none)" : item.blockedBy.join(", ")}\n`;
  out += `  reason: ${item.reason}\n`;
  if (item.note !== undefined) {
    out += `  note: ${item.note}\n`;
  }
  out += renderNodeStateHuman("scope", document["scope"] as JsonObject);
  const contexts = document["context"] as readonly JsonObject[];
  out += `  context:${contexts.length === 0 ? " (none)" : ""}\n`;
  for (const state of contexts) {
    out += renderNodeStateHuman("  -", state);
  }
  const origins = document["origin"] as readonly JsonObject[];
  out += `  origin:${origins.length === 0 ? " (none)" : ""}\n`;
  for (const entry of origins) {
    out += renderOriginHuman(entry);
  }
  out += `  baseline: ${compactStateHuman(item)}\n`;
  out += `  current: ${compactStateHuman(item, "current")}\n`;
  return out;
}

/** One payload node as human lines (identity, presence, range, text). */
function renderNodeStateHuman(label: string, state: JsonObject): string {
  const present = state["present"] === true;
  let out = `  ${label}: ${String(state["node"])} (${present ? "present" : "absent"})\n`;
  const range = state["sourceRange"];
  if (range !== undefined) {
    const rangeObject = range as JsonObject;
    out += `    range: ${String(rangeObject["start"])}-${String(rangeObject["end"])}\n`;
  }
  const text = state["text"];
  if (typeof text === "string") {
    out += renderTextBlock(text);
  }
  return out;
}

/** One origin before/after pair as human lines (SPEC 10.7). */
function renderOriginHuman(entry: JsonObject): string {
  let out = `  - ${String(entry["node"])}\n`;
  for (const side of ["before", "after"] as const) {
    const sideObject = entry[side] as JsonObject;
    const present = sideObject["present"] === true;
    out += `    ${side}: ${present ? "present" : "absent"}\n`;
    const text = sideObject["text"];
    if (typeof text === "string") {
      out += renderTextBlock(text, "      ");
    }
  }
  return out;
}

/** A text value as an indented block, deterministic for identical text. */
function renderTextBlock(text: string, indent = "    "): string {
  if (text.length === 0) {
    return `${indent}text: (empty)\n`;
  }
  const lines = text.split("\n");
  let out = `${indent}text: |\n`;
  for (const line of lines) {
    out += `${indent}  ${line}\n`;
  }
  return out;
}

/** A recorded state as one compact human line (the same information the
 * JSON member carries; SPEC 12.0). */
function compactStateHuman(
  item: ReviewItem,
  which: "baseline" | "current" = "baseline",
): string {
  const state = which === "baseline" ? item.baseline : item.current;
  const parts: string[] = [];
  for (const [identity, node] of Object.entries(state.nodes)) {
    if (!node.present) {
      parts.push(`${identity}=absent`);
      continue;
    }
    const hashes = Object.entries(node.hashes)
      .map(([name, value]) => `${name}:${value}`)
      .join(" ");
    parts.push(`${identity}={${hashes}}`);
  }
  return parts.length === 0 ? "(no nodes)" : parts.join("; ");
}

// ---------------------------------------------------------------------------
// Status rows and totals (SPEC 10.7 `status`)
// ---------------------------------------------------------------------------

/** Effective totals by status (SPEC 10.7 `status`: read-time invalidation
 * applied — 10.4). */
export function effectiveTotals(
  view: SessionReadView,
): Readonly<Record<ItemStatus, number>> {
  const totals: Record<ItemStatus, number> = {
    unresolved: 0,
    updated: 0,
    "no-change": 0,
    skipped: 0,
    invalidated: 0,
  };
  for (const item of view.session.items) {
    totals[view.statuses.get(item.id) ?? item.status] += 1;
  }
  return totals;
}

/** Status counts as a JSON member (explicit zeros keep the record total). */
export function countsJson(
  counts: Readonly<Record<ItemStatus, number>>,
): JsonObject {
  return {
    unresolved: counts.unresolved,
    updated: counts.updated,
    "no-change": counts["no-change"],
    skipped: counts.skipped,
    invalidated: counts.invalidated,
  };
}

/** Status counts as one deterministic human fragment. */
export function renderCountsHuman(
  counts: Readonly<Record<ItemStatus, number>>,
): string {
  return (
    `unresolved=${String(counts.unresolved)} ` +
    `updated=${String(counts.updated)} ` +
    `no-change=${String(counts["no-change"])} ` +
    `skipped=${String(counts.skipped)} ` +
    `invalidated=${String(counts.invalidated)}`
  );
}

// ---------------------------------------------------------------------------
// Refusals (SPEC 10.7 → 12.0: refused review operations, exit 1)
// ---------------------------------------------------------------------------

/**
 * SPEC 10.7/12.0: a refused review operation is a findings-class outcome —
 * exit 1, the refusal report on standard output (with `--json`, one JSON
 * document as the entire standard output).
 */
export function emitReviewRefusal(
  json: boolean,
  stdout: CliWriter,
  command: string,
  message: string,
): ExitCode {
  if (json) {
    // The canonical serializer keeps the document byte-deterministic.
    stdout.write(canonicalJson({ refused: { command, message } }));
  } else {
    stdout.write(`${command} refused: ${message}\n`);
  }
  return 1;
}
