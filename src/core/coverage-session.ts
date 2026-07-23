// The built-in `coverage` review strategy (SPEC 10.7).
//
// Pure core (IMPLEMENTATION Architecture: review-session logic is core —
// deterministic, I/O-free): over the current workspace graph and a coverage
// session's recorded profile definition (SPEC 10.7: the named profile's 7.4
// fields, with each group name replaced by that group's configured glob list
// and kind at `create`), this module generates the session's items — one
// `uncovered-requirement` item per uncovered required node of the recorded
// profile: scope the node, context its ancestor chain, origin and
// `blockedBy` empty. Item order — file path, then document order — is
// `sortItemsByFileThenDocument` (review-derive.ts).
//
// Every generator run — `create` and the resolve-time re-derivation of
// SPEC 10.5, which holds for every strategy — uses the recorded parameters:
// the recorded globs are compiled and matched against the currently
// discovered sources (the current graph's nodes), so renaming or editing
// refs, profiles, or groups after `create` never changes what the session
// runs with, while discovery itself follows the current configuration — a
// file that no longer belongs to any configured group contributes no
// current node and is out of the session's view, exactly as if deleted
// (SPEC 10.7). The evaluation itself is the shared resolved-profile seam of
// src/core/coverage.ts (SPEC 8, 8.1), so the coverage command and coverage
// sessions can never disagree about coverage.
//
// A coverage session has no baseline: generated nodes carry no baseline
// identity, and an item's `baseline` is the current graph's values at the
// moment it enters the session (SPEC 10.2).

import type {
  CoveragePathMatcher,
  ResolvedCoverageProfile,
} from "./coverage.js";
import { evaluateResolvedCoverageProfile } from "./coverage.js";
import { compileGlob } from "./glob.js";
import type { WorkspaceGraph } from "./graph.js";
import type { RecordedProfile } from "./review.js";
import type {
  DecompositionContentSource,
  GeneratedItem,
} from "./review-derive.js";
import { currentAncestorChain } from "./review-derive.js";

/** The output of one coverage-session generator run (SPEC 10.7). */
export interface CoverageSessionGeneration {
  /** The generated items, before decomposition replay
   * (review-derive.ts `expandDecompositions`), in graph node order —
   * file path, then document order: the coverage item order (SPEC 10.7,
   * 12.0). */
  readonly items: readonly GeneratedItem[];
  /** The strategy's decomposition content (SPEC 10.7), for
   * `expandDecompositions`. No command records a decomposition in a
   * coverage session — `split` applies only to `subtree-coherence` items —
   * so this source keeps the replay total, nothing more. */
  readonly contentSource: DecompositionContentSource;
}

/** A matcher matching no path — the evaluation of a pattern that cannot
 * match any discovered source (`compileRecordedPattern`). */
const MATCHES_NOTHING: CoveragePathMatcher = {
  matches: () => false,
};

/**
 * Compile one recorded glob pattern in plain mode (SPEC 7: group globs
 * support exactly `*`, `?`, and `**`). A validated configuration cannot
 * hold an outside-root group pattern (SPEC 7 → 14.14), so a recorded
 * pattern failing to compile can only enter by external modification of the
 * session file; such a pattern resolves outside the workspace root and can
 * match no discovered source (SPEC 7), so it evaluates as matching nothing
 * — total and deterministic.
 */
function compileRecordedPattern(pattern: string): CoveragePathMatcher {
  const compiled = compileGlob(pattern, "plain");
  return compiled.ok ? compiled.glob : MATCHES_NOTHING;
}

/**
 * SPEC 10.7: resolve a session's recorded profile definition for
 * evaluation — the recorded glob lists compiled, to be matched against the
 * currently discovered sources; the recorded kinds, tags, targets, mode,
 * and edge kinds carried as recorded.
 */
export function resolveRecordedCoverageProfile(
  profile: RecordedProfile,
): ResolvedCoverageProfile {
  return {
    name: profile.name,
    targetGlobs: profile.target.globs.map(compileRecordedPattern),
    targetTags: profile.targetTags,
    targets: profile.targets,
    boundaryKind: profile.boundary.kind,
    boundaryGlobs: profile.boundary.globs.map(compileRecordedPattern),
    mode: profile.mode,
    edgeKinds: profile.edgeKinds,
  };
}

/**
 * Run the `coverage` generators (module header) over the current workspace
 * graph with the session's recorded profile: one `uncovered-requirement`
 * item per uncovered required node (SPEC 10.7, 8.1), in graph node order —
 * the coverage item order.
 */
export function generateCoverageSessionItems(
  graph: WorkspaceGraph,
  profile: RecordedProfile,
): CoverageSessionGeneration {
  const coverage = evaluateResolvedCoverageProfile(
    graph,
    resolveRecordedCoverageProfile(profile),
  );
  // `uncovered` follows the graph's requirement-node order — file path
  // bytes, then document order — the coverage item order (SPEC 10.7).
  const items = coverage.uncovered.map((identity): GeneratedItem => ({
    kind: "uncovered-requirement",
    // SPEC 10.7: scope is the node; context its ancestor chain; origin
    // and blockedBy empty.
    scope: { identity, baselineIdentity: null },
    context: currentAncestorChain(graph, identity),
    origin: [],
    reason:
      `${identity} is a required node of the coverage profile ` +
      `${profile.name} that no permitted dependency path covers ` +
      `(SPEC 8, 10.7)`,
    blockedBy: [],
  }));
  return { items, contentSource: coverageContentSource(graph) };
}

/**
 * The SPEC 10.7 split-decomposition content over the current graph, with
 * the empty origins of a session without originating nodes (SPEC 5.6 needs
 * a baseline; a coverage session has none). Unreachable through the
 * commands (`split` refuses every kind but `subtree-coherence`, and a
 * coverage session contains none), but the replay stays total over
 * externally supplied decompositions: child items carry only what SPEC 10.7
 * assigns them — the split rule blocks the `parent-consistency` item on the
 * child items and nothing else.
 */
function coverageContentSource(
  graph: WorkspaceGraph,
): DecompositionContentSource {
  return {
    subtreeCoherenceItem: (scopeIdentity): GeneratedItem => ({
      kind: "subtree-coherence",
      scope: { identity: scopeIdentity, baselineIdentity: null },
      context: currentAncestorChain(graph, scopeIdentity),
      origin: [],
      reason:
        `review the subtree rooted at ${scopeIdentity} as a single block — ` +
        `split from its parent's review (SPEC 10.7, 10.5)`,
      blockedBy: [],
    }),
    splitParentConsistencyItem: (
      scopeIdentity,
      childIdentities,
    ): GeneratedItem => ({
      kind: "parent-consistency",
      scope: { identity: scopeIdentity, baselineIdentity: null },
      context: childIdentities.map((identity) => ({
        identity,
        baselineIdentity: null,
      })),
      origin: [],
      reason:
        `review the own text of ${scopeIdentity} against its child ` +
        `subtrees — split from its subtree review (SPEC 10.7)`,
      blockedBy: childIdentities.map((identity) => ({
        kind: "subtree-coherence" as const,
        scope: identity,
      })),
    }),
  };
}
