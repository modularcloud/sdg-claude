// Review-item relevant state and read-time invalidation (SPEC 10.4).
//
// Pure core (IMPLEMENTATION Architecture: review-session logic is core —
// deterministic, I/O-free): over the workspace graph (./graph.ts), the node
// hashes (./hashes.ts), and the session model (./review.ts), this module
// computes the recorded state of SPEC 10.4 — the value an item's `baseline`
// and `current` fields hold (10.2) — and the read-time invalidation that
// compares a resolved item's recorded `current` against the current graph.
//
// The per-kind relevant hashes (SPEC 10.4):
//
// - `subtree-coherence` — subtreeHash and metadataHash of each scope node.
//   The scope is the root and all its descendants (10.5, 10.6), so the
//   scope-node set is derived from the graph the state is computed against:
//   a present root contributes itself and every current descendant, an
//   absent root contributes itself alone. Deriving the set identically at
//   record and at check keeps the two computations structurally aligned —
//   a descendant added or removed since the record surfaces as a key
//   difference (and through the root's subtreeHash), while a
//   metadata-only edit on a descendant, which changes no subtreeHash
//   (SPEC 5.5), still invalidates through that scope node's metadataHash.
// - `parent-consistency` — ownHash and metadataHash of the scope node;
//   subtreeHash of each context node (the branch children, 10.5).
// - `dependency-consistency` — ownHash and metadataHash of the scope node;
//   subtreeHash of each upstream target in context (10.5).
// - `metadata-consistency` — metadataHash of the scope node.
// - `code-impact` — subtreeHash and effectiveHash of each node targeted by
//   the scoped code location's impact edges (9.2: the union of the
//   location's `references` and `embeds` edges in the recorded-baseline
//   graph and in the current graph, identities mapped through the journal).
//   The target set is supplied by the caller (`ReviewStateInputs`), which
//   owns baseline reconstruction — `code-impact` items exist only in
//   baseline sessions (10.5), where the recorded baseline is at hand.
// - `uncovered-requirement` — subtreeHash and metadataHash of the scope
//   node (a coverage item's scope is the node alone, 10.7).
//
// Beyond the relevant hashes, the state records, for every scope, context,
// and origin node, whether the node is present; an absent node's hashes are
// recorded as the explicit absent marker (SPEC 10.4). A node carries hash
// values only where the kind's table lists them — so, e.g., an edit under a
// `subtree-coherence` item's context node (its ancestor chain, whose
// subtreeHashes change on any edit in the file) never invalidates by
// itself, while its deletion, a presence change, does.
//
// Invalidation (SPEC 10.4): a resolved item becomes `invalidated` when its
// recorded state differs from the same state computed against the current
// graph — a recorded hash changed, a node's presence changed in either
// direction, or the item's context set changed. The recorded context set is
// the item's `context` field (10.2), rewritten only where a strategy
// assigns it — creation and re-derivation (10.5) — and the current context
// set is the one the session's strategy generators, re-run with the
// recorded creation parameters and decompositions against the current
// workspace, assign to the item; callers supply it (`ItemValidityInputs`)
// and an item the generators no longer produce retains its recorded set. A
// node that was already absent when the state was recorded does not
// invalidate by remaining absent — the absent marker compares equal — so
// deletion review stays resolvable (SPEC 10.4, 10.2).
//
// Identity policy (src/core/review.ts header; SPEC 10.4, 5.4): sessions
// store every node reference as a canonical identity in the injective key
// encoding of src/core/journal.ts (`<position>:<identity>`). A canonical
// identity never changes as the journal grows, so byte equality of stored
// references is canonical comparison — requirement nodes compare as
// canonical identities and never as reference spellings: a journaled
// rename or move changes no stored reference and no hash wherever the
// operation was pure (SPEC 6.2), so it duplicates no item, discards no
// status, and by itself invalidates nothing, while a spelling vacated by a
// manual deletion (SPEC 6.6) and later recaptured by a journaled rename
// denotes two distinct canonical identities that never collide. The state
// computation here keys its result canonically — descendants and impact
// targets enumerated from the current graph are canonicalized against the
// full current journal — and judges presence by canonical resolution
// (SPEC 10.4: "a node is absent when it is deleted or its identity ceases
// to resolve through the journal"): a recorded node is present iff its
// canonical identity still resolves through the journal
// (`resolvesCurrently`) AND the graph holds a node at its derived current
// spelling — never by the spelling lookup alone, which would let a
// dangling reference alias the distinct node that recaptured its
// spelling. Spellings (`currentSpellingOf`, SPEC 6.3) serve presentation
// and, for a resolving reference, the graph, hash, and text lookups. This
// module owns the reference codec seam (`canonicalKeyOfCurrent`,
// `parseReference`, `spellingOfReference`, `resolveReference`) the
// derivation and presentation layers share.
//
// Everything here is pure: item validity is recomputed against the current
// graph on every read (`status`, `next`, `show`, `export`) and never
// persisted — reads never write the session file; sessions change only
// through the mutating subcommands (SPEC 10.4, 13.5). The one computation
// (`computeRecordedState`) serves both sides: the mutating subcommands
// record its result (item creation and each resolve, 10.2), and reads
// compare the recorded value against a fresh run.

