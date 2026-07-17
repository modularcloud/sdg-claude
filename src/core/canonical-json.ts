// The canonical JSON serializer.
//
// IMPLEMENTATION (cross-cutting rules): stored and emitted JSON goes through
// one canonical serializer — sorted keys, stable ordering, trailing newline —
// shared by graph data, sessions, and --json output. SPEC 12.0: all output,
// generated files, and stored data are byte-deterministic for identical
// input.

import { compareBytes } from "./bytes.js";

/**
 * A JSON-representable value. Object properties whose value is `undefined`
 * are omitted at serialization (so optional model fields serialize
 * naturally); `undefined` never appears anywhere else.
 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/**
 * Serializes `value` to canonical JSON text: object keys sorted byte-wise
 * (SPEC 12.0 comparison), array elements in given order, two-space
 * indentation, and a trailing newline terminating the document. The output
 * is a deterministic function of `value` alone.
 */
export function canonicalJson(value: JsonValue): string {
  return render(value, "") + "\n";
}

function render(value: JsonValue, indent: string): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite number in canonical JSON: ${value}`);
    }
    // Number-to-string conversion is fully specified by ECMAScript (shortest
    // round-trip form), so this is byte-deterministic across platforms.
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // JSON.stringify string quoting is fully specified by ECMAScript.
    return JSON.stringify(value);
  }
  const inner = indent + "  ";
  if (isJsonArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value.map((element) => {
      if (element === undefined) {
        throw new TypeError("undefined array element in canonical JSON");
      }
      return inner + render(element, inner);
    });
    return "[\n" + items.join(",\n") + "\n" + indent + "]";
  }
  const object: JsonObject = value;
  const entries: string[] = [];
  for (const key of Object.keys(object).sort(compareBytes)) {
    const propertyValue = object[key];
    if (propertyValue === undefined) {
      continue;
    }
    entries.push(
      inner + JSON.stringify(key) + ": " + render(propertyValue, inner),
    );
  }
  if (entries.length === 0) {
    return "{}";
  }
  return "{\n" + entries.join(",\n") + "\n" + indent + "}";
}

function isJsonArray(
  value: readonly JsonValue[] | JsonObject,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}
