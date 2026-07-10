// S-6 glob/capture-oracle vectors (TEST-SPEC 17 S-6): the in-harness glob
// and capture matching oracle for P-7 (test/helpers/oracles/glob.ts) passes
// this fixed vector suite, derived from SPEC.md 7's glob grammar and SPEC.md
// 7.5's capture rules and worked examples, before any property test trusts
// it. Every vector's expected decision and capture assignment is
// hand-computed; no product is involved (the product's own 7/7.5 behavior is
// asserted by the suite's T7-4…T7-6 and T7.5-* tests against fixtures, not
// against this oracle).
//
// Coverage, by the rules the vectors derive from (TEST-SPEC restatements in
// parentheses):
//   * `*` any possibly empty byte run within one segment; `?` exactly one
//     byte; `**` any number of whole segments including none (7; T7-4);
//   * byte-wise matching — the two-byte `é.mdx` probe discriminating bytes
//     from characters, and non-UTF-8 path bytes (7; T7-4's Linux arm);
//   * case-sensitive matching — the `SPECS/*.mdx` vs `specs/A.mdx` probe
//     (7; T7-4);
//   * the dot-segment rule, for `*`, `?`, `**`, captures, and references
//     alike (7; T7-4);
//   * every character outside the grammar is a literal: `[1]`, `{a,c}`,
//     `!`, `+(x)`, `( )`, and `$` in discovery globs (7; T7-4, P-7);
//   * captures: each at most once, one or more bytes, never `/`, never
//     empty; whole-pattern left-to-right shortest-match disambiguation with
//     SPEC.md 7.5's two worked examples; `to` expansion agreement matching
//     captured bytes literally (7.5; T7.5-5);
// plus misuse guards: a `from` repeating a capture and a `to` referencing an
// unvalued capture throw plain errors (harness defects), never diagnosed
// product failures.

import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import {
  captureIndicesIn,
  globMatches,
  matchFromPattern,
  matchToPattern,
} from "../helpers/oracles/glob.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** Build capture values for matchToPattern from a plain record. */
function values(record: Record<number, string>): Map<number, string> {
  return new Map(
    Object.entries(record).map(([index, value]) => [Number(index), value]),
  );
}

/**
 * Assert a from-pattern match: null for a mismatch, otherwise the exact
 * capture assignment (values decoded as UTF-8 text — every vector's captured
 * bytes are ASCII).
 */
function expectCaptures(
  pattern: string,
  path: string,
  expected: Record<number, string> | null,
): void {
  const match = matchFromPattern(pattern, path);
  if (expected === null) {
    expect(match).toBeNull();
    return;
  }
  expect(match).not.toBeNull();
  if (match === null) return; // unreachable: the expect above threw
  const actual: Record<number, string> = {};
  for (const [index, value] of match) {
    actual[index] = Buffer.from(value).toString("utf8");
  }
  expect(actual).toEqual(expected);
}

// --- SPEC.md 7: the glob grammar ---------------------------------------------

test("S-6 (7): `*` matches any possibly empty run of bytes within one path segment", () => {
  expect(globMatches("a*z", "az")).toBe(true); // empty run
  expect(globMatches("a*z", "abcz")).toBe(true);
  expect(globMatches("a*z", "a/z")).toBe(false); // never crosses `/`
  expect(globMatches("src*.ts", "src/a.ts")).toBe(false);
  expect(globMatches("*.mdx", "é.mdx")).toBe(true); // any bytes
});

test("S-6 (7): `?` matches exactly one byte — the é.mdx probe discriminates bytes from characters (T7-4)", () => {
  expect(globMatches("?x", "ax")).toBe(true);
  expect(globMatches("?x", "x")).toBe(false); // never empty
  expect(globMatches("?x", "aax")).toBe(false); // never two bytes
  // "é" is the two bytes 0xC3 0xA9 in UTF-8 (SPEC.md 7: paths match as
  // their UTF-8 bytes).
  expect(globMatches("?.mdx", "é.mdx")).toBe(false);
  expect(globMatches("??.mdx", "é.mdx")).toBe(true);
});

