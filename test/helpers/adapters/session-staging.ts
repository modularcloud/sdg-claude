// H-3 adapter layer — session-corruption staging for T10.1-4 (TEST-SPEC §0
// H-3, §10.1). SPEC.md leaves the review session file's concrete shape opaque
// (10.1), so every shape-dependent corrupt fixture starts from a session file
// the product itself wrote and is corrupted here — the one place aware of the
// stored session's concrete shape. The transformations are shape-aware and
// value-blind: they locate structure (the item list, an item's id, status,
// blockedBy, the recorded creation parameters), never inspect what the values
// are, and fail loudly (diagnosed test error, file untouched) when the shape
// does not match. The harness never writes a session file from an assumed
// layout — shape-independent corrupt states (unparseable bytes, truncation, a
// directory or symlink at the path) are staged directly by the tests, not
// here.
//
// ASSUMED STORED-SESSION SHAPE (adjustable per H-3, values never):
//   { ..., "creationParameters": <recorded>, ...,
//     "items": [ { "id": string, "status": string, "blockedBy": [id...],
//                  ...per-item fields... }, ... ], ... }
//
// Every transformation validates the shape it needs before mutating anything,
// rewrites the parsed document, and writes it back as a single well-formed
// JSON document — each staged state stays parseable, so the product observes
// exactly the one injected corruption (unparseable bytes are a separate,
// shape-independent state).

import * as fsp from "node:fs/promises";
import { fail } from "../assertions.js";
import { describeJsonValue } from "./decode.js";

/** The stored-session shape knowledge, in one adjustable place. */
const SESSION_SHAPE = {
  itemsKey: "items",
  idKey: "id",
  statusKey: "status",
  blockedByKey: "blockedBy",
  creationParametersKey: "creationParameters",
} as const;

interface LoadedSession {
  readonly doc: Record<string, unknown>;
  readonly items: Record<string, unknown>[];
}

function shapeFail(absPath: string, problem: string, actual?: unknown): never {
  const rendered =
    actual === undefined ? "" : `; got ${describeJsonValue(actual)}`;
  fail(
    `session-corruption staging: ${absPath}: ${problem}${rendered}. ` +
      `H-3: staging transformations are shape-aware and value-blind, applied to a file the product itself wrote, ` +
      `and fail loudly when the shape does not match — the harness never fabricates a session file from an assumed layout. ` +
      `The file was left unmodified. If the product's real stored shape legitimately differs, adjust SESSION_SHAPE ` +
      `in test/helpers/adapters/session-staging.ts.`,
  );
}

