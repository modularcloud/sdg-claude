// TEST-SPEC §16 P-10 (concurrency) — PROP-08.
//
// One registered product-facing property test (C-2 "one code path"): a
// seeded, reproducible generator (helpers/property.ts, H-10; fixed seed set
// in CI, E-5) produces randomized schedules of episodes over one workspace —
// each episode exactly one mutating command (`rename`, file-form `move`, or
// `review resolve`), choreographed through the `--test-hold` seam via the
// subprocess driver's background-start, hold-file, and kill support
// (helpers/subprocess.ts, HARNESS-02) — with concurrent readers throughout:
// drawn read commands during the held phase and straddling the
// release-to-exit commit window, plus a continuous polling reader over every
// file path the schedule's mutating commands ever write. P-10's two invariant
// families are asserted post-hoc:
//
//   * readers observe only prior-or-complete file states (SPEC 13.5, cited
//     via T13.5-5 — CERTIFICATIONS.md: P-10's reader half shares T13.5-5's
//     polling machinery): every distinct content the poller observes at a
//     path must byte-equal one of that path's settled states — the states
//     captured in quiescence after staging and after each episode — with
//     absence a state like any other. The settled list enumerates every
//     legitimate complete state because each episode's mutator writes each
//     polled path at most once (a rename rewrites the source in place and
//     regenerates its module, 6.4; a file move deletes the origin and
//     creates the destination, 6.5; a resolve rewrites the session, 10.7;
//     a journaled operation appends one self-contained entry, 6.1) and no
//     concurrent reader writes any polled path (the journal and sessions
//     are written only by their owning commands, 6.1/10.4/13.4; sources by
//     nothing but rename/move; generated modules only by build-style
//     regeneration — and the read menu deliberately excludes `build`, whose
//     concurrent module writes 13.5 last-write-wins would legitimize).
//     The journal is additionally order-checked: successive observations
//     prefix-monotone (append-only, 6.1) and never absent after content
//     (never deleted, 6.1/13.4).
//   * mutual exclusion never loses a journal append or a resolution,
//     accounted post-hoc at each quiescent point: journal lines = successful
//     `rename`/`move` operations — the journal's only writers (6.1) — as
//     exactly one appended entry per completed journaled episode (previous
//     bytes a strict prefix), byte-identity across every resolve episode and
//     every held-point kill, and a zero-entry journal before the first one;
//     session statuses = successful resolves — the item-id set never changes
//     after `create` and every item's status equals the status set by its
//     last completed resolve (`unresolved` before any), read back after
//     every episode and cross-checked at the end against `review list`'s
//     stored-status counts (10.7), with every bracketing read asserted to
//     leave journal and session bytes untouched (10.4, 13.4).
//
// Kill model (SPEC 13.5 "exclusivity ends when the holding command's process
// terminates, normally or abnormally"):
//   * held-point kills for every mutating kind: the hold precedes all
//     modification (T13.5-1), so the settled workspace must be byte-identical
//     across the episode on every polled path — the deterministic no-op that
//     keeps kill/success interleavings exactly accountable. Every episode
//     after a kill also exercises the terminated-holder clause: the next
//     mutating command must reach its own hold and complete.
//   * post-release kills (a drawn delay after hold release, then SIGKILL)
//     for resolve episodes only. Conservative operationalization (H-3/H-4,
//     noted): a post-release-killed rename/move can leave sources invalid,
//     after which 13.3 entitles every review read to refuse (exit 1) and the
//     session accounting would become unassertable — that regime belongs to
//     T13.5-7's disjunctive `check` contract. A killed resolve touches only
//     the session file (10.7, 13.4), so sources stay valid, reads stay
//     asserted, and the kill outcome is exactly two-valued: the target
//     item's status is its prior value or the attempted one — whichever the
//     next quiescent read observes is adopted (the session holds a definite
//     state once the process is dead; atomic visibility excludes anything
//     else) and accounting continues exactly.
//   * kill delays come from a fixed list — scheduling choreography only,
//     never an assertion input (H-10): every assertion is delay-independent.
//
// Concurrent read commands (the menu: `check`, `ids --json`, `query nodes`,
// `review status s --json`, `review list --json` — fixed valid argv, none
// writes a polled path):
//   * held-phase reads run to completion while the mutator is held and must
//     exit 0: the workspace is valid, built, and unmodified while held
//     (T13.5-4's premise). Graph data is fresh at every held point: the
//     quiescent accounting read between episodes refreshes it (13.3) after
//     any commit-window read/mutator write race left it stale.
//   * straddle reads start immediately before the release (or kill) and are
//     awaited after the mutator settles: asserted to terminate without
//     signal death and to exit 0 or 1 — a read overlapping a move's commit
//     window can see the file at neither or both paths (per-path atomicity
//     promises nothing across paths), so transient validation failures are
//     legitimate, but usage errors are not (argv and configuration are fixed
//     valid) and neither is a crash or hang (H-8, 12.0).
//
// Validity discipline (every completed mutating command must exit 0):
//   * `rename` targets a top-level id that exists in the generator's file
//     model with a fresh valid name; file-form `move` targets a fresh
//     `specs/M<n>.mdx` destination (never an existing path). The model
//     evolves only on *completed* rename/move draws, so generation and
//     replay stay deterministic under kills: held-point kills modify
//     nothing, and post-release kills apply only to resolves, which never
//     touch sources (the P-9 concretization pattern).
//   * `resolve` targets only unblocked items — picked by rank from the
//     immediately preceding quiescent `review status` read, with nothing
//     running in between (execution-time rank resolution, the P-9 pattern:
//     item ids are product-assigned, so the generator cannot name them).
//
// Invalidation cannot occur in these schedules — no source edits happen,
// completed renames/moves are pure (6.2: they leave every hash byte-stable
// and by themselves invalidate nothing, 10.4), and killed mutators either
// modified nothing (held point) or touched only the session — so recorded
// hashes always match the current graph and every presented status equals
// the stored status (10.4): the status accounting reads exactly what
// resolves stored. P-10 is outside every CERTIFICATIONS.md fixture scope
// (its preamble), so this body binds only to the real product surface.
//
// The initial workspace is fixed (one importless spec file; audit session
// `s` — no baseline, no git, T10.6-1): P-10's search space is the schedule
// interleavings; workspace-shape search belongs to P-1…P-9. An
// implementation-time dry-run over the committed default seeds at the
// registered 3 runs per seed verified the fixed trial set covers the full
// menu: both journal writers, all three fates (held kills of all three
// kinds, post-release kills at several delays), all three resolve statuses,
// and every read command in both held and straddle position.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ItemStatus,
  SessionStatusReport,
  SessionStatusRow,
} from "../../helpers/adapters/index.js";
import {
  decodeSessionListReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  bytesEqual,
  describeByteDifference,
  fail,
} from "../../helpers/assertions.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty, listOf } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type {
  ProductBinding,
  RunningProduct,
  RunResult,
} from "../../helpers/subprocess.js";
import {
  releaseHoldFile,
  runProduct,
  startProduct,
  summarizeResult,
} from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk, expectExit, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. Audit
// sessions need no code group and no git (SPEC 10.6).
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// The fixed initial spec file (module header): importless and tagless, one
// top-level section with a child plus a second top-level leaf — the audit
// session holds four items (file root, `a`, `a.k`, `g`; SPEC 10.6) with a
// non-trivial `blockedBy` chain, and both `a` and `g` are rename targets.
const INITIAL_SOURCE_REL = "specs/A.mdx";
const INITIAL_TOP_IDS = ["a", "g"] as const;
const A_MDX = [
  '<S id="a">',
  "Alpha text.",
  '<S id="a.k">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="g">',
  "Gamma text.",
  "</S>",
  "",
].join("\n");

