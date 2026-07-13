// H-3 output adapters — the `review` command family: `list`, `status`,
// `next`, `show`, `export` (SPEC.md 10; TEST-SPEC §10).
//
// Shape-aware, value-blind, fail-loud (H-3) — see query.ts for the layer's
// contract. Adjust the ASSUMED SHAPE below when the real product's output
// shape legitimately differs; never adjust values. `baseline`, `current`,
// `creationParameters`, and `decompositions` are recorded, product-shaped
// data: the adapter requires their presence and passes their decoded JSON
// through whole for the tests to compare (T10.2-2/4, T10.7-2).
//
// ASSUMED SHAPE:
//   review list →
//     { "sessions": [ { "name", "corrupt": true }
//                   | { "name", "corrupt": false, "strategy",
//                       "counts": { <status>: n, ... } } ] }
//   review status →
//     { "items": [ { "id", "kind", "scope", "status", "blocked" } ],
//       "totals": { <status>: n, ... } }
//   review next →
//     { "fullyResolved": bool, "item"?: Item }   ("item" iff not fully resolved)
//   review show → Item (the document is the item)
//   review export →
//     { "name", "strategy", "creationParameters", "decompositions",
//       "items": [Item] }
//   Item = { "id", "kind", "status", "blocked", "blockedBy": [id...],
//            "reason", "note"?,
//            "scope": NodeState, "context": [NodeState],
//            "origin": [ { "node", "before": Side, "after": Side } ],
//            "baseline", "current" }
//   NodeState = { "node", "present": bool, "text"?, "sourceRange"? }
//     (text optional either way: a present node's text is read from the
//     current graph, an absent node's is the recorded value of SPEC 10.7's
//     provenance rule — only a node contained in no recorded state, and a
//     code-impact scope, carries none; sourceRange only when present, since
//     an absent node has no current source)
//   Side = { "present": bool, "text"? }   (text required iff present — the
//     absent side of an origin before/after pair carries no text, SPEC 10.7)

import type {
  ExportReport,
  NextReport,
  NodeTextState,
  OriginEntry,
  OriginTextSide,
  ReviewItem,
  SessionListEntry,
  SessionListReport,
  SessionStatusReport,
  SessionStatusRow,
} from "./model.js";
import { ITEM_KINDS, ITEM_STATUSES } from "./model.js";
import type { DecodeSite } from "./decode.js";
import {
  at,
  expectArray,
  expectBoolean,
  expectNonEmptyString,
  expectNonEmptyStringArray,
  expectNonNegativeInteger,
  expectObject,
  expectString,
  expectToken,
  forbiddenKey,
  optionalKey,
  requiredKey,
  requiredMember,
  rootSite,
} from "./decode.js";
import { decodeSourceRange } from "./query.js";

/** Counts keyed by status: every value a non-negative integer. */
function decodeCounts(
  value: unknown,
  site: DecodeSite,
): Record<string, number> {
  const obj = expectObject(value, site);
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(obj)) {
    counts[key] = expectNonNegativeInteger(count, at(site, key));
  }
  return counts;
}

function decodeSessionListEntry(
  value: unknown,
  site: DecodeSite,
): SessionListEntry {
  const obj = expectObject(value, site);
  const name = expectNonEmptyString(
    requiredKey(obj, "name", site),
    at(site, "name"),
  );
  const corrupt = expectBoolean(
    requiredKey(obj, "corrupt", site),
    at(site, "corrupt"),
  );
  if (corrupt) {
    // T10.1-4: a corrupt session is reported by name, corrupt in place of
    // its fields — a document carrying fields anyway is contradictory.
    forbiddenKey(obj, "strategy", site, "a corrupt session has no fields");
    forbiddenKey(obj, "counts", site, "a corrupt session has no fields");
    return { name, corrupt };
  }
  return {
    name,
    corrupt,
    strategy: expectNonEmptyString(
      requiredKey(obj, "strategy", site),
      at(site, "strategy"),
    ),
    counts: decodeCounts(requiredKey(obj, "counts", site), at(site, "counts")),
  };
}

/**
 * `review list` (T10.7-5): every session in byte order of name — name,
 * strategy, and item counts by stored status; corrupt sessions by name as
 * corrupt.
 */
