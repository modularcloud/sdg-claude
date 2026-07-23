// The `xspec review` subcommands (SPEC 10.7): `create`, `list`, `status`,
// `show`, `export`. (`next`, `split`, `resolve` are dispatched separately.)
//
// Outcome precedence, per subcommand:
//
// `create` (mutating, SPEC 13.5) — under workspace exclusivity with the
// `--test-hold` seam:
//   1. session-name validity (SPEC 10.1 → 12.0, exit 2);
//   2. `--coverage`: the named profile must be configured (SPEC 10.7 →
//      12.0 "unknown profiles named in arguments", exit 2) — a
//      configuration-level check preceding source analysis;
//   3. `--base`: baseline resolution (SPEC 6.3 → 12.0, exit 2) — precedes
//      source validation;
//   4. refresh-on-read (SPEC 13.3): invalid sources report the validation
//      errors, exit 1, nothing created;
//   5. an existing session name — matched ignoring ASCII case (SPEC 10.1)
//      — is refused, exit 1, nothing created (SPEC 10.7); an exact-name
//      corrupt occupant reports the corruption instead (SPEC 10.1, 14.21);
//   6. derive the items (SPEC 10.5–10.7), validate the write path
//      (SPEC 14.22), and write the session file (SPEC 10.1, 13.4).
//
// `list` (read) — refresh-on-read, then every session in byte order of
// name with its name, strategy, and item counts by stored status (no
// read-time invalidation, SPEC 10.7); corrupt sessions by name as corrupt
// in place of those fields; exit 1 iff any is corrupt.
//
// `status`, `show`, `export` (reads) — the shared open flow of
// review-session.ts (name validity, load, recorded-baseline resolution,
// refresh), then the read-time view (SPEC 10.4: invalidation applied,
// never persisted). `export` emits the entire session as a single JSON
// document — its only output form, with or without `--json` (SPEC 10.7).

import type { JsonObject } from "../../core/canonical-json.js";
import type { ExitCode } from "../../core/findings.js";
import type { ReviewSession, SessionParameters } from "../../core/review.js";
import {
  countsByStoredStatus,
  existingNameIgnoringAsciiCase,
  parametersToJson,
  recordCoverageProfile,
  sessionFilePath,
  sessionNameProblem,
  sessionStrategy,
} from "../../core/review.js";
import {
  deriveSessionItems,
  expandDecompositions,
} from "../../core/review-derive.js";
import type { ResolvedBaseline } from "../../workspace/baseline.js";
import { resolveBaseline } from "../../workspace/baseline.js";
import { withMutationExclusivity } from "../../workspace/lock.js";
import {
  listSessionNames,
  loadAllSessions,
  loadSession,
  writeSession,
} from "../../workspace/reviews.js";
import { symlinkWritePathFindings } from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import { flagValue } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { emitFindingsReport } from "../report.js";
import { emitDocument, testHoldSpecOf, usageError } from "./common.js";
import {
  countsJson,
  effectiveTotals,
  emitReviewRefusal,
  itemDocument,
  openSessionForRead,
  renderCountsHuman,
  renderItemHuman,
  runSessionGenerators,
} from "./review-session.js";

