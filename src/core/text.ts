// Character classes and the line model.
//
// SPEC 1.4 defines the whitespace and control-character classes exactly, and
// they apply throughout the specification: ID segment and tag rules (1.4),
// tag splitting (2.6), and line dropping (3) all use these definitions.
// SPEC 3 defines line terminators and lines for Markdown compilation and for
// every rule that drops or preserves lines.

/**
 * SPEC 1.4: whitespace means exactly U+0009 (tab), U+000A (line feed),
 * U+000B (vertical tab), U+000C (form feed), U+000D (carriage return), and
 * U+0020 (space). No other code point (U+00A0, U+0085, and U+2028 included)
 * belongs to the class.
 */
export function isWhitespaceCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x09 && codePoint <= 0x0d) || codePoint === 0x20;
}

/**
 * SPEC 1.4: control characters means exactly U+0000–U+001F and U+007F. No
 * other code point belongs to the class.
 */
export function isControlCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x00 && codePoint <= 0x1f) || codePoint === 0x7f;
}

/**
 * True when every character of `text` is SPEC 1.4 whitespace; true for the
 * empty string. This is the "empty or whitespace-only" test of the SPEC 3
 * line-drop rule.
 */
export function isWhitespaceOnly(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    // All whitespace characters are single UTF-16 code units, so a code-unit
    // scan is exact: any surrogate half fails the predicate, as it should.
    if (!isWhitespaceCodePoint(text.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

/** True when `text` contains at least one SPEC 1.4 whitespace character. */
export function containsWhitespace(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isWhitespaceCodePoint(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

/** True when `text` contains at least one SPEC 1.4 control character. */
export function containsControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isControlCodePoint(text.charCodeAt(index))) {
      return true;
    }
  }
  return false;
}

/**
 * SPEC 1.4: the five forbidden segment (and tag) names. Shared by MDX prop
 * validation (mdx.ts) and journal-entry validation (journal.ts).
 */
export const FORBIDDEN_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  "$",
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

/** A SPEC 3 line terminator: CRLF (one terminator), lone LF, or lone CR. */
export type LineTerminator = "\r\n" | "\n" | "\r";

/**
 * One line under the SPEC 3 line model: a maximal terminator-free run of
 * characters plus the terminator that ends it; the final line MAY have no
 * terminator (terminator `""`). Indices are UTF-16 code-unit offsets into
 * the split text: content = text.slice(start, contentEnd) and
 * terminator = text.slice(contentEnd, end).
 */
export interface Line {
  readonly content: string;
  readonly terminator: LineTerminator | "";
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
}

/**
 * Splits `text` into SPEC 3 lines. A line terminator is the sequence U+000D
 * U+000A (one terminator), a U+000A not preceded by U+000D, or a U+000D not
 * followed by U+000A. The concatenation of every line's content and
 * terminator restores `text` exactly; empty text yields no lines, and text
 * not ending in a terminator yields a final line with terminator `""`.
 */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      const terminator: LineTerminator =
        index + 1 < text.length && text.charCodeAt(index + 1) === 0x0a
          ? "\r\n"
          : "\r";
      const end = index + terminator.length;
      lines.push({
        content: text.slice(start, index),
        terminator,
        start,
        contentEnd: index,
        end,
      });
      start = end;
      index = end;
    } else if (code === 0x0a) {
      // A preceding U+000D would have consumed this U+000A as CRLF, so this
      // is a U+000A not preceded by U+000D: a lone-LF terminator.
      lines.push({
        content: text.slice(start, index),
        terminator: "\n",
        start,
        contentEnd: index,
        end: index + 1,
      });
      start = index + 1;
      index = start;
    } else {
      index += 1;
    }
  }
  if (start < text.length) {
    lines.push({
      content: text.slice(start),
      terminator: "",
      start,
      contentEnd: text.length,
      end: text.length,
    });
  }
  return lines;
}
