// In-harness glob and capture matching oracle (TEST-SPEC 16 P-7, 17 S-6): an
// independent implementation of SPEC.md 7's glob grammar and SPEC.md 7.5's
// capture matching, used to compute the expected match decisions and capture
// values for the P-7 property tests. Per S-6, the oracle passes its fixed
// vector suite (test/self/s6-glob-oracle.test.ts), derived from SPEC.md 7's
// rules and 7.5's rules and worked examples, before any property test trusts
// it. Harness machinery only: pure functions, no product imports, no I/O, no
// test-framework dependence — a CERTIFICATIONS.md CONF-DISC fixture may share
// this matcher.
//
// SPEC.md 7, as implemented here:
//
// * Matching is byte-wise and case-sensitive: patterns and paths are matched
//   as their UTF-8 bytes. String inputs are encoded; Uint8Array inputs are
//   matched as given, valid UTF-8 or not (whether a discovered path is valid
//   UTF-8 is the product's 14.19 concern, not the matcher's). `/` (0x2F)
//   separates segments in patterns and paths alike; UTF-8 never embeds 0x2F
//   inside a multi-byte sequence, so byte-level splitting is exact.
// * Globs support exactly `*` (any possibly empty run of bytes within one
//   path segment), `?` (one byte within a segment), and `**` (any number of
//   whole segments, including none). Every other character is a literal —
//   the metacharacters of other dialects (`[` `]` `{` `}` `!` `+` `(` `)`)
//   included, and `$` too in discovery globs (capture wildcards exist only
//   in policy `files` selectors, SPEC.md 7.5).
// * A pattern segment written exactly `**` is the whole-segments wildcard.
//   Only a whole pattern segment can match "whole segments": a `**` written
//   inside a larger segment is two adjacent `*` byte runs (the same match
//   decisions as a single `*`).
// * A path segment beginning with `.` is matched only by a pattern segment
//   written with a leading `.` — the rule reads the pattern as written, so
//   `*`, `?`, `**`, capture wildcards, and capture references never match a
//   dot-initial segment (a reference does not match one even when its
//   captured value begins with `.`), and `**` never consumes one.
//
// SPEC.md 7.5, as implemented here:
//
// * A `from` pattern may contain capture wildcards `$1`…`$9`, each at most
//   once; a capture matches one or more bytes within a single path segment
//   (never `/`, never empty). `$` not followed by `1`…`9` is a literal.
// * Disambiguation is across the whole pattern, left to right: each wildcard
//   (`*`, `?`, `**`) and each capture, in pattern order, takes as few bytes
//   as possible while a match of the remainder of the pattern still exists —
//   so every match, and every capture value, is unique.
// * A `to` pattern references captures: `$n` there matches exactly the
//   captured bytes, as a literal — "targets whose expansion agrees with the
//   captured values" — so bytes captured from a path are never reinterpreted
//   as metacharacters.
// * A `from` pattern repeating a capture, or a `to` pattern referencing a
//   capture it has no value for, is a configuration error (14.14) the
//   product rejects; the oracle defines matching only for valid patterns and
//   throws a plain Error on such misuse (a harness defect, never a diagnosed
//   product failure).
//
// Pattern *resolution* — upward config search, paths resolving outside the
// workspace root (14.14) — is out of scope: the oracle decides matches of
// already workspace-relative patterns against workspace-relative paths.

import { Buffer } from "node:buffer";

/** Pattern or path bytes: strings are matched as their UTF-8 bytes. */
export type GlobInput = string | Uint8Array;

/**
 * Capture values for `matchToPattern`: what `matchFromPattern` returned on
 * the `from` side, or hand-built values (strings are UTF-8-encoded).
 */
export type CaptureValues = ReadonlyMap<number, string | Uint8Array>;

const SLASH = 0x2f; // "/"
const STAR = 0x2a; // "*"
const QUESTION = 0x3f; // "?"
const DOLLAR = 0x24; // "$"
const DOT = 0x2e; // "."

