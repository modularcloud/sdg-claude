// S-6 Markdown-oracle vectors (TEST-SPEC 17 S-6): the in-harness Markdown-
// compilation oracle for P-2 (test/helpers/oracles/markdown.ts) passes this
// fixed vector suite, derived from SPEC.md 3's examples and rules, before
// any property test trusts it. Every vector's expected output is a
// hand-computed string; no product is involved (the product's own SPEC.md 3
// behavior is asserted by the suite's T3-1…T3-6 tests against fixtures, not
// against this oracle).
//
// Coverage, by the rules the vectors derive from (TEST-SPEC 3 restatements
// in parentheses):
//   * removals of imports, tags with all their props, and comments; byte
//     preservation of everything else (T3-1);
//   * text(...) replacement, fully expanded through chains, expansions
//     inserted verbatim (T3-2);
//   * the line-drop rule with all counter-cases, the 1.4 class boundaries —
//     U+00A0/U+0085/U+2028 neither whitespace nor terminators — and
//     multi-line-construct merging (T3-3);
//   * CRLF / lone LF / lone CR each one terminator; the final line never
//     gains one (T3-4);
//   * in-line tags are transparent annotations (T3-5; SPEC.md 3's own
//     example);
// plus misuse guards: degenerate construct pieces and bad spans throw plain
// errors (harness defects), never diagnosed product failures.

import { expect, test } from "vitest";
import {
  compileMarkdown,
  compileMarkdownSource,
  isSpecWhitespace,
  sourceTextOf,
} from "../helpers/oracles/markdown.js";
import type { MarkdownPiece } from "../helpers/oracles/markdown.js";

const content = (text: string): MarkdownPiece => ({ kind: "content", text });
const removal = (text: string): MarkdownPiece => ({ kind: "removal", text });
const embedding = (text: string, expansion: string): MarkdownPiece => ({
  kind: "embedding",
  text,
  expansion,
});

/** Compare compiled output exactly, with escapes visible in failures. */
function expectCompiled(
  pieces: readonly MarkdownPiece[],
  expected: string,
): void {
  expect(JSON.stringify(compileMarkdown(pieces))).toBe(
    JSON.stringify(expected),
  );
}

// --- 1.4 character classes ---------------------------------------------------

test("S-6 (1.4): whitespace is exactly U+0009 U+000A U+000B U+000C U+000D U+0020, and no other code point", () => {
  for (const code of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) {
    expect(isSpecWhitespace(code)).toBe(true);
  }
  for (const code of [0x00a0, 0x0085, 0x2028, 0x08, 0x1f, 0x7f, 0x41, 0x2029]) {
    expect(isSpecWhitespace(code)).toBe(false);
  }
});

// --- removals and preservation (T3-1) ---------------------------------------

test("S-6 (T3-1): a spec module import is deleted and its emptied line drops with its terminator", () => {
  expectCompiled(
    [
      removal('import BASE from "./BASE.xspec"'),
      content("\n# Title\n\nBody.\n"),
    ],
    "# Title\n\nBody.\n",
  );
});

test("S-6 (T3-1): <S>/<Spec> tags are deleted together with all their props", () => {
  expectCompiled(
    [
      removal(
        '<Spec id="root.alpha" d={[BASE.auth.login, "local.req"]} coverage="none" tags="negative temporal">',
      ),
      content("\nAlpha.\n"),
      removal("</Spec>"),
      content("\n"),
    ],
    "Alpha.\n",
  );
});

test("S-6 (T3-1): tables, code fences, trailing spaces, and blank lines are preserved byte-for-byte", () => {
  const body =
    "| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nconst x = 1;  \n```\ntrailing  \n";
  expectCompiled(
    [
      removal('<S id="t">'),
      content(`\n${body}`),
      removal("</S>"),
      content("\n"),
    ],
    body,
  );
});

test("S-6 (T3-1): a document without constructs compiles to itself, final terminator-less line included", () => {
  expectCompiled([content("plain\ntext  \n\nend ")], "plain\ntext  \n\nend ");
});

// --- replacement (T3-2) ------------------------------------------------------

test("S-6 (T3-2): a text(...) expression is replaced by its expansion at its position", () => {
  expectCompiled(
    [
      content("Intro: "),
      embedding('{text("local.req")}', "Requirement text."),
      content("\n"),
    ],
    "Intro: Requirement text.\n",
  );
});

test("S-6 (T3-2): chained embeddings expand fully, bottom-up", () => {
  // A embeds B embeds C: each stage's expansion is the previous stage's
  // compiled output — the oracle's caller expands chains bottom-up.
  const compiledC = compileMarkdown([
    removal('<S id="c">'),
    content("Core."),
    removal("</S>"),
  ]);
  expect(compiledC).toBe("Core.");
  const compiledB = compileMarkdown([
    removal('<S id="b">'),
    content("B: "),
    embedding("{text(C.c)}", compiledC),
    removal("</S>"),
  ]);
  expect(compiledB).toBe("B: Core.");
  expectCompiled(
    [content("A> "), embedding("{text(B.b)}", compiledB), content("\n")],
    "A> B: Core.\n",
  );
});

