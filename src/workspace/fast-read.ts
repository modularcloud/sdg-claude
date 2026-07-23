// The store-backed read fast path (SPEC 13.3).
//
// A read command's answer is a pure function of the workspace bytes
// (SPEC 12.0), and the stored graph data records the derivation inputs it
// was computed from — the configuration file's content hash with its parsed
// form, the journal's content hash, and every discovered source's content
// hash (core/graph-data.ts `StoredInputs`). When every recorded input
// matches the current bytes, the stored snapshot IS what the full pipeline
// would re-derive (SPEC 12.0 determinism), the store already "matches the
// current sources and configuration" (SPEC 13.3 — no refresh would write),
// and the query subcommands can answer from it directly — without loading
// the MDX parser or the TypeScript compiler, which is the point: a fresh
// workspace's `query` costs I/O and hashing, not a re-derivation.
//
// Verification, in order — ANY failure returns null and the caller falls
// back to the full path (cli/commands/query.ts), whose behavior is exactly
// today's; only the positive case answers here, and it is sound:
//
//  1. the store parses as the current versioned shape and its bytes are the
//     canonical serialization of what was parsed (a byte-tampered store
//     must fall back so the full path's compare-and-refresh judges it);
//  2. the configuration file's bytes hash to the recorded configHash, and
//     the recorded parse reconstructs (core/config-data.ts) — identical
//     bytes parse identically (SPEC 12.0), so re-parsing is redundant;
//  3. the journal bytes hash to the recorded journalHash (the journal is a
//     derivation input, SPEC 5.4);
//  4. discovery over the reconstructed configuration — the same walk and
//     classification the pipeline runs (./discovery.ts) — yields no
//     findings, exactly the recorded path set, and every discovered file's
//     bytes hash to the recorded fingerprint (the discovered SET is part
//     of the record: a new matching file is a mismatch).
//
// The fast path never writes (a verified store needs no refresh; SPEC
// 13.3's refreshing reads write only when the store does not match), and
// reads never modify anything (SPEC 13.4).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { configurationFromStored } from "../core/config-data.js";
import type { Configuration } from "../core/config.js";
import type { GraphData, StoredRequirementNode } from "../core/graph-data.js";
import {
  GRAPH_DATA_PATH,
  parseGraphData,
  serializeGraphData,
} from "../core/graph-data.js";
import { sha256Hex } from "../core/hash.js";
import { discoverSources } from "./discovery.js";
import { readJournalBytes } from "./journal.js";
import type { LocatedWorkspace } from "./locate.js";

/** A verified store: the parsed graph data and the recovered parse. */
export interface VerifiedStore {
  readonly configuration: Configuration;
  readonly data: GraphData;
}

/** The absolute filesystem path of a workspace-relative `/`-path. */
function absoluteOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/**
 * Load and verify the stored graph data against the current workspace
 * bytes (module header). Null — fall back to the full path — whenever
 * anything at all fails to verify.
 */
export async function verifyStoreForRead(
  located: LocatedWorkspace,
): Promise<VerifiedStore | null> {
  // 1. Store bytes: present, parseable, canonical.
  let storedBytes: Buffer;
  try {
    storedBytes = await fsp.readFile(absoluteOf(located.root, GRAPH_DATA_PATH));
  } catch {
    return null;
  }
  let storedText: string;
  try {
    storedText = new TextDecoder("utf-8", { fatal: true }).decode(storedBytes);
  } catch {
    return null;
  }
  const data = parseGraphData(storedText);
  if (data === null || serializeGraphData(data) !== storedText) {
    return null;
  }

  // 2. Configuration: recorded content hash and recoverable parse.
  if (sha256Hex(located.configBytes) !== data.inputs.configHash) {
    return null;
  }
  const configuration = configurationFromStored(data.inputs.config);
  if (configuration === null) {
    return null;
  }

  // 3. Journal: recorded content hash (null = absent, SPEC 6.1).
  const journalBytes = await readJournalBytes(located.root);
  const journalHash = journalBytes === null ? null : sha256Hex(journalBytes);
  if (journalHash !== data.inputs.journalHash) {
    return null;
  }

  // 4. Discovery: the same walk the pipeline runs, then byte fingerprints.
  const classification = await discoverSources(located.root, configuration);
  if (classification.findings.length > 0) {
    return null;
  }
  const discovered = [
    ...classification.specSources,
    ...classification.codeSources,
  ].map((source) => source.path);
  const recorded = new Map(
    data.inputs.sources.map((source) => [source.path, source.hash]),
  );
  if (discovered.length !== recorded.size) {
    return null;
  }
  for (const sourcePath of discovered) {
    const expected = recorded.get(sourcePath);
    if (expected === undefined) {
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(absoluteOf(located.root, sourcePath));
    } catch {
      return null;
    }
    if (sha256Hex(bytes) !== expected) {
      return null;
    }
  }

  return { configuration, data };
}

/**
 * The verified store's requirement rows in graph order with structural
 * indexes — the data behind the store-backed query view
 * (cli/commands/query-fast.ts). Children are ordered by row position:
 * stored requirements are in graph order (files in byte order, document
 * order within a file), so a node's children — always of the same file —
 * appear in document order (SPEC 5.2 `contains`; core/graph.ts
 * `childrenOf`).
 */
export interface StoreIndexes {
  readonly rowIndex: ReadonlyMap<string, number>;
  readonly childIdentities: ReadonlyMap<string, readonly string[]>;
  readonly parentIdentity: ReadonlyMap<string, string>;
  readonly codeIdentities: ReadonlySet<string>;
}

/** Build the structural indexes of a verified store (SPEC 5.2, 1.2). */
export function storeIndexes(data: GraphData): StoreIndexes {
  const rowIndex = new Map<string, number>();
  data.snapshot.requirements.forEach(
    (node: StoredRequirementNode, index: number) => {
      rowIndex.set(node.identity, index);
    },
  );
  const childLists = new Map<string, string[]>();
  const parentIdentity = new Map<string, string>();
  for (const edge of data.snapshot.edges) {
    if (edge.kind !== "contains") {
      continue;
    }
    let children = childLists.get(edge.source);
    if (children === undefined) {
      childLists.set(edge.source, (children = []));
    }
    children.push(edge.target);
    parentIdentity.set(edge.target, edge.source);
  }
  // Document order (row order), not edge order: the edge set is in
  // (source, kind, target) order, which sorts a node's children by
  // identity bytes — core/graph.ts orders children by document position.
  for (const children of childLists.values()) {
    children.sort((a, b) => (rowIndex.get(a) ?? -1) - (rowIndex.get(b) ?? -1));
  }
  return {
    rowIndex,
    childIdentities: childLists,
    parentIdentity,
    codeIdentities: new Set(
      data.snapshot.codeLocations.map((location) => location.identity),
    ),
  };
}
