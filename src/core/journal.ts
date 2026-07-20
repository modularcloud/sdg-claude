// The journal model (SPEC 6.1) and canonical identities (SPEC 5.4).
//
// SPEC 6.1: xspec maintains a journal at `.xspec/journal` — a plain-text,
// append-only file with one entry per line, each entry a self-contained
// record of one `rename` or `move` operation and the identity mapping it
// produced. The journal is written only by `xspec rename` and `xspec move`;
// an absent file is an empty journal. Entries are byte-deterministic for a
// given operation and workspace state; entry content is otherwise opaque —
// the observable contract is the line-oriented, append-only form and the
// entry's effect on canonical identities (5.4), baseline resolution (6.3),
// and validation (14.13).
//
// Entry format (this implementation's design, within 6.1's opaque-content
// latitude): each line is the compact canonical JSON of
//
//   {"from":<root-from>,"map":[[<from>,<to>],…],"op":<kind>,"to":<root-to>}
//
// where <kind> is "rename", "move-file", or "move-section"; "from"/"to"
// record the operated-on node — identities (`path#id`, SPEC 1.5) for
// "rename" and "move-section", bare file paths for "move-file"; and "map" is
// the full identity mapping the operation produced (SPEC 6.4/6.5: the
// mapping is appended to the journal) — one [from, to] pair per affected
// node, in strictly ascending byte order of the pair's source. JSON string
// escaping keeps an entry on one line whatever characters an identity
// contains, and the compact canonical rendering (sorted keys, no
// insignificant whitespace, mapping order fixed) makes the line a
// deterministic function of the operation and its mapping alone (SPEC 6.1).
// The canonical bytes are the only accepted spelling: a parsed line must
// re-serialize to its exact bytes, so any tampering with the deterministic
// form surfaces as a 14.13 finding.
//
// Recording the produced mapping explicitly — rather than re-deriving it
// from the operation parameters at read time — keeps entries self-contained
// (SPEC 6.1) and replay exact (SPEC 6.3): the mapping covers exactly the
// nodes that existed when the operation ran, so identities that entered the
// workspace later and happen to share a renamed prefix are never mapped.
//
// This module is pure (IMPLEMENTATION Architecture: canonical identities are
// core): parsing, validation, serialization, and the canonical-identity walk
// take bytes and entries as values. File I/O — reading `.xspec/journal`,
// classifying its occupant, appending — lives in src/workspace/journal.ts.

import type { ByteRange } from "./bytes.js";
import { compareBytes, sortByBytes } from "./bytes.js";
import { compactJson } from "./canonical-json.js";
import type { Finding } from "./findings.js";
import { firstInvalidUtf8 } from "./source-text.js";
import {
  containsControl,
  containsWhitespace,
  FORBIDDEN_SEGMENT_NAMES,
} from "./text.js";

/** SPEC 6.1: the journal's workspace-relative path. */
export const JOURNAL_PATH = ".xspec/journal";

// ---------------------------------------------------------------------------
// The entry model
// ---------------------------------------------------------------------------

/** The journaled operation kinds (SPEC 6.4, 6.5). */
export type JournalOperationKind = "rename" | "move-file" | "move-section";

/** One identity mapping pair: `from` (baseline side) → `to` (current side). */
export interface IdentityMapping {
  readonly from: string;
  readonly to: string;
}

/**
 * One journal entry: a self-contained record of a rename or move operation
 * and the identity mapping it produced (SPEC 6.1). `from`/`to` are the
 * operated-on node's identities (`rename`, `move-section`) or file paths
 * (`move-file`); `mapping` is the full produced mapping, strictly ascending
 * by byte order of `from`, always containing the (`from` → `to`) root pair.
 */
export interface JournalEntry {
  readonly op: JournalOperationKind;
  readonly from: string;
  readonly to: string;
  readonly mapping: readonly IdentityMapping[];
}

/** A parsed entry located in the journal file (for 14.13 "naming the lines"). */
export interface PositionedJournalEntry extends JournalEntry {
  /** 1-based journal line number. */
  readonly line: number;
  /** The line's content bytes in the journal file (terminator excluded). */
  readonly range: ByteRange;
}

/** The result of parsing a journal file's bytes. */
export interface ParsedJournal {
  /** The entries of the lines that parsed and validated, in file order. */
  readonly entries: readonly PositionedJournalEntry[];
  /** One 14.13 finding per malformed, conflicting, or non-canonical line. */
  readonly findings: readonly Finding[];
}

