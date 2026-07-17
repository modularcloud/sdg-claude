// The glob engine with captures — in-repo per IMPLEMENTATION ("Key
// libraries"): no glob library; the dialect's semantics are pinned exactly
// by the spec and off-the-shelf behavior differs. This is the one glob code
// path: configured group patterns and `--file` flag values compile in
// "plain" mode; policy `files` selectors compile in "capture-from" /
// "capture-to" mode (SPEC 7.5).
//
// SPEC 7: glob matching, like every path comparison (12.0), is byte-wise
// and case-sensitive — workspace-relative paths are matched as their UTF-8
// bytes. Globs support exactly `*` (any possibly empty run of bytes within
// one path segment), `?` (one byte within a segment), and `**` (any number
// of whole segments, including none); every other character is a literal,
// the metacharacters of other dialects (`[` `]` `{` `}` `!` `+` `(` `)`)
// included. Only a whole pattern segment written exactly `**` is the
// whole-segments wildcard; a `**` inside a larger segment reads as two
// adjacent `*` runs. A path segment beginning with `.` is matched only by a
// pattern segment written with a leading `.` — read from the pattern as
// written, so `*`, `?`, `**`, captures, and capture references never match
// a dot-initial segment, and `**` never consumes one. A pattern that
// resolves outside the workspace root is a configuration error (14.14); an
// outside-root `--file` value is the flag-level counterpart, a usage error
// (SPEC 11, 12.0) — this module only reports the condition as data.
//
// SPEC 7.5: a `from` pattern MAY contain capture wildcards `$1`…`$9`, each
// appearing at most once; a capture matches one or more bytes within a
// single path segment (never `/`). The `to` pattern MAY reference them and
// matches only targets whose expansion agrees with the captured values:
// `$n` there matches exactly the captured bytes, as literals — bytes
// captured from a path are never reinterpreted as metacharacters. When a
// pattern could match a path in more than one way, the match is
// disambiguated across the whole pattern, left to right: each wildcard
// (`*`, `?`, `**`) and each capture, in pattern order, takes as few bytes
// as possible while a match of the remainder of the pattern still exists —
// so every match, and every capture value, is unique (`$1-$2.ts` against
// `a-b-c.ts` captures `$1 = a`, `$2 = b-c`; `*$1*` against `abc` captures
// `$1 = a`).

const SLASH = 0x2f; // "/"
const STAR = 0x2a; // "*"
const QUESTION = 0x3f; // "?"
const DOLLAR = 0x24; // "$"
const DOT = 0x2e; // "."

const utf8Encoder = new TextEncoder();

/** A path to match: strings are matched as their UTF-8 bytes (SPEC 7). */
export type PathInput = string | Uint8Array;

/**
 * How the pattern's `$` characters read. Capture wildcards exist only in
 * policy `files` selectors (SPEC 7.5): `"capture-from"` for a rule's `from`
 * pattern (`$1`…`$9` bind values), `"capture-to"` for its `to` pattern
 * (`$1`…`$9` reference the `from` side's values). Everywhere else —
 * `specs`/`code` group globs, `--file` flag values — the mode is `"plain"`
 * and `$` is an ordinary literal (SPEC 7: globs support exactly `*`, `?`,
 * and `**`).
 */
export type GlobMode = "plain" | "capture-from" | "capture-to";

/** Captured byte values keyed by capture number (`$1` → 1), ascending. */
export type CaptureValues = ReadonlyMap<number, Uint8Array>;

/**
 * Why a pattern does not compile, as data (IMPLEMENTATION cross-cutting
 * rules): "outside-root" — the pattern resolves outside the workspace root
 * (SPEC 7); "duplicate-capture" — a `from` pattern uses a capture wildcard
 * more than once (SPEC 7.5). Both are configuration errors (14.14) when the
 * pattern comes from configuration; an outside-root `--file` value is a
 * usage error (SPEC 11, 12.0). The caller assigns the exit class.
 */