test("S-6 (T3-2): a multi-line expansion is inserted verbatim", () => {
  expectCompiled(
    [content("> "), embedding("{text(X.x)}", "L1\nL2"), content(" <\n")],
    "> L1\nL2 <\n",
  );
});

test("S-6 (T3-2): an expansion's trailing terminator and the source line's own terminator both survive", () => {
  // Exact textual replacement: expansion "Core.\n" on its own source line
  // yields the expansion's terminator followed by the line's terminator.
  expectCompiled(
    [content("a\n"), embedding("{text(X.x)}", "Core.\n"), content("\nb\n")],
    "a\nCore.\n\nb\n",
  );
});

// --- line-drop rule (T3-3) ---------------------------------------------------

test("S-6 (T3-3): a line holding only a removed construct, or only a text(...) whose expansion is empty, drops with its terminator", () => {
  const constructsAloneOnALine: MarkdownPiece[] = [
    removal('import BASE from "./BASE.xspec"'),
    removal('<S id="a">'),
    removal("</S>"),
    removal("{/* only a comment */}"),
    embedding('{text("gone")}', ""),
  ];
  for (const construct of constructsAloneOnALine) {
    expectCompiled(
      [content("before\n"), construct, content("\nafter\n")],
      "before\nafter\n",
    );
  }
});

test("S-6 (T3-3): lines already empty or whitespace-only in the source are kept exactly", () => {
  // No construct touches the blank line or the " \t " line, so neither
  // "contained non-whitespace in the source": both are kept. The trailing
  // construct-only line (terminator-less) drops without gaining bytes.
  expectCompiled(
    [content("a\n\n \t \nb\n"), removal("{/* tail */}")],
    "a\n\n \t \nb\n",
  );
});

test("S-6 (T3-3): a removal-affected line that retains other content keeps its residue and terminator", () => {
  expectCompiled(
    [content("x "), removal("{/* c */}"), content("\ny\n")],
    "x \ny\n",
  );
});

test("S-6 (T3-3): a line left whitespace-only purely by an empty expansion drops, surrounding source whitespace included", () => {
  expectCompiled(
    [content("a\n  "), embedding('{text("gone")}', ""), content("  \nb\n")],
    "a\nb\n",
  );
});

test("S-6 (T3-3): a whitespace-only but non-empty expansion keeps its line, expansion and terminator included", () => {
  // Neither drop cause applies: the line is not left whitespace-only purely
  // by removals, and the expansion is not empty (T3-3's discriminating arm).
  expectCompiled(
    [content("a\n"), embedding('{text("ws")}', " "), content("\nb\n")],
    "a\n \nb\n",
  );
});

test("S-6 (T3-3): a non-empty expansion keeps its whole logical line even when an empty expansion shares it", () => {
  // The line is not left anything "purely" by the empty expansion: a
  // non-empty expansion contributed, so the line is kept in full.
  expectCompiled(
    [
      content("a\n"),
      embedding("{text(P.p)}", "X\n"),
      embedding('{text("gone")}', ""),
      content("\nb\n"),
    ],
    "a\nX\n\nb\n",
  );
});

test("S-6 (T3-3): U+00A0, U+0085, and U+2028 are not whitespace — a line left holding only them is kept", () => {
  for (const codePoint of ["\u00a0", "\u0085", "\u2028"]) {
    expectCompiled(
      [content("a\n"), removal("{/* c */}"), content(`${codePoint}\nb\n`)],
      `a\n${codePoint}\nb\n`,
    );
  }
});

test("S-6 (T3-3): a line left holding only U+0009 or U+0020 drops — those are whitespace", () => {
  for (const residue of ["\t", " ", "\t "]) {
    expectCompiled(
      [content("a\n"), removal("{/* c */}"), content(`${residue}\nb\n`)],
      "a\nb\n",
    );
  }
});

test("S-6 (T3-3): U+0085 and U+2028 are not line terminators", () => {
  // If either code point ended a line, the construct's "line" would drop as
  // construct-only and the tab would survive on a source-whitespace-only
  // line ("\t\n"); if either were whitespace, the whole line would drop.
  for (const codePoint of ["\u0085", "\u2028"]) {
    expectCompiled(
      [removal("{/* c */}"), content(`${codePoint}\t\n`)],
      `${codePoint}\t\n`,
    );
  }
});

test("S-6 (T3-3): deleting a multi-line construct merges the surrounding residues into one line", () => {
  // TEST-SPEC T3-3's example: "foo {/* …" / "… */} bar" compiles to
  // "foo  bar" (two spaces) on one line.
  expectCompiled(
    [
      content("foo "),
      removal("{/* first\nsecond */}"),
      content(" bar\nnext\n"),
    ],
    "foo  bar\nnext\n",
  );
});

