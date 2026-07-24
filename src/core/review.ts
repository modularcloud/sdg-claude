// The review session model and stored form (SPEC 10.1–10.3).
//
// SPEC 10.1: a review session is stored at `.xspec/reviews/<session-name>.json`
// as a plain, deterministic file — a durable task ledger (13.4), written only
// by the mutating `review` subcommands and never regenerated. A session name
// is one or more characters of `A–Z a–z 0–9 . _ -`, never beginning with `.`;
// names are case-sensitive, with `review create` alone refusing a name that
// matches an existing session's ignoring ASCII case (10.7). A session file
// that is not a plain file, cannot be parsed, or violates a session invariant
// is corrupt (14.21).
//
// Stored document (this implementation's design; SPEC.md fixes the
// information, not the concrete shape) — one canonical-JSON document
// (canonical-json.ts: sorted keys, two-space indentation, trailing newline):
//
//   {
//     "creationParameters": {"base": <commit>} | {} | {"profile": {…}},
//     "decompositions": [{"kind": "subtree-coherence", "scope": <ref>}, …],
//     "items": [<item>, …],
//     "journalLength": <n>,
//     "nextItemId": <n>,
//     "strategy": "path-blocks" | "audit" | "coverage",
//     "version": 1
//   }
//
// where every node reference <ref> is a canonical identity key (identity
// policy below).
//
// and each item carries exactly the fields of SPEC 10.2 — `id`, `kind`,
// `scope`, `context`, `reason`, `origin`, `baseline`, `current`, `status`,
// optional `note`, `blockedBy` — plus the recorded text snapshots
// (`baselineTexts`, `derivedTexts`) that keep items actionable after the
// referenced nodes are edited, moved, or deleted (SPEC 10.2, 10.7: an absent
// node's text is its value in the most recent graph state that contained it,
// among the item's `baseline` state and the states under which mutating
// subcommands derived the item).
//
// Identity policy: every stored node reference — an item's `scope`, its
// `context` and `origin` entries, the node keys of `baseline`/`current` and
// of `baselineTexts`/`derivedTexts`, and each recorded decomposition's
// `scope` — is a canonical identity (SPEC 5.4) in the injective key
// encoding of src/core/journal.ts (`<position>:<identity>`,
// `encodeCanonicalIdentity`). A node's canonical identity never changes as
// the journal grows (SPEC 6.1: append-only), so byte equality of stored
// references IS the canonical comparison SPEC 10.4 requires wherever review
// compares or matches recorded nodes — item matching, decomposition
// matching, and the at-most-one invariant (10.1, 10.5) are checked
// byte-wise here, journal-free. Two canonically distinct nodes may come to
// share one forward-mapped spelling (a spelling vacated by a manual
// deletion, SPEC 6.6, and later recaptured by a journaled rename), which is
// exactly why spellings are never the stored or matching key. Reads derive
// each reference's current spelling — the recorded identity mapped forward
// through the journal (SPEC 10.4, 6.3) — for presentation and graph
// lookups only (src/core/review-state.ts).
//
// `journalLength` records the journal's entry count when the session was
// last written — the write-moment bound: every stored reference's canonical
// position is <= it (positions come from walks over that journal or a
// prefix of it), and parsing enforces the bound as a session invariant. It
// plays no identity-mapping role.
//
// This module is pure (IMPLEMENTATION Architecture): the model, name rules,
// status semantics, parsing, validation, and serialization take bytes and
// values. File I/O — reading `.xspec/reviews/`, classifying occupants,
// writing session files — lives in src/workspace/reviews.ts.

import { compareBytes } from "./bytes.js";
import { canonicalJson } from "./canonical-json.js";
import type { JsonObject, JsonValue } from "./canonical-json.js";
import { parseCanonicalIdentity } from "./journal.js";
import type {
  Configuration,
  ConfiguredGroup,
  CoverageProfile,
  DependencyEdgeKind,
} from "./config.js";
import { DEPENDENCY_EDGE_KINDS } from "./config.js";
import type { Finding } from "./findings.js";

/** SPEC 10.1: the reviews directory under the workspace root. */
export const REVIEWS_DIRECTORY = ".xspec/reviews";

/** The session file's workspace-relative path (SPEC 10.1). */
export function sessionFilePath(name: string): string {
  return `${REVIEWS_DIRECTORY}/${name}.json`;
}

// ---------------------------------------------------------------------------
// Session names (SPEC 10.1)
// ---------------------------------------------------------------------------

/**
 * SPEC 10.1: a session name consists of one or more characters from `A–Z`,
 * `a–z`, `0–9`, `.`, `_`, and `-`, and does not begin with `.`.
 */
export function isValidSessionName(name: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name);
}

/**
 * The usage-error diagnostic for an invalid session name, or null for a
 * valid one (SPEC 10.1 → 12.0: any other name is a usage error).
 */
export function sessionNameProblem(name: string): string | null {
  if (isValidSessionName(name)) {
    return null;
  }
  const reason =
    name.length === 0
      ? "it is empty"
      : name.startsWith(".")
        ? "it begins with `.`"
        : "it contains a character outside `A-Z a-z 0-9 . _ -`";
  return (
    `invalid session name ${JSON.stringify(name)}: ${reason} — a session ` +
    `name must consist of one or more characters from A-Z, a-z, 0-9, ` +
    `\`.\`, \`_\`, and \`-\`, and must not begin with \`.\` (SPEC 10.1)`
  );
}

/** ASCII case folding (A–Z → a–z); no other character is touched. */
export function asciiCaseFold(text: string): string {
  let folded = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    folded +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : character;
  }
  return folded;
}

/**
 * SPEC 10.1: the existing session name that `candidate` matches ignoring
 * ASCII case, or null when none does. `review create` treats a match as the
 * name of an existing session and refuses it (10.7); every other subcommand
 * matches names exactly, byte-wise (SPEC 12.0).
 */
