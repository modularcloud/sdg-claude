// Impact-analysis report derivation (SPEC 9, 9.1–9.3).
//
// Pure core (IMPLEMENTATION Architecture: impact derivation is core —
// deterministic, I/O-free): over a completed change analysis (./changes.ts,
// SPEC 5.6), the two sides' graphs, and the baseline→current replay journal
// (SPEC 6.3), this module derives the content of the `xspec impact` report:
//
// - requirement impact (SPEC 9.1): the change categories of 5.6, each
//   attributed to its originating nodes, grouped by category (SPEC 9.3)
//   with maximal `descendant-changed`-only ancestor chains of identical
//   attribution collapsed to one entry;
// - impacted code (SPEC 9.2): evaluated over each code location's impact
//   edges — the union of its `references` and `embeds` edges in the
//   baseline graph and in the current graph, identities mapped through the
//   journal — where a node present on only one side counts as one whose
//   subtreeHash and effectiveHash changed (the stated exception to 5.6's
//   both-sides rule);
// - witness selection (SPEC 9.3): per impacted location and category, one
//   impact edge and one shortest propagation path, minimized together over
//   every qualifying edge, ties resolved by the SPEC 12.0 element-wise
//   byte comparison of node-identity sequences, `embeds` reported over
//   `references` when both target the chosen first node.
//
// Identities are reported in their current form: a node absent from the
// current graph is reported as deleted under its baseline identity mapped
// forward through the journal entries applied since the baseline (SPEC 9.3,
// 6.3); a mapped identity now borne by a distinct new node (SPEC 5.4)
// therefore appears twice — once as deleted, once as added — because the
// two nodes hold two distinct change records.

import type {
  ChangeAnalysis,
  ChangeCategoryName,
  NodeChange,
} from "./changes.js";
import { nodeCategories } from "./changes.js";
import { compareBytes } from "./bytes.js";
import type { WorkspaceGraph } from "./graph.js";
import type { Journal } from "./journal.js";

/** One category of one requirement entry, attribution as identities. */
export interface ImpactCategoryReport {
  readonly category: ChangeCategoryName;
  /**
   * The reported identities of the originating nodes the category is
   * attributed to (SPEC 5.6, 9.1), deduplicated, in record order.
   */
  readonly attributedTo: readonly string[];
}

/**
 * One requirement-level report entry (SPEC 9.3): one node with all its
 * SPEC 5.6 categories in listing order — or one maximal collapsed ancestor
 * chain, whose members' one shared category is `descendant-changed`.
 */
export interface ImpactRequirementReportEntry {
  /** The reported identities the entry covers, top ancestor first. */
  readonly nodes: readonly string[];
  /** SPEC 9.3: deleted nodes report under mapped baseline identities. */
  readonly deleted: boolean;
  readonly categories: readonly ImpactCategoryReport[];
}

/** The witness edge kinds a code location can source (SPEC 9.2). */
export type ImpactEdgeKind = "references" | "embeds";

/** One impacted-code entry (SPEC 9.3). */
export interface ImpactedCodeReportEntry {
  /** The code location's identity — its baseline identity when absent from
   * the current graph (SPEC 9.2). */
  readonly location: string;
  /** The minimized witness edge (SPEC 9.3); its source is the location. */
  readonly edgeKind: ImpactEdgeKind;
  /** The witness edge's target — the reported path's first node. */
  readonly edgeTarget: string;
  /** The shortest propagation path, edge target first (SPEC 9.3, 12.0). */
  readonly path: readonly string[];
}

/** The full impact-report content (SPEC 9.1–9.3). */
export interface ImpactReportData {
  /**
   * The requirement entries in record order (SPEC 12.0): the current
   * graph's node order, deleted nodes after, chains at their top member's
   * position. Each entry carries all its node's categories, so the
   * category grouping of SPEC 9.3 is a rendering over these entries.
   */
  readonly requirements: readonly ImpactRequirementReportEntry[];
  readonly code: {
    /** Directly impacted locations, in byte order of location (SPEC 12.0). */
    readonly direct: readonly ImpactedCodeReportEntry[];
    /** Transitively impacted locations, in byte order of location. */
    readonly transitive: readonly ImpactedCodeReportEntry[];
  };
}

