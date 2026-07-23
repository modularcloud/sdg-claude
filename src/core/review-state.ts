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
// Identity policy (src/core/review.ts header; SPEC 10.4, 6.3): sessions
// store node identities mapped forward to their current canonical spellings
// at write time, with the journal's entry count (`journalLength`) recording
// the moment. Reads map every recorded identity forward through the
// journal-entry suffix appended since (`journalSuffixMapper`,
// `mapSessionIdentitiesForward`) before comparing or presenting anything,
// so requirement nodes compare as canonical identities (SPEC 5.4) and code
// locations as identities, never as reference spellings: a journaled rename
// or move maps every recorded node to the identity its node now bears —
// hashes byte-identical wherever the operation was pure (SPEC 6.2) — so it
// duplicates no item, discards no status, and by itself invalidates
// nothing, while a vacated identity reintroduced by a distinct node maps
// away from that node's spelling and never collides with it.
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
import { Journal } from "./journal.js";
import type {
  ItemKind,
  ItemStatus,
  RecordedHashName,
  RecordedNodeState,
  RecordedState,
  RecordedTextTable,
  ReviewItem,
  ReviewSession,
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
   * SPEC 10.4/9.2: per code-location identity, the identities of the nodes
   * targeted by the location's impact edges — the union of its `references`
   * and `embeds` edges in the recorded-baseline graph and in this graph,
   * identities mapped through the journal into this graph's identity space.
   * Consulted only for `code-impact` items; callers of sessions that can
   * hold none (`audit`, `coverage`) may omit it.
   */
  readonly impactTargets?: (location: string) => readonly string[];
}

/**
 * The item fields the state computation reads (SPEC 10.4): the kind and the
 * scope, context, and origin nodes. `ReviewItem` satisfies this shape.
 * Every identity must be a spelling of the target graph's identity space —
 * for the current graph, a stored identity mapped forward first
 * (`mapItemIdentitiesForward`).
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
      for (const identity of scopeSubtreeIdentities(inputs.graph, item.scope)) {
        record(identity, "subtreeHash", "metadataHash");
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
 * The scope-node identities of a `subtree-coherence` item (SPEC 10.5: the
 * root and all descendants), in document order: derived from the graph the
 * state is computed against; an absent root has no descendants there and
 * contributes itself alone (module header).
 */
function scopeSubtreeIdentities(
  graph: WorkspaceGraph,
  scope: string,
): string[] {
  const root = graph.requirementNode(scope);
  if (root === undefined) {
    return [scope];
  }
  const identities: string[] = [];
  const stack: RequirementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    identities.push(node.identity);
    const children = graph.childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return identities;
}

/** One node's recorded state (SPEC 10.4): presence, and the required hash
 * values for a present node — the absent marker otherwise. */
