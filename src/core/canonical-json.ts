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

/**
 * Serializes `value` to compact canonical JSON: the same deterministic
 * rendering as `canonicalJson` — object keys sorted byte-wise, array elements
 * in given order — but with no whitespace and no trailing newline, so one
 * value occupies exactly one line. This is the line encoding of the
 * line-oriented journal (SPEC 6.1): JSON string escaping keeps every value on
 * a single line whatever characters it contains.
 */
export function compactJson(value: JsonValue): string {
  const primitive = renderPrimitive(value);
  if (primitive !== null) {
    return primitive;
  }
  const composite = value as readonly JsonValue[] | JsonObject;
  if (isJsonArray(composite)) {
    const items = composite.map((element) => {
      if (element === undefined) {
        throw new TypeError("undefined array element in canonical JSON");
      }
      return compactJson(element);
    });
    return "[" + items.join(",") + "]";
  }
  const entries: string[] = [];
  for (const key of Object.keys(composite).sort(compareBytes)) {
    const propertyValue = composite[key];
    if (propertyValue === undefined) {
      continue;
    }
    entries.push(JSON.stringify(key) + ":" + compactJson(propertyValue));
  }
  return "{" + entries.join(",") + "}";
}

/** The rendering of a primitive value, or null for arrays and objects. */
function renderPrimitive(value: JsonValue): string | null {
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
  return null;
}

function render(value: JsonValue, indent: string): string {
  const primitive = renderPrimitive(value);
  if (primitive !== null) {
    return primitive;
  }
  // renderPrimitive returned null, so `value` is an array or an object.
  const composite = value as readonly JsonValue[] | JsonObject;
  const inner = indent + "  ";
  if (isJsonArray(composite)) {
    if (composite.length === 0) {
      return "[]";
    }
    const items = composite.map((element) => {
      if (element === undefined) {
        throw new TypeError("undefined array element in canonical JSON");
      }
      return inner + render(element, inner);
    });
    return "[\n" + items.join(",\n") + "\n" + indent + "]";
  }
  const object: JsonObject = composite;
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
