// The built-in `path-blocks` review strategy (SPEC 10.5).
//
// Pure core (IMPLEMENTATION Architecture: review-session logic is core —
// deterministic, I/O-free): over the SPEC 5.6 change analysis of a
// baseline side and the current side (./changes.ts), this module generates
// the items of a `path-blocks` session — the default strategy for
// baseline-based sessions:
//
// For each `changed` node N, skipping nodes that have a `changed` ancestor
// (SPEC 10.5):
//
// 1. one `subtree-coherence` item — scope: N and all descendants, reviewed
//    as a single block (the stored scope is the subtree root, SPEC 10.5);
//    context: N's ancestor chain; origin: the `changed` nodes in scope;
// 2. one `parent-consistency` item per non-root ancestor A on the path to
//    the root — scope: A; context: the changed branches beneath A, each
//    entering as one context node, A's child on that branch; origin: the
//    changed branches' `changed` nodes; when multiple changed nodes share
//    A, A receives a single item against the union of changed branches.
//    Its `blockedBy` holds, for each changed branch, the item whose scope
//    node is A's child on that branch: that child's `subtree-coherence`
//    item when the child is the branch's changed node, otherwise the
//    child's `parent-consistency` item.
//
// For metadata and dependency impact (SPEC 10.5):
//
// 1. one `metadata-consistency` item per `metadata-changed` node — scope
//    and origin: that node; context: the added and removed `d` targets;
//    `coverage` and `tags` changes are described in the item's `reason`;
// 2. one `dependency-consistency` item per requirement node having a
//    dependency edge to a target present on both sides of the baseline
//    (SPEC 5.6) whose effectiveHash changed — scope: that node; context:
//    those changed targets; origin: the originating nodes (5.6) of the
//    targets' changes;
// 3. one `code-impact` item per impacted code location (SPEC 9.2) — scope:
//    that location; context: the targets of its impact edges whose
//    subtreeHash or effectiveHash changed (added and deleted targets
//    included, SPEC 9.2's counting); origin: the originating nodes (5.6)
//    of those targets' changes.
//
// The generation is consumed by src/core/review-derive.ts: `create` and
// re-derivation merge it into a session under the SPEC 10.5 rules, and
// reads match it to items for the current context sets of SPEC 10.4. The
// recorded baseline is the caller's to reconstruct (SPEC 6.3, 10.7:
// generators run with the session's recorded creation parameters — the
// recorded commit — against the current workspace).
//
// Attribution plumbing: the originating nodes of a target's subtreeHash or
// effectiveHash change follow from the change records' structure
// (./changes.ts): the causes of a subtreeHash change are the node itself
// when `changed` plus its `descendant-changed` attribution, and the causes
// of an effectiveHash change additionally include the node itself when its
// dependency edges changed plus its `upstream-changed` attribution — for a
// one-sided node, the node itself (SPEC 5.6, 9.2).

import type {
  ChangeAnalysis,
  ChangeAnalysisSide,
  NodeChange,
} from "./changes.js";
import { deriveChangeCategories } from "./changes.js";
import { compareBytes } from "./bytes.js";
import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import { collectImpactEdges, countsAsImpactChanged } from "./impact.js";
import { Journal } from "./journal.js";
import type {
  DecompositionContentSource,
  GeneratedBlockerRef,
  GeneratedItem,
  GeneratedNode,
} from "./review-derive.js";

/** The output of one generator run (SPEC 10.5, 10.4). */
export interface PathBlocksGeneration {
  /** The generated items, before decomposition replay
   * (review-derive.ts `expandDecompositions`), in a deterministic
   * generation order. */
  readonly items: readonly GeneratedItem[];
  /**
   * SPEC 10.4/9.2: per code-location identity, every impact-edge target's
   * stored identity — the union of the location's `references` and
   * `embeds` edges in the baseline graph and in the current graph. Covers
   * every location with any impact edge on either side, impacted or not,
   * so read-time invalidation can recompute any `code-impact` item's
   * state (review-state.ts `ReviewStateInputs.impactTargets`).
   */
  readonly impactTargets: ReadonlyMap<string, readonly string[]>;
  /** The strategy's decomposition content (SPEC 10.7), for
   * `expandDecompositions`. */
  readonly contentSource: DecompositionContentSource;
  /** SPEC 6.3: the journal entries applied since the baseline — maps a
   * baseline identity to its current (stored) spelling. */
  readonly replay: Journal;
}