/**
 * SPEC 5.4: a node's canonical identity — the identity the backward journal
 * walk ends on, paired with the journal position where it ends. Positions
 * count entries: 0 is the journal's start (no entry ended the walk);
 * position N means entry N (1-based) ended it — the entry vacated the
 * identity, so the node now bearing it entered the workspace after entry N.
 */
export interface CanonicalIdentity {
  readonly identity: string;
  readonly position: number;
}

/**
 * SPEC 5.5's ordering of canonical identities: identity string first (byte
 * order, SPEC 12.0), then journal position, earliest first.
 */
export function compareCanonicalIdentities(
  a: CanonicalIdentity,
  b: CanonicalIdentity,
): number {
  return compareBytes(a.identity, b.identity) || a.position - b.position;
}

// ---------------------------------------------------------------------------
// Construction and serialization
// ---------------------------------------------------------------------------

/**
 * Build a journal entry from an operation's produced mapping (SPEC 6.4, 6.5:
 * `rename` and `move` append the full mapping). Orders the mapping into its
 * canonical form and self-checks the entry against the same validation that
 * `parseJournal` applies, so the product can only ever write entries its own
 * reader accepts — a malformed argument is an internal error, never a
 * written line.
 */
export function createJournalEntry(
  op: JournalOperationKind,
  from: string,
  to: string,
  mapping: readonly IdentityMapping[],
): JournalEntry {
  const entry: JournalEntry = {
    op,
    from,
    to,
    mapping: sortByBytes(mapping, (pair) => pair.from),
  };
  const problem = entryProblem(entry);
  if (problem !== null) {
    throw new Error(`xspec internal error: invalid journal entry: ${problem}`);
  }
  return entry;
}

/**
 * The entry's canonical line (no terminator): compact canonical JSON with
 * byte-sorted keys — deterministic bytes for a given entry (SPEC 6.1).
 */
export function serializeJournalEntry(entry: JournalEntry): string {
  return compactJson({
    from: entry.from,
    map: entry.mapping.map((pair) => [pair.from, pair.to]),
    op: entry.op,
    to: entry.to,
  });
}

// ---------------------------------------------------------------------------
// Parsing and validation (SPEC 6.1 → 14.13)
// ---------------------------------------------------------------------------

const LF = 0x0a;
const decoder = new TextDecoder();

/**
 * Parse a journal file's bytes (SPEC 6.1): one entry per line, the final
 * line's terminator optional (the product always writes it). Every line that
 * is not the canonical byte form of a valid entry yields one condition-13
 * finding naming the line (SPEC 14.13); the remaining lines' entries are
 * still returned, in file order, so diagnostics can describe the rest of the
 * journal — but canonical identities and replay are only ever computed over
 * journals with no findings (a journal error fails validation, SPEC 14).
 */
export function parseJournal(bytes: Uint8Array): ParsedJournal {
  const entries: PositionedJournalEntry[] = [];
  const findings: Finding[] = [];
  let offset = 0;
  let line = 0;
  while (offset < bytes.length) {
    line += 1;
    const terminator = bytes.indexOf(LF, offset);
    const end = terminator === -1 ? bytes.length : terminator;
    const range: ByteRange = { start: offset, end };
    const result = parseEntryLine(bytes.subarray(offset, end));
    if (result.ok) {
      entries.push({ ...result.entry, line, range });
    } else {
      findings.push(journalFinding(line, range, result.problem));
    }
    offset = end + 1;
  }
  return { entries, findings };
}

/** One 14.13 finding for a bad journal line, naming the line (SPEC 14.13). */
function journalFinding(
  line: number,
  range: ByteRange,
  problem: string,
): Finding {
  return {
    condition: 13,
    file: JOURNAL_PATH,
    line,
    range,
    message:
      `journal error: the entry on line ${String(line)} of ${JOURNAL_PATH} ` +
      `${problem} — the journal is a durable, append-only record written ` +
      `only by \`xspec rename\` and \`xspec move\` (SPEC 6.1, 13.4); ` +
      `restore it from version control or delete the offending line ` +
      `(SPEC 14.13)`,
  };
}

type LineResult =
  | { readonly ok: true; readonly entry: JournalEntry }
  | { readonly ok: false; readonly problem: string };

function lineProblem(problem: string): LineResult {
  return { ok: false, problem };
}