const SESSION_NAME = "s";
const JOURNAL_REL = ".xspec/journal";
const SESSION_REL = `.xspec/reviews/${SESSION_NAME}.json`;

/** `NAME.mdx` generates `NAME.xspec.ts` beside it (SPEC 13.1). */
function moduleRelOf(sourceRel: string): string {
  return `${sourceRel.slice(0, -".mdx".length)}.xspec.ts`;
}

// ---------------------------------------------------------------------------
// Schedule model and generator

/** Statuses `resolve --status` accepts (SPEC 10.7). */
export type ResolveStatus = "no-change" | "skipped" | "updated";

/** How a mutating episode ends; `releaseKill` is resolve-only (module header). */
export type P10Fate = "complete" | "heldKill" | "releaseKill";

/**
 * The concurrent-read menu (module header). Fixed valid argv; none writes a
 * polled path (`build` deliberately excluded — its concurrent module writes
 * are legitimate under 13.5 last-write-wins and would break enumerability).
 */
const READ_MENU: readonly {
  readonly argv: readonly string[];
  readonly what: string;
}[] = [
  { argv: ["check"], what: "`check`" },
  { argv: ["ids", "--json"], what: "`ids --json`" },
  { argv: ["query", "nodes"], what: "`query nodes`" },
  {
    argv: ["review", "status", SESSION_NAME, "--json"],
    what: `\`review status ${SESSION_NAME} --json\``,
  },
  { argv: ["review", "list", "--json"], what: "`review list --json`" },
];

/** Post-release kill delays in ms — choreography only, never asserted (H-10). */
const KILL_DELAYS_MS = [0, 3, 10, 30] as const;

interface EpisodeReads {
  /** Indices into READ_MENU, run to completion while the mutator is held. */
  readonly heldReads: readonly number[];
  /** Indices into READ_MENU, started just before the release or kill. */
  readonly straddleReads: readonly number[];
}

export type P10Episode =
  | ({
      readonly kind: "resolve";
      readonly fate: P10Fate;
      readonly rank: number;
      readonly status: ResolveStatus;
      readonly killDelayMs: number;
    } & EpisodeReads)
  | ({
      readonly kind: "rename";
      readonly fate: "complete" | "heldKill";
      readonly file: string;
      readonly oldId: string;
      readonly newId: string;
    } & EpisodeReads)
  | ({
      readonly kind: "move";
      readonly fate: "complete" | "heldKill";
      readonly from: string;
      readonly to: string;
    } & EpisodeReads);

export interface P10Trial {
  readonly episodes: readonly P10Episode[];
}

const MIN_EPISODES = 2;
const MAX_EPISODES = 5;

const genReadSet: Gen<readonly number[]> = listOf(
  (c: Choices) => c.intInclusive(0, READ_MENU.length - 1),
  { max: 2 },
);