export type GlobCompileError =
  | { readonly kind: "outside-root" }
  | { readonly kind: "duplicate-capture"; readonly capture: number };

export type GlobCompileResult =
  | { readonly ok: true; readonly glob: CompiledGlob }
  | { readonly ok: false; readonly error: GlobCompileError };

type SegmentToken =
  | { readonly kind: "literal"; readonly bytes: Uint8Array }
  | { readonly kind: "one-byte" } // `?` (SPEC 7)
  | { readonly kind: "byte-run" } // `*` (SPEC 7)
  | { readonly kind: "capture"; readonly capture: number }; // `$1`…`$9` (SPEC 7.5)

type PatternSegment =
  | { readonly kind: "globstar" } // the whole segment written exactly `**`
  | {
      readonly kind: "tokens";
      readonly tokens: readonly SegmentToken[];
      /** SPEC 7 dot rule: the segment's first written byte is `.`. */
      readonly writtenLeadingDot: boolean;
    };

/** How `$n` tokens evaluate: bind fewest-first, or match bound bytes. */
type CaptureRole = "bind" | "reference";

function toBytes(input: PathInput): Uint8Array {
  return typeof input === "string" ? utf8Encoder.encode(input) : input;
}

/**
 * Split on `/` (0x2F). UTF-8 never embeds 0x2F inside a multi-byte
 * sequence, so byte-level splitting is exact (SPEC 7 byte-wise matching).
 * Any input yields at least one (possibly empty) segment.
 */
function splitOnSlash(bytes: Uint8Array): Uint8Array[] {
  const segments: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === SLASH) {
      segments.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return segments;
}

function isDotSegment(segment: Uint8Array): boolean {
  return segment.length === 1 && segment[0] === DOT;
}

function isDotDotSegment(segment: Uint8Array): boolean {
  return segment.length === 2 && segment[0] === DOT && segment[1] === DOT;
}

/**
 * Resolve a pattern's `.` and `..` segments lexically against the
 * workspace root (SPEC 7: configured paths and globs resolve relative to
 * the configuration file's directory, which is the workspace root).
 * Wildcard segments count as ordinary names to resolution; matched paths
 * are canonical workspace-relative paths and never contain dot segments,
 * so matching uses the resolved form. Returns null when the pattern
 * resolves outside the workspace root (SPEC 7 → 14.14): an absolute
 * pattern, or a `..` with no preceding segment left to cancel. Interior
 * empty segments (`//` runs) collapse; a trailing slash keeps one final
 * empty segment — no real path has one, so such a pattern matches nothing.
 */