/** How `$` followed by `1`…`9` reads: literal (7), capture or reference (7.5). */
type DollarTreatment = "literal" | "capture" | "reference";

type SegmentToken =
  | { readonly kind: "literal"; readonly bytes: Uint8Array }
  | { readonly kind: "one-byte" } // `?`
  | { readonly kind: "byte-run" } // `*`
  | { readonly kind: "capture"; readonly index: number }; // `$1`…`$9`

type PatternSegment =
  | { readonly kind: "globstar" } // the pattern segment written exactly `**`
  | {
      readonly kind: "tokens";
      readonly tokens: readonly SegmentToken[];
      /** SPEC.md 7 dot rule: the segment's first written byte is `.`. */
      readonly writtenLeadingDot: boolean;
    };

function toBytes(input: GlobInput): Uint8Array {
  return typeof input === "string" ? Buffer.from(input, "utf8") : input;
}

function misuse(message: string): never {
  throw new Error(`glob oracle misuse: ${message}`);
}

/** Render a pattern for a misuse message (lossy decode is fine there). */
function describePattern(pattern: GlobInput): string {
  return JSON.stringify(
    typeof pattern === "string"
      ? pattern
      : Buffer.from(pattern).toString("utf8"),
  );
}

function splitOnSlash(bytes: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === SLASH) {
      segments.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return segments;
}

function parseSegment(
  segment: Uint8Array,
  dollar: DollarTreatment,
): PatternSegment {
  if (segment.length === 2 && segment[0] === STAR && segment[1] === STAR) {
    return { kind: "globstar" };
  }
  const tokens: SegmentToken[] = [];
  let literalStart = -1;
  const endLiteral = (end: number): void => {
    if (literalStart !== -1) {
      tokens.push({
        kind: "literal",
        bytes: segment.subarray(literalStart, end),
      });
      literalStart = -1;
    }
  };
  for (let i = 0; i < segment.length; i += 1) {
    const byte = segment[i];
    if (byte === STAR) {
      endLiteral(i);
      tokens.push({ kind: "byte-run" });
    } else if (byte === QUESTION) {
      endLiteral(i);
      tokens.push({ kind: "one-byte" });
    } else if (
      byte === DOLLAR &&
      dollar !== "literal" &&
      i + 1 < segment.length &&
      segment[i + 1] >= 0x31 && // "1"
      segment[i + 1] <= 0x39 // "9"
    ) {
      endLiteral(i);
      tokens.push({ kind: "capture", index: segment[i + 1] - 0x30 });
      i += 1;
    } else if (literalStart === -1) {
      literalStart = i;
    }
  }
  endLiteral(segment.length);
  return {
    kind: "tokens",
    tokens,
    writtenLeadingDot: segment.length > 0 && segment[0] === DOT,
  };
}

function parsePattern(
  pattern: GlobInput,
  dollar: DollarTreatment,
): PatternSegment[] {
  return splitOnSlash(toBytes(pattern)).map((segment) =>
    parseSegment(segment, dollar),
  );
}

/** Every capture index written in the parsed pattern, in written order. */
function captureIndexList(segments: readonly PatternSegment[]): number[] {
  const indices: number[] = [];
  for (const segment of segments) {
    if (segment.kind !== "tokens") continue;
    for (const token of segment.tokens) {
      if (token.kind === "capture") indices.push(token.index);
    }
  }
  return indices;
}

interface MatchState {
  readonly dollar: DollarTreatment;
  /** Reference mode: the bytes each `$n` must match exactly. */
  readonly values: ReadonlyMap<number, Uint8Array>;
  /**
   * Capture mode: capture assignments, overwritten as the search moves on.
   * On overall success this holds exactly the winning assignment: the
   * search stops at its first success, every pattern segment on the success
   * path matches (binding every capture token it contains) after all
   * previously explored failures, and nothing reads these values during
   * matching — so failed branches need no rollback.
   */
  readonly captures: Map<number, Uint8Array>;
}

