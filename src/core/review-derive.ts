// Review-session derivation machinery (SPEC 10.5, 10.7).
//
// Pure core (IMPLEMENTATION Architecture: review-session logic is core —
// deterministic, I/O-free): the strategy-generic half of item derivation.
// A strategy generator (src/core/path-blocks.ts for SPEC 10.5; audit and
// coverage per SPEC 10.6/10.7) produces `GeneratedItem` values — the 10.2
// content of each item plus the per-side node identities the state and
// text computations need. This module then:
//
// - replays the session's recorded `split` decompositions over the
//   generated items (SPEC 10.5: a generated item whose kind and scope node
//   are recorded as decomposed is never added back — its decomposition
//   applies instead, recursively), rewriting every blocker reference to a
//   decomposed item into all items of its decomposition;
// - merges the expanded generation into a session's existing items under
//   the re-derivation rules of SPEC 10.5 (`deriveSessionItems`) — the same
//   computation serves `create` (merge into an empty session) and the
//   re-derivation an `updated` resolve triggers;
// - computes each item's recorded `baseline` and `current` states
//   (SPEC 10.2, 10.4) and its text snapshots (SPEC 10.7): `current` via
//   review-state.ts's `computeRecordedState` — byte-identical to what
//   read-time invalidation recomputes, so a freshly derived item is never
//   born invalidated — and `baseline` against the recorded-baseline graph,
//   resolving nodes through their per-side identities so an identity
//   reintroduced by a distinct node (SPEC 5.4) never leaks the wrong
//   side's values;
// - realizes the `split` decomposition (SPEC 10.7,
//   `splitItemDecomposition`) and `resolve`'s status/state update with its
//   `updated`-triggered re-derivation (SPEC 10.5, `resolveSessionItem`);
// - derives the generator-assigned current context sets reads feed to
//   read-time invalidation (SPEC 10.4, `currentContextSets`);
// - orders items per the total order of SPEC 10.5 (`sortItemsPathBlocks`)
//   and per the file-path-then-document order of SPEC 10.6 audit sessions
//   and SPEC 10.7 coverage sessions (`sortItemsByFileThenDocument`), with
//   the shared present-before-absent document-order tie machinery
//   ("wherever an item order ranks by document order — here, in 10.6, and
//   in 10.7", SPEC 10.5).
//
// Identity policy (src/core/review.ts header): the strategy generators
// work in spelling space — a `GeneratedNode.identity` as produced is the
// node's current-graph spelling (a deleted node's baseline identity mapped
// forward through the replay journal, SPEC 6.3) plus its identity in the
// baseline graph (null when absent there). `canonicalizeGeneration` is the
// central seam that rewrites one generator run into canonical-reference
// space (SPEC 5.4): a node identified by a current-graph spelling
// canonicalizes against the full current journal, while a node that exists
// only in the recorded baseline canonicalizes as of the baseline journal
// prefix from its baseline identity — never by canonicalizing its
// forward-mapped spelling against the full journal, which would
// misattribute a spelling recaptured by a replay entry. Everything
// downstream of the seam — matching, decomposition replay, `split`, state
// and text keys — is byte-wise over (kind, canonical scope reference),
// which IS the canonical comparison SPEC 10.4 requires; spellings are
// derived (`spellingOfReference`) only for graph lookups, item ordering,
// and generator content.

import { compareBytes } from "./bytes.js";
import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import type { NodeHashes } from "./hashes.js";
import type { Journal } from "./journal.js";
import { canonicalAt, encodeCanonicalIdentity } from "./journal.js";
import type {
  ItemKind,
  RecordedHashName,
  RecordedNodeState,
  RecordedState,
  RecordedTexts,
  RecordedTextTable,
  ResolveStatus,
  ReviewItem,
  ReviewSession,
} from "./review.js";
import { allocateItemId, kindScopesCodeLocation } from "./review.js";
import type { ReferenceResolution, ReviewStateInputs } from "./review-state.js";
import {
  canonicalKeyOfCurrent,
  computeRecordedState,
  resolveReference,
  spellingOfReference,
} from "./review-state.js";
import type { WorkspaceTextModel } from "./text-model.js";

// ---------------------------------------------------------------------------
// The generated-item model (the strategy → derivation seam)
// ---------------------------------------------------------------------------

/**
 * One node of a generated item, with the identities the derivation needs.
 * As a generator produces it, `identity` is the node's current-space
 * spelling (module header); after `canonicalizeGeneration` — which every
 * derivation consumer runs behind — it is the node's stored canonical
 * reference (SPEC 5.4). `baselineIdentity` is the node's identity in the
 * recorded-baseline graph — null when the node is absent there (added
 * since the baseline, or a session without a baseline) — and is never
 * rewritten: baseline-graph lookups resolve through it.
 */
export interface GeneratedNode {
  readonly identity: string;
  readonly baselineIdentity: string | null;
}

/** A blocker reference by kind and scope node — resolved to an item id
 * once the merge fixes ids (SPEC 10.5: `blockedBy` is recomputed for every
 * generated or decomposition-produced item). */
export interface GeneratedBlockerRef {
  readonly kind: ItemKind;
  readonly scope: string;
}

/**
 * The node's ancestor chain in the current graph — the shared context shape
 * of the strategies without a baseline (SPEC 10.6 audit items; SPEC 10.7
 * `uncovered-requirement` items and split decompositions): every proper
 * ancestor up to the file root, in document order (root first), each with
 * no baseline identity (SPEC 10.2: such a session's `baseline` is the
 * current graph's values at entry). Empty for an absent node — it has no
 * current ancestors — and for a root (SPEC 1.2: roots have no parent).
 */
export function currentAncestorChain(
  graph: WorkspaceGraph,
  identity: string,
): GeneratedNode[] {
  const node = graph.requirementNode(identity);
  if (node === undefined) return [];
  const chain: GeneratedNode[] = [];
  for (
    let ancestor = graph.parentOf(node);
    ancestor !== null;
    ancestor = graph.parentOf(ancestor)
  ) {
    chain.push({ identity: ancestor.identity, baselineIdentity: null });
  }
  return chain.reverse();
}

/** One strategy-generated review item: the SPEC 10.2 content plus the
 * node-identity plumbing of `GeneratedNode`. */
export interface GeneratedItem {
  readonly kind: ItemKind;
  /** The scope node — the subtree root for `subtree-coherence` (SPEC 10.5),
   * the scoped code location for `code-impact`. */
  readonly scope: GeneratedNode;
  readonly context: readonly GeneratedNode[];
  readonly origin: readonly GeneratedNode[];
  readonly reason: string;
  /** The strategy-assigned blockers (SPEC 10.5, 10.6), as references. */
  readonly blockedBy: readonly GeneratedBlockerRef[];
  /**
   * SPEC 10.7: blockers a decomposition-produced item inherits from the
   * decomposed original ("newly created decomposition items additionally
   * inherit the original's `blockedBy`") — applied by the merge only when
   * the item is newly created, so a reused existing item is untouched.
   * Inheritance is the `split` subcommand's split-time rule — the caller's
   * to inject from the stored original's `blockedBy` — never derived by the
   * decomposition replay from the generated original's recomputed blockers:
   * at re-derivation `blockedBy` is recomputed per the strategy's rules and
   * 10.7 (SPEC 10.5 rule 5), and an audit original's recomputed blockers
   * are its children's items — the decomposition's own items — so
   * replay-time inheritance would make a newly authored child of a
   * decomposed node block itself, contradicting SPEC 10.1's acyclicity.
   */
  readonly inheritedBlockedBy?: readonly GeneratedBlockerRef[];
  /**
   * `code-impact` only (SPEC 10.4, 9.2): every node targeted by the scoped
   * location's impact edges — the union over both sides, qualifying for
   * the impact categories or not — whose subtreeHash and effectiveHash the
   * recorded state carries.
   */
  readonly impactTargets?: readonly GeneratedNode[];
}

