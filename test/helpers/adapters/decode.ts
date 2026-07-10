// Shape-decoding primitives for the H-3 output adapters (TEST-SPEC §0 H-3,
// §17 S-5). Harness machinery only: no product imports.
//
// Every adapter in this directory is built from these primitives, so the
// H-3 contract holds uniformly: when a document lacks required information or
// carries it in an unexpected structural form, decoding fails loudly as a
// diagnosed test failure (`HarnessAssertionError`, never a default, never a
// silent pass), naming the adapter, the JSON path of the offense, and the
// offending value. Primitives are value-blind: they check structure (types,
// presence, spec-fixed vocabularies) and never inspect fixture-specific
// values — asserting values is the tests' job.
//
// Absence convention (a shape decision, adjustable per H-3): a JSON `null` and
// a missing key both denote "absent" for optional information; a *required*
// key must be present and non-null.

import { fail } from "../assertions.js";

/** Where a decoder currently is: the adapter's name plus a JSON path. */
export interface DecodeSite {
  /** The adapter (command) this decode belongs to, for diagnoses. */
  readonly adapter: string;
  /** JSON-path-style location inside the document (`$`, `$.items[3].id`). */
  readonly path: string;
}

/** The root site of a document decoded by the named adapter. */
export function rootSite(adapter: string, context?: string): DecodeSite {
  const label = context === undefined ? adapter : `${adapter} (${context})`;
  return { adapter: label, path: "$" };
}

/** The site one step deeper: an object key (string) or array index (number). */
export function at(site: DecodeSite, step: string | number): DecodeSite {
  const path =
    typeof step === "number"
      ? `${site.path}[${String(step)}]`
      : `${site.path}.${step}`;
  return { adapter: site.adapter, path };
}

/**
 * Fail the decode loudly (H-3: a test error, not a pass). Every structural
 * mismatch in every adapter funnels through here.
 */
export function decodeFail(
  site: DecodeSite,
  expected: string,
  actual: unknown,
): never {
  fail(
    `${site.adapter} adapter: at ${site.path}: expected ${expected}, got ${describeJsonValue(actual)}. ` +
      `H-3: adapters fail loudly when required information is absent or malformed, never defaulting; ` +
      `if the product's real output shape legitimately differs, adjust the adapter's shape here — never its values.`,
  );
}

/** Render a decoded-JSON value for a diagnosis (type plus a bounded excerpt). */
export function describeJsonValue(value: unknown): string {
  if (value === undefined) return "nothing (the key is absent)";
  if (value === null) return "null";
  const kind = Array.isArray(value) ? "array" : typeof value;
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  const LIMIT = 256;
  if (rendered.length > LIMIT) {
    rendered = `${rendered.slice(0, LIMIT)}… (${String(rendered.length)} chars)`;
  }
  return `${kind} ${rendered}`;
}

/** The decoded value must be a JSON object (not null, not an array). */
export function expectObject(
  value: unknown,
  site: DecodeSite,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    decodeFail(site, "a JSON object", value);
  }
  return value as Record<string, unknown>;
}

/** The decoded value must be a JSON array. */
export function expectArray(value: unknown, site: DecodeSite): unknown[] {
  if (!Array.isArray(value)) decodeFail(site, "a JSON array", value);
  return value;
}

/** The decoded value must be a string (empty allowed — e.g. empty own text). */
export function expectString(value: unknown, site: DecodeSite): string {
  if (typeof value !== "string") decodeFail(site, "a string", value);
  return value;
}

/** The decoded value must be a non-empty string (identities, names, hashes). */
export function expectNonEmptyString(value: unknown, site: DecodeSite): string {
  const text = expectString(value, site);
  if (text.length === 0) decodeFail(site, "a non-empty string", value);
  return text;
}

/** The decoded value must be a boolean. */
export function expectBoolean(value: unknown, site: DecodeSite): boolean {
  if (typeof value !== "boolean") decodeFail(site, "a boolean", value);
  return value;
}

/** The decoded value must be a non-negative integer (counts, byte offsets). */
export function expectNonNegativeInteger(
  value: unknown,
  site: DecodeSite,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    decodeFail(site, "a non-negative integer", value);
  }
  return value;
}

/**
 * The decoded value must be one of a spec-fixed vocabulary (edge kinds, item
 * statuses, …). Vocabulary membership is structure, not fixture values: the
 * tokens are pinned by SPEC.md itself, so an unknown token is malformed
 * output, rejected loudly rather than passed through.
 */
export function expectToken<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
  site: DecodeSite,
): T {
  const text = expectString(value, site);
  if (!(vocabulary as readonly string[]).includes(text)) {
    decodeFail(
      site,
      `one of ${vocabulary.map((t) => `"${t}"`).join(", ")}`,
      value,
    );
  }
  return text as T;
}

/** An array whose every element is a string (possibly empty array). */
export function expectStringArray(value: unknown, site: DecodeSite): string[] {
  return expectArray(value, site).map((element, index) =>
    expectString(element, at(site, index)),
  );
}

/** An array whose every element is a non-empty string. */
export function expectNonEmptyStringArray(
  value: unknown,
  site: DecodeSite,
): string[] {
  return expectArray(value, site).map((element, index) =>
    expectNonEmptyString(element, at(site, index)),
  );
}

/**
 * Read a required key: the key must be present with a non-null value.
 * Required information may never be defaulted (H-3).
 */
export function requiredKey(
  obj: Record<string, unknown>,
  key: string,
  site: DecodeSite,
): unknown {
  if (!Object.hasOwn(obj, key) || obj[key] === null) {
    decodeFail(
      at(site, key),
      `required key "${key}" with a non-null value`,
      obj[key],
    );
  }
  return obj[key];
}

/**
 * Read a key that must be present but whose value is opaque, product-shaped
 * data passed through whole (recorded state, creation parameters,
 * decompositions) — `null` is a legitimate encoding of "none recorded" there,
 * so unlike `requiredKey` this only requires the member to exist.
 */
export function requiredMember(
  obj: Record<string, unknown>,
  key: string,
  site: DecodeSite,
): unknown {
  if (!Object.hasOwn(obj, key)) {
    decodeFail(at(site, key), `required key "${key}"`, undefined);
  }
  return obj[key];
}

/**
 * Read an optional key: absent or null mean "absent" (returns undefined); a
 * present non-null value is returned for further shape checks — a wrong-typed
 * optional value still fails loudly downstream, it never decays to absent.
 */
export function optionalKey(
  obj: Record<string, unknown>,
  key: string,
): unknown {
  if (!Object.hasOwn(obj, key)) return undefined;
  const value = obj[key];
  return value === null ? undefined : value;
}

/**
 * Assert a key is absent (or null). Used where the information model makes
 * presence contradictory — e.g. a witness path on an unreachable result, or
 * text on a node presented as absent — so contradictory documents are
 * rejected rather than one half silently ignored.
 */
export function forbiddenKey(
  obj: Record<string, unknown>,
  key: string,
  site: DecodeSite,
  reason: string,
): void {
  const value = optionalKey(obj, key);
  if (value !== undefined) {
    decodeFail(at(site, key), `no "${key}" (${reason})`, value);
  }
}