import type { RequirementNode, WorkspaceGraph } from "./graph.js";
import type { NodeHashes } from "./hashes.js";
import type { CanonicalIdentity, Journal } from "./journal.js";
import {
  currentSpellingOf,
  encodeCanonicalIdentity,
  parseCanonicalIdentity,
  resolvesCurrently,
} from "./journal.js";
import type {
  ItemKind,
  ItemStatus,
  RecordedHashName,
  RecordedNodeState,
  RecordedState,
  ReviewItem,
} from "./review.js";
import { isResolvedStatus, RECORDED_HASH_NAMES } from "./review.js";

// ---------------------------------------------------------------------------
// Computing the recorded state (SPEC 10.4)
// ---------------------------------------------------------------------------

/**
 * The graph state a recorded state is computed against: the (current or
 * baseline) workspace graph and its hashes (SPEC 5.5), keyed by the node
 * identities of that graph.
 */
export interface ReviewStateInputs {
  readonly graph: WorkspaceGraph;
  readonly hashes: ReadonlyMap<string, NodeHashes>;
  /**
   * The full current journal (module header identity policy): stored
   * canonical references decode to their current spellings for graph and
   * hash lookups, and graph-enumerated nodes canonicalize into reference
   * keys.
   */
  readonly journal: Journal;
  /**
   * SPEC 10.4/9.2: per code-location reference, the canonical references of
   * the nodes targeted by the location's impact edges — the union of its
   * `references` and `embeds` edges in the recorded-baseline graph and in
   * this graph. Consulted only for `code-impact` items; callers of sessions
   * that can hold none (`audit`, `coverage`) may omit it.
   */
  readonly impactTargets?: (location: string) => readonly string[];
}

/**
 * The item fields the state computation reads (SPEC 10.4): the kind and the
 * scope, context, and origin nodes, each a stored canonical reference
 * (module header). `ReviewItem` satisfies this shape.
 */
export interface ItemStateSpec {
  readonly kind: ItemKind;
  readonly scope: string;
  readonly context: readonly string[];
  readonly origin: readonly string[];
}

/**
 * Compute the SPEC 10.4 recorded state of one item against `inputs`: the
 * item's relevant hashes per the kind table (module header) and, for every
 * scope, context, and origin node, whether the node is present — an absent
 * node's hashes recorded as the explicit absent marker. This is the value
 * the mutating subcommands record (item creation and each resolve, 10.2)
 * and the value reads recompute for the invalidation comparison.
 */
