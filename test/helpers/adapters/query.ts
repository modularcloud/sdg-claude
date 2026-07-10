// H-3 output adapters — query-surface commands: `query node`, `show`,
// `query nodes`/`subtree`/`ancestors`, `query edges`, `query reachable`, and
// `ids` (TEST-SPEC §11, T12.3-1, T12.4-1).
//
// This module is shape-aware and value-blind: it maps the product's concrete
// JSON output onto the information model in model.ts, failing loudly
// (diagnosed test error, never a default) when required information is
// absent or malformed. It is one of the only places aware of concrete output
// shape (H-3); adjust the ASSUMED SHAPE below when the real product's shape
// legitimately differs — never adjust values.
//
// ASSUMED SHAPE (per command; `?` marks optional-per-model information):
//   query node / show →
//     { "identity", "sourceRange": {"start","end"}, "ownText", "subtreeText",
//       "hashes": {"ownHash","subtreeHash","effectiveHash","metadataHash"},
//       "tags": [..], "coverage"?, "edges": {"incoming": [Edge], "outgoing": [Edge]} }
//     Edge = { "from", "to", "kind" }
//   query nodes / subtree / ancestors →
//     { "nodes": [ { "identity", "sourceRange", "tags", "coverage"? } ] }
//   query edges → { "edges": [Edge] }
//   query reachable → { "reachable": bool, "path"?: [identity...] }
//     ("path" present exactly when reachable)
//   ids → { "files": [ { "file", "ids": [id...] } ] }
//   ids --tree → { "files": [ { "file", "nodes": [ { "id", "children": [...] } ] } ] }

import type {
  GraphEdge,
  IdsFileEntry,
  IdsReport,
  IdsTreeFileEntry,
  IdsTreeNode,
  IdsTreeReport,
  NodeHashes,
  NodeReport,
  NodeRow,
  NodeSummary,
  ReachableReport,
  SourceRange,
} from "./model.js";
import { EDGE_KINDS } from "./model.js";
import type { DecodeSite } from "./decode.js";
import {
  at,
  decodeFail,
  expectArray,
  expectBoolean,
  expectNonEmptyString,
  expectNonEmptyStringArray,
  expectNonNegativeInteger,
  expectObject,
  expectString,
  expectStringArray,
  expectToken,
  forbiddenKey,
  optionalKey,
  requiredKey,
  rootSite,
} from "./decode.js";

/** Decode a source range (SPEC.md 1.7: zero-based byte offsets). */
export function decodeSourceRange(
  value: unknown,
  site: DecodeSite,
): SourceRange {
  const obj = expectObject(value, site);
  const start = expectNonNegativeInteger(
    requiredKey(obj, "start", site),
    at(site, "start"),
  );
  const end = expectNonNegativeInteger(
    requiredKey(obj, "end", site),
    at(site, "end"),
  );
  if (end < start) {
    decodeFail(site, "a range with end >= start", value);
  }
  return { start, end };
}

/** Decode one edge: from/to graph-node identities plus a spec-fixed kind. */
export function decodeEdge(value: unknown, site: DecodeSite): GraphEdge {
  const obj = expectObject(value, site);
  return {
    from: expectNonEmptyString(
      requiredKey(obj, "from", site),
      at(site, "from"),
    ),
    to: expectNonEmptyString(requiredKey(obj, "to", site), at(site, "to")),
    kind: expectToken(
      requiredKey(obj, "kind", site),
      EDGE_KINDS,
      at(site, "kind"),
    ),
  };
}

function decodeEdgeArray(value: unknown, site: DecodeSite): GraphEdge[] {
  return expectArray(value, site).map((element, index) =>
    decodeEdge(element, at(site, index)),
  );
}

