// `xspec query` answering (SPEC 11) over an abstract graph view — the one
// implementation behind both read paths.
//
// The full path (./query.ts) answers from the refreshed workspace analysis
// (SPEC 13.3); the store-backed fast path (./query-fast.ts over
// workspace/fast-read.ts) answers from stored graph data whose recorded
// derivation inputs all match the current workspace bytes. Both wrap their
// data as a `QueryView` and call `answerQuery`, so the two paths cannot
// drift: every subcommand's validation, ordering, and rendering is this
// module's, once (SPEC 12.0 byte determinism — identical workspaces answer
// identically on either path).
//
// This module's import chain is deliberately light — no analysis pipeline,
// no TypeScript compiler, no MDX parser — so the fast path loads none of
// them (the point of answering from the store; see fast-read.ts).

import type { ByteRange } from "../../core/bytes.js";
import type { JsonObject } from "../../core/canonical-json.js";
import type { CompiledGlob } from "../../core/glob.js";
import { compileGlob } from "../../core/glob.js";
import type { GraphEdge, GraphEdgeKind } from "../../core/graph.js";
import { DEPENDENCY_EDGE_KINDS } from "../../core/graph.js";
import type { NodeHashes } from "../../core/hashes.js";
import type { ExitCode } from "../../core/findings.js";
import { shortestWitnessPath } from "../../core/paths.js";
import type { Invocation } from "../args.js";
import { flagList, flagValue } from "../args.js";
import type { CliWriter } from "../io.js";
import { emitDocument, rangeJson, usageError } from "./common.js";

/** One requirement node as the query subcommands consume it (SPEC 11). */
export interface QueryRow {
  /** SPEC 1.5: `path#id`, or the bare path for the root node. */
  readonly identity: string;
  /** Workspace-relative `/`-separated source file path (SPEC 1.5). */
  readonly path: string;
  /** Whether this is the file's root node (SPEC 1.2). */
  readonly isRoot: boolean;
  /** SPEC 1.7: the construct's byte range; the entire file for a root. */
  readonly range: ByteRange;
  /** SPEC 2.6: the node's tags, in first-occurrence order. */
  readonly tags: readonly string[];
  /** SPEC 2.5: the effective coverage attribute — null for a root. */
  readonly coverage: "required" | "none" | null;
  /** SPEC 5.5: the node's four hashes. */
  readonly hashes: NodeHashes;
  /** SPEC 1.6: own text, fully expanded — computed on demand. */
  readonly ownText: () => string;
  /** SPEC 1.6: subtree text, fully expanded — computed on demand. */
  readonly subtreeText: () => string;
}

/**
 * The graph as the query subcommands read it (SPEC 11) — implemented over
 * the live analysis (./query.ts) and over verified stored graph data
 * (./query-fast.ts).
 */
export interface QueryView {
  /**
   * Every requirement node in graph order: files in byte order of path,
   * document order within a file (SPEC 12.0).
   */
  readonly rows: readonly QueryRow[];
  /** The collapsed edge set in (source, kind, target) order (SPEC 5.2). */
  readonly edges: readonly GraphEdge[];
  /** The requirement node bearing `identity` (SPEC 1.5), if any. */
  readonly row: (identity: string) => QueryRow | undefined;
  /** Whether `identity` names a code location (SPEC 4.6). */
  readonly isCodeLocation: (identity: string) => boolean;
  /** The child nodes in document order (SPEC 5.2 `contains`). */
  readonly childrenOf: (row: QueryRow) => readonly QueryRow[];
  /** The structural parent node — null for a root (SPEC 1.2). */
  readonly parentOf: (row: QueryRow) => QueryRow | null;
}

/** The configured groups as `query nodes` flag validation reads them. */
export interface GroupsView {
  readonly specGroups: readonly {
    readonly name: string;
    readonly globs: readonly CompiledGlob[];
  }[];
  readonly codeGroupNames: ReadonlySet<string>;
}