export function existingNameIgnoringAsciiCase(
  existing: Iterable<string>,
  candidate: string,
): string | null {
  const folded = asciiCaseFold(candidate);
  for (const name of existing) {
    if (asciiCaseFold(name) === folded) {
      return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statuses (SPEC 10.3) and item kinds (SPEC 10.2, 10.4–10.7)
// ---------------------------------------------------------------------------

/** SPEC 10.3: the five item statuses. */
export const ITEM_STATUSES = [
  "unresolved",
  "updated",
  "no-change",
  "skipped",
  "invalidated",
] as const;

export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** SPEC 10.7: the statuses `resolve --status` accepts. */
export const RESOLVE_STATUSES = ["updated", "no-change", "skipped"] as const;

export type ResolveStatus = (typeof RESOLVE_STATUSES)[number];

/**
 * SPEC 10.3: an item is resolved when its status is `updated`, `no-change`,
 * or `skipped`; `unresolved` and `invalidated` items need review.
 */
export function isResolvedStatus(status: ItemStatus): boolean {
  return status === "updated" || status === "no-change" || status === "skipped";
}

/** SPEC 10.3: `unresolved` and `invalidated` items need review. */
export function statusNeedsReview(status: ItemStatus): boolean {
  return !isResolvedStatus(status);
}

/** The built-in item kinds (SPEC 10.4–10.6, 10.7 coverage sessions). */
export const ITEM_KINDS = [
  "subtree-coherence",
  "parent-consistency",
  "dependency-consistency",
  "metadata-consistency",
  "code-impact",
  "uncovered-requirement",
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Whether a kind's scope is a code location (SPEC 10.2: scope holds
 * requirement nodes or code locations; only `code-impact` scopes the
 * latter, 10.5).
 */
export function kindScopesCodeLocation(kind: ItemKind): boolean {
  return kind === "code-impact";
}

// ---------------------------------------------------------------------------
// The item model (SPEC 10.2)
// ---------------------------------------------------------------------------

/** The recordable hash names (SPEC 5.5 → 10.4 relevant-hash table). */
export const RECORDED_HASH_NAMES = [
  "ownHash",
  "subtreeHash",
  "effectiveHash",
  "metadataHash",
] as const;

export type RecordedHashName = (typeof RECORDED_HASH_NAMES)[number];

/** A node's recorded relevant hashes, by hash name (SPEC 10.4). */
export type RecordedHashes = Readonly<
  Partial<Record<RecordedHashName, string>>
>;

/**
 * One node's recorded state (SPEC 10.4): whether it was present, and — for a
 * present node — its relevant hash values per the item kind's table; an
 * absent node's hashes are recorded as the explicit `"absent"` marker.
 */
export type RecordedNodeState =
  | { readonly present: true; readonly hashes: RecordedHashes }
  | { readonly present: false; readonly hashes: "absent" };

/**
 * A recorded state of SPEC 10.4 — the value of an item's `baseline` and
 * `current` fields (10.2): per scope, context, and origin node (and, for
 * `code-impact`, per impact-edge target), keyed by the node's identity as
 * stored (the identity policy of the module header).
 */
export interface RecordedState {
  readonly nodes: Readonly<Record<string, RecordedNodeState>>;
}

/**
 * A node's recorded text snapshots (SPEC 10.2: items carry enough baseline
 * text to remain actionable after the referenced nodes are edited, moved,
 * or deleted; SPEC 10.7 fixes which value each payload role presents). Code
 * locations have no text value (10.7) and get no entry.
 */
export interface RecordedTexts {
  /** The node's own text — the expanded value of SPEC 1.6. */
  readonly ownText?: string;
  /** The node's subtree text — the expanded value of SPEC 1.6. */
  readonly subtreeText?: string;
}

/** A per-node text snapshot table, keyed like `RecordedState.nodes`. */
export type RecordedTextTable = Readonly<Record<string, RecordedTexts>>;

/** One review item (SPEC 10.2). */
export interface ReviewItem {
  /** Unique within the session; never reused after removal (SPEC 10.7). */
  readonly id: string;
  /** Assigned by the strategy (SPEC 10.2). */
  readonly kind: ItemKind;
  /**
   * The scope node: the requirement node (subtree root for
   * `subtree-coherence`, SPEC 10.5) or the scoped code location
   * (`code-impact`) under review.
   */
  readonly scope: string;
  /** Nodes whose text frames the review (SPEC 10.2), by identity. */
  readonly context: readonly string[];
  /** Why the item exists — human-readable (SPEC 10.2). */
  readonly reason: string;
  /** The originating nodes (SPEC 5.6), when applicable, by identity. */
  readonly origin: readonly string[];
  /**
   * SPEC 10.2: fixed when the item enters the session — baseline-graph
   * values in a baseline session, current-graph values at entry in `audit`
   * and `coverage` sessions.
   */
  readonly baseline: RecordedState;
  /**
   * SPEC 10.2/10.4: the recorded state — written at item creation,
   * rewritten at each resolve; read-time invalidation compares it against
   * the current graph and never rewrites it.
   */
  readonly current: RecordedState;
  readonly status: ItemStatus;
  /** SPEC 10.2/10.7: the optional `--note` text of the last resolve. */
  readonly note?: string;
  /** Item IDs that must resolve first (SPEC 10.2, 10.3). */
  readonly blockedBy: readonly string[];
  /**
   * Text snapshots at the item's `baseline` state (SPEC 10.7: an origin
   * node's before text comes from the item's `baseline` state); entries
   * exist only for nodes present in that state.
   */
  readonly baselineTexts: RecordedTextTable;
  /**
   * Text snapshots from the most recent mutating-subcommand derivation
   * whose graph contained the node (SPEC 10.7): rewritten per node at each
   * derivation that finds it present, never removed.
   */
  readonly derivedTexts: RecordedTextTable;
}

// ---------------------------------------------------------------------------
// The session model (SPEC 10.1, 10.7)
// ---------------------------------------------------------------------------

export type ReviewStrategy = "path-blocks" | "audit" | "coverage";

/**
 * SPEC 10.7: a recorded group reference — the group name replaced by the
 * group's configured glob list and kind at `create` time.
 */
export interface RecordedGroup {
  readonly kind: "spec" | "code";
  /** The group's configured glob patterns, as written (SPEC 7.1, 7.2). */
  readonly globs: readonly string[];
}

/**
 * SPEC 10.7: a coverage session's recorded profile definition — its 7.4
 * fields, fully resolved, with each group name replaced by that group's
 * configured glob list and kind.
 */
export interface RecordedProfile {
  readonly name: string;
  readonly target: RecordedGroup;
  /** When present, never empty (SPEC 7.4). */
  readonly targetTags?: readonly string[];
  readonly targets: "leaves" | "all";
  readonly boundary: RecordedGroup;
  readonly mode: "direct" | "transitive";
  /** Never empty (SPEC 7.4: defaults to all three). */
  readonly edgeKinds: readonly DependencyEdgeKind[];
}

/**
 * SPEC 10.7: the session's fully resolved creation parameters — the
 * resolved commit identity for a baseline session, the resolved profile
 * definition for a `coverage` session, and nothing for `audit`.
 */
export type SessionParameters =
  | { readonly strategy: "path-blocks"; readonly baseCommit: string }
  | { readonly strategy: "audit" }
  | { readonly strategy: "coverage"; readonly profile: RecordedProfile };

/**
 * SPEC 10.7: resolve a configured coverage profile into the recorded form a
 * `coverage` session's `create` stores — the profile's 7.4 fields with each
 * group name replaced by that group's configured glob list and kind.
 * Renaming or editing refs, profiles, or groups after `create` never changes
 * the recorded parameters the session runs with. The configuration is
 * validated (SPEC 14.14), so the referenced groups exist and are of the
 * required kinds; a miss is an internal error, never a user-facing state.
 */
export function recordCoverageProfile(
  configuration: Configuration,
  profile: CoverageProfile,
): RecordedProfile {
  const groupOf = (kind: "spec" | "code", name: string): ConfiguredGroup => {
    const groups =
      kind === "spec" ? configuration.specGroups : configuration.codeGroups;
    const group = groups.find((candidate) => candidate.name === name);
    if (group === undefined) {
      throw new Error(
        `xspec internal error: the validated configuration names no ` +
          `${kind} group ${JSON.stringify(name)} (SPEC 7.4, 14.14)`,
      );
    }
    return group;
  };
  // SPEC 7.4: `target` is a spec group; `boundary`'s kind was resolved at
  // configuration load (inferred when unambiguous, else as given).
  const target = groupOf("spec", profile.target);
  const boundary = groupOf(profile.boundaryKind, profile.boundary);
  return {
    name: profile.name,
    target: { kind: "spec", globs: [...target.patterns] },
    targetTags:
      profile.targetTags === undefined ? undefined : [...profile.targetTags],
    targets: profile.targets,
    boundary: { kind: profile.boundaryKind, globs: [...boundary.patterns] },
    mode: profile.mode,
    edgeKinds: [...profile.edgeKinds],
  };
}

/**
 * SPEC 10.7: one recorded `split` decomposition — the original item's kind
 * and scope node; the replacement (per-child `subtree-coherence` items plus
 * the scope node's `parent-consistency` item) is computed against the
 * current workspace on every re-derivation (10.5), so only the decomposed
 * (kind, scope) is durable.
 */
export interface RecordedDecomposition {
  readonly kind: "subtree-coherence";
  readonly scope: string;
}

/** One review session (SPEC 10.1, 10.2, 10.7). */
export interface ReviewSession {
  readonly parameters: SessionParameters;
  /** In the order the `split`s were recorded (SPEC 10.7). */
  readonly decompositions: readonly RecordedDecomposition[];
  /**
   * The journal's entry count when the session was last written (module
   * header identity policy): the write-moment bound every stored canonical
   * position stays within. Mutating subcommands advance it to the current
   * entry count on every write.
   */
  readonly journalLength: number;
  /**
   * The next item id's ordinal — ids are `item-<n>`, allocated in creation
   * order and never reused after removal (SPEC 10.7).
   */
  readonly nextItemId: number;
  /** In insertion order; presentation order is derived at read (10.5–10.7). */
  readonly items: readonly ReviewItem[];
}

/** The session's strategy (stored top-level beside the parameters). */
export function sessionStrategy(session: ReviewSession): ReviewStrategy {
  return session.parameters.strategy;
}

/** Allocate the next item id (`item-<n>`), returning it with the bumped counter. */
export function allocateItemId(nextItemId: number): {
  readonly id: string;
  readonly nextItemId: number;
} {
  return { id: `item-${String(nextItemId)}`, nextItemId: nextItemId + 1 };
}

// ---------------------------------------------------------------------------
// Blocking (SPEC 10.3)
// ---------------------------------------------------------------------------

/**
 * SPEC 10.3: an item is blocked while any item in its `blockedBy` is not
 * resolved. `statusOf` supplies each blocker's effective status — stored
 * statuses, or statuses with read-time invalidation applied (10.4): because
 * `invalidated` is not a resolved status, a blocker that becomes invalidated
 * re-blocks its dependents until it is resolved again.
 */
export function isItemBlocked(
  item: ReviewItem,
  statusOf: (itemId: string) => ItemStatus,
): boolean {
  return item.blockedBy.some((blocker) => !isResolvedStatus(statusOf(blocker)));
}

/** Item counts by stored status (SPEC 10.7 `list`: no read-time invalidation). */
export function countsByStoredStatus(
  session: ReviewSession,
): Readonly<Record<ItemStatus, number>> {
  const counts: Record<ItemStatus, number> = {
    unresolved: 0,
    updated: 0,
    "no-change": 0,
    skipped: 0,
    invalidated: 0,
  };
  for (const item of session.items) {
    counts[item.status] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Corruption findings (SPEC 10.1 → 14.21)
// ---------------------------------------------------------------------------

/**
 * The SPEC 14.21 finding for a session file that cannot be parsed or
 * violates a session invariant (SPEC 10.1). `problems` are the specific
 * violations, all reported (SPEC 14: each present condition is reported).
 */
export function corruptSessionFinding(
  name: string,
  problems: readonly string[],
): Finding {
  return {
    condition: 21,
    file: sessionFilePath(name),
    message:
      `corrupt review session ${JSON.stringify(name)}: ` +
      problems.join("; ") +
      ` (SPEC 10.1)`,
    correction:
      `the session file ${sessionFilePath(name)} was modified outside ` +
      `xspec or damaged; sessions are durable files changed only by their ` +
      `owning commands (SPEC 13.4) — restore the file from version control, ` +
      `or delete it and create the session again (SPEC 14.21)`,
  };
}

/**
 * The SPEC 14.21 finding for a session path occupied by anything other than
 * a plain file (SPEC 13.4: such a path is never read, appended to, or
 * replaced — the session is corrupt). `occupant` is the human description
 * ("a directory", "a symbolic link", …).
 */
export function corruptSessionOccupantFinding(
  name: string,
  occupant: string,
): Finding {
  return {
    condition: 21,
    file: sessionFilePath(name),
    message:
      `corrupt review session ${JSON.stringify(name)}: the session path ` +
      `${sessionFilePath(name)} is occupied by ${occupant}, not a plain ` +
      `file — a durable file's path occupied by anything other than a ` +
      `plain file is never read, appended to, or replaced (SPEC 13.4, 10.1)`,
    correction:
      `remove the occupant and restore the session as a plain file from ` +
      `version control, or delete it and create the session again ` +
      `(SPEC 14.21)`,
  };
}

// ---------------------------------------------------------------------------
// Serialization (SPEC 10.1: plain, deterministic; 13.4: stably keyed)
// ---------------------------------------------------------------------------

/**
 * A recorded state (SPEC 10.4) as JSON data — the stored form, also the
 * `baseline`/`current` members of the read payloads (SPEC 10.7: reads
 * report both fields as recorded).
 */
export function recordedStateToJson(state: RecordedState): JsonValue {
  const nodes: Record<string, JsonValue> = {};
  for (const [identity, node] of Object.entries(state.nodes)) {
    nodes[identity] = node.present
      ? { present: true, hashes: { ...node.hashes } }
      : { present: false, hashes: "absent" };
  }
  return { nodes };
}

function textTableToJson(table: RecordedTextTable): JsonValue {
  const entries: Record<string, JsonValue> = {};
  for (const [identity, texts] of Object.entries(table)) {
    entries[identity] = {
      ownText: texts.ownText,
      subtreeText: texts.subtreeText,
    };
  }
  return entries;
}

function itemToJson(item: ReviewItem): JsonObject {
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    context: [...item.context],
    reason: item.reason,
    origin: [...item.origin],
    baseline: recordedStateToJson(item.baseline),
    current: recordedStateToJson(item.current),
    status: item.status,
    note: item.note,
    blockedBy: [...item.blockedBy],
    baselineTexts: textTableToJson(item.baselineTexts),
    derivedTexts: textTableToJson(item.derivedTexts),
  };
}

/**
 * The recorded creation parameters as JSON data (SPEC 10.7) — the stored
 * form, also `export`'s `creationParameters` member: the resolved commit
 * for a baseline session, the resolved profile definition for a `coverage`
 * session, nothing for `audit`.
 */
export function parametersToJson(parameters: SessionParameters): JsonObject {
  switch (parameters.strategy) {
    case "path-blocks":
      // SPEC 10.7: the commit identity `--base` resolved to at creation.
      return { base: parameters.baseCommit };
    case "audit":
      // SPEC 10.7: an audit session records none.
      return {};
    case "coverage": {
      // SPEC 10.7: the named profile's definition — its 7.4 fields, group
      // names replaced by the groups' configured glob lists and kinds.
      const profile = parameters.profile;
      return {
        profile: {
          name: profile.name,
          target: {
            kind: profile.target.kind,
            globs: [...profile.target.globs],
          },
          targetTags: profile.targetTags ? [...profile.targetTags] : undefined,
          targets: profile.targets,
          boundary: {
            kind: profile.boundary.kind,
            globs: [...profile.boundary.globs],
          },
          mode: profile.mode,
          edgeKinds: [...profile.edgeKinds],
        },
      };
    }
  }
}

/** The stored format version: any other version is corrupt (unintelligible). */
const SESSION_VERSION = 1;

/**
 * Serialize a session to its stored form: one canonical JSON document
 * (SPEC 10.1 "plain, deterministic"; 13.4 "stable ordering and sorted
 * keys"; 12.0 byte determinism — the text is a pure function of the
 * session value).
 */
export function serializeSession(session: ReviewSession): string {
  const document: JsonObject = {
    creationParameters: parametersToJson(session.parameters),
    decompositions: session.decompositions.map((decomposition) => ({
      kind: decomposition.kind,
      scope: decomposition.scope,
    })),
    items: session.items.map(itemToJson),
    journalLength: session.journalLength,
    nextItemId: session.nextItemId,
    strategy: session.parameters.strategy,
    version: SESSION_VERSION,
  };
  return canonicalJson(document);
}

// ---------------------------------------------------------------------------
// Parsing and invariant validation (SPEC 10.1 → 14.21)
// ---------------------------------------------------------------------------

/** The outcome of parsing and validating a session file's bytes. */
export type SessionParseResult =
  | { readonly ok: true; readonly session: ReviewSession }
  | {
      /**
       * SPEC 10.1: the file cannot be parsed or violates a session
       * invariant — the session is corrupt (14.21). Every detected problem
       * is listed.
       */
      readonly ok: false;
      readonly problems: readonly string[];
    };

/** A problem collector that keeps validation total. */
class Problems {
  readonly list: string[] = [];

  add(problem: string): void {
    this.list.push(problem);
  }

  get empty(): boolean {
    return this.list.length === 0;
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * Verify `object` carries every `required` key and no key outside
 * `required` ∪ `optional` (the stored shape is exact: the product writes
 * these files, so any deviation is external modification).
 */
function checkKeys(
  object: Record<string, unknown>,
  where: string,
  required: readonly string[],
  optional: readonly string[],
  problems: Problems,
): boolean {
  let complete = true;
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      problems.add(
        `${where} is missing the required field ${JSON.stringify(key)}`,
      );
      complete = false;
    }
  }
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      problems.add(`${where} carries the unknown field ${JSON.stringify(key)}`);
      complete = false;
    }
  }
  return complete;
}

function requireString(
  value: unknown,
  where: string,
  problems: Problems,
): value is string {
  if (typeof value === "string") return true;
  problems.add(`${where} must be a string, found ${describeType(value)}`);
  return false;
}

function requireNonEmptyString(
  value: unknown,
  where: string,
  problems: Problems,
): value is string {
  if (!requireString(value, where, problems)) return false;
  if (value.length === 0) {
    problems.add(`${where} must be a non-empty string`);
    return false;
  }
  return true;
}

function parseIdentityList(
  value: unknown,
  where: string,
  problems: Problems,
): string[] {
  if (!Array.isArray(value)) {
    problems.add(`${where} must be an array, found ${describeType(value)}`);
    return [];
  }
  const identities: string[] = [];
  value.forEach((element, index) => {
    if (
      requireNonEmptyString(element, `${where}[${String(index)}]`, problems)
    ) {
      identities.push(element);
    }
  });
  return identities;
}

function parseRecordedNodeState(
  value: unknown,
  where: string,
  problems: Problems,
): RecordedNodeState | null {
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return null;
  }
  if (!checkKeys(value, where, ["present", "hashes"], [], problems)) {
    return null;
  }
  const present = value["present"];
  if (typeof present !== "boolean") {
    problems.add(
      `${where}.present must be a boolean, found ${describeType(present)}`,
    );
    return null;
  }
  const hashes = value["hashes"];
  if (!present) {
    // SPEC 10.4: an absent node's hashes are an explicit absent marker.
    if (hashes !== "absent") {
      problems.add(
        `${where}.hashes must be the explicit "absent" marker for an ` +
          `absent node (SPEC 10.4), found ${describeType(hashes)}`,
      );
      return null;
    }
    return { present: false, hashes: "absent" };
  }
  if (!isPlainJsonObject(hashes)) {
    problems.add(
      `${where}.hashes must be an object of recorded hash values for a ` +
        `present node (SPEC 10.4), found ${describeType(hashes)}`,
    );
    return null;
  }
  const recorded: Partial<Record<RecordedHashName, string>> = {};
  let wellFormed = true;
  for (const [hashName, hashValue] of Object.entries(hashes)) {
    if (!(RECORDED_HASH_NAMES as readonly string[]).includes(hashName)) {
      problems.add(
        `${where}.hashes carries the unknown hash name ${JSON.stringify(hashName)}`,
      );
      wellFormed = false;
      continue;
    }
    if (
      !requireNonEmptyString(hashValue, `${where}.hashes.${hashName}`, problems)
    ) {
      wellFormed = false;
      continue;
    }
    recorded[hashName as RecordedHashName] = hashValue;
  }
  return wellFormed ? { present: true, hashes: recorded } : null;
}

function parseRecordedState(
  value: unknown,
  where: string,
  problems: Problems,
): RecordedState {
  const empty: RecordedState = { nodes: {} };
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return empty;
  }
  if (!checkKeys(value, where, ["nodes"], [], problems)) {
    return empty;
  }
  const nodesValue = value["nodes"];
  if (!isPlainJsonObject(nodesValue)) {
    problems.add(
      `${where}.nodes must be an object keyed by node identity, found ` +
        describeType(nodesValue),
    );
    return empty;
  }
  const nodes: Record<string, RecordedNodeState> = {};
  for (const [identity, nodeValue] of Object.entries(nodesValue)) {
    if (identity.length === 0) {
      problems.add(`${where}.nodes carries an empty node identity`);
      continue;
    }
    const state = parseRecordedNodeState(
      nodeValue,
      `${where}.nodes[${JSON.stringify(identity)}]`,
      problems,
    );
    if (state !== null) {
      nodes[identity] = state;
    }
  }
  return { nodes };
}