export function decodeSessionListReport(
  doc: unknown,
  context?: string,
): SessionListReport {
  const site = rootSite("review list", context);
  const obj = expectObject(doc, site);
  const sessionsSite = at(site, "sessions");
  const sessions = expectArray(
    requiredKey(obj, "sessions", site),
    sessionsSite,
  ).map((element, index) =>
    decodeSessionListEntry(element, at(sessionsSite, index)),
  );
  return { sessions };
}

function decodeStatusRow(value: unknown, site: DecodeSite): SessionStatusRow {
  const obj = expectObject(value, site);
  return {
    id: expectNonEmptyString(requiredKey(obj, "id", site), at(site, "id")),
    kind: expectToken(
      requiredKey(obj, "kind", site),
      ITEM_KINDS,
      at(site, "kind"),
    ),
    scope: expectNonEmptyString(
      requiredKey(obj, "scope", site),
      at(site, "scope"),
    ),
    status: expectToken(
      requiredKey(obj, "status", site),
      ITEM_STATUSES,
      at(site, "status"),
    ),
    blocked: expectBoolean(
      requiredKey(obj, "blocked", site),
      at(site, "blocked"),
    ),
  };
}

/**
 * `review status` (T10.7-6): items in item order with id, kind, scope,
 * status, and blocked state, plus totals by status (read-time invalidation
 * applied).
 */
export function decodeSessionStatusReport(
  doc: unknown,
  context?: string,
): SessionStatusReport {
  const site = rootSite("review status", context);
  const obj = expectObject(doc, site);
  const itemsSite = at(site, "items");
  return {
    items: expectArray(requiredKey(obj, "items", site), itemsSite).map(
      (element, index) => decodeStatusRow(element, at(itemsSite, index)),
    ),
    totals: decodeCounts(requiredKey(obj, "totals", site), at(site, "totals")),
  };
}

/**
 * A node presented in a payload: identity plus presence; text is optional for
 * present and absent nodes alike (SPEC 10.7: a present node's text comes from
 * the current graph, an absent node's is the recorded value under the
 * provenance rule — a node contained in no recorded state, and a
 * `code-impact` scope, carries none; T10.2-3, T10.7-12), while a source range
 * exists only for a present node (SPEC 10.7, 1.7: an absent node has no
 * current source).
 */
function decodeNodeTextState(value: unknown, site: DecodeSite): NodeTextState {
  const obj = expectObject(value, site);
  const state: {
    node: string;
    present: boolean;
    text?: string;
    sourceRange?: NodeTextState["sourceRange"];
  } = {
    node: expectNonEmptyString(
      requiredKey(obj, "node", site),
      at(site, "node"),
    ),
    present: expectBoolean(
      requiredKey(obj, "present", site),
      at(site, "present"),
    ),
  };
  const text = optionalKey(obj, "text");
  if (text !== undefined) {
    state.text = expectString(text, at(site, "text"));
  }
  if (!state.present) {
    forbiddenKey(
      obj,
      "sourceRange",
      site,
      "an absent node has no current source, so it is presented without a source range (SPEC 10.7, 1.7)",
    );
    return state;
  }
  const sourceRange = optionalKey(obj, "sourceRange");
  if (sourceRange !== undefined) {
    state.sourceRange = decodeSourceRange(sourceRange, at(site, "sourceRange"));
  }
  return state;
}

/** One side of an origin before/after pair: text required iff present. */
function decodeOriginSide(value: unknown, site: DecodeSite): OriginTextSide {
  const obj = expectObject(value, site);
  const present = expectBoolean(
    requiredKey(obj, "present", site),
    at(site, "present"),
  );
  if (!present) {
    forbiddenKey(obj, "text", site, "an absent side carries no text");
    return { present };
  }
  return {
    present,
    text: expectString(requiredKey(obj, "text", site), at(site, "text")),
  };
}

function decodeOriginEntry(value: unknown, site: DecodeSite): OriginEntry {
  const obj = expectObject(value, site);
  return {
    node: expectNonEmptyString(
      requiredKey(obj, "node", site),
      at(site, "node"),
    ),
    before: decodeOriginSide(
      requiredKey(obj, "before", site),
      at(site, "before"),
    ),
    after: decodeOriginSide(requiredKey(obj, "after", site), at(site, "after")),
  };
}