test("S-6 (7): `**` matches any number of whole segments, including none", () => {
  expect(globMatches("a/**/b", "a/b")).toBe(true); // none
  expect(globMatches("a/**/b", "a/x/b")).toBe(true); // one
  expect(globMatches("a/**/b", "a/x/y/b")).toBe(true); // two
  expect(globMatches("a/**/b", "a/b/c")).toBe(false); // only whole trailing match
  expect(globMatches("specs/**", "specs")).toBe(true);
  expect(globMatches("specs/**", "specs/x")).toBe(true);
  expect(globMatches("specs/**", "specs/x/y")).toBe(true);
  expect(globMatches("**/*.mdx", "x.mdx")).toBe(true);
  expect(globMatches("**/*.mdx", "d/e/x.mdx")).toBe(true);
});

test("S-6 (7): `**` is the whole-segments wildcard only as a whole pattern segment", () => {
  // Written inside a larger segment, `**` cannot match "whole segments";
  // it is two adjacent `*` byte runs — the decisions of a single `*`.
  expect(globMatches("a**b", "ab")).toBe(true);
  expect(globMatches("a**b", "aXYb")).toBe(true);
  expect(globMatches("a**b", "a/b")).toBe(false);
});

test("S-6 (7): matching is case-sensitive — the SPECS/specs probe (T7-4)", () => {
  expect(globMatches("SPECS/*.mdx", "specs/A.mdx")).toBe(false);
  expect(globMatches("specs/*.mdx", "specs/A.mdx")).toBe(true);
  expect(globMatches("a.mdx", "A.mdx")).toBe(false);
  expect(globMatches("A.mdx", "A.mdx")).toBe(true);
});

test("S-6 (7): a path segment beginning with `.` is matched only by a pattern segment written with a leading `.`", () => {
  // T7-4: wildcards never match dot-segments.
  expect(globMatches("*", ".hidden")).toBe(false);
  expect(globMatches("?x", ".x")).toBe(false);
  expect(globMatches("a/**/b.mdx", "a/.h/b.mdx")).toBe(false);
  expect(globMatches("a/**/b.mdx", "a/b.mdx")).toBe(true); // control
  expect(globMatches("**", ".h")).toBe(false);
  expect(globMatches("**/x", ".d/x")).toBe(false);
  expect(globMatches("**/x", "d/x")).toBe(true); // control
  expect(globMatches("a/**", "a/.h")).toBe(false);
  // A pattern segment written with a leading `.` does match.
  expect(globMatches(".hidden", ".hidden")).toBe(true);
  expect(globMatches(".*", ".hidden")).toBe(true);
  expect(globMatches(".?", ".x")).toBe(true);
  expect(globMatches(".d/*", ".d/x")).toBe(true);
  // Only the segment's first byte is constrained.
  expect(globMatches("a*", "a.b")).toBe(true);
});

test("S-6 (7): every character outside the grammar is a literal — foreign dialect metacharacters never activate (T7-4, P-7)", () => {
  // Character classes:
  expect(globMatches("a[1].mdx", "a[1].mdx")).toBe(true);
  expect(globMatches("a[1].mdx", "a1.mdx")).toBe(false);
  // Brace expansion:
  expect(globMatches("b{a,c}.mdx", "b{a,c}.mdx")).toBe(true);
  expect(globMatches("b{a,c}.mdx", "ba.mdx")).toBe(false);
  expect(globMatches("b{a,c}.mdx", "bc.mdx")).toBe(false);
  // Negation:
  expect(globMatches("!x", "!x")).toBe(true);
  expect(globMatches("!x", "y")).toBe(false);
  expect(globMatches("!x", "x")).toBe(false);
  // Extglob:
  expect(globMatches("+(x)", "+(x)")).toBe(true);
  expect(globMatches("+(x)", "x")).toBe(false);
  expect(globMatches("+(x)", "xx")).toBe(false);
  expect(globMatches("(a)", "(a)")).toBe(true);
});