export function computeRecordedState(
  item: ItemStateSpec,
  inputs: ReviewStateInputs,
): RecordedState {
  // The required hash names per recorded node. Roles merge: a node both in
  // scope and in origin (say) holds one entry with the union of its
  // roles' relevant hashes.
  const required = new Map<string, Set<RecordedHashName>>();
  const record = (identity: string, ...names: RecordedHashName[]): void => {
    let set = required.get(identity);
    if (set === undefined) {
      required.set(identity, (set = new Set()));
    }
    for (const name of names) {
      set.add(name);
    }
  };

  // SPEC 10.4: presence is recorded for every scope, context, and origin
  // node, whatever hashes the kind's table assigns them.
  record(item.scope);
  for (const identity of item.context) {
    record(identity);
  }
  for (const identity of item.origin) {
    record(identity);
  }

  switch (item.kind) {
    case "subtree-coherence": {
      // SPEC 10.4: subtreeHash and metadataHash of each scope node — the
      // root and all current descendants (10.5), derived from the graph.
      for (const reference of scopeSubtreeReferences(inputs, item.scope)) {
        record(reference, "subtreeHash", "metadataHash");
      }
      break;
    }
    case "parent-consistency":
    case "dependency-consistency": {
      // SPEC 10.4: ownHash and metadataHash of the scope node; subtreeHash
      // of each context node (branch children / upstream targets, 10.5).
      record(item.scope, "ownHash", "metadataHash");
      for (const identity of item.context) {
        record(identity, "subtreeHash");
      }
      break;
    }
    case "metadata-consistency": {
      // SPEC 10.4: metadataHash of the scope node.
      record(item.scope, "metadataHash");
      break;
    }
    case "code-impact": {
      // SPEC 10.4: subtreeHash and effectiveHash of each node targeted by
      // the scoped code location's impact edges (9.2).
      const impactTargets = inputs.impactTargets;
      if (impactTargets === undefined) {
        throw new Error(
          `xspec internal error: the recorded state of a code-impact item ` +
            `(scope ${item.scope}) needs the impact-edge targets ` +
            `(SPEC 10.4, 9.2), but the caller supplied none`,
        );
      }
      for (const identity of impactTargets(item.scope)) {
        record(identity, "subtreeHash", "effectiveHash");
      }
      break;
    }
    case "uncovered-requirement": {
      // SPEC 10.4: subtreeHash and metadataHash of the scope node.
      record(item.scope, "subtreeHash", "metadataHash");
      break;
    }
  }

  const nodes: Record<string, RecordedNodeState> = {};
  for (const [identity, names] of required) {
    nodes[identity] = recordedNodeState(item, identity, names, inputs);
  }
  return { nodes };
}

/**
 * The scope-node references of a `subtree-coherence` item (SPEC 10.5: the
 * root and all descendants), in document order: the stored scope reference
 * canonically resolved to a current node, the subtree derived from the
 * graph the state is computed against, and each member canonicalized
 * against the full journal (module header). A root that does not resolve
 * to a current node — deleted, or its identity ceased to resolve
 * (SPEC 10.4) even though its derived spelling is borne by a distinct
 * recaptured node — has no descendants and contributes its stored
 * reference alone. Deriving the set identically at record and at check
 * keeps the two computations structurally aligned (module header).
 */
function scopeSubtreeReferences(
  inputs: ReviewStateInputs,
  scope: string,
): string[] {
  const resolution = resolveReference(inputs.journal, scope);
  const root = resolution.resolves
    ? inputs.graph.requirementNode(resolution.spelling)
    : undefined;
  if (root === undefined) {
    return [scope];
  }
  const references: string[] = [];
  const stack: RequirementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    references.push(canonicalKeyOfCurrent(inputs.journal, node.identity));
    const children = inputs.graph.childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return references;
}

/** One node's recorded state (SPEC 10.4): presence judged by canonical
 * resolution (module header) — the node is present iff its canonical
 * identity still resolves through the journal AND the graph holds a node
 * at the derived spelling — and the required hash values for a present
 * node, the absent marker otherwise. Hashes are read only for a resolving,
 * present node. */
function recordedNodeState(
  item: ItemStateSpec,
  reference: string,
  names: ReadonlySet<RecordedHashName>,
  inputs: ReviewStateInputs,
): RecordedNodeState {
  const { spelling, resolves } = resolveReference(inputs.journal, reference);
  // SPEC 10.2/10.5: only a `code-impact` item's scope is a code location;
  // every other recorded node is a requirement node. A code location has no
  // hash values (SPEC 5.5 hashes requirement nodes), so its state is
  // presence alone.
  if (item.kind === "code-impact" && reference === item.scope) {
    return resolves && inputs.graph.codeLocation(spelling) !== undefined
      ? { present: true, hashes: {} }
      : { present: false, hashes: "absent" };
  }
  if (!resolves || inputs.graph.requirementNode(spelling) === undefined) {
    // SPEC 10.4: absent — deleted, or its identity ceased to resolve
    // through the journal (a dangling reference stays absent even when its
    // derived spelling is borne by a distinct recaptured node); the hashes
    // are the explicit absent marker.
    return { present: false, hashes: "absent" };
  }
  const hashes: Partial<Record<RecordedHashName, string>> = {};
  if (names.size > 0) {
    const nodeHashes = inputs.hashes.get(spelling);
    if (nodeHashes === undefined) {
      // Callers pass validated, fully hashed workspaces (SPEC 12.1, 13.3).
      throw new Error(
        `xspec internal error: no hashes for the recorded node ${spelling}`,
      );
    }
    for (const name of RECORDED_HASH_NAMES) {
      if (names.has(name)) {
        hashes[name] = nodeHashes[name];
      }
    }
  }
  return { present: true, hashes };
}

