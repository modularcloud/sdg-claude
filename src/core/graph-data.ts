// Graph data — the serializable store model (SPEC 13.3).
//
// Pure core (IMPLEMENTATION Architecture: serialization is core —
// deterministic, I/O-free; storage I/O is the workspace layer's,
// src/workspace/graph-data.ts): xspec maintains graph data under `.xspec/`,
// containing requirement nodes, code locations, edges by kind, source
// ranges (SPEC 1.7), all four hashes (SPEC 5.5), coverage attributes
// (SPEC 2.5), tags (SPEC 2.6), and the paths of the derived files most
// recently generated (SPEC 13.3, 13.4). This module defines that content:
//
// - the stored model — a plain-data snapshot of the assembled workspace
//   graph (./graph.ts) plus the recorded derived-file paths;
// - `buildGraphSnapshot` — the pure derivation of the snapshot from the
//   graph and its computed hashes (./hashes.ts);
// - `serializeGraphData`/`parseGraphData` — the byte encoding through the
//   one canonical serializer (./canonical-json.ts; IMPLEMENTATION: stored
//   JSON goes through one canonical serializer — sorted keys, stable
//   ordering, trailing newline), byte-deterministic for a given workspace
//   (SPEC 12.0: no wall-clock values, no randomness, no absolute paths —
//   every stored path is workspace-relative, SPEC 1.5);
// - the compare-with-current predicate `graphDataMatchesCurrent` — shared
//   by refresh-on-read (SPEC 13.3) and `check`'s staleness finding
//   (SPEC 14.10), so both judge the store by one rule.
//
// The two parts age differently (SPEC 13.3): the snapshot is a pure
// function of the current sources, configuration, and journal, and
// "graph data does not match the current sources and configuration"
// exactly when the stored bytes differ from a re-serialization holding the
// current snapshot; the recorded derived-file paths are updated only by
// generation (`xspec build`, and the commands that regenerate as `build`
// does) — a refresh leaves them unchanged, and the record legitimately
// outlives the generation set (that is what makes orphan removal and
// 14.10's recorded-orphan arm possible, SPEC 13.3, 13.4, 12.1). A refresh
// writes exactly what `xspec build` would write except for that record
// clause (SPEC 13.3): with a recoverable record, build's data with the
// stored record preserved; with none — the store missing or malformed —
// there are no recorded paths to preserve, and the written data is exactly
// build's, would-be record included. The predicate compares against the
// same refreshed form, so both judge the store by one rule.
//
// The content is otherwise opaque (SPEC 13.3): its observable contract is
// its location under `.xspec/`, its classification as a derived file
// (SPEC 13.4), and the refresh, failure, and staleness behaviors — the
// concrete JSON shape here is an implementation choice, versioned so a
// future shape change reads as "does not match" rather than misparsing.

import type { ByteRange } from "./bytes.js";
import { compareBytes } from "./bytes.js";
import type { JsonValue } from "./canonical-json.js";
import { canonicalJson } from "./canonical-json.js";
import type { GraphEdge, GraphEdgeKind, WorkspaceGraph } from "./graph.js";
import type { NodeHashes } from "./hashes.js";
import type { WorkspaceTextModel } from "./text-model.js";

/** SPEC 13.3/13.4: the graph-data file's workspace-relative path. */
export const GRAPH_DATA_PATH = ".xspec/graph.json";

/**
 * The stored format version: a parsed file of any other version is
 * malformed (parse yields null), so it reads as not matching the current
 * sources and configuration and is refreshed or rebuilt (SPEC 13.3).
 */
const GRAPH_DATA_VERSION = 2;

/** One recorded derivation input: a discovered source and its fingerprint. */
export interface StoredSourceInput {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** SHA-256 (hex) of the source's exact bytes. */
  readonly hash: string;
}