/**
 * Derive the `xspec impact` report content (module header). `analysis` is
 * the completed SPEC 5.6 change analysis of the two sides, `replay` the
 * journal entries applied since the baseline (SPEC 6.3), and the graphs are
 * the two sides' — both from validated workspaces (the callers'
 * precondition, SPEC 12.1, 13.3, 6.3).
 */
export function deriveImpactReport(
  analysis: ChangeAnalysis,
  baselineGraph: WorkspaceGraph,
  currentGraph: WorkspaceGraph,
  replay: Journal,
): ImpactReportData {
  return new ImpactComputation(
    analysis,
    baselineGraph,
    currentGraph,
    replay,
  ).compute();
}

class ImpactComputation {
  /** Reported identity per record (SPEC 9.3), memoized. */
  private readonly identities = new Map<NodeChange, string>();

  constructor(
    private readonly analysis: ChangeAnalysis,
    private readonly baselineGraph: WorkspaceGraph,
    private readonly currentGraph: WorkspaceGraph,
    private readonly replay: Journal,
  ) {}

  compute(): ImpactReportData {
    return {
      requirements: this.requirementEntries(),
      code: {
        direct: this.codeEntries("direct"),
        transitive: this.codeEntries("transitive"),
      },
    };
  }

  /**
   * SPEC 9.3: the identity a record reports under — its current identity,
   * or, for a node absent from the current graph, its baseline identity
   * mapped forward through the journal entries applied since the baseline
   * (SPEC 6.3).
   */
  private identityOf(record: NodeChange): string {
    let identity = this.identities.get(record);
    if (identity === undefined) {
      if (record.currentIdentity !== null) {
        identity = record.currentIdentity;
      } else if (record.baselineIdentity !== null) {
        identity = this.replay.mapForward(record.baselineIdentity);
      } else {
        throw new Error("xspec internal error: change record with no identity");
      }
      this.identities.set(record, identity);
    }
    return identity;
  }

  /** Attribution records as reported identities, deduplicated, in order. */
  private attribution(records: readonly NodeChange[]): string[] {
    const identities: string[] = [];
    for (const record of records) {
      const identity = this.identityOf(record);
      if (!identities.includes(identity)) identities.push(identity);
    }
    return identities;
  }

  // -------------------------------------------------------------------------
  // Requirement impact (SPEC 9.1, 9.3)
  // -------------------------------------------------------------------------

  /**
   * SPEC 9.3: the requirement-level entries — one entry per categorized
   * node carrying all its SPEC 5.6 categories with their attributions, in
   * record order (SPEC 12.0; the report groups by category over these
   * entries), with ancestor chains collapsed: a maximal chain of ancestors
   * whose only category is `descendant-changed` with identical attribution
   * appears as one entry covering the chain, rather than one entry per
   * node. Chains follow the current graph's parent axis (chain members are
   * present on both sides: a deleted node is `changed` and never
   * `descendant-changed`, SPEC 5.6); a node carrying any other category,
   * or a different attribution, breaks the chain and is covered alone.
   */
  private requirementEntries(): ImpactRequirementReportEntry[] {
    const collapsible = (record: NodeChange): boolean =>
      record.descendantChanged.length > 0 &&
      !record.changed &&
      !record.metadataChanged &&
      record.upstreamChanged.length === 0;
    // The observable attribution (SPEC 9.3: "identical attribution"): the
    // reported originating identities, order-insensitively.
    const keys = new Map<NodeChange, string>();
    const keyOf = (record: NodeChange): string => {
      let key = keys.get(record);
      if (key === undefined) {
        key = JSON.stringify(
          [...this.attribution(record.descendantChanged)].sort(compareBytes),
        );
        keys.set(record, key);
      }
      return key;
    };

    // Build the chains in record order — within a file the current graph
    // lists a parent before its children, so a member's chain exists before
    // the member is visited. A child joins its parent's chain only while
    // the parent is the chain's last member, so every chain is a genuine
    // parent-child chain even if two siblings were ever eligible.
    const chains = new Map<NodeChange, NodeChange[]>();
    for (const record of this.analysis.nodes) {
      if (!collapsible(record)) continue;
      const parent = this.parentRecordOf(record);
      if (
        parent !== undefined &&
        collapsible(parent) &&
        keyOf(parent) === keyOf(record)
      ) {
        const chain = chains.get(parent);
        if (chain !== undefined && chain[chain.length - 1] === parent) {
          chain.push(record);
          chains.set(record, chain);
          continue;
        }
      }
      chains.set(record, [record]);
    }

    const entries: ImpactRequirementReportEntry[] = [];
    for (const record of this.analysis.nodes) {
      const categories = nodeCategories(record);
      if (categories.length === 0) continue; // uncategorized: no entry
      const chain = chains.get(record);
      if (chain !== undefined) {
        if (chain[0] !== record) continue; // covered by its chain's entry
        entries.push({
          nodes: chain.map((member) => this.identityOf(member)),
          deleted: false, // chain members are present on both sides
          categories: [
            {
              category: "descendant-changed",
              attributedTo: this.attribution(record.descendantChanged),
            },
          ],
        });
        continue;
      }
      entries.push({
        nodes: [this.identityOf(record)],
        deleted: record.presence === "deleted",
        categories: categories.map((category) => ({
          category: category.category,
          attributedTo: this.attribution(category.attributedTo),
        })),
      });
    }
    return entries;
  }

