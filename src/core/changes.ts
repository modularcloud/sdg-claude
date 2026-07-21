// Change categories relative to a baseline (SPEC 5.6).
//
// Pure core (IMPLEMENTATION Architecture: impact derivation is core —
// deterministic, I/O-free): over a baseline side and the current side —
// each a (graph, hashes, journal) triple, the hashes computed with that
// side's journal (SPEC 6.3) — this module matches every requirement node
// across the two sides and derives the zero or more categories of SPEC 5.6,
// each attributed to its originating nodes:
//
// - changed — the node was added or deleted, or its ownHash changed
//   (adding, removing, or reordering its children included: identities
//   enter own content at their positions, so structural child edits
//   originate at the parent — SPEC 5.5, 5.6);
// - metadata-changed — its metadataHash changed;
// - descendant-changed — its subtreeHash changed because of a change in a
//   descendant;
// - upstream-changed — its effectiveHash changed because the effectiveHash
//   of a dependency-edge target (of the node or of a node in its subtree)
//   changed, or because a node in its subtree other than the node itself
//   had dependency edges added, removed, or retargeted.
//
// Matching (SPEC 5.4, 6.3): nodes are matched by canonical identity — the
// (identity, journal position) pair of the backward journal walk, computed
// per side with that side's journal. Because the baseline journal is a
// prefix of the current journal (SPEC 6.1, 6.3 — callers obtain the two
// sides from baseline resolution, which enforces the prefix), a baseline
// node and the current node its identity forward-maps to under the replayed
// entries walk back to the same (identity, position) pair, while an
// identity vacated by a journaled operation and later reintroduced by a
// distinct node walks back to a later position and matches nothing —
// exactly SPEC 6.3's mapping with SPEC 9.3's reused-identity semantics
// (distinct nodes never match). A node whose canonical identity exists on
// both sides is present on both sides; one present only at the baseline is
// deleted; one present only currently is added.
//
// Both-sides rule (SPEC 5.6): an added or deleted node is `changed` and
// receives no category through its own hashes — never `metadata-changed`,
// `descendant-changed`, or `upstream-changed`, whatever metadata, children,
// or dependency edges it carries — and every hash comparison below is made
// only for nodes present on both sides. (The one stated exception,
// impacted-code counting under SPEC 9.2, is the impact renderer's, not this
// module's.)
//
// Derivation: the leaf comparisons are hash equality — ownHash,
// metadataHash, subtreeHash, effectiveHash per side (byte-identical under
// the pure operations of SPEC 6.2, because references hash by canonical
// identity) — and the dependency-edge multiset comparison; the propagated
// categories are derived structurally so each carries its attribution
// (SPEC 5.6: every category MUST be attributed to its originating nodes —
// those carrying `changed` or `metadata-changed`):
//
// - descendant-changed: the changed nodes strictly within the node's
//   subtree, on either side (a deleted descendant lies in the baseline-side
//   subtree, an added one in the current-side subtree). Any such node makes
//   the subtreeHash differ, and a subtreeHash difference not explained by
//   the node's own content is explained by one of them (SPEC 5.5
//   properties), so the flag holds exactly when the attribution set is
//   non-empty.
// - upstream-changed: computed recursively over the relation that is
//   comparable across sides — children matched as children on both sides
//   and dependency-edge targets carried by edges present on both sides (a
//   sub-relation of the baseline dependency graph, so acyclic for valid
//   inputs, SPEC 5.3). A matched dependency target contributes every
//   originating cause of its own effectiveHash change; a matched child
//   contributes its own upstream causes plus itself when its dependency
//   edges changed (SPEC 5.6: "a node in its subtree other than the node
//   itself"). The node's own dependency-edge edits are excluded — they
//   surface as `metadata-changed` (a `d` edit) or `changed` (a `text(...)`
//   edit changes own content), never as the node's own `upstream-changed`.
//   A one-sided child slot — an added or deleted child, or a child moved in
//   or out by a journaled move — contributes nothing here: its arrival or
//   departure changes the parent's own content (`changed`, with the
//   descendant cascade above); per the both-sides rule its dependency edges
//   are not compared.
//
// The worked cascades of SPEC 5.6 fall out: a leaf edit makes the leaf
// `changed`, ancestors `descendant-changed` attributed to the leaf, and
// dependents of path nodes plus those dependents' ancestors
// `upstream-changed` attributed to the leaf; a child add/remove originates
// at both the child and the parent; a `d`-target edit on D makes D
// `metadata-changed` and every other effectiveHash-affected node
// `upstream-changed` attributed to D; a coverage/tags-only edit changes no
// effectiveHash and propagates nothing.