/**
 * The recorded derivation inputs (SPEC 13.3). The snapshot is a pure
 * function of the current sources, configuration, and journal (SPEC 12.0
 * determinism), so these fingerprints — the configuration file's content
 * hash with its parsed form, the journal's content hash, and every
 * discovered source's content hash — certify the stored snapshot for
 * byte-identical current inputs. The store-backed read fast path
 * (workspace/fast-read.ts) answers from a store whose recorded inputs all
 * match without re-deriving; any mismatch falls back to the full pipeline,
 * whose compare-and-refresh behavior is unchanged.
 */
export interface StoredInputs {
  /** SHA-256 (hex) of the configuration file's exact bytes. */
  readonly configHash: string;
  /**
   * The parsed configuration's plain form (core/config-data.ts) — the
   * recorded parse the fast path recovers instead of re-parsing.
   */
  readonly config: JsonValue;
  /**
   * SHA-256 (hex) of the journal file's exact bytes — null when the
   * journal is absent (an empty journal, SPEC 6.1). The journal is a
   * derivation input (SPEC 5.4).
   */
  readonly journalHash: string | null;
  /**
   * Every discovered source with its content fingerprint, in byte order of
   * path (SPEC 12.0). The discovered set itself is part of the record: a
   * current discovery yielding any other path set is a mismatch.
   */
  readonly sources: readonly StoredSourceInput[];
}

/** One stored requirement node (SPEC 13.3, 5.1). */
export interface StoredRequirementNode {
  /** SPEC 1.5: `path#id`, or the bare path for the root node. */
  readonly identity: string;
  /** Workspace-relative `/`-separated source file path (SPEC 1.5). */
  readonly path: string;
  /** The requirement ID — null exactly for the root node (SPEC 1.2). */
  readonly id: string | null;
  /** SPEC 1.7: the construct's byte range; the entire file for a root. */
  readonly range: ByteRange;
  /** SPEC 2.5: the effective coverage attribute — null for a root. */
  readonly coverage: "required" | "none" | null;
  /** SPEC 2.6: the node's tags, in first-occurrence order. */
  readonly tags: readonly string[];
  /** SPEC 5.5: the node's four hashes. */
  readonly hashes: NodeHashes;
  /** SPEC 1.6: the node's own text, fully expanded (SPEC 11, 12.4). */
  readonly ownText: string;
  /** SPEC 1.6: the node's subtree text, fully expanded (SPEC 11, 12.4). */
  readonly subtreeText: string;
}

/** One stored code location (SPEC 13.3, 5.1, 4.6). */
export interface StoredCodeLocation {
  /** SPEC 4.6: `path`, `path#unit`, or `path#unit@N`. */
  readonly identity: string;
  /** Workspace-relative `/`-separated code file path (SPEC 1.5). */
  readonly path: string;
}

/**
 * The graph-content part of the store: a pure function of the current
 * sources, configuration, and journal (SPEC 13.3) — the part the
 * compare-with-current predicate judges.
 */
export interface GraphSnapshot {
  /** In graph order: files in byte order, document order within a file. */
  readonly requirements: readonly StoredRequirementNode[];
  /** In graph order: files in byte order, whole file before its units. */
  readonly codeLocations: readonly StoredCodeLocation[];
  /** The collapsed edge set in (source, kind, target) order (SPEC 5.2). */
  readonly edges: readonly GraphEdge[];
}

/** The complete stored graph data (SPEC 13.3). */
export interface GraphData {
  readonly snapshot: GraphSnapshot;
  /** The recorded derivation inputs of the snapshot (see `StoredInputs`). */
  readonly inputs: StoredInputs;
  /**
   * SPEC 13.3/13.4: the workspace-relative paths of the derived files most
   * recently generated — generated TypeScript modules and companions
   * (13.1) and emitted Markdown (13.2). Updated only by generation;
   * refresh preserves it. Orphan removal (12.1) and 14.10's
   * recorded-orphan finding rely on exactly this record.
   */
  readonly derivedFiles: readonly string[];
}