/**
 * Run the `path-blocks` generators (module header) over the recorded
 * baseline and the current workspace. Both sides must be validated
 * workspaces satisfying the baseline-prefix invariant (SPEC 6.3) — the
 * precondition baseline resolution enforces for callers.
 */
export function generatePathBlocksItems(
  baseline: ChangeAnalysisSide,
  current: ChangeAnalysisSide,
): PathBlocksGeneration {
  return new PathBlocksComputation(baseline, current).compute();
}

/** Per-ancestor accumulation for SPEC 10.5 rule 2. */
interface ParentAccumulation {
  readonly ancestor: NodeChange;
  /** The distinct branch children (A's child on each changed branch). */
  readonly branches: NodeChange[];
  /** The changed branches' `changed` nodes. */
  readonly origins: NodeChange[];
}

class PathBlocksComputation {
  private readonly analysis: ChangeAnalysis;
  private readonly replay: Journal;
  /** Deterministic record order (the analysis' node order, SPEC 12.0). */
  private readonly ordinals = new Map<NodeChange, number>();
  /** Deleted records by stored (forward-mapped) identity. */
  private readonly deletedByStored = new Map<string, NodeChange>();
  /** Stored identity per record, memoized. */
  private readonly storedIdentities = new Map<NodeChange, string>();

  constructor(
    private readonly baseline: ChangeAnalysisSide,
    private readonly current: ChangeAnalysisSide,
  ) {
    this.analysis = deriveChangeCategories(baseline, current);
    // SPEC 6.3: the entries present now but absent at the baseline — the
    // baseline journal is a prefix of the current one (the callers'
    // precondition), so the suffix is the replay.
    this.replay = new Journal(
      current.journal.entries.slice(baseline.journal.entries.length),
    );
    this.analysis.nodes.forEach((record, index) => {
      this.ordinals.set(record, index);
      if (record.currentIdentity === null && record.baselineIdentity !== null) {
        this.deletedByStored.set(this.storedIdentity(record), record);
      }
    });
  }

  compute(): PathBlocksGeneration {
    const items: GeneratedItem[] = [];
    const parents = new Map<NodeChange, ParentAccumulation>();

    // SPEC 10.5: for each `changed` node, skipping nodes that have a
    // `changed` ancestor — rule 1 items, and rule 2 accumulation over the
    // surviving nodes' ancestor paths.
    for (const record of this.analysis.nodes) {
      if (!record.changed || this.hasChangedAncestor(record)) continue;
      items.push(this.subtreeCoherenceItem(record));
      this.accumulateParents(record, parents);
    }

    // SPEC 10.5: one `metadata-consistency` item per `metadata-changed`
    // node.
    for (const record of this.analysis.nodes) {
      if (!record.metadataChanged) continue;
      items.push(this.metadataConsistencyItem(record));
    }

    // SPEC 10.5: one `dependency-consistency` item per requirement node
    // having a dependency edge to a target present on both sides of the
    // baseline (5.6) whose effectiveHash changed. The node's dependency
    // edges are its current ones (`depends`/`embeds`, SPEC 5.2 — the
    // present tense of "having"); the both-sides restriction is the
    // target's (SPEC 5.6: "a dependency-consistency item arises only from
    // a target present on both sides"), so an edge to a target added
    // since the baseline — necessarily itself a new edge (SPEC 5.4) —
    // yields no item: that change is reviewed at its source (SPEC 10.5).
    for (const record of this.analysis.nodes) {
      if (record.currentIdentity === null) continue;
      const seen = new Set<NodeChange>();
      const targets: NodeChange[] = [];
      for (const edge of this.current.graph.outgoingEdges(
        record.currentIdentity,
      )) {
        if (edge.kind === "contains") continue;
        const target = this.analysis.byCurrentIdentity.get(edge.target);
        if (target === undefined || seen.has(target)) continue;
        seen.add(target);
        if (target.presence === "both" && target.effectiveChanged) {
          targets.push(target);
        }
      }
      if (targets.length === 0) continue;
      items.push(this.dependencyConsistencyItem(record, targets));
    }

    // SPEC 10.5 rule 2: one `parent-consistency` item per ancestor, the
    // union of changed branches — emitted in record order of the ancestor.
    const accumulations = [...parents.values()].sort(
      (a, b) => this.ordinalOf(a.ancestor) - this.ordinalOf(b.ancestor),
    );
    for (const accumulation of accumulations) {
      items.push(this.parentConsistencyItem(accumulation));
    }

    // SPEC 10.5/9.2: one `code-impact` item per impacted code location, in
    // byte order of location identity (SPEC 12.0).
    const impactEdges = collectImpactEdges(
      this.analysis,
      this.baseline.graph,
      this.current.graph,
    );
    const impactTargets = new Map<string, readonly string[]>();
    const locations = [...impactEdges.keys()].sort(compareBytes);
    for (const location of locations) {
      const targetMap = impactEdges.get(location);
      if (targetMap === undefined) continue;
      const targets = [...targetMap.keys()].sort(
        (a, b) => this.ordinalOf(a) - this.ordinalOf(b),
      );
      impactTargets.set(
        location,
        targets.map((target) => this.storedIdentity(target)),
      );
      const changedTargets = targets.filter((target) =>
        countsAsImpactChanged(target),
      );
      if (changedTargets.length === 0) continue; // not impacted (SPEC 9.2)
      items.push(this.codeImpactItem(location, targets, changedTargets));
    }

    return {
      items,
      impactTargets,
      contentSource: this.contentSource(),
      replay: this.replay,
    };
  }