test("S-6 (7): `$` is an ordinary literal in discovery globs — capture wildcards exist only in 7.5 selectors", () => {
  expect(globMatches("$1.ts", "$1.ts")).toBe(true);
  expect(globMatches("$1.ts", "a.ts")).toBe(false);
});

test("S-6 (7): matching is byte-wise and total — non-UTF-8 path bytes match by their bytes", () => {
  // 0xFF is no valid UTF-8 byte; the matcher still decides by bytes (a
  // discovered path's UTF-8 validity is the product's 14.19 concern).
  const invalidUtf8 = bytes(0xff, 0x2e, 0x62, 0x69, 0x6e); // 0xFF + ".bin"
  expect(globMatches("*.bin", invalidUtf8)).toBe(true);
  expect(globMatches("?.bin", invalidUtf8)).toBe(true);
  expect(globMatches("??.bin", invalidUtf8)).toBe(false);
});

// --- SPEC.md 7.5: captures ---------------------------------------------------

test("S-6 (7.5): `$1-$2.ts` against `a-b-c.ts` captures $1 = a and $2 = b-c (SPEC.md's example)", () => {
  expectCaptures("$1-$2.ts", "a-b-c.ts", { 1: "a", 2: "b-c" });
});

test("S-6 (7.5): `*$1*` against `abc` captures $1 = a — the leading `*` takes the empty string (SPEC.md's example)", () => {
  expectCaptures("*$1*", "abc", { 1: "a" });
});

test("S-6 (7.5): each element, in pattern order, takes as few bytes as possible while the remainder still matches", () => {
  // $1 = "a" and $1 = "a-" leave no match for the literal "-x", so the
  // capture grows to "a-b" — the least value for which the remainder
  // matches.
  expectCaptures("$1-x", "a-b-x", { 1: "a-b" });
  expectCaptures("$1$2.ts", "ab.ts", { 1: "a", 2: "b" });
  expectCaptures("?$1*", "abc", { 1: "b" });
});

test("S-6 (7.5): capture wildcards are `$1`…`$9` exactly — `$12` is capture 1 then literal 2; `$0` and a bare `$` are literals", () => {
  expectCaptures("$12.ts", "ab2.ts", { 1: "ab" });
  expectCaptures("$0.ts", "$0.ts", {});
  expectCaptures("a$", "a$", {});
});

test("S-6 (7.5): a capture never matches the empty string", () => {
  expectCaptures("a$1", "a", null);
  expectCaptures("$1x", "x", null);
  expect(globMatches("a*", "a")).toBe(true); // the contrast with `*`
});

test("S-6 (7.5): a capture never matches `/` — one or more bytes within a single path segment", () => {
  expectCaptures("$1.ts", "a/b.ts", null);
  expectCaptures("a$1b", "a/b", null);
  expectCaptures("**/$1.ts", "a/b.ts", { 1: "b" });
});

test("S-6 (7.5): disambiguation spans the whole pattern — a `**` before a capture takes as few segments as a match allows", () => {
  expectCaptures("**/$1.mdx", "a/b/c.mdx", { 1: "c" });
});

test("S-6 (7.5): the dot-segment rule binds capture segments as written", () => {
  expectCaptures("$1", ".x", null);
  expectCaptures(".$1", ".x", { 1: "x" });
  // Mid-segment, a captured value may itself begin with `.`.
  expectCaptures("a$1", "a.x", { 1: ".x" });
});

test("S-6 (7.5): a from-pattern without captures reports an empty assignment on match, null on mismatch", () => {
  expectCaptures("*.ts", "a.ts", {});
  expectCaptures("*.ts", "a.md", null);
});