/** Parse and validate one journal line's content bytes. */
function parseEntryLine(content: Uint8Array): LineResult {
  if (content.length === 0) {
    return lineProblem("is empty — every journal line is one entry");
  }
  if (firstInvalidUtf8(content) !== -1) {
    return lineProblem("is not valid UTF-8");
  }
  const text = decoder.decode(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return lineProblem("is not a well-formed journal entry (not valid JSON)");
  }
  const shaped = entryShape(parsed);
  if (!shaped.ok) {
    return shaped;
  }
  const problem = entryProblem(shaped.entry);
  if (problem !== null) {
    return lineProblem(problem);
  }
  // SPEC 6.1: entries are byte-deterministic — the canonical rendering is
  // the only accepted spelling, so reordered keys, whitespace variants, or
  // alternate string escapes are malformed even when they parse to a valid
  // entry.
  if (serializeJournalEntry(shaped.entry) !== text) {
    return lineProblem(
      "is not the canonical byte form of its entry (journal entries are " +
        "byte-deterministic)",
    );
  }
  return shaped;
}

/** Narrow a parsed JSON value to the entry shape, or say what is wrong. */
function entryShape(parsed: unknown): LineResult {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return lineProblem("is not a JSON object");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareBytes);
  if (keys.join(",") !== "from,map,op,to") {
    return lineProblem(
      `does not have exactly the entry fields "from", "map", "op", "to" ` +
        `(found ${JSON.stringify(keys)})`,
    );
  }
  const op = record["op"];
  if (op !== "rename" && op !== "move-file" && op !== "move-section") {
    return lineProblem(
      `names an unknown operation ${JSON.stringify(op)} — journaled ` +
        `operations are "rename", "move-file", and "move-section"`,
    );
  }
  const from = record["from"];
  const to = record["to"];
  if (typeof from !== "string" || typeof to !== "string") {
    return lineProblem(`does not record "from" and "to" as strings`);
  }
  const map = record["map"];
  if (!Array.isArray(map) || map.length === 0) {
    return lineProblem(
      `does not record "map" as a non-empty array of mapping pairs`,
    );
  }
  const mapping: IdentityMapping[] = [];
  for (const element of map as readonly unknown[]) {
    if (!Array.isArray(element) || element.length !== 2) {
      return lineProblem(
        `has a mapping element that is not a [from, to] pair of strings`,
      );
    }
    const pair = element as readonly unknown[];
    const pairFrom = pair[0];
    const pairTo = pair[1];
    if (typeof pairFrom !== "string" || typeof pairTo !== "string") {
      return lineProblem(
        `has a mapping element that is not a [from, to] pair of strings`,
      );
    }
    mapping.push({ from: pairFrom, to: pairTo });
  }
  return { ok: true, entry: { op, from, to, mapping } };
}

/**
 * Why `entry` is not a valid journal entry — malformed identities, an
 * impossible operation, or conflicting mappings (SPEC 14.13) — or null when
 * valid. Every check here holds for the entry any successful `rename` or
 * `move` writes (SPEC 6.4, 6.5), so a legitimate journal never reports.
 */
function entryProblem(entry: JournalEntry): string | null {
  const operation = operationProblem(entry);
  if (operation !== null) {
    return operation;
  }
  // The mapping's suffix separator: journaled identities extend the
  // operated-on node's identity — descendants by `.` + ID suffix for
  // ID-rooted operations, sections by `#` + ID for a whole-file move.
  const separator = entry.op === "move-file" ? "#" : ".";
  let sawRootPair = false;
  let previous: string | null = null;
  for (const pair of entry.mapping) {
    if (previous !== null && compareBytes(previous, pair.from) >= 0) {
      return previous === pair.from
        ? `maps the identity ${JSON.stringify(pair.from)} twice — ` +
            `conflicting mappings`
        : `does not list its mapping in ascending byte order of sources`;
    }
    previous = pair.from;
    if (pair.from === entry.from) {
      sawRootPair = true;
      if (pair.to !== entry.to) {
        return (
          `maps the operated-on ${JSON.stringify(pair.from)} to ` +
          `${JSON.stringify(pair.to)}, conflicting with the operation's ` +
          `own target ${JSON.stringify(entry.to)}`
        );
      }
      continue;
    }
    if (!pair.from.startsWith(entry.from + separator)) {
      return (
        `maps ${JSON.stringify(pair.from)}, which the operation on ` +
        `${JSON.stringify(entry.from)} does not affect`
      );
    }
    const suffix = pair.from.slice(entry.from.length + 1);
    const suffixProblem = idProblem(suffix);
    if (suffixProblem !== null) {
      return `maps ${JSON.stringify(pair.from)}, which ${suffixProblem}`;
    }
    if (pair.to !== entry.to + separator + suffix) {
      return (
        `maps ${JSON.stringify(pair.from)} to ${JSON.stringify(pair.to)} ` +
        `instead of the operation's ${JSON.stringify(entry.to + separator + suffix)}`
      );
    }
    // Target uniqueness needs no separate check: each target is the
    // operation's target root plus the pair's suffix, and source uniqueness
    // (the ascending order above) makes the suffixes distinct. Sources and
    // targets cannot collide either: valid operations' source and target
    // roots are never equal or `.`-prefix-related (see operationProblem), so
    // no source extension equals a target extension.
  }
  if (!sawRootPair) {
    return (
      `does not map the operated-on ${JSON.stringify(entry.from)} itself ` +
      `to ${JSON.stringify(entry.to)}`
    );
  }
  return null;
}

