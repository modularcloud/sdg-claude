// `xspec ids` (SPEC 12.3): requirement IDs grouped by file.
//
// Files in byte order of workspace-relative path, IDs within a file in
// document order — exactly the order of the graph's requirement-node list
// (SPEC 12.0 determinism). `--tree` renders each file's IDs as a tree
// following section nesting instead of a flat list, in the same file and
// document order. `--file <glob>` restricts the listing to files the glob
// matches (the rules of SPEC 7, as in 11: a pattern resolving outside the
// workspace root is an invalid flag value, exit 2). `--unreferenced`
// restricts it to requirement nodes with no incoming dependency edges from
// specs or code (`contains` does not count) — unreferenced is not the same
// as uncovered (SPEC 12.3). When the listing is restricted and a listed
// node's parent is not listed, `--tree` nests the node under its nearest
// listed ancestor, or at its file's top level when no ancestor is listed:
// the tree contains exactly the listed IDs.
//
// Roots never appear: the listing is of requirement IDs, and a file's
// implicit root carries none (SPEC 1.2, 1.3). A file none of whose IDs
// survive the restrictions contributes no entry (SPEC 12.3 fixes nothing
// about empty entries; omitting them keeps both forms minimal and
// byte-deterministic). The answer comes from the refreshed graph
// (SPEC 13.3, via cli/prepare.ts); `--json` emits the single JSON document
// per SPEC 12.0, and the human form carries the same information.

import type { JsonObject } from "../../core/canonical-json.js";
import type { ExitCode } from "../../core/findings.js";
import type { CompiledGlob } from "../../core/glob.js";
import { compileGlob } from "../../core/glob.js";
import type { RequirementNode, WorkspaceGraph } from "../../core/graph.js";
import type { Invocation } from "../args.js";
import { flagPresent, flagValue } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { emitDocument, usageError } from "./common.js";

/** The requirement ID of a listed node — never a root (see the filter). */
function requirementIdOf(node: RequirementNode): string {
  if (node.id === null) {
    throw new Error(
      `xspec internal error: root node ${node.identity} in an ids listing`,
    );
  }
  return node.id;
}

/**
 * SPEC 12.3: a node is unreferenced when it has no incoming dependency
 * edges from specs or code — `contains` does not count (the dependency
 * kinds are `depends`, `embeds`, `references`; SPEC 5.2).
 */
function isReferenced(graph: WorkspaceGraph, node: RequirementNode): boolean {
  return graph
    .incomingEdges(node.identity)
    .some((edge) => edge.kind !== "contains");
}

/** One file's listed nodes, in document order. */
interface FileGroup {
  readonly file: string;
  readonly nodes: RequirementNode[];
}

/**
 * Group the listed nodes by file, preserving order: the input follows the
 * graph's requirement-node list — files in byte order of workspace-relative
 * path, nodes within a file in document order (SPEC 12.3, 12.0) — so each
 * file's nodes are contiguous and the groups come out file-byte-ordered.
 */
function groupByFile(listed: readonly RequirementNode[]): FileGroup[] {
  const groups: FileGroup[] = [];
  const byFile = new Map<string, FileGroup>();
  for (const node of listed) {
    let group = byFile.get(node.path);
    if (group === undefined) {
      group = { file: node.path, nodes: [] };
      byFile.set(node.path, group);
      groups.push(group);
    }
    group.nodes.push(node);
  }
  return groups;
}

/** One `--tree` node: the full requirement ID plus nested children. */
interface TreeNode {
  readonly id: string;
  readonly children: TreeNode[];
}

/**
 * SPEC 12.3: one file's listed nodes as a tree following section nesting.
 * Each node nests under its nearest listed ancestor, or at the file's top
 * level when no ancestor is listed — for an unrestricted listing every
 * parent is listed, so this is exactly the section structure. Document
 * order is pre-order (a parent's construct begins before its descendants'),
 * so every listed ancestor is placed before its descendants arrive, and
 * children accumulate in document order. The tree contains exactly the
 * listed IDs.
 */