/** The trial generator (module header). Exported for dry-run instrumentation. */
export const genP10Trial: Gen<P10Trial> = (choices) => {
  // The evolving concretization model: the single spec file's current path
  // and top-level ids. Mutated only by *completed* rename/move draws, so the
  // body's execution reproduces it exactly (module header).
  let filePath = INITIAL_SOURCE_REL;
  const topIds: string[] = [...INITIAL_TOP_IDS];
  let fresh = 1;

  const genEpisode = (): P10Episode => {
    const heldReads = genReadSet(choices);
    const straddleReads = genReadSet(choices);
    // Simplest first (shrinking): a completed resolve is one command with no
    // journal traffic and no model change.
    const kind = choices.weightedPick<"resolve" | "rename" | "move">([
      [3, "resolve"],
      [3, "rename"],
      [2, "move"],
    ]);
    if (kind === "resolve") {
      const fate = choices.weightedPick<P10Fate>([
        [3, "complete"],
        [1, "heldKill"],
        [2, "releaseKill"],
      ]);
      return {
        kind,
        fate,
        rank: choices.intInclusive(0, 7),
        status: choices.weightedPick<ResolveStatus>([
          [2, "no-change"],
          [2, "updated"],
          [1, "skipped"],
        ]),
        killDelayMs: fate === "releaseKill" ? choices.pick(KILL_DELAYS_MS) : 0,
        heldReads,
        straddleReads,
      };
    }
    // Even weights for `move` (few move episodes occur per trial set, so an
    // uneven split left held-killed moves uncovered on the fixed seeds).
    const fate = choices.weightedPick<"complete" | "heldKill">([
      [kind === "move" ? 2 : 3, "complete"],
      [2, "heldKill"],
    ]);
    if (kind === "rename") {
      const index = choices.intInclusive(0, topIds.length - 1);
      const oldId = topIds[index];
      const newId = `r${String(fresh)}`;
      fresh += 1;
      if (fate === "complete") topIds[index] = newId;
      return { kind, fate, file: filePath, oldId, newId, heldReads, straddleReads };
    }
    const from = filePath;
    const to = `specs/M${String(fresh)}.mdx`;
    fresh += 1;
    if (fate === "complete") filePath = to;
    return { kind, fate, from, to, heldReads, straddleReads };
  };

  const episodes: P10Episode[] = [];
  do {
    episodes.push(genEpisode());
  } while (
    episodes.length < MIN_EPISODES ||
    (episodes.length < MAX_EPISODES && choices.boolean(0.65))
  );
  return { episodes };
};

function describeReads(episode: P10Episode): string {
  const names = (indices: readonly number[]): string =>
    indices.map((i) => READ_MENU[i].what).join(", ");
  const held = episode.heldReads.length > 0 ? ` held:[${names(episode.heldReads)}]` : "";
  const straddle =
    episode.straddleReads.length > 0
      ? ` straddle:[${names(episode.straddleReads)}]`
      : "";
  return `${held}${straddle}`;
}

function describeEpisode(episode: P10Episode): string {
  switch (episode.kind) {
    case "resolve": {
      const delay =
        episode.fate === "releaseKill"
          ? ` +${String(episode.killDelayMs)}ms`
          : "";
      return (
        `resolve rank ${String(episode.rank)} --status ${episode.status} ` +
        `(${episode.fate}${delay})${describeReads(episode)}`
      );
    }
    case "rename":
      return (
        `rename ${episode.file} ${episode.oldId}->${episode.newId} ` +
        `(${episode.fate})${describeReads(episode)}`
      );
    case "move":
      return `move ${episode.from} -> ${episode.to} (${episode.fate})${describeReads(episode)}`;
  }
}

/** Compact counterexample rendering; seed replay reconstructs the rest. */
export function renderP10Trial(trial: P10Trial): string {
  return JSON.stringify(trial.episodes.map(describeEpisode));
}