  /** The record of the node's parent in the current graph, if any. */
  private parentRecordOf(record: NodeChange): NodeChange | undefined {
    if (record.currentIdentity === null) return undefined;
    const node = this.currentGraph.requirementNode(record.currentIdentity);
    if (node === undefined) return undefined;
    const parent = this.currentGraph.parentOf(node);
    if (parent === null) return undefined;
    return this.analysis.byCurrentIdentity.get(parent.identity);
  }

  // -------------------------------------------------------------------------
  // Impacted code (SPEC 9.2, 9.3)
  // -------------------------------------------------------------------------

  /**
   * SPEC 9.2's counting under the stated exception to 5.6's both-sides
   * rule: for impacted-code evaluation and its witness paths, a node
   * present on only one side counts as one whose subtreeHash changed.
   */
  private subtreeCounts(record: NodeChange): boolean {
    return record.presence !== "both" || record.subtreeChanged;
  }

  /**
   * SPEC 9.3: "a node whose own edit explains the change — a `changed`
   * node, or a `metadata-changed` node whose `d` targets changed" (a
   * dependency-edge change without a `changed` flag is a `d` change:
   * `text(...)` edits change own content, core/changes.ts).
   */
  private explainsChange(record: NodeChange): boolean {
    return record.changed || record.depEdgesChanged;
  }

  /**
   * One code category's entries (SPEC 9.2, 9.3): per location the impact
   * edges qualifying for the category, the qualifying paths from their
   * targets, and the minimized edge-and-path pair. Locations in byte order
   * of identity (SPEC 12.0).
   */
  private codeEntries(
    category: "direct" | "transitive",
  ): ImpactedCodeReportEntry[] {
    const impactEdges = this.impactEdges();
    // SPEC 9.2: the categories.
    // - directly impacted: an impact edge, in either graph, to a node whose
    //   subtreeHash changed (one-sided nodes counting as changed);
    // - transitively impacted: an impact edge to a node whose effectiveHash
    //   changed but whose subtreeHash did not — necessarily a both-sides
    //   node, since one-sided nodes count as changed in both hashes.
    const qualifies =
      category === "direct"
        ? (record: NodeChange): boolean => this.subtreeCounts(record)
        : (record: NodeChange): boolean =>
            record.presence === "both" &&
            record.effectiveChanged &&
            !record.subtreeChanged;
    const distances =
      category === "direct"
        ? this.directDistances()
        : this.transitiveDistances();
    const successors =
      category === "direct"
        ? (record: NodeChange): readonly NodeChange[] =>
            record.matchedChildren.filter((child) => this.subtreeCounts(child))
        : (record: NodeChange): readonly NodeChange[] =>
            this.transitiveSuccessors(record);

    const entries: ImpactedCodeReportEntry[] = [];
    const locations = [...impactEdges.keys()].sort(compareBytes);
    for (const location of locations) {
      const targets = impactEdges.get(location);
      if (targets === undefined) continue;
      // The candidates (SPEC 9.3): the qualifying paths from each
      // qualifying edge's target; the reported path is the shortest, ties
      // resolved by the SPEC 12.0 element-wise byte comparison.
      let best: { target: NodeChange; path: readonly string[] } | null = null;
      for (const target of targets.keys()) {
        if (!qualifies(target)) continue;
        const path = this.witnessPath(target, distances, successors);
        if (best === null || comparePathSequences(path, best.path) < 0) {
          best = { target, path };
        }
      }
      if (best === null) continue; // no qualifying edge: not impacted
      const kinds = targets.get(best.target);
      if (kinds === undefined) {
        throw new Error("xspec internal error: chosen target without edges");
      }
      entries.push({
        location,
        // SPEC 9.3: when an `embeds` and a `references` edge both target
        // the chosen first node, the byte-least kind (`embeds`) is reported.
        edgeKind: kinds.has("embeds") ? "embeds" : "references",
        edgeTarget: best.path[0],
        path: best.path,
      });
    }
    return entries;
  }

