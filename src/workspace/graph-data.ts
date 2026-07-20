// Graph-data storage — the I/O half (SPEC 13.3, 13.4; IMPLEMENTATION
// Architecture: storage is workspace-layer I/O).
//
// The graph data lives at `.xspec/graph.json` under the workspace root
// (SPEC 13.3: under `.xspec/`; content otherwise opaque). It is a derived
// file (SPEC 13.4): fully reproducible from sources, configuration, and the
// journal via `xspec build`; its path belongs to xspec, so a write replaces
// whatever occupies it — a symbolic link is replaced as itself and never
// written through — and a conflicted, corrupted, deleted, or orphaned store
// is correctly resolved by rebuilding. Only the reading side is here plus
// the one write, through the workspace write layer (writes.ts) like every
// product file write, so it is atomic in its observable effect (SPEC 13.5).
//
// Serialization, parsing, and the compare-with-current predicate are the
// pure core's (src/core/graph-data.ts). Loading classifies the occupant
// with lstat: only a plain file is read (a non-plain occupant loads as
// missing — it cannot match the current sources and configuration, so the
// refreshing reads replace it and `check` reports it stale, SPEC 13.3,
// 14.10); bytes that are not valid UTF-8 or do not parse as the stored
// shape load with a null model (malformed — same consequence, and the
// derived-file record is unrecoverable, SPEC 13.4).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { GraphData } from "../core/graph-data.js";
import {
  GRAPH_DATA_PATH,
  parseGraphData,
  serializeGraphData,
} from "../core/graph-data.js";
import { classifyOccupant, writeDerivedFile } from "./writes.js";

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** The loaded store: raw bytes and, when they parse, the model. */
export interface LoadedGraphData {
  /**
   * The stored file's exact bytes — null when nothing is loadable: the
   * path is absent or occupied by anything other than a plain file
   * (SPEC 13.4: a derived path's occupant is resolved by rebuilding).
   */
  readonly bytes: Uint8Array | null;
  /**
   * The parsed model — null when `bytes` is null or the bytes are
   * malformed (not UTF-8, not JSON, or not the stored shape). Feed this
   * with `bytes` to `graphDataMatchesCurrent` (core) for the staleness
   * predicate, and to `recordedDerivedFiles` (core) for orphan handling.
   */
  readonly data: GraphData | null;
}

/** The graph-data file's absolute path under the workspace root. */
function graphDataAbsolutePath(root: string): string {
  return path.join(root, ...GRAPH_DATA_PATH.split("/"));
}

/**
 * Load the workspace's graph data (SPEC 13.3). Never throws on the
 * expected states: an absent file, a non-plain occupant, or malformed
 * content all load as "does not match" inputs for the predicate — the
 * refresh, failure, and staleness behaviors are the callers' (SPEC 13.3,
 * 14.10).
 */
export async function loadGraphData(root: string): Promise<LoadedGraphData> {
  const absolute = graphDataAbsolutePath(root);
  if ((await classifyOccupant(absolute)) !== "file") {
    return { bytes: null, data: null };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fsp.readFile(absolute);
  } catch {
    // The occupant changed between classification and read (SPEC 13.5:
    // concurrent commands, last-write-wins): load as missing.
    return { bytes: null, data: null };
  }
  let text: string;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    return { bytes, data: null };
  }
  return { bytes, data: parseGraphData(text) };
}

/**
 * Write the graph data (SPEC 13.3): the canonical serialization (core) at
 * `.xspec/graph.json`, through the derived-file write primitive — atomic
 * in its observable effect (SPEC 13.5), replacing whatever occupies the
 * path (SPEC 13.4). Byte-deterministic for a given workspace (SPEC 12.0).
 * Callers validate the write path first (SPEC 14.22,
 * `symlinkWritePathFindings`) and write only for workspaces that pass
 * build validation — a failed build or refresh writes nothing (SPEC 12.1,
 * 13.3).
 */
export async function writeGraphData(
  root: string,
  data: GraphData,
): Promise<void> {
  await writeDerivedFile(root, GRAPH_DATA_PATH, serializeGraphData(data));
}