  // -------------------------------------------------------------------------
  // Record plumbing
  // -------------------------------------------------------------------------

  private ordinalOf(record: NodeChange): number {
    const ordinal = this.ordinals.get(record);
    if (ordinal === undefined) {
      throw new Error("xspec internal error: change record without ordinal");
    }
    return ordinal;
  }

  /** SPEC 10.4/6.3: the record's stored identity — its current identity,
   * or its baseline identity mapped forward through the replay. */
  private storedIdentity(record: NodeChange): string {
    let identity = this.storedIdentities.get(record);
    if (identity === undefined) {
      if (record.currentIdentity !== null) {
        identity = record.currentIdentity;
      } else if (record.baselineIdentity !== null) {
        identity = this.replay.mapForward(record.baselineIdentity);
      } else {
        throw new Error("xspec internal error: change record with no identity");
      }
      this.storedIdentities.set(record, identity);
    }
    return identity;
  }

  private nodeOf(record: NodeChange): GeneratedNode {
    return {
      identity: this.storedIdentity(record),
      baselineIdentity: record.baselineIdentity,
    };
  }

  /** Distinct records as `GeneratedNode`s in record order (SPEC 12.0). */
  private nodesOf(records: Iterable<NodeChange>): GeneratedNode[] {
    const distinct = [...new Set(records)].sort(
      (a, b) => this.ordinalOf(a) - this.ordinalOf(b),
    );
    return distinct.map((record) => this.nodeOf(record));
  }

  /**
   * The record of the node's parent: along the current graph for a present
   * node, the baseline graph for a deleted one (its ancestors exist only
   * there). Undefined for a root (SPEC 1.2: roots have no parent).
   */
  private parentRecordOf(record: NodeChange): NodeChange | undefined {
    if (record.currentIdentity !== null) {
      const node = this.current.graph.requirementNode(record.currentIdentity);
      if (node === undefined) return undefined;
      const parent = this.current.graph.parentOf(node);
      if (parent === null) return undefined;
      return this.analysis.byCurrentIdentity.get(parent.identity);
    }
    if (record.baselineIdentity !== null) {
      const node = this.baseline.graph.requirementNode(record.baselineIdentity);
      if (node === undefined) return undefined;
      const parent = this.baseline.graph.parentOf(node);
      if (parent === null) return undefined;
      return this.analysis.byBaselineIdentity.get(parent.identity);
    }
    return undefined;
  }

  /** SPEC 10.5: whether the node has a `changed` ancestor. */
  private hasChangedAncestor(record: NodeChange): boolean {
    for (
      let ancestor = this.parentRecordOf(record);
      ancestor !== undefined;
      ancestor = this.parentRecordOf(ancestor)
    ) {
      if (ancestor.changed) return true;
    }
    return false;
  }