import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import type { NodeHashes } from "./hashes.js";
import type { Journal } from "./journal.js";

/** One side of the comparison: its graph, hashes, and journal (SPEC 6.3). */
export interface ChangeAnalysisSide {
  readonly graph: WorkspaceGraph;
  /** SPEC 5.5: the side's hashes, computed with the side's journal. */
  readonly hashes: ReadonlyMap<string, NodeHashes>;
  /** SPEC 5.4: the journal the side's canonical identities walk. */
  readonly journal: Journal;
}

/** SPEC 5.6: the four category names, in listing order. */
export type ChangeCategoryName =
  "changed" | "metadata-changed" | "descendant-changed" | "upstream-changed";

/** Whether a node exists on both sides, only currently, or only at the
 * baseline (SPEC 5.6: added / deleted). */
export type NodePresence = "both" | "added" | "deleted";

/**
 * One requirement node's change record (SPEC 5.6). Categories are
 * independent flags; the propagated ones carry their attribution — a
 * non-empty attribution list is the flag. Records are shared: attribution
 * entries are the records of the originating nodes themselves.
 */
export interface NodeChange {
  readonly presence: NodePresence;
  /** The node's identity at the baseline — null exactly when added. */
  readonly baselineIdentity: string | null;
  /** The node's current identity — null exactly when deleted (SPEC 9.3
   * reports such nodes under the forward-mapped baseline identity; the
   * mapping is the caller's, via the replayed journal entries). */
  readonly currentIdentity: string | null;
  /** SPEC 5.6 `changed`: added, deleted, or ownHash changed. */
  readonly changed: boolean;
  /** SPEC 5.6 `metadata-changed`: metadataHash changed (both sides only). */
  readonly metadataChanged: boolean;
  /** SPEC 5.5: subtreeHash differs (both-sides nodes only; always false
   * for added/deleted nodes — the both-sides rule). */
  readonly subtreeChanged: boolean;
  /** SPEC 5.5: effectiveHash differs (both-sides nodes only). */
  readonly effectiveChanged: boolean;
  /**
   * SPEC 5.6 `descendant-changed` with its attribution: the `changed`
   * records strictly within the node's subtree on either side, in record
   * order. Non-empty exactly when the node is `descendant-changed`.
   */
  readonly descendantChanged: readonly NodeChange[];
  /**
   * SPEC 5.6 `upstream-changed` with its attribution: the originating
   * records reached through dependency-edge targets and subtree dependency
   * edits (module header), in record order. Non-empty exactly when the
   * node is `upstream-changed`.
   */
  readonly upstreamChanged: readonly NodeChange[];
  /**
   * SPEC 5.5/5.6: the node's per-edge dependency-target multiset differs —
   * a dependency edge was added, removed, or retargeted (both-sides nodes
   * only; always false for added/deleted nodes, the both-sides rule). With
   * no `changed` flag this is exactly a `d`-target change (a `text(...)`
   * edit changes own content), so `changed || depEdgesChanged` is SPEC
   * 9.3's propagation-path terminus: "a node whose own edit explains the
   * change — a `changed` node, or a `metadata-changed` node whose `d`
   * targets changed".
   */
  readonly depEdgesChanged: boolean;
  /**
   * The node's children matched as children on both sides (module header) —
   * the `contains` steps of SPEC 9.3's propagation paths, in the current
   * side's document order. Empty for added/deleted nodes.
   */
  readonly matchedChildren: readonly NodeChange[];
  /**
   * The targets of the node's dependency edges present on both sides
   * (module header) — the dependency steps of SPEC 9.3's propagation
   * paths, one record per matched target, in the current side's edge
   * order. Empty for added/deleted nodes.
   */
  readonly matchedDependencyTargets: readonly NodeChange[];
}