/**
 * Derive the storable snapshot from the assembled graph and its computed
 * hashes (SPEC 13.3): every requirement node with its source range,
 * coverage attribute, tags, four hashes, and fully expanded own and
 * subtree text (SPEC 1.6 — recorded so the store answers the node report
 * of SPEC 11/12.4 without re-deriving); every code location; every edge.
 * Deterministic: everything is emitted in the graph's own fixed order
 * (SPEC 12.0). `hashes` must be the computation over this same graph
 * (./hashes.ts covers every requirement node), `textModel` the model over
 * the same documents.
 */
export function buildGraphSnapshot(
  graph: WorkspaceGraph,
  hashes: ReadonlyMap<string, NodeHashes>,
  textModel: WorkspaceTextModel,
): GraphSnapshot {
  const requirements = graph.requirementNodes.map(
    (node): StoredRequirementNode => {
      const nodeHashes = hashes.get(node.identity);
      if (nodeHashes === undefined) {
        throw new Error(
          `xspec internal error: no hashes computed for ${node.identity}`,
        );
      }
      return {
        identity: node.identity,
        path: node.path,
        id: node.id,
        range: { start: node.section.range.start, end: node.section.range.end },
        coverage: node.section.coverage,
        tags: node.section.tags,
        hashes: nodeHashes,
        ownText: textModel.ownText(node.document, node.section),
        subtreeText: textModel.subtreeText(node.document, node.section),
      };
    },
  );
  const codeLocations = graph.codeLocations.map((node): StoredCodeLocation => ({
    identity: node.identity,
    path: node.path,
  }));
  const edges = graph.edges.map((edge): GraphEdge => ({
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
  }));
  return { requirements, codeLocations, edges };
}

/**
 * The graph data a refresh writes (SPEC 13.3): exactly what `xspec build`
 * would write, except the recorded derived-file paths are left unchanged.
 * `build` is what the build would write for the current sources and
 * configuration — snapshot plus the would-be generated set as its record
 * (core/build.ts, `BuildOutputs.graphData`). With a recoverable record the
 * refresh preserves it (the record is updated only by generation, and it
 * legitimately outlives the generation set — SPEC 13.3, 13.4); with none —
 * the store missing or malformed — there are no recorded paths to leave
 * unchanged, and the refresh writes build's data as is. Files orphaned
 * while the record was missing stay outside xspec's knowledge either way
 * (SPEC 13.4): the would-be record names only currently generated paths,
 * never such orphans. `build` itself does not use this — it records the
 * paths it just generated.
 */
export function refreshedGraphData(
  stored: GraphData | null,
  build: GraphData,
): GraphData {
  return stored === null
    ? build
    : {
        snapshot: build.snapshot,
        inputs: build.inputs,
        derivedFiles: stored.derivedFiles,
      };
}

/**
 * The recorded derived-file paths of a loaded store (SPEC 13.3), for
 * orphan removal (SPEC 12.1, 13.4) and 14.10's recorded-orphan arm. A
 * missing or malformed store records nothing: such orphans are outside
 * xspec's knowledge and are never removed (SPEC 13.4).
 */
export function recordedDerivedFiles(
  data: GraphData | null,
): readonly string[] {
  return data === null ? [] : data.derivedFiles;
}

/**
 * The compare-with-current predicate (SPEC 13.3, 14.10): whether the
 * stored graph data matches the current sources and configuration —
 * operationally, whether the stored bytes are exactly what a refresh
 * would write (`refreshedGraphData` over `build`, what `xspec build`
 * would write for the current sources and configuration). False when the
 * store is missing (`storedBytes` null) or malformed (`storedData` null —
 * its bytes cannot equal a canonical serialization, which always parses).
 * The refreshing reads refresh exactly when this is false (SPEC 13.3);
 * `check`, which never refreshes, reports the graph-data file stale
 * exactly when this is false (SPEC 14.10) — by the same rule, so the
 * retained derived-file record never reads as staleness (SPEC 13.3: the
 * record is mandated to be left unchanged).
 */