/**
 * The strategy-supplied content builder the decomposition replay draws on
 * (SPEC 10.5/10.7): when a recorded decomposition replaces a generated
 * `subtree-coherence` item, the replacement items' content — per-child
 * `subtree-coherence` items and the scope root's `parent-consistency`
 * item — is the strategy's to define (context, origin, reason), because it
 * mirrors what the strategy generates (SPEC 10.7: "its context the child's
 * ancestor chain, as in 10.5 and 10.6"; origin "the originating nodes
 * (5.6) within its scope and context — empty in an `audit` session").
 */
export interface DecompositionContentSource {
  /** The `subtree-coherence` item for a child subtree rooted at
   * `scopeIdentity` (a stored identity). */
  subtreeCoherenceItem(scopeIdentity: string): GeneratedItem;
  /**
   * The decomposed scope root's `parent-consistency` item (SPEC 10.7):
   * scope `scopeIdentity`, context the child subtrees (`childIdentities`,
   * the scope root's current child nodes in document order). `blockedBy`
   * MUST reference the child items — the replay rewrites references into
   * decomposed children recursively.
   */
  splitParentConsistencyItem(
    scopeIdentity: string,
    childIdentities: readonly string[],
  ): GeneratedItem;
}

// ---------------------------------------------------------------------------
// The canonicalization seam (SPEC 5.4, 10.4 — spelling space → references)
// ---------------------------------------------------------------------------

/** The inputs of `canonicalizeGeneration`. */
export interface GenerationCanonicalization {
  /** The full current journal. */
  readonly journal: Journal;
  /** The current workspace graph. */
  readonly graph: WorkspaceGraph;
  /**
   * The baseline journal prefix length (SPEC 6.3: the baseline journal is
   * a prefix of the current one — its entry count) for a baseline session;
   * omitted for `audit`/`coverage`, whose generated nodes never carry a
   * baseline identity.
   */
  readonly baselineJournalLength?: number;
}

