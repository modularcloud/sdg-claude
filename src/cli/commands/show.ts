// `xspec show <node>` (SPEC 12.4): one requirement for human reading.
//
// Accepts `path#id`, or a bare `path` for a file's root node (SPEC 1.5),
// and prints the full enumeration: identity, source range (1.7), own and
// subtree text (fully expanded, 1.6), all four hashes (5.5), tags, coverage
// attribute (absent for a root node, 11), and edges by kind. `query node`
// is the machine-facing equivalent: `show --json` emits the identical node
// report document (./query-core.ts `nodeReportOf` — one shape, one place),
// so the two commands can never disagree. The answer comes from the
// refreshed graph (SPEC 13.3, via cli/prepare.ts); an unknown node identity
// is a usage error, exit 2 (SPEC 12.0).

import type { ExitCode } from "../../core/findings.js";
import type { GraphEdge } from "../../core/graph.js";
import type { Invocation } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { analysisQueryView } from "./analysis-view.js";
import { emitDocument, usageError } from "./common.js";
import type { QueryRow, QueryView } from "./query-core.js";
import { nodeReportOf, resolveRow } from "./query-core.js";

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
function renderNodeHuman(view: QueryView, row: QueryRow): string {
  let out = `${row.identity}\n`;
  out += `source range: bytes ${String(row.range.start)}-${String(row.range.end)}\n`;
  out += ["tags:", ...row.tags].join(" ") + "\n";
  if (row.coverage !== null) {
    out += `coverage: ${row.coverage}\n`;
  }
  out += `hashes:\n`;
  out += `  ownHash: ${row.hashes.ownHash}\n`;
  out += `  subtreeHash: ${row.hashes.subtreeHash}\n`;
  out += `  effectiveHash: ${row.hashes.effectiveHash}\n`;
  out += `  metadataHash: ${row.hashes.metadataHash}\n`;
  out += `edges:\n`;
  out += `  incoming:\n`;
  for (const edge of view.edges) {
    if (edge.target === row.identity) out += edgeLine(edge, "incoming");
  }
  out += `  outgoing:\n`;
  for (const edge of view.edges) {
    if (edge.source === row.identity) out += edgeLine(edge, "outgoing");
  }
  out += `own text:\n`;
  out += indentedBlock(row.ownText());
  out += `subtree text:\n`;
  out += indentedBlock(row.subtreeText());
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
  const view = analysisQueryView(prepared.analysis);

  const resolved = resolveRow(view, invocation.positionals[0]);
  if (!resolved.ok) {
    return usageError(stderr, invocation.command, resolved.message);
  }
  if (invocation.json) {
    // SPEC 12.4/11: the machine form is `query node`'s document exactly.
    return emitDocument(stdout, nodeReportOf(view, resolved.row));
  }
  stdout.write(renderNodeHuman(view, resolved.row));
  return 0;
}