export function graphDataMatchesCurrent(
  storedBytes: Uint8Array | null,
  storedData: GraphData | null,
  build: GraphData,
): boolean {
  if (storedBytes === null) {
    return false;
  }
  const expected = utf8Encoder.encode(
    serializeGraphData(refreshedGraphData(storedData, build)),
  );
  return bytesEqual(storedBytes, expected);
}

// ---------------------------------------------------------------------------
// Serialization (the canonical byte encoding)
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();

/** Exact byte equality of two byte sequences (SPEC 12.0 comparisons). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Serialize graph data to its stored text: the canonical serializer over
 * the versioned shape (IMPLEMENTATION: one canonical serializer — sorted
 * keys, stable ordering, trailing newline). Byte-deterministic for a given
 * workspace (SPEC 13.3, 12.0): the snapshot enters in the graph's fixed
 * order and the recorded derived-file paths enter deduplicated in byte
 * order.
 */
export function serializeGraphData(data: GraphData): string {
  const value: JsonValue = {
    version: GRAPH_DATA_VERSION,
    inputs: {
      configHash: data.inputs.configHash,
      config: data.inputs.config,
      journalHash: data.inputs.journalHash,
      // Byte order of path (SPEC 12.0); collection order is discovery
      // order, already byte-ordered — sorting keeps the serialization
      // order-independent of its inputs.
      sources: [...data.inputs.sources]
        .sort((a, b) => compareBytes(a.path, b.path))
        .map((source): JsonValue => ({
          path: source.path,
          hash: source.hash,
        })),
    },
    derivedFiles: [...new Set(data.derivedFiles)].sort(compareBytes),
    requirements: data.snapshot.requirements.map(requirementToJson),
    codeLocations: data.snapshot.codeLocations.map((location): JsonValue => ({
      identity: location.identity,
      path: location.path,
    })),
    edges: data.snapshot.edges.map((edge): JsonValue => ({
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
    })),
  };
  return canonicalJson(value);
}

function requirementToJson(node: StoredRequirementNode): JsonValue {
  return {
    identity: node.identity,
    path: node.path,
    id: node.id,
    range: { start: node.range.start, end: node.range.end },
    coverage: node.coverage,
    tags: [...node.tags],
    hashes: {
      ownHash: node.hashes.ownHash,
      subtreeHash: node.hashes.subtreeHash,
      effectiveHash: node.hashes.effectiveHash,
      metadataHash: node.hashes.metadataHash,
    },
    ownText: node.ownText,
    subtreeText: node.subtreeText,
  };
}

// ---------------------------------------------------------------------------
// Parsing (structural validation; anything else is malformed)
// ---------------------------------------------------------------------------

/** SPEC 5.2: the four edge kinds, for runtime validation. */
const EDGE_KINDS: ReadonlySet<string> = new Set([
  "contains",
  "depends",
  "embeds",
  "references",
]);

/**
 * Parse stored graph-data text. Returns null — malformed — for anything
 * that is not the versioned shape `serializeGraphData` writes: not JSON,
 * a different version, or structurally invalid fields. A malformed store
 * never matches the current sources and configuration (SPEC 13.3), so it
 * is refreshed by the reading commands and reported stale by `check`
 * (SPEC 14.10); its derived-file record is unrecoverable, leaving any
 * orphans outside xspec's knowledge (SPEC 13.4).
 */
export function parseGraphData(text: string): GraphData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["version"] !== GRAPH_DATA_VERSION) {
    return null;
  }
  const inputs = parseInputs(raw["inputs"]);
  const derivedFiles = parseStringArray(raw["derivedFiles"]);
  const requirements = parseArray(raw["requirements"], parseRequirement);
  const codeLocations = parseArray(raw["codeLocations"], parseCodeLocation);
  const edges = parseArray(raw["edges"], parseEdge);
  if (
    inputs === null ||
    derivedFiles === null ||
    requirements === null ||
    codeLocations === null ||
    edges === null
  ) {
    return null;
  }
  return {
    snapshot: { requirements, codeLocations, edges },
    inputs,
    derivedFiles,
  };
}