/** Why the entry's operation record is impossible, or null when valid. */
function operationProblem(entry: JournalEntry): string | null {
  if (entry.op === "move-file") {
    // SPEC 6.5 (file form): both sides are spec source file paths; the
    // destination differs from the origin (the self-move is refused).
    const fromProblem = pathProblem(entry.from);
    if (fromProblem !== null) {
      return `records an origin path that ${fromProblem}`;
    }
    const toProblem = pathProblem(entry.to);
    if (toProblem !== null) {
      return `records a destination path that ${toProblem}`;
    }
    if (entry.from === entry.to) {
      return `records a move of ${JSON.stringify(entry.from)} onto itself`;
    }
    return null;
  }
  const from = splitIdentity(entry.from);
  if (typeof from === "string") {
    return `records an origin identity that ${from}`;
  }
  const to = splitIdentity(entry.to);
  if (typeof to === "string") {
    return `records a target identity that ${to}`;
  }
  if (entry.op === "rename") {
    // SPEC 6.4: a rename stays within one file and rewrites the renamed
    // section's ID; the section keeps its place in the tree, so old and new
    // ID share every segment but the last (structural parent rules remain
    // satisfied) and differ in that last segment (the new ID differs).
    if (from.path !== to.path) {
      return (
        `records a rename whose identities lie in different files ` +
        `(${JSON.stringify(from.path)} and ${JSON.stringify(to.path)})`
      );
    }
    const fromSegments = from.id.split(".");
    const toSegments = to.id.split(".");
    if (
      fromSegments.length !== toSegments.length ||
      fromSegments.slice(0, -1).join(".") !== toSegments.slice(0, -1).join(".")
    ) {
      return (
        `records a rename of ${JSON.stringify(from.id)} to ` +
        `${JSON.stringify(to.id)}, which do not share every segment but ` +
        `the last — a rename keeps the section's place in the tree ` +
        `(SPEC 6.4)`
      );
    }
    if (from.id === to.id) {
      return `records a rename of ${JSON.stringify(from.id)} onto itself`;
    }
    return null;
  }
  // move-section (SPEC 6.5): the exact self-move is refused, and within one
  // file the target can be neither inside the moved subtree (no insertion
  // point would remain) nor a proper ancestor's ID (it would collide with an
  // ID remaining after the removal).
  if (entry.from === entry.to) {
    return `records a move of ${JSON.stringify(entry.from)} onto itself`;
  }
  if (
    from.path === to.path &&
    (to.id.startsWith(from.id + ".") || from.id.startsWith(to.id + "."))
  ) {
    return (
      `records a same-file move between the nested identities ` +
      `${JSON.stringify(from.id)} and ${JSON.stringify(to.id)}`
    );
  }
  return null;
}

/**
 * Split a `path#id` identity (SPEC 1.5) and validate both halves; a problem
 * description instead when malformed. The first `#` is the separator: a
 * discovered source path never contains `#` (SPEC 14.19), and no valid ID
 * segment does either (SPEC 1.4).
 */
function splitIdentity(
  identity: string,
): { readonly path: string; readonly id: string } | string {
  const hash = identity.indexOf("#");
  if (hash === -1) {
    return `has no "#" — the operation acts on a section (path#id, SPEC 1.5)`;
  }
  const path = identity.slice(0, hash);
  const id = identity.slice(hash + 1);
  const forPath = pathProblem(path);
  if (forPath !== null) {
    return forPath;
  }
  return idProblem(id) ?? { path, id };
}