function parseTextTable(
  value: unknown,
  where: string,
  problems: Problems,
): RecordedTextTable {
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return {};
  }
  const table: Record<string, RecordedTexts> = {};
  for (const [identity, entry] of Object.entries(value)) {
    const entryWhere = `${where}[${JSON.stringify(identity)}]`;
    if (identity.length === 0) {
      problems.add(`${where} carries an empty node identity`);
      continue;
    }
    if (!isPlainJsonObject(entry)) {
      problems.add(
        `${entryWhere} must be an object, found ${describeType(entry)}`,
      );
      continue;
    }
    if (
      !checkKeys(entry, entryWhere, [], ["ownText", "subtreeText"], problems)
    ) {
      continue;
    }
    const texts: { ownText?: string; subtreeText?: string } = {};
    let wellFormed = true;
    for (const key of ["ownText", "subtreeText"] as const) {
      if (!Object.hasOwn(entry, key)) continue;
      const text = entry[key];
      if (requireString(text, `${entryWhere}.${key}`, problems)) {
        texts[key] = text;
      } else {
        wellFormed = false;
      }
    }
    if (wellFormed) {
      table[identity] = texts;
    }
  }
  return table;
}

const ITEM_REQUIRED_KEYS = [
  "id",
  "kind",
  "scope",
  "context",
  "reason",
  "origin",
  "baseline",
  "current",
  "status",
  "blockedBy",
  "baselineTexts",
  "derivedTexts",
] as const;