function parseSourceInput(value: unknown): StoredSourceInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const path = value["path"];
  const hash = value["hash"];
  if (typeof path !== "string" || typeof hash !== "string") {
    return null;
  }
  return { path, hash };
}

function parseInputs(value: unknown): StoredInputs | null {
  if (!isRecord(value)) {
    return null;
  }
  const configHash = value["configHash"];
  const journalHash = value["journalHash"];
  const sources = parseArray(value["sources"], parseSourceInput);
  if (
    typeof configHash !== "string" ||
    (journalHash !== null && typeof journalHash !== "string") ||
    sources === null ||
    !("config" in value)
  ) {
    return null;
  }
  // The recorded parse (`config`) is structurally validated at use
  // (core/config-data.ts `configurationFromStored`); here it must only be
  // JSON data, which a parsed JSON document's field always is.
  return {
    configHash,
    config: value["config"] as JsonValue,
    journalHash,
    sources,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative safe integer (SPEC 1.7 byte offsets). */
function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: T[] = [];
  for (const raw of value) {
    const item = parseItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return items;
}

function parseStringArray(value: unknown): string[] | null {
  return parseArray(value, (item) => (typeof item === "string" ? item : null));
}

function parseRange(value: unknown): ByteRange | null {
  if (!isRecord(value)) {
    return null;
  }
  const start = value["start"];
  const end = value["end"];
  if (!isOffset(start) || !isOffset(end) || end < start) {
    return null;
  }
  return { start, end };
}

function parseHashes(value: unknown): NodeHashes | null {
  if (!isRecord(value)) {
    return null;
  }
  const ownHash = value["ownHash"];
  const subtreeHash = value["subtreeHash"];
  const effectiveHash = value["effectiveHash"];
  const metadataHash = value["metadataHash"];
  if (
    typeof ownHash !== "string" ||
    typeof subtreeHash !== "string" ||
    typeof effectiveHash !== "string" ||
    typeof metadataHash !== "string"
  ) {
    return null;
  }
  return { ownHash, subtreeHash, effectiveHash, metadataHash };
}

function parseRequirement(value: unknown): StoredRequirementNode | null {
  if (!isRecord(value)) {
    return null;
  }
  const identity = value["identity"];
  const path = value["path"];
  const id = value["id"];
  const coverage = value["coverage"];
  if (typeof identity !== "string" || typeof path !== "string") {
    return null;
  }
  if (id !== null && typeof id !== "string") {
    return null;
  }
  if (coverage !== "required" && coverage !== "none" && coverage !== null) {
    return null;
  }
  const range = parseRange(value["range"]);
  const tags = parseStringArray(value["tags"]);
  const hashes = parseHashes(value["hashes"]);
  const ownText = value["ownText"];
  const subtreeText = value["subtreeText"];
  if (
    range === null ||
    tags === null ||
    hashes === null ||
    typeof ownText !== "string" ||
    typeof subtreeText !== "string"
  ) {
    return null;
  }
  return {
    identity,
    path,
    id,
    range,
    coverage,
    tags,
    hashes,
    ownText,
    subtreeText,
  };
}

function parseCodeLocation(value: unknown): StoredCodeLocation | null {
  if (!isRecord(value)) {
    return null;
  }
  const identity = value["identity"];
  const path = value["path"];
  if (typeof identity !== "string" || typeof path !== "string") {
    return null;
  }
  return { identity, path };
}

function parseEdge(value: unknown): GraphEdge | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const source = value["source"];
  const target = value["target"];
  if (
    typeof kind !== "string" ||
    !EDGE_KINDS.has(kind) ||
    typeof source !== "string" ||
    typeof target !== "string"
  ) {
    return null;
  }
  return { kind: kind as GraphEdgeKind, source, target };
}