  /**
   * SPEC 9.2: the impact edges of every code location — the union of its
   * `references` and `embeds` edges in the baseline graph and in the
   * current graph, with identities mapped through the journal: a baseline
   * edge and a current edge reaching the same change record are one edge.
   * Locations are keyed by identity — a location absent from the current
   * graph keeps its baseline identity (SPEC 9.2). Per location, per
   * target record, the edge kinds reaching it.
   */
  private impactEdges(): Map<string, Map<NodeChange, Set<ImpactEdgeKind>>> {
    const locations = new Map<string, Map<NodeChange, Set<ImpactEdgeKind>>>();
    const addSide = (
      graph: WorkspaceGraph,
      recordOf: ReadonlyMap<string, NodeChange>,
      side: string,
    ): void => {
      for (const location of graph.codeLocations) {
        for (const edge of graph.outgoingEdges(location.identity)) {
          if (edge.kind !== "references" && edge.kind !== "embeds") continue;
          const record = recordOf.get(edge.target);
          if (record === undefined) {
            // Impossible over validated graphs: every requirement node of
            // either side has a change record under that side's identity.
            throw new Error(
              `xspec internal error: no change record for the ${side} ` +
                `impact-edge target ${edge.target}`,
            );
          }
          let targets = locations.get(location.identity);
          if (targets === undefined) {
            locations.set(location.identity, (targets = new Map()));
          }
          let kinds = targets.get(record);
          if (kinds === undefined) targets.set(record, (kinds = new Set()));
          kinds.add(edge.kind);
        }
      }
    };
    addSide(this.baselineGraph, this.analysis.byBaselineIdentity, "baseline");
    addSide(this.currentGraph, this.analysis.byCurrentIdentity, "current");
    return locations;
  }

  /**
   * Distance from every direct-qualifying record to its nearest qualifying
   * terminus (SPEC 9.3): on a directly impacted location's path every
   * node's subtreeHash changed and every step is a `contains` step, ending
   * at a `changed` node. One-sided nodes are `changed` themselves —
   * distance zero, the single-node path — and interior steps run through
   * matched children only: a one-sided child's arrival or departure makes
   * its parent `changed` (SPEC 5.5: identities enter own content), so a
   * shortest path never needs a one-sided step.
   */
  private directDistances(): Map<NodeChange, number> {
    const members = this.analysis.nodes.filter((record) =>
      this.subtreeCounts(record),
    );
    return nearestTerminalDistances(
      members,
      (record) =>
        record.matchedChildren.filter((child) => this.subtreeCounts(child)),
      (record) => record.changed,
    );
  }

  /** The transitive-path steps of a record (SPEC 9.3): a `contains` edge to
   * a child or a dependency edge to a target, every node with changed
   * effectiveHash — over the relations present on both sides (a one-sided
   * dependency edge makes its source's own `d` targets changed, a terminus
   * already, so such steps never shorten a path). */
  private transitiveSuccessors(record: NodeChange): NodeChange[] {
    const successors: NodeChange[] = [];
    for (const child of record.matchedChildren) {
      if (child.effectiveChanged) successors.push(child);
    }
    for (const target of record.matchedDependencyTargets) {
      if (target.effectiveChanged) successors.push(target);
    }
    return successors;
  }