function parseItem(
  value: unknown,
  where: string,
  problems: Problems,
): ReviewItem | null {
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return null;
  }
  const before = problems.list.length;
  // SPEC 10.1: the fields of 10.2 present and well-formed.
  checkKeys(value, where, ITEM_REQUIRED_KEYS, ["note"], problems);

  const id = value["id"];
  requireNonEmptyString(id, `${where}.id`, problems);

  const kind = value["kind"];
  if (
    typeof kind !== "string" ||
    !(ITEM_KINDS as readonly string[]).includes(kind)
  ) {
    problems.add(
      `${where}.kind must be one of ${ITEM_KINDS.join(", ")}, found ` +
        (typeof kind === "string" ? JSON.stringify(kind) : describeType(kind)),
    );
  }

  const scope = value["scope"];
  requireNonEmptyString(scope, `${where}.scope`, problems);

  const context = parseIdentityList(
    value["context"],
    `${where}.context`,
    problems,
  );
  const origin = parseIdentityList(
    value["origin"],
    `${where}.origin`,
    problems,
  );

  const reason = value["reason"];
  requireString(reason, `${where}.reason`, problems);

  const baseline = parseRecordedState(
    value["baseline"],
    `${where}.baseline`,
    problems,
  );
  const current = parseRecordedState(
    value["current"],
    `${where}.current`,
    problems,
  );

  // SPEC 10.1: statuses drawn from 10.3.
  const status = value["status"];
  if (
    typeof status !== "string" ||
    !(ITEM_STATUSES as readonly string[]).includes(status)
  ) {
    problems.add(
      `${where}.status must be one of ${ITEM_STATUSES.join(", ")} ` +
        `(SPEC 10.3), found ` +
        (typeof status === "string"
          ? JSON.stringify(status)
          : describeType(status)),
    );
  }

  let note: string | undefined;
  if (Object.hasOwn(value, "note")) {
    const noteValue = value["note"];
    if (requireString(noteValue, `${where}.note`, problems)) {
      note = noteValue;
    }
  }

  const blockedBy = parseIdentityList(
    value["blockedBy"],
    `${where}.blockedBy`,
    problems,
  );
  const baselineTexts = parseTextTable(
    value["baselineTexts"],
    `${where}.baselineTexts`,
    problems,
  );
  const derivedTexts = parseTextTable(
    value["derivedTexts"],
    `${where}.derivedTexts`,
    problems,
  );

  if (problems.list.length > before) {
    return null;
  }
  return {
    id: id as string,
    kind: kind as ItemKind,
    scope: scope as string,
    context,
    reason: reason as string,
    origin,
    baseline,
    current,
    status: status as ItemStatus,
    note,
    blockedBy,
    baselineTexts,
    derivedTexts,
  };
}