/** Every path the schedule's mutating commands can ever write (module header). */
function polledPathsOf(trial: P10Trial): readonly string[] {
  const sources = new Set<string>([INITIAL_SOURCE_REL]);
  for (const episode of trial.episodes) {
    if (episode.kind === "move") sources.add(episode.to);
  }
  const paths = [JOURNAL_REL, SESSION_REL];
  for (const source of sources) {
    paths.push(source, moduleRelOf(source));
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Path states, the polling reader, and settled-state bookkeeping

type PathState =
  | { readonly kind: "absent" }
  | { readonly kind: "content"; readonly bytes: Uint8Array };

const ABSENT: PathState = { kind: "absent" };

function stateKey(state: PathState): string {
  return state.kind === "absent"
    ? "absent"
    : `c:${Buffer.from(state.bytes).toString("latin1")}`;
}

function describeState(state: PathState): string {
  return state.kind === "absent"
    ? "absent"
    : `${String(state.bytes.length)} bytes`;
}

async function readPathState(abs: string): Promise<PathState> {
  try {
    return { kind: "content", bytes: await fsp.readFile(abs) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    throw error;
  }
}

function isPrefix(prefix: Uint8Array, whole: Uint8Array): boolean {
  return (
    prefix.length <= whole.length &&
    bytesEqual(whole.subarray(0, prefix.length), prefix)
  );
}

/**
 * Journal entries in a path state: one entry per line (SPEC 6.1). The line
 * terminator is not byte-pinned by 6.1 (H-4: line-oriented form only), so an
 * unterminated final line still counts — any line-oriented representation
 * counts identically.
 */
function journalEntryCount(state: PathState): number {
  if (state.kind === "absent" || state.bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of state.bytes) {
    if (byte === 0x0a) lines += 1;
  }
  if (state.bytes[state.bytes.length - 1] !== 0x0a) lines += 1;
  return lines;
}

interface DistinctObservation {
  readonly state: PathState;
  readonly firstIndex: number;
}

/**
 * The continuous polling reader (T13.5-5's machinery generalized to a fixed
 * path set): a tight loop reading every polled path each cycle, recording
 * distinct states per path plus the journal's order bookkeeping. It never
 * throws — violations and errors are recorded and diagnosed post-hoc (H-8).
 */
class PollingReader {
  readonly distinct = new Map<string, Map<string, DistinctObservation>>();
  observationCycles = 0;
  pollError: string | undefined;
  journalOrderViolation: string | undefined;

  readonly #workspace: TestWorkspace;
  readonly #paths: readonly string[];
  #stop = false;
  #task: Promise<void> | undefined;
  #lastJournal: PathState | undefined;

  constructor(workspace: TestWorkspace, paths: readonly string[]) {
    this.#workspace = workspace;
    this.#paths = paths;
    for (const rel of paths) this.distinct.set(rel, new Map());
  }

  start(): void {
    this.#task = (async () => {
      while (!this.#stop) {
        const cycle = this.observationCycles;
        this.observationCycles += 1;
        for (const rel of this.#paths) {
          let state: PathState;
          try {
            state = await readPathState(this.#workspace.path(rel));
          } catch (error) {
            this.pollError ??= `cycle #${String(cycle)} reading ${rel}: ${(error as Error).message}`;
            continue;
          }
          const perPath = this.distinct.get(rel);
          if (perPath !== undefined) {
            const key = stateKey(state);
            if (!perPath.has(key)) {
              perPath.set(key, { state, firstIndex: cycle });
            }
          }
          if (rel === JOURNAL_REL) this.#checkJournalOrder(state, cycle);
        }
        await sleep(1);
      }
    })();
  }

  /**
   * Journal order bookkeeping (SPEC 6.1: append-only, never deleted): each
   * observation extends the previous one — absence reads as the empty
   * journal, and absence after content is a deletion.
   */
  #checkJournalOrder(state: PathState, cycle: number): void {
    const previous = this.#lastJournal;
    this.#lastJournal = state;
    if (previous === undefined || this.journalOrderViolation !== undefined) {
      return;
    }
    if (previous.kind === "content" && state.kind === "absent") {
      this.journalOrderViolation =
        `cycle #${String(cycle)}: the journal was observed absent after ` +
        `content had been observed (${describeState(previous)}) — the ` +
        `journal is never deleted (SPEC 6.1, 13.4)`;
      return;
    }
    if (previous.kind !== "content" || state.kind !== "content") return;
    if (!isPrefix(previous.bytes, state.bytes)) {
      this.journalOrderViolation =
        `cycle #${String(cycle)}: a journal observation did not extend the ` +
        `previous one — the journal is append-only, so successive reads ` +
        `are prefix-monotone (SPEC 6.1, 13.5)\n` +
        describeByteDifference(
          state.bytes,
          previous.bytes,
          "later observation",
          "earlier observation",
        );
    }
  }

  async stop(): Promise<void> {
    this.#stop = true;
    await (this.#task ?? Promise.resolve());
  }
}

/**
 * Settled-state bookkeeping: the per-path set of legitimate complete states,
 * captured in quiescence (no product process running) after staging and
 * after each episode. `latest` backs the per-episode byte accounting.
 */
class SettledStates {
  readonly keys = new Map<string, Set<string>>();
  readonly samples = new Map<string, PathState[]>();
  latest = new Map<string, PathState>();

  readonly #workspace: TestWorkspace;
  readonly #paths: readonly string[];

  constructor(workspace: TestWorkspace, paths: readonly string[]) {
    this.#workspace = workspace;
    this.#paths = paths;
    for (const rel of paths) {
      this.keys.set(rel, new Set());
      this.samples.set(rel, []);
    }
  }

  /** Read every polled path, record the states, and return the snapshot. */
  async capture(): Promise<ReadonlyMap<string, PathState>> {
    const snapshot = new Map<string, PathState>();
    for (const rel of this.#paths) {
      const state = await readPathState(this.#workspace.path(rel));
      snapshot.set(rel, state);
      const keys = this.keys.get(rel);
      const samples = this.samples.get(rel);
      if (keys !== undefined && samples !== undefined) {
        const key = stateKey(state);
        if (!keys.has(key)) {
          keys.add(key);
          samples.push(state);
        }
      }
    }
    this.latest = snapshot;
    return snapshot;
  }
}

function requireState(
  snapshot: ReadonlyMap<string, PathState>,
  rel: string,
): PathState {
  const state = snapshot.get(rel);
  if (state === undefined) {
    throw new Error(`P-10 harness defect: ${rel} missing from a snapshot`);
  }
  return state;
}

function assertSameState(
  before: ReadonlyMap<string, PathState>,
  after: ReadonlyMap<string, PathState>,
  rel: string,
  context: string,
): void {
  const stateBefore = requireState(before, rel);
  const stateAfter = requireState(after, rel);
  if (stateKey(stateBefore) === stateKey(stateAfter)) return;
  let difference = "";
  if (stateBefore.kind === "content" && stateAfter.kind === "content") {
    difference = `\n${describeByteDifference(stateAfter.bytes, stateBefore.bytes, "after", "before")}`;
  }
  fail(
    `${context} — ${rel}: expected byte-identical state, found ` +
      `${describeState(stateBefore)} before vs ${describeState(stateAfter)} ` +
      `after${difference}`,
  );
}

// ---------------------------------------------------------------------------
// Read-command execution

/**
 * Run one menu read to completion under the driver's hang guard, converting
 * a rejection (hang, runaway output) into a diagnosed failure (H-8).
 */
async function runHeldRead(
  product: ProductBinding,
  cwd: string,
  menuIndex: number,
  context: string,
): Promise<void> {
  const read = READ_MENU[menuIndex];
  let result: RunResult;
  try {
    result = await runProduct(product, { cwd, argv: read.argv });
  } catch (error) {
    return fail(
      `${context} ${read.what}: a read command must run and terminate while ` +
        `a mutating command is held (SPEC 13.5; H-8) — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertExitCode(
    result,
    0,
    `${context} ${read.what}: read commands still run while a mutating ` +
      `command is held, and the workspace is valid, built, and unmodified ` +
      `while held, so the read succeeds (SPEC 13.5, 13.3)`,
  );
}

interface StraddleRead {
  readonly running: RunningProduct;
  readonly what: string;
}

/** Await a straddle read: terminated, no signal death, exit 0 or 1. */
async function settleStraddleRead(
  read: StraddleRead,
  context: string,
): Promise<void> {
  let result: RunResult;
  try {
    result = await read.running.waitForExit();
  } catch (error) {
    return fail(
      `${context} straddling ${read.what}: a read command running across a ` +
        `mutating command's commit window must terminate (SPEC 13.5; H-8: ` +
        `hangs are failures) — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    result.signal !== null ||
    (result.exitCode !== 0 && result.exitCode !== 1)
  ) {
    fail(
      `${context} straddling ${read.what}: a read overlapping the commit ` +
        `window may see transient states (a moving file at neither or both ` +
        `paths), so exit 1 is legitimate — but never a crash or any other ` +
        `code: argv and configuration are fixed valid (SPEC 13.5, 12.0); ` +
        `got ${summarizeResult(result)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Quiescent accounting reads

/** Bracket a quiescent product read: journal and session bytes untouched. */
async function bracketedQuiescentRead<T>(
  workspace: TestWorkspace,
  body: () => Promise<T>,
  context: string,
): Promise<T> {
  const journalBefore = await readPathState(workspace.path(JOURNAL_REL));
  const sessionBefore = await readPathState(workspace.path(SESSION_REL));
  const value = await body();
  const journalAfter = await readPathState(workspace.path(JOURNAL_REL));
  const sessionAfter = await readPathState(workspace.path(SESSION_REL));
  if (stateKey(journalBefore) !== stateKey(journalAfter)) {
    fail(
      `${context}: the read changed ${JOURNAL_REL} from ` +
        `${describeState(journalBefore)} to ${describeState(journalAfter)} — ` +
        `the journal is written only by \`rename\` and \`move\` (SPEC 6.1, ` +
        `13.4), so P-10's journal accounting requires reads to leave it ` +
        `untouched`,
    );
  }
  if (stateKey(sessionBefore) !== stateKey(sessionAfter)) {
    fail(
      `${context}: the read changed ${SESSION_REL} — reads never write the ` +
        `session file (SPEC 10.4, 13.5), so P-10's status accounting ` +
        `requires reads to leave it untouched`,
    );
  }
  return value;
}

/** The status ledger: expected stored status per item id (module header). */
interface StatusLedger {
  /** Item ids learned at the post-`create` read; never changes after. */
  ids: readonly string[];
  readonly expected: Map<string, ItemStatus>;
  /**
   * A post-release-killed resolve whose landing is not yet observed: the
   * target's status is two-valued until the next quiescent read adopts
   * whichever the settled session holds.
   */
  pendingKill: { readonly id: string; readonly status: ResolveStatus } | null;
}

/**
 * The quiescent accounting read (module header): `review status --json`,
 * bracketed, exit 0, decoded; the item-id set must equal the created set and
 * every status must match the ledger — a lost resolution (or a phantom one,
 * an invalidation, a lost or duplicated item) fails here.
 */
async function accountingRead(
  product: ProductBinding,
  workspace: TestWorkspace,
  ledger: StatusLedger,
  context: string,
): Promise<SessionStatusReport> {
  const label = `${context} — quiescent \`review status ${SESSION_NAME} --json\``;
  const report = decodeSessionStatusReport(
    await bracketedQuiescentRead(
      workspace,
      () =>
        runJson(
          product,
          workspace,
          ["review", "status", SESSION_NAME, "--json"],
          label,
        ),
      label,
    ),
    label,
  );

  const observedIds = report.items.map((row) => row.id).sort();
  const expectedIds = [...ledger.ids].sort();
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    fail(
      `${label}: the item-id set must never change after \`create\` in ` +
        `these schedules — no edits happen, completed renames/moves are ` +
        `pure and identity mappings duplicate no item (SPEC 6.2, 10.4), ` +
        `and re-derivation over the unchanged workspace matches every ` +
        `existing item (SPEC 10.5) — expected ` +
        `${JSON.stringify(expectedIds)}, got ${JSON.stringify(observedIds)}`,
    );
  }

  for (const row of report.items) {
    const expected = ledger.expected.get(row.id);
    if (expected === undefined) {
      throw new Error(`P-10 harness defect: no expectation for item ${row.id}`);
    }
    if (ledger.pendingKill !== null && ledger.pendingKill.id === row.id) {
      const attempted = ledger.pendingKill.status;
      if (row.status !== expected && row.status !== attempted) {
        fail(
          `${label}: item ${row.id} was the target of a post-release-killed ` +
            `resolve, so its stored status is exactly two-valued — the ` +
            `prior ${JSON.stringify(expected)} (the kill landed first) or ` +
            `the attempted ${JSON.stringify(attempted)} (the write landed ` +
            `first); atomic visibility excludes anything else (SPEC 13.5, ` +
            `10.7) — got ${JSON.stringify(row.status)}`,
        );
      }
      ledger.expected.set(row.id, row.status);
      continue;
    }
    if (row.status !== expected) {
      fail(
        `${label}: item ${row.id} must hold the status of its last ` +
          `completed resolve — mutual exclusion never loses a resolution, ` +
          `nothing in these schedules invalidates (SPEC 13.5, 6.2, 10.4), ` +
          `and presented statuses equal stored statuses — expected ` +
          `${JSON.stringify(expected)}, got ${JSON.stringify(row.status)}`,
      );
    }
  }
  ledger.pendingKill = null;
  return report;
}

// ---------------------------------------------------------------------------
// Episode execution

const HOLD_APPEAR_CONTEXT =
  "the mutating command must create the hold file immediately after " +
  "acquiring workspace exclusivity and before modifying anything (SPEC 13.5)";

function mutatorArgv(episode: P10Episode, resolveTargetId: string): string[] {
  switch (episode.kind) {
    case "resolve":
      return [
        "review",
        "resolve",
        SESSION_NAME,
        resolveTargetId,
        "--status",
        episode.status,
      ];
    case "rename":
      return ["rename", episode.file, episode.oldId, episode.newId];
    case "move":
      return ["move", episode.from, episode.to];
  }
}

/**
 * Pick the drawn resolve target from the last quiescent status rows: the
 * rank-picked unblocked item (SPEC 10.7 refuses blocked targets; re-resolving
 * a resolved item is valid). Nothing runs between that read and the resolve.
 */
function resolveTarget(
  rows: readonly SessionStatusRow[],
  rank: number,
  context: string,
): SessionStatusRow {
  const unblocked = rows.filter((row) => !row.blocked);
  if (unblocked.length === 0) {
    fail(
      `${context}: no unblocked item to resolve — the audit session always ` +
        `holds items here, and with acyclic blockedBy some item's blockers ` +
        `are all resolved (SPEC 10.1, 10.3, 10.6), so a non-empty session ` +
        `with zero unblocked items violates the blocking contract (got ` +
        `${String(rows.length)} items, all reported blocked)`,
    );
  }
  return unblocked[rank % unblocked.length];
}

interface EpisodeOutcome {
  /** True when a completed resolve's status write is known to have landed. */
  readonly resolveCompleted: boolean;
}

/** Run one episode: mutator + held reads + straddle reads + fate. */
async function runEpisode(
  product: ProductBinding,
  workspace: TestWorkspace,
  episode: P10Episode,
  episodeIndex: number,
  resolveTargetId: string,
  context: string,
): Promise<EpisodeOutcome> {
  const hold = path.join(
    workspace.tempRoot,
    `hold-${String(episodeIndex)}.tmp`,
  );
  const argv = [
    ...mutatorArgv(episode, resolveTargetId),
    "--test-hold",
    hold,
  ];
  const running = await startProduct(product, {
    cwd: workspace.root,
    argv,
  });
  const straddle: StraddleRead[] = [];
  try {
    try {
      await running.waitForFile(hold);
    } catch (error) {
      fail(
        `${context}: ${HOLD_APPEAR_CONTEXT} — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Held-phase reads: concurrent with the held mutator, sequential among
    // themselves, each asserted exit 0 (module header).
    for (const menuIndex of episode.heldReads) {
      await runHeldRead(product, workspace.root, menuIndex, `${context} held`);
    }
    if (running.hasExited()) {
      const outcome = await running
        .waitForExit()
        .then(summarizeResult, (error: unknown) =>
          error instanceof Error ? error.message : String(error),
        );
      fail(
        `${context}: the mutating command must proceed only once the hold ` +
          `file is deleted, but it exited while still held (SPEC 13.5) — ` +
          `${outcome}`,
      );
    }

    // Straddle reads: started before the release or kill, so they overlap
    // the commit window (or the kill) — settled after the mutator.
    for (const menuIndex of episode.straddleReads) {
      straddle.push({
        running: await startProduct(product, {
          cwd: workspace.root,
          argv: READ_MENU[menuIndex].argv,
        }),
        what: READ_MENU[menuIndex].what,
      });
    }

    let resolveCompleted = false;
    if (episode.fate === "heldKill") {
      // The hold file is never deleted: the kill lands at the held point,
      // before any modification (SPEC 13.5; T13.5-1).
      running.kill("SIGKILL");
      await settleKilled(running, context);
    } else {
      await releaseHoldFile(hold);
      if (episode.fate === "releaseKill") {
        if (episode.killDelayMs > 0) await sleep(episode.killDelayMs);
        running.kill("SIGKILL");
        await settleKilled(running, context);
      } else {
        let result: RunResult;
        try {
          result = await running.waitForExit();
        } catch (error) {
          fail(
            `${context}: once the hold file is deleted the mutating command ` +
              `must proceed and complete (SPEC 13.5; H-8) — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        assertExitCode(
          result,
          0,
          `${context}: the drawn operation is valid by construction — an ` +
            `existing target, a fresh name or destination, an unblocked ` +
            `item — and a mutating command that reached its hold and was ` +
            `released completes it (SPEC 13.5, 6.4, 6.5, 10.7). Every ` +
            `episode after a kill also proves the terminated holder ` +
            `released exclusivity (SPEC 13.5)`,
        );
        resolveCompleted = episode.kind === "resolve";
      }
    }

    for (const read of straddle) {
      await settleStraddleRead(read, context);
    }
    return { resolveCompleted };
  } finally {
    running.kill();
    for (const read of straddle) read.running.kill();
    await releaseHoldFile(hold);
  }
}

/** Settle a killed mutator; the death's shape is not asserted. */
async function settleKilled(
  running: RunningProduct,
  context: string,
): Promise<void> {
  try {
    await running.waitForExit();
  } catch (error) {
    fail(
      `${context}: the killed mutating command must settle (H-8) — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-episode byte accounting over settled snapshots

function assertJournalAppended(
  before: ReadonlyMap<string, PathState>,
  after: ReadonlyMap<string, PathState>,
  context: string,
): void {
  const stateBefore = requireState(before, JOURNAL_REL);
  const stateAfter = requireState(after, JOURNAL_REL);
  if (stateAfter.kind !== "content") {
    fail(
      `${context}: after a completed journaled operation the journal exists ` +
        `at ${JOURNAL_REL} (SPEC 6.1: the file comes into existence with ` +
        `the first journaled operation); found ${describeState(stateAfter)}`,
    );
  }
  const bytesBefore =
    stateBefore.kind === "content" ? stateBefore.bytes : new Uint8Array(0);
  if (!isPrefix(bytesBefore, stateAfter.bytes)) {
    fail(
      `${context}: the journal is append-only — the pre-episode bytes must ` +
        `be a prefix of the post-episode bytes (SPEC 6.1)\n` +
        describeByteDifference(
          stateAfter.bytes,
          bytesBefore,
          "after",
          "before",
        ),
    );
  }
  const countBefore = journalEntryCount(stateBefore);
  const countAfter = journalEntryCount(stateAfter);
  if (countAfter !== countBefore + 1) {
    fail(
      `${context}: exactly one self-contained entry per completed rename or ` +
        `move — journal lines = successful \`rename\`/\`move\` operations ` +
        `(SPEC 6.1; P-10 accounting) — expected ` +
        `${String(countBefore + 1)} entries, got ${String(countAfter)}`,
    );
  }
}

function settledAccounting(
  episode: P10Episode,
  before: ReadonlyMap<string, PathState>,
  after: ReadonlyMap<string, PathState>,
  polled: readonly string[],
  context: string,
): void {
  if (episode.fate === "heldKill") {
    // The strongest accounting: a held-point kill modified nothing.
    for (const rel of polled) {
      assertSameState(
        before,
        after,
        rel,
        `${context}: a mutating command killed at the held point modified ` +
          `nothing — the hold precedes all modification, and its exclusivity ` +
          `died with the process (SPEC 13.5)`,
      );
    }
    return;
  }
  if (episode.kind === "resolve") {
    // Completed or post-release-killed resolve: the session file is its
    // only legitimate write among the polled paths.
    for (const rel of polled) {
      if (rel === SESSION_REL) continue;
      assertSameState(
        before,
        after,
        rel,
        `${context}: a \`review resolve\` writes the session file alone — ` +
          `never the journal (its only writers are \`rename\` and \`move\`, ` +
          `SPEC 6.1), never sources or generated modules (SPEC 10.7, 13.4)`,
      );
    }
    return;
  }
  // Completed rename or move: one appended journal entry; sessions untouched.
  assertJournalAppended(before, after, context);
  assertSameState(
    before,
    after,
    SESSION_REL,
    `${context}: \`rename\` and \`move\` never write review sessions — ` +
      `identity mappings are applied at read time, not persisted into ` +
      `sessions (SPEC 10.4, 13.4)`,
  );
}

// ---------------------------------------------------------------------------
// The trial body

async function runP10Trial(
  product: ProductBinding,
  trial: P10Trial,
): Promise<void> {
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": SPECS_ONLY_CONFIG,
      [INITIAL_SOURCE_REL]: A_MDX,
    },
  });
  const polled = polledPathsOf(trial);
  const settled = new SettledStates(workspace, polled);
  const poller = new PollingReader(workspace, polled);
  try {
    // --- Staging: build, create the audit session, learn the item set ---
    await buildOk(
      product,
      workspace,
      "P-10 staging `build` (the fixed workspace is valid)",
    );
    await expectExit(
      product,
      workspace,
      ["review", "create", "--strategy", "audit", "--name", SESSION_NAME],
      0,
      `P-10 staging \`review create --strategy audit --name ${SESSION_NAME}\` ` +
        `(a fresh valid name; audit needs no baseline, SPEC 10.6)`,
    );

    const ledger: StatusLedger = {
      ids: [],
      expected: new Map(),
      pendingKill: null,
    };
    const initialLabel = "P-10 after `review create`";
    const initialReport = decodeSessionStatusReport(
      await bracketedQuiescentRead(
        workspace,
        () =>
          runJson(
            product,
            workspace,
            ["review", "status", SESSION_NAME, "--json"],
            `${initialLabel} — \`review status ${SESSION_NAME} --json\``,
          ),
        `${initialLabel} — \`review status ${SESSION_NAME} --json\``,
      ),
      `${initialLabel} — \`review status ${SESSION_NAME} --json\``,
    );
    if (initialReport.items.length === 0) {
      fail(
        `${initialLabel}: staging premise — an audit session over a ` +
          `non-empty workspace holds one item per requirement node ` +
          `(SPEC 10.6), but \`status\` reports none`,
      );
    }
    ledger.ids = initialReport.items.map((row) => row.id);
    if (new Set(ledger.ids).size !== ledger.ids.length) {
      fail(
        `${initialLabel}: item ids must be unique within the session ` +
          `(SPEC 10.1, 10.2) — got ${JSON.stringify(ledger.ids)}`,
      );
    }
    for (const row of initialReport.items) {
      if (row.status !== "unresolved") {
        fail(
          `${initialLabel}: every item enters the session \`unresolved\` ` +
            `(SPEC 10.2) — the accounting baseline — but item ${row.id} ` +
            `reports ${JSON.stringify(row.status)}`,
        );
      }
      ledger.expected.set(row.id, "unresolved");
    }

    // --- Initial settled capture; the poller runs from here on ---
    let previous = await settled.capture();
    const initialJournal = requireState(previous, JOURNAL_REL);
    if (journalEntryCount(initialJournal) !== 0) {
      fail(
        `P-10 accounting baseline: before any \`rename\` or \`move\` the ` +
          `journal has zero entries — it is written only by those commands ` +
          `and comes into existence with the first journaled operation ` +
          `(SPEC 6.1) — found ${describeState(initialJournal)} at ` +
          `${JOURNAL_REL}`,
      );
    }
    poller.start();

    // --- The schedule ---
    let rows: readonly SessionStatusRow[] = initialReport.items;
    try {
      for (let index = 0; index < trial.episodes.length; index += 1) {
        const episode = trial.episodes[index];
        const context = `P-10 episode ${String(index + 1)}/${String(trial.episodes.length)} [${describeEpisode(episode)}]`;

        let targetId = "";
        if (episode.kind === "resolve") {
          const target = resolveTarget(rows, episode.rank, context);
          targetId = target.id;
          if (episode.fate === "releaseKill") {
            ledger.pendingKill = { id: targetId, status: episode.status };
          }
        }

        const outcome = await runEpisode(
          product,
          workspace,
          episode,
          index,
          targetId,
          context,
        );
        if (outcome.resolveCompleted && episode.kind === "resolve") {
          ledger.expected.set(targetId, episode.status);
        }

        const now = await settled.capture();
        settledAccounting(episode, previous, now, polled, context);
        previous = now;

        rows = (
          await accountingRead(
            product,
            workspace,
            ledger,
            `${context} — post-episode accounting`,
          )
        ).items;
      }
    } finally {
      await poller.stop();
    }

    // --- Post-hoc poller validation (T13.5-5's protocol, module header) ---
    if (poller.pollError !== undefined) {
      fail(
        `P-10: the polling reader hit an unexpected filesystem error — ` +
          poller.pollError,
      );
    }
    if (poller.journalOrderViolation !== undefined) {
      fail(`P-10: ${poller.journalOrderViolation}`);
    }
    if (poller.observationCycles === 0) {
      fail(
        "P-10 staging premise: the polling reader completed zero cycles " +
          "across the whole schedule — the polling cadence is broken",
      );
    }
    for (const rel of polled) {
      const observed = poller.distinct.get(rel);
      const legitimate = settled.keys.get(rel);
      const samples = settled.samples.get(rel);
      if (
        observed === undefined ||
        legitimate === undefined ||
        samples === undefined
      ) {
        throw new Error(`P-10 harness defect: no bookkeeping for ${rel}`);
      }
      for (const [key, observation] of observed) {
        if (legitimate.has(key)) continue;
        let nearest: PathState | undefined;
        if (observation.state.kind === "content") {
          for (const candidate of samples) {
            if (candidate.kind !== "content") continue;
            if (
              nearest === undefined ||
              nearest.kind !== "content" ||
              Math.abs(candidate.bytes.length - observation.state.bytes.length) <
                Math.abs(nearest.bytes.length - observation.state.bytes.length)
            ) {
              nearest = candidate;
            }
          }
        }
        fail(
          `P-10: cycle #${String(observation.firstIndex)} observed ${rel} in ` +
            `a state matching no settled state of that path — a concurrent ` +
            `reader only ever observes the prior state or the complete new ` +
            `content, never a partial write (SPEC 13.5; T13.5-5's protocol). ` +
            `Observed ${describeState(observation.state)}; settled states: ` +
            `${samples.map(describeState).join(", ")}.` +
            (nearest !== undefined &&
            nearest.kind === "content" &&
            observation.state.kind === "content"
              ? `\n${describeByteDifference(observation.state.bytes, nearest.bytes, "observed", "nearest settled")}`
              : ""),
        );
      }
    }

    // --- Final cross-check: stored-status counts via `review list` ---
    const listLabel = "P-10 final `review list --json`";
    const listed = decodeSessionListReport(
      await bracketedQuiescentRead(
        workspace,
        () =>
          runJson(product, workspace, ["review", "list", "--json"], listLabel),
        listLabel,
      ),
      listLabel,
    );
    const entry = listed.sessions.find(
      (session) => session.name === SESSION_NAME,
    );
    if (listed.sessions.length !== 1 || entry === undefined) {
      fail(
        `${listLabel}: \`list\` reports exactly the created session ` +
          `${JSON.stringify(SESSION_NAME)} (SPEC 10.7, 10.1) — got ` +
          `${JSON.stringify(listed.sessions.map((session) => session.name))}`,
      );
    }
    if (entry.corrupt) {
      fail(
        `${listLabel}: the session must never read as corrupt — every write ` +
          `to it was atomic and complete (SPEC 13.5, 10.1, 14.21)`,
      );
    }
    const expectedCounts: Record<string, number> = {};
    for (const status of ledger.expected.values()) {
      expectedCounts[status] = (expectedCounts[status] ?? 0) + 1;
    }
    const reportedTotal = Object.values(entry.counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (reportedTotal !== ledger.ids.length) {
      fail(
        `${listLabel}: stored-status counts must cover exactly the ` +
          `session's ${String(ledger.ids.length)} items (SPEC 10.7) — ` +
          `reported ${JSON.stringify(entry.counts)} (total ` +
          `${String(reportedTotal)})`,
      );
    }
    for (const status of [
      "unresolved",
      "invalidated",
      "updated",
      "no-change",
      "skipped",
    ]) {
      const reported = entry.counts[status] ?? 0;
      const expected = expectedCounts[status] ?? 0;
      if (reported !== expected) {
        fail(
          `${listLabel}: \`list\` counts from stored statuses, without ` +
            `read-time invalidation (SPEC 10.7) — session statuses = ` +
            `successful resolves (P-10 accounting) — expected ` +
            `${String(expected)} ${JSON.stringify(status)} item(s), got ` +
            `${String(reported)} (expected counts ` +
            `${JSON.stringify(expectedCounts)}, reported ` +
            `${JSON.stringify(entry.counts)})`,
        );
      }
    }
  } finally {
    await poller.stop();
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// Registration

const P_10 = defineProductTest({
  id: "P-10",
  title:
    "concurrency under randomized schedules of concurrent readers and one mutating command via --test-hold and process kills (TEST-SPEC §16 P-10): episodes of `rename`, file-form `move`, and `review resolve` — completed, killed at the held point, or (resolves) killed after release — with read commands during the held phase and straddling the commit window and a continuous polling reader over the journal, the session file, sources, and generated modules; readers observe only prior-or-complete file states (every distinct polled observation byte-equals a settled state, the journal prefix-monotone and never deleted, T13.5-5's protocol); and post-hoc accounting loses nothing: journal lines = successful rename/move operations (exactly one appended entry each, byte-identity across resolves and held-point kills, zero entries at baseline, SPEC 6.1), session statuses = successful resolves (stable item-id set, per-item status equal to the last completed resolve with killed resolves exactly two-valued, `review list` stored-status counts matching, SPEC 10.4, 10.7), with every bracketing read leaving journal and session bytes untouched (SPEC 13.4, 13.5)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), up to 5
  // episodes per trial, each episode costing a handful of product
  // invocations (the mutator, up to four reads, the accounting read).
  timeoutMs: 600_000,
  run: async (product) => {
    await checkProperty(
      "P-10 concurrency schedules",
      genP10Trial,
      async (trial) => {
        await runP10Trial(product, trial);
      },
      { runs: 3, maxShrinkExecutions: 25, render: renderP10Trial },
    );
  },
});

/** TEST-SPEC §16 P-10, registered as PROP-08. */
export const section16P10Tests: readonly ProductTestEntry[] = [P_10];