/** Load and shape-check a product-written session file (nothing modified). */
async function loadSession(absPath: string): Promise<LoadedSession> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(absPath);
  } catch (error) {
    return shapeFail(
      absPath,
      `expected a readable session file the product wrote, but reading it failed: ${(error as Error).message}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return shapeFail(absPath, "the session file is not valid UTF-8");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (error) {
    return shapeFail(
      absPath,
      `the session file is not one JSON document: ${(error as Error).message}`,
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return shapeFail(absPath, "expected a JSON object at the top level", doc);
  }
  const obj = doc as Record<string, unknown>;
  if (!Object.hasOwn(obj, SESSION_SHAPE.itemsKey)) {
    return shapeFail(
      absPath,
      `expected an "${SESSION_SHAPE.itemsKey}" member holding the item list`,
      undefined,
    );
  }
  const itemsValue = obj[SESSION_SHAPE.itemsKey];
  if (!Array.isArray(itemsValue)) {
    return shapeFail(
      absPath,
      `expected "${SESSION_SHAPE.itemsKey}" to be an array`,
      itemsValue,
    );
  }
  const items = itemsValue.map((element, index) => {
    if (
      typeof element !== "object" ||
      element === null ||
      Array.isArray(element)
    ) {
      return shapeFail(
        absPath,
        `expected ${SESSION_SHAPE.itemsKey}[${String(index)}] to be a JSON object`,
        element,
      );
    }
    return element as Record<string, unknown>;
  });
  // The returned array is the document's own item list, so transformations
  // that push or reorder entries act on the document directly.
  obj[SESSION_SHAPE.itemsKey] = items;
  return { doc: obj, items };
}

function requireItems(
  absPath: string,
  loaded: LoadedSession,
  minimum: number,
): void {
  if (loaded.items.length < minimum) {
    shapeFail(
      absPath,
      `the transformation needs at least ${String(minimum)} item(s), found ${String(loaded.items.length)} — stage it on a session the product wrote with enough items`,
    );
  }
}

function itemId(
  absPath: string,
  item: Record<string, unknown>,
  index: number,
): string {
  const value = item[SESSION_SHAPE.idKey];
  if (typeof value !== "string" || value.length === 0) {
    return shapeFail(
      absPath,
      `expected ${SESSION_SHAPE.itemsKey}[${String(index)}].${SESSION_SHAPE.idKey} to be a non-empty string`,
      value,
    );
  }
  return value;
}

function requireItemKey(
  absPath: string,
  item: Record<string, unknown>,
  index: number,
  key: string,
): void {
  if (!Object.hasOwn(item, key)) {
    shapeFail(
      absPath,
      `expected ${SESSION_SHAPE.itemsKey}[${String(index)}] to carry a "${key}" member`,
    );
  }
}

function requireBlockedByArray(
  absPath: string,
  item: Record<string, unknown>,
  index: number,
): void {
  requireItemKey(absPath, item, index, SESSION_SHAPE.blockedByKey);
  const value = item[SESSION_SHAPE.blockedByKey];
  if (!Array.isArray(value)) {
    shapeFail(
      absPath,
      `expected ${SESSION_SHAPE.itemsKey}[${String(index)}].${SESSION_SHAPE.blockedByKey} to be an array`,
      value,
    );
  }
}

/** A string distinct from every element of `taken` (deterministic). */
function distinctFrom(taken: readonly string[], base: string): string {
  let candidate = base;
  while (taken.includes(candidate)) candidate = `${candidate}-x`;
  return candidate;
}

async function writeSession(
  absPath: string,
  doc: Record<string, unknown>,
): Promise<void> {
  await fsp.writeFile(absPath, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * T10.1-4 "duplicate item ids" / "two items with same kind and scope node":
 * duplicate an item entry. By default the copy keeps the original's id
 * (duplicate ids); with `distinctId` the copy's id is rewritten to a fresh
 * value, so the duplicate-kind-and-scope state is staged without the
 * duplicate-id state.
 */
export async function stageDuplicateItemEntry(
  absPath: string,
  options: { readonly distinctId?: boolean } = {},
): Promise<void> {
  const loaded = await loadSession(absPath);
  requireItems(absPath, loaded, 1);
  const original = loaded.items[0];
  itemId(absPath, original, 0); // Shape check: an item entry carries an id.
  const copy = structuredClone(original);
  if (options.distinctId === true) {
    const ids = loaded.items.map((item, index) => itemId(absPath, item, index));
    copy[SESSION_SHAPE.idKey] = distinctFrom(ids, `${ids[0]}-dup`);
  }
  loaded.items.push(copy);
  await writeSession(absPath, loaded.doc);
}

/**
 * T10.1-4 "unknown status": rewrite an item's status to a value outside every
 * status SPEC.md 10.3/10.4 defines (and distinct from whatever was stored).
 */
export async function stageUnknownItemStatus(absPath: string): Promise<void> {
  const loaded = await loadSession(absPath);
  requireItems(absPath, loaded, 1);
  const item = loaded.items[0];
  requireItemKey(absPath, item, 0, SESSION_SHAPE.statusKey);
  const stored = item[SESSION_SHAPE.statusKey];
  if (typeof stored !== "string") {
    shapeFail(
      absPath,
      `expected ${SESSION_SHAPE.itemsKey}[0].${SESSION_SHAPE.statusKey} to be a string`,
      stored,
    );
  }
  item[SESSION_SHAPE.statusKey] = distinctFrom(
    [stored],
    "xspec-harness-unknown-status",
  );
  await writeSession(absPath, loaded.doc);
}

/**
 * T10.1-4 "a blockedBy cycle": redirect `blockedBy` into a cycle over the
 * ids the session itself bears — two items block each other; a single-item
 * session blocks itself.
 */
export async function stageBlockedByCycle(absPath: string): Promise<void> {
  const loaded = await loadSession(absPath);
  requireItems(absPath, loaded, 1);
  const first = loaded.items[0];
  requireBlockedByArray(absPath, first, 0);
  const firstId = itemId(absPath, first, 0);
  if (loaded.items.length === 1) {
    first[SESSION_SHAPE.blockedByKey] = [firstId];
  } else {
    const second = loaded.items[1];
    requireBlockedByArray(absPath, second, 1);
    const secondId = itemId(absPath, second, 1);
    first[SESSION_SHAPE.blockedByKey] = [secondId];
    second[SESSION_SHAPE.blockedByKey] = [firstId];
  }
  await writeSession(absPath, loaded.doc);
}

/**
 * T10.1-4 "blockedBy naming an absent item": redirect an item's `blockedBy`
 * at an id no item of the session bears (derived from, and distinct from,
 * the ids present — value-blind).
 */
export async function stageBlockedByAbsentItem(absPath: string): Promise<void> {
  const loaded = await loadSession(absPath);
  requireItems(absPath, loaded, 1);
  const item = loaded.items[0];
  requireBlockedByArray(absPath, item, 0);
  const ids = loaded.items.map((entry, index) => itemId(absPath, entry, index));
  item[SESSION_SHAPE.blockedByKey] = [
    distinctFrom(ids, "xspec-harness-absent-item"),
  ];
  await writeSession(absPath, loaded.doc);
}

/**
 * T10.1-4 "missing 10.2 field": delete a named field from an item entry.
 * The field must exist in the product-written file — deleting an already
 * absent field would stage nothing, so that is a shape mismatch.
 */
export async function stageDeleteItemField(
  absPath: string,
  field: string,
): Promise<void> {
  const loaded = await loadSession(absPath);
  requireItems(absPath, loaded, 1);
  const item = loaded.items[0];
  requireItemKey(absPath, item, 0, field);
  delete item[field];
  await writeSession(absPath, loaded.doc);
}

/**
 * T10.1-4 "malformed recorded creation parameters": garble the recorded
 * creation parameters by replacing them with a value of a different JSON
 * structural type (value-blind: only the stored value's type is examined, so
 * the replacement is malformed whatever the recorded content was — a garbage
 * *string* where a string is stored could still parse as merely unresolvable,
 * which is a different, exit-2 state, T10.7-3).
 */
export async function stageGarbleCreationParameters(
  absPath: string,
): Promise<void> {
  const loaded = await loadSession(absPath);
  const key = SESSION_SHAPE.creationParametersKey;
  if (!Object.hasOwn(loaded.doc, key)) {
    shapeFail(
      absPath,
      `expected a "${key}" member holding the recorded creation parameters`,
    );
  }
  const stored = loaded.doc[key];
  loaded.doc[key] =
    typeof stored === "object" && stored !== null
      ? " xspec-harness-garbled "
      : { "xspec-harness-garbled": true };
  await writeSession(absPath, loaded.doc);
}