// ---------------------------------------------------------------------------
// `review create` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `create` operation, run under workspace exclusivity (SPEC 13.5). */
async function runCreate(
  invocation: Invocation,
  context: CommandContext,
  name: string,
): Promise<ExitCode> {
  const { workspace, stdout, stderr } = context;

  // SPEC 10.1 → 12.0: an invalid session name is a usage error.
  const nameProblem = sessionNameProblem(name);
  if (nameProblem !== null) {
    return usageError(stderr, invocation.command, nameProblem);
  }

  // SPEC 10.7: exactly one of `--base`, `--strategy audit`, `--coverage`
  // was given (the parser enforces the exclusivity); resolve the creation
  // parameters, fully (SPEC 10.7: the resolved commit identity; the
  // profile definition with group names replaced by the groups' configured
  // glob lists and kind; nothing for audit).
  const baseRef = flagValue(invocation, "--base");
  const profileName = flagValue(invocation, "--coverage");
  let parameters: SessionParameters;
  let baseline: ResolvedBaseline | undefined;
  if (profileName !== undefined) {
    // SPEC 10.7 → 12.0: an unknown profile named in arguments is a usage
    // error — a configuration-level check preceding source analysis, as
    // for `coverage <name>` (SPEC 8.2, 14.14).
    const profile = workspace.configuration.coverage.find(
      (candidate) => candidate.name === profileName,
    );
    if (profile === undefined) {
      return usageError(
        stderr,
        invocation.command,
        `unknown profile '${profileName}' — no configured coverage profile ` +
          `has that name (SPEC 10.7, 7.4, 12.0)`,
      );
    }
    parameters = {
      strategy: "coverage",
      profile: recordCoverageProfile(workspace.configuration, profile),
    };
  } else if (baseRef !== undefined) {
    // SPEC 6.3 → 12.0: baseline resolution precedes source validation — an
    // unresolvable baseline is a usage error (exit 2), nothing modified,
    // even when the current sources also fail build validation.
    const resolution = await resolveBaseline(workspace, baseRef);
    if (!resolution.ok) {
      return usageError(stderr, invocation.command, resolution.message);
    }
    baseline = resolution.baseline;
    // SPEC 10.7: a baseline session records the commit identity `--base`
    // resolved to at creation, never the ref spelling.
    parameters = {
      strategy: "path-blocks",
      baseCommit: resolution.baseline.commit,
    };
  } else {
    // SPEC 10.7: an audit session records no creation parameters.
    parameters = { strategy: "audit" };
  }

  // SPEC 13.3: refresh-on-read — with invalid sources, report the
  // validation errors, exit 1, nothing created (a `review` subcommand like
  // any other).
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }
  const { analysis } = prepared;

  // SPEC 10.1/10.7: `create` with the name of an existing session is
  // refused (exit 1, nothing created); a name matching an existing
  // session's ignoring ASCII case is treated as the name of an existing
  // session. An exact-name corrupt occupant is a session `create` names,
  // so the corruption is reported (SPEC 10.1, 14.21).
  const occupant = await loadSession(workspace.root, name);
  if (occupant.state === "corrupt") {
    emitFindingsReport(invocation.json, stdout, [occupant.finding]);
    return 1;
  }
  if (occupant.state === "ok") {
    return emitReviewRefusal(
      invocation.json,
      stdout,
      invocation.command,
      `a session named '${name}' already exists — \`review create\` with ` +
        `the name of an existing session is refused (SPEC 10.1, 10.7)`,
    );
  }
  const collision = existingNameIgnoringAsciiCase(
    await listSessionNames(workspace.root),
    name,
  );
  if (collision !== null) {
    return emitReviewRefusal(
      invocation.json,
      stdout,
      invocation.command,
      `the name '${name}' matches the existing session '${collision}' ` +
        `ignoring ASCII case, so it is treated as the name of an existing ` +
        `session and refused (SPEC 10.1, 10.7)`,
    );
  }

  // Derive the session's items with the creation-time generator run
  // (SPEC 10.5–10.7; `create` merges into an empty session, so every
  // generated item enters with current state and a fresh id).
  const generation = runSessionGenerators(parameters, analysis, baseline);
  const expanded = expandDecompositions(
    generation.items,
    [],
    analysis.graph,
    generation.contentSource,
  );
  const derived = deriveSessionItems({
    existing: [],
    nextItemId: 1,
    generated: expanded,
    current: {
      graph: analysis.graph,
      hashes: analysis.hashes,
      textModel: analysis.textModel,
      impactTargets: generation.impactTargets,
    },
    baseline: generation.baseline,
  });
  const session: ReviewSession = {
    parameters,
    decompositions: [],
    // Stored identities are current spellings (core/review.ts identity
    // policy): record the journal position they are current at.
    journalLength: analysis.journal.journal.entries.length,
    nextItemId: derived.nextItemId,
    items: derived.items,
  };

  // SPEC 14.22: a symbolic link at a workspace-relative directory component
  // of the write path refuses the write, reported before modifying anything.
  const writeFindings = await symlinkWritePathFindings(workspace.root, [
    sessionFilePath(name),
  ]);
  if (writeFindings.length > 0) {
    emitFindingsReport(invocation.json, stdout, writeFindings);
    return 1;
  }
  await writeSession(workspace.root, name, session);

  if (invocation.json) {
    // SPEC 12.0: one JSON document as the entire standard output.
    emitDocument(stdout, {
      created: {
        items: session.items.length,
        name,
        strategy: parameters.strategy,
      },
    });
  } else {
    stdout.write(
      `created review session '${name}' (${parameters.strategy}): ` +
        `${String(session.items.length)} item(s)\n`,
    );
  }
  return 0;
}

/** The `review create` handler (SPEC 10.7). */
export async function reviewCreateCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const name = flagValue(invocation, "--name");
  if (name === undefined) {
    // Unreachable: the parser enforces the required flag (SPEC 10.7, 12.0).
    throw new Error("xspec internal error: review create without --name");
  }
  // SPEC 13.5: `create` is a mutating subcommand — workspace exclusivity
  // around the whole operation, with the `--test-hold` seam immediately
  // after acquisition; a held workspace fails promptly as a usage error,
  // modifying nothing.
  const outcome = await withMutationExclusivity(
    context.workspace.root,
    testHoldSpecOf(invocation, context.cwd),
    () => runCreate(invocation, context, name),
  );
  if (!outcome.ok) {
    return usageError(context.stderr, invocation.command, outcome.usageMessage);
  }
  return outcome.value;
}

