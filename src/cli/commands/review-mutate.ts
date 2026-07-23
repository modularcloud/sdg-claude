// The mutating `xspec review` subcommands beyond `create`: `split` and
// `resolve` (SPEC 10.7). Both modify the session's durable file (SPEC 13.4,
// 13.5), so both run under workspace mutual exclusion with the `--test-hold`
// seam, exactly like `create`, `rename`, and `move`.
//
// Outcome precedence, per subcommand (shared steps through
// review-session.ts's `loadSessionForCommand` — name validity, load with
// the corrupt check, recorded-baseline resolution, refresh-on-read):
//
// `split <name> <item-id>`:
//   1. session name validity (SPEC 10.1 → 12.0, exit 2), unknown session or
//      corrupt session (SPEC 10.7 → 12.0 exit 2; 14.21 exit 1), baseline
//      resolution (SPEC 6.3 → 12.0), refresh (SPEC 13.3);
//   2. an unknown item id is a usage error (SPEC 10.7 → 12.0, exit 2);
//   3. `split` on an item of any other kind than `subtree-coherence`, or on
//      one whose scope root has no children, is refused — exit 1, nothing
//      modified (SPEC 10.7);
//   4. otherwise the decomposition of SPEC 10.7 applies
//      (core/review-derive.ts `splitItemDecomposition`), the write path is
//      validated (SPEC 14.22), and the session file is rewritten.
//
// `resolve <name> <item-id> --status <status> [--note <text>]`:
//   1. as above (the parser already rejects any `--status` value outside
//      `updated`, `no-change`, `skipped` — SPEC 10.7 → 12.0);
//   2. an unknown item id is a usage error (exit 2);
//   3. resolving a blocked item is refused — exit 1, nothing modified —
//      over the effective statuses of SPEC 10.4, so an invalidated blocker
//      re-blocks its dependents (SPEC 10.3);
//   4. otherwise the status is set and the current relevant state recorded
//      (SPEC 10.4; `resolve` applies to any unblocked item regardless of
//      current status), an `updated` resolve re-derives the session
//      (SPEC 10.5, every strategy), the write path is validated
//      (SPEC 14.22), and the session file is rewritten.

import type { ExitCode } from "../../core/findings.js";
import type { ResolveStatus } from "../../core/review.js";
import { sessionFilePath } from "../../core/review.js";
import type { CurrentDerivationSide } from "../../core/review-derive.js";
import {
  resolveSessionItem,
  splitItemDecomposition,
} from "../../core/review-derive.js";
import {
  journalSuffixMapper,
  mapSessionIdentitiesForward,
} from "../../core/review-state.js";
import { withMutationExclusivity } from "../../workspace/lock.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import { writeSession } from "../../workspace/reviews.js";
import { symlinkWritePathFindings } from "../../workspace/writes.js";
import type { Invocation } from "../args.js";
import { flagValue } from "../args.js";
import type { CommandContext } from "../io.js";
import { emitFindingsReport } from "../report.js";
import { emitDocument, testHoldSpecOf, usageError } from "./common.js";
import type { SessionGenerationRun } from "./review-session.js";
import {
  buildSessionReadView,
  emitReviewRefusal,
  loadSessionForCommand,
  runSessionGenerators,
} from "./review-session.js";

/** SPEC 10.7 → 12.0: an unknown item ID in a review command's arguments. */
function unknownItemError(
  invocation: Invocation,
  context: CommandContext,
  name: string,
  itemId: string,
): ExitCode {
  return usageError(
    context.stderr,
    invocation.command,
    `unknown item '${itemId}' in session '${name}' — no item of the ` +
      `session has that id (SPEC 10.7, 12.0)`,
  );
}

/**
 * The current derivation side over the analysis and a generation run —
 * total for every stored item: a `code-impact` item in a strategy without
 * impact data reads an empty target set (review-session.ts
 * `generationStateInputs` makes reads total the same way).
 */