// ---------------------------------------------------------------------------
// Comparing recorded states (SPEC 10.4)
// ---------------------------------------------------------------------------

/**
 * SPEC 10.4: whether two recorded states agree — the same node set, each
 * node with the same presence and, when present, the same recorded hash
 * values. Any difference is an invalidation cause: a recorded hash changed,
 * a node's presence changed in either direction, or the derived node set
 * itself moved (a scope subtree or impact-target set gaining or losing a
 * member). Both states must be in one identity space — recorded states
 * mapped forward before comparing (module header).
 */
export function recordedStatesEqual(
  a: RecordedState,
  b: RecordedState,
): boolean {
  const aEntries = Object.entries(a.nodes);
  if (aEntries.length !== Object.keys(b.nodes).length) {
    return false;
  }
  for (const [identity, aNode] of aEntries) {
    if (!Object.hasOwn(b.nodes, identity)) {
      return false;
    }
    if (!recordedNodeStatesEqual(aNode, b.nodes[identity])) {
      return false;
    }
  }
  return true;
}

function recordedNodeStatesEqual(
  a: RecordedNodeState,
  b: RecordedNodeState,
): boolean {
  if (!a.present || !b.present) {
    // SPEC 10.4: presence changed in either direction invalidates; two
    // absent markers compare equal (already-absent nodes staying absent do
    // not invalidate).
    return a.present === b.present;
  }
  for (const name of RECORDED_HASH_NAMES) {
    if (a.hashes[name] !== b.hashes[name]) {
      return false;
    }
  }
  return true;
}

/**
 * SPEC 10.4: whether two context sets agree, as sets of node references —
 * the recorded context set (the item's `context` field, 10.2) against the
 * generator-derived current one. Both sides are canonical references
 * (module header), so string equality is canonical-identity equality
 * (SPEC 5.4).
 */
