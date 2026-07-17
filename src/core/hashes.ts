// The four requirement-node hashes (SPEC 5.5).
//
// Pure core (IMPLEMENTATION Architecture: canonical identities and the four
// hashes are core — deterministic, I/O-free): over the assembled workspace
// graph (./graph.ts), the text model's own content sequences (./text-model.ts,
// SPEC 1.6), and the journal's canonical-identity walk (./journal.ts,
// SPEC 5.4), this module computes, for every requirement node:
//
// - ownHash — the node's own content sequence: all runs, empty runs
//   included, each referenced node entering as its canonical identity at its
//   position, child and embedding references distinguished (SPEC 5.5);
// - subtreeHash — (ownHash, child subtreeHashes in document order);
// - effectiveHash — (ownHash, child effectiveHashes in document order, the
//   node's dependency edges as (canonical identity, effectiveHash) pairs of
//   their targets, sorted by canonical identity — one pair per edge);
// - metadataHash — (the `d`-declared target set as canonical identities,
//   the coverage attribute, the sorted tags; a root hashes the empty inputs).
//
// SPEC 5.4: references enter every hash as their target's canonical identity
// — the (identity, journal position) pair of the backward journal walk —
// and reference spellings never enter any hash. That holds here by
// construction: `d` values live inside opening tags, which Markdown
// compilation removes from every run (SPEC 3), and `text(...)` expressions
// are excised from own content (SPEC 1.6), so no spelling can reach a run;
// only resolved targets enter, always as canonical identities. Hash
// computation therefore takes the journal as an input, and the pure
// operations of 6.2 change no hash: a journaled rename or move changes
// current identities but no canonical identity — the walk ends where it did
// before — so every hash input is byte-identical (SPEC 5.5 properties).
// Likewise, an embedded target's text is no part of the embedder's own
// content: editing it changes the target's hashes — and, through the
// dependency pair, the embedder's effectiveHash — but never the embedder's
// ownHash or subtreeHash (SPEC 5.5).
//
// Framing (SPEC 5.5: distinct sequences of components never yield the same
// input): every hash is `hashComponents` (./hash.ts) over a component
// sequence that parses back to exactly one structure —
//
// - a leading domain tag ("own", "subtree", "effective", "metadata")
//   separates the four hash kinds;
// - ownHash appends, per own-content part, a part tag of fixed arity:
//   "run" + the run text (empty runs contribute their component), "child" or
//   "embed" + the canonical identity's two components, or a zero-arity
//   marker for parts without a resolvable node (possible only in invalid
//   workspaces, which never surface hashes — SPEC 12.1, 13.3). Reading
//   tag-by-tag recovers the exact part sequence, so distinct sequences —
//   different splits, orders, kinds, or positions — never collide;
// - subtreeHash is (tag, ownHash, child subtreeHashes…): the first
//   component after the tag is the node's own, the rest the children's, so
//   the (ownHash, child list) pair is recoverable;
// - effectiveHash and metadataHash hash their variable-length parts first
//   and pass the digests as fixed-arity components (the composite pattern
//   of ./hash.ts), keeping child-hash lists and dependency-pair lists from
//   running together;
// - a canonical identity always enters as its two components — identity
//   string and decimal journal position — so an identity reintroduced after
//   a journaled rename or move (a later position) never hashes like its
//   predecessor (SPEC 5.4: references to distinct nodes never hash alike).

import { sortByBytes } from "./bytes.js";
import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import { hashComponents } from "./hash.js";
import type { CanonicalIdentity, Journal } from "./journal.js";
import { compareCanonicalIdentities } from "./journal.js";
import type { WorkspaceTextModel } from "./text-model.js";

/** SPEC 5.5: the four hashes of one requirement node, hex-encoded. */
export interface NodeHashes {
  readonly ownHash: string;
  readonly subtreeHash: string;
  readonly effectiveHash: string;
  readonly metadataHash: string;
}

