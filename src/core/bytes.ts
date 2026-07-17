// Byte-oriented string primitives.
//
// SPEC 12.0: IDs, tags, identities, session names, and paths compare
// byte-wise and case-sensitively; no Unicode normalization or case folding is
// applied anywhere. SPEC 1.6: source files are UTF-8 and text values are
// their decoded content. SPEC 1.7: source ranges are byte offsets into the
// file's bytes. JavaScript strings index UTF-16 code units, so this module
// provides exact conversion between the two and a comparison that orders
// strings by their UTF-8 bytes.

/**
 * A half-open range of byte offsets: zero-based, start-inclusive,
 * end-exclusive (SPEC 1.7).
 */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Three-way comparison of two strings equivalent to lexicographic byte
 * comparison of their UTF-8 encodings (SPEC 12.0: byte-wise, case-sensitive,
 * no normalization). For well-formed strings, Unicode code-point order equals
 * UTF-8 byte order, so this compares code points without materializing bytes.
 * (UTF-16 code-unit order would differ: e.g. U+FFFD sorts after U+10000 in
 * code units but before it in bytes.)
 */
export function compareBytes(a: string, b: string): -1 | 0 | 1 {
  const shorter = Math.min(a.length, b.length);
  let index = 0;
  while (index < shorter) {
    // Identical prefixes so far, so `index` is a code point boundary in both.
    const codePointA = a.codePointAt(index)!;
    const codePointB = b.codePointAt(index)!;
    if (codePointA !== codePointB) {
      return codePointA < codePointB ? -1 : 1;
    }
    index += codePointA > 0xffff ? 2 : 1;
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
}

/**
 * A copy of `items` sorted by the byte-wise order (`compareBytes`) of
 * `key(item)`. The sort is stable: items with equal keys keep their input
 * order, so callers layering further ordering rules stay deterministic
 * (SPEC 12.0).
 */
export function sortByBytes<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => compareBytes(key(a), key(b)));
}

/** The length in bytes of one code point's UTF-8 encoding. */
function utf8CodePointLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** The byte length of `text`'s UTF-8 encoding (SPEC 1.7 offsets are bytes). */
export function utf8Length(text: string): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    bytes += utf8CodePointLength(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/**
 * Bidirectional conversion between a string's UTF-16 code-unit indices and
 * byte offsets into its UTF-8 encoding, for one decoded source text. Source
 * files are UTF-8 (SPEC 1.6) and source ranges are byte offsets into the
 * file's bytes (SPEC 1.7); models built over decoded strings convert their
 * positions through this index. Assumes well-formed input: sources that are
 * not valid UTF-8 are rejected before any model is built (SPEC 14.19, 14.20).
 */
export class Utf8Offsets {
  readonly text: string;

  /**
   * byteOffsetOfIndex[i] = byte offset of the code point containing UTF-16
   * index i (a trailing-surrogate index maps to its code point's start);
   * byteOffsetOfIndex[text.length] = total byte length. Non-decreasing.
   */
  private readonly byteOffsetOfIndex: Uint32Array;

  constructor(text: string) {
    this.text = text;
    const offsets = new Uint32Array(text.length + 1);
    let byteOffset = 0;
    let index = 0;
    while (index < text.length) {
      const codePoint = text.codePointAt(index)!;
      offsets[index] = byteOffset;
      if (codePoint > 0xffff) {
        offsets[index + 1] = byteOffset;
        index += 2;
      } else {
        index += 1;
      }
      byteOffset += utf8CodePointLength(codePoint);
    }
    offsets[text.length] = byteOffset;
    this.byteOffsetOfIndex = offsets;
  }

  /** The byte length of the whole text's UTF-8 encoding. */
  get byteLength(): number {
    return this.byteOffsetOfIndex[this.text.length];
  }

  /**
   * The byte offset of UTF-16 index `index` (0 ≤ index ≤ text.length; the
   * end index maps to `byteLength`). An index inside a surrogate pair
   * reports the enclosing code point's start.
   */
  byteOffset(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index > this.text.length) {
      throw new RangeError(
        `UTF-16 index ${index} outside 0..${this.text.length}`,
      );
    }
    return this.byteOffsetOfIndex[index];
  }

  /**
   * The UTF-16 index whose code point starts at byte offset `offset`
   * (0 ≤ offset ≤ byteLength; `byteLength` maps to text.length). Throws when
   * `offset` falls inside a code point's encoding.
   */
  indexOfByteOffset(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.byteLength) {
      throw new RangeError(
        `byte offset ${offset} outside 0..${this.byteLength}`,
      );
    }
    // Smallest index whose byte offset is >= `offset`; because a trailing
    // surrogate repeats its code point's start, the smallest match is always
    // a code point boundary.
    const offsets = this.byteOffsetOfIndex;
    let low = 0;
    let high = this.text.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (offsets[mid] < offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    if (offsets[low] !== offset) {
      throw new RangeError(
        `byte offset ${offset} is inside a code point's UTF-8 encoding`,
      );
    }
    return low;
  }
}