test("S-6 (T3-3): an own-lines multi-line comment leaves the merged line empty purely by removals, and it drops", () => {
  expectCompiled(
    [content("para\n"), removal("{/* line1\nline2 */}"), content("\nnext\n")],
    "para\nnext\n",
  );
});

// --- line terminators (T3-4) -------------------------------------------------

test("S-6 (T3-4): CRLF is one terminator — a dropped line consumes both bytes, a kept line keeps both", () => {
  expectCompiled(
    [removal('<S id="a">'), content("\r\nAlpha\r\n"), removal("</S>")],
    "Alpha\r\n",
  );
});

test("S-6 (T3-4): a lone CR is one terminator", () => {
  expectCompiled([removal("{/* c */}"), content("\rkeep\r")], "keep\r");
});

test("S-6 (T3-4): mixed terminators are preserved byte-for-byte on kept lines", () => {
  expectCompiled(
    [content("a\nb\r\nc\rd\n"), removal("{/* tail */}")],
    "a\nb\r\nc\rd\n",
  );
});

test("S-6 (T3-4): a final line without a terminator survives compilation without gaining one", () => {
  expectCompiled(
    [content("kept "), removal("{/* c */}"), content(" tail")],
    "kept  tail",
  );
});

test("S-6 (T3-4): a CR immediately before a construct is a lone terminator — the construct's characters intervene before any LF", () => {
  // Source: "a\r{/* c */}\nb\n" — the CR ends line one (lone CR), the LF
  // ends the construct-only line two (which drops with exactly that LF).
  expectCompiled(
    [content("a\r"), removal("{/* c */}"), content("\nb\n")],
    "a\rb\n",
  );
});

test("S-6 (T3-4): adjacent content pieces are one source text — a CRLF split across pieces is one terminator", () => {
  // The dropped construct-only line's terminator is the CRLF pair split
  // across the two content pieces; both bytes go with the dropped line.
  expectCompiled(
    [content("a\n"), removal("{/* c */}"), content("\r"), content("\nb")],
    "a\nb",
  );
});

// --- in-line tags (T3-5; SPEC.md 3's example) --------------------------------

test('S-6 (T3-5): <S id="a">Example:</S><S id="b">1. A</S> strips to Example:1. A', () => {
  const pieces = [
    removal('<S id="a">'),
    content("Example:"),
    removal("</S>"),
    removal('<S id="b">'),
    content("1. A"),
    removal("</S>"),
  ];
  expect(sourceTextOf(pieces)).toBe('<S id="a">Example:</S><S id="b">1. A</S>');
  expectCompiled(pieces, "Example:1. A");
});

// --- trivial documents -------------------------------------------------------

test("S-6: empty and construct-only documents compile to empty output", () => {
  expectCompiled([], "");
  expectCompiled([removal("{/* c */}")], "");
  expectCompiled([embedding('{text("gone")}', "")], "");
  expectCompiled([embedding("{text(X.x)}", "X")], "X");
});

// --- the span-based entry point ----------------------------------------------

test("S-6: compileMarkdownSource compiles spans identically to the piece form", () => {
  const inlineTags = '<S id="a">Example:</S><S id="b">1. A</S>';
  expect(
    compileMarkdownSource(inlineTags, [
      { kind: "removal", start: 0, end: 10 },
      { kind: "removal", start: 18, end: 22 },
      { kind: "removal", start: 22, end: 32 },
      { kind: "removal", start: 36, end: 40 },
    ]),
  ).toBe("Example:1. A");

  const embedded = 'pre {text("x")} post';
  expect(
    compileMarkdownSource(embedded, [
      { kind: "embedding", start: 4, end: 15, expansion: "X\nY" },
    ]),
  ).toBe("pre X\nY post");
});

test("S-6: misordered, overlapping, empty, or out-of-bounds spans are oracle misuse and throw", () => {
  const source = "abcdefghij";
  const cases = [
    [
      { kind: "removal", start: 0, end: 5 },
      { kind: "removal", start: 3, end: 7 },
    ], // overlapping
    [
      { kind: "removal", start: 5, end: 7 },
      { kind: "removal", start: 0, end: 3 },
    ], // out of order
    [{ kind: "removal", start: 3, end: 3 }], // empty
    [{ kind: "removal", start: 0, end: 999 }], // out of bounds
    [{ kind: "removal", start: 0.5, end: 3 }], // non-integer
  ] as const;
  for (const spans of cases) {
    expect(() => compileMarkdownSource(source, [...spans])).toThrow(
      /oracle misuse/,
    );
  }
});

test("S-6: a construct piece with empty or whitespace-only own characters is oracle misuse and throws", () => {
  expect(() => compileMarkdown([removal("")])).toThrow(/oracle misuse/);
  expect(() => compileMarkdown([removal("  ")])).toThrow(/oracle misuse/);
  expect(() => compileMarkdown([embedding(" ", "x")])).toThrow(/oracle misuse/);
});
