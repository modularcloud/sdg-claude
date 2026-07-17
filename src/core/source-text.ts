// Source-file decoding (SPEC 1.6 → 14.20).
//
// SPEC 1.6: source files are UTF-8 — a discovered spec or code source that
// is not valid UTF-8 or that begins with a byte-order mark is unparseable
// (14.20), and text values are the decoded content. This module is the one
// place that turns discovered source bytes into decoded text, shared by the
// MDX model (spec sources) and the TypeScript analysis (code sources); the
// 14.20 finding it produces reports the location of the failure (SPEC 14.20)
// as a byte offset into the file.

import type { Finding } from "./findings.js";

/** Decoder for byte sequences already validated by `firstInvalidUtf8`. */
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The byte offset of the first position at which `bytes` fails to be valid
 * UTF-8 (RFC 3629: no overlong encodings, no surrogate code points, nothing
 * above U+10FFFF, no truncated sequences), or -1 when the whole buffer is
 * valid. The offset makes the 14.20 report actionable (SPEC 14.20).
 */
export function firstInvalidUtf8(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead <= 0x7f) {
      index += 1;
      continue;
    }
    let length: number;
    let codePoint: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      codePoint = lead & 0x1f;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      codePoint = lead & 0x0f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      codePoint = lead & 0x07;
    } else {
      // 0x80–0xC1 (stray continuation or overlong lead) and 0xF5–0xFF.
      return index;
    }
    if (index + length > bytes.length) {
      return index;
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset];
      if (continuation < 0x80 || continuation > 0xbf) {
        return index;
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      (length === 2 && codePoint < 0x80) ||
      (length === 3 && codePoint < 0x800) ||
      (length === 4 && codePoint < 0x10000)
    ) {
      return index; // overlong encoding
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return index; // surrogate code point
    }
    if (codePoint > 0x10ffff) {
      return index;
    }
    index += length;
  }
  return -1;
}

/** The decoded text, or the file's 14.20 finding (SPEC 1.6). */
export type DecodedSource =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly finding: Finding };

/**
 * Decode one discovered source file's bytes (SPEC 1.6): a leading UTF-8
 * byte-order mark or invalid UTF-8 makes the file unparseable — condition
 * 14.20, with the failure's byte location. On success the text is the
 * decoded content, exactly.
 */
export function decodeSourceBytes(
  path: string,
  bytes: Uint8Array,
): DecodedSource {
  // SPEC 1.6: a source beginning with a byte-order mark is unparseable.
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return {
      ok: false,
      finding: {
        condition: 20,
        file: path,
        range: { start: 0, end: 3 },
        message:
          "unparseable source: the file begins with a UTF-8 byte-order " +
          "mark (bytes 0-3) — source files are BOM-free UTF-8; remove the " +
          "byte-order mark (SPEC 1.6, 14.20)",
      },
    };
  }
  const invalidAt = firstInvalidUtf8(bytes);
  if (invalidAt !== -1) {
    return {
      ok: false,
      finding: {
        condition: 20,
        file: path,
        range: { start: invalidAt, end: invalidAt + 1 },
        message:
          `unparseable source: the file is not valid UTF-8 (first invalid ` +
          `byte at offset ${String(invalidAt)}) — re-encode the file as ` +
          `UTF-8 (SPEC 1.6, 14.20)`,
      },
    };
  }
  return { ok: true, text: utf8Decoder.decode(bytes) };
}
