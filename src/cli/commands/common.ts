// Shared helpers of the graph-reading command handlers (`query`, `show`,
// `ids`, and later graph consumers — SPEC 11, 12.3, 12.4).
//
// IMPLEMENTATION (Architecture): the cli layer owns rendering and the
// exit-code taxonomy; these helpers keep every command's usage-error
// reporting, JSON emission, and node-report content identical. SPEC 12.4:
// `query node` is the machine-facing equivalent of `show` — both build the
// one node-report document defined here, so their information content can
// never drift apart.

import * as path from "node:path";
import type { JsonObject, JsonValue } from "../../core/canonical-json.js";
import { canonicalJson } from "../../core/canonical-json.js";
import type { ByteRange } from "../../core/bytes.js";
import type {
  GraphEdge,
  RequirementNode,
  WorkspaceGraph,
} from "../../core/graph.js";
import type { TestHoldSpec } from "../../workspace/lock.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import type { Invocation } from "../args.js";
import { flagValue } from "../args.js";
import type { CliWriter } from "../io.js";

/**
 * SPEC 12.0: usage errors — unknown identities, unknown groups, invalid
 * flag values — exit 2 with the diagnostic on standard error and nothing on
 * standard output (the exit-2 error prevents emitting the single JSON
 * document). Diagnostics echo argv tokens and static text only, keeping
 * output byte-deterministic (SPEC 12.0).
 */
export function usageError(
  stderr: CliWriter,
  command: string,
  message: string,
): 2 {
  stderr.write(`xspec: ${command}: ${message}\n`);
  return 2;
}

/** SPEC 12.0: emit the single JSON document — the entire standard output. */
export function emitDocument(stdout: CliWriter, document: JsonValue): 0 {
  stdout.write(canonicalJson(document));
  return 0;
}

/**
 * The invocation's `--test-hold <path>` value as the workspace layer's hold
 * spec, or undefined when the flag was not given. SPEC 12.0/13.5: the value
 * is a filesystem path resolved against the working directory; the verbatim
 * token is kept for diagnostics (argv tokens only — never resolved paths).
 */
export function testHoldSpecOf(
  invocation: Invocation,
  cwd: string,
): TestHoldSpec | undefined {
  const given = flagValue(invocation, "--test-hold");
  if (given === undefined) {
    return undefined;
  }
  return { given, absolutePath: path.resolve(cwd, given) };
}

/** A source range (SPEC 1.7) as JSON data. */
export function rangeJson(range: ByteRange): JsonObject {
  return { start: range.start, end: range.end };
}

/** One edge (SPEC 5.2) as JSON data. */
export function edgeJson(edge: GraphEdge): JsonObject {
  return { from: edge.source, to: edge.target, kind: edge.kind };
}

/** How a `<node>` argument resolved. */
export type NodeResolution =
  | { readonly ok: true; readonly node: RequirementNode }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a `<node>` argument: a requirement-node identity — `path#id`, or
 * a bare path for a file's root node (SPEC 11, 12.4, 1.5). A code-location
 * identity or a path in no configured group is unknown here (12.0).
 */
export function resolveRequirementNode(
  graph: WorkspaceGraph,
  raw: string,
): NodeResolution {
  const node = graph.requirementNode(raw);
  if (node !== undefined) {
    return { ok: true, node };
  }
  if (graph.codeLocation(raw) !== undefined) {
    return {
      ok: false,
      message:
        `'${raw}' names a code location — <node> takes a requirement-node ` +
        `identity: path#id, or a bare path for a file's root node ` +
        `(SPEC 11, 1.5)`,
    };
  }
  return {
    ok: false,
    message:
      `unknown requirement node '${raw}' — expected path#id, or a bare ` +
      `path for a file's root node; a path in no configured group is ` +
      `unknown (SPEC 11, 1.5, 12.0)`,
  };
}

/**
 * The one requirement-node report (SPEC 11, 12.4): identity, source range
 * (1.7), own and subtree text (fully expanded, 1.6), all four hashes (5.5),
 * tags, coverage attribute (absent for a root, 5.5), and incoming and
 * outgoing edges by kind. `query node` emits it as its document; `show
 * --json` carries the same shape, so the two commands answer identically
 * (SPEC 12.4: `query node` is the machine-facing equivalent).
 */
export function nodeReportDocument(
  analysis: WorkspaceAnalysis,
  node: RequirementNode,
): JsonObject {
  const hashes = analysis.hashes.get(node.identity);
  if (hashes === undefined) {
    throw new Error(
      `xspec internal error: no hashes for requirement node ${node.identity}`,
    );
  }
  return {
    identity: node.identity,
    sourceRange: rangeJson(node.section.range),
    // SPEC 1.6: both text values fully expanded.
    ownText: analysis.textModel.ownText(node.document, node.section),
    subtreeText: analysis.textModel.subtreeText(node.document, node.section),
    // SPEC 5.5: all four hashes.
    hashes: {
      ownHash: hashes.ownHash,
      subtreeHash: hashes.subtreeHash,
      effectiveHash: hashes.effectiveHash,
      metadataHash: hashes.metadataHash,
    },
    tags: [...node.section.tags],
    // SPEC 11/5.5: reported as absent for a root node (key omitted).
    coverage: node.section.coverage ?? undefined,
    // SPEC 11: incoming and outgoing edges by kind — the graph's
    // (source, kind, target) order, deterministic (SPEC 12.0).
    edges: {
      incoming: analysis.graph.incomingEdges(node.identity).map(edgeJson),
      outgoing: analysis.graph.outgoingEdges(node.identity).map(edgeJson),
    },
  };
}