/** Decode one full review item (10.2 fields plus the payload of 10.7). */
export function decodeReviewItemValue(
  value: unknown,
  site: DecodeSite,
): ReviewItem {
  const obj = expectObject(value, site);
  const contextSite = at(site, "context");
  const originSite = at(site, "origin");
  const item: {
    id: string;
    kind: ReviewItem["kind"];
    status: ReviewItem["status"];
    blocked: boolean;
    blockedBy: readonly string[];
    reason: string;
    note?: string;
    scope: NodeTextState;
    context: readonly NodeTextState[];
    origin: readonly OriginEntry[];
    baseline: unknown;
    current: unknown;
  } = {
    id: expectNonEmptyString(requiredKey(obj, "id", site), at(site, "id")),
    kind: expectToken(
      requiredKey(obj, "kind", site),
      ITEM_KINDS,
      at(site, "kind"),
    ),
    status: expectToken(
      requiredKey(obj, "status", site),
      ITEM_STATUSES,
      at(site, "status"),
    ),
    blocked: expectBoolean(
      requiredKey(obj, "blocked", site),
      at(site, "blocked"),
    ),
    blockedBy: expectNonEmptyStringArray(
      requiredKey(obj, "blockedBy", site),
      at(site, "blockedBy"),
    ),
    reason: expectNonEmptyString(
      requiredKey(obj, "reason", site),
      at(site, "reason"),
    ),
    scope: decodeNodeTextState(
      requiredKey(obj, "scope", site),
      at(site, "scope"),
    ),
    context: expectArray(requiredKey(obj, "context", site), contextSite).map(
      (element, index) => decodeNodeTextState(element, at(contextSite, index)),
    ),
    origin: expectArray(requiredKey(obj, "origin", site), originSite).map(
      (element, index) => decodeOriginEntry(element, at(originSite, index)),
    ),
    // Recorded relevant state (10.2, 10.4): product-shaped, required to be
    // present, passed through whole for the tests to compare.
    baseline: requiredMember(obj, "baseline", site),
    current: requiredMember(obj, "current", site),
  };
  const note = optionalKey(obj, "note");
  if (note !== undefined) {
    item.note = expectString(note, at(site, "note"));
  }
  return item;
}

/** `review show <name> <item-id>` (T10.7-8): the full item. */
export function decodeItemReport(doc: unknown, context?: string): ReviewItem {
  return decodeReviewItemValue(doc, rootSite("review show", context));
}

/**
 * `review next` (T10.7-7): the first needing-review unblocked item in item
 * order with its self-contained payload, or the fully-resolved report with
 * no item. A document claiming both (or neither) is contradictory.
 */
export function decodeNextReport(doc: unknown, context?: string): NextReport {
  const site = rootSite("review next", context);
  const obj = expectObject(doc, site);
  const fullyResolved = expectBoolean(
    requiredKey(obj, "fullyResolved", site),
    at(site, "fullyResolved"),
  );
  if (fullyResolved) {
    forbiddenKey(
      obj,
      "item",
      site,
      "a fully-resolved session reports no item (T10.7-7)",
    );
    return { fullyResolved };
  }
  return {
    fullyResolved,
    item: decodeReviewItemValue(
      requiredKey(obj, "item", site),
      at(site, "item"),
    ),
  };
}

/**
 * `review export` (T10.7-8): one JSON document with name, strategy, the
 * recorded creation parameters and decompositions (product-shaped, passed
 * through whole), and every item in item order.
 */
export function decodeExportReport(
  doc: unknown,
  context?: string,
): ExportReport {
  const site = rootSite("review export", context);
  const obj = expectObject(doc, site);
  const itemsSite = at(site, "items");
  return {
    name: expectNonEmptyString(
      requiredKey(obj, "name", site),
      at(site, "name"),
    ),
    strategy: expectNonEmptyString(
      requiredKey(obj, "strategy", site),
      at(site, "strategy"),
    ),
    creationParameters: requiredMember(obj, "creationParameters", site),
    decompositions: requiredMember(obj, "decompositions", site),
    items: expectArray(requiredKey(obj, "items", site), itemsSite).map(
      (element, index) => decodeReviewItemValue(element, at(itemsSite, index)),
    ),
  };
}
