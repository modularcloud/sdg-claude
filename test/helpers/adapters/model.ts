// The information model the test suite asserts against (TEST-SPEC §0 H-3).
//
// SPEC.md fixes the information content of reports and JSON documents but not
// their concrete shape; TEST-SPEC's assertions are written against the types
// in this file. This module is the *fixed* side of the adapter layer: it
// mirrors what the tests assert (nodes, hashes, edges, categories, counts,
// paths, findings, items, …) and changes only when TEST-SPEC does. The
// decoders beside it (query.ts, reports.ts, review.ts) are the *adjustable*
// side — aware of the product's concrete output shape, adjustable to shape,
// never to values.
//
// Vocabularies below are spec-fixed tokens (they appear literally in SPEC.md
// as configuration values, CLI flag values, category names, statuses, and
// item kinds), so adapters validate membership rather than passing unknown
// tokens through.

/** Edge kinds (SPEC.md 5.2; CLI `--kinds` values, T11-4/T12.0-4). */
export const EDGE_KINDS = [
  "contains",
  "depends",
  "embeds",
  "references",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The three dependency kinds — `reachable`'s domain (SPEC.md 11, T11-5). */
export const DEPENDENCY_EDGE_KINDS = [
  "depends",
  "embeds",
  "references",
] as const;

/** Change categories of SPEC.md 5.6 (T5.6-*, T9.1-1). */
export const CHANGE_CATEGORIES = [
  "changed",
  "descendant-changed",
  "upstream-changed",
  "metadata-changed",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/**
 * Review item statuses (SPEC.md 10.3/10.4): the stored resolve statuses plus
 * `unresolved` and the read-time `invalidated`.
 */
export const ITEM_STATUSES = [
  "unresolved",
  "invalidated",
  "updated",
  "no-change",
  "skipped",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Built-in review item kinds (SPEC.md 10.4–10.6, 10.7 coverage sessions). */
export const ITEM_KINDS = [
  "subtree-coherence",
  "parent-consistency",
  "dependency-consistency",
  "metadata-consistency",
  "code-impact",
  "uncovered-requirement",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** A source range: zero-based byte offsets into the source file (SPEC.md 1.7). */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** One graph edge: canonical graph-node identities plus kind (SPEC.md 5.2). */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/** The four hashes of a requirement node (SPEC.md 5.5). Values are opaque. */
export interface NodeHashes {
  readonly ownHash: string;
  readonly subtreeHash: string;
  readonly effectiveHash: string;
  readonly metadataHash: string;
}

/** Full node report: `query node` / `show` (T11-1, T12.4-1). */
export interface NodeReport {
  readonly identity: string;
  readonly sourceRange: SourceRange;
  readonly ownText: string;
  readonly subtreeText: string;
  readonly hashes: NodeHashes;
  readonly tags: readonly string[];
  /** Coverage attribute; absent for root nodes (T1.2-3, T11-1). */
  readonly coverage?: string;
  readonly incomingEdges: readonly GraphEdge[];
  readonly outgoingEdges: readonly GraphEdge[];
}

/** One row of `query nodes`/`subtree`/`ancestors` (T11-2, T11-3). */
export interface NodeRow {
  readonly identity: string;
  readonly sourceRange: SourceRange;
  readonly tags: readonly string[];
  /** Coverage attribute; absent for root nodes. */
  readonly coverage?: string;
}

/**
 * Identity-and-tags summary of a `query node` document — the minimal decoding
 * for tests certified against fixtures whose scoped query surface reports
 * only identity, tags, and metadataHash (CERTIFICATIONS.md §CONF-VALID:
 * T1.4-2, T1.4-4).
 */
export interface NodeSummary {
  readonly identity: string;
  readonly tags: readonly string[];
}

/**
 * Identity/tags/metadataHash summary of a `query node` document — the full
 * CONF-VALID-scoped query surface (CERTIFICATIONS.md §CONF-VALID: fixtures
 * within that scope promise exactly identity, tags, and metadataHash), for
 * the tests comparing tag spellings through the metadata hash (T2.6-1,
 * T2.6-2; SPEC.md 5.5).
 */
export interface NodeMetadataSummary {
  readonly identity: string;
  readonly tags: readonly string[];
  readonly metadataHash: string;
}

/**
 * Own/subtree text summary of a `query node` document — the CONF-MD-scoped
 * query surface (CERTIFICATIONS.md §CONF-MD: fixtures within that scope
 * promise `query node` reporting own and subtree text, SPEC.md 1.6), for the
 * text-algebra property (P-2/P-3). Either text MAY be empty (an empty leaf
 * section, SPEC.md 1.1).
 */
export interface NodeTextSummary {
  readonly ownText: string;
  readonly subtreeText: string;
}

/** `query reachable` (T11-5): existence plus one shortest witness path. */
export interface ReachableReport {
  readonly reachable: boolean;
  /** Node-identity sequence; present exactly when `reachable`. */
  readonly path?: readonly string[];
}

/** `ids` flat form (T12.3-1): files in byte order, IDs in document order. */
export interface IdsReport {
  readonly files: readonly IdsFileEntry[];
}
export interface IdsFileEntry {
  readonly file: string;
  readonly ids: readonly string[];
}

/** `ids --tree` (T12.3-1): per-file nesting. */
export interface IdsTreeReport {
  readonly files: readonly IdsTreeFileEntry[];
}
export interface IdsTreeFileEntry {
  readonly file: string;
  readonly nodes: readonly IdsTreeNode[];
}
export interface IdsTreeNode {
  readonly id: string;
  readonly children: readonly IdsTreeNode[];
}

/**
 * One validation/check finding (SPEC.md 14; T14-1, T7.5-2, T5.3-1, T6.1-3).
 * `condition` is the SPEC.md 14 condition identity (`"14.2"`); `message` is
 * the correction-oriented text (information presence, never exact wording).
 * The optional fields carry the extra information particular findings must
 * identify: source file and location, the violated policy rule and offending
 * edge (7.5), a full cycle path (5.3).
 */
export interface Finding {
  readonly condition: string;
  readonly message: string;
  readonly file?: string;
  readonly location?: SourceRange;
  readonly rule?: string;
  readonly edge?: GraphEdge;
  readonly cycle?: readonly string[];
}

/** A failing `build` / `check` findings report (exit 1, stdout). */
export interface FindingsReport {
  readonly findings: readonly Finding[];
}

/** `coverage` (T8.2-1): all profiles by default, one when named. */
export interface CoverageReport {
  readonly profiles: readonly CoverageProfileReport[];
}
export interface CoverageProfileReport {
  readonly name: string;
  readonly counts: CoverageCounts;
  readonly covered: readonly CoveredNode[];
  readonly uncovered: readonly string[];
  readonly ignored: readonly IgnoredNode[];
}
export interface CoverageCounts {
  readonly required: number;
  readonly covered: number;
  readonly uncovered: number;
  readonly ignored: number;
}
export interface CoveredNode {
  readonly identity: string;
  /** One shortest covering path, boundary to target (12.0 tie-break). */
  readonly path: readonly string[];
}
export interface IgnoredNode {
  readonly identity: string;
  /** All applicable reasons, in the fixed order (T8.2-1, `root node` incl.). */
  readonly reasons: readonly string[];
}

/**
 * `impact --base` (SPEC.md 5.6, 9; T9.1-1, T9.2-*, T9.3-*).
 * A requirement entry may cover a collapsed ancestor chain (T9.3-1), so it
 * carries one or more node identities. Deleted nodes report under their
 * (journal-mapped) baseline identities with `deleted` set (T5.6-6, T9.3-3).
 */
export interface ImpactReport {
  /** The resolved baseline commit, when the product echoes it (E-6, H-3). */
  readonly baseline?: string;
  readonly requirements: readonly ImpactRequirementEntry[];
  readonly code: ImpactedCode;
}
export interface ImpactRequirementEntry {
  readonly nodes: readonly string[];
  readonly deleted: boolean;
  readonly categories: readonly ImpactCategoryEntry[];
}
export interface ImpactCategoryEntry {
  readonly category: ChangeCategory;
  /** Attribution identities (T5.6-1/2/3; may be empty for `changed`). */
  readonly attributedTo: readonly string[];
}
export interface ImpactedCode {
  readonly direct: readonly ImpactedCodeEntry[];
  readonly transitive: readonly ImpactedCodeEntry[];
}
export interface ImpactedCodeEntry {
  readonly location: string;
  /** The minimized witness edge (T9.3-2: kind is asserted — `embeds` wins). */
  readonly edge: GraphEdge;
  /** The witness path from the edge's target (T9.3-2). */
  readonly path: readonly string[];
}

/** `review list` (T10.7-5): sessions in byte order of name. */
export interface SessionListReport {
  readonly sessions: readonly SessionListEntry[];
}
export type SessionListEntry =
  | { readonly name: string; readonly corrupt: true }
  | {
      readonly name: string;
      readonly corrupt: false;
      readonly strategy: string;
      /** Item counts by stored status (no read-time invalidation). */
      readonly counts: Readonly<Record<string, number>>;
    };

/** `review status` (T10.7-6): rows in item order plus totals by status. */
export interface SessionStatusReport {
  readonly items: readonly SessionStatusRow[];
  /** Totals by status, read-time invalidation applied. */
  readonly totals: Readonly<Record<string, number>>;
}
export interface SessionStatusRow {
  readonly id: string;
  readonly kind: ItemKind;
  readonly scope: string;
  readonly status: ItemStatus;
  readonly blocked: boolean;
}

/**
 * A node presented inside an item payload: identity, presence, and — where
 * the kind's payload contract supplies one — text: read from the current
 * graph for a present node, and for an absent node the recorded value under
 * SPEC.md 10.7's provenance rule (a node contained in no recorded state, and
 * a `code-impact` scope, carries none; T10.2-3, T10.7-12). A source range
 * exists only for a present node (10.7, 1.7).
 */
export interface NodeTextState {
  readonly node: string;
  readonly present: boolean;
  readonly text?: string;
  readonly sourceRange?: SourceRange;
}

/** One side of an origin before/after pair (T10.7-12). */
export type OriginTextSide =
  | { readonly present: false }
  | { readonly present: true; readonly text: string };

/** One origin entry: a node's own text before and after (T10.7-12). */
export interface OriginEntry {
  readonly node: string;
  readonly before: OriginTextSide;
  readonly after: OriginTextSide;
}

/**
 * A full review item as presented by `next --json`, `show`, and `export`
 * (SPEC.md 10.2, 10.7; T10.2-1, T10.7-7/8/12). `baseline` and `current` carry
 * the recorded relevant state; their inner structure is product-shaped and
 * compared whole (as decoded JSON) by the tests that assert them.
 */
export interface ReviewItem {
  readonly id: string;
  readonly kind: ItemKind;
  readonly status: ItemStatus;
  readonly blocked: boolean;
  readonly blockedBy: readonly string[];
  readonly reason: string;
  readonly note?: string;
  readonly scope: NodeTextState;
  readonly context: readonly NodeTextState[];
  readonly origin: readonly OriginEntry[];
  readonly baseline: unknown;
  readonly current: unknown;
}

/** `review next` (T10.7-7): fully resolved, or the first actionable item. */
export interface NextReport {
  readonly fullyResolved: boolean;
  /** Present exactly when not fully resolved. */
  readonly item?: ReviewItem;
}

/** `review export` (T10.7-8): the whole session, one JSON document. */
export interface ExportReport {
  readonly name: string;
  readonly strategy: string;
  /** Recorded creation parameters — product-shaped, compared whole. */
  readonly creationParameters: unknown;
  /** Recorded decompositions — product-shaped, compared whole. */
  readonly decompositions: unknown;
  readonly items: readonly ReviewItem[];
}
