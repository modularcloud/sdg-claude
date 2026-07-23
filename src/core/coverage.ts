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
//
// The evaluation runs over a `ResolvedCoverageProfile` — the profile's 7.4
// fields with each group reference resolved to its glob matchers — so the
// one implementation serves both consumers (the shared-seam pattern of
// SPEC 9.2's impact edges): the `xspec coverage` command resolves a
// configured profile against the current configuration
// (`resolveConfiguredCoverageProfile`), while a `coverage` review session
// resolves its recorded profile definition — the recorded glob lists,
// compiled — and matches them against the currently discovered sources
// (SPEC 10.7; src/core/coverage-session.ts).

import type { Configuration, CoverageProfile } from "./config.js";
import type { DependencyEdgeKind } from "./config.js";
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

/** A compiled path matcher (core/glob.ts `CompiledGlob` satisfies this). */
export interface CoveragePathMatcher {
  matches(path: string): boolean;
}

/**
 * A coverage profile ready for evaluation (module header): the SPEC 7.4
 * fields with each group reference resolved to the group's kind and glob
 * matchers. How the matchers are obtained is the caller's — the current
 * configuration's compiled globs (`resolveConfiguredCoverageProfile`), or a
 * review session's recorded glob lists compiled at use (SPEC 10.7).
 */
export interface ResolvedCoverageProfile {
  readonly name: string;
  /** The target spec group's glob matchers (SPEC 7.4). */
  readonly targetGlobs: readonly CoveragePathMatcher[];
  /** When present, never empty (SPEC 7.4). */
  readonly targetTags?: readonly string[];
  readonly targets: "leaves" | "all";
  readonly boundaryKind: "spec" | "code";
  readonly boundaryGlobs: readonly CoveragePathMatcher[];
  readonly mode: "direct" | "transitive";
  /** Never empty (SPEC 7.4: defaults to all three). */
  readonly edgeKinds: readonly DependencyEdgeKind[];
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
  profile: ResolvedCoverageProfile,
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
): readonly CoveragePathMatcher[] {
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
  profile: ResolvedCoverageProfile,
): Set<string> {
  const globs = profile.boundaryGlobs;
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
  profile: ResolvedCoverageProfile,
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
 * Resolve a configured profile's group references against the current
 * configuration (SPEC 7.4): the target is a spec group; the boundary group
 * is looked up under the profile's resolved boundary kind. Callers pass a
 * validated configuration whose groups the profile references (SPEC 14.14).
 */
export function resolveConfiguredCoverageProfile(
  configuration: Configuration,
  profile: CoverageProfile,
): ResolvedCoverageProfile {
  return {
    name: profile.name,
    targetGlobs: groupGlobs(configuration, "spec", profile.target),
    targetTags: profile.targetTags,
    targets: profile.targets,
    boundaryKind: profile.boundaryKind,
    boundaryGlobs: groupGlobs(
      configuration,
      profile.boundaryKind,
      profile.boundary,
    ),
    mode: profile.mode,
    edgeKinds: profile.edgeKinds,
  };
}

/**
 * Evaluate one resolved coverage profile over the graph (SPEC 8, 8.1, 8.2):
 * classify every node of the target group as ignored (with all applicable
 * exclusion reasons, fixed order), covered (with one shortest covering path
 * under the SPEC 12.0 byte tie rule), or uncovered. The graph fixes the
 * node universe: the matchers select among the discovered sources' nodes,
 * so a recorded profile's globs are matched against the currently
 * discovered sources exactly as SPEC 10.7 requires.
 */
export function evaluateResolvedCoverageProfile(
  graph: WorkspaceGraph,
  profile: ResolvedCoverageProfile,
): ProfileCoverage {
  const targetGlobs = profile.targetGlobs;
  // SPEC 8: root nodes never participate in coverage paths.
  const roots = new Set<string>();
  for (const node of graph.requirementNodes) {
    if (node.id === null) roots.add(node.identity);
  }
  const boundary = boundaryNodes(graph, profile);
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

/**
 * Evaluate one configured coverage profile over the graph (SPEC 8, 8.1,
 * 8.2): `resolveConfiguredCoverageProfile` composed with
 * `evaluateResolvedCoverageProfile` — the `xspec coverage` command's entry.
 */
export function evaluateCoverageProfile(
  graph: WorkspaceGraph,
  configuration: Configuration,
  profile: CoverageProfile,
): ProfileCoverage {
  return evaluateResolvedCoverageProfile(
    graph,
    resolveConfiguredCoverageProfile(configuration, profile),
  );
}
