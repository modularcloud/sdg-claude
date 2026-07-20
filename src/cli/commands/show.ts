// `xspec show <node>` (SPEC 12.4): one requirement for human reading.
//
// Accepts `path#id`, or a bare `path` for a file's root node (SPEC 1.5),
// and prints the full enumeration: identity, source range (1.7), own and
// subtree text (fully expanded, 1.6), all four hashes (5.5), tags, coverage
// attribute (absent for a root node, 11), and edges by kind. `query node`
// is the machine-facing equivalent: `show --json` emits the identical node
// report document (commands/common.ts), so the two commands can never
// disagree. The answer comes from the refreshed graph (SPEC 13.3, via
// cli/prepare.ts); an unknown node identity is a usage error, exit 2
// (SPEC 12.0).

import type { ExitCode } from "../../core/findings.js";
import type { GraphEdge, RequirementNode } from "../../core/graph.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import type { Invocation } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import {
  emitDocument,
  nodeReportDocument,
  resolveRequirementNode,
  usageError,
} from "./common.js";

/** A text value as an indented block, one report line per text line. */
function indentedBlock(text: string): string {
  if (text === "") return "";
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return `${body
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n`;
}

/** One edge line: its kind plus the far endpoint's identity (SPEC 5.2). */
function edgeLine(edge: GraphEdge, direction: "incoming" | "outgoing"): string {
  return direction === "incoming"
    ? `    ${edge.kind} from ${edge.source}\n`
    : `    ${edge.kind} to ${edge.target}\n`;
}

/**
 * The human report (SPEC 12.4): the same information as the `query node`
 * document — identity, source range, own and subtree text, hashes, tags,
 * coverage attribute (line omitted for a root node, which carries none),
 * and edges by kind (SPEC 12.0: the JSON form carries the same
 * information). Byte-deterministic: graph content and static text only.
 */
function renderNodeHuman(
  analysis: WorkspaceAnalysis,
  node: RequirementNode,
): string {
  const hashes = analysis.hashes.get(node.identity);
  if (hashes === undefined) {
    throw new Error(
      `xspec internal error: no hashes for requirement node ${node.identity}`,
    );
  }
  const { section } = node;
  let out = `${node.identity}\n`;
  out += `source range: bytes ${String(section.range.start)}-${String(section.range.end)}\n`;
  out += ["tags:", ...section.tags].join(" ") + "\n";
  if (section.coverage !== null) {
    out += `coverage: ${section.coverage}\n`;
  }
  out += `hashes:\n`;
  out += `  ownHash: ${hashes.ownHash}\n`;
  out += `  subtreeHash: ${hashes.subtreeHash}\n`;
  out += `  effectiveHash: ${hashes.effectiveHash}\n`;
  out += `  metadataHash: ${hashes.metadataHash}\n`;
  out += `edges:\n`;
  out += `  incoming:\n`;
  for (const edge of analysis.graph.incomingEdges(node.identity)) {
    out += edgeLine(edge, "incoming");
  }
  out += `  outgoing:\n`;
  for (const edge of analysis.graph.outgoingEdges(node.identity)) {
    out += edgeLine(edge, "outgoing");
  }
  out += `own text:\n`;
  out += indentedBlock(analysis.textModel.ownText(node.document, section));
  out += `subtree text:\n`;
  out += indentedBlock(analysis.textModel.subtreeText(node.document, section));
  return out;
}

/** The `show` command handler (SPEC 12.4). */
export async function showCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { stdout, stderr } = context;

  // SPEC 13.3: refresh-on-read, then answer.
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }
  const { analysis } = prepared;

  const resolved = resolveRequirementNode(
    analysis.graph,
    invocation.positionals[0],
  );
  if (!resolved.ok) {
    return usageError(stderr, invocation.command, resolved.message);
  }
  if (invocation.json) {
    // SPEC 12.4/11: the machine form is `query node`'s document exactly.
    return emitDocument(stdout, nodeReportDocument(analysis, resolved.node));
  }
  stdout.write(renderNodeHuman(analysis, resolved.node));
  return 0;
}