  /** The node's ancestor chain as records, nearest first (SPEC 10.5:
   * a `subtree-coherence` item's context). */
  private ancestorChain(record: NodeChange): NodeChange[] {
    const chain: NodeChange[] = [];
    for (
      let ancestor = this.parentRecordOf(record);
      ancestor !== undefined;
      ancestor = this.parentRecordOf(ancestor)
    ) {
      chain.push(ancestor);
    }
    return chain;
  }

  /** Whether the record's node is a file root (SPEC 1.5: a root's identity
   * is the bare path — no `#`). */
  private isRoot(record: NodeChange): boolean {
    return !this.storedIdentity(record).includes("#");
  }

  /**
   * The records within the node's scope — the node and all its
   * descendants on either side (SPEC 10.5: an added or deleted subtree's
   * members lie in one side's graph only), filtered by `include`.
   */
  private scopeRecords(
    record: NodeChange,
    include: (candidate: NodeChange) => boolean,
  ): Set<NodeChange> {
    const collected = new Set<NodeChange>();
    const walk = (
      graph: WorkspaceGraph,
      recordOf: ReadonlyMap<string, NodeChange>,
      identity: string,
    ): void => {
      const root = graph.requirementNode(identity);
      if (root === undefined) return;
      const stack: RequirementNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) break;
        const candidate = recordOf.get(node.identity);
        if (candidate !== undefined && include(candidate)) {
          collected.add(candidate);
        }
        for (const child of graph.childrenOf(node)) {
          stack.push(child);
        }
      }
    };
    if (record.currentIdentity !== null) {
      walk(
        this.current.graph,
        this.analysis.byCurrentIdentity,
        record.currentIdentity,
      );
    }
    if (record.baselineIdentity !== null) {
      walk(
        this.baseline.graph,
        this.analysis.byBaselineIdentity,
        record.baselineIdentity,
      );
    }
    return collected;
  }

  // -------------------------------------------------------------------------
  // Attribution (SPEC 5.6, 10.5)
  // -------------------------------------------------------------------------

  /** The originating nodes of the target's subtreeHash change: itself when
   * `changed`, plus its `descendant-changed` attribution — a one-sided
   * node counts as changed itself (SPEC 5.6, 9.2). */
  private subtreeChangeCauses(target: NodeChange): NodeChange[] {
    const causes: NodeChange[] = [];
    if (target.changed) causes.push(target);
    causes.push(...target.descendantChanged);
    return causes;
  }

  /** The originating nodes of the target's effectiveHash change: itself
   * when `changed` or when its own `d` targets changed, its
   * `descendant-changed` attribution, and its `upstream-changed`
   * attribution (SPEC 5.5's effectiveHash inputs; SPEC 5.6). */
  private effectiveChangeCauses(target: NodeChange): NodeChange[] {
    const causes: NodeChange[] = [];
    if (target.changed || target.depEdgesChanged) causes.push(target);
    causes.push(...target.descendantChanged);
    causes.push(...target.upstreamChanged);
    return causes;
  }

  // -------------------------------------------------------------------------
  // Rule 1: subtree-coherence (SPEC 10.5)
  // -------------------------------------------------------------------------

  private subtreeCoherenceItem(record: NodeChange): GeneratedItem {
    // SPEC 10.5: origin is the `changed` nodes in scope — the node and its
    // changed descendants on either side.
    const origin = this.scopeRecords(record, (candidate) => candidate.changed);
    const scope = this.nodeOf(record);
    return {
      kind: "subtree-coherence",
      scope,
      context: this.nodesOf(this.ancestorChain(record)),
      origin: this.nodesOf(origin),
      reason:
        `the subtree rooted at ${scope.identity} changed relative to the ` +
        `baseline; review the node and all its descendants as a single ` +
        `block (SPEC 10.5)`,
      blockedBy: [],
    };
  }

  // -------------------------------------------------------------------------
  // Rule 2: parent-consistency (SPEC 10.5)
  // -------------------------------------------------------------------------

  /** Accumulate the surviving changed node's path to the root into the
   * per-ancestor unions of SPEC 10.5 rule 2. */
  private accumulateParents(
    record: NodeChange,
    parents: Map<NodeChange, ParentAccumulation>,
  ): void {
    let child = record;
    for (
      let ancestor = this.parentRecordOf(record);
      ancestor !== undefined;
      ancestor = this.parentRecordOf(ancestor)
    ) {
      // SPEC 10.5: one item per *non-root* ancestor on the path to the
      // root; the root itself receives none.
      if (!this.isRoot(ancestor)) {
        let accumulation = parents.get(ancestor);
        if (accumulation === undefined) {
          accumulation = { ancestor, branches: [], origins: [] };
          parents.set(ancestor, accumulation);
        }
        // SPEC 10.5: each changed branch enters as one context node — A's
        // child on that branch; multiple changed nodes sharing A union.
        if (!accumulation.branches.includes(child)) {
          accumulation.branches.push(child);
        }
        if (!accumulation.origins.includes(record)) {
          accumulation.origins.push(record);
        }
      }
      child = ancestor;
    }
  }

  private parentConsistencyItem(
    accumulation: ParentAccumulation,
  ): GeneratedItem {
    const scope = this.nodeOf(accumulation.ancestor);
    const branches = [...accumulation.branches].sort(
      (a, b) => this.ordinalOf(a) - this.ordinalOf(b),
    );
    // SPEC 10.5: blockedBy holds, per changed branch, the item whose scope
    // node is A's child on that branch — the child's subtree-coherence
    // item when the child is the branch's changed node (a changed child of
    // an unchanged ancestor is exactly a surviving changed node), the
    // child's parent-consistency item otherwise.
    const blockedBy: GeneratedBlockerRef[] = branches.map((branch) => ({
      kind: branch.changed ? "subtree-coherence" : "parent-consistency",
      scope: this.storedIdentity(branch),
    }));
    return {
      kind: "parent-consistency",
      scope,
      context: branches.map((branch) => this.nodeOf(branch)),
      origin: this.nodesOf(accumulation.origins),
      reason:
        `changed branches lie beneath ${scope.identity}; review its own ` +
        `text against them for consistency (SPEC 10.5)`,
      blockedBy,
    };
  }

  // -------------------------------------------------------------------------
  // Metadata impact (SPEC 10.5)
  // -------------------------------------------------------------------------

  /** The node's `d`-declared (`depends`) target set on one side, as
   * canonical keys with a representative record each (SPEC 5.5: the
   * metadataHash covers the `d` target set; SPEC 5.4: targets compare as
   * canonical identities). */
  private dTargets(
    side: "baseline" | "current",
    identity: string,
  ): Map<string, NodeChange> {
    const graph =
      side === "baseline" ? this.baseline.graph : this.current.graph;
    const journal =
      side === "baseline" ? this.baseline.journal : this.current.journal;
    const recordOf =
      side === "baseline"
        ? this.analysis.byBaselineIdentity
        : this.analysis.byCurrentIdentity;
    const targets = new Map<string, NodeChange>();
    for (const edge of graph.outgoingEdges(identity)) {
      if (edge.kind !== "depends") continue;
      const record = recordOf.get(edge.target);
      if (record === undefined) continue; // unreachable for valid graphs
      const canonical = journal.canonicalIdentity(edge.target);
      // Injective: the position is decimal digits, so the first ":" splits
      // (SPEC 5.4; the same key shape as core/changes.ts). The prefix
      // invariant (SPEC 6.3) makes a node's key side-independent.
      targets.set(
        `${String(canonical.position)}:${canonical.identity}`,
        record,
      );
    }
    return targets;
  }

  private metadataConsistencyItem(record: NodeChange): GeneratedItem {
    // `metadata-changed` is a both-sides category (SPEC 5.6): both
    // identities exist.
    const baselineIdentity = record.baselineIdentity as string;
    const currentIdentity = record.currentIdentity as string;
    const before = this.dTargets("baseline", baselineIdentity);
    const after = this.dTargets("current", currentIdentity);
    // SPEC 10.5: context is the added and removed `d` targets.
    const added: NodeChange[] = [];
    const removed: NodeChange[] = [];
    for (const [key, target] of after) {
      if (!before.has(key)) added.push(target);
    }
    for (const [key, target] of before) {
      if (!after.has(key)) removed.push(target);
    }

    // SPEC 10.5: `coverage` and `tags` changes are described in the
    // item's `reason`. Both nodes exist (both-sides); their sections carry
    // the effective coverage attribute (SPEC 2.5) and tags (SPEC 2.6).
    const baselineNode = this.baseline.graph.requirementNode(baselineIdentity);
    const currentNode = this.current.graph.requirementNode(currentIdentity);
    const parts: string[] = [];
    if (added.length > 0) {
      parts.push(
        `d targets added: ` +
          this.nodesOf(added)
            .map((node) => node.identity)
            .join(", "),
      );
    }
    if (removed.length > 0) {
      parts.push(
        `d targets removed: ` +
          this.nodesOf(removed)
            .map((node) => node.identity)
            .join(", "),
      );
    }
    if (baselineNode !== undefined && currentNode !== undefined) {
      const coverageBefore = baselineNode.section.coverage ?? "(none)";
      const coverageAfter = currentNode.section.coverage ?? "(none)";
      if (coverageBefore !== coverageAfter) {
        parts.push(
          `coverage changed from ${coverageBefore} to ${coverageAfter}`,
        );
      }
      const tagsBefore = [...baselineNode.section.tags].sort(compareBytes);
      const tagsAfter = [...currentNode.section.tags].sort(compareBytes);
      if (tagsBefore.join(" ") !== tagsAfter.join(" ")) {
        parts.push(
          `tags changed from [${tagsBefore.join(", ")}] to ` +
            `[${tagsAfter.join(", ")}]`,
        );
      }
    }
    const scope = this.nodeOf(record);
    return {
      kind: "metadata-consistency",
      scope,
      context: this.nodesOf([...added, ...removed]),
      // SPEC 10.5: scope and origin are the metadata-changed node itself.
      origin: [scope],
      reason:
        `the metadata of ${scope.identity} changed relative to the ` +
        `baseline` +
        (parts.length > 0 ? `: ${parts.join("; ")}` : "") +
        ` (SPEC 10.5)`,
      blockedBy: [],
    };
  }

  // -------------------------------------------------------------------------
  // Dependency impact (SPEC 10.5)
  // -------------------------------------------------------------------------

  private dependencyConsistencyItem(
    record: NodeChange,
    targets: readonly NodeChange[],
  ): GeneratedItem {
    // SPEC 10.5: origin is the originating nodes (5.6) of the targets'
    // changes — the causes of each target's effectiveHash change.
    const origin = new Set<NodeChange>();
    for (const target of targets) {
      for (const cause of this.effectiveChangeCauses(target)) {
        origin.add(cause);
      }
    }
    const scope = this.nodeOf(record);
    return {
      kind: "dependency-consistency",
      scope,
      context: this.nodesOf(targets),
      origin: this.nodesOf(origin),
      reason:
        `dependency targets of ${scope.identity} changed effectively ` +
        `relative to the baseline; review the node against them ` +
        `(SPEC 10.5)`,
      blockedBy: [],
    };
  }

  // -------------------------------------------------------------------------
  // Code impact (SPEC 10.5, 9.2)
  // -------------------------------------------------------------------------

  /** The location as a `GeneratedNode`: code locations are never
   * journal-mapped (SPEC 6.4/6.5 map requirement identities and spec
   * files), so the identity is side-independent. */
  private locationNode(location: string): GeneratedNode {
    return {
      identity: location,
      baselineIdentity:
        this.baseline.graph.codeLocation(location) !== undefined
          ? location
          : null,
    };
  }

  private codeImpactItem(
    location: string,
    allTargets: readonly NodeChange[],
    changedTargets: readonly NodeChange[],
  ): GeneratedItem {
    // SPEC 10.5: origin is the originating nodes (5.6) of the changed
    // targets' changes — subtreeHash causes for direct impact,
    // effectiveHash causes for transitive impact, a one-sided target
    // counting as its own change (SPEC 9.2).
    const origin = new Set<NodeChange>();
    for (const target of changedTargets) {
      if (target.presence !== "both") {
        origin.add(target);
        continue;
      }
      if (target.subtreeChanged) {
        for (const cause of this.subtreeChangeCauses(target)) {
          origin.add(cause);
        }
      }
      if (target.effectiveChanged) {
        for (const cause of this.effectiveChangeCauses(target)) {
          origin.add(cause);
        }
      }
    }
    return {
      kind: "code-impact",
      scope: this.locationNode(location),
      // SPEC 10.5: context is the targets that make the location impacted
      // — those whose subtreeHash or effectiveHash changed, added and
      // deleted targets included (SPEC 9.2).
      context: this.nodesOf(changedTargets),
      origin: this.nodesOf(origin),
      reason:
        `the code location ${location} is impacted: requirement nodes it ` +
        `references or embeds changed relative to the baseline ` +
        `(SPEC 9.2, 10.5)`,
      blockedBy: [],
      // SPEC 10.4: the recorded state covers every impact-edge target.
      impactTargets: this.nodesOf(allTargets),
    };
  }

  // -------------------------------------------------------------------------
  // Decomposition content (SPEC 10.7 — review-derive.ts's replay seam)
  // -------------------------------------------------------------------------

  /** The record bearing a stored identity, if any: a present node's, else
   * a deleted node's whose forward-mapped identity matches. */
  private recordOfStored(identity: string): NodeChange | undefined {
    return (
      this.analysis.byCurrentIdentity.get(identity) ??
      this.deletedByStored.get(identity)
    );
  }

  private generatedNodeOfStored(identity: string): GeneratedNode {
    const record = this.recordOfStored(identity);
    if (record !== undefined) return this.nodeOf(record);
    return { identity, baselineIdentity: null };
  }

  private contentSource(): DecompositionContentSource {
    return {
      // SPEC 10.7: one subtree-coherence item per child subtree — its
      // context the child's ancestor chain, as in 10.5; its origin the
      // originating nodes (5.6) within its scope and context.
      subtreeCoherenceItem: (scopeIdentity): GeneratedItem => {
        const record = this.recordOfStored(scopeIdentity);
        const scope = this.generatedNodeOfStored(scopeIdentity);
        const chain = record === undefined ? [] : this.ancestorChain(record);
        const origin = new Set<NodeChange>();
        if (record !== undefined) {
          // Within its scope: the subtree's originating nodes (5.6 —
          // `changed` or `metadata-changed`).
          for (const member of this.scopeRecords(
            record,
            (candidate) => candidate.changed || candidate.metadataChanged,
          )) {
            origin.add(member);
          }
          // Within its context: the ancestor chain's own originating
          // nodes.
          for (const ancestor of chain) {
            if (ancestor.changed || ancestor.metadataChanged) {
              origin.add(ancestor);
            }
          }
        }
        return {
          kind: "subtree-coherence",
          scope,
          context: this.nodesOf(chain),
          origin: this.nodesOf(origin),
          reason:
            `review the subtree rooted at ${scope.identity} as a single ` +
            `block — split from its parent's review (SPEC 10.7, 10.5)`,
          blockedBy: [],
        };
      },
      // SPEC 10.7: the scope root's parent-consistency item — for its own
      // text, context the child subtrees, blocked by the child items.
      splitParentConsistencyItem: (
        scopeIdentity,
        childIdentities,
      ): GeneratedItem => {
        const record = this.recordOfStored(scopeIdentity);
        const scope = this.generatedNodeOfStored(scopeIdentity);
        const origin = new Set<NodeChange>();
        if (record !== undefined) {
          // The originating nodes within its scope (the root) and its
          // context (the child subtrees) — together, the root's subtree.
          for (const member of this.scopeRecords(
            record,
            (candidate) => candidate.changed || candidate.metadataChanged,
          )) {
            origin.add(member);
          }
        }
        return {
          kind: "parent-consistency",
          scope,
          context: childIdentities.map((identity) =>
            this.generatedNodeOfStored(identity),
          ),
          origin: this.nodesOf(origin),
          reason:
            `review the own text of ${scope.identity} against its child ` +
            `subtrees — split from its subtree review (SPEC 10.7)`,
          blockedBy: childIdentities.map((identity) => ({
            kind: "subtree-coherence",
            scope: identity,
          })),
        };
      },
    };
  }
}