/** One edge (SPEC 5.2) as JSON data. */
export function edgeJson(edge: GraphEdge): JsonObject {
  return { from: edge.source, to: edge.target, kind: edge.kind };
}

/**
 * The one row contract of `nodes`, `subtree`, and `ancestors` (SPEC 11):
 * identity, source range (1.7), tags, coverage attribute — omitted for a
 * root node, which carries none (SPEC 5.5, 2.5).
 */
function rowJson(row: QueryRow): JsonObject {
  return {
    identity: row.identity,
    sourceRange: rangeJson(row.range),
    tags: [...row.tags],
    coverage: row.coverage ?? undefined,
  };
}

/** The `nodes` document of `nodes`/`subtree`/`ancestors` (SPEC 11). */
function rowsDocument(rows: readonly QueryRow[]): JsonObject {
  return { nodes: rows.map(rowJson) };
}

/**
 * The one requirement-node report (SPEC 11, 12.4): identity, source range
 * (1.7), own and subtree text (fully expanded, 1.6), all four hashes (5.5),
 * tags, coverage attribute (absent for a root, 5.5), and incoming and
 * outgoing edges by kind. `query node` emits it as its document; `show
 * --json` carries the same shape, so the two commands answer identically
 * (SPEC 12.4: `query node` is the machine-facing equivalent).
 */
export function nodeReportOf(view: QueryView, row: QueryRow): JsonObject {
  return {
    identity: row.identity,
    sourceRange: rangeJson(row.range),
    // SPEC 1.6: both text values fully expanded.
    ownText: row.ownText(),
    subtreeText: row.subtreeText(),
    // SPEC 5.5: all four hashes.
    hashes: {
      ownHash: row.hashes.ownHash,
      subtreeHash: row.hashes.subtreeHash,
      effectiveHash: row.hashes.effectiveHash,
      metadataHash: row.hashes.metadataHash,
    },
    tags: [...row.tags],
    // SPEC 11/5.5: reported as absent for a root node (key omitted).
    coverage: row.coverage ?? undefined,
    // SPEC 11: incoming and outgoing edges by kind — the graph's
    // (source, kind, target) order, deterministic (SPEC 12.0). Filters of
    // the whole ordered edge set preserve that order.
    edges: {
      incoming: view.edges
        .filter((edge) => edge.target === row.identity)
        .map(edgeJson),
      outgoing: view.edges
        .filter((edge) => edge.source === row.identity)
        .map(edgeJson),
    },
  };
}

/** How a `<node>` argument resolved. */
export type RowResolution =
  | { readonly ok: true; readonly row: QueryRow }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a `<node>` argument: a requirement-node identity — `path#id`, or
 * a bare path for a file's root node (SPEC 11, 12.4, 1.5). A code-location
 * identity or a path in no configured group is unknown here (12.0).
 */