/**
 * Compute the four hashes (SPEC 5.5) of every requirement node of `graph`,
 * keyed by the node's current identity (SPEC 1.5). `journal` supplies the
 * canonical-identity walk (SPEC 5.4) — for a baseline graph (SPEC 6.3),
 * pass the baseline journal, so baseline hashes are computed with it.
 *
 * Deterministic for identical input (SPEC 5.5): nodes are processed in the
 * graph's fixed order and every variable input is explicitly ordered, so
 * the result is a pure function of (graph, text model, journal). Total even
 * over invalid workspaces: dependency cycles (SPEC 5.3) close a node's
 * effectiveHash over a fixed marker digest — such workspaces fail
 * validation and never surface hashes (SPEC 12.1, 13.3).
 */
export function computeWorkspaceHashes(
  graph: WorkspaceGraph,
  textModel: WorkspaceTextModel,
  journal: Journal,
): ReadonlyMap<string, NodeHashes> {
  return new HashComputation(graph, textModel, journal).computeAll();
}

/**
 * The effectiveHash stand-in for a dependency reached through a cycle
 * (SPEC 5.3: invalid; hashes of such workspaces are never surfaced). A
 * fixed digest keeps the computation total and deterministic.
 */
const CYCLE_DIGEST = hashComponents(["cycle"]);

/** One node's evaluation frame in the iterative post-order walk. */
interface Frame {
  readonly node: RequirementNode;
  expanded: boolean;
}

class HashComputation {
  private readonly canonicalMemo = new Map<string, CanonicalIdentity>();
  private readonly ownMemo = new Map<RequirementNode, string>();
  private readonly subtreeMemo = new Map<RequirementNode, string>();
  private readonly effectiveMemo = new Map<RequirementNode, string>();

  constructor(
    private readonly graph: WorkspaceGraph,
    private readonly textModel: WorkspaceTextModel,
    private readonly journal: Journal,
  ) {}

  /** All four hashes for every requirement node, in graph order. */
  computeAll(): ReadonlyMap<string, NodeHashes> {
    const hashes = new Map<string, NodeHashes>();
    for (const node of this.graph.requirementNodes) {
      hashes.set(node.identity, {
        ownHash: this.ownHash(node),
        // SPEC 5.5: subtreeHash recurses over children (a tree by document
        // structure); effectiveHash additionally over dependency-edge
        // targets (acyclic in valid workspaces, SPEC 5.3).
        subtreeHash: this.evaluate(
          node,
          this.subtreeMemo,
          (parent) => this.graph.childrenOf(parent),
          (parent, valueOf) => this.combineSubtree(parent, valueOf),
        ),
        effectiveHash: this.evaluate(
          node,
          this.effectiveMemo,
          (parent) => [
            ...this.graph.childrenOf(parent),
            ...this.dependencyTargets(parent),
          ],
          (parent, valueOf) => this.combineEffective(parent, valueOf),
        ),
        metadataHash: this.metadataHash(node),
      });
    }
    return hashes;
  }

  /**
   * SPEC 5.4: the canonical identity of the node currently bearing
   * `identity` — the backward journal walk, memoized.
   */
  private canonical(identity: string): CanonicalIdentity {
    let canonical = this.canonicalMemo.get(identity);
    if (canonical === undefined) {
      canonical = this.journal.canonicalIdentity(identity);
      this.canonicalMemo.set(identity, canonical);
    }
    return canonical;
  }

  /** A canonical identity's two hash components (see the framing note). */
  private canonicalComponents(identity: string): [string, string] {
    const canonical = this.canonical(identity);
    return [canonical.identity, String(canonical.position)];
  }