/** One category of one node with its attribution (SPEC 5.6, 9.1). */
export interface NodeCategory {
  readonly category: ChangeCategoryName;
  /**
   * The originating records the category is attributed to (SPEC 5.6). An
   * originating category (`changed`, `metadata-changed`) is attributed to
   * the node itself — the node where the edit occurred.
   */
  readonly attributedTo: readonly NodeChange[];
}

/** The node's categories in SPEC 5.6 listing order — empty when unchanged. */
export function nodeCategories(node: NodeChange): NodeCategory[] {
  const categories: NodeCategory[] = [];
  if (node.changed) {
    categories.push({ category: "changed", attributedTo: [node] });
  }
  if (node.metadataChanged) {
    categories.push({ category: "metadata-changed", attributedTo: [node] });
  }
  if (node.descendantChanged.length > 0) {
    categories.push({
      category: "descendant-changed",
      attributedTo: node.descendantChanged,
    });
  }
  if (node.upstreamChanged.length > 0) {
    categories.push({
      category: "upstream-changed",
      attributedTo: node.upstreamChanged,
    });
  }
  return categories;
}

/**
 * The full comparison: one record per requirement node of either side.
 * `nodes` is deterministically ordered (SPEC 12.0): the current graph's
 * node order — file path in byte order, document order within a file —
 * followed by the deleted records in the baseline graph's node order.
 */