/** One generator run rewritten into canonical-reference space. */
export interface CanonicalizedGeneration {
  readonly items: readonly GeneratedItem[];
  readonly contentSource: DecompositionContentSource;
  /** Per canonical code-location reference, the canonical references of
   * its impact-edge targets (SPEC 10.4, 9.2). */
  readonly impactTargets?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The canonical reference of one generated node (module header): a node
 * identified by a current-graph spelling canonicalizes against the full
 * current journal (SPEC 5.4: the canonical identity of the node currently
 * bearing the spelling), while a node that exists only in the recorded
 * baseline — baseline identity recorded, absent from the current graph —
 * canonicalizes as of the baseline journal prefix from its baseline
 * identity. Never by canonicalizing its forward-mapped spelling against
 * the full journal: a replay entry that recaptured the spelling for a
 * different chain would misattribute the node.
 */
function canonicalNodeKey(
  node: GeneratedNode,
  isCodeLocation: boolean,
  inputs: GenerationCanonicalization,
): string {
  const { journal, graph, baselineJournalLength } = inputs;
  if (baselineJournalLength !== undefined && node.baselineIdentity !== null) {
    const present = isCodeLocation
      ? graph.codeLocation(node.identity) !== undefined
      : graph.requirementNode(node.identity) !== undefined;
    if (!present) {
      return encodeCanonicalIdentity(
        canonicalAt(journal, baselineJournalLength, node.baselineIdentity),
      );
    }
  }
  return canonicalKeyOfCurrent(journal, node.identity);
}

/**
 * Rewrite one generator run into canonical-reference space (module
 * header): every `GeneratedNode.identity` and every blocker reference's
 * scope becomes a canonical reference, the decomposition content source is
 * wrapped to accept and produce references, and the per-location
 * impact-target map is rekeyed canonically. The generators themselves stay
 * spelling-space and journal-free; this seam is the one place generated
 * nodes canonicalize.
 */
export function canonicalizeGeneration(
  run: {
    readonly items: readonly GeneratedItem[];
    readonly contentSource: DecompositionContentSource;
    readonly impactTargets?: ReadonlyMap<string, readonly string[]>;
  },
  inputs: GenerationCanonicalization,
): CanonicalizedGeneration {
  const { journal } = inputs;

  // Blocker references carry only (kind, scope spelling), so a reference
  // to an item whose scope canonicalizes through its baseline identity (a
  // deleted node) must resolve through the items: collect the scopes whose
  // canonical reference diverges from the spelling's own full-journal
  // canonicalization. Where a current-graph item bears the same (kind,
  // spelling) — reachable only when a vacated spelling was recaptured —
  // the current item wins, matching the generators' own current-first
  // resolution of stored spellings.
  const divergent = new Map<string, string>();
  const hasCurrent = new Set<string>();
  for (const item of run.items) {
    const key = kindScopeKey(item.kind, item.scope.identity);
    const canonical = canonicalNodeKey(
      item.scope,
      kindScopesCodeLocation(item.kind),
      inputs,
    );
    if (canonical === canonicalKeyOfCurrent(journal, item.scope.identity)) {
      hasCurrent.add(key);
    } else if (!divergent.has(key)) {
      divergent.set(key, canonical);
    }
  }
  const mainRefKey = (ref: GeneratedBlockerRef): string => {
    const key = kindScopeKey(ref.kind, ref.scope);
    if (!hasCurrent.has(key)) {
      const anchored = divergent.get(key);
      if (anchored !== undefined) {
        return anchored;
      }
    }
    return canonicalKeyOfCurrent(journal, ref.scope);
  };
  // Decomposition-content references — the split parent's blockers and an
  // audit-style item's child blockers — always name current-graph child
  // nodes (SPEC 10.5, 10.7: decomposition is per *current* child subtree),
  // so they canonicalize as current spellings, never through the main
  // generation's divergent scopes.
  const contentRefKey = (ref: GeneratedBlockerRef): string =>
    canonicalKeyOfCurrent(journal, ref.scope);

  const canonicalNode = (
    node: GeneratedNode,
    isCodeLocation: boolean,
  ): GeneratedNode => ({
    identity: canonicalNodeKey(node, isCodeLocation, inputs),
    baselineIdentity: node.baselineIdentity,
  });
  const canonicalizeItem = (
    item: GeneratedItem,
    refKey: (ref: GeneratedBlockerRef) => string,
  ): GeneratedItem => ({
    ...item,
    scope: canonicalNode(item.scope, kindScopesCodeLocation(item.kind)),
    context: item.context.map((node) => canonicalNode(node, false)),
    origin: item.origin.map((node) => canonicalNode(node, false)),
    blockedBy: item.blockedBy.map((ref) => ({
      kind: ref.kind,
      scope: refKey(ref),
    })),
    inheritedBlockedBy: item.inheritedBlockedBy?.map((ref) => ({
      kind: ref.kind,
      scope: refKey(ref),
    })),
    impactTargets: item.impactTargets?.map((node) =>
      canonicalNode(node, false),
    ),
  });

  const items = run.items.map((item) => canonicalizeItem(item, mainRefKey));

  // The decomposition content source in reference space: inputs decode to
  // the spellings the strategy's builder works in, outputs canonicalize.
  const inner = run.contentSource;
  const decode = (reference: string): string =>
    spellingOfReference(journal, reference);
  const contentSource: DecompositionContentSource = {
    subtreeCoherenceItem: (scopeReference): GeneratedItem =>
      canonicalizeItem(
        inner.subtreeCoherenceItem(decode(scopeReference)),
        contentRefKey,
      ),
    splitParentConsistencyItem: (
      scopeReference,
      childReferences,
    ): GeneratedItem =>
      canonicalizeItem(
        inner.splitParentConsistencyItem(
          decode(scopeReference),
          childReferences.map(decode),
        ),
        contentRefKey,
      ),
  };

  // The per-location impact-target map (SPEC 10.4, 9.2), rekeyed
  // canonically. A location with a generated `code-impact` item reuses the
  // item's canonicalized targets — the deleted-target-aware keying above.
  // Every other covered location is unimpacted, so its targets are present
  // on both sides (SPEC 9.2: an added or deleted target makes the location
  // impacted) and canonicalize as current spellings.
  let impactTargets: Map<string, readonly string[]> | undefined;
  if (run.impactTargets !== undefined) {
    const itemBySpelling = new Map<string, GeneratedItem>();
    run.items.forEach((item, index) => {
      if (item.kind === "code-impact") {
        itemBySpelling.set(item.scope.identity, items[index]);
      }
    });
    const rekeyed = new Map<string, readonly string[]>();
    for (const [location, targets] of run.impactTargets) {
      const item = itemBySpelling.get(location);
      if (item !== undefined) {
        rekeyed.set(
          item.scope.identity,
          (item.impactTargets ?? []).map((node) => node.identity),
        );
      } else {
        rekeyed.set(
          canonicalKeyOfCurrent(journal, location),
          targets.map((target) => canonicalKeyOfCurrent(journal, target)),
        );
      }
    }
    impactTargets = rekeyed;
  }

  return { items, contentSource, impactTargets };
}

// ---------------------------------------------------------------------------
// Decomposition replay (SPEC 10.5 re-derivation rule 2, SPEC 10.7)
// ---------------------------------------------------------------------------

/** The injective (kind, scope) key of an item or reference. */
function kindScopeKey(kind: ItemKind, scope: string): string {
  return `${kind} ${scope}`;
}

/**
 * Replay the session's recorded decompositions over a generation
 * (SPEC 10.5): a generated item whose kind and scope node are recorded as
 * decomposed by `split` (SPEC 10.7) is never added back — it is replaced
 * by one `subtree-coherence` item per current child subtree of the scope
 * node plus the scope node's `parent-consistency` item, recursively (a
 * replacement child item that is itself decomposed is replaced in turn).
 * Every blocker reference to a decomposed item is replaced by references
 * to all items of its decomposition (rule 5), and a kind and scope node
 * produced more than once yields a single item (rule 1's dedup, applied
 * here so the expansion output is the one-item-per-kind-and-scope set the
 * merge consumes; SPEC 10.1).
 *
 * `decomposedScopes` holds the recorded decompositions' scope references
 * (all recorded decompositions are `subtree-coherence`, SPEC 10.7), as
 * stored canonical references; `generated` and `source` are
 * canonical-space (`canonicalizeGeneration`). A decomposed scope resolves
 * to a current graph node for child enumeration through its derived
 * spelling (`journal`).
 */
export function expandDecompositions(
  generated: readonly GeneratedItem[],
  decomposedScopes: readonly string[],
  graph: WorkspaceGraph,
  journal: Journal,
  source: DecompositionContentSource,
): GeneratedItem[] {
  const decomposed = new Set(decomposedScopes);
  const isDecomposed = (kind: ItemKind, scope: string): boolean =>
    kind === "subtree-coherence" && decomposed.has(scope);

  // Per decomposed scope identity, the fully expanded replacement items —
  // memoized so nested decompositions expand once (SPEC 10.5: "recursively").
  // The replacement items carry the content and blockers the strategy's
  // rules and 10.7 assign them; nothing is inherited from the replaced
  // generated item — split-time inheritance is the `split` subcommand's own
  // (`GeneratedItem.inheritedBlockedBy`).
  const expansionMemo = new Map<string, readonly GeneratedItem[]>();
  const expanding = new Set<string>();

  const expandScope = (scopeIdentity: string): readonly GeneratedItem[] => {
    const memoized = expansionMemo.get(scopeIdentity);
    if (memoized !== undefined) return memoized;
    if (expanding.has(scopeIdentity)) {
      // A scope cannot lie within its own decomposition's child subtrees
      // for any valid graph (the containment tree is a tree); the guard
      // keeps the replay total over invalid inputs.
      return [];
    }
    expanding.add(scopeIdentity);
    try {
      // SPEC 10.5: one subtree-coherence item per *current* child subtree
      // of the scope node — an absent scope node (10.4: deleted, or its
      // identity ceased to resolve through the journal) has no current
      // children, so a dangling stored scope never enumerates the distinct
      // node that recaptured its spelling. A canonically resolving scope
      // reaches its graph node through its derived spelling; the children,
      // current-graph nodes, canonicalize against the full journal (module
      // header).
      const resolution = resolveReference(journal, scopeIdentity);
      const scopeNode = resolution.resolves
        ? graph.requirementNode(resolution.spelling)
        : undefined;
      const children: RequirementNode[] =
        scopeNode === undefined ? [] : graph.childrenOf(scopeNode);
      const childReferences = children.map((child) =>
        canonicalKeyOfCurrent(journal, child.identity),
      );
      const items: GeneratedItem[] = [];
      for (const childReference of childReferences) {
        const childItem = source.subtreeCoherenceItem(childReference);
        if (isDecomposed(childItem.kind, childItem.scope.identity)) {
          // SPEC 10.5: the decomposition applies recursively.
          items.push(...expandScope(childItem.scope.identity));
        } else {
          items.push(childItem);
        }
      }
      items.push(
        source.splitParentConsistencyItem(scopeIdentity, childReferences),
      );
      expansionMemo.set(scopeIdentity, items);
      return items;
    } finally {
      expanding.delete(scopeIdentity);
    }
  };

  // First pass: replace decomposed generated items by their expansions,
  // deduplicating by (kind, scope) — the first occurrence wins, later
  // occurrences merge their blocker references (SPEC 10.5 rule 1: "a kind
  // and scope node produced more than once in one derivation yields a
  // single item").
  const expanded: GeneratedItem[] = [];
  const byKey = new Map<string, number>();
  const add = (item: GeneratedItem): void => {
    const key = kindScopeKey(item.kind, item.scope.identity);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, expanded.length);
      expanded.push(item);
      return;
    }
    const existing = expanded[existingIndex];
    expanded[existingIndex] = {
      ...existing,
      blockedBy: mergeRefs(existing.blockedBy, item.blockedBy),
      inheritedBlockedBy: mergeRefs(
        existing.inheritedBlockedBy ?? [],
        item.inheritedBlockedBy ?? [],
      ),
    };
  };
  for (const item of generated) {
    if (isDecomposed(item.kind, item.scope.identity)) {
      for (const replacement of expandScope(item.scope.identity)) {
        add(replacement);
      }
    } else {
      add(item);
    }
  }

  // Second pass (SPEC 10.5 rule 5): rewrite every blocker reference to a
  // decomposed item into references to all items of its decomposition,
  // recursively; the expansion memo already holds each decomposition's
  // final items.
  const rewriteRefs = (
    refs: readonly GeneratedBlockerRef[],
  ): GeneratedBlockerRef[] => {
    const out: GeneratedBlockerRef[] = [];
    const seen = new Set<string>();
    const push = (ref: GeneratedBlockerRef): void => {
      const key = kindScopeKey(ref.kind, ref.scope);
      if (seen.has(key)) return;
      if (isDecomposed(ref.kind, ref.scope)) {
        seen.add(key);
        for (const item of expandScope(ref.scope)) {
          push({ kind: item.kind, scope: item.scope.identity });
        }
        return;
      }
      seen.add(key);
      out.push(ref);
    };
    for (const ref of refs) push(ref);
    return out;
  };
  return expanded.map((item) => ({
    ...item,
    blockedBy: rewriteRefs(item.blockedBy),
    inheritedBlockedBy:
      item.inheritedBlockedBy === undefined
        ? undefined
        : rewriteRefs(item.inheritedBlockedBy),
  }));
}

