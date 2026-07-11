// H-3 adapter layer — the sorted-keys assertion for T13.4-1 (SPEC.md 13.4:
// every file xspec writes is written with sorted keys; 12.0: byte-wise
// comparison). Asserted shape- and value-blind: over whatever objects and
// keys are present in the document, every JSON object's keys must be in
// byte-sorted order — no shape or values pinned (H-3).
//
// The check scans the document text itself rather than JSON.parse-ing it:
// JavaScript objects reorder integer-like keys ("9" before "10" regardless of
// document order), so a parse-based check would silently pass documents whose
// written order is wrong and fail documents whose written order is right.
// Keys compare as the UTF-8 bytes of their *decoded* values (escape
// sequences resolved): the key is the string, not its spelling.

import { Buffer } from "node:buffer";
import { fail } from "../assertions.js";

/**
 * Assert every JSON object in the document has its keys in byte-sorted order
 * (strictly ascending — a duplicate key is not sorted). The input must be
 * exactly one JSON document (a product-written file, T13.4-1); anything else
 * — invalid UTF-8, malformed JSON, trailing content — fails loudly as a
 * diagnosed test error, never a pass.
 */
export function assertJsonKeysByteSorted(
  input: string | Uint8Array,
  context: string,
): void {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      fail(
        `${context}: not valid UTF-8, so not one JSON document — the sorted-keys assertion applies to a product-written JSON file (T13.4-1)`,
      );
    }
  }
  const scanner = new KeyOrderScanner(text, context);
  scanner.scanDocument();
}

class KeyOrderScanner {
  #pos = 0;
  readonly #text: string;
  readonly #context: string;

  constructor(text: string, context: string) {
    this.#text = text;
    this.#context = context;
  }

  scanDocument(): void {
    this.#skipWhitespace();
    if (this.#pos >= this.#text.length) {
      this.#fail(
        "expected one JSON document, got an empty (or all-whitespace) input",
      );
    }
    this.#scanValue("$");
    this.#skipWhitespace();
    if (this.#pos < this.#text.length) {
      this.#fail(
        `trailing content after the JSON document (not exactly one document)`,
      );
    }
  }

  #fail(problem: string): never {
    fail(
      `${this.#context}: sorted-keys assertion (T13.4-1, SPEC.md 13.4): ${problem} at character offset ${String(this.#pos)}`,
    );
  }

  #skipWhitespace(): void {
    while (this.#pos < this.#text.length) {
      const ch = this.#text[this.#pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.#pos += 1;
      } else {
        return;
      }
    }
  }

  #scanValue(path: string): void {
    const ch = this.#text[this.#pos];
    switch (ch) {
      case "{":
        this.#scanObject(path);
        return;
      case "[":
        this.#scanArray(path);
        return;
      case '"':
        this.#scanString(path);
        return;
      case "t":
        this.#scanLiteral("true");
        return;
      case "f":
        this.#scanLiteral("false");
        return;
      case "n":
        this.#scanLiteral("null");
        return;
      default:
        this.#scanNumber(path);
        return;
    }
  }

  #scanObject(path: string): void {
    this.#pos += 1; // consume "{"
    this.#skipWhitespace();
    if (this.#text[this.#pos] === "}") {
      this.#pos += 1;
      return;
    }
    let previousKey: string | undefined;
    for (;;) {
      this.#skipWhitespace();
      if (this.#text[this.#pos] !== '"') {
        this.#fail(`expected a string key in the object at ${path}`);
      }
      const key = this.#scanString(path);
      if (previousKey !== undefined) {
        const order = Buffer.compare(
          Buffer.from(previousKey, "utf8"),
          Buffer.from(key, "utf8"),
        );
        if (order === 0) {
          this.#fail(
            `duplicate key ${JSON.stringify(key)} in the object at ${path} — duplicate keys are not sorted keys`,
          );
        }
        if (order > 0) {
          this.#fail(
            `keys of the object at ${path} are not in byte-sorted order: ${JSON.stringify(previousKey)} precedes ${JSON.stringify(key)}, but ${JSON.stringify(key)} sorts first as UTF-8 bytes`,
          );
        }
      }
      previousKey = key;
      this.#skipWhitespace();
      if (this.#text[this.#pos] !== ":") {
        this.#fail(
          `expected ":" after the key ${JSON.stringify(key)} at ${path}`,
        );
      }
      this.#pos += 1;
      this.#skipWhitespace();
      this.#scanValue(`${path}.${key}`);
      this.#skipWhitespace();
      const next = this.#text[this.#pos];
      if (next === ",") {
        this.#pos += 1;
        continue;
      }
      if (next === "}") {
        this.#pos += 1;
        return;
      }
      this.#fail(`expected "," or "}" in the object at ${path}`);
    }
  }

  #scanArray(path: string): void {
    this.#pos += 1; // consume "["
    this.#skipWhitespace();
    if (this.#text[this.#pos] === "]") {
      this.#pos += 1;
      return;
    }
    let index = 0;
    for (;;) {
      this.#skipWhitespace();
      this.#scanValue(`${path}[${String(index)}]`);
      this.#skipWhitespace();
      const next = this.#text[this.#pos];
      if (next === ",") {
        this.#pos += 1;
        index += 1;
        continue;
      }
      if (next === "]") {
        this.#pos += 1;
        return;
      }
      this.#fail(`expected "," or "]" in the array at ${path}`);
    }
  }

  /** Scan a JSON string; return its decoded value (escapes resolved). */
  #scanString(path: string): string {
    this.#pos += 1; // consume the opening quote
    let value = "";
    for (;;) {
      if (this.#pos >= this.#text.length) {
        this.#fail(`unterminated string at ${path}`);
      }
      const ch = this.#text[this.#pos];
      if (ch === '"') {
        this.#pos += 1;
        return value;
      }
      if (ch === "\\") {
        value += this.#scanEscape(path);
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        this.#fail(
          `unescaped control character U+${code.toString(16).padStart(4, "0").toUpperCase()} in a string at ${path} (not valid JSON)`,
        );
      }
      value += ch;
      this.#pos += 1;
    }
  }

  #scanEscape(path: string): string {
    this.#pos += 1; // consume "\"
    const ch = this.#text[this.#pos];
    this.#pos += 1;
    switch (ch) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.#text.slice(this.#pos, this.#pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.#fail(`invalid \\u escape in a string at ${path}`);
        }
        this.#pos += 4;
        // Surrogate halves concatenate into the right code point in a JS
        // string; a lone half stays lone, exactly as JSON.parse decodes it.
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.#fail(
          `invalid escape ${JSON.stringify(`\\${ch ?? "<end>"}`)} in a string at ${path}`,
        );
    }
  }

  #scanLiteral(literal: "true" | "false" | "null"): void {
    if (this.#text.startsWith(literal, this.#pos)) {
      this.#pos += literal.length;
      return;
    }
    this.#fail(`expected the JSON literal "${literal}"`);
  }

  static readonly #NUMBER =
    /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

  #scanNumber(path: string): void {
    KeyOrderScanner.#NUMBER.lastIndex = this.#pos;
    const match = KeyOrderScanner.#NUMBER.exec(this.#text);
    if (match === null || match.index !== this.#pos || match[0].length === 0) {
      this.#fail(`expected a JSON value at ${path} (not valid JSON)`);
    }
    this.#pos += match[0].length;
  }
}