function parseRecordedGroup(
  value: unknown,
  where: string,
  problems: Problems,
): RecordedGroup | null {
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return null;
  }
  if (!checkKeys(value, where, ["kind", "globs"], [], problems)) {
    return null;
  }
  const kind = value["kind"];
  if (kind !== "spec" && kind !== "code") {
    problems.add(
      `${where}.kind must be "spec" or "code", found ${describeType(kind)}`,
    );
    return null;
  }
  const globsValue = value["globs"];
  if (!Array.isArray(globsValue)) {
    problems.add(
      `${where}.globs must be an array, found ${describeType(globsValue)}`,
    );
    return null;
  }
  const globs: string[] = [];
  let wellFormed = true;
  globsValue.forEach((glob, index) => {
    if (requireString(glob, `${where}.globs[${String(index)}]`, problems)) {
      globs.push(glob);
    } else {
      wellFormed = false;
    }
  });
  return wellFormed ? { kind, globs } : null;
}

function parseRecordedProfile(
  value: unknown,
  where: string,
  problems: Problems,
): RecordedProfile | null {
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return null;
  }
  const complete = checkKeys(
    value,
    where,
    ["name", "target", "targets", "boundary", "mode", "edgeKinds"],
    ["targetTags"],
    problems,
  );
  const before = problems.list.length;

  const name = value["name"];
  requireNonEmptyString(name, `${where}.name`, problems);

  const target = parseRecordedGroup(
    value["target"],
    `${where}.target`,
    problems,
  );
  const boundary = parseRecordedGroup(
    value["boundary"],
    `${where}.boundary`,
    problems,
  );

  const targets = value["targets"];
  if (targets !== "leaves" && targets !== "all") {
    problems.add(
      `${where}.targets must be "leaves" or "all", found ${describeType(targets)}`,
    );
  }

  const mode = value["mode"];
  if (mode !== "direct" && mode !== "transitive") {
    problems.add(
      `${where}.mode must be "direct" or "transitive", found ${describeType(mode)}`,
    );
  }

  const edgeKindsValue = value["edgeKinds"];
  const edgeKinds: DependencyEdgeKind[] = [];
  if (!Array.isArray(edgeKindsValue) || edgeKindsValue.length === 0) {
    problems.add(
      `${where}.edgeKinds must be a non-empty array of dependency edge ` +
        `kinds (SPEC 7.4), found ${describeType(edgeKindsValue)}`,
    );
  } else {
    edgeKindsValue.forEach((edgeKind, index) => {
      if (
        typeof edgeKind !== "string" ||
        !(DEPENDENCY_EDGE_KINDS as readonly string[]).includes(edgeKind)
      ) {
        problems.add(
          `${where}.edgeKinds[${String(index)}] must be one of ` +
            `${DEPENDENCY_EDGE_KINDS.join(", ")}, found ` +
            describeType(edgeKind),
        );
      } else {
        edgeKinds.push(edgeKind as DependencyEdgeKind);
      }
    });
  }

  let targetTags: string[] | undefined;
  if (Object.hasOwn(value, "targetTags")) {
    const tagsValue = value["targetTags"];
    if (!Array.isArray(tagsValue) || tagsValue.length === 0) {
      problems.add(
        `${where}.targetTags must be a non-empty array of tags when ` +
          `present (SPEC 7.4), found ${describeType(tagsValue)}`,
      );
    } else {
      targetTags = [];
      tagsValue.forEach((tag, index) => {
        if (
          requireNonEmptyString(
            tag,
            `${where}.targetTags[${String(index)}]`,
            problems,
          )
        ) {
          targetTags?.push(tag);
        }
      });
    }
  }

  if (!complete || problems.list.length > before) {
    return null;
  }
  return {
    name: name as string,
    target: target as RecordedGroup,
    targetTags,
    targets: targets as "leaves" | "all",
    boundary: boundary as RecordedGroup,
    mode: mode as "direct" | "transitive",
    edgeKinds,
  };
}