function currentSideOf(
  analysis: WorkspaceAnalysis,
  generation: SessionGenerationRun,
): CurrentDerivationSide {
  return {
    graph: analysis.graph,
    hashes: analysis.hashes,
    textModel: analysis.textModel,
    impactTargets:
      generation.impactTargets ?? new Map<string, readonly string[]>(),
  };
}

/**
 * SPEC 14.22: validate the session file's write path — a symbolic link at a
 * workspace-relative directory component refuses the write, reported before
 * modifying anything — then write the session. Returns null on success.
 */
async function writeSessionChecked(
  invocation: Invocation,
  context: CommandContext,
  name: string,
  session: Parameters<typeof writeSession>[2],
): Promise<ExitCode | null> {
  const findings = await symlinkWritePathFindings(context.workspace.root, [
    sessionFilePath(name),
  ]);
  if (findings.length > 0) {
    emitFindingsReport(invocation.json, context.stdout, findings);
    return 1;
  }
  await writeSession(context.workspace.root, name, session);
  return null;
}

// ---------------------------------------------------------------------------
// `review split` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `split` operation, run under workspace exclusivity (SPEC 13.5). */
async function runSplit(
  invocation: Invocation,
  context: CommandContext,
  name: string,
  itemId: string,
): Promise<ExitCode> {
  const loaded = await loadSessionForCommand(name, invocation, context);
  if (!loaded.ok) {
    return loaded.exit;
  }
  // The mutating subcommands persist current spellings (core/review.ts
  // identity policy): map every recorded identity forward through the
  // journal entries appended since the session was last written.
  const journal = loaded.analysis.journal.journal;
  const session = mapSessionIdentitiesForward(
    loaded.session,
    journalSuffixMapper(journal, loaded.session.journalLength),
    journal.entries.length,
  );
  const original = session.items.find((item) => item.id === itemId);
  if (original === undefined) {
    return unknownItemError(invocation, context, name, itemId);
  }
  // SPEC 10.7: the decomposition items' content is the strategy's to define
  // — its generators, run with the recorded creation parameters, supply the
  // decomposition content source.
  const generation = runSessionGenerators(
    session.parameters,
    loaded.analysis,
    loaded.baseline,
  );
  const split = splitItemDecomposition({
    session,
    original,
    contentSource: generation.contentSource,
    current: currentSideOf(loaded.analysis, generation),
    baseline: generation.baseline,
  });
  if (!split.ok) {
    // SPEC 10.7: the refusal — exit 1, nothing modified.
    return emitReviewRefusal(
      invocation.json,
      context.stdout,
      invocation.command,
      split.refusal,
    );
  }
  const failed = await writeSessionChecked(
    invocation,
    context,
    name,
    split.session,
  );
  if (failed !== null) {
    return failed;
  }
  if (invocation.json) {
    // SPEC 12.0: one JSON document as the entire standard output.
    emitDocument(context.stdout, {
      split: { item: itemId, items: [...split.itemIds], session: name },
    });
  } else {
    context.stdout.write(
      `split item '${itemId}' of session '${name}' into: ` +
        `${split.itemIds.join(", ")}\n`,
    );
  }
  return 0;
}

/** The `review split <name> <item-id>` handler (SPEC 10.7). */
export async function reviewSplitCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const [name, itemId] = invocation.positionals;
  if (name === undefined || itemId === undefined) {
    // Unreachable: the parser enforces the positionals (SPEC 10.7).
    throw new Error("xspec internal error: review split without its arguments");
  }
  // SPEC 13.5: workspace exclusivity around the whole operation, with the
  // `--test-hold` seam immediately after acquisition; a held workspace
  // fails promptly as a usage error, modifying nothing.
  const outcome = await withMutationExclusivity(
    context.workspace.root,
    testHoldSpecOf(invocation, context.cwd),
    () => runSplit(invocation, context, name, itemId),
  );
  if (!outcome.ok) {
    return usageError(context.stderr, invocation.command, outcome.usageMessage);
  }
  return outcome.value;
}