  /**
   * SPEC 5.5 ownHash: the node's own content sequence (SPEC 1.6) — all
   * runs, empty runs included, each referenced node entering as its
   * canonical identity (SPEC 5.4) at its position, child and embedding
   * references distinguished (the part tags). Identities enter at their
   * positions, so adding, removing, or reordering child sections — children
   * with identical text included — changes the parent's ownHash, as does
   * adding, removing, retargeting, or repositioning an embedded reference,
   * or any edit to the node's own content runs (SPEC 5.5).
   */
  private ownHash(node: RequirementNode): string {
    let own = this.ownMemo.get(node);
    if (own !== undefined) {
      return own;
    }
    const components: string[] = ["own"];
    for (const part of this.textModel.ownContent(node.document, node.section)) {
      if (part.kind === "run") {
        components.push("run", part.text);
      } else if (part.kind === "child") {
        const child = this.graph.nodeOfSection(part.section);
        if (child === undefined) {
          // No usable identity (SPEC 14.1, 14.3, 14.17): the workspace is
          // invalid and never surfaces hashes; a fixed zero-arity marker
          // keeps the computation total and deterministic.
          components.push("child-unidentified");
        } else {
          components.push("child", ...this.canonicalComponents(child.identity));
        }
      } else {
        const target = this.graph.embeddingTarget(part.embedding);
        if (target === null) {
          // Unresolved or dynamic embedding (SPEC 14.6, 14.8): invalid, as
          // above.
          components.push("embed-unresolved");
        } else {
          components.push(
            "embed",
            ...this.canonicalComponents(target.identity),
          );
        }
      }
    }
    own = hashComponents(components);
    this.ownMemo.set(node, own);
    return own;
  }

  /**
   * SPEC 5.5 subtreeHash: hash of (ownHash, child subtreeHashes in document
   * order). With ownHash covering the node's runs and its references at
   * their positions, subtreeHash changes if and only if a node in the
   * subtree was added, removed, or reordered, or a node's own content
   * changed (SPEC 5.5 properties).
   */
  private combineSubtree(
    node: RequirementNode,
    valueOf: (dependency: RequirementNode) => string,
  ): string {
    const components = ["subtree", this.ownHash(node)];
    for (const child of this.graph.childrenOf(node)) {
      components.push(valueOf(child));
    }
    return hashComponents(components);
  }

  /**
   * SPEC 5.5 effectiveHash: hash of (ownHash, child effectiveHashes in
   * document order, the node's dependency edges as (canonical identity,
   * effectiveHash) pairs of their targets, sorted by canonical identity —
   * identity string first, then journal position (5.4), earliest first).
   * One pair enters per dependency edge, not per distinct target: a target
   * both depended on and embedded contributes two identical pairs — the
   * sort stays deterministic — and removing either edge changes the input;
   * identities enter the pairs, so retargeting between targets with equal
   * effectiveHash still changes it (SPEC 5.5).
   */
  private combineEffective(
    node: RequirementNode,
    valueOf: (dependency: RequirementNode) => string,
  ): string {
    const childComponents: string[] = [];
    for (const child of this.graph.childrenOf(node)) {
      childComponents.push(valueOf(child));
    }
    const pairs: {
      readonly canonical: CanonicalIdentity;
      readonly effectiveHash: string;
    }[] = [];
    for (const target of this.dependencyTargets(node)) {
      pairs.push({
        canonical: this.canonical(target.identity),
        effectiveHash: valueOf(target),
      });
    }
    pairs.sort((a, b) => compareCanonicalIdentities(a.canonical, b.canonical));
    const pairComponents: string[] = [];
    for (const pair of pairs) {
      pairComponents.push(
        pair.canonical.identity,
        String(pair.canonical.position),
        pair.effectiveHash,
      );
    }
    return hashComponents([
      "effective",
      this.ownHash(node),
      hashComponents(childComponents),
      hashComponents(pairComponents),
    ]);
  }

