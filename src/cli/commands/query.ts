// `xspec query` (SPEC 11): set-level, JSON-only access to the graph.
//
// A single JSON document is `query`'s only output form, with or without
// `--json` (SPEC 11, 12.0) — including the findings report of a failed
// refresh (SPEC 13.3), which is standard-output content like a failed
// `build`'s. Six subcommands over the refreshed graph (SPEC 13.3, via
// cli/prepare.ts):
//
// - `node <node>` — identity, source range (1.7), own and subtree text
//   (fully expanded, 1.6), all four hashes (5.5), tags, coverage attribute
//   (absent for a root, 5.5), and incoming and outgoing edges by kind;
// - `nodes [--group] [--file] [--tag] [--coverage]` — requirement-node rows
//   under conjunctive filters; `--coverage` matches no root;
// - `edges [--from] [--to] [--kinds]` — the edge set filtered over all four
//   kinds (default: no kind filter);
// - `subtree <node>` — the node and all descendants, document order;
// - `ancestors <node>` — proper ancestors, nearest first, ending at the
//   file root;
// - `reachable --from --to [--kinds]` — whether a nontrivial dependency
//   path exists under the given kinds (dependency kinds only, default all
//   three) and, when one does, one shortest witness path under the SPEC
//   12.0 byte tie rule.
//
// Identity forms (SPEC 11, 1.5, 4.6): `<node>` is a requirement-node
// identity (`path#id`, or a bare path for a file's root node); a
// `<graph-node>` is any graph-node identity, code locations included.
// Whether a bare path names a root node or a code file follows from the
// file's group (7) — equivalently, from which graph index holds it, since
// spec and code paths are disjoint (14.14) — and a path in no configured
// group is unknown: a usage error, exit 2 (12.0), like every unknown
// identity, unknown group, or invalid flag value below, all reported on
// standard error with standard output left empty.