function decodeHashes(value: unknown, site: DecodeSite): NodeHashes {
  const obj = expectObject(value, site);
  const hash = (key: string): string =>
    expectNonEmptyString(requiredKey(obj, key, site), at(site, key));
  return {
    ownHash: hash("ownHash"),
    subtreeHash: hash("subtreeHash"),
    effectiveHash: hash("effectiveHash"),
    metadataHash: hash("metadataHash"),
  };
}

/** Coverage attribute: absent (root) or a non-empty string. */
function decodeCoverage(
  obj: Record<string, unknown>,
  site: DecodeSite,
): string | undefined {
  const value = optionalKey(obj, "coverage");
  if (value === undefined) return undefined;
  return expectNonEmptyString(value, at(site, "coverage"));
}

/**
 * `query node` / `show` (T11-1, T12.4-1): identity, source range, own and
 * subtree text, all four hashes, tags, coverage attribute (absent for roots),
 * and incoming and outgoing edges by kind.
 */
export function decodeNodeReport(doc: unknown, context?: string): NodeReport {
  const site = rootSite("query node/show", context);
  const obj = expectObject(doc, site);
  const edgesSite = at(site, "edges");
  const edges = expectObject(requiredKey(obj, "edges", site), edgesSite);
  return {
    identity: expectNonEmptyString(
      requiredKey(obj, "identity", site),
      at(site, "identity"),
    ),
    sourceRange: decodeSourceRange(
      requiredKey(obj, "sourceRange", site),
      at(site, "sourceRange"),
    ),
    ownText: expectString(
      requiredKey(obj, "ownText", site),
      at(site, "ownText"),
    ),
    subtreeText: expectString(
      requiredKey(obj, "subtreeText", site),
      at(site, "subtreeText"),
    ),
    hashes: decodeHashes(requiredKey(obj, "hashes", site), at(site, "hashes")),
    tags: expectStringArray(requiredKey(obj, "tags", site), at(site, "tags")),
    coverage: decodeCoverage(obj, site),
    incomingEdges: decodeEdgeArray(
      requiredKey(edges, "incoming", edgesSite),
      at(edgesSite, "incoming"),
    ),
    outgoingEdges: decodeEdgeArray(
      requiredKey(edges, "outgoing", edgesSite),
      at(edgesSite, "outgoing"),
    ),
  };
}

/**
 * Minimal `query node` decoding — identity and tags only (T1.4-2, T1.4-4).
 * Those tests are in CERTIFICATIONS.md §CONF-VALID's scope, which pins the
 * fixture product's query surface to reporting identity, tags, and
 * metadataHash: decoding the full node report would demand information the
 * scoped fixture never promises. The two keys read here are the `query node`
 * shape's own (see the ASSUMED SHAPE above); everything else in the document
 * is ignored, not validated.
 */
export function decodeNodeSummary(doc: unknown, context?: string): NodeSummary {
  const site = rootSite("query node (identity/tags summary)", context);
  const obj = expectObject(doc, site);
  return {
    identity: expectNonEmptyString(
      requiredKey(obj, "identity", site),
      at(site, "identity"),
    ),
    tags: expectStringArray(requiredKey(obj, "tags", site), at(site, "tags")),
  };
}

function decodeNodeRow(value: unknown, site: DecodeSite): NodeRow {
  const obj = expectObject(value, site);
  return {
    identity: expectNonEmptyString(
      requiredKey(obj, "identity", site),
      at(site, "identity"),
    ),
    sourceRange: decodeSourceRange(
      requiredKey(obj, "sourceRange", site),
      at(site, "sourceRange"),
    ),
    tags: expectStringArray(requiredKey(obj, "tags", site), at(site, "tags")),
    coverage: decodeCoverage(obj, site),
  };
}

/**
 * `query nodes` / `query subtree` / `query ancestors` (T11-2, T11-3): rows in
 * the reported order, each with the one row contract — identity, source
 * range, tags, coverage attribute (absent for roots).
 */