test("S-6 (7.5): capture matching is deterministic — repeated runs yield identical assignments, keyed in ascending index order", () => {
  const first = matchFromPattern("$2-$1.ts", "a-b.ts");
  const second = matchFromPattern("$2-$1.ts", "a-b.ts");
  expect(first).toEqual(second);
  expect(first).not.toBeNull();
  if (first === null) return; // unreachable: the expect above threw
  expect([...first.keys()]).toEqual([1, 2]);
  expectCaptures("$2-$1.ts", "a-b.ts", { 1: "b", 2: "a" });
});

// --- SPEC.md 7.5: `to` patterns ----------------------------------------------

test("S-6 (7.5): a `to` pattern matches only targets whose expansion agrees with the captured values", () => {
  // The mirror-structure policy shape of T7.5-5: from "src/$1.ts", to
  // "specs/$1.mdx".
  expectCaptures("src/$1.ts", "src/auth.ts", { 1: "auth" });
  expect(
    matchToPattern("specs/$1.mdx", "specs/auth.mdx", values({ 1: "auth" })),
  ).toBe(true);
  expect(
    matchToPattern("specs/$1.mdx", "specs/login.mdx", values({ 1: "auth" })),
  ).toBe(false);
  expect(matchToPattern("$1.md", "a.md", values({ 1: "a" }))).toBe(true);
  expect(matchToPattern("$1.md", "b.md", values({ 1: "a" }))).toBe(false);
});

test("S-6 (7.5): captured bytes are matched literally in `to` — never reinterpreted as metacharacters", () => {
  expectCaptures("$1.ts", "a*b.ts", { 1: "a*b" });
  expect(matchToPattern("$1.md", "a*b.md", values({ 1: "a*b" }))).toBe(true);
  expect(matchToPattern("$1.md", "axb.md", values({ 1: "a*b" }))).toBe(false);
});

test("S-6 (7.5): a `to` may reference a capture more than once and mix references with wildcards", () => {
  expect(matchToPattern("$1/$1.md", "a/a.md", values({ 1: "a" }))).toBe(true);
  expect(matchToPattern("$1/$1.md", "a/b.md", values({ 1: "a" }))).toBe(false);
  expect(matchToPattern("**/$1.mdx", "p/q/a.mdx", values({ 1: "a" }))).toBe(
    true,
  );
});

test("S-6 (7.5): a `to` reference obeys the dot rule as written, whatever bytes it carries", () => {
  expect(matchToPattern("$1", ".x", values({ 1: ".x" }))).toBe(false);
  expect(matchToPattern("x$1", "x.y", values({ 1: ".y" }))).toBe(true);
});

test("S-6 (7.5): matchToPattern accepts captured values as bytes — matchFromPattern's own output shape", () => {
  const match = matchFromPattern("$1.ts", "auth.ts");
  expect(match).not.toBeNull();
  if (match === null) return; // unreachable: the expect above threw
  expect(matchToPattern("$1.mdx", "auth.mdx", match)).toBe(true);
  expect(matchToPattern("$1.mdx", "other.mdx", match)).toBe(false);
});

// --- helpers and misuse guards -----------------------------------------------

test("S-6 (7.5): captureIndicesIn reports the written capture indices, ascending", () => {
  expect([...captureIndicesIn("$1-$2.ts")]).toEqual([1, 2]);
  expect([...captureIndicesIn("$2-$1.ts")]).toEqual([1, 2]);
  expect([...captureIndicesIn("$0a$x$")]).toEqual([]);
  expect([...captureIndicesIn("**/x$3*")]).toEqual([3]);
});

test("S-6: a `from` pattern repeating a capture index is oracle misuse and throws", () => {
  expect(() => matchFromPattern("$1$1.ts", "ab.ts")).toThrow(/oracle misuse/);
  expect(() => matchFromPattern("$1/x/$1", "a/x/a")).toThrow(/oracle misuse/);
});

test("S-6: a `to` pattern referencing an unvalued capture is oracle misuse and throws", () => {
  expect(() => matchToPattern("$1.md", "a.md", new Map())).toThrow(
    /oracle misuse/,
  );
  expect(() => matchToPattern("$2.md", "a.md", values({ 1: "a" }))).toThrow(
    /oracle misuse/,
  );
});
