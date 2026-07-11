// In-harness Markdown-compilation oracle (TEST-SPEC 16 P-2, 17 S-6): an
// independent implementation of the removal / replacement / line-drop /
// line-terminator rules of SPEC.md 3 (with the character classes of SPEC.md
// 1.4), used to compute the expected compiled output for the P-2 property
// tests. Per S-6, the oracle passes its fixed vector suite
// (test/self/s6-markdown-oracle.test.ts), derived from SPEC.md 3's examples
// and rules, before any property test trusts it. Harness machinery only:
// pure functions, no product imports, no I/O, no test-framework dependence.
//
// The oracle does not parse MDX. Its callers — the P-2 document generator,
// the S-6 vectors, a CERTIFICATIONS.md CONF-MD fixture sharing this logic —
// construct their documents, so they know exactly where every construct
// sits; the input is the source text segmented into pieces (or the whole
// text plus construct spans, `compileMarkdownSource`). Feeding the oracle
// the caller's own structure rather than a parse of the source is what keeps
// it independent of the product (P-2: "an independent oracle ... the oracle
// lives in the harness").
//
// SPEC.md 3, as implemented here:
//
// * Compilation removes spec module imports, `<S>`/`<Spec>` tags together
//   with their props, and MDX comments (`kind: "removal"`), and replaces
//   each `text(...)` expression with the target's compiled subtree text,
//   fully expanded (`kind: "embedding"` — the caller computes the expansion,
//   expanding chains bottom-up before invoking the oracle). All other
//   Markdown content and author whitespace is preserved.
// * Removal is exact textual deletion of the construct's own characters, in
//   place. A construct whose own characters include a line terminator (a
//   multi-line MDX comment) merges the surrounding lines' residues into one
//   logical line when deleted.
// * A line terminator is U+000D U+000A (one terminator), a U+000A not
//   preceded by U+000D, or a U+000D not followed by U+000A; a line is a
//   maximal terminator-free run plus the terminator that ends it, and the
//   final line may have no terminator. Only terminators in plain content end
//   logical lines: terminators inside a construct's own characters are
//   deleted with the construct, and terminators inside an expansion are
//   inserted bytes of the logical line the expansion landed on, not line
//   breaks of the source document.
// * Drop rule: a logical line that contained non-whitespace (1.4) in the
//   source — surviving residues and deleted construct characters alike — but
//   is left empty or whitespace-only purely by removals (or by a `text(...)`
//   replacement whose expansion is empty) is dropped together with its line
//   terminator, if any. Every other line keeps its remaining content and
//   terminator; in particular, a logical line any non-empty expansion
//   contributed to is never dropped, even when the result is
//   whitespace-only: a non-empty expansion is not a removal, so the line is
//   not left whitespace-only "purely by removals" (TEST-SPEC T3-3's
//   single-space-expansion arm).
// * Whitespace means exactly U+0009, U+000A, U+000B, U+000C, U+000D, and
//   U+0020, and control characters exactly U+0000–U+001F and U+007F; no
//   other code point belongs to either class — U+00A0, U+0085, and U+2028
//   are neither whitespace nor line terminators (SPEC.md 1.4; TEST-SPEC
//   T3-3 class boundaries).

/**
 * One segment of a source document, in document order. The document's source
 * text is the concatenation of every piece's `text` (`sourceTextOf`).
 */
export type MarkdownPiece =
  | {
      /** Plain source content: preserved, subject only to the drop rule. */
      kind: "content";
      text: string;
    }
  | {
      /**
       * A removed construct's own characters — a spec module import, an
       * `<S>`/`<Spec>` opening, closing, or self-closing tag together with
       * its props, or an MDX comment (SPEC.md 3).
       */
      kind: "removal";
      text: string;
    }
  | {
      /**
       * A `text(...)` expression: `text` is the expression's own characters
       * (the braced container included), `expansion` the target's compiled
       * subtree text, fully expanded by the caller (SPEC.md 3, 1.6).
       */
      kind: "embedding";
      text: string;
      expansion: string;
    };

/** A construct located by string indices into a whole source text. */
export type MarkdownConstructSpan =
  | { kind: "removal"; start: number; end: number }
  | { kind: "embedding"; start: number; end: number; expansion: string };

/**
 * SPEC.md 1.4: whitespace means exactly U+0009, U+000A, U+000B, U+000C,
 * U+000D, and U+0020 — no other code point (U+00A0, U+0085, and U+2028
 * included). Tag splitting (2.6) and line dropping (3) use this definition.
 */
export function isSpecWhitespace(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x20
  );
}

/**
 * True when `text` is empty or consists only of 1.4 whitespace. Iterating
 * UTF-16 code units is exact here: every 1.4 whitespace character is a
 * single BMP code unit, and each half of a surrogate pair is outside the
 * class, so any astral code point correctly counts as non-whitespace.
 */
function isWhitespaceOnly(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!isSpecWhitespace(text.charCodeAt(i))) return false;
  }
  return true;
}

/** The source text a piece list describes: the concatenation of all `text`. */
export function sourceTextOf(pieces: readonly MarkdownPiece[]): string {
  return pieces.map((piece) => piece.text).join("");
}

/**
 * Compile a source document to its pure Markdown output per SPEC.md 3.
 * Deterministic and pure; misuse (a construct piece with empty or
 * whitespace-only own characters, which no SPEC.md 3 construct can have)
 * throws a plain Error — a harness defect, never a diagnosed product
 * failure.
 */