/**
 * SPEC 10.1: the recorded creation parameters well-formed, per strategy
 * (SPEC 10.7): `{base}` for `path-blocks`, nothing for `audit`, `{profile}`
 * for `coverage`. Value validity (e.g. whether the recorded commit still
 * resolves) is a use-time concern, not corruption (6.3 → 12.0).
 */
function parseParameters(
  strategy: ReviewStrategy,
  value: unknown,
  problems: Problems,
): SessionParameters | null {
  const where = "the recorded creation parameters (creationParameters)";
  if (!isPlainJsonObject(value)) {
    problems.add(`${where} must be an object, found ${describeType(value)}`);
    return null;
  }
  switch (strategy) {
    case "path-blocks": {
      if (!checkKeys(value, where, ["base"], [], problems)) return null;
      const base = value["base"];
      if (
        !requireNonEmptyString(
          base,
          `${where}.base (the resolved baseline commit, SPEC 10.7)`,
          problems,
        )
      ) {
        return null;
      }
      return { strategy, baseCommit: base };
    }
    case "audit": {
      // SPEC 10.7: an audit session records none.
      if (!checkKeys(value, where, [], [], problems)) return null;
      return { strategy };
    }
    case "coverage": {
      if (!checkKeys(value, where, ["profile"], [], problems)) return null;
      const profile = parseRecordedProfile(
        value["profile"],
        `${where}.profile`,
        problems,
      );
      return profile === null ? null : { strategy, profile };
    }
  }
}