function recordedNodeState(
  item: ItemStateSpec,
  identity: string,
  names: ReadonlySet<RecordedHashName>,
  inputs: ReviewStateInputs,
): RecordedNodeState {
  // SPEC 10.2/10.5: only a `code-impact` item's scope is a code location;
  // every other recorded node is a requirement node. A code location has no
  // hash values (SPEC 5.5 hashes requirement nodes), so its state is
  // presence alone.
  if (item.kind === "code-impact" && identity === item.scope) {
    return inputs.graph.codeLocation(identity) !== undefined
      ? { present: true, hashes: {} }
      : { present: false, hashes: "absent" };
  }
  if (inputs.graph.requirementNode(identity) === undefined) {
    // SPEC 10.4: absent — deleted, or its identity ceased to resolve; the
    // hashes are the explicit absent marker.
    return { present: false, hashes: "absent" };
  }
  const hashes: Partial<Record<RecordedHashName, string>> = {};
  if (names.size > 0) {
    const nodeHashes = inputs.hashes.get(identity);
    if (nodeHashes === undefined) {
      // Callers pass validated, fully hashed workspaces (SPEC 12.1, 13.3).
      throw new Error(
        `xspec internal error: no hashes for the recorded node ${identity}`,
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
 * SPEC 10.4: whether two context sets agree, as sets of node identities —
 * the recorded context set (the item's `context` field, 10.2) against the
 * generator-derived current one. Both sides must be current-identity
 * spellings (module header), so string equality is canonical-identity
 * equality (SPEC 5.4).
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
// Forward mapping (SPEC 10.4, 6.3 — the read-time identity seam)
// ---------------------------------------------------------------------------

/** An identity mapping — `Journal.mapForward` or a composition of it. */
export type IdentityMapper = (identity: string) => string;

/**
 * The mapper from a session's stored identity space to the current one
 * (SPEC 10.4, 6.3): the journal entries appended since the session was last
 * written (`journalLength` counts them, src/core/review.ts) applied in file
 * order, chained mappings composing. With no entries appended the mapper is
 * the identity. A `journalLength` beyond the journal's length maps nothing
 * — such a session was written under journal content the current journal no
 * longer extends, which the journal's own validation reports (SPEC 6.1,
 * 14.13); the mapping stays total and deterministic regardless.
 */
export function journalSuffixMapper(
  journal: Journal,
  journalLength: number,
): IdentityMapper {
  const suffix = new Journal(journal.entries.slice(journalLength));
  return (identity) => suffix.mapForward(identity);
}

/** A recorded state with every node key mapped (SPEC 10.4: reads present
 * every recorded node under its current identity). */
export function mapRecordedState(
  state: RecordedState,
  map: IdentityMapper,
): RecordedState {
  const nodes: Record<string, RecordedNodeState> = {};
  for (const [identity, node] of Object.entries(state.nodes)) {
    nodes[map(identity)] = node;
  }
  return { nodes };
}

/** A text table with every node key mapped (SPEC 10.4, 10.7). */
export function mapTextTable(
  table: RecordedTextTable,
  map: IdentityMapper,
): RecordedTextTable {
  const mapped: Record<string, RecordedTextTable[string]> = {};
  for (const [identity, texts] of Object.entries(table)) {
    mapped[map(identity)] = texts;
  }
  return mapped;
}

/**
 * SPEC 10.4: one item with every recorded node identity mapped forward —
 * scope, context, origin, both recorded states, and both text tables;
 * `blockedBy` names item IDs, not nodes, and is untouched. Whether or not a
 * node is still present, it is presented (and compared) under the identity
 * the mapping yields.
 */
export function mapItemIdentitiesForward(
  item: ReviewItem,
  map: IdentityMapper,
): ReviewItem {
  return {
    ...item,
    scope: map(item.scope),
    context: item.context.map((identity) => map(identity)),
    origin: item.origin.map((identity) => map(identity)),
    baseline: mapRecordedState(item.baseline, map),
    current: mapRecordedState(item.current, map),
    baselineTexts: mapTextTable(item.baselineTexts, map),
    derivedTexts: mapTextTable(item.derivedTexts, map),
  };
}

/**
 * SPEC 10.4/6.3: a session value with every recorded node identity — each
 * item's and each recorded decomposition's — mapped forward, and
 * `journalLength` advanced to the journal position the mapping reached.
 * Reads run this once after loading (with `journalSuffixMapper` over the
 * current journal) so every comparison and presentation works in current
 * identities; mutating subcommands persist the mapped session, which is how
 * stored identities stay current spellings (src/core/review.ts header).
 */
export function mapSessionIdentitiesForward(
  session: ReviewSession,
  map: IdentityMapper,
  journalLength: number,
): ReviewSession {
  return {
    ...session,
    journalLength,
    decompositions: session.decompositions.map((decomposition) => ({
      ...decomposition,
      scope: map(decomposition.scope),
    })),
    items: session.items.map((item) => mapItemIdentitiesForward(item, map)),
  };
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
   * without persisting anything, as current-identity spellings. An item the
   * generators no longer produce MUST be absent from the map: it retains
   * its recorded context set and cannot invalidate through it.
   */
  readonly currentContexts: ReadonlyMap<string, readonly string[]>;
}

/**
 * SPEC 10.4: the status a read reports for one item. A resolved item
 * (SPEC 10.3) is reported `invalidated` when its recorded `current` state
 * differs from the same state computed against the current graph, or when
 * its context set changed (`ItemValidityInputs`); an item needing review
 * (`unresolved`, `invalidated`) reports its stored status unchanged. The
 * item must already be mapped forward (`mapSessionIdentitiesForward`) —
 * this function never rewrites anything: a stale resolution is reported
 * `invalidated`, never persisted.
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
 * SPEC 10.4: read-time validity of every item of a (forward-mapped)
 * session, by item ID. Every read (`status`, `next`, `show`, `export`)
 * derives statuses through this — a stale resolution is never reported as
 * resolved — and feeds them to the blocking rule (SPEC 10.3,
 * `isItemBlocked`): because `invalidated` is not a resolved status, a
 * blocker that becomes invalidated re-blocks its dependents.
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