export function compileMarkdown(pieces: readonly MarkdownPiece[]): string {
  for (const piece of pieces) {
    if (piece.kind !== "content" && isWhitespaceOnly(piece.text)) {
      throw new Error(
        `markdown oracle misuse: the own characters of a ${piece.kind} construct always contain non-whitespace (SPEC.md 3 knows no empty or whitespace-only construct); got ${JSON.stringify(piece.text)}`,
      );
    }
  }

  const output: string[] = [];

  // State of the current logical line: the run of source characters up to
  // the next terminator occurring in plain content. Terminators inside a
  // construct's own characters are deleted with the construct, merging the
  // surrounding source lines into one logical line (SPEC.md 3, multi-line
  // constructs).
  let survivors: string[] = []; // what remains: content residues, expansions
  let sourceHadNonWhitespace = false; // over all source characters of the line
  let expansionContributed = false; // a non-empty expansion landed on the line

  // Close the logical line at `terminator` ("" at end of input): drop the
  // line together with its terminator when SPEC.md 3's rule says so, emit
  // its remaining content and terminator otherwise.
  const finalizeLine = (terminator: string): void => {
    const remaining = survivors.join("");
    const dropped =
      sourceHadNonWhitespace &&
      !expansionContributed &&
      isWhitespaceOnly(remaining); // left empty or whitespace-only
    if (!dropped) output.push(remaining, terminator);
    survivors = [];
    sourceHadNonWhitespace = false;
    expansionContributed = false;
  };

  const consumeSourceChunk = (chunk: string): void => {
    if (chunk.length === 0) return;
    survivors.push(chunk);
    if (!isWhitespaceOnly(chunk)) sourceHadNonWhitespace = true;
  };

  for (const piece of coalesceContent(pieces)) {
    if (piece.kind === "content") {
      const text = piece.text;
      let start = 0;
      let i = 0;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code !== 0x0a && code !== 0x0d) {
          i += 1;
          continue;
        }
        // A line terminator: U+000D U+000A as one terminator, else a lone
        // LF / lone CR. A CR that ends the piece is a lone CR: adjacent
        // content pieces were coalesced, so the next source character (if
        // any) is a construct's first own character — never the LF of a
        // CRLF pair.
        const terminator =
          code === 0x0d && text.charCodeAt(i + 1) === 0x0a ? "\r\n" : text[i];
        consumeSourceChunk(text.slice(start, i));
        finalizeLine(terminator);
        i += terminator.length;
        start = i;
      }
      consumeSourceChunk(text.slice(start));
    } else {
      // The construct's own characters are source characters of the current
      // logical line: their non-whitespace counts for "contained
      // non-whitespace in the source" (and the guard above makes that
      // invariant for every real construct). They are deleted — internal
      // terminators included.
      if (!isWhitespaceOnly(piece.text)) sourceHadNonWhitespace = true;
      if (piece.kind === "embedding" && piece.expansion.length > 0) {
        // Replacement: the expansion's bytes — internal terminators
        // included — join this logical line's survivors verbatim, and a
        // non-empty expansion keeps the line (it is not a removal).
        survivors.push(piece.expansion);
        expansionContributed = true;
      }
    }
  }

  // The final line may have no terminator (SPEC.md 3); it is kept or
  // dropped like any other and never gains one. When the input ended at a
  // terminator, the fresh state appends nothing here.
  finalizeLine("");
  return output.join("");
}

/**
 * Compile from a whole source text plus construct spans — the shape a
 * parser-holding caller naturally has. `start`/`end` are string indices
 * (start-inclusive, end-exclusive); spans must be non-empty, in bounds, in
 * document order, and non-overlapping, or the call throws (oracle misuse is
 * a harness defect).
 */
export function compileMarkdownSource(
  source: string,
  constructs: readonly MarkdownConstructSpan[],
): string {
  const pieces: MarkdownPiece[] = [];
  let cursor = 0;
  constructs.forEach((span, index) => {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < cursor ||
      span.end <= span.start ||
      span.end > source.length
    ) {
      throw new Error(
        `markdown oracle misuse: construct span ${String(index)} [${String(span.start)}, ${String(span.end)}) must be non-empty, in bounds, in document order, and non-overlapping (previous construct ended at ${String(cursor)}; source length ${String(source.length)})`,
      );
    }
    pieces.push({ kind: "content", text: source.slice(cursor, span.start) });
    const text = source.slice(span.start, span.end);
    pieces.push(
      span.kind === "removal"
        ? { kind: "removal", text }
        : { kind: "embedding", text, expansion: span.expansion },
    );
    cursor = span.end;
  });
  pieces.push({ kind: "content", text: source.slice(cursor) });
  return compileMarkdown(pieces);
}

/**
 * Merge adjacent content pieces (dropping empty ones) so terminator scanning
 * sees the source's real adjacency — a CRLF pair split across two content
 * pieces is one terminator, exactly as it is one terminator in the source.
 */
function coalesceContent(pieces: readonly MarkdownPiece[]): MarkdownPiece[] {
  const result: MarkdownPiece[] = [];
  for (const piece of pieces) {
    if (piece.kind === "content") {
      if (piece.text.length === 0) continue;
      const last = result[result.length - 1];
      if (last !== undefined && last.kind === "content") {
        result[result.length - 1] = {
          kind: "content",
          text: last.text + piece.text,
        };
        continue;
      }
    }
    result.push(piece);
  }
  return result;
}