export interface ChangeAnalysis {
  readonly nodes: readonly NodeChange[];
  /** Present nodes (both-sides and added) by current identity. */
  readonly byCurrentIdentity: ReadonlyMap<string, NodeChange>;
  /** Baseline nodes (both-sides and deleted) by baseline identity. */
  readonly byBaselineIdentity: ReadonlyMap<string, NodeChange>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** The mutable shape the exposed records are built through. */
interface MutableNodeChange {
  presence: NodePresence;
  baselineIdentity: string | null;
  currentIdentity: string | null;
  changed: boolean;
  metadataChanged: boolean;
  subtreeChanged: boolean;
  effectiveChanged: boolean;
  descendantChanged: NodeChange[];
  upstreamChanged: NodeChange[];
  depEdgesChanged: boolean;
  matchedChildren: NodeChange[];
  matchedDependencyTargets: NodeChange[];
}

/** One record's full internal state. */
interface RecordState {
  readonly change: MutableNodeChange;
  /** Position in `nodes` — the deterministic record order (SPEC 12.0). */
  readonly ordinal: number;
  readonly baselineNode: RequirementNode | null;
  readonly currentNode: RequirementNode | null;
  /** Both sides only: ownHash differs (SPEC 5.5). */
  ownChanged: boolean;
  /** Both sides only: the dependency-edge target multiset differs — an
   * edge was added, removed, or retargeted (SPEC 5.5, 5.6). */
  depEdgesChanged: boolean;
  /** Both sides only: children matched as children on both sides. */
  matchedChildren: RecordState[];
  /** Both sides only: targets of dependency edges present on both sides. */
  matchedDepTargets: RecordState[];
  /** Both sides only: the records of added child subtrees (current side)
   * and deleted child subtrees (baseline side) — wholly `changed`. */
  oneSidedChildRecords: RecordState[];
}

/** Order a record set into the deterministic record order. */
function sortedRecords(records: ReadonlySet<RecordState>): NodeChange[] {
  return [...records]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((state) => state.change);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the SPEC 5.6 change categories of every requirement node of the
 * two sides (module header). Both sides must be validated workspaces whose
 * hashes are complete and whose journals satisfy the baseline-prefix
 * invariant (SPEC 6.3) — the callers' precondition: only valid workspaces
 * surface graph content (SPEC 12.1, 13.3), and baseline resolution fails
 * otherwise (SPEC 6.3).
 */
export function deriveChangeCategories(
  baseline: ChangeAnalysisSide,
  current: ChangeAnalysisSide,
): ChangeAnalysis {
  return new ChangeComputation(baseline, current).compute();
}

class ChangeComputation {
  private readonly states: RecordState[] = [];
  private readonly byBaselineNode = new Map<RequirementNode, RecordState>();
  private readonly byCurrentNode = new Map<RequirementNode, RecordState>();
  /** Canonical-identity walk memos, one per side (SPEC 5.4). */
  private readonly baselineKeys = new Map<string, string>();
  private readonly currentKeys = new Map<string, string>();

  constructor(
    private readonly baseline: ChangeAnalysisSide,
    private readonly current: ChangeAnalysisSide,
  ) {}

  compute(): ChangeAnalysis {
    this.matchNodes();
    this.compareBothSides();
    this.attributeChanges();

    const nodes = this.states.map((state): NodeChange => state.change);
    const byCurrentIdentity = new Map<string, NodeChange>();
    const byBaselineIdentity = new Map<string, NodeChange>();
    for (const state of this.states) {
      if (state.currentNode !== null) {
        byCurrentIdentity.set(state.currentNode.identity, state.change);
      }
      if (state.baselineNode !== null) {
        byBaselineIdentity.set(state.baselineNode.identity, state.change);
      }
    }
    return { nodes, byCurrentIdentity, byBaselineIdentity };
  }

  /**
   * SPEC 5.4: a node's canonical identity as an injective key — the walk
   * of the side's journal, memoized per side. Distinct nodes of one side
   * always have distinct canonical identities (SPEC 5.4), so each side's
   * key map is collision-free for valid inputs.
   */
  private canonicalKey(side: "baseline" | "current", identity: string): string {
    const memo = side === "baseline" ? this.baselineKeys : this.currentKeys;
    let key = memo.get(identity);
    if (key === undefined) {
      const journal =
        side === "baseline" ? this.baseline.journal : this.current.journal;
      const canonical = journal.canonicalIdentity(identity);
      // Injective: the position is decimal digits, so the first ":" splits.
      key = `${String(canonical.position)}:${canonical.identity}`;
      memo.set(identity, key);
    }
    return key;
  }

  /** Match the two sides' requirement nodes by canonical identity (module
   * header) and create the records in the deterministic order. */
  private matchNodes(): void {
    const baselineByKey = new Map<string, RequirementNode>();
    for (const node of this.baseline.graph.requirementNodes) {
      const key = this.canonicalKey("baseline", node.identity);
      if (baselineByKey.has(key)) {
        throw new Error(
          `xspec internal error: two baseline nodes share the canonical ` +
            `identity of ${node.identity} (SPEC 5.4)`,
        );
      }
      baselineByKey.set(key, node);
    }

    const seenCurrentKeys = new Set<string>();
    const matchedBaseline = new Set<RequirementNode>();
    for (const node of this.current.graph.requirementNodes) {
      const key = this.canonicalKey("current", node.identity);
      if (seenCurrentKeys.has(key)) {
        throw new Error(
          `xspec internal error: two current nodes share the canonical ` +
            `identity of ${node.identity} (SPEC 5.4)`,
        );
      }
      seenCurrentKeys.add(key);
      const baselineNode = baselineByKey.get(key) ?? null;
      if (baselineNode !== null) matchedBaseline.add(baselineNode);
      this.newState(baselineNode, node);
    }
    // The deleted records, in the baseline graph's node order.
    for (const node of this.baseline.graph.requirementNodes) {
      if (!matchedBaseline.has(node)) this.newState(node, null);
    }
  }

  private newState(
    baselineNode: RequirementNode | null,
    currentNode: RequirementNode | null,
  ): void {
    const presence: NodePresence =
      baselineNode !== null && currentNode !== null
        ? "both"
        : currentNode !== null
          ? "added"
          : "deleted";
    const state: RecordState = {
      change: {
        presence,
        baselineIdentity: baselineNode === null ? null : baselineNode.identity,
        currentIdentity: currentNode === null ? null : currentNode.identity,
        // SPEC 5.6: an added or deleted node is `changed`; both-sides
        // flags are filled by the comparisons that follow.
        changed: presence !== "both",
        metadataChanged: false,
        subtreeChanged: false,
        effectiveChanged: false,
        descendantChanged: [],
        upstreamChanged: [],
        depEdgesChanged: false,
        matchedChildren: [],
        matchedDependencyTargets: [],
      },
      ordinal: this.states.length,
      baselineNode,
      currentNode,
      ownChanged: false,
      depEdgesChanged: false,
      matchedChildren: [],
      matchedDepTargets: [],
      oneSidedChildRecords: [],
    };
    this.states.push(state);
    if (baselineNode !== null) this.byBaselineNode.set(baselineNode, state);
    if (currentNode !== null) this.byCurrentNode.set(currentNode, state);
  }

  /**
   * The leaf comparisons of every both-sides record: ownHash, metadataHash,
   * subtreeHash, effectiveHash (SPEC 5.5), the dependency-edge multiset
   * (SPEC 5.6), and the cross-side relations the propagation walks —
   * matched children and matched dependency-edge targets (module header).
   */
  private compareBothSides(): void {
    for (const state of this.states) {
      const { baselineNode, currentNode } = state;
      if (baselineNode === null || currentNode === null) continue;
      const before = this.hashesOf(this.baseline, baselineNode);
      const after = this.hashesOf(this.current, currentNode);
      state.ownChanged = before.ownHash !== after.ownHash;
      state.change.changed = state.ownChanged;
      state.change.metadataChanged = before.metadataHash !== after.metadataHash;
      state.change.subtreeChanged = before.subtreeHash !== after.subtreeHash;
      state.change.effectiveChanged =
        before.effectiveHash !== after.effectiveHash;

      // SPEC 5.5/5.6: the per-edge dependency-target multiset — one entry
      // per `depends`/`embeds` edge, targets as canonical identities. A
      // difference means an edge was added, removed, or retargeted.
      const baselineTargets = this.depTargetCounts("baseline", baselineNode);
      const currentTargets = this.depTargetCounts("current", currentNode);
      state.depEdgesChanged =
        baselineTargets.size !== currentTargets.size ||
        [...baselineTargets].some(
          ([key, entry]) => currentTargets.get(key)?.count !== entry.count,
        );

      // Matched dependency targets: edges present on both sides, in the
      // current side's deterministic edge order (map insertion order).
      for (const [key, entry] of currentTargets) {
        if (!baselineTargets.has(key)) continue;
        const targetState = this.byCurrentNode.get(entry.target);
        if (targetState !== undefined) {
          state.matchedDepTargets.push(targetState);
        }
      }

      // Matched children: the current-side children that are this node's
      // children on the baseline side too (identity structure makes that
      // automatic except across journaled moves, module header).
      for (const child of this.current.graph.childrenOf(currentNode)) {
        const childState = this.byCurrentNode.get(child);
        if (childState === undefined || childState.baselineNode === null) {
          continue;
        }
        if (
          this.baseline.graph.parentOf(childState.baselineNode) === baselineNode
        ) {
          state.matchedChildren.push(childState);
        }
      }

      // Expose the comparisons the impact renderer walks (SPEC 9.2, 9.3):
      // the dependency-edge multiset flag and the cross-side relations, as
      // records.
      state.change.depEdgesChanged = state.depEdgesChanged;
      state.change.matchedChildren = state.matchedChildren.map(
        (child) => child.change,
      );
      state.change.matchedDependencyTargets = state.matchedDepTargets.map(
        (target) => target.change,
      );
    }
  }

  /** The node's dependency-edge target multiset: canonical key → edge
   * count and one target node per key (SPEC 5.5: one pair per edge). */
  private depTargetCounts(
    side: "baseline" | "current",
    node: RequirementNode,
  ): Map<string, { count: number; readonly target: RequirementNode }> {
    const graph =
      side === "baseline" ? this.baseline.graph : this.current.graph;
    const counts = new Map<
      string,
      { count: number; readonly target: RequirementNode }
    >();
    for (const edge of graph.outgoingEdges(node.identity)) {
      if (edge.kind === "contains") continue;
      const target = graph.requirementNode(edge.target);
      if (target === undefined) continue; // unreachable for valid graphs
      const key = this.canonicalKey(side, edge.target);
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { count: 1, target });
      else entry.count += 1;
    }
    return counts;
  }

  private hashesOf(
    side: ChangeAnalysisSide,
    node: RequirementNode,
  ): NodeHashes {
    const hashes = side.hashes.get(node.identity);
    if (hashes === undefined) {
      // Callers pass validated, fully hashed workspaces (SPEC 12.1, 13.3).
      throw new Error(
        `xspec internal error: no hashes for requirement node ${node.identity}`,
      );
    }
    return hashes;
  }

  /**
   * The propagated categories. First the per-side bottom-up subtree sets
   * of `changed` records — the per-file node lists are in document order
   * with each parent before its children, so a reverse iteration visits
   * children first — then, per both-sides record:
   *
   * - `descendant-changed` (SPEC 5.6): the changed records strictly below
   *   on either side — the union of the node's children's subtree sets;
   * - the one-sided child slots feeding the effective-cause computation:
   *   an added child's current subtree and a deleted child's baseline
   *   subtree, wholly `changed` records;
   * - `upstream-changed` (SPEC 5.6, module header), via the memoized
   *   effective-cause and upstream-cause evaluations.
   */
  private attributeChanges(): void {
    const baselineSets = this.subtreeSets(
      this.baseline.graph,
      this.byBaselineNode,
    );
    const currentSets = this.subtreeSets(
      this.current.graph,
      this.byCurrentNode,
    );

    const bothSides: RecordState[] = [];
    for (const state of this.states) {
      const { baselineNode, currentNode } = state;
      // The both-sides rule: added and deleted nodes receive no category
      // beyond `changed` (SPEC 5.6).
      if (baselineNode === null || currentNode === null) continue;
      bothSides.push(state);

      const below = new Set<RecordState>();
      for (const child of this.baseline.graph.childrenOf(baselineNode)) {
        const childState = this.byBaselineNode.get(child);
        for (const record of baselineSets.get(child) ?? []) below.add(record);
        if (childState !== undefined && childState.currentNode === null) {
          // A deleted child: its baseline subtree is wholly `changed`.
          for (const record of baselineSets.get(child) ?? []) {
            state.oneSidedChildRecords.push(record);
          }
        }
      }
      for (const child of this.current.graph.childrenOf(currentNode)) {
        const childState = this.byCurrentNode.get(child);
        for (const record of currentSets.get(child) ?? []) below.add(record);
        if (childState !== undefined && childState.baselineNode === null) {
          // An added child: its current subtree is wholly `changed`.
          for (const record of currentSets.get(child) ?? []) {
            state.oneSidedChildRecords.push(record);
          }
        }
      }
      state.change.descendantChanged = sortedRecords(below);
    }

    // The originating causes of each node's effectiveHash change (SPEC 5.5
    // inputs: ownHash, child list and child effectiveHashes, dependency
    // pairs) — consumed by dependents through matched dependency edges.
    const effectiveCauses = evaluateSets(
      bothSides,
      (state) => [...state.matchedChildren, ...state.matchedDepTargets],
      (state, valueOf) => {
        const causes = new Set<RecordState>();
        if (state.ownChanged || state.depEdgesChanged) causes.add(state);
        for (const record of state.oneSidedChildRecords) causes.add(record);
        for (const child of state.matchedChildren) {
          for (const record of valueOf(child)) causes.add(record);
        }
        for (const target of state.matchedDepTargets) {
          for (const record of valueOf(target)) causes.add(record);
        }
        return causes;
      },
    );

    const upstreamCauses = evaluateSets(
      bothSides,
      (state) => state.matchedChildren,
      (state, valueOf) => {
        const causes = new Set<RecordState>();
        // SPEC 5.6: a dependency-edge target — of the node or, through the
        // child union below, of a node in its subtree — whose effectiveHash
        // changed, attributed to that change's originating causes.
        for (const target of state.matchedDepTargets) {
          for (const record of effectiveCauses.get(target) ?? []) {
            causes.add(record);
          }
        }
        // SPEC 5.6: plus a node in its subtree other than the node itself
        // whose dependency edges were added, removed, or retargeted.
        for (const child of state.matchedChildren) {
          for (const record of valueOf(child)) causes.add(record);
          if (child.depEdgesChanged) causes.add(child);
        }
        return causes;
      },
    );

    for (const state of bothSides) {
      const causes = upstreamCauses.get(state);
      if (causes !== undefined && causes.size > 0) {
        state.change.upstreamChanged = sortedRecords(causes);
      }
    }
  }

  /** Per side node, the `changed` records within its subtree, itself
   * included — bottom-up over the reverse of the graph's node order. */
  private subtreeSets(
    graph: WorkspaceGraph,
    stateOf: ReadonlyMap<RequirementNode, RecordState>,
  ): Map<RequirementNode, readonly RecordState[]> {
    const sets = new Map<RequirementNode, readonly RecordState[]>();
    const nodes = graph.requirementNodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const state = stateOf.get(node);
      if (state === undefined) {
        throw new Error(
          `xspec internal error: no change record for ${node.identity}`,
        );
      }
      const set: RecordState[] = state.change.changed ? [state] : [];
      for (const child of graph.childrenOf(node)) {
        for (const record of sets.get(child) ?? []) set.push(record);
      }
      sets.set(node, set);
    }
    return sets;
  }
}