function parseDecompositions(
  value: unknown,
  problems: Problems,
): RecordedDecomposition[] {
  const where = "the recorded decompositions (decompositions)";
  if (!Array.isArray(value)) {
    problems.add(`${where} must be an array, found ${describeType(value)}`);
    return [];
  }
  const decompositions: RecordedDecomposition[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryWhere = `${where}[${String(index)}]`;
    if (!isPlainJsonObject(entry)) {
      problems.add(
        `${entryWhere} must be an object, found ${describeType(entry)}`,
      );
      return;
    }
    if (!checkKeys(entry, entryWhere, ["kind", "scope"], [], problems)) {
      return;
    }
    const kind = entry["kind"];
    if (kind !== "subtree-coherence") {
      // SPEC 10.7: only subtree-coherence items are ever split.
      problems.add(
        `${entryWhere}.kind must be "subtree-coherence" (SPEC 10.7), found ` +
          (typeof kind === "string"
            ? JSON.stringify(kind)
            : describeType(kind)),
      );
      return;
    }
    const scope = entry["scope"];
    if (!requireNonEmptyString(scope, `${entryWhere}.scope`, problems)) {
      return;
    }
    const key = `${kind} ${scope}`;
    if (seen.has(key)) {
      problems.add(
        `${entryWhere} records the already-decomposed scope node ` +
          `${JSON.stringify(scope)} a second time`,
      );
      return;
    }
    seen.add(key);
    decompositions.push({ kind, scope });
  });
  return decompositions;
}

function requireCount(
  value: unknown,
  where: string,
  minimum: number,
  problems: Problems,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    problems.add(
      `${where} must be an integer >= ${String(minimum)}, found ` +
        (typeof value === "number" ? String(value) : describeType(value)),
    );
    return null;
  }
  return value;
}

/**
 * SPEC 10.1: every stored node reference parses as the canonical identity
 * key encoding of the module header — a reference that does not is a
 * session-invariant violation (the product only ever writes canonical
 * references) — and its canonical position stays within the session's
 * write-moment bound (`journalLength`) when that bound itself parsed.
 */
function checkCanonicalReferences(
  items: readonly ReviewItem[],
  decompositions: readonly RecordedDecomposition[],
  journalLength: number | null,
  problems: Problems,
): void {
  const check = (reference: string, where: string): void => {
    const canonical = parseCanonicalIdentity(reference);
    if (canonical === null || canonical.identity.length === 0) {
      problems.add(
        `${where} must be a canonical identity reference of the form ` +
          `"<position>:<identity>" (SPEC 5.4, 10.4), found ` +
          JSON.stringify(reference),
      );
      return;
    }
    if (journalLength !== null && canonical.position > journalLength) {
      problems.add(
        `${where} records the canonical position ` +
          `${String(canonical.position)}, beyond the session's journalLength ` +
          `${String(journalLength)} — a stored position never exceeds the ` +
          `journal's entry count at the write that stored it (SPEC 5.4, 10.1)`,
      );
    }
  };
  items.forEach((item, index) => {
    const where = `items[${String(index)}]`;
    check(item.scope, `${where}.scope`);
    item.context.forEach((reference, at) => {
      check(reference, `${where}.context[${String(at)}]`);
    });
    item.origin.forEach((reference, at) => {
      check(reference, `${where}.origin[${String(at)}]`);
    });
    for (const [which, state] of [
      ["baseline", item.baseline],
      ["current", item.current],
    ] as const) {
      for (const reference of Object.keys(state.nodes)) {
        check(reference, `a ${where}.${which}.nodes key`);
      }
    }
    for (const [which, table] of [
      ["baselineTexts", item.baselineTexts],
      ["derivedTexts", item.derivedTexts],
    ] as const) {
      for (const reference of Object.keys(table)) {
        check(reference, `a ${where}.${which} key`);
      }
    }
  });
  decompositions.forEach((decomposition, index) => {
    check(decomposition.scope, `decompositions[${String(index)}].scope`);
  });
}

/**
 * SPEC 10.1: item `id`s unique within the session; `blockedBy` naming only
 * item `id`s present in the session and containing no cycle; at most one
 * item per kind and scope node — byte-wise over the stored canonical
 * references, which is canonical comparison (SPEC 10.4, module header).
 */