export function identitySetsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const aSet = new Set(a);
  const bSet = new Set(b);
  if (aSet.size !== bSet.size) {
    return false;
  }
  for (const identity of aSet) {
    if (!bSet.has(identity)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Canonical references (SPEC 5.4, 10.4 — the stored-identity codec seam)
// ---------------------------------------------------------------------------

/**
 * The stored canonical reference of a node identified by a current-graph
 * spelling: its canonical identity against the full journal (SPEC 5.4),
 * encoded as the injective reference key (src/core/journal.ts).
 */
export function canonicalKeyOfCurrent(
  journal: Journal,
  spelling: string,
): string {
  return encodeCanonicalIdentity(journal.canonicalIdentity(spelling));
}

/**
 * Decode a stored canonical reference. Session parsing validates every
 * stored reference (src/core/review.ts), and every internally built key
 * comes from the encoder, so a reference that does not parse here is an
 * internal error, never data.
 */
export function parseReference(reference: string): CanonicalIdentity {
  const canonical = parseCanonicalIdentity(reference);
  if (canonical === null) {
    throw new Error(
      `xspec internal error: ${JSON.stringify(reference)} is not a ` +
        `canonical identity reference`,
    );
  }
  return canonical;
}

/**
 * SPEC 10.4/6.3: a stored reference's current spelling — "the recorded
 * identity mapped forward through the journal (6.3)" — for presentation
 * and graph lookups. Total whether or not the node still resolves; after a
 * recapture the spelling is the recapturing chain's, a distinction the
 * canonical keys keep and the spellings deliberately do not.
 */
export function spellingOfReference(
  journal: Journal,
  reference: string,
): string {
  return currentSpellingOf(journal, parseReference(reference));
}

/** A stored reference's current resolution (`resolveReference`). */
export interface ReferenceResolution {
  /** The derived current spelling (SPEC 6.3) — total, presentation-grade
   * whether or not the reference resolves. */
  readonly spelling: string;
  /** SPEC 10.4: whether the canonical identity still resolves through the
   * journal — false exactly when a later entry recaptured the spelling for
   * a different chain. */
  readonly resolves: boolean;
}

/**
 * Resolve a stored reference against the journal (SPEC 10.4): its derived
 * current spelling plus whether its canonical identity still resolves.
 * Every presence or state judgment requires both (module header): a node
 * is present iff `resolves` holds AND the graph holds a node at
 * `spelling` — a dangling reference whose spelling is borne by a distinct
 * recaptured node is absent, while its spelling still names it for
 * presentation.
 */
export function resolveReference(
  journal: Journal,
  reference: string,
): ReferenceResolution {
  const canonical = parseReference(reference);
  return {
    spelling: currentSpellingOf(journal, canonical),
    resolves: resolvesCurrently(journal, canonical),
  };
}

/**
 * A recorded state as presented (SPEC 10.2: reads report both fields as
 * recorded; 10.4: every recorded node presented under its current
 * identity): each node keyed by its derived current spelling. Where two
 * canonically distinct recorded nodes of the state share a forward-mapped
 * spelling — reachable only when a spelling vacated by a manual deletion
 * was recaptured by a journaled rename — spelling keys would collide and
 * drop a recorded node, so the whole state keeps its stored canonical keys
 * instead: deterministic, injective, and every recorded node presented.
 */
export function presentRecordedState(
  journal: Journal,
  state: RecordedState,
): RecordedState {
  const references = Object.keys(state.nodes);
  const spellings = new Map<string, string>();
  for (const reference of references) {
    spellings.set(reference, spellingOfReference(journal, reference));
  }
  if (new Set(spellings.values()).size !== references.length) {
    return state;
  }
  const nodes: Record<string, RecordedNodeState> = {};
  for (const [reference, node] of Object.entries(state.nodes)) {
    nodes[spellings.get(reference) as string] = node;
  }
  return { nodes };
}

// ---------------------------------------------------------------------------
// Read-time validity (SPEC 10.4)
// ---------------------------------------------------------------------------

/** The inputs of the read-time validity computation (SPEC 10.4). */
export interface ItemValidityInputs {
  /** The current graph state (module header). */
  readonly state: ReviewStateInputs;
  /**
   * SPEC 10.4: the current context sets, by item ID — the context set the
   * session's strategy generators assign to each item when re-run with the
   * session's recorded creation parameters (10.7) and recorded
   * decompositions (10.5, 10.7) against the current workspace, computed
   * without persisting anything, as canonical references (module header).
   * An item the generators no longer produce MUST be absent from the map:
   * it retains its recorded context set and cannot invalidate through it.
   */
  readonly currentContexts: ReadonlyMap<string, readonly string[]>;
}

/**
 * SPEC 10.4: the status a read reports for one item. A resolved item
 * (SPEC 10.3) is reported `invalidated` when its recorded `current` state
 * differs from the same state computed against the current graph — both
 * keyed canonically (module header), so the comparison is the canonical
 * one SPEC 10.4 requires — or when its context set changed
 * (`ItemValidityInputs`). An item needing review (`unresolved`,
 * `invalidated`) reports its stored status unchanged. This function never
 * rewrites anything: a stale resolution is reported `invalidated`, never
 * persisted.
 */
export function effectiveItemStatus(
  item: ReviewItem,
  inputs: ItemValidityInputs,
): ItemStatus {
  if (!isResolvedStatus(item.status)) {
    return item.status;
  }
  const fresh = computeRecordedState(item, inputs.state);
  if (!recordedStatesEqual(item.current, fresh)) {
    return "invalidated";
  }
  const currentContext = inputs.currentContexts.get(item.id);
  if (
    currentContext !== undefined &&
    !identitySetsEqual(item.context, currentContext)
  ) {
    return "invalidated";
  }
  return item.status;
}

/**
 * SPEC 10.4: read-time validity of every item of a session, by item ID.
 * Every read (`status`, `next`, `show`, `export`) derives statuses through
 * this — a stale resolution is never reported as resolved — and feeds them
 * to the blocking rule (SPEC 10.3, `isItemBlocked`): because `invalidated`
 * is not a resolved status, a blocker that becomes invalidated re-blocks
 * its dependents.
 */
export function deriveEffectiveStatuses(
  items: readonly ReviewItem[],
  inputs: ItemValidityInputs,
): ReadonlyMap<string, ItemStatus> {
  const statuses = new Map<string, ItemStatus>();
  for (const item of items) {
    statuses.set(item.id, effectiveItemStatus(item, inputs));
  }
  return statuses;
}
