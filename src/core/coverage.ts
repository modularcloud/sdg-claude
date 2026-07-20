// Coverage evaluation (SPEC 8, 8.1, 8.2).
//
// Pure core (IMPLEMENTATION Architecture: deterministic, I/O-free): coverage
// is graph reachability over dependency edges between non-root participants
// (SPEC 8) — a target requirement is covered for a profile when a permitted
// path exists from a boundary node to it: a single edge in `direct` mode, a
// path of one or more edges in `transitive` mode, using only the profile's
// `edgeKinds`. `contains` edges never grant coverage and never appear in
// coverage paths; root nodes never appear in coverage paths either — not as
// boundary node, intermediate, or target: a spec group serving as `boundary`
// contributes only its non-root requirement nodes as boundary nodes, and a
// dependency edge whose source or target is a root never extends a covering
// path. The exclusion is coverage-scoped (SPEC 8): this module removes the
// root-adjacent edges only from its own reachability question — the graph
// itself keeps them for policy, impact, effectiveHash, and query.

import type { Configuration, CoverageProfile } from "./config.js";
import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import { shortestWitnessPath } from "./paths.js";

// SPEC 8.2: each ignored node is reported with its exclusion reasons — all
// that apply, listed in this fixed order. One canonical spelling per reason,
// shared by the JSON and human output forms (SPEC 12.0: same information).
export const IGNORED_REASON_ROOT = "root node";
export const IGNORED_REASON_COVERAGE_NONE = 'coverage="none"';
export const IGNORED_REASON_NON_LEAF = 'non-leaf under targets: "leaves"';
export const IGNORED_REASON_LACKING_TAGS = "lacking every targetTags tag";

/** One covered node with its one shortest covering path (SPEC 8.2, 12.0). */
export interface CoveredNodeCoverage {
  readonly identity: string;
  /** Boundary node first, covered target last — never a root, never a
   * `contains` step (SPEC 8). */
  readonly path: readonly string[];
}

/** One ignored node with all applicable exclusion reasons (SPEC 8.2). */
export interface IgnoredNodeCoverage {
  readonly identity: string;
  /** In the fixed SPEC 8.2 order; never empty. */
  readonly reasons: readonly string[];
}

/**
 * One profile's evaluated coverage (SPEC 8.2). Row order follows the graph's
 * requirement-node list — files in byte order of workspace-relative path,
 * document order within a file (SPEC 12.0 determinism; 8.2 fixes membership
 * and per-node information, not row order). The required set is
 * covered ∪ uncovered (SPEC 8.1).
 */
export interface ProfileCoverage {
  readonly name: string;
  /** SPEC 8.2: the count of required nodes (= covered + uncovered). */
  readonly requiredCount: number;
  readonly covered: readonly CoveredNodeCoverage[];
  readonly uncovered: readonly string[];
  readonly ignored: readonly IgnoredNodeCoverage[];
}

/**
 * The virtual multi-source origin for covering-path searches. No real
 * graph-node identity can collide with it: identities are workspace-relative
 * paths (with optional `#` suffixes), and no filesystem path component can
 * contain a NUL character.
 */
const VIRTUAL_SOURCE = "\u0000boundary";

/**
 * SPEC 8.1: the reasons excluding one target-group node from the profile's
 * required set, in the fixed SPEC 8.2 reporting order — root node,
 * `coverage="none"`, non-leaf under `targets: "leaves"`, lacking every
 * `targetTags` tag. Empty exactly when the node is required. A root carries
 * no coverage attribute and no tags (SPEC 1.2, 2.5, 2.6), so the root
 * reason coincides with `coverage="none"` never and with the tag reason
 * whenever `targetTags` is present.
 */
function exclusionReasons(
  graph: WorkspaceGraph,
  profile: CoverageProfile,
  node: RequirementNode,
): string[] {
  const reasons: string[] = [];
  if (node.id === null) {
    reasons.push(IGNORED_REASON_ROOT);
  }
  if (node.section.coverage === "none") {
    reasons.push(IGNORED_REASON_COVERAGE_NONE);
  }
  if (profile.targets === "leaves" && graph.childrenOf(node).length > 0) {
    reasons.push(IGNORED_REASON_NON_LEAF);
  }
  if (
    profile.targetTags !== undefined &&
    !node.section.tags.some((tag) => profile.targetTags?.includes(tag) === true)
  ) {
    reasons.push(IGNORED_REASON_LACKING_TAGS);
  }
  return reasons;
}

/** The configured group a profile references, by name and kind (SPEC 7.4). */
function groupGlobs(
  configuration: Configuration,
  kind: "spec" | "code",
  name: string,
): readonly { matches(path: string): boolean }[] {
  const groups =
    kind === "spec" ? configuration.specGroups : configuration.codeGroups;
  const group = groups.find((candidate) => candidate.name === name);
  if (group === undefined) {
    // Unreachable for a validated configuration: profile group references
    // are checked at load (SPEC 7.4 → 14.14).
    throw new Error(
      `xspec internal error: coverage profile references unknown ${kind} ` +
        `group '${name}'`,
    );
  }
  return group.globs;
}

/**
 * SPEC 8: the profile's boundary nodes. A spec group contributes only its
 * non-root requirement nodes; a code group contributes its code locations —
 * the whole-file locations and the named units, either of which dependency
 * edges may originate at (SPEC 4.6).
 */