  /**
   * SPEC 5.5 metadataHash: hash of (the node's `d`-declared (`depends`)
   * target set as canonical identities sorted the same way, its coverage
   * attribute, its sorted tags). A root node has no `d` targets, no
   * coverage attribute, and no tags, so its metadataHash is computed from
   * those empty inputs; embedded `text(...)` references are part of own
   * content (SPEC 1.6) and surface through ownHash, not metadataHash.
   */
  private metadataHash(node: RequirementNode): string {
    const targets: CanonicalIdentity[] = [];
    for (const edge of this.graph.outgoingEdges(node.identity)) {
      if (edge.kind === "depends") {
        // SPEC 5.2: `depends` edges form a set, and distinct nodes always
        // have distinct canonical identities (SPEC 5.4), so this is the
        // declared target set.
        targets.push(this.canonical(edge.target));
      }
    }
    targets.sort(compareCanonicalIdentities);
    const targetComponents: string[] = [];
    for (const target of targets) {
      targetComponents.push(target.identity, String(target.position));
    }
    // SPEC 2.5: every non-root node has an effective coverage attribute
    // ("required" by default), so the root's absent attribute (null) enters
    // as a component equal to neither value.
    const coverage = node.section.coverage ?? "";
    const tags = sortByBytes(node.section.tags, (tag) => tag);
    return hashComponents([
      "metadata",
      hashComponents(targetComponents),
      coverage,
      hashComponents(tags),
    ]);
  }

  /**
   * The targets of the node's dependency edges (SPEC 5.2: `depends`,
   * `embeds`, `references` — a requirement node sources only the first
   * two), one entry per edge in the graph's (source, kind, target) order;
   * `combineEffective` re-sorts its pairs by canonical identity.
   */
  private dependencyTargets(node: RequirementNode): RequirementNode[] {
    const targets: RequirementNode[] = [];
    for (const edge of this.graph.outgoingEdges(node.identity)) {
      if (edge.kind === "contains") {
        continue;
      }
      const target = this.graph.requirementNode(edge.target);
      if (target === undefined) {
        // Unreachable: every graph edge targets a resolved requirement node.
        throw new Error(
          `xspec internal error: dependency edge to unknown node ${edge.target}`,
        );
      }
      targets.push(target);
    }
    return targets;
  }

  /**
   * Iterative post-order evaluation of one memoized hash over its
   * dependency relation — children for subtreeHash (always a tree), plus
   * dependency-edge targets for effectiveHash (acyclic in valid workspaces,
   * SPEC 5.3). An explicit stack keeps deep `contains` chains from
   * overflowing the call stack; a dependency re-entered through a cycle
   * contributes `CYCLE_DIGEST` (see there). `computeAll` evaluates every
   * node in the graph's fixed order, so memoized results — cycle stand-ins
   * included — never depend on caller order (SPEC 12.0 determinism).
   */
  private evaluate(
    node: RequirementNode,
    memo: Map<RequirementNode, string>,
    dependenciesOf: (node: RequirementNode) => readonly RequirementNode[],
    combine: (
      node: RequirementNode,
      valueOf: (dependency: RequirementNode) => string,
    ) => string,
  ): string {
    const memoized = memo.get(node);
    if (memoized !== undefined) {
      return memoized;
    }
    const valueOf = (dependency: RequirementNode): string =>
      memo.get(dependency) ?? CYCLE_DIGEST;
    const active = new Set<RequirementNode>();
    const stack: Frame[] = [{ node, expanded: false }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (memo.has(frame.node)) {
        stack.pop();
        continue;
      }
      if (!frame.expanded) {
        frame.expanded = true;
        active.add(frame.node);
        // Push unresolved dependencies (reversed, so they evaluate in list
        // order); an active one is a cycle and stays unpushed — the
        // parent's combine reads it as CYCLE_DIGEST.
        const dependencies = dependenciesOf(frame.node);
        for (let index = dependencies.length - 1; index >= 0; index -= 1) {
          const dependency = dependencies[index];
          if (!memo.has(dependency) && !active.has(dependency)) {
            stack.push({ node: dependency, expanded: false });
          }
        }
        continue;
      }
      memo.set(frame.node, combine(frame.node, valueOf));
      active.delete(frame.node);
      stack.pop();
    }
    const result = memo.get(node);
    if (result === undefined) {
      throw new Error("xspec internal error: hash evaluation left no result");
    }
    return result;
  }
}