/**
 * Iterative memoized post-order evaluation of a record-set function over an
 * acyclic dependency relation — the explicit stack keeps deep `contains`
 * and dependency chains from overflowing the call stack (the same pattern
 * as the hash computation's). The relation walked here is a sub-relation of
 * the baseline dependency graph, acyclic for valid inputs (SPEC 5.3); a
 * dependency re-entered through a cycle (invalid inputs only) contributes
 * the empty set, keeping the evaluation total and deterministic.
 */
function evaluateSets(
  states: readonly RecordState[],
  dependenciesOf: (state: RecordState) => readonly RecordState[],
  combine: (
    state: RecordState,
    valueOf: (dependency: RecordState) => ReadonlySet<RecordState>,
  ) => ReadonlySet<RecordState>,
): Map<RecordState, ReadonlySet<RecordState>> {
  const memo = new Map<RecordState, ReadonlySet<RecordState>>();
  const empty: ReadonlySet<RecordState> = new Set();
  const valueOf = (dependency: RecordState): ReadonlySet<RecordState> =>
    memo.get(dependency) ?? empty;
  interface Frame {
    readonly state: RecordState;
    expanded: boolean;
  }
  for (const root of states) {
    if (memo.has(root)) continue;
    const active = new Set<RecordState>();
    const stack: Frame[] = [{ state: root, expanded: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (memo.has(frame.state)) {
        stack.pop();
        continue;
      }
      if (!frame.expanded) {
        frame.expanded = true;
        active.add(frame.state);
        const dependencies = dependenciesOf(frame.state);
        for (let index = dependencies.length - 1; index >= 0; index -= 1) {
          const dependency = dependencies[index];
          if (!memo.has(dependency) && !active.has(dependency)) {
            stack.push({ state: dependency, expanded: false });
          }
        }
        continue;
      }
      memo.set(frame.state, combine(frame.state, valueOf));
      active.delete(frame.state);
      stack.pop();
    }
  }
  return memo;
}