function boundaryNodes(
  graph: WorkspaceGraph,
  configuration: Configuration,
  profile: CoverageProfile,
): Set<string> {
  const globs = groupGlobs(
    configuration,
    profile.boundaryKind,
    profile.boundary,
  );
  const boundary = new Set<string>();
  if (profile.boundaryKind === "spec") {
    for (const node of graph.requirementNodes) {
      if (node.id !== null && globs.some((glob) => glob.matches(node.path))) {
        boundary.add(node.identity);
      }
    }
  } else {
    for (const location of graph.codeLocations) {
      if (globs.some((glob) => glob.matches(location.path))) {
        boundary.add(location.identity);
      }
    }
  }
  return boundary;
}

/**
 * The profile's reachability adjacency (SPEC 8): the graph's edges of the
 * profile's `edgeKinds` — never `contains`, which the configured kinds
 * cannot include (SPEC 7.4) — excluding every edge whose source or target
 * is a root node: a root-sourced or root-targeted dependency edge never
 * extends a covering path.
 */
function coverageAdjacency(
  graph: WorkspaceGraph,
  profile: CoverageProfile,
  roots: ReadonlySet<string>,
): Map<string, ReadonlySet<string>> {
  const kinds = new Set<string>(profile.edgeKinds);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!kinds.has(edge.kind)) continue;
    if (roots.has(edge.source) || roots.has(edge.target)) continue;
    let targets = adjacency.get(edge.source);
    if (targets === undefined) {
      adjacency.set(edge.source, (targets = new Set()));
    }
    targets.add(edge.target);
  }
  return adjacency;
}

/**
 * One shortest covering path to `target` (SPEC 8, 8.2): from any boundary
 * node, over the profile adjacency — a single edge in `direct` mode, one or
 * more edges in `transitive` mode — or null when the target is uncovered.
 *
 * Realized as one shortest-path search from a virtual source with an edge to
 * every boundary node except the target itself: a covering path is one or
 * more edges (SPEC 8), so a target that is itself a boundary node is not
 * covered by the zero-length path (boundary membership alone is no covering
 * path). Every candidate real path gains the same virtual first element, so
 * the SPEC 12.0 element-wise byte tie rule of `shortestWitnessPath` picks
 * exactly the byte-least real sequence among the shortest. In `direct` mode
 * a covered target's covering paths are single edges; when the shortest path
 * found is longer, no single-edge path exists and the target is uncovered.
 */
function shortestCoveringPath(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  boundary: ReadonlySet<string>,
  target: string,
  mode: "direct" | "transitive",
): readonly string[] | null {
  const sources = new Set<string>();
  for (const node of boundary) {
    if (node !== target) sources.add(node);
  }
  if (sources.size === 0) return null;
  const augmented = new Map(adjacency);
  augmented.set(VIRTUAL_SOURCE, sources);
  const path = shortestWitnessPath(augmented, VIRTUAL_SOURCE, target);
  if (path === null) return null;
  const real = path.slice(1);
  if (mode === "direct" && real.length !== 2) {
    // SPEC 8: `direct` mode covers over a single edge. The shortest path is
    // longer, so no boundary node holds a single edge to the target.
    return null;
  }
  return real;
}

/**
 * Evaluate one coverage profile over the graph (SPEC 8, 8.1, 8.2): classify
 * every node of the target group as ignored (with all applicable exclusion
 * reasons, fixed order), covered (with one shortest covering path under the
 * SPEC 12.0 byte tie rule), or uncovered. Callers pass a validated
 * configuration whose groups the profile references (SPEC 14.14).
 */
export function evaluateCoverageProfile(
  graph: WorkspaceGraph,
  configuration: Configuration,
  profile: CoverageProfile,
): ProfileCoverage {
  const targetGlobs = groupGlobs(configuration, "spec", profile.target);
  // SPEC 8: root nodes never participate in coverage paths.
  const roots = new Set<string>();
  for (const node of graph.requirementNodes) {
    if (node.id === null) roots.add(node.identity);
  }
  const boundary = boundaryNodes(graph, configuration, profile);
  const adjacency = coverageAdjacency(graph, profile, roots);

  const covered: CoveredNodeCoverage[] = [];
  const uncovered: string[] = [];
  const ignored: IgnoredNodeCoverage[] = [];
  // SPEC 8.1/8.2 over the target group's nodes, roots included (the root is
  // a node of its group — its exclusion from the required set is reported
  // as an ignored row). Graph order keeps every row list deterministic.
  for (const node of graph.requirementNodes) {
    if (!targetGlobs.some((glob) => glob.matches(node.path))) continue;
    const reasons = exclusionReasons(graph, profile, node);
    if (reasons.length > 0) {
      ignored.push({ identity: node.identity, reasons });
      continue;
    }
    const path = shortestCoveringPath(
      adjacency,
      boundary,
      node.identity,
      profile.mode,
    );
    if (path === null) {
      uncovered.push(node.identity);
    } else {
      covered.push({ identity: node.identity, path });
    }
  }
  return {
    name: profile.name,
    requiredCount: covered.length + uncovered.length,
    covered,
    uncovered,
    ignored,
  };
}