function buildFileTree(
  graph: WorkspaceGraph,
  nodes: readonly RequirementNode[],
): TreeNode[] {
  const placed = new Map<string, TreeNode>();
  const top: TreeNode[] = [];
  for (const node of nodes) {
    const built: TreeNode = { id: requirementIdOf(node), children: [] };
    placed.set(node.identity, built);
    let nearest: TreeNode | undefined;
    for (
      let ancestor = graph.parentOf(node);
      ancestor !== null;
      ancestor = graph.parentOf(ancestor)
    ) {
      nearest = placed.get(ancestor.identity);
      if (nearest !== undefined) break;
    }
    if (nearest !== undefined) {
      nearest.children.push(built);
    } else {
      top.push(built);
    }
  }
  return top;
}

/** A tree node as JSON data (`--tree --json`). */
function treeNodeJson(node: TreeNode): JsonObject {
  return { id: node.id, children: node.children.map(treeNodeJson) };
}

/** The flat human listing: the file line, IDs indented under it. */
function renderFlatHuman(groups: readonly FileGroup[]): string {
  let out = "";
  for (const group of groups) {
    out += `${group.file}\n`;
    for (const node of group.nodes) {
      out += `  ${requirementIdOf(node)}\n`;
    }
  }
  return out;
}

/** The tree human listing: full IDs indented by nesting depth. */
function renderTreeHuman(
  groups: readonly { file: string; nodes: readonly TreeNode[] }[],
): string {
  let out = "";
  const renderNode = (node: TreeNode, depth: number): void => {
    out += `${"  ".repeat(depth)}${node.id}\n`;
    for (const child of node.children) {
      renderNode(child, depth + 1);
    }
  };
  for (const group of groups) {
    out += `${group.file}\n`;
    for (const node of group.nodes) {
      renderNode(node, 1);
    }
  }
  return out;
}

/** The `ids` command handler (SPEC 12.3). */
export async function idsCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { stdout, stderr } = context;

  // SPEC 12.3/11: `--file` compiles under the glob rules of 7, where a
  // pattern resolving outside the workspace root is an invalid flag value,
  // exit 2 like its configuration-time counterpart (14.14). Like those
  // counterparts, this check precedes source analysis.
  let fileGlob: CompiledGlob | undefined;
  const filePattern = flagValue(invocation, "--file");
  if (filePattern !== undefined) {
    const compiled = compileGlob(filePattern, "plain");
    if (!compiled.ok) {
      // Plain mode has one compile error: outside-root (SPEC 7).
      return usageError(
        stderr,
        invocation.command,
        `invalid value '${filePattern}' for '--file' — the pattern ` +
          `resolves outside the workspace root (SPEC 12.3, 7, 12.0)`,
      );
    }
    fileGlob = compiled.glob;
  }

  // SPEC 13.3: refresh-on-read, then answer.
  const prepared = await prepareGraphForRead(invocation, context);
  if (!prepared.ok) {
    return prepared.exit;
  }
  const graph = prepared.analysis.graph;
  const unreferenced = flagPresent(invocation, "--unreferenced");

  // The listed set (SPEC 12.3): non-root requirement nodes surviving the
  // restrictions, in the graph's file-byte/document order.
  const listed = graph.requirementNodes.filter((node) => {
    if (node.id === null) return false;
    if (fileGlob !== undefined && !fileGlob.matches(node.path)) return false;
    if (unreferenced && isReferenced(graph, node)) return false;
    return true;
  });
  const groups = groupByFile(listed);

  if (flagPresent(invocation, "--tree")) {
    const trees = groups.map((group) => ({
      file: group.file,
      nodes: buildFileTree(graph, group.nodes),
    }));
    if (invocation.json) {
      return emitDocument(stdout, {
        files: trees.map((entry) => ({
          file: entry.file,
          nodes: entry.nodes.map(treeNodeJson),
        })),
      });
    }
    stdout.write(renderTreeHuman(trees));
    return 0;
  }

  if (invocation.json) {
    return emitDocument(stdout, {
      files: groups.map((group) => ({
        file: group.file,
        ids: group.nodes.map(requirementIdOf),
      })),
    });
  }
  stdout.write(renderFlatHuman(groups));
  return 0;
}