function mergeRefs(
  a: readonly GeneratedBlockerRef[],
  b: readonly GeneratedBlockerRef[],
): GeneratedBlockerRef[] {
  const out: GeneratedBlockerRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...a, ...b]) {
    const key = kindScopeKey(ref.kind, ref.scope);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation sides (the graph states the merge computes against)
// ---------------------------------------------------------------------------

/** The current workspace's graph state (SPEC 10.4): graph, hashes, text
 * model, the full current journal (the reference codec seam), and — for
 * sessions that can hold `code-impact` items — the per-location
 * impact-edge target references (canonical, `canonicalizeGeneration`). */
export interface CurrentDerivationSide {
  readonly graph: WorkspaceGraph;
  readonly hashes: ReadonlyMap<string, NodeHashes>;
  readonly textModel: WorkspaceTextModel;
  /** The full current journal (module header identity policy). */
  readonly journal: Journal;
  /** SPEC 10.4/9.2: per canonical code-location reference, the canonical
   * impact-edge target references; omitted for strategies that scope no
   * code (SPEC 10.6, 10.7 coverage sessions). */
  readonly impactTargets?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The recorded-baseline graph state (SPEC 10.2: in a baseline session, an
 * item's `baseline` field holds the values in the graph at the recorded
 * baseline). `journal` is the full current journal and `journalLength` the
 * baseline journal prefix length (SPEC 6.3: the baseline journal is a
 * prefix of the current one), so a baseline-graph node's stored key is its
 * canonical identity as of that prefix — eternal under journal growth
 * (SPEC 5.4). Sessions without a baseline (`audit`, `coverage`) pass none:
 * their `baseline` is the current graph's values at the moment the item
 * enters the session (SPEC 10.2).
 */
export interface BaselineDerivationSide {
  readonly graph: WorkspaceGraph;
  readonly hashes: ReadonlyMap<string, NodeHashes>;
  readonly textModel: WorkspaceTextModel;
  readonly journal: Journal;
  readonly journalLength: number;
}

/** `ReviewStateInputs` (review-state.ts) over a current side. */
export function reviewStateInputs(
  current: CurrentDerivationSide,
): ReviewStateInputs {
  const impactTargets = current.impactTargets;
  return {
    graph: current.graph,
    hashes: current.hashes,
    journal: current.journal,
    impactTargets:
      impactTargets === undefined
        ? undefined
        : (location): readonly string[] => impactTargets.get(location) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Baseline recorded state (SPEC 10.2, 10.4)
// ---------------------------------------------------------------------------

/**
 * The SPEC 10.4 recorded state of a generated item against the
 * recorded-baseline graph — the `baseline` field a new item enters the
 * session with (SPEC 10.2). The per-kind relevant-hash table mirrors
 * review-state.ts's `computeRecordedState`; nodes resolve through their
 * `GeneratedNode.baselineIdentity` (module header), never by looking a
 * stored reference up in the baseline graph, so a reintroduced identity
 * (SPEC 5.4) cannot alias a distinct baseline node. Keys are stored
 * canonical references: a baseline-side subtree member's key is its
 * canonical identity as of the baseline journal prefix (SPEC 5.4 — never
 * its forward-mapped spelling canonicalized against the full journal,
 * module header).
 */
export function computeBaselineRecordedState(
  item: GeneratedItem,
  baseline: BaselineDerivationSide,
): RecordedState {
  // Required hash names per stored identity; roles merge (a node in
  // several roles holds one entry with the union of relevant hashes), as
  // in computeRecordedState.
  const required = new Map<
    string,
    { baselineIdentity: string | null; names: Set<RecordedHashName> }
  >();
  const record = (
    identity: string,
    baselineIdentity: string | null,
    ...names: RecordedHashName[]
  ): void => {
    let entry = required.get(identity);
    if (entry === undefined) {
      required.set(identity, (entry = { baselineIdentity, names: new Set() }));
    } else if (entry.baselineIdentity === null && baselineIdentity !== null) {
      entry.baselineIdentity = baselineIdentity;
    }
    for (const name of names) entry.names.add(name);
  };
  const recordNode = (
    node: GeneratedNode,
    ...names: RecordedHashName[]
  ): void => {
    record(node.identity, node.baselineIdentity, ...names);
  };

  // SPEC 10.4: presence is recorded for every scope, context, and origin
  // node, whatever hashes the kind's table assigns them.
  recordNode(item.scope);
  for (const node of item.context) recordNode(node);
  for (const node of item.origin) recordNode(node);

  switch (item.kind) {
    case "subtree-coherence": {
      // SPEC 10.4: subtreeHash and metadataHash of each scope node — the
      // root and all its descendants in the baseline graph (SPEC 10.5); an
      // absent root contributes itself alone.
      const rootIdentity = item.scope.baselineIdentity;
      const root =
        rootIdentity === null
          ? undefined
          : baseline.graph.requirementNode(rootIdentity);
      if (root === undefined) {
        recordNode(item.scope, "subtreeHash", "metadataHash");
        break;
      }
      const stack: RequirementNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === undefined) break;
        record(
          encodeCanonicalIdentity(
            canonicalAt(
              baseline.journal,
              baseline.journalLength,
              node.identity,
            ),
          ),
          node.identity,
          "subtreeHash",
          "metadataHash",
        );
        const children = baseline.graph.childrenOf(node);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
      break;
    }
    case "parent-consistency":
    case "dependency-consistency": {
      // SPEC 10.4: ownHash and metadataHash of the scope node; subtreeHash
      // of each context node (branch children / upstream targets, 10.5).
      recordNode(item.scope, "ownHash", "metadataHash");
      for (const node of item.context) recordNode(node, "subtreeHash");
      break;
    }
    case "metadata-consistency": {
      // SPEC 10.4: metadataHash of the scope node.
      recordNode(item.scope, "metadataHash");
      break;
    }
    case "code-impact": {
      // SPEC 10.4: subtreeHash and effectiveHash of each node targeted by
      // the scoped code location's impact edges (9.2).
      for (const node of item.impactTargets ?? []) {
        recordNode(node, "subtreeHash", "effectiveHash");
      }
      break;
    }
    case "uncovered-requirement": {
      // SPEC 10.4: subtreeHash and metadataHash of the scope node.
      recordNode(item.scope, "subtreeHash", "metadataHash");
      break;
    }
  }

  const nodes: Record<string, RecordedNodeState> = {};
  for (const [identity, entry] of required) {
    nodes[identity] = baselineNodeState(item, identity, entry, baseline);
  }
  return { nodes };
}

function baselineNodeState(
  item: GeneratedItem,
  identity: string,
  entry: {
    readonly baselineIdentity: string | null;
    readonly names: ReadonlySet<RecordedHashName>;
  },
  baseline: BaselineDerivationSide,
): RecordedNodeState {
  // SPEC 10.2/10.5: only a `code-impact` item's scope is a code location;
  // a code location has no hash values (SPEC 5.5 hashes requirement
  // nodes), so its state is presence alone.
  if (kindScopesCodeLocation(item.kind) && identity === item.scope.identity) {
    return entry.baselineIdentity !== null &&
      baseline.graph.codeLocation(entry.baselineIdentity) !== undefined
      ? { present: true, hashes: {} }
      : { present: false, hashes: "absent" };
  }
  if (
    entry.baselineIdentity === null ||
    baseline.graph.requirementNode(entry.baselineIdentity) === undefined
  ) {
    // SPEC 10.4: absent — the node does not exist in the baseline graph;
    // its hashes are the explicit absent marker.
    return { present: false, hashes: "absent" };
  }
  const hashes: Partial<Record<RecordedHashName, string>> = {};
  if (entry.names.size > 0) {
    const nodeHashes = baseline.hashes.get(entry.baselineIdentity);
    if (nodeHashes === undefined) {
      // Callers pass validated, fully hashed workspaces (SPEC 6.3, 13.3).
      throw new Error(
        `xspec internal error: no baseline hashes for the recorded node ` +
          entry.baselineIdentity,
      );
    }
    for (const name of entry.names) {
      hashes[name] = nodeHashes[name];
    }
  }
  return { present: true, hashes };
}

// ---------------------------------------------------------------------------
// Text snapshots (SPEC 10.2, 10.7)
// ---------------------------------------------------------------------------

/** The distinct requirement nodes of an item's scope, context, and origin
 * — the nodes whose texts the payload rule presents (SPEC 10.7); a
 * `code-impact` scope is a code location with no text value. */
function textBearingNodes(item: GeneratedItem): GeneratedNode[] {
  const nodes: GeneratedNode[] = [];
  const seen = new Set<string>();
  const push = (node: GeneratedNode): void => {
    if (!seen.has(node.identity)) {
      seen.add(node.identity);
      nodes.push(node);
    }
  };
  if (!kindScopesCodeLocation(item.kind)) push(item.scope);
  for (const node of item.context) push(node);
  for (const node of item.origin) push(node);
  return nodes;
}

/** A node's own and subtree text (SPEC 1.6, fully expanded) from a graph
 * and its text model — null when the identity resolves to no node there. */
function nodeTexts(
  graph: WorkspaceGraph,
  textModel: WorkspaceTextModel,
  identity: string,
): RecordedTexts | null {
  const node = graph.requirementNode(identity);
  if (node === undefined) return null;
  return {
    ownText: textModel.ownText(node.document, node.section),
    subtreeText: textModel.subtreeText(node.document, node.section),
  };
}

/** A stored reference's texts in the current graph — null unless the
 * reference canonically resolves to a present node (SPEC 10.4): text
 * snapshots record only nodes present per 10.4, so a dangling reference
 * never captures the text of the distinct node that recaptured its
 * spelling. */
function currentNodeTexts(
  current: CurrentDerivationSide,
  reference: string,
): RecordedTexts | null {
  const resolution = resolveReference(current.journal, reference);
  return resolution.resolves
    ? nodeTexts(current.graph, current.textModel, resolution.spelling)
    : null;
}

/**
 * SPEC 10.7: the item's baseline text snapshots — the origin before-texts
 * and absent-node fallbacks come from the item's `baseline` state, so each
 * node present in the baseline graph records its texts there, keyed by
 * stored identity. Sessions without a baseline record the entry-moment
 * current texts (their `baseline` state is the current graph's, SPEC 10.2).
 */
function baselineTextTable(
  item: GeneratedItem,
  baseline: BaselineDerivationSide | undefined,
  current: CurrentDerivationSide,
): RecordedTextTable {
  const table: Record<string, RecordedTexts> = {};
  for (const node of textBearingNodes(item)) {
    const texts =
      baseline === undefined
        ? currentNodeTexts(current, node.identity)
        : node.baselineIdentity === null
          ? null
          : nodeTexts(
              baseline.graph,
              baseline.textModel,
              node.baselineIdentity,
            );
    if (texts !== null) {
      table[node.identity] = texts;
    }
  }
  return table;
}

/** SPEC 10.7: the derivation-time text snapshots — every item node present
 * per 10.4 (canonically resolving, in the current graph) records its
 * texts, rewritten per node at each derivation that finds it present and
 * never removed (`previous` entries for nodes absent now are kept). */
function derivedTextTable(
  item: GeneratedItem,
  current: CurrentDerivationSide,
  previous: RecordedTextTable,
): RecordedTextTable {
  const table: Record<string, RecordedTexts> = { ...previous };
  for (const node of textBearingNodes(item)) {
    const texts = currentNodeTexts(current, node.identity);
    if (texts !== null) {
      table[node.identity] = texts;
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// New-item construction (shared by the merge and `split`)
// ---------------------------------------------------------------------------

/**
 * One new session item from a generated item (SPEC 10.2): status
 * `unresolved`, `current` computed against the current graph exactly as
 * read-time invalidation recomputes it (so a freshly created item is never
 * born invalidated), `baseline` against the recorded-baseline side — or the
 * current graph's values at this moment for a session without one — and the
 * SPEC 10.7 text snapshots. `blockedBy` is the caller's: resolved blocker
 * references plus, for a `split`'s newly created decomposition items, the
 * inherited set (SPEC 10.7).
 */
function newItemFromGenerated(
  generated: GeneratedItem,
  id: string,
  blockedBy: readonly string[],
  current: CurrentDerivationSide,
  baseline: BaselineDerivationSide | undefined,
): ReviewItem {
  const currentState = computeRecordedState(
    {
      kind: generated.kind,
      scope: generated.scope.identity,
      context: generated.context.map((node) => node.identity),
      origin: generated.origin.map((node) => node.identity),
    },
    reviewStateInputs(current),
  );
  return {
    id,
    kind: generated.kind,
    scope: generated.scope.identity,
    context: generated.context.map((node) => node.identity),
    reason: generated.reason,
    origin: generated.origin.map((node) => node.identity),
    // SPEC 10.2: `baseline` is fixed at entry — recorded-baseline values in
    // a baseline session, current values without one.
    baseline:
      baseline === undefined
        ? currentState
        : computeBaselineRecordedState(generated, baseline),
    current: currentState,
    status: "unresolved",
    blockedBy,
    baselineTexts: baselineTextTable(generated, baseline, current),
    derivedTexts: derivedTextTable(generated, current, {}),
  };
}

// ---------------------------------------------------------------------------
// The merge (SPEC 10.5 re-derivation rules; `create` merges into nothing)
// ---------------------------------------------------------------------------

/** The inputs of `deriveSessionItems`. */
export interface DeriveSessionItemsArgs {
  /**
   * The session's existing items, as stored — canonical references
   * (src/core/review.ts identity policy); empty at `create`.
   */
  readonly existing: readonly ReviewItem[];
  /** The session's item-id counter (src/core/review.ts). */
  readonly nextItemId: number;
  /** The expanded canonical-space generation (`canonicalizeGeneration` →
   * `expandDecompositions`) — one item per kind and scope node. */
  readonly generated: readonly GeneratedItem[];
  readonly current: CurrentDerivationSide;
  /** The recorded-baseline side; omitted for `audit`/`coverage` sessions
   * (SPEC 10.2: their `baseline` is the entry-moment current state). */
  readonly baseline?: BaselineDerivationSide;
}

/** The merge result: the session's new item list and id counter. */
export interface DerivedSessionItems {
  readonly items: readonly ReviewItem[];
  readonly nextItemId: number;
}

/**
 * Merge an expanded generation into a session's existing items under the
 * re-derivation rules of SPEC 10.5 (which hold for every strategy):
 *
 * - a generated item whose kind and scope node match an existing item is
 *   that item — it keeps its `id`, `status`, `note`, and recorded state
 *   (`baseline`, `current`); its `context`, `origin`, and `reason` are
 *   updated from the generation (a changed context set surfaces as
 *   read-time invalidation once the item is resolved, SPEC 10.4);
 * - items that no longer generate remain in the session untouched,
 *   keeping their `blockedBy` (and recorded context set, SPEC 10.4);
 * - new items are added with current state — status `unresolved`
 *   (SPEC 10.2), `current` computed against the current graph exactly as
 *   read-time invalidation recomputes it, `baseline` against the
 *   recorded-baseline side (or the current graph when none, SPEC 10.2) —
 *   and fresh ids in generation order (ids are never reused, SPEC 10.7);
 * - `blockedBy` is recomputed for every generated item from its blocker
 *   references (decomposed references were already replaced by
 *   `expandDecompositions`); newly created decomposition items add their
 *   inherited blockers (SPEC 10.7);
 * - text snapshots follow SPEC 10.7: a new item records baseline texts
 *   and current texts; a matched item's derivation-time texts are
 *   rewritten per node found present, never removed.
 *
 * The result keeps existing items in their stored order (matched ones
 * updated in place) and appends new items in generation order —
 * presentation order is derived at read (`sortItemsPathBlocks`, SPEC 10.5).
 */
export function deriveSessionItems(
  args: DeriveSessionItemsArgs,
): DerivedSessionItems {
  const { existing, generated, current, baseline } = args;

  const existingByKey = new Map<string, ReviewItem>();
  for (const item of existing) {
    existingByKey.set(kindScopeKey(item.kind, item.scope), item);
  }

  // First pass: fix ids — matched items keep theirs, new items allocate in
  // generation order (SPEC 10.5: new items take their place with fresh
  // ids; SPEC 10.7: an id is never reused).
  let nextItemId = args.nextItemId;
  const idByKey = new Map<string, string>();
  const isNew = new Set<string>();
  for (const item of generated) {
    const key = kindScopeKey(item.kind, item.scope.identity);
    const existingItem = existingByKey.get(key);
    if (existingItem !== undefined) {
      idByKey.set(key, existingItem.id);
    } else {
      const allocation = allocateItemId(nextItemId);
      nextItemId = allocation.nextItemId;
      idByKey.set(key, allocation.id);
      isNew.add(key);
    }
  }

  const resolveRefs = (item: GeneratedItem, key: string): readonly string[] => {
    const refs = isNew.has(key)
      ? mergeRefs(item.blockedBy, item.inheritedBlockedBy ?? [])
      : item.blockedBy;
    const ids: string[] = [];
    for (const ref of refs) {
      const id = idByKey.get(kindScopeKey(ref.kind, ref.scope));
      if (id === undefined) {
        // Every blocker reference names a generated item (SPEC 10.5, 10.6:
        // the strategies' blockers are items of the same derivation).
        throw new Error(
          `xspec internal error: a blocker reference names the ` +
            `non-generated item ${ref.kind} ${ref.scope}`,
        );
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  // Second pass: build the merged items — generated ones by key, then
  // assemble the session list (existing order, new items appended).
  const mergedByKey = new Map<string, ReviewItem>();
  for (const item of generated) {
    const key = kindScopeKey(item.kind, item.scope.identity);
    const blockedBy = resolveRefs(item, key);
    const existingItem = existingByKey.get(key);
    if (existingItem !== undefined) {
      // SPEC 10.5: the matched item keeps id, status, and recorded state;
      // context (and the strategy content around it) is updated.
      mergedByKey.set(key, {
        ...existingItem,
        scope: item.scope.identity,
        context: item.context.map((node) => node.identity),
        origin: item.origin.map((node) => node.identity),
        reason: item.reason,
        blockedBy,
        derivedTexts: derivedTextTable(
          item,
          current,
          existingItem.derivedTexts,
        ),
      });
    } else {
      mergedByKey.set(
        key,
        newItemFromGenerated(
          item,
          idByKey.get(key) as string,
          blockedBy,
          current,
          baseline,
        ),
      );
    }
  }

  const items: ReviewItem[] = [];
  const emitted = new Set<string>();
  for (const item of existing) {
    const key = kindScopeKey(item.kind, item.scope);
    const merged = mergedByKey.get(key);
    // SPEC 10.5: items that no longer generate remain, keeping their
    // blockedBy (and everything else) untouched.
    items.push(merged ?? item);
    emitted.add(key);
  }
  for (const item of generated) {
    const key = kindScopeKey(item.kind, item.scope.identity);
    if (emitted.has(key)) continue;
    emitted.add(key);
    const merged = mergedByKey.get(key);
    if (merged !== undefined) items.push(merged);
  }
  return { items, nextItemId };
}

// ---------------------------------------------------------------------------
// The `split` decomposition (SPEC 10.7)
// ---------------------------------------------------------------------------

/** The inputs of `splitItemDecomposition`. */
export interface SplitDecompositionArgs {
  /**
   * The session, as stored — canonical references (src/core/review.ts
   * identity policy).
   */
  readonly session: ReviewSession;
  /** The item to decompose — an item of `session.items` (caller-resolved;
   * an unknown item id is the caller's usage error, SPEC 10.7, 12.0). */
  readonly original: ReviewItem;
  /** The session strategy's decomposition content (SPEC 10.7), in
   * canonical-reference space (`canonicalizeGeneration`). */
  readonly contentSource: DecompositionContentSource;
  readonly current: CurrentDerivationSide;
  /** The recorded-baseline side; omitted for `audit`/`coverage` sessions
   * (SPEC 10.2: their `baseline` is the entry-moment current state). */
  readonly baseline?: BaselineDerivationSide;
}

/** The split outcome: the new session value, or the SPEC 10.7 refusal. */
export type SplitDecompositionResult =
  | {
      readonly ok: true;
      readonly session: ReviewSession;
      /** The decomposition's item ids — reused and newly created alike —
       * in expansion order (SPEC 10.7: "all items of the decomposition"). */
      readonly itemIds: readonly string[];
    }
  | {
      /** SPEC 10.7: `split` on an item of any other kind, or on a
       * `subtree-coherence` item whose scope root has no children, is
       * refused. */
      readonly ok: false;
      readonly refusal: string;
    };

/**
 * SPEC 10.7 `split`: decompose a `subtree-coherence` item whose scope root
 * has children into one `subtree-coherence` item per current child subtree
 * plus one `parent-consistency` item for the scope root's own text — the
 * strategy's decomposition content fixes each item's context, origin, and
 * reason ("its context the child's ancestor chain, as in 10.5 and 10.6"),
 * and a child whose kind and scope node are themselves recorded as
 * decomposed is spliced recursively (SPEC 10.5). An item of the
 * decomposition whose kind and scope node already exist in the session is
 * not created: the existing item takes its place, keeping its `id`,
 * status, and recorded state — untouched entirely. Newly created
 * decomposition items enter `unresolved` with current state and
 * additionally inherit the original's `blockedBy`; every item that was
 * blocked by the original becomes blocked by all items of the
 * decomposition; the original is removed and its id never reused (the id
 * counter only advances); the decomposition is recorded durably and
 * governs re-derivation (SPEC 10.5, 10.7).
 */
export function splitItemDecomposition(
  args: SplitDecompositionArgs,
): SplitDecompositionResult {
  const { session, original, contentSource, current, baseline } = args;

  // SPEC 10.7: `split` on an item of any other kind is refused.
  if (original.kind !== "subtree-coherence") {
    return {
      ok: false,
      refusal:
        `item '${original.id}' is a ${original.kind} item — \`split\` ` +
        `decomposes only a subtree-coherence item whose scope root has ` +
        `children (SPEC 10.7)`,
    };
  }
  // SPEC 10.7: a childless scope root is refused. The decomposition is per
  // *current* child subtree (SPEC 10.5), so an absent scope root — deleted,
  // or its identity ceased to resolve through the journal (SPEC 10.4) —
  // has no current children and is childless here: a dangling scope never
  // splits over the children of the distinct node that recaptured its
  // spelling. A canonically resolving scope reaches its graph node through
  // its derived spelling, which is also how the refusal names it
  // (SPEC 10.4: nodes surface under current identities).
  const scopeResolution = resolveReference(current.journal, original.scope);
  const scopeSpelling = scopeResolution.spelling;
  const scopeNode = scopeResolution.resolves
    ? current.graph.requirementNode(scopeSpelling)
    : undefined;
  const children =
    scopeNode === undefined ? [] : current.graph.childrenOf(scopeNode);
  if (children.length === 0) {
    return {
      ok: false,
      refusal:
        `the scope root ${scopeSpelling} of item '${original.id}' has no ` +
        `children in the current graph — \`split\` on a subtree-coherence ` +
        `item whose scope root has no children is refused (SPEC 10.7)`,
    };
  }

  // The decomposition's items: the original, expanded under the recorded
  // decompositions plus this new one — a decomposed child is spliced
  // recursively, and blocker references to decomposed items are rewritten
  // to their decompositions' items (SPEC 10.5, 10.7).
  const decomposedScopes = [
    ...session.decompositions.map((decomposition) => decomposition.scope),
    original.scope,
  ];
  const expansion = expandDecompositions(
    [contentSource.subtreeCoherenceItem(original.scope)],
    decomposedScopes,
    current.graph,
    current.journal,
    contentSource,
  );

  // SPEC 10.7: an item of the decomposition whose kind and scope node
  // already exist in the session is not created — the existing item takes
  // its place. New items allocate fresh ids in expansion order; the
  // removed original's id is never reused (the counter only advances).
  const existingByKey = new Map<string, ReviewItem>();
  for (const item of session.items) {
    if (item.id === original.id) continue;
    existingByKey.set(kindScopeKey(item.kind, item.scope), item);
  }
  let nextItemId = session.nextItemId;
  const idByKey = new Map<string, string>();
  const newByKey = new Map<string, GeneratedItem>();
  for (const generated of expansion) {
    const key = kindScopeKey(generated.kind, generated.scope.identity);
    const existing = existingByKey.get(key);
    if (existing !== undefined) {
      idByKey.set(key, existing.id);
    } else {
      const allocation = allocateItemId(nextItemId);
      nextItemId = allocation.nextItemId;
      idByKey.set(key, allocation.id);
      newByKey.set(key, generated);
    }
  }

  // A blocker reference resolves against the decomposition's items and the
  // session's items. SPEC 10.1 lets `blockedBy` name only item ids present
  // in the session, so a reference to an item that never entered it (a new
  // child's own children, itemless until a re-derivation) is dropped —
  // re-derivation recomputes every blocker per the strategy's rules
  // (SPEC 10.5).
  const idOfRef = (ref: GeneratedBlockerRef): string | undefined => {
    const key = kindScopeKey(ref.kind, ref.scope);
    return idByKey.get(key) ?? existingByKey.get(key)?.id;
  };

  // SPEC 10.7: newly created decomposition items — per-child items and the
  // scope root's parent-consistency item alike — additionally inherit the
  // original's `blockedBy`.
  const newItems: ReviewItem[] = [];
  for (const generated of expansion) {
    const key = kindScopeKey(generated.kind, generated.scope.identity);
    if (!newByKey.has(key)) continue;
    const blockedBy: string[] = [];
    for (const ref of generated.blockedBy) {
      const id = idOfRef(ref);
      if (id !== undefined && !blockedBy.includes(id)) blockedBy.push(id);
    }
    for (const inherited of original.blockedBy) {
      if (!blockedBy.includes(inherited)) blockedBy.push(inherited);
    }
    newItems.push(
      newItemFromGenerated(
        generated,
        idByKey.get(key) as string,
        blockedBy,
        current,
        baseline,
      ),
    );
  }

  const itemIds = expansion.map(
    (generated) =>
      idByKey.get(
        kindScopeKey(generated.kind, generated.scope.identity),
      ) as string,
  );

  // SPEC 10.7: the original is removed; every item that was blocked by it
  // becomes blocked by all items of the decomposition. Reused items are
  // otherwise untouched — id, status, recorded state, and everything else
  // kept.
  const items: ReviewItem[] = [];
  for (const item of session.items) {
    if (item.id === original.id) continue;
    if (!item.blockedBy.includes(original.id)) {
      items.push(item);
      continue;
    }
    const blockedBy: string[] = [];
    for (const blocker of item.blockedBy) {
      if (blocker !== original.id) {
        if (!blockedBy.includes(blocker)) blockedBy.push(blocker);
        continue;
      }
      for (const id of itemIds) {
        // SPEC 10.1: no item blocks itself — split produces only acyclic
        // blocking.
        if (id !== item.id && !blockedBy.includes(id)) blockedBy.push(id);
      }
    }
    items.push({ ...item, blockedBy });
  }
  items.push(...newItems);

  // SPEC 10.7: the decomposition — the original's kind and scope node — is
  // recorded durably in the session and governs re-derivation (10.5).
  return {
    ok: true,
    session: {
      ...session,
      decompositions: [
        ...session.decompositions,
        { kind: "subtree-coherence", scope: original.scope },
      ],
      nextItemId,
      items,
    },
    itemIds,
  };
}

// ---------------------------------------------------------------------------
// `resolve` (SPEC 10.7): status, recorded state, and re-derivation
// ---------------------------------------------------------------------------

/** The inputs of `resolveSessionItem`. */
export interface ResolveItemArgs {
  /** The session, as stored — canonical references (src/core/review.ts). */
  readonly session: ReviewSession;
  /** The id of an item of `session.items` — caller-resolved and unblocked
   * (SPEC 10.7: resolving a blocked item is refused before this runs). */
  readonly itemId: string;
  /** SPEC 10.7: `--status` accepts `updated`, `no-change`, and `skipped`. */
  readonly status: ResolveStatus;
  /** SPEC 10.2: the optional `--note` text of this resolve — the stored
   * note is rewritten at each resolve, cleared when none is given. */
  readonly note?: string;
  /** The decomposition-expanded generator run (`expandDecompositions`) —
   * the generated set an `updated` resolve's re-derivation merges
   * (SPEC 10.5, 10.7). */
  readonly expanded: readonly GeneratedItem[];
  readonly current: CurrentDerivationSide;
  /** The recorded-baseline side; omitted for `audit`/`coverage` sessions. */
  readonly baseline?: BaselineDerivationSide;
}

/**
 * SPEC 10.7 `resolve`: set the item's status and record the current
 * relevant state (10.4) — `current` is rewritten at this resolve (10.2) —
 * on any unblocked item regardless of current status, so an `invalidated`
 * or previously resolved item is re-resolved the same way. When the status
 * is `updated`, the session is re-derived at resolve time (SPEC 10.5, for
 * every strategy): the expanded generation is merged under the
 * re-derivation rules — the just-resolved item, matched by kind and scope
 * node, keeps its new status and recorded state through the merge.
 * Resolving with `no-change` or `skipped` never re-derives.
 */
export function resolveSessionItem(args: ResolveItemArgs): ReviewSession {
  const { session, itemId, status, note, expanded, current, baseline } = args;
  const stateInputs = reviewStateInputs(current);
  const items = session.items.map((item): ReviewItem => {
    if (item.id !== itemId) return item;
    return {
      ...item,
      status,
      note,
      current: computeRecordedState(item, stateInputs),
    };
  });
  if (status !== "updated") {
    return { ...session, items };
  }
  const derived = deriveSessionItems({
    existing: items,
    nextItemId: session.nextItemId,
    generated: expanded,
    current,
    baseline,
  });
  return { ...session, nextItemId: derived.nextItemId, items: derived.items };
}

// ---------------------------------------------------------------------------
// Current context sets (SPEC 10.4 — the read-time seam)
// ---------------------------------------------------------------------------

/**
 * SPEC 10.4: the context set the session's strategy generators assign to
 * each item — the generators re-run with the recorded creation parameters
 * and decompositions against the current workspace (`generated` is that
 * run's expanded output), matched to the session's items by kind and scope
 * node. An item the generators no longer produce is absent from the map
 * (it retains its recorded context set). Feeds `ItemValidityInputs.
 * currentContexts` (review-state.ts); nothing is persisted.
 */
export function currentContextSets(
  items: readonly ReviewItem[],
  generated: readonly GeneratedItem[],
): ReadonlyMap<string, readonly string[]> {
  const generatedByKey = new Map<string, GeneratedItem>();
  for (const item of generated) {
    generatedByKey.set(kindScopeKey(item.kind, item.scope.identity), item);
  }
  const contexts = new Map<string, readonly string[]>();
  for (const item of items) {
    const match = generatedByKey.get(kindScopeKey(item.kind, item.scope));
    if (match !== undefined) {
      contexts.set(
        item.id,
        match.context.map((node) => node.identity),
      );
    }
  }
  return contexts;
}

// ---------------------------------------------------------------------------
// Item order (SPEC 10.5)
// ---------------------------------------------------------------------------

/** SPEC 10.5: the kind order among requirement-scoped items. */
const KIND_RANK: Readonly<Record<ItemKind, number>> = {
  "subtree-coherence": 0,
  "metadata-consistency": 1,
  "dependency-consistency": 2,
  "parent-consistency": 3,
  // `code-impact` is ordered by the code branch below, `uncovered-
  // requirement` by the coverage-session order (SPEC 10.7); the ranks are
  // unused but keep the record total.
  "code-impact": 4,
  "uncovered-requirement": 5,
};

/** SPEC 10.5: scope-node depth is the ID segment count; roots are 0. The
 * identity's shape (SPEC 1.5: `path#id`, bare path for a root) makes depth
 * derivable for absent nodes too. */
export function scopeDepth(identity: string): number {
  const hash = identity.indexOf("#");
  if (hash === -1) return 0;
  return identity.slice(hash + 1).split(".").length;
}

/** The scope node's file path (SPEC 1.5: the identity's path part). */
export function scopeFilePath(identity: string): string {
  const hash = identity.indexOf("#");
  return hash === -1 ? identity : identity.slice(0, hash);
}

/**
 * SPEC 10.5: the shared document-order tie-break ("wherever an item order
 * ranks by document order — here, in 10.6, and in 10.7"): among items tied
 * on every earlier key, those with present scope nodes come first, in
 * document order; those with absent scope nodes (SPEC 10.4) follow,
 * ordered by scope-node identity (the derived current spelling — ordering
 * compares scope nodes under their current identities), then by item id.
 * `spellingOf` maps an item to its scope's derived current spelling;
 * `positionOf` maps an item to its scope's document position — undefined
 * for a scope absent per 10.4, so a dangling scope whose spelling is borne
 * by a distinct recaptured node takes the absent branch.
 */
export function compareByDocumentOrder(
  a: ReviewItem,
  b: ReviewItem,
  spellingOf: (item: ReviewItem) => string,
  positionOf: (item: ReviewItem) => number | undefined,
): number {
  const aPosition = positionOf(a);
  const bPosition = positionOf(b);
  if (aPosition !== undefined && bPosition !== undefined) {
    return aPosition - bPosition;
  }
  if (aPosition !== undefined) return -1;
  if (bPosition !== undefined) return 1;
  const byIdentity = compareBytes(spellingOf(a), spellingOf(b));
  if (byIdentity !== 0) return byIdentity;
  return compareBytes(a.id, b.id);
}

/** Per requirement-node identity, its position in the graph's node order
 * (file path bytes, then document order — src/core/graph.ts). */
function nodePositions(graph: WorkspaceGraph): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  graph.requirementNodes.forEach((node, index) => {
    positions.set(node.identity, index);
  });
  return positions;
}

/** Per item, its scope reference's current resolution (SPEC 10.4):
 * ordering ranks by the derived current spelling, and a document position
 * exists only for a canonically resolving scope — a dangling scope is
 * absent (10.4) whatever node bears its spelling now. */
function scopeResolutions(
  items: readonly ReviewItem[],
  journal: Journal,
): (item: ReviewItem) => ReferenceResolution {
  const resolutions = new Map<ReviewItem, ReferenceResolution>();
  for (const item of items) {
    resolutions.set(item, resolveReference(journal, item.scope));
  }
  return (item): ReferenceResolution =>
    resolutions.get(item) as ReferenceResolution;
}

/** The `positionOf` of `compareByDocumentOrder` over a graph's node order:
 * an item's scope has a document position only when it canonically
 * resolves to a present node (SPEC 10.5 over 10.4 presence). */
function scopePositions(
  resolutionOf: (item: ReviewItem) => ReferenceResolution,
  positions: ReadonlyMap<string, number>,
): (item: ReviewItem) => number | undefined {
  return (item): number | undefined => {
    const resolution = resolutionOf(item);
    return resolution.resolves ? positions.get(resolution.spelling) : undefined;
  };
}

/**
 * SPEC 10.5: the total item order of a `path-blocks` session, computed
 * over current identities and presence (SPEC 10.4 — stored references
 * resolved to their derived current spellings): requirement-scoped items
 * first, by scope-node depth (ID segment count, roots 0) deepest first,
 * then kind (`subtree-coherence`, `metadata-consistency`,
 * `dependency-consistency`, `parent-consistency`), then scope-node file
 * path (bytes), then document order (present scopes first, absent ones by
 * identity then item id); `code-impact` items follow, sorted by
 * code-location identity (bytes). `status`, `next`, and `export` present
 * items in this order.
 */
export function sortItemsPathBlocks(
  items: readonly ReviewItem[],
  graph: WorkspaceGraph,
  journal: Journal,
): ReviewItem[] {
  const resolutionOf = scopeResolutions(items, journal);
  const spellingOf = (item: ReviewItem): string => resolutionOf(item).spelling;
  const positionOf = scopePositions(resolutionOf, nodePositions(graph));
  return [...items].sort((a, b) => {
    const aCode = a.kind === "code-impact";
    const bCode = b.kind === "code-impact";
    if (aCode !== bCode) return aCode ? 1 : -1;
    if (aCode && bCode) {
      const bySpelling = compareBytes(spellingOf(a), spellingOf(b));
      return bySpelling !== 0 ? bySpelling : compareBytes(a.id, b.id);
    }
    // SPEC 10.5: depth deepest first.
    const byDepth = scopeDepth(spellingOf(b)) - scopeDepth(spellingOf(a));
    if (byDepth !== 0) return byDepth;
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    const byPath = compareBytes(
      scopeFilePath(spellingOf(a)),
      scopeFilePath(spellingOf(b)),
    );
    if (byPath !== 0) return byPath;
    return compareByDocumentOrder(a, b, spellingOf, positionOf);
  });
}

/**
 * SPEC 10.6/10.7: the item order of an `audit` session and of a `coverage`
 * session's `uncovered-requirement` items — scope-node file path first
 * (byte order), then document order within the file — computed over current
 * identities and presence (SPEC 10.4) with the shared document-order tie
 * machinery of SPEC 10.5: within a file, items with present scope nodes
 * come first in document order (a root before every section of its file,
 * SPEC 1.2), and items with absent scope nodes follow, ordered by
 * scope-node identity, then by item id. An audit decomposition's
 * `parent-consistency` item ranks by its scope node like any other item
 * (SPEC 10.6 orders by scope node, not kind); a residual full tie falls
 * back to item id, keeping the order total. `status`, `next`, and `export`
 * present items in this order.
 */
export function sortItemsByFileThenDocument(
  items: readonly ReviewItem[],
  graph: WorkspaceGraph,
  journal: Journal,
): ReviewItem[] {
  const resolutionOf = scopeResolutions(items, journal);
  const spellingOf = (item: ReviewItem): string => resolutionOf(item).spelling;
  const positionOf = scopePositions(resolutionOf, nodePositions(graph));
  return [...items].sort((a, b) => {
    const byPath = compareBytes(
      scopeFilePath(spellingOf(a)),
      scopeFilePath(spellingOf(b)),
    );
    if (byPath !== 0) return byPath;
    const byDocument = compareByDocumentOrder(a, b, spellingOf, positionOf);
    if (byDocument !== 0) return byDocument;
    return compareBytes(a.id, b.id);
  });
}
