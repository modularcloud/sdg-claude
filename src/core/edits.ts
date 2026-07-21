// Minimal in-place source edits (SPEC 6.4, 6.5) — the shared machinery of
// the rename and move rewrite plans.
//
// SPEC 6.4/6.5: rewrites are minimal in-place edits — each affected part is
// replaced within its recorded byte range, and every byte outside the
// affected parts is preserved verbatim. This module is pure (IMPLEMENTATION
// Architecture): edits are values applied to source bytes; the derivations
// that produce them live in ./rename.ts and ./move.ts.

import type { ByteRange } from "./bytes.js";

/** One in-place edit: replace the bytes of `range` with `replacement`. */
export interface SourceEdit {
  readonly range: ByteRange;
  readonly replacement: string;
}

/** One rewritten source file: its path and complete new content bytes. */
export interface SourceRewrite {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** The file's complete rewritten bytes (SPEC 6.4/6.5: edits applied). */
  readonly content: Uint8Array;
}

const encoder = new TextEncoder();

/**
 * Apply non-overlapping edits to a file's bytes (SPEC 6.4, 6.5: minimal
 * in-place edits — every byte outside the edited ranges is preserved
 * verbatim).
 */
export function applyEdits(
  bytes: Uint8Array,
  edits: readonly SourceEdit[],
): Uint8Array {
  const ordered = [...edits].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.range.start < cursor || edit.range.end > bytes.length) {
      throw new Error(
        "xspec internal error: overlapping or out-of-range source edits",
      );
    }
    parts.push(bytes.subarray(cursor, edit.range.start));
    parts.push(encoder.encode(edit.replacement));
    cursor = edit.range.end;
  }
  parts.push(bytes.subarray(cursor));
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Collects per-file edits, keyed by workspace-relative path. */
export class EditCollector {
  private readonly editsByPath = new Map<string, SourceEdit[]>();

  add(path: string, edit: SourceEdit): void {
    let edits = this.editsByPath.get(path);
    if (edits === undefined) {
      edits = [];
      this.editsByPath.set(path, edits);
    }
    edits.push(edit);
  }

  editsFor(path: string): readonly SourceEdit[] | undefined {
    return this.editsByPath.get(path);
  }
}

/**
 * A JavaScript string literal holding exactly `value`, written with `quote`
 * (SPEC 6.4: quote style preserved; the fallback form is double-quoted).
 * Only the quote character and the backslash need escaping: the rewritten
 * values — ID segments (SPEC 1.4) and workspace-relative import specifiers
 * (SPEC 2.1) — contain no characters whose escape sequence differs, and the
 * literal re-parses to `value`.
 */
export function jsStringLiteral(value: string, quote: '"' | "'"): string {
  let escaped = "";
  for (const character of value) {
    escaped +=
      character === "\\" || character === quote ? `\\${character}` : character;
  }
  return `${quote}${escaped}${quote}`;
}

/**
 * The characters of a quoted MDX attribute value holding exactly `value`
 * under `quote` (SPEC 2.7: quoted attribute form; SPEC 6.4: the quote style
 * is preserved). MDX decodes character references in attribute values, so
 * `&` and the quote character are written as character references — every
 * other character is written verbatim — and the attribute re-parses to
 * exactly `value`.
 */
export function attributeValueText(value: string, quote: '"' | "'"): string {
  let encoded = "";
  for (const character of value) {
    if (character === "&") {
      encoded += "&amp;";
    } else if (character === quote) {
      encoded += quote === '"' ? "&quot;" : "&#x27;";
    } else {
      encoded += character;
    }
  }
  return encoded;
}
