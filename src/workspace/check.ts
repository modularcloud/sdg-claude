// `xspec check`'s staleness verification — the I/O half (SPEC 12.2, 14.10;
// IMPLEMENTATION Architecture: all filesystem access lives in the workspace
// layer).
//
// SPEC 12.2/14.10: `check` verifies that generated files are
// content-identical to what the current sources and configuration generate,
// and that no recorded derived file remains at a path no longer generated;
// each deviation is a 14.10 finding naming the file and instructing
// rebuilding. SPEC 13.3: `check` never refreshes — this module only reads
// and compares, writing nothing; the graph data itself is judged by the
// same compare-with-current predicate the refreshing reads use
// (core/graph-data.ts, `graphDataMatchesCurrent`), so the retained
// derived-file record never reads as staleness.
//
// The comparison is against the pure build derivation (core/build.ts): the
// caller computes the current `BuildOutputs` over a workspace that passed
// build validation — with invalid sources "what the current sources and
// configuration generate" is undefined, and the validation findings mask
// staleness (SPEC 14).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { BuildOutputs } from "../core/build.js";
import type { Finding } from "../core/findings.js";
import {
  GRAPH_DATA_PATH,
  graphDataMatchesCurrent,
} from "../core/graph-data.js";
import type { LoadedGraphData } from "./graph-data.js";
import { classifyOccupant, describeOccupant } from "./writes.js";

const utf8Encoder = new TextEncoder();

/** The absolute filesystem path of a workspace-relative `/`-path. */
function absoluteOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/** Exact byte equality (SPEC 12.0: comparisons are byte-wise). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** SPEC 14.10: a stale generated file — names the file, instructs rebuild. */
function staleFinding(rel: string, state: string): Finding {
  return {
    condition: 10,
    file: rel,
    message:
      `stale generated output: ${rel} ${state} what the current sources ` +
      `and configuration generate; run \`xspec build\` to regenerate every ` +
      `derived file (SPEC 14.10)`,
  };
}

/** SPEC 14.10: a recorded derived file at a no-longer-generated path. */
function orphanFinding(rel: string): Finding {
  return {
    condition: 10,
    file: rel,
    message:
      `stale generated output: the recorded derived file ${rel} remains at ` +
      `a path the current sources and configuration no longer generate; ` +
      `run \`xspec build\` to remove it (SPEC 14.10)`,
  };
}

/**
 * The SPEC 14.10 findings of `check` (SPEC 12.2), reading and comparing
 * only — nothing is written:
 *
 * - each derived file the current sources and configuration generate whose
 *   path holds different bytes, no plain file, or nothing at all;
 * - the graph data, judged by the shared compare-with-current predicate
 *   (SPEC 13.3 — the retained derived-file record is never staleness);
 * - each recorded derived file remaining (anything occupying its path) at
 *   a path the current build no longer generates (`outputs.orphans`).
 *
 * `outputs` is the pure build derivation over the current, validated
 * workspace; `stored` the loaded graph data it was derived against.
 * Deterministic order: generated files in the build's output order, then
 * the graph data, then the orphans (byte order, SPEC 12.0).
 */
export async function stalenessFindings(
  root: string,
  outputs: BuildOutputs,
  stored: LoadedGraphData,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const file of outputs.files) {
    const absolute = absoluteOf(root, file.path);
    const occupant = await classifyOccupant(absolute);
    if (occupant === "absent") {
      findings.push(staleFinding(file.path, "is missing — it does not match"));
      continue;
    }
    if (occupant !== "file") {
      // SPEC 13.4: generation writes a plain file (a symbolic link at the
      // path would be replaced as itself) — any other occupant cannot be
      // content-identical to the generated file.
      findings.push(
        staleFinding(
          file.path,
          `is ${describeOccupant(occupant)}, not the plain file holding`,
        ),
      );
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fsp.readFile(absolute);
    } catch {
      // Vanished between classification and read (SPEC 13.5 concurrency):
      // it no longer matches.
      findings.push(
        staleFinding(file.path, "cannot be read — it does not match"),
      );
      continue;
    }
    if (!bytesEqual(bytes, utf8Encoder.encode(file.content))) {
      findings.push(staleFinding(file.path, "does not match"));
    }
  }

  // SPEC 13.3/14.10: `check` reports the graph data stale exactly when the
  // refreshing reads would refresh it — one shared predicate.
  if (!graphDataMatchesCurrent(stored.bytes, stored.data, outputs.graphData)) {
    findings.push(staleFinding(GRAPH_DATA_PATH, "does not match"));
  }

  // SPEC 14.10's recorded-orphan arm: `outputs.orphans` holds the recorded
  // derived files the current build no longer generates (byte order,
  // core/build.ts); one whose path is vacant remains nowhere — no finding.
  for (const rel of outputs.orphans) {
    if ((await classifyOccupant(absoluteOf(root, rel))) !== "absent") {
      findings.push(orphanFinding(rel));
    }
  }

  return findings;
}