function resolveSegments(
  raw: readonly Uint8Array[],
): readonly Uint8Array[] | null {
  const first = raw[0];
  if (raw.length > 1 && first.length === 0) {
    return null; // absolute: not workspace-root-relative
  }
  const resolved: Uint8Array[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const segment = raw[index];
    if (segment.length === 0) {
      if (index > 0 && index === raw.length - 1) {
        resolved.push(segment);
      }
      continue;
    }
    if (isDotSegment(segment)) {
      continue;
    }
    if (isDotDotSegment(segment)) {
      if (resolved.length === 0) {
        return null; // steps above the workspace root
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved;
}

/**
 * Tokenize one pattern segment: the whole-segment `**` wildcard, or a run
 * of literal bytes, `*`, `?`, and — in capture modes — `$1`…`$9` tokens.
 * Every other byte is a literal (SPEC 7); `$` not followed by `1`…`9`, and
 * every `$` in plain mode, is a literal too (SPEC 7.5: capture wildcards
 * exist only in policy `files` selectors).
 */
function parseSegment(
  segment: Uint8Array,
  capturesEnabled: boolean,
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
  for (let index = 0; index < segment.length; index += 1) {
    const byte = segment[index];
    if (byte === STAR) {
      endLiteral(index);
      tokens.push({ kind: "byte-run" });
    } else if (byte === QUESTION) {
      endLiteral(index);
      tokens.push({ kind: "one-byte" });
    } else if (
      byte === DOLLAR &&
      capturesEnabled &&
      index + 1 < segment.length &&
      segment[index + 1] >= 0x31 && // "1"
      segment[index + 1] <= 0x39 // "9"
    ) {
      endLiteral(index);
      tokens.push({ kind: "capture", capture: segment[index + 1] - 0x30 });
      index += 1;
    } else if (literalStart === -1) {
      literalStart = index;
    }
  }
  endLiteral(segment.length);
  return {
    kind: "tokens",
    tokens,
    writtenLeadingDot: segment.length > 0 && segment[0] === DOT,
  };
}

/** The capture numbers written in the segments, in written order. */
function writtenCaptures(segments: readonly PatternSegment[]): number[] {
  const captures: number[] = [];
  for (const segment of segments) {
    if (segment.kind !== "tokens") continue;
    for (const token of segment.tokens) {
      if (token.kind === "capture") captures.push(token.capture);
    }
  }
  return captures;
}

function startsWithAt(
  bytes: Uint8Array,
  prefix: Uint8Array,
  at: number,
): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[at + index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Match one token segment against one path segment, shortest first: each
 * `*` and each capture, in token order, takes as few bytes as possible
 * while the rest of the segment still matches, so the first assignment
 * found is the unique disambiguated one (SPEC 7.5). Failure states
 * (token, offset) are memoized: matchability from a position never depends
 * on capture assignments — bound values are read only in "reference" role,
 * where they are fixed before matching starts — so failure is
 * position-absolute and pruning changes no decision, only running time.
 *
 * In "bind" role, `captured` entries are overwritten as the search moves;
 * on overall success they hold exactly the winning assignment: the search
 * stops at its first success, every capture token lies on that success
 * path (each is matched by its segment's final, successful attempt), and
 * nothing reads the entries during binding — so failed branches need no
 * rollback.
 */
function matchTokenSegment(
  tokens: readonly SegmentToken[],
  bytes: Uint8Array,
  role: CaptureRole,
  values: ReadonlyMap<number, Uint8Array>,
  captured: Map<number, Uint8Array>,
): boolean {
  const width = bytes.length + 1;
  const failed = new Set<number>();
  const matchAt = (tokenIndex: number, at: number): boolean => {
    const key = tokenIndex * width + at;
    if (failed.has(key)) return false;
    let matched: boolean;
    if (tokenIndex === tokens.length) {
      matched = at === bytes.length;
    } else {
      const token = tokens[tokenIndex];
      switch (token.kind) {
        case "literal":
          matched =
            startsWithAt(bytes, token.bytes, at) &&
            matchAt(tokenIndex + 1, at + token.bytes.length);
          break;
        case "one-byte":
          // SPEC 7: `?` is one byte within a segment.
          matched = at < bytes.length && matchAt(tokenIndex + 1, at + 1);
          break;
        case "byte-run": {
          // SPEC 7: `*` is any possibly empty run of bytes within one
          // segment — fewest bytes first (SPEC 7.5 disambiguation).
          matched = false;
          for (let end = at; end <= bytes.length; end += 1) {
            if (matchAt(tokenIndex + 1, end)) {
              matched = true;
              break;
            }
          }
          break;
        }
        case "capture":
          if (role === "reference") {
            // SPEC 7.5: a `to` reference matches exactly the captured
            // bytes, as literals — expansion agreement.
            const value = values.get(token.capture);
            if (value === undefined) {
              throw new RangeError(
                `no captured value for $${String(token.capture)} — a \`to\` ` +
                  `pattern referencing a capture absent from \`from\` is a ` +
                  `configuration error (SPEC 7.5, 14.14) rejected before ` +
                  `matching`,
              );
            }
            matched =
              startsWithAt(bytes, value, at) &&
              matchAt(tokenIndex + 1, at + value.length);
          } else {
            // SPEC 7.5: a capture matches one or more bytes within a
            // single segment — fewest bytes first.
            matched = false;
            for (let end = at + 1; end <= bytes.length; end += 1) {
              captured.set(token.capture, bytes.subarray(at, end));
              if (matchAt(tokenIndex + 1, end)) {
                matched = true;
                break;
              }
            }
          }
          break;
      }
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchAt(0, 0);
}

/**
 * Match the pattern segments against the path segments. `**` takes as few
 * whole segments as possible while the remainder still matches (SPEC 7.5
 * disambiguation; fewest whole segments is fewest bytes), and never
 * consumes a dot-initial segment (SPEC 7 dot rule). Every other pattern
 * segment matches exactly one whole path segment — which is what confines
 * `*`, `?`, and captures within a single segment (never `/`). A token
 * segment consumes its whole path segment whatever internal assignment is
 * chosen, so segment-level feasibility is assignment-independent: the
 * per-(pattern, path) failure memo is sound, and local shortest-first
 * token search realizes the whole-pattern left-to-right rule of SPEC 7.5.
 */
function matchSegments(
  patternSegments: readonly PatternSegment[],
  pathSegments: readonly Uint8Array[],
  role: CaptureRole,
  values: ReadonlyMap<number, Uint8Array>,
  captured: Map<number, Uint8Array>,
): boolean {
  const width = pathSegments.length + 1;
  const failed = new Set<number>();
  const matchFrom = (patternIndex: number, pathIndex: number): boolean => {
    const key = patternIndex * width + pathIndex;
    if (failed.has(key)) return false;
    let matched: boolean;
    if (patternIndex === patternSegments.length) {
      matched = pathIndex === pathSegments.length;
    } else {
      const segment = patternSegments[patternIndex];
      if (segment.kind === "globstar") {
        // SPEC 7: `**` is any number of whole segments, including none —
        // fewest first, extending only over segments the dot rule lets a
        // wildcard consume.
        matched = false;
        let end = pathIndex;
        for (;;) {
          if (matchFrom(patternIndex + 1, end)) {
            matched = true;
            break;
          }
          if (end === pathSegments.length) break;
          const next = pathSegments[end];
          if (next.length > 0 && next[0] === DOT) break;
          end += 1;
        }
      } else if (pathIndex === pathSegments.length) {
        matched = false;
      } else {
        const pathSegment = pathSegments[pathIndex];
        // SPEC 7: a path segment beginning with `.` is matched only by a
        // pattern segment written with a leading `.`.
        const dotBlocked =
          pathSegment.length > 0 &&
          pathSegment[0] === DOT &&
          !segment.writtenLeadingDot;
        matched =
          !dotBlocked &&
          matchTokenSegment(
            segment.tokens,
            pathSegment,
            role,
            values,
            captured,
          ) &&
          matchFrom(patternIndex + 1, pathIndex + 1);
      }
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchFrom(0, 0);
}

/**
 * A compiled glob pattern. Compile with {@link compileGlob}; match with
 * {@link CompiledGlob.matches} / {@link CompiledGlob.match} (plain and
 * capture-from modes) or {@link CompiledGlob.matchesWith} (capture-to
 * mode, under the `from` side's captured values). Matching is pure and
 * deterministic (SPEC 12.0).
 */
export class CompiledGlob {
  /** The pattern as written, for diagnostics. */
  readonly source: string;
  readonly mode: GlobMode;
  /**
   * The capture numbers written in the pattern, ascending — empty outside
   * capture modes. For a valid rule every capture a `to` pattern
   * references must appear here on the `from` side (SPEC 7.5, else 14.14);
   * see {@link unboundToCaptures}.
   */
  readonly captures: ReadonlySet<number>;
  private readonly segments: readonly PatternSegment[];

  private constructor(
    source: string,
    mode: GlobMode,
    captures: ReadonlySet<number>,
    segments: readonly PatternSegment[],
  ) {
    this.source = source;
    this.mode = mode;
    this.captures = captures;
    this.segments = segments;
  }

  /** @internal Use {@link compileGlob}. */
  static compileInternal(pattern: string, mode: GlobMode): GlobCompileResult {
    const resolved = resolveSegments(splitOnSlash(utf8Encoder.encode(pattern)));
    if (resolved === null) {
      return { ok: false, error: { kind: "outside-root" } };
    }
    const capturesEnabled = mode !== "plain";
    const segments = resolved.map((segment) =>
      parseSegment(segment, capturesEnabled),
    );
    const written = writtenCaptures(segments);
    if (mode === "capture-from") {
      // SPEC 7.5: the `from` pattern MAY contain `$1`…`$9`, each appearing
      // at most once; a repeat is a configuration error (14.14).
      const seen = new Set<number>();
      for (const capture of written) {
        if (seen.has(capture)) {
          return { ok: false, error: { kind: "duplicate-capture", capture } };
        }
        seen.add(capture);
      }
    }
    const captures: ReadonlySet<number> = new Set(
      [...new Set(written)].sort((a, b) => a - b),
    );
    return {
      ok: true,
      glob: new CompiledGlob(pattern, mode, captures, segments),
    };
  }

  /**
   * Does the pattern match this workspace-relative path? In capture-from
   * mode, captures act as anonymous one-plus-byte within-segment wildcards
   * — the match decision does not depend on disambiguation. Not defined
   * for capture-to mode: a `to` pattern's references have no meaning
   * without the `from` side's values (use {@link CompiledGlob.matchesWith}).
   */
  matches(path: PathInput): boolean {
    return this.match(path) !== null;
  }

  /**
   * Match and return the unique capture assignment under the SPEC 7.5
   * disambiguation (whole pattern, left to right, fewest bytes): captured
   * values keyed by capture number ascending, an empty map when the
   * pattern has no captures; null on no match. Captured values are copies
   * of the matched path bytes. Not defined for capture-to mode.
   */
  match(path: PathInput): CaptureValues | null {
    if (this.mode === "capture-to") {
      throw new RangeError(
        "a capture-to pattern matches only under captured values (SPEC 7.5); " +
          "use matchesWith",
      );
    }
    const captured = new Map<number, Uint8Array>();
    const matched = matchSegments(
      this.segments,
      splitOnSlash(toBytes(path)),
      "bind",
      new Map(),
      captured,
    );
    if (!matched) return null;
    const result = new Map<number, Uint8Array>();
    for (const capture of [...captured.keys()].sort((a, b) => a - b)) {
      const value = captured.get(capture);
      if (value !== undefined) result.set(capture, Uint8Array.from(value));
    }
    return result;
  }

  /**
   * Match under the `from` side's captured values (SPEC 7.5 expansion
   * agreement): each `$n` matches exactly `values.get(n)`'s bytes, as
   * literals, while `*`, `?`, and `**` keep their SPEC 7 meanings; a `to`
   * MAY reference a capture more than once. Every capture written in the
   * pattern must have a value — a `to` referencing a capture absent from
   * `from` is a configuration error (14.14) rejected at validation, so a
   * missing value here is a caller defect (RangeError).
   */
  matchesWith(path: PathInput, values: CaptureValues): boolean {
    return matchSegments(
      this.segments,
      splitOnSlash(toBytes(path)),
      "reference",
      values,
      new Map(),
    );
  }
}

/**
 * Compile a pattern in the given mode. Errors — an outside-root pattern
 * (SPEC 7), a repeated capture in a `from` pattern (SPEC 7.5) — come back
 * as data for the caller to report (14.14 from configuration; usage error
 * for `--file`, SPEC 11/12.0).
 */
export function compileGlob(
  pattern: string,
  mode: GlobMode,
): GlobCompileResult {
  return CompiledGlob.compileInternal(pattern, mode);
}

/**
 * SPEC 7.5: the captures a `to` pattern references without the `from`
 * pattern binding them, ascending — non-empty means the rule is a
 * configuration error (14.14).
 */
export function unboundToCaptures(
  from: CompiledGlob,
  to: CompiledGlob,
): number[] {
  return [...to.captures]
    .filter((capture) => !from.captures.has(capture))
    .sort((a, b) => a - b);
}