function checkSessionInvariants(
  items: readonly ReviewItem[],
  problems: Problems,
): void {
  const byId = new Map<string, ReviewItem>();
  for (const item of items) {
    if (byId.has(item.id)) {
      problems.add(
        `duplicate item id ${JSON.stringify(item.id)} — item ids must be ` +
          `unique within the session (SPEC 10.2)`,
      );
    } else {
      byId.set(item.id, item);
    }
  }

  const byKindAndScope = new Set<string>();
  for (const item of items) {
    const key = `${item.kind} ${item.scope}`;
    if (byKindAndScope.has(key)) {
      problems.add(
        `two items share kind ${JSON.stringify(item.kind)} and scope node ` +
          `${JSON.stringify(item.scope)} — a session never contains two ` +
          `items with the same kind and scope node (SPEC 10.5)`,
      );
    } else {
      byKindAndScope.add(key);
    }
  }

  for (const item of items) {
    for (const blocker of item.blockedBy) {
      if (!byId.has(blocker)) {
        problems.add(
          `item ${JSON.stringify(item.id)} is blocked by ` +
            `${JSON.stringify(blocker)}, which names no item of the session ` +
            `(SPEC 10.1)`,
        );
      }
    }
  }

  // Cycle detection over the blockedBy graph (SPEC 10.1: no item
  // transitively blocks itself). Iterative coloring keeps validation total
  // whatever the graph size.
  const colors = new Map<string, "visiting" | "done">();
  const reportCycle = (stack: readonly string[], repeated: string): void => {
    const start = stack.indexOf(repeated);
    const cycle = [...stack.slice(start), repeated];
    problems.add(
      `blockedBy contains a cycle: ${cycle.map((id) => JSON.stringify(id)).join(" -> ")} ` +
        `— no item may transitively block itself (SPEC 10.1)`,
    );
  };
  let cycleReported = false;
  for (const root of items) {
    if (colors.has(root.id) || cycleReported) continue;
    // Explicit stack of (id, next blocker index) frames.
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    colors.set(root.id, "visiting");
    while (stack.length > 0 && !cycleReported) {
      const frame = stack[stack.length - 1];
      const item = byId.get(frame.id);
      const blockers = item ? item.blockedBy : [];
      if (frame.next >= blockers.length) {
        colors.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const blocker = blockers[frame.next];
      frame.next += 1;
      if (!byId.has(blocker)) continue; // reported above
      const color = colors.get(blocker);
      if (color === "visiting") {
        reportCycle(
          stack.map((entry) => entry.id),
          blocker,
        );
        cycleReported = true;
      } else if (color === undefined) {
        colors.set(blocker, "visiting");
        stack.push({ id: blocker, next: 0 });
      }
    }
  }
}

/**
 * Parse and validate a session file's bytes (SPEC 10.1): strict UTF-8, one
 * JSON document, the stored shape of this module's header, and every listed
 * session invariant. Any failure yields the collected problems — the
 * session is corrupt (14.21).
 */
export function parseSessionBytes(bytes: Uint8Array): SessionParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      problems: ["the session file is not valid UTF-8, so it cannot be parsed"],
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [
        `the session file cannot be parsed as one JSON document: ` +
          (error as Error).message,
      ],
    };
  }
  return validateSessionDocument(document);
}

/**
 * Validate a parsed session document against the stored shape and the
 * session invariants of SPEC 10.1.
 */
export function validateSessionDocument(document: unknown): SessionParseResult {
  const problems = new Problems();
  if (!isPlainJsonObject(document)) {
    problems.add(
      `the session document must be a JSON object, found ${describeType(document)}`,
    );
    return { ok: false, problems: problems.list };
  }
  checkKeys(
    document,
    "the session document",
    [
      "creationParameters",
      "decompositions",
      "items",
      "journalLength",
      "nextItemId",
      "strategy",
      "version",
    ],
    [],
    problems,
  );

  const version = document["version"];
  if (version !== SESSION_VERSION) {
    problems.add(
      `the session document's version must be ${String(SESSION_VERSION)}, found ` +
        (typeof version === "number" ? String(version) : describeType(version)),
    );
  }

  const strategyValue = document["strategy"];
  let strategy: ReviewStrategy | null = null;
  if (
    strategyValue === "path-blocks" ||
    strategyValue === "audit" ||
    strategyValue === "coverage"
  ) {
    strategy = strategyValue;
  } else {
    problems.add(
      `the session document's strategy must be "path-blocks", "audit", or ` +
        `"coverage", found ` +
        (typeof strategyValue === "string"
          ? JSON.stringify(strategyValue)
          : describeType(strategyValue)),
    );
  }

  const parameters =
    strategy === null
      ? null
      : parseParameters(strategy, document["creationParameters"], problems);

  const decompositions = parseDecompositions(
    document["decompositions"],
    problems,
  );

  const journalLength = requireCount(
    document["journalLength"],
    "the session document's journalLength",
    0,
    problems,
  );
  const nextItemId = requireCount(
    document["nextItemId"],
    "the session document's nextItemId",
    1,
    problems,
  );

  const itemsValue = document["items"];
  const items: ReviewItem[] = [];
  if (!Array.isArray(itemsValue)) {
    problems.add(
      `the session document's items must be an array, found ` +
        describeType(itemsValue),
    );
  } else {
    itemsValue.forEach((value, index) => {
      const item = parseItem(value, `items[${String(index)}]`, problems);
      if (item !== null) {
        items.push(item);
      }
    });
    // The invariants are meaningful only over well-formed items; a
    // malformed item has already made the session corrupt above.
    checkSessionInvariants(items, problems);
  }
  checkCanonicalReferences(items, decompositions, journalLength, problems);

  if (!problems.empty || parameters === null) {
    return { ok: false, problems: problems.list };
  }
  return {
    ok: true,
    session: {
      parameters,
      decompositions,
      journalLength: journalLength as number,
      nextItemId: nextItemId as number,
      items,
    },
  };
}

/** Session names in byte order (SPEC 10.7 `list`; 12.0). */
export function sortSessionNames(names: readonly string[]): string[] {
  return [...names].sort(compareBytes);
}