export function resolveRow(view: QueryView, raw: string): RowResolution {
  const row = view.row(raw);
  if (row !== undefined) {
    return { ok: true, row };
  }
  if (view.isCodeLocation(raw)) {
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
  view: QueryView,
  flag: string,
  raw: string,
): string | null {
  if (view.row(raw) !== undefined || view.isCodeLocation(raw)) {
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
  groups: GroupsView,
): NodesFiltersResult {
  let groupGlobs: readonly CompiledGlob[] | undefined;
  const group = flagValue(invocation, "--group");
  if (group !== undefined) {
    const specGroup = groups.specGroups.find(
      (candidate) => candidate.name === group,
    );
    if (specGroup === undefined) {
      return {
        ok: false,
        message: groups.codeGroupNames.has(group)
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
function rowMatches(row: QueryRow, filters: NodesFilters): boolean {
  if (
    filters.groupGlobs !== undefined &&
    !filters.groupGlobs.some((glob) => glob.matches(row.path))
  ) {
    return false;
  }
  if (filters.fileGlob !== undefined && !filters.fileGlob.matches(row.path)) {
    return false;
  }
  if (filters.tag !== undefined && !row.tags.includes(filters.tag)) {
    return false;
  }
  // SPEC 11: `--coverage` never matches a root — a root carries no
  // coverage attribute (its `coverage` is null, never `required`/`none`).
  if (filters.coverage !== undefined && row.coverage !== filters.coverage) {
    return false;
  }
  return true;
}

/**
 * SPEC 11: `subtree <node>` — the queried node and all its descendants, in
 * document order (pre-order: a parent's construct begins before its
 * descendants'). Iterative, so deep nesting never overflows the stack.
 */
function subtreeRows(view: QueryView, row: QueryRow): QueryRow[] {
  const out: QueryRow[] = [];
  const stack: QueryRow[] = [row];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    out.push(current);
    const children = view.childrenOf(current);
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
function ancestorRows(view: QueryView, row: QueryRow): QueryRow[] {
  const chain: QueryRow[] = [];
  for (
    let parent = view.parentOf(row);
    parent !== null;
    parent = view.parentOf(parent)
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

/**
 * Validate the configuration-level flag values of `query nodes` and return
 * either the resolved filters (null for other subcommands) or the emitted
 * usage-error exit. SPEC 11: this validation precedes source analysis, like
 * its 14.14 counterparts — the caller runs it before preparing the graph.
 */
export function prevalidateQuery(
  invocation: Invocation,
  groups: GroupsView,
  stderr: CliWriter,
): { readonly ok: true } | { readonly ok: false; readonly exit: ExitCode } {
  if (invocation.command !== "query nodes") {
    return { ok: true };
  }
  const resolved = resolveNodesFilters(invocation, groups);
  if (!resolved.ok) {
    return {
      ok: false,
      exit: usageError(stderr, invocation.command, resolved.message),
    };
  }
  return { ok: true };
}

/**
 * Answer one `query` subcommand from the view (SPEC 11). The caller has
 * already run `prevalidateQuery` (flag validation precedes preparation) and
 * prepared the view; this emits the single JSON document or the usage error
 * (SPEC 12.0).
 */
export function answerQuery(
  invocation: Invocation,
  view: QueryView,
  groups: GroupsView,
  stdout: CliWriter,
  stderr: CliWriter,
): ExitCode {
  switch (invocation.command) {
    case "query node": {
      const resolved = resolveRow(view, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(stdout, nodeReportOf(view, resolved.row));
    }
    case "query nodes": {
      const resolved = resolveNodesFilters(invocation, groups);
      if (!resolved.ok) {
        // Unreachable after prevalidateQuery; kept total so the answering
        // is correct standalone.
        return usageError(stderr, invocation.command, resolved.message);
      }
      const filters = resolved.filters;
      // SPEC 11/12.0: deterministic order — the graph's requirement-node
      // list is byte-ordered by file path, document order within a file.
      const rows = view.rows.filter((row) => rowMatches(row, filters));
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
        const message = unknownGraphNodeMessage(view, flag, raw);
        if (message !== null) {
          return usageError(stderr, invocation.command, message);
        }
      }
      const edges = view.edges.filter(
        (edge) =>
          (kinds === null || kinds.has(edge.kind)) &&
          (from === undefined || edge.source === from) &&
          (to === undefined || edge.target === to),
      );
      return emitDocument(stdout, { edges: edges.map(edgeJson) });
    }
    case "query subtree": {
      const resolved = resolveRow(view, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(
        stdout,
        rowsDocument(subtreeRows(view, resolved.row)),
      );
    }
    case "query ancestors": {
      const resolved = resolveRow(view, invocation.positionals[0]);
      if (!resolved.ok) {
        return usageError(stderr, invocation.command, resolved.message);
      }
      return emitDocument(
        stdout,
        rowsDocument(ancestorRows(view, resolved.row)),
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
        const message = unknownGraphNodeMessage(view, flag, raw);
        if (message !== null) {
          return usageError(stderr, invocation.command, message);
        }
      }
      const adjacency = new Map<string, Set<string>>();
      for (const edge of view.edges) {
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