function startsWithAt(
  bytes: Uint8Array,
  prefix: Uint8Array,
  at: number,
): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[at + i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Match one non-`**` pattern segment against one path segment, shortest
 * first: each `*`, `?`, and capture, in token order, takes as few bytes as
 * possible while the rest of the segment still matches, so the first
 * assignment found is the unique disambiguated one (SPEC.md 7.5). The
 * `failed` memo records (token, offset) states proven unmatchable — capture
 * values never feed back into matchability, so failure is position-absolute
 * and pruning changes no decision and no assignment, only the running time.
 */
function matchTokenSegment(
  tokens: readonly SegmentToken[],
  bytes: Uint8Array,
  state: MatchState,
): boolean {
  const width = bytes.length + 1;
  const failed = new Set<number>();
  const matchAt = (ti: number, at: number): boolean => {
    const key = ti * width + at;
    if (failed.has(key)) return false;
    const token = tokens[ti];
    let matched: boolean;
    if (token === undefined) {
      matched = at === bytes.length;
    } else if (token.kind === "literal") {
      matched =
        startsWithAt(bytes, token.bytes, at) &&
        matchAt(ti + 1, at + token.bytes.length);
    } else if (token.kind === "one-byte") {
      matched = at < bytes.length && matchAt(ti + 1, at + 1);
    } else if (token.kind === "byte-run") {
      // `*`: a possibly empty byte run — fewest bytes first.
      matched = false;
      for (let end = at; end <= bytes.length; end += 1) {
        if (matchAt(ti + 1, end)) {
          matched = true;
          break;
        }
      }
    } else if (state.dollar === "reference") {
      // `$n` in a `to` pattern: exactly the captured bytes, as a literal
      // (SPEC.md 7.5 expansion agreement). Presence was pre-validated.
      const value =
        state.values.get(token.index) ??
        misuse(`no value for $${String(token.index)} reached the matcher`);
      matched =
        startsWithAt(bytes, value, at) && matchAt(ti + 1, at + value.length);
    } else {
      // `$n` in a `from` pattern: one or more bytes within this segment
      // (SPEC.md 7.5) — fewest bytes first.
      matched = false;
      for (let end = at + 1; end <= bytes.length; end += 1) {
        state.captures.set(token.index, bytes.subarray(at, end));
        if (matchAt(ti + 1, end)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchAt(0, 0);
}

/**
 * Match parsed pattern segments against path segments. `**` takes as few
 * whole segments as possible while the remainder still matches, and never
 * consumes a dot-initial segment (SPEC.md 7); every other pattern segment
 * matches exactly one path segment, which is what keeps `*` runs and
 * captures inside a single segment (never `/`). A token segment consumes
 * its whole path segment whatever internal assignment is chosen, so
 * segment-level feasibility is assignment-independent: the per-(pattern,
 * path) failure memo is sound, and local shortest-first token search
 * realizes the whole-pattern left-to-right rule of SPEC.md 7.5.
 */
function matchSegments(
  patternSegments: readonly PatternSegment[],
  pathSegments: readonly Uint8Array[],
  state: MatchState,
): boolean {
  const width = pathSegments.length + 1;
  const failed = new Set<number>();
  const matchFrom = (pi: number, si: number): boolean => {
    const key = pi * width + si;
    if (failed.has(key)) return false;
    const segment = patternSegments[pi];
    let matched: boolean;
    if (segment === undefined) {
      matched = si === pathSegments.length;
    } else if (segment.kind === "globstar") {
      // `**`: fewest whole segments first — zero, then one, … — extending
      // only over segments the dot rule lets a wildcard consume.
      matched = false;
      let end = si;
      for (;;) {
        if (matchFrom(pi + 1, end)) {
          matched = true;
          break;
        }
        if (end === pathSegments.length) break;
        const next = pathSegments[end];
        if (next.length > 0 && next[0] === DOT) break;
        end += 1;
      }
    } else if (si === pathSegments.length) {
      matched = false;
    } else {
      const pathSegment = pathSegments[si];
      const dotBlocked =
        pathSegment.length > 0 &&
        pathSegment[0] === DOT &&
        !segment.writtenLeadingDot;
      matched =
        !dotBlocked &&
        matchTokenSegment(segment.tokens, pathSegment, state) &&
        matchFrom(pi + 1, si + 1);
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchFrom(0, 0);
}

/**
 * SPEC.md 7: does a discovery glob match a workspace-relative path? `$` is
 * an ordinary literal here — capture wildcards exist only in policy `files`
 * selectors (SPEC.md 7.5).
 */
export function globMatches(pattern: GlobInput, path: GlobInput): boolean {
  const state: MatchState = {
    dollar: "literal",
    values: new Map(),
    captures: new Map(),
  };
  return matchSegments(
    parsePattern(pattern, "literal"),
    splitOnSlash(toBytes(path)),
    state,
  );
}

/**
 * SPEC.md 7.5: match a policy `files` selector `from` pattern. Returns the
 * unique capture assignment on a match — keyed by capture index in
 * ascending order, an empty map when the pattern has no captures — and null
 * on a mismatch. Captured values are copies of the matched path bytes. A
 * pattern repeating a capture index is a configuration error (14.14) the
 * oracle has no semantics for: it throws.
 */
export function matchFromPattern(
  pattern: GlobInput,
  path: GlobInput,
): ReadonlyMap<number, Uint8Array> | null {
  const segments = parsePattern(pattern, "capture");
  const indices = captureIndexList(segments);
  if (new Set(indices).size !== indices.length) {
    misuse(
      `a \`from\` pattern uses each capture wildcard at most once (SPEC.md 7.5; a repeat is a 14.14 configuration error): ${describePattern(pattern)}`,
    );
  }
  const state: MatchState = {
    dollar: "capture",
    values: new Map(),
    captures: new Map(),
  };
  if (!matchSegments(segments, splitOnSlash(toBytes(path)), state)) {
    return null;
  }
  const captured = new Map<number, Uint8Array>();
  for (const index of [...state.captures.keys()].sort((a, b) => a - b)) {
    const value =
      state.captures.get(index) ??
      misuse(`capture $${String(index)} vanished from the assignment`);
    captured.set(index, Uint8Array.from(value));
  }
  return captured;
}

/**
 * SPEC.md 7.5: match a policy `files` selector `to` pattern under the given
 * captured values (the `from` side's `matchFromPattern` result). `$n`
 * matches exactly the captured bytes, as a literal — expansion agreement —
 * while `*`, `?`, and `**` keep their SPEC.md 7 meanings; a `to` may
 * reference a capture more than once. Referencing an index the map has no
 * value for is a configuration error (14.14) the oracle has no semantics
 * for: it throws.
 */
export function matchToPattern(
  pattern: GlobInput,
  path: GlobInput,
  captures: CaptureValues,
): boolean {
  const segments = parsePattern(pattern, "reference");
  const values = new Map<number, Uint8Array>();
  for (const [index, value] of captures) {
    values.set(index, toBytes(value));
  }
  for (const index of captureIndexList(segments)) {
    if (!values.has(index)) {
      misuse(
        `a \`to\` pattern referencing a capture absent from \`from\` is a configuration error (SPEC.md 7.5, 14.14): $${String(index)} in ${describePattern(pattern)}`,
      );
    }
  }
  const state: MatchState = {
    dollar: "reference",
    values,
    captures: new Map(),
  };
  return matchSegments(segments, splitOnSlash(toBytes(path)), state);
}

/**
 * The capture indices written in a pattern (`$1` → 1), ascending — for
 * `from`/`to` agreement checks and the P-7 generators. `$` not followed by
 * `1`…`9` is a literal and contributes nothing; repeats collapse (validity
 * of a `from` pattern is `matchFromPattern`'s concern).
 */
export function captureIndicesIn(pattern: GlobInput): ReadonlySet<number> {
  return new Set(
    captureIndexList(parsePattern(pattern, "capture")).sort((a, b) => a - b),
  );
}