// ---------------------------------------------------------------------------
// `review list` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `review list` handler (SPEC 10.7). */
export async function reviewListCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  // SPEC 13.3: refresh-on-read binds every `review` subcommand.
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }

  // SPEC 10.7: every session in byte order of session name; item counts by
  // stored status — no read-time invalidation — and each corrupt session
  // (14.21) by name as corrupt in place of those fields.
  const loaded = await loadAllSessions(context.workspace.root);
  let anyCorrupt = false;
  const entries: JsonObject[] = [];
  let human = "";
  for (const entry of loaded) {
    if (entry.state === "corrupt") {
      anyCorrupt = true;
      entries.push({ corrupt: true, name: entry.name });
      human += `${entry.name} corrupt\n`;
      continue;
    }
    const counts = countsByStoredStatus(entry.session);
    entries.push({
      corrupt: false,
      counts: countsJson(counts),
      name: entry.name,
      strategy: sessionStrategy(entry.session),
    });
    human +=
      `${entry.name} ${sessionStrategy(entry.session)} ` +
      `${renderCountsHuman(counts)}\n`;
  }
  if (invocation.json) {
    emitDocument(context.stdout, { sessions: entries });
  } else {
    context.stdout.write(human);
  }
  // SPEC 10.7: `list` exits 1 when any session is corrupt, else 0.
  return anyCorrupt ? 1 : 0;
}

// ---------------------------------------------------------------------------
// `review status` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `review status <name>` handler (SPEC 10.7). */
export async function reviewStatusCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const name = invocation.positionals[0];
  if (name === undefined) {
    // Unreachable: the parser enforces the positional (SPEC 10.7).
    throw new Error("xspec internal error: review status without <name>");
  }
  const opened = await openSessionForRead(name, invocation, context);
  if (!opened.ok) {
    return opened.exit;
  }
  const view = opened.view;
  const totals = effectiveTotals(view);

  if (invocation.json) {
    // SPEC 10.7: items in item order — id, kind, scope, status, blocked
    // state — plus totals by status, read-time invalidation applied (10.4).
    emitDocument(context.stdout, {
      items: view.ordered.map((item): JsonObject => ({
        id: item.id,
        kind: item.kind,
        scope: item.scope,
        status: view.statuses.get(item.id) ?? item.status,
        blocked: view.blocked.get(item.id) ?? false,
      })),
      totals: countsJson(totals),
    });
    return 0;
  }
  let out = "";
  for (const item of view.ordered) {
    const status = view.statuses.get(item.id) ?? item.status;
    const blocked = view.blocked.get(item.id) ?? false;
    out += `${item.id} ${item.kind} ${item.scope} ${status} blocked=${String(blocked)}\n`;
  }
  out += `totals: ${renderCountsHuman(totals)}\n`;
  context.stdout.write(out);
  return 0;
}

// ---------------------------------------------------------------------------
// `review show` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `review show <name> <item-id>` handler (SPEC 10.7). */
export async function reviewShowCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const [name, itemId] = invocation.positionals;
  if (name === undefined || itemId === undefined) {
    // Unreachable: the parser enforces the positionals (SPEC 10.7).
    throw new Error("xspec internal error: review show without its arguments");
  }
  const opened = await openSessionForRead(name, invocation, context);
  if (!opened.ok) {
    return opened.exit;
  }
  const view = opened.view;
  const item = view.session.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    // SPEC 10.7 → 12.0: an unknown item ID in any `review` command's
    // arguments is a usage error.
    return usageError(
      context.stderr,
      invocation.command,
      `unknown item '${itemId}' in session '${name}' — no item of the ` +
        `session has that id (SPEC 10.7, 12.0)`,
    );
  }
  if (invocation.json) {
    // SPEC 10.7: the full item — every field of 10.2 plus the same
    // self-contained text payload as `next --json`.
    emitDocument(context.stdout, itemDocument(view, item));
  } else {
    context.stdout.write(renderItemHuman(view, item));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `review export` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `review export <name>` handler (SPEC 10.7). */
export async function reviewExportCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const name = invocation.positionals[0];
  if (name === undefined) {
    // Unreachable: the parser enforces the positional (SPEC 10.7).
    throw new Error("xspec internal error: review export without <name>");
  }
  const opened = await openSessionForRead(name, invocation, context);
  if (!opened.ok) {
    return opened.exit;
  }
  const view = opened.view;
  // SPEC 10.7: the entire session as a single JSON document — its only
  // output form, with or without `--json`: name, strategy, recorded
  // creation parameters and decompositions, every item in item order with
  // every 10.2 field, blocked state, and the payload, read-time
  // invalidation applied (10.4).
  emitDocument(context.stdout, {
    creationParameters: parametersToJson(view.session.parameters),
    decompositions: view.session.decompositions.map(
      (decomposition): JsonObject => ({
        kind: decomposition.kind,
        scope: decomposition.scope,
      }),
    ),
    items: view.ordered.map((item) => itemDocument(view, item)),
    name,
    strategy: sessionStrategy(view.session),
  });
  return 0;
}