  /**
   * Distance from every effectiveHash-changed both-sides record to its
   * nearest transitive terminus (SPEC 9.3): every node on the path has
   * changed effectiveHash; the path ends at a node whose own edit explains
   * the change.
   */
  private transitiveDistances(): Map<NodeChange, number> {
    const members = this.analysis.nodes.filter(
      (record) => record.presence === "both" && record.effectiveChanged,
    );
    return nearestTerminalDistances(
      members,
      (record) => this.transitiveSuccessors(record),
      (record) => this.explainsChange(record),
    );
  }

  /**
   * The one shortest qualifying path from `target` (SPEC 9.3), ties among
   * equal-length paths resolved by the SPEC 12.0 element-wise byte
   * comparison of the node-identity sequences: with the distance to the
   * nearest terminus known at every node, the successors that still
   * complete a shortest path are exactly those whose remaining distance
   * matches, and greedily taking the byte-least of them realizes the least
   * sequence — the comparison is positional because all shortest paths
   * share one length. The recurrences of SPEC 5.5 guarantee the path
   * exists (SPEC 9.3); a missing distance is an internal error.
   */
  private witnessPath(
    target: NodeChange,
    distances: ReadonlyMap<NodeChange, number>,
    successorsOf: (record: NodeChange) => readonly NodeChange[],
  ): string[] {
    const total = distances.get(target);
    if (total === undefined) {
      throw new Error(
        `xspec internal error: no propagation path from the impact-edge ` +
          `target ${this.identityOf(target)} (SPEC 9.3 guarantees one)`,
      );
    }
    const path: string[] = [this.identityOf(target)];
    let current = target;
    for (let step = 1; step <= total; step += 1) {
      const remaining = total - step;
      let best: NodeChange | null = null;
      let bestIdentity = "";
      for (const next of successorsOf(current)) {
        if (distances.get(next) !== remaining) continue;
        const identity = this.identityOf(next);
        if (best === null || compareBytes(identity, bestIdentity) < 0) {
          best = next;
          bestIdentity = identity;
        }
      }
      if (best === null) {
        throw new Error(
          "xspec internal error: propagation-path construction found no " +
            "successor",
        );
      }
      path.push(bestIdentity);
      current = best;
    }
    return path;
  }
}

/**
 * Breadth-first distances to the nearest terminal over the reversed step
 * relation: terminals at distance zero, every other member at one more than
 * its nearest successor's distance. Members outside every path stay absent.
 * Deterministic: members arrive in record order, and BFS order never
 * affects the distances.
 */
function nearestTerminalDistances(
  members: readonly NodeChange[],
  successorsOf: (record: NodeChange) => readonly NodeChange[],
  isTerminal: (record: NodeChange) => boolean,
): Map<NodeChange, number> {
  const memberSet = new Set(members);
  const predecessors = new Map<NodeChange, NodeChange[]>();
  for (const record of members) {
    for (const next of successorsOf(record)) {
      if (!memberSet.has(next)) continue;
      let list = predecessors.get(next);
      if (list === undefined) predecessors.set(next, (list = []));
      list.push(record);
    }
  }
  const distance = new Map<NodeChange, number>();
  const queue: NodeChange[] = [];
  for (const record of members) {
    if (isTerminal(record)) {
      distance.set(record, 0);
      queue.push(record);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const level = distance.get(current);
    if (level === undefined) {
      throw new Error("xspec internal error: BFS queue holds unseen record");
    }
    for (const previous of predecessors.get(current) ?? []) {
      if (!distance.has(previous)) {
        distance.set(previous, level + 1);
        queue.push(previous);
      }
    }
  }
  return distance;
}

/**
 * SPEC 9.3/12.0: order candidate paths by length, then element-wise byte
 * comparison of the node-identity sequences.
 */
function comparePathSequences(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < a.length; index += 1) {
    const order = compareBytes(a[index], b[index]);
    if (order !== 0) return order;
  }
  return 0;
}