import type { JsonObject, JsonValue } from "../../core/canonical-json.js";
import { canonicalJson } from "../../core/canonical-json.js";
import type { ByteRange } from "../../core/bytes.js";
import type { ExitCode } from "../../core/findings.js";
import type { CompiledGlob } from "../../core/glob.js";
import { compileGlob } from "../../core/glob.js";
import type {
  GraphEdge,
  GraphEdgeKind,
  RequirementNode,
  WorkspaceGraph,
} from "../../core/graph.js";
import { DEPENDENCY_EDGE_KINDS } from "../../core/graph.js";
import { shortestWitnessPath } from "../../core/paths.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import type { Invocation } from "../args.js";
import { flagList, flagValue } from "../args.js";
import type { CliWriter, CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";

/**
 * SPEC 12.0: usage errors — unknown identities, unknown groups, invalid
 * flag values — exit 2 with the diagnostic on standard error and nothing on
 * standard output (the exit-2 error prevents emitting the single JSON
 * document). Diagnostics echo argv tokens and static text only, keeping
 * output byte-deterministic (SPEC 12.0).
 */
function usageError(stderr: CliWriter, command: string, message: string): 2 {
  stderr.write(`xspec: ${command}: ${message}\n`);
  return 2;
}

/** SPEC 11/12.0: the single JSON document, `query`'s only output form. */
function emitDocument(stdout: CliWriter, document: JsonValue): 0 {
  stdout.write(canonicalJson(document));
  return 0;
}

/** A source range (SPEC 1.7) as JSON data. */
function rangeJson(range: ByteRange): JsonObject {
  return { start: range.start, end: range.end };
}

/** One edge (SPEC 5.2) as JSON data. */
function edgeJson(edge: GraphEdge): JsonObject {
  return { from: edge.source, to: edge.target, kind: edge.kind };
}

/**
 * The one row contract of `nodes`, `subtree`, and `ancestors` (SPEC 11):
 * identity, source range (1.7), tags, coverage attribute — omitted for a
 * root node, which carries none (SPEC 5.5, 2.5).
 */
function rowJson(node: RequirementNode): JsonObject {
  return {
    identity: node.identity,
    sourceRange: rangeJson(node.section.range),
    tags: [...node.section.tags],
    coverage: node.section.coverage ?? undefined,
  };
}

/** The `nodes` document of `nodes`/`subtree`/`ancestors` (SPEC 11). */
function rowsDocument(nodes: readonly RequirementNode[]): JsonObject {
  return { nodes: nodes.map(rowJson) };
}

/** How a `<node>` / `<graph-node>` argument resolved. */
type NodeResolution =
  | { readonly ok: true; readonly node: RequirementNode }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a `<node>` argument: a requirement-node identity — `path#id`, or
 * a bare path for a file's root node (SPEC 11, 1.5). A code-location
 * identity or a path in no configured group is unknown here (12.0).
 */
function resolveRequirementNode(
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
 * Check a `<graph-node>` argument (SPEC 11, 4.6): any graph-node identity —
 * a requirement node or a code location. Returns the usage-error message
 * for an unknown identity, null when it resolves.
 */
function unknownGraphNodeMessage(
  graph: WorkspaceGraph,
  flag: string,
  raw: string,
): string | null {
  if (graph.node(raw) !== undefined) {
    return null;
  }
  return (
    `unknown graph node '${raw}' for '${flag}' — expected a requirement ` +
    `node (path#id, or a bare path for a spec file's root node) or a code ` +
    `location (path, path#unit, or path#unit@N); a path in no configured ` +
    `group is unknown (SPEC 11, 1.5, 4.6, 12.0)`
  );
}

/** The `nodes` filters, validated against the configuration alone. */
interface NodesFilters {
  readonly groupGlobs?: readonly CompiledGlob[];
  readonly fileGlob?: CompiledGlob;
  readonly tag?: string;
  readonly coverage?: string;
}

type NodesFiltersResult =
  | { readonly ok: true; readonly filters: NodesFilters }
  | { readonly ok: false; readonly message: string };

/**
 * Validate the configuration-level flag values of `query nodes` (SPEC 11):
 * `--group` accepts only a configured spec group's name — a code group's
 * name is an invalid flag value, the wrong-kind group reference of 14.14,
 * and an unknown name is a usage error (12.0) — and `--file` compiles under
 * the glob rules of 7, where a pattern resolving outside the workspace root
 * is an invalid flag value, exit 2 like its configuration-time counterpart
 * (14.14). Like those counterparts, these checks precede source analysis.
 */
function resolveNodesFilters(
  invocation: Invocation,
  context: CommandContext,
): NodesFiltersResult {
  const { configuration } = context.workspace;
  let groupGlobs: readonly CompiledGlob[] | undefined;
  const group = flagValue(invocation, "--group");
  if (group !== undefined) {
    const specGroup = configuration.specGroups.find(
      (candidate) => candidate.name === group,
    );
    if (specGroup === undefined) {
      const isCodeGroup = configuration.codeGroups.some(
        (candidate) => candidate.name === group,
      );
      return {
        ok: false,
        message: isCodeGroup
          ? `invalid value '${group}' for '--group' — it names a code ` +
            `group, and --group accepts only a configured spec group's ` +
            `name (SPEC 11, 14.14)`
          : `unknown group '${group}' for '--group' — no configured spec ` +
            `group has that name (SPEC 11, 12.0)`,
      };
    }
    groupGlobs = specGroup.globs;
  }
  let fileGlob: CompiledGlob | undefined;
  const filePattern = flagValue(invocation, "--file");
  if (filePattern !== undefined) {
    const compiled = compileGlob(filePattern, "plain");
    if (!compiled.ok) {
      // Plain mode has one compile error: outside-root (SPEC 7).
      return {
        ok: false,
        message:
          `invalid value '${filePattern}' for '--file' — the pattern ` +
          `resolves outside the workspace root (SPEC 11, 7, 12.0)`,
      };
    }
    fileGlob = compiled.glob;
  }
  return {
    ok: true,
    filters: {
      groupGlobs,
      fileGlob,
      tag: flagValue(invocation, "--tag"),
      coverage: flagValue(invocation, "--coverage"),
    },
  };
}

/** SPEC 11: the conjunctive `nodes` filters over one requirement node. */
function rowMatches(node: RequirementNode, filters: NodesFilters): boolean {
  if (
    filters.groupGlobs !== undefined &&
    !filters.groupGlobs.some((glob) => glob.matches(node.path))
  ) {
    return false;
  }
  if (filters.fileGlob !== undefined && !filters.fileGlob.matches(node.path)) {
    return false;
  }
  if (filters.tag !== undefined && !node.section.tags.includes(filters.tag)) {
    return false;
  }
  // SPEC 11: `--coverage` never matches a root — a root carries no
  // coverage attribute (its `coverage` is null, never `required`/`none`).
  if (
    filters.coverage !== undefined &&
    node.section.coverage !== filters.coverage
  ) {
    return false;
  }
  return true;
}

/** The `query node` report document (SPEC 11). */
function nodeReportDocument(
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

/**
 * SPEC 11: `subtree <node>` — the queried node and all its descendants, in
 * document order (pre-order: a parent's construct begins before its
 * descendants'). Iterative, so deep nesting never overflows the stack.
 */
function subtreeNodes(
  graph: WorkspaceGraph,
  node: RequirementNode,
): RequirementNode[] {
  const out: RequirementNode[] = [];
  const stack: RequirementNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    out.push(current);
    const children = graph.childrenOf(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return out;
}

/**
 * SPEC 11: `ancestors <node>` — the proper ancestors, itself excluded,
 * nearest first, ending at the file root (a root yields none).
 */
function ancestorNodes(
  graph: WorkspaceGraph,
  node: RequirementNode,
): RequirementNode[] {
  const chain: RequirementNode[] = [];
  for (
    let parent = graph.parentOf(node);
    parent !== null;
    parent = graph.parentOf(parent)
  ) {
    chain.push(parent);
  }
  return chain;
}

/** The `--kinds` set of `edges`/`reachable`, or the subcommand's default. */
function kindSet(
  invocation: Invocation,
  defaults: readonly GraphEdgeKind[] | null,
): ReadonlySet<string> | null {
  const kinds = flagList(invocation, "--kinds");
  if (kinds === undefined) {
    // SPEC 11: `edges --kinds` defaults to no kind filter (null),
    // `reachable --kinds` to all three dependency kinds.
    return defaults === null ? null : new Set<string>(defaults);
  }
  return new Set(kinds);
}

/** The `query` command handler — all six subcommands (SPEC 11). */
export async function queryCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { stdout, stderr } = context;

  // SPEC 11: configuration-level flag validation precedes source analysis,
  // like its 14.14 counterparts (see resolveNodesFilters).
  let nodesFilters: NodesFilters | null = null;
  if (invocation.command === "query nodes") {
    const resolved = resolveNodesFilters(invocation, context);
    if (!resolved.ok) {
      return usageError(stderr, invocation.command, resolved.message);
    }
    nodesFilters = resolved.filters;
  }

  // SPEC 13.3: refresh-on-read, then answer. SPEC 11: a single JSON
  // document is `query`'s only output form, with or without `--json` — the
  // findings report of a failed refresh included, so the prepare step runs
  // with JSON output forced on.
  const prepared = await prepareGraphForRead(
    { ...invocation, json: true },
    context,
  );
  if (!prepared.ok) {
    return prepared.exit;
  }
  const { analysis } = prepared;
  const graph = analysis.graph;

  switch (invocation.command) {
    case "query node": {
      const resolved = resolveRequirementNode(graph, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(stdout, nodeReportDocument(analysis, resolved.node));
    }
    case "query nodes": {
      if (nodesFilters === null) {
        throw new Error("xspec internal error: nodes filters not resolved");
      }
      const filters = nodesFilters;
      // SPEC 11/12.0: deterministic order — the graph's requirement-node
      // list is byte-ordered by file path, document order within a file.
      const rows = graph.requirementNodes.filter((node) =>
        rowMatches(node, filters),
      );
      return emitDocument(stdout, rowsDocument(rows));
    }
    case "query edges": {
      const kinds = kindSet(invocation, null);
      const from = flagValue(invocation, "--from");
      const to = flagValue(invocation, "--to");
      // SPEC 11: `--from`/`--to` take any graph-node identity; unknown
      // identities are usage errors (12.0).
      for (const [flag, raw] of [
        ["--from", from],
        ["--to", to],
      ] as const) {
        if (raw === undefined) {
          continue;
        }
        const message = unknownGraphNodeMessage(graph, flag, raw);
        if (message !== null) {
          return usageError(stderr, invocation.command, message);
        }
      }
      const edges = graph.edges.filter(
        (edge) =>
          (kinds === null || kinds.has(edge.kind)) &&
          (from === undefined || edge.source === from) &&
          (to === undefined || edge.target === to),
      );
      return emitDocument(stdout, { edges: edges.map(edgeJson) });
    }
    case "query subtree": {
      const resolved = resolveRequirementNode(graph, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(
        stdout,
        rowsDocument(subtreeNodes(graph, resolved.node)),
      );
    }
    case "query ancestors": {
      const resolved = resolveRequirementNode(graph, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(
        stdout,
        rowsDocument(ancestorNodes(graph, resolved.node)),
      );
    }
    case "query reachable": {
      // SPEC 11: `reachable --kinds` accepts only the three dependency edge
      // kinds (the parser rejects `contains`) and defaults to all three.
      const kinds = kindSet(invocation, DEPENDENCY_EDGE_KINDS);
      const from = flagValue(invocation, "--from");
      const to = flagValue(invocation, "--to");
      if (from === undefined || to === undefined) {
        throw new Error(
          "xspec internal error: reachable without required --from/--to",
        );
      }
      for (const [flag, raw] of [
        ["--from", from],
        ["--to", to],
      ] as const) {
        const message = unknownGraphNodeMessage(graph, flag, raw);
        if (message !== null) {
          return usageError(stderr, invocation.command, message);
        }
      }
      const adjacency = new Map<string, Set<string>>();
      for (const edge of graph.edges) {
        if (kinds !== null && !kinds.has(edge.kind)) {
          continue;
        }
        let targets = adjacency.get(edge.source);
        if (targets === undefined) {
          adjacency.set(edge.source, (targets = new Set()));
        }
        targets.add(edge.target);
      }
      // SPEC 11: a dependency path is one or more edges — a zero-length
      // path is not one, so equal endpoints report no path — and the
      // witness is one shortest path under the SPEC 12.0 byte tie rule.
      const path = shortestWitnessPath(adjacency, from, to);
      return emitDocument(
        stdout,
        path === null
          ? { reachable: false }
          : { reachable: true, path: [...path] },
      );
    }
    default:
      throw new Error(
        `xspec internal error: unknown query subcommand '${invocation.command}'`,
      );
  }
}