export function decodeNodeRowsReport(
  doc: unknown,
  context?: string,
): NodeRow[] {
  const site = rootSite("query nodes/subtree/ancestors", context);
  const obj = expectObject(doc, site);
  const rowsSite = at(site, "nodes");
  return expectArray(requiredKey(obj, "nodes", site), rowsSite).map(
    (element, index) => decodeNodeRow(element, at(rowsSite, index)),
  );
}

/** `query edges` (T11-4): the edge list in the reported order. */
export function decodeEdgesReport(doc: unknown, context?: string): GraphEdge[] {
  const site = rootSite("query edges", context);
  const obj = expectObject(doc, site);
  return decodeEdgeArray(requiredKey(obj, "edges", site), at(site, "edges"));
}

/**
 * `query reachable` (T11-5): whether a dependency path exists, and — exactly
 * when one does — one shortest witness path as a node-identity sequence. A
 * document claiming reachability without a path, or a path without
 * reachability, is contradictory and rejected.
 */
export function decodeReachableReport(
  doc: unknown,
  context?: string,
): ReachableReport {
  const site = rootSite("query reachable", context);
  const obj = expectObject(doc, site);
  const reachable = expectBoolean(
    requiredKey(obj, "reachable", site),
    at(site, "reachable"),
  );
  if (!reachable) {
    forbiddenKey(obj, "path", site, "no witness path exists when unreachable");
    return { reachable };
  }
  const pathSite = at(site, "path");
  const path = expectNonEmptyStringArray(
    requiredKey(obj, "path", site),
    pathSite,
  );
  if (path.length === 0) {
    decodeFail(
      pathSite,
      "a non-empty witness path when reachable",
      obj["path"],
    );
  }
  return { reachable, path };
}

/** `ids` (T12.3-1): files in byte order, IDs within a file in document order. */
export function decodeIdsReport(doc: unknown, context?: string): IdsReport {
  const site = rootSite("ids", context);
  const obj = expectObject(doc, site);
  const filesSite = at(site, "files");
  const files: IdsFileEntry[] = expectArray(
    requiredKey(obj, "files", site),
    filesSite,
  ).map((element, index) => {
    const entrySite = at(filesSite, index);
    const entry = expectObject(element, entrySite);
    return {
      file: expectNonEmptyString(
        requiredKey(entry, "file", entrySite),
        at(entrySite, "file"),
      ),
      ids: expectNonEmptyStringArray(
        requiredKey(entry, "ids", entrySite),
        at(entrySite, "ids"),
      ),
    };
  });
  return { files };
}

function decodeIdsTreeNode(value: unknown, site: DecodeSite): IdsTreeNode {
  const obj = expectObject(value, site);
  const childrenSite = at(site, "children");
  return {
    id: expectNonEmptyString(requiredKey(obj, "id", site), at(site, "id")),
    children: expectArray(requiredKey(obj, "children", site), childrenSite).map(
      (element, index) => decodeIdsTreeNode(element, at(childrenSite, index)),
    ),
  };
}

/** `ids --tree` (T12.3-1): per-file nesting in file and document order. */
export function decodeIdsTreeReport(
  doc: unknown,
  context?: string,
): IdsTreeReport {
  const site = rootSite("ids --tree", context);
  const obj = expectObject(doc, site);
  const filesSite = at(site, "files");
  const files: IdsTreeFileEntry[] = expectArray(
    requiredKey(obj, "files", site),
    filesSite,
  ).map((element, index) => {
    const entrySite = at(filesSite, index);
    const entry = expectObject(element, entrySite);
    const nodesSite = at(entrySite, "nodes");
    return {
      file: expectNonEmptyString(
        requiredKey(entry, "file", entrySite),
        at(entrySite, "file"),
      ),
      nodes: expectArray(requiredKey(entry, "nodes", entrySite), nodesSite).map(
        (node, nodeIndex) => decodeIdsTreeNode(node, at(nodesSite, nodeIndex)),
      ),
    };
  });
  return { files };
}