// ---------------------------------------------------------------------------
// `review resolve` (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The `resolve` operation, run under workspace exclusivity (SPEC 13.5). */
async function runResolve(
  invocation: Invocation,
  context: CommandContext,
  name: string,
  itemId: string,
  status: ResolveStatus,
  note: string | undefined,
): Promise<ExitCode> {
  const loaded = await loadSessionForCommand(name, invocation, context);
  if (!loaded.ok) {
    return loaded.exit;
  }
  const generation = runSessionGenerators(
    loaded.session.parameters,
    loaded.analysis,
    loaded.baseline,
  );
  // The read-time view (SPEC 10.4): forward-mapped identities, effective
  // statuses, and blocked states — the blocked refusal is judged over the
  // effective statuses, so a blocker whose resolution went stale re-blocks
  // its dependents (SPEC 10.3).
  const view = buildSessionReadView(
    name,
    loaded.session,
    generation,
    loaded.analysis,
  );
  const item = view.session.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    return unknownItemError(invocation, context, name, itemId);
  }
  if (view.blocked.get(item.id) ?? false) {
    // SPEC 10.7: resolving a blocked item is refused — exit 1, nothing
    // modified. Any *unblocked* item is resolvable regardless of status.
    return emitReviewRefusal(
      invocation.json,
      context.stdout,
      invocation.command,
      `item '${itemId}' of session '${name}' is blocked — an item is ` +
        `blocked while any item in its blockedBy is not resolved, and ` +
        `resolving a blocked item is refused (SPEC 10.3, 10.7)`,
    );
  }
  // SPEC 10.7/10.4: set the status, record the current relevant state; an
  // `updated` resolve re-derives the session with the recorded creation
  // parameters and decompositions against the current workspace
  // (SPEC 10.5 — view.expanded is exactly that decomposition-expanded run).
  const session = resolveSessionItem({
    session: view.session,
    itemId,
    status,
    note,
    expanded: view.expanded,
    current: currentSideOf(loaded.analysis, generation),
    baseline: generation.baseline,
  });
  const failed = await writeSessionChecked(invocation, context, name, session);
  if (failed !== null) {
    return failed;
  }
  if (invocation.json) {
    // SPEC 12.0: one JSON document as the entire standard output.
    emitDocument(context.stdout, {
      resolved: { item: itemId, session: name, status },
    });
  } else {
    context.stdout.write(
      `resolved item '${itemId}' of session '${name}' as ${status}\n`,
    );
  }
  return 0;
}

/** The `review resolve <name> <item-id> --status <status> [--note <text>]`
 * handler (SPEC 10.7). */
export async function reviewResolveCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const [name, itemId] = invocation.positionals;
  if (name === undefined || itemId === undefined) {
    // Unreachable: the parser enforces the positionals (SPEC 10.7).
    throw new Error(
      "xspec internal error: review resolve without its arguments",
    );
  }
  // SPEC 10.7 → 12.0: the parser enforces the required `--status` flag and
  // rejects any value outside `updated`, `no-change`, `skipped`.
  const status = flagValue(invocation, "--status");
  if (status === undefined) {
    throw new Error("xspec internal error: review resolve without --status");
  }
  const note = flagValue(invocation, "--note");
  // SPEC 13.5: workspace exclusivity around the whole operation, with the
  // `--test-hold` seam immediately after acquisition.
  const outcome = await withMutationExclusivity(
    context.workspace.root,
    testHoldSpecOf(invocation, context.cwd),
    () =>
      runResolve(
        invocation,
        context,
        name,
        itemId,
        status as ResolveStatus,
        note,
      ),
  );
  if (!outcome.ok) {
    return usageError(context.stderr, invocation.command, outcome.usageMessage);
  }
  return outcome.value;
}