/**
 * Why `path` is not a workspace-relative spec source path, or null when it
 * is. SPEC 1.5: identity paths are workspace-relative and `/`-separated on
 * every platform; SPEC 14.19/7.1: a discovered spec source contains no `#`
 * and carries the `.mdx` extension — journaled operations act on discovered
 * spec sources only (SPEC 6.4, 6.5).
 */
function pathProblem(path: string): string | null {
  if (path.length === 0) {
    return "is empty";
  }
  if (path.includes("#")) {
    return `contains "#" (SPEC 14.19)`;
  }
  if (path.startsWith("/")) {
    return "is not workspace-relative (SPEC 1.5)";
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      return "has an empty path segment";
    }
    if (segment === "." || segment === "..") {
      return (
        `has a ${JSON.stringify(segment)} path segment (SPEC 1.5: ` +
        `workspace-relative)`
      );
    }
  }
  if (!path.endsWith(".mdx")) {
    return "lacks the .mdx extension of a spec source (SPEC 7.1)";
  }
  return null;
}

/** Why `id` is not a valid requirement ID (SPEC 1.3, 1.4), or null. */
function idProblem(id: string): string | null {
  for (const segment of id.split(".")) {
    if (segment.length === 0) {
      return "has an ID with an empty segment (SPEC 1.4)";
    }
    if (FORBIDDEN_SEGMENT_NAMES.has(segment)) {
      return (
        `has an ID with the forbidden segment ${JSON.stringify(segment)} ` +
        `(SPEC 1.4)`
      );
    }
    if (segment.includes("#")) {
      return `has an ID segment containing "#" (SPEC 1.4)`;
    }
    if (containsWhitespace(segment)) {
      return "has an ID segment containing whitespace (SPEC 1.4)";
    }
    if (containsControl(segment)) {
      return "has an ID segment containing a control character (SPEC 1.4)";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical identities (SPEC 5.4) and forward mapping (SPEC 6.3)
// ---------------------------------------------------------------------------

/**
 * A parsed journal's entries with the walks SPEC 5.4 and 6.3 define over
 * them. Callers gate on the parse findings first: identities are only ever
 * computed over journals that validated clean (a journal error is a 14.13
 * finding and the workspace fails validation).
 */
export class Journal {
  readonly entries: readonly JournalEntry[];
  /** Per entry: mapping source → target. */
  private readonly sourceIndex: readonly ReadonlyMap<string, string>[];
  /** Per entry: mapping target → source. */
  private readonly targetIndex: readonly ReadonlyMap<string, string>[];

  constructor(entries: readonly JournalEntry[]) {
    this.entries = entries;
    this.sourceIndex = entries.map(
      (entry) => new Map(entry.mapping.map((pair) => [pair.from, pair.to])),
    );
    this.targetIndex = entries.map(
      (entry) => new Map(entry.mapping.map((pair) => [pair.to, pair.from])),
    );
  }

  /**
   * SPEC 5.4: the canonical identity of the node currently bearing
   * `identity` — walk the journal backwards from its newest entry tracking
   * the current identity: an entry that maps another identity to the
   * tracked one extends the chain (the tracked identity becomes that
   * entry's source), while an entry that maps the tracked identity away
   * ends the walk, because that entry vacated the identity and the node now
   * bearing it can only have entered the workspace after it. The result is
   * the identity the walk ends on paired with the position where it ends —
   * the journal's start (position 0) when no entry ends it, position N when
   * entry N (1-based) does. An identity reintroduced after leaving through
   * a journaled operation thus starts a new chain: distinct nodes always
   * have distinct canonical identities, and no hash ever changes merely
   * because an identity changed.
   */
  canonicalIdentity(identity: string): CanonicalIdentity {
    let tracked = identity;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      // Valid entries' source and target sets are disjoint (entryProblem),
      // so at most one branch applies; checking sources first keeps the
      // walk total and deterministic even over unvalidated entries.
      if (this.sourceIndex[index].has(tracked)) {
        return { identity: tracked, position: index + 1 };
      }
      const source = this.targetIndex[index].get(tracked);
      if (source !== undefined) {
        tracked = source;
      }
    }
    return { identity: tracked, position: 0 };
  }

  /**
   * SPEC 6.3: apply this journal's entries, in file order, to map an
   * identity forward — chained mappings compose. Baseline replay constructs
   * a Journal over the entry suffix present now but absent at the baseline
   * ref and maps each baseline identity through it.
   */
  mapForward(identity: string): string {
    let current = identity;
    for (const index of this.sourceIndex) {
      const target = index.get(current);
      if (target !== undefined) {
        current = target;
      }
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Baseline replay (SPEC 6.3)
// ---------------------------------------------------------------------------

/**
 * The raw content bytes of each line (terminators excluded; the final line
 * may be unterminated) — the same line model `parseJournal` walks.
 */
function lineContents(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const terminator = bytes.indexOf(LF, offset);
    const end = terminator === -1 ? bytes.length : terminator;
    lines.push(bytes.subarray(offset, end));
    offset = end + 1;
  }
  return lines;
}

function sameContent(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** The outcome of computing the SPEC 6.3 baseline→current replay mapping. */
export type JournalReplayResult =
  | {
      readonly ok: true;
      /**
       * The journal entries present in the current journal but absent from
       * the journal content at the baseline ref, in file order, as a
       * walkable Journal: `mapForward` maps a baseline identity to its
       * current identity, composing chained mappings (SPEC 6.3).
       */
      readonly replay: Journal;
    }
  | {
      readonly ok: false;
      /**
       * Why the replay cannot be computed — a prefix violation or
       * unresolvable entries — naming the offending entries or files
       * (SPEC 6.3). The caller reports it as a usage error (12.0).
       */
      readonly problem: string;
    };

/**
 * SPEC 6.3: compute the replay mapping from a baseline ref's journal
 * content to the current journal content. A journal file absent on either
 * side reads as an empty journal (callers pass zero bytes); an empty
 * journal is a prefix of every journal. The prefix requirement is
 * entry-wise — the baseline journal's lines must be an exact leading run of
 * the current journal's lines, each byte-identical (the journal is
 * append-only, SPEC 6.1) — and the entries beyond that prefix are the
 * replay, applied in file order with chained mappings composing.
 *
 * Callers validate the baseline journal first (a baseline whose journal has
 * malformed lines fails workspace validation, 14.13, before replay is ever
 * computed); with the prefix holding, any malformed current line therefore
 * lies in the replay suffix and makes the mapping unresolvable.
 */
export function computeJournalReplay(
  baselineBytes: Uint8Array,
  currentBytes: Uint8Array,
): JournalReplayResult {
  const baselineLines = lineContents(baselineBytes);
  const currentLines = lineContents(currentBytes);
  // SPEC 6.3: the journal at the baseline ref must be a prefix of the
  // current journal — otherwise the append-only invariant (6.1) was
  // violated and no replay suffix exists.
  if (baselineLines.length > currentLines.length) {
    const base = String(baselineLines.length);
    const current = String(currentLines.length);
    return {
      ok: false,
      problem:
        `the journal content at the baseline ref has ${base} ` +
        `${baselineLines.length === 1 ? "entry" : "entries"} but the ` +
        `current ${JOURNAL_PATH} has only ${current} — the baseline ` +
        `journal is not a prefix of the current journal, so the ` +
        `append-only invariant was violated (SPEC 6.1, 6.3); restore ` +
        `${JOURNAL_PATH} from version control so it extends the journal ` +
        `content at the baseline ref`,
    };
  }
  for (let index = 0; index < baselineLines.length; index += 1) {
    if (!sameContent(baselineLines[index], currentLines[index])) {
      const line = String(index + 1);
      return {
        ok: false,
        problem:
          `line ${line} of the current ${JOURNAL_PATH} differs from line ` +
          `${line} of the journal content at the baseline ref — the ` +
          `baseline journal is not a prefix of the current journal, so ` +
          `the append-only invariant was violated (SPEC 6.1, 6.3); ` +
          `restore ${JOURNAL_PATH} from version control so it extends the ` +
          `journal content at the baseline ref`,
      };
    }
  }
  // SPEC 6.3: replay is unresolvable when the entries to apply cannot be
  // parsed and validated — the findings name the offending lines (14.13's
  // message form, reused here as the naming duty's carrier).
  const parsed = parseJournal(currentBytes);
  if (parsed.findings.length > 0) {
    return {
      ok: false,
      problem:
        `replaying the journal entries absent at the baseline ref ` +
        `produced no resolvable mapping — ` +
        parsed.findings.map((finding) => finding.message).join("; "),
    };
  }
  return {
    ok: true,
    replay: new Journal(
      parsed.entries.filter((entry) => entry.line > baselineLines.length),
    ),
  };
}
