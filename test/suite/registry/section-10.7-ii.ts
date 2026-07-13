// TEST-SPEC §10.7 (review commands), second half — SUITE-39:
// T10.7-7…T10.7-12 (`next`; `show`/`export`; `split`; `resolve`; coverage
// re-derivation; the payload text contract). T10.7-1…T10.7-6 are SUITE-38's
// business (section-10.7-i.ts).
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 10.7: `next` returns the first needing-review unblocked item in item
// order; a session whose items are all resolved (or that has none) reports
// fully resolved in human and `--json` forms, exit 0, with no item in the
// JSON payload, and the `--json` payload is self-contained — every scope,
// context, and origin node under its current identity and presence, source
// ranges for present requirement nodes, the recorded `baseline` and `current`
// hashes, and text per item kind. `show` reports the full item (the 10.2
// fields plus the same payload); `export` emits the whole session as one JSON
// document, with or without `--json`, read-time invalidation applied. `split`
// decomposes a `subtree-coherence` item with children into per-child
// `subtree-coherence` items plus the scope root's `parent-consistency` item,
// reusing existing kind+scope items, recording the decomposition durably, and
// never reusing the removed original's id. `resolve` sets the status and
// records the current relevant state, on any unblocked item regardless of
// status. Re-derivation on an `updated` resolve holds for every strategy —
// a coverage session re-runs its recorded profile against the current
// workspace (T10.7-11). The payload text contract (T10.7-12) fixes which text
// each kind presents and the provenance of absent nodes' texts.
//
// Conservative operationalizations (noted per H-3/H-4):
// - The human fully-resolved report (T10.7-7) is asserted for information
//   presence via /resolv/i: SPEC fixes the fact reported ("fully resolved"),
//   never wording — any phrasing reporting resolution qualifies (H-3).
// - Payload texts are byte-compared against `query node` captures taken at
//   the pinned graph states (own/subtree text per SPEC 1.6, source ranges per
//   1.7 — the same values T11-1 fixes for `query node`), with distinctness
//   premises asserted first so every discrimination (own vs subtree text,
//   baseline vs create-time vs current values) is meaningful. Embedding
//   expansion is additionally pinned with byte literals: the asserted text
//   must contain the embedded target's authored text and must not contain the
//   unexpanded `text(` spelling (SPEC 1.6, 2.3).
// - `context` and `origin` are compared as identity-keyed sets (SPEC 10.7
//   fixes their membership, not a payload order); each entry's presence,
//   text, and source range are then asserted per node.
// - "Texts byte-asserted in `next --json` and identically via `show` and
//   `export` (one payload rule)": `export` is the reference read; `show` of
//   every item and a full `next` walk (repeated `next --json` + `resolve
//   --status no-change`, which never re-derives) must present the identical
//   {scope, context, origin} payload projection per item id.
// - `blockedBy` is compared as a sorted id set (SPEC 10.5/10.7 fix which
//   items block, not an order within the field).
// - Recorded state (`baseline`/`current`), creation parameters, and
//   decompositions are product-shaped and opaque (H-4): hash recording is
//   asserted by string-leaf containment of `query node` captures at the
//   expected moment (with pairwise-distinct premises and negative arms), the
//   recorded decomposition by containment of the decomposed item's spec-fixed
//   scope-node identity, and "state kept" as canonical-JSON equality of the
//   reported member across the operation (the §10.2/§10.6 style).
// - A refused `split`/`resolve` (exit 1) is additionally checked to leave the
//   session's reported rows unchanged — a refusal resolves and splits nothing
//   (SPEC 10.7; the byte-level modifies-nothing protocol is T10.1-4/T10.3-2
//   territory).
// - Workspaces are git-less wherever no baseline is involved; every fixture
//   edit is followed by an explicit `build` before any read, so no read
//   relies on the 13.3 refresh path (T13.3-*'s business).

import type {
  ExportReport,
  ItemKind,
  ItemStatus,
  NextReport,
  NodeReport,
  OriginEntry,
  ReviewItem,
  SessionStatusReport,
  SessionStatusRow,
  SourceRange,
} from "../../helpers/adapters/index.js";
import {
  assertReportMentions,
  decodeExportReport,
  decodeItemReport,
  decodeNextReport,
  decodeNodeReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { assertSameJson, buildOk, expectExit, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus a direct coverage profile over it (SPEC 7.4): with the
// group serving as its own boundary, a leaf is covered exactly when some
// non-root node has a single dependency edge to it (SPEC 8).
const COVERAGE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "p",
      target: "main",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

// A direct profile over every node (`targets: "all"`, SPEC 7.4/8.1), so a
// branch node can be required and uncovered — making an
// `uncovered-requirement` scope whose subtree text differs from its own text
// (the T10.7-12 discriminator).
const COVERAGE_ALL_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "p",
      target: "main",
      boundary: "main",
      mode: "direct",
      targets: "all"
    }
  ]
})
`;

// Spec group plus a code group (SPEC 7.2) — the T10.7-12 matrix fixture needs
// a `code-impact` item (an impacted code location, SPEC 9.2, 10.5).
const SPECS_CODE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  }
})
`;

/** Stage a fresh workspace (config plus `files`), run `body`, dispose (H-1). */
async function withWorkspace<T>(
  config: string,
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({
    files: { "xspec.config.ts": config, ...files },
  });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** Full `query node` report (SPEC 11, JSON-only; H-3). */
async function queryNode(
  product: ProductBinding,
  workspace: TestWorkspace,
  identity: string,
  context: string,
): Promise<NodeReport> {
  const label = `${context} \`query node ${identity}\``;
  return decodeNodeReport(
    await runJson(product, workspace, ["query", "node", identity], label),
    label,
  );
}

/** `review status <name> --json`, decoded (SPEC 10.7). */
async function sessionStatus(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<SessionStatusReport> {
  const label = `${context} \`review status ${name} --json\``;
  return decodeSessionStatusReport(
    await runJson(
      product,
      workspace,
      ["review", "status", name, "--json"],
      label,
    ),
    label,
  );
}

/** `review export <name> --json`, decoded (SPEC 10.7). */
async function exportSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<ExportReport> {
  const label = `${context} \`review export ${name} --json\``;
  return decodeExportReport(
    await runJson(
      product,
      workspace,
      ["review", "export", name, "--json"],
      label,
    ),
    label,
  );
}

/** `review show <name> <item-id> --json`, decoded as the full item. */
async function showItem(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  itemId: string,
  context: string,
): Promise<ReviewItem> {
  const label = `${context} \`review show ${name} ${itemId} --json\``;
  return decodeItemReport(
    await runJson(
      product,
      workspace,
      ["review", "show", name, itemId, "--json"],
      label,
    ),
    label,
  );
}

/** `review next <name> --json`, decoded (SPEC 10.7). */
async function nextInSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<NextReport> {
  const label = `${context} \`review next ${name} --json\``;
  return decodeNextReport(
    await runJson(
      product,
      workspace,
      ["review", "next", name, "--json"],
      label,
    ),
    label,
  );
}

/** The item `next` returned, diagnosed when the session reports resolved. */
function requireNextItem(next: NextReport, context: string): ReviewItem {
  if (next.fullyResolved || next.item === undefined) {
    fail(
      `${context}: the session still holds a needing-review unblocked item, ` +
        `so \`next\` returns one (SPEC 10.7); got the fully-resolved report`,
    );
  }
  return next.item;
}

/** `review create --strategy audit --name <name>` must succeed (SPEC 10.7). */
async function createAuditSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<void> {
  await expectExit(
    product,
    workspace,
    ["review", "create", "--strategy", "audit", "--name", name],
    0,
    `${context} \`review create --strategy audit --name ${name}\``,
  );
}

/** `review create --base <ref> --name <name>` must succeed (SPEC 10.7). */
async function createBaseSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  ref: string,
  name: string,
  context: string,
): Promise<void> {
  await expectExit(
    product,
    workspace,
    ["review", "create", "--base", ref, "--name", name],
    0,
    `${context} \`review create --base <baseline> --name ${name}\``,
  );
}

/** `review create --coverage <profile> --name <name>` must succeed. */
async function createCoverageSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  profile: string,
  name: string,
  context: string,
): Promise<void> {
  await expectExit(
    product,
    workspace,
    ["review", "create", "--coverage", profile, "--name", name],
    0,
    `${context} \`review create --coverage ${profile} --name ${name}\``,
  );
}

/** `review resolve <name> <item-id> --status <status>` must succeed. */
async function resolveOk(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  itemId: string,
  status: ItemStatus,
  context: string,
): Promise<void> {
  await expectExit(
    product,
    workspace,
    ["review", "resolve", name, itemId, "--status", status],
    0,
    context,
  );
}

/**
 * The unique status row for a kind and scope node, diagnosed loudly when
 * missing or duplicated (SPEC 10.1, 10.5: at most one item per kind and
 * scope node — the invariant holds for every strategy).
 */
function requireRow(
  report: SessionStatusReport,
  kind: ItemKind,
  scope: string,
  context: string,
): SessionStatusRow {
  const rows = report.items.filter(
    (row) => row.kind === kind && row.scope === scope,
  );
  if (rows.length !== 1) {
    fail(
      `${context}: expected exactly one ${kind} item scoped at ${scope} ` +
        `(SPEC 10.1, 10.5: a session never contains two items with the same ` +
        `kind and scope node); found ${String(rows.length)} among ` +
        JSON.stringify(report.items.map((row) => `${row.kind} ${row.scope}`)),
    );
  }
  return rows[0];
}

/** The unique full item for a kind and scope node in an export item list. */
function requireItem(
  items: readonly ReviewItem[],
  kind: ItemKind,
  scope: string,
  context: string,
): ReviewItem {
  const matches = items.filter(
    (item) => item.kind === kind && item.scope.node === scope,
  );
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one ${kind} item scoped at ${scope} ` +
        `(SPEC 10.1, 10.5: at most one item per kind and scope node); found ` +
        `${String(matches.length)} among ` +
        JSON.stringify(items.map((item) => `${item.kind} ${item.scope.node}`)),
    );
  }
  return matches[0];
}

/** The unique item with the given id in an item list (SPEC 10.2). */
function requireItemById(
  items: readonly ReviewItem[],
  id: string,
  context: string,
): ReviewItem {
  const matches = items.filter((item) => item.id === id);
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one item with id ${JSON.stringify(id)} ` +
        `(SPEC 10.2: item ids are unique within the session); found ` +
        `${String(matches.length)} among ` +
        JSON.stringify(items.map((item) => item.id)),
    );
  }
  return matches[0];
}

/** In-order `kind scope status` rendering of status rows (order compare). */
function rowSequence(report: SessionStatusReport): readonly string[] {
  return report.items.map((row) => `${row.kind} ${row.scope} ${row.status}`);
}

/** In-order `kind scope` rendering of export items (order compare). */
function exportKindScopeSequence(
  items: readonly ReviewItem[],
): readonly string[] {
  return items.map((item) => `${item.kind} ${item.scope.node}`);
}

/** Sorted node-identity set of a payload node list (membership compare). */
function identitySet(
  states: readonly { readonly node: string }[],
): readonly string[] {
  return states.map((state) => state.node).sort();
}

/**
 * Assert an item's `blockedBy` as a sorted id set (SPEC 10.5/10.7 fix which
 * items block; the field's internal order is not pinned).
 */
function assertBlockedBy(
  item: ReviewItem,
  expected: readonly string[],
  context: string,
): void {
  assertSameJson(
    [...item.blockedBy].sort(),
    [...expected].sort(),
    `${context}: the item's blockedBy id set (SPEC 10.5, 10.6, 10.7)`,
  );
}

/**
 * Canonical JSON rendering: object members sorted by key, arrays in order,
 * recursively — equality of information content where concrete member order
 * is shape territory (H-3/H-4).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Diagnosed canonical-JSON (key-order-insensitive) deep equality. */
function assertSameInformation(
  actual: unknown,
  expected: unknown,
  context: string,
): void {
  const actualRendered = canonicalJson(actual);
  const expectedRendered = canonicalJson(expected);
  if (actualRendered === expectedRendered) return;
  fail(
    `${context}: values differ (canonical JSON, key order normalized)\n` +
      `  actual:   ${actualRendered}\n` +
      `  expected: ${expectedRendered}`,
  );
}

/** Every string leaf of a decoded JSON value (array elements and members). */
function collectStringLeaves(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const element of value) collectStringLeaves(element, into);
  } else if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) {
      collectStringLeaves(member, into);
    }
  }
  return into;
}

/**
 * The recorded state must hold the given value among its string leaves
 * (SPEC 10.2/10.4: `baseline`/`current` hold the item's relevant hashes; the
 * value is the one `query node` reported at the expected moment).
 */
function assertRecordedHolds(
  recorded: unknown,
  hash: string,
  what: string,
  context: string,
): void {
  if (collectStringLeaves(recorded).includes(hash)) return;
  fail(
    `${context}: the recorded state must hold ${what} — the value ` +
      `${JSON.stringify(hash)} captured via \`query node\` at that moment ` +
      `(SPEC 10.2, 10.4, 10.7; H-4: opaque shape, spec-fixed values) — but ` +
      `it appears nowhere in ${canonicalJson(recorded)}`,
  );
}

/**
 * The recorded state must NOT hold the given value — the discriminator
 * against records taken (or recomputed) at the wrong moment; the value's
 * distinctness from every legitimately recorded value is asserted as a
 * staging premise before this runs.
 */
function assertRecordedLacks(
  recorded: unknown,
  hash: string,
  what: string,
  context: string,
): void {
  if (!collectStringLeaves(recorded).includes(hash)) return;
  fail(
    `${context}: the recorded state must not hold ${what} — the value ` +
      `${JSON.stringify(hash)} belongs to a different moment than the one ` +
      `the record was written at (SPEC 10.2, 10.4: resolve records the ` +
      `current relevant state; reads report the recorded state) — but it ` +
      `appears in ${canonicalJson(recorded)}`,
  );
}

/** Staging premise: the listed values are pairwise distinct (diagnosed). */
function assertPairwiseDistinct(
  values: readonly (readonly [string, string])[],
  context: string,
): void {
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      if (values[i][1] === values[j][1]) {
        fail(
          `${context}: staging premise — ${values[i][0]} and ${values[j][0]} ` +
            `must be distinct values for the discrimination to be ` +
            `meaningful; both are ${JSON.stringify(values[i][1])}`,
        );
      }
    }
  }
}

/**
 * The {scope, context, origin} payload projection of an item, with context
 * and origin sorted by node identity — the "same self-contained text payload"
 * SPEC 10.7 fixes across `next --json`, `show`, and `export` (membership and
 * per-node content; entry order within the lists is shape territory, H-3).
 */
function payloadProjection(item: ReviewItem): unknown {
  const state = (node: {
    readonly node: string;
    readonly present: boolean;
    readonly text?: string;
    readonly sourceRange?: SourceRange;
  }): unknown => ({
    node: node.node,
    present: node.present,
    text: node.text,
    sourceRange: node.sourceRange,
  });
  return {
    scope: state(item.scope),
    context: [...item.context]
      .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
      .map(state),
    origin: [...item.origin]
      .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
      .map((entry) => ({
        node: entry.node,
        before: entry.before,
        after: entry.after,
      })),
  };
}

/** What a present payload node must present (SPEC 10.7, 1.6, 1.7). */
interface PresentStateExpectation {
  readonly node: string;
  /** The exact expected text; `undefined` = the node must carry no text. */
  readonly text: string | undefined;
  /** The exact expected range; `undefined` = the node must carry no range. */
  readonly sourceRange: SourceRange | undefined;
}

/** Assert a payload node state presents a present node exactly. */
function assertPresentState(
  state: {
    readonly node: string;
    readonly present: boolean;
    readonly text?: string;
    readonly sourceRange?: SourceRange;
  },
  expected: PresentStateExpectation,
  context: string,
): void {
  if (state.node !== expected.node || !state.present) {
    fail(
      `${context}: expected the present node ${expected.node} under its ` +
        `current identity (SPEC 10.4, 10.7); got ` +
        `{node: ${JSON.stringify(state.node)}, present: ${String(state.present)}}`,
    );
  }
  if (expected.text === undefined) {
    if (state.text !== undefined) {
      fail(
        `${context}: ${expected.node} must carry no text value — a code ` +
          `location has none (SPEC 10.7); got ${JSON.stringify(state.text)}`,
      );
    }
  } else if (state.text !== expected.text) {
    fail(
      `${context}: ${expected.node}'s payload text must be byte-equal to ` +
        `the spec-fixed value (SPEC 10.7, 1.6)\n` +
        `  actual:   ${JSON.stringify(state.text)}\n` +
        `  expected: ${JSON.stringify(expected.text)}`,
    );
  }
  if (expected.sourceRange === undefined) {
    if (state.sourceRange !== undefined) {
      fail(
        `${context}: ${expected.node} must carry no source range — a code ` +
          `location's identity already locates it (SPEC 10.7, 1.7); got ` +
          JSON.stringify(state.sourceRange),
      );
    }
  } else {
    assertSameJson(
      state.sourceRange,
      expected.sourceRange,
      `${context}: ${expected.node}'s source range (SPEC 10.7, 1.7 — a ` +
        `present requirement node enters the payload with its source range)`,
    );
  }
}

/** Assert a payload node state presents an absent node exactly. */
function assertAbsentState(
  state: {
    readonly node: string;
    readonly present: boolean;
    readonly text?: string;
    readonly sourceRange?: SourceRange;
  },
  expected: {
    readonly node: string;
    /** The exact provenance text; `undefined` = must carry no text. */
    readonly text: string | undefined;
  },
  context: string,
): void {
  if (state.node !== expected.node || state.present) {
    fail(
      `${context}: expected the absent node ${expected.node} presented under ` +
        `its identity with present: false (SPEC 10.4, 10.7); got ` +
        `{node: ${JSON.stringify(state.node)}, present: ${String(state.present)}}`,
    );
  }
  if (state.sourceRange !== undefined) {
    fail(
      `${context}: an absent node has no current source, so it is presented ` +
        `without a source range (SPEC 10.7, 1.7); got ` +
        JSON.stringify(state.sourceRange),
    );
  }
  if (expected.text === undefined) {
    if (state.text !== undefined) {
      fail(
        `${context}: ${expected.node} is contained in no recorded state, so ` +
          `it is presented with no text (SPEC 10.7); got ` +
          JSON.stringify(state.text),
      );
    }
  } else if (state.text !== expected.text) {
    fail(
      `${context}: the absent node ${expected.node} presents its text from ` +
        `the most recent graph state containing it, among the item's ` +
        `baseline state and the states under which mutating subcommands ` +
        `derived the item (SPEC 10.7)\n` +
        `  actual:   ${JSON.stringify(state.text)}\n` +
        `  expected: ${JSON.stringify(expected.text)}`,
    );
  }
}

/** The unique context entry for a node identity, diagnosed when absent. */
function requireContextEntry(
  item: ReviewItem,
  node: string,
  context: string,
): ReviewItem["context"][number] {
  const matches = item.context.filter((state) => state.node === node);
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one context entry for ${node} ` +
        `(SPEC 10.7: every context node enters the payload once); found ` +
        `${String(matches.length)} among ${JSON.stringify(identitySet(item.context))}`,
    );
  }
  return matches[0];
}

/** The unique origin entry for a node identity, diagnosed when absent. */
function requireOriginEntry(
  item: ReviewItem,
  node: string,
  context: string,
): OriginEntry {
  const matches = item.origin.filter((entry) => entry.node === node);
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one origin entry for ${node} ` +
        `(SPEC 10.7: every origin node enters the payload once); found ` +
        `${String(matches.length)} among ${JSON.stringify(identitySet(item.origin))}`,
    );
  }
  return matches[0];
}

/** What one side of an origin before/after pair must present (SPEC 10.7). */
type OriginSideExpectation =
  | { readonly present: false }
  | { readonly present: true; readonly text: string };

/** Assert an origin entry's before/after pair exactly (SPEC 10.7). */
function assertOriginPair(
  entry: OriginEntry,
  expected: {
    readonly before: OriginSideExpectation;
    readonly after: OriginSideExpectation;
  },
  context: string,
): void {
  for (const [label, side, want] of [
    ["before", entry.before, expected.before],
    ["after", entry.after, expected.after],
  ] as const) {
    if (!want.present) {
      if (side.present) {
        fail(
          `${context}: the ${label} side of ${entry.node}'s origin pair is ` +
            `the absent side — presented absent, with no text (SPEC 10.7); ` +
            `got ${JSON.stringify(side)}`,
        );
      }
      continue;
    }
    if (!side.present) {
      fail(
        `${context}: the ${label} side of ${entry.node}'s origin pair must ` +
          `be present with the node's own text (SPEC 10.7); got the absent side`,
      );
    }
    if (side.text !== want.text) {
      fail(
        `${context}: the ${label} side of ${entry.node}'s origin pair — ` +
          `own text ${label === "before" ? "from the item's baseline state" : "from the current graph"} ` +
          `(SPEC 10.7, 1.6)\n` +
          `  actual:   ${JSON.stringify(side.text)}\n` +
          `  expected: ${JSON.stringify(want.text)}`,
      );
    }
  }
}

/**
 * Walk a session to completion via `next --json` + `resolve --status
 * no-change` (which never re-derives, SPEC 10.5): every item of `reference`
 * must be returned by `next` exactly once, presenting the identical
 * {scope, context, origin} payload projection as the reference read (one
 * payload rule, SPEC 10.7), and the walk must end fully resolved.
 */
async function walkNextAgainstReference(
  product: ProductBinding,
  workspace: TestWorkspace,
  session: string,
  reference: readonly ReviewItem[],
  context: string,
): Promise<void> {
  const remaining = new Set(reference.map((item) => item.id));
  for (let step = 1; step <= reference.length + 1; step += 1) {
    const label = `${context}, walk step ${String(step)}`;
    const next = await nextInSession(product, workspace, session, label);
    if (next.fullyResolved) {
      if (remaining.size > 0) {
        fail(
          `${label}: \`next\` reports the session fully resolved while ` +
            `these needing-review items were never returned: ` +
            `${JSON.stringify([...remaining].sort())} (SPEC 10.7: next ` +
            `returns the first needing-review unblocked item until none ` +
            `qualifies)`,
        );
      }
      return;
    }
    const item = requireNextItem(next, label);
    if (!remaining.has(item.id)) {
      fail(
        `${label}: \`next\` returned item ${item.id}, which is not among ` +
          `the session's still-unresolved items ` +
          `${JSON.stringify([...remaining].sort())} — either an unknown id ` +
          `or an item returned twice (SPEC 10.7)`,
      );
    }
    remaining.delete(item.id);
    assertSameInformation(
      payloadProjection(item),
      payloadProjection(requireItemById(reference, item.id, label)),
      `${label}: item ${item.id}'s \`next --json\` payload — scope, context, ` +
        `and origin nodes with their texts, presence, and source ranges — ` +
        `is identical to the reference read's (SPEC 10.7: \`show\` and ` +
        `\`export\` carry the same self-contained text payload as ` +
        `\`next --json\`)`,
    );
    await resolveOk(
      product,
      workspace,
      session,
      item.id,
      "no-change",
      `${label} \`review resolve ${session} ${item.id} --status no-change\``,
    );
  }
  fail(
    `${context}: after resolving every item, \`next\` must report the ` +
      `session fully resolved (SPEC 10.7)`,
  );
}

// ---------------------------------------------------------------------------
// T10.7-7 — next
// ---------------------------------------------------------------------------

const N7_FILE = "specs/T.mdx";
const N7_P = "specs/T.mdx#p";
const N7_PA = "specs/T.mdx#p.a";
const N7_PB = "specs/T.mdx#p.b";

const N7_SOURCE = [
  '<S id="p">',
  "Pee own line.",
  "",
  '<S id="p.a">',
  "Paa line.",
  "</S>",
  "",
  '<S id="p.b">',
  "Pab line.",
  "</S>",
  "</S>",
  "",
].join("\n");

const N7_PB_FILE = "specs/A2.mdx";
const N7_PB_ROOT = "specs/A2.mdx";
const N7_A = "specs/A2.mdx#a";
const N7_AK = "specs/A2.mdx#a.k";

function n7PbSpec(kidText: string): string {
  return [
    '<S id="a">',
    "Parent alpha line.",
    "",
    '<S id="a.k">',
    kidText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

/**
 * `review next <name>` (human form) reporting the session fully resolved:
 * exit 0 and stdout mentioning resolution (H-3: information presence — the
 * /resolv/i operationalization from the module header).
 */
async function expectFullyResolvedBothForms(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<void> {
  const human = await expectExit(
    product,
    workspace,
    ["review", "next", name],
    0,
    `${context} \`review next ${name}\` (human form) — a fully resolved ` +
      `session exits 0 (SPEC 10.7)`,
  );
  assertReportMentions(
    human,
    [/resolv/i],
    `${context} \`review next ${name}\` (human form) — the report states ` +
      `the session is fully resolved (SPEC 10.7; information presence, ` +
      `never exact wording, H-3)`,
  );
  const next = await nextInSession(product, workspace, name, context);
  if (!next.fullyResolved) {
    fail(
      `${context} \`review next ${name} --json\`: every item is resolved, ` +
        `so the JSON form reports fully resolved with no item in the ` +
        `payload (SPEC 10.7); the product returned an item`,
    );
  }
  // The adapter itself refuses a document that claims fullyResolved while
  // carrying an item, so reaching here pins "no item in the JSON payload".
}

const T10_7_7 = defineProductTest({
  id: "T10.7-7",
  title:
    "`review next`: returns the first needing-review unblocked item in item order — in an audit session with blocked root and parent items it returns the first leaf, then the second, then moves backward in item order to the meanwhile-unblocked parent and root; when all items are resolved, and for a session with no items, it exits 0 and reports fully resolved in the human and `--json` forms with no item in the JSON payload; the `--json` payload is self-contained — scope text, context texts, origin before/after texts, source ranges for present requirement nodes, and the recorded `baseline` and `current` hashes (asserted against distinct `query node` captures at the baseline and creation moments) (SPEC 10.2, 10.3, 10.4, 10.6, 10.7)",
  timeoutMs: 360_000,
  run: async (product) => {
    // --- arm 1: order walking and the fully-resolved report -----------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [N7_FILE]: N7_SOURCE },
      async (workspace) => {
        const prefix = "T10.7-7 order arm";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await createAuditSession(product, workspace, "s", prefix);

        // Item order (SPEC 10.6): root, p, p.a, p.b — with the root and p
        // blocked by their children's items, so the first needing-review
        // UNBLOCKED item is p.a's, not the root's (a product ignoring the
        // blocked state fails here).
        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          rowSequence(initial),
          [
            `subtree-coherence ${N7_FILE} unresolved`,
            `subtree-coherence ${N7_P} unresolved`,
            `subtree-coherence ${N7_PA} unresolved`,
            `subtree-coherence ${N7_PB} unresolved`,
          ],
          `${prefix} staging premise: the audit items in item order (SPEC 10.6)`,
        );
        const idRoot = requireRow(
          initial,
          "subtree-coherence",
          N7_FILE,
          prefix,
        ).id;
        const idP = requireRow(initial, "subtree-coherence", N7_P, prefix).id;
        const idPA = requireRow(initial, "subtree-coherence", N7_PA, prefix).id;
        const idPB = requireRow(initial, "subtree-coherence", N7_PB, prefix).id;

        const expectNextId = async (
          expected: string,
          why: string,
        ): Promise<void> => {
          const item = requireNextItem(
            await nextInSession(product, workspace, "s", `${prefix} ${why}`),
            `${prefix} ${why}`,
          );
          if (item.id !== expected) {
            fail(
              `${prefix} ${why}: \`next\` returns the first needing-review ` +
                `unblocked item in item order (SPEC 10.7); expected ` +
                `${expected}, got ${item.id}`,
            );
          }
        };

        await expectNextId(
          idPA,
          "fresh session — the root's and p's items are blocked, so the " +
            "first needing-review unblocked item is p.a's",
        );
        await resolveOk(
          product,
          workspace,
          "s",
          idPA,
          "no-change",
          `${prefix} \`resolve s <p.a's item> --status no-change\``,
        );
        await expectNextId(idPB, "after resolving p.a's item");
        await resolveOk(
          product,
          workspace,
          "s",
          idPB,
          "skipped",
          `${prefix} \`resolve s <p.b's item> --status skipped\``,
        );
        // p's item precedes p.a's and p.b's in item order and just became
        // unblocked: next moves backward in item order — a product scanning
        // forward from the last returned item fails here.
        await expectNextId(
          idP,
          "after resolving both leaves — p's item, earlier in item order, " +
            "is now the first needing-review unblocked item",
        );
        await resolveOk(
          product,
          workspace,
          "s",
          idP,
          "no-change",
          `${prefix} \`resolve s <p's item> --status no-change\``,
        );
        await expectNextId(idRoot, "after resolving p's item");
        await resolveOk(
          product,
          workspace,
          "s",
          idRoot,
          "skipped",
          `${prefix} \`resolve s <root's item> --status skipped\``,
        );

        await expectFullyResolvedBothForms(
          product,
          workspace,
          "s",
          `${prefix}, all items resolved:`,
        );
      },
    );

    // --- arm 2: a session with no items reports fully resolved --------------
    await withWorkspace(SPECS_ONLY_CONFIG, {}, async (workspace) => {
      const prefix = "T10.7-7 empty-session arm";
      // The configured spec group matches no file: a zero-source group is a
      // valid workspace (SPEC 7), and audit derives one item per requirement
      // node — zero nodes, zero items (SPEC 10.6).
      await buildOk(product, workspace, `${prefix} \`build\``);
      await createAuditSession(product, workspace, "s", prefix);
      const status = await sessionStatus(product, workspace, "s", prefix);
      if (status.items.length !== 0) {
        fail(
          `${prefix} staging premise: an audit session over a workspace ` +
            `with no requirement nodes holds no items (SPEC 10.6); got ` +
            JSON.stringify(rowSequence(status)),
        );
      }
      await expectFullyResolvedBothForms(product, workspace, "s", `${prefix}:`);
    });

    // --- arm 3: the self-contained --json payload ----------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [N7_PB_FILE]: n7PbSpec("Kid line v0.") },
      async (workspace) => {
        const prefix = "T10.7-7 payload arm";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await buildOk(product, workspace, `${prefix} \`build\` at v0`);
        const akAtBase = await queryNode(
          product,
          workspace,
          N7_AK,
          `${prefix} baseline capture`,
        );

        await workspace.file(N7_PB_FILE, n7PbSpec("Kid line v1."));
        await buildOk(product, workspace, `${prefix} \`build\` at v1`);
        const akAtCreate = await queryNode(
          product,
          workspace,
          N7_AK,
          `${prefix} creation capture`,
        );
        const aNow = await queryNode(
          product,
          workspace,
          N7_A,
          `${prefix} current capture of a`,
        );
        const rootNow = await queryNode(
          product,
          workspace,
          N7_PB_ROOT,
          `${prefix} current capture of the root`,
        );
        assertPairwiseDistinct(
          [
            ["the v0 subtreeHash of a.k", akAtBase.hashes.subtreeHash],
            ["the v1 subtreeHash of a.k", akAtCreate.hashes.subtreeHash],
            ["a.k's metadataHash", akAtBase.hashes.metadataHash],
          ],
          prefix,
        );
        if (akAtBase.ownText === akAtCreate.ownText) {
          fail(
            `${prefix} staging premise: the a.k edit must change its own ` +
              `text (SPEC 1.6) so the origin pair's sides differ`,
          );
        }

        await createBaseSession(product, workspace, base, "s", prefix);

        // The changed leaf's subtree-coherence item is first in item order
        // (depth-deepest first) and unblocked (SPEC 10.5).
        const item = requireNextItem(
          await nextInSession(product, workspace, "s", prefix),
          prefix,
        );
        if (item.kind !== "subtree-coherence" || item.scope.node !== N7_AK) {
          fail(
            `${prefix}: the first needing-review unblocked item is a.k's ` +
              `subtree-coherence item — deepest first, and the ` +
              `parent-consistency item is blocked (SPEC 10.5, 10.7); got ` +
              `${item.kind} ${item.scope.node}`,
          );
        }

        // Self-contained payload (SPEC 10.7): scope with subtree text and
        // source range; context (the ancestor chain) with own texts and
        // source ranges; origin with the before/after own-text pair; the
        // recorded baseline and current hashes.
        assertPresentState(
          item.scope,
          {
            node: N7_AK,
            text: akAtCreate.subtreeText,
            sourceRange: akAtCreate.sourceRange,
          },
          `${prefix} scope (subtree-coherence scope text is the scope ` +
            `root's subtree text)`,
        );
        assertSameJson(
          identitySet(item.context),
          [N7_A, N7_PB_ROOT].sort(),
          `${prefix}: the context is a.k's ancestor chain (SPEC 10.5)`,
        );
        assertPresentState(
          requireContextEntry(item, N7_A, prefix),
          { node: N7_A, text: aNow.ownText, sourceRange: aNow.sourceRange },
          `${prefix} context entry a (ancestor-chain context carries own text)`,
        );
        assertPresentState(
          requireContextEntry(item, N7_PB_ROOT, prefix),
          {
            node: N7_PB_ROOT,
            text: rootNow.ownText,
            sourceRange: rootNow.sourceRange,
          },
          `${prefix} context entry root (ancestor-chain context carries own text)`,
        );
        assertSameJson(
          identitySet(item.origin),
          [N7_AK],
          `${prefix}: the origin is the changed node (SPEC 10.5)`,
        );
        assertOriginPair(
          requireOriginEntry(item, N7_AK, prefix),
          {
            before: { present: true, text: akAtBase.ownText },
            after: { present: true, text: akAtCreate.ownText },
          },
          `${prefix} origin pair for a.k — before from the item's baseline ` +
            `state, after from the current graph`,
        );
        assertRecordedHolds(
          item.baseline,
          akAtBase.hashes.subtreeHash,
          "the scope node's baseline subtreeHash",
          `${prefix} payload \`baseline\``,
        );
        assertRecordedHolds(
          item.baseline,
          akAtBase.hashes.metadataHash,
          "the scope node's baseline metadataHash",
          `${prefix} payload \`baseline\``,
        );
        assertRecordedLacks(
          item.baseline,
          akAtCreate.hashes.subtreeHash,
          "the creation-time subtreeHash",
          `${prefix} payload \`baseline\``,
        );
        assertRecordedHolds(
          item.current,
          akAtCreate.hashes.subtreeHash,
          "the scope node's creation-time subtreeHash",
          `${prefix} payload \`current\``,
        );
        assertRecordedLacks(
          item.current,
          akAtBase.hashes.subtreeHash,
          "the baseline subtreeHash",
          `${prefix} payload \`current\``,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.7-8 — show/export
// ---------------------------------------------------------------------------

const E8_FILE = "specs/X.mdx";
const E8_X = "specs/X.mdx#x";
const E8_XK = "specs/X.mdx#x.k";

function e8Spec(kidText: string): string {
  return [
    '<S id="x">',
    "Ex own line.",
    "",
    '<S id="x.k">',
    kidText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const T10_7_8 = defineProductTest({
  id: "T10.7-8",
  title:
    "`review show <name> <item-id>` reports the full item — the 10.2 fields plus the identical self-contained text payload as `next --json` (compared whole against the item `next` returns); an unknown item ID, including the id of an item removed by `split`, is exit 2; `review export <name>` emits one JSON document as its only output form — byte-parsed and information-identical with and without `--json` — containing the session's name, strategy, recorded creation parameters, recorded decompositions (holding the split item's scope-node identity), and every item in item order with its fields, blocked state, payload, and read-time invalidation applied (a stored `no-change` under an edited scope exports as `invalidated`, re-blocking its dependents) (SPEC 10.2, 10.4, 10.6, 10.7, 12.0)",
  timeoutMs: 360_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [E8_FILE]: e8Spec("Kay line v0.") },
      async (workspace) => {
        const prefix = "T10.7-8";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await createAuditSession(product, workspace, "s", prefix);

        // `show` = the full item with the same payload as `next --json`:
        // compare the item `next` returns against `show` of the same id,
        // whole (same read state, nothing mutated between).
        const nextItem = requireNextItem(
          await nextInSession(product, workspace, "s", prefix),
          prefix,
        );
        if (nextItem.scope.node !== E8_XK) {
          fail(
            `${prefix}: the first needing-review unblocked item in audit ` +
              `order is x.k's — the root's and x's items are blocked ` +
              `(SPEC 10.3, 10.6); got ${nextItem.scope.node}`,
          );
        }
        const shown = await showItem(
          product,
          workspace,
          "s",
          nextItem.id,
          prefix,
        );
        assertSameInformation(
          shown,
          nextItem,
          `${prefix}: \`show <name> <item-id>\` reports the full item — ` +
            `every 10.2 field plus the same self-contained text payload as ` +
            `\`next --json\` (SPEC 10.7)`,
        );

        // Stage the decomposition: resolve x.k's item so nothing blocks x's,
        // then split x's item (x has the one child x.k).
        const status = await sessionStatus(product, workspace, "s", prefix);
        const idRoot = requireRow(
          status,
          "subtree-coherence",
          E8_FILE,
          prefix,
        ).id;
        const idX = requireRow(status, "subtree-coherence", E8_X, prefix).id;
        const idXK = requireRow(status, "subtree-coherence", E8_XK, prefix).id;
        await resolveOk(
          product,
          workspace,
          "s",
          idXK,
          "no-change",
          `${prefix} \`resolve s <x.k's item> --status no-change\``,
        );
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", idX],
          0,
          `${prefix} \`review split s <x's item>\``,
        );

        // Export, with and without --json: one JSON document either way,
        // carrying the same information (SPEC 10.7: export's only output
        // form).
        const exportJsonLabel = `${prefix} \`review export s --json\``;
        const withJson = decodeExportReport(
          await runJson(
            product,
            workspace,
            ["review", "export", "s", "--json"],
            exportJsonLabel,
          ),
          exportJsonLabel,
        );
        const exportBareLabel = `${prefix} \`review export s\` (no --json)`;
        const bareResult = await expectExit(
          product,
          workspace,
          ["review", "export", "s"],
          0,
          exportBareLabel,
        );
        const withoutJson = decodeExportReport(
          parseJsonStdout(bareResult, exportBareLabel),
          exportBareLabel,
        );
        assertSameInformation(
          withoutJson,
          withJson,
          `${prefix}: \`export\` emits one JSON document as its only output ` +
            `form — with or without --json, the same information (SPEC 10.7)`,
        );

        // Name, strategy, and the recorded decomposition (opaque shape;
        // the decomposed item's scope-node identity is a spec-fixed value
        // the record must hold — SPEC 10.7: the decomposition is the
        // original's kind and scope node, replaced by its items).
        if (withJson.name !== "s" || withJson.strategy !== "audit") {
          fail(
            `${prefix}: \`export\` carries the session's name and strategy ` +
              `(SPEC 10, 10.7); got name ${JSON.stringify(withJson.name)}, ` +
              `strategy ${JSON.stringify(withJson.strategy)}`,
          );
        }
        if (!collectStringLeaves(withJson.decompositions).includes(E8_X)) {
          fail(
            `${prefix}: after \`split\` of x's item, the exported recorded ` +
              `decompositions must hold the decomposed item's scope node ` +
              `${JSON.stringify(E8_X)} (SPEC 10.7: the decomposition — the ` +
              `original's kind and scope node, replaced by its items — is ` +
              `recorded durably); it appears nowhere in ` +
              canonicalJson(withJson.decompositions),
          );
        }
        // `creationParameters` presence is enforced by the adapter decode
        // (an audit session records none — the member still exists as an
        // explicit "none"); its content is T10.7-2's business.

        // Item order after the split (SPEC 10.6, 10.7): root, then x's
        // parent-consistency item (scope x precedes x.k in document order),
        // then x.k's reused item.
        assertSameJson(
          exportKindScopeSequence(withJson.items),
          [
            `subtree-coherence ${E8_FILE}`,
            `parent-consistency ${E8_X}`,
            `subtree-coherence ${E8_XK}`,
          ],
          `${prefix}: \`export\` presents every item in item order — the ` +
            `original subtree-coherence item for x is removed, its ` +
            `decomposition's parent-consistency item ordering at x's ` +
            `document position (SPEC 10.6, 10.7)`,
        );
        const pcX = requireItem(
          withJson.items,
          "parent-consistency",
          E8_X,
          prefix,
        );
        if (
          requireItem(withJson.items, "subtree-coherence", E8_XK, prefix).id !==
          idXK
        ) {
          fail(
            `${prefix}: the split reuses x.k's existing item — same id ` +
              `(SPEC 10.7)`,
          );
        }

        // Unknown item IDs are usage errors, exit 2 (SPEC 10.7, 12.0): a
        // never-existing id, and the split-removed original's id.
        for (const [unknownId, why] of [
          ["no-such-item", "a never-existing item id"],
          [idX, "the id of the item `split` removed from the session"],
        ] as const) {
          const context = `${prefix} \`review show s ${unknownId} --json\` (${why})`;
          const result = await expectExit(
            product,
            workspace,
            ["review", "show", "s", unknownId, "--json"],
            2,
            `${context} — an unknown item ID in a review command's ` +
              `arguments is a usage error (SPEC 10.7, 12.0)`,
          );
          assertStdoutEmpty(
            result,
            `${context} — under --json, stdout is byte-empty on exit 2 ` +
              `(SPEC 12.0, H-5)`,
          );
        }

        // Read-time invalidation applied to export (SPEC 10.4, 10.7): edit
        // x.k so its stored no-change goes stale — the exported item reads
        // invalidated and re-blocks its dependents, without rewriting the
        // stored status (list-side counting is T10.7-5's business).
        await workspace.file(E8_FILE, e8Spec("Kay line v1."));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the x.k edit`,
        );
        const stale = await exportSession(product, workspace, "s", prefix);
        assertSameJson(
          stale.items.map((item) => ({
            kind: item.kind,
            scope: item.scope.node,
            status: item.status,
            blocked: item.blocked,
          })),
          [
            {
              kind: "subtree-coherence",
              scope: E8_FILE,
              status: "unresolved",
              blocked: true,
            },
            {
              kind: "parent-consistency",
              scope: E8_X,
              status: "unresolved",
              blocked: true,
            },
            {
              kind: "subtree-coherence",
              scope: E8_XK,
              status: "invalidated",
              blocked: false,
            },
          ],
          `${prefix} after the x.k edit: \`export\` applies read-time ` +
            `invalidation — the stale no-change reads invalidated and, not ` +
            `being a resolved status, re-blocks x's parent-consistency item ` +
            `and through it the root's (SPEC 10.3, 10.4, 10.7)`,
        );
        // The dependents' blockedBy pins why they are blocked: the root's
        // item was blocked by the original and is now blocked by all items
        // of its decomposition (T10.7-9 asserts this in depth).
        assertBlockedBy(
          requireItemById(stale.items, idRoot, prefix),
          [pcX.id, idXK],
          `${prefix}: the root's item, previously blocked by the original, ` +
            `is blocked by all items of the decomposition (SPEC 10.7)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.7-9 — split
// ---------------------------------------------------------------------------

// Path-blocks arm: g.a (child of g, with children g.a.x and g.a.y) is the
// changed node; its subtree-coherence item is resolved, then split.
const S9_FILE = "specs/G.mdx";
const S9_G = "specs/G.mdx#g";
const S9_GA = "specs/G.mdx#g.a";
const S9_GAX = "specs/G.mdx#g.a.x";
const S9_GAY = "specs/G.mdx#g.a.y";
const S9_GAZ = "specs/G.mdx#g.a.z";

function s9Spec(gaOwn: string, withZ: boolean): string {
  const zLines = withZ ? ["", '<S id="g.a.z">', "Gaz line.", "</S>"] : [];
  return [
    '<S id="g">',
    "Gee own line.",
    "",
    '<S id="g.a">',
    gaOwn,
    "",
    '<S id="g.a.x">',
    "Gax line.",
    "</S>",
    "",
    '<S id="g.a.y">',
    "Gay line.",
    "</S>",
    ...zLines,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

// Audit arm: h with child h.a; h.b and h.c are authored later.
const S9_H_FILE = "specs/H.mdx";
const S9_H = "specs/H.mdx#h";
const S9_HA = "specs/H.mdx#h.a";
const S9_HB = "specs/H.mdx#h.b";
const S9_HC = "specs/H.mdx#h.c";

function s9HSpec(withB: boolean, withC: boolean): string {
  const b = withB ? ["", '<S id="h.b">', "Habe line.", "</S>"] : [];
  const c = withC ? ["", '<S id="h.c">', "Hace line.", "</S>"] : [];
  return [
    '<S id="h">',
    "Aitch own line.",
    "",
    '<S id="h.a">',
    "Haa line.",
    "</S>",
    ...b,
    ...c,
    "</S>",
    "",
  ].join("\n");
}

const T10_7_9 = defineProductTest({
  id: "T10.7-9",
  title:
    "`review split` of a `subtree-coherence` item whose scope root has children replaces it with one `subtree-coherence` item per child subtree (context: the child's ancestor chain; in a path-blocks session, origin: the originating nodes within scope and context) plus one `parent-consistency` item for the scope root (context: the child subtrees; blockedBy: the child items); newly created decomposition items enter `unresolved` — asserted on splits of resolved originals in both a path-blocks and an audit session, whose statuses must not propagate — and inherit the original's blockedBy (discriminated in the audit arm by a child authored after `create`, whose new item inherits the original's stale blocker set); existing kind+scope items are reused with id, status, and recorded state kept (audit case); every item blocked by the original becomes blocked by all decomposition items; the original is removed, its id never reused across subsequent re-derivations in either strategy, and the recorded decomposition governs re-derivation — a decomposed kind+scope is never re-added, a later-authored child enters through the decomposition with a fresh id, and inherited blockers are dropped when blockedBy is recomputed; `split` on any other kind, or on a childless scope root, is refused (exit 1) leaving the session's rows unchanged (SPEC 10.2, 10.5, 10.6, 10.7)",
  timeoutMs: 480_000,
  run: async (product) => {
    // --- path-blocks arm ------------------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [S9_FILE]: s9Spec("Gaa own v0.", false) },
      async (workspace) => {
        const prefix = "T10.7-9 path-blocks arm";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(S9_FILE, s9Spec("Gaa own v1.", false));
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await createBaseSession(product, workspace, base, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          rowSequence(initial),
          [
            `subtree-coherence ${S9_GA} unresolved`,
            `parent-consistency ${S9_G} unresolved`,
          ],
          `${prefix} staging premise: g.a's edit yields its ` +
            `subtree-coherence item and g's parent-consistency item ` +
            `(SPEC 10.5)`,
        );
        const scGA = requireRow(initial, "subtree-coherence", S9_GA, prefix).id;
        const pcG = requireRow(initial, "parent-consistency", S9_G, prefix).id;

        // Refusals first (SPEC 10.7): split on a parent-consistency item,
        // exit 1; the session's rows are unchanged by the refusal.
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", pcG],
          1,
          `${prefix} \`review split s <g's parent-consistency item>\` — ` +
            `split on an item of any other kind is refused (SPEC 10.7)`,
        );
        assertSameJson(
          rowSequence(await sessionStatus(product, workspace, "s", prefix)),
          rowSequence(initial),
          `${prefix}: a refused split changes nothing about the session ` +
            `(SPEC 10.7)`,
        );

        // Resolve the original, then split it: the decomposition items must
        // enter unresolved — the original's resolved status must not
        // propagate (SPEC 10.2, 10.7).
        await resolveOk(
          product,
          workspace,
          "s",
          scGA,
          "no-change",
          `${prefix} \`resolve s <g.a's item> --status no-change\``,
        );
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", scGA],
          0,
          `${prefix} \`review split s <g.a's resolved item>\``,
        );

        const afterSplit = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          [...rowSequence(afterSplit)].sort(),
          [
            `parent-consistency ${S9_G} unresolved`,
            `parent-consistency ${S9_GA} unresolved`,
            `subtree-coherence ${S9_GAX} unresolved`,
            `subtree-coherence ${S9_GAY} unresolved`,
          ].sort(),
          `${prefix} after the split: one subtree-coherence item per child ` +
            `subtree plus g.a's parent-consistency item, every ` +
            `decomposition item created unresolved (the original's ` +
            `no-change must not propagate), and the original removed ` +
            `(SPEC 10.2, 10.7)`,
        );
        const scX = requireRow(
          afterSplit,
          "subtree-coherence",
          S9_GAX,
          prefix,
        ).id;
        const scY = requireRow(
          afterSplit,
          "subtree-coherence",
          S9_GAY,
          prefix,
        ).id;
        const pcGA = requireRow(
          afterSplit,
          "parent-consistency",
          S9_GA,
          prefix,
        ).id;
        for (const [id, what] of [
          [scX, "g.a.x's new item"],
          [scY, "g.a.y's new item"],
          [pcGA, "g.a's new parent-consistency item"],
        ] as const) {
          if (id === scGA || id === pcG) {
            fail(
              `${prefix}: ${what} takes a fresh id — the removed original's ` +
                `id is never reused (SPEC 10.7); got ${id}`,
            );
          }
        }

        const exported = await exportSession(product, workspace, "s", prefix);
        // Decomposition fields (SPEC 10.7): per-child context is the child's
        // ancestor chain; the parent-consistency item's context is the child
        // subtrees and its blockedBy the child items; origin is the
        // originating nodes within scope and context — g.a, the session's
        // one changed node, lies in each child's ancestor chain and in the
        // parent-consistency item's scope.
        const xItem = requireItem(
          exported.items,
          "subtree-coherence",
          S9_GAX,
          prefix,
        );
        const yItem = requireItem(
          exported.items,
          "subtree-coherence",
          S9_GAY,
          prefix,
        );
        const pcGAItem = requireItem(
          exported.items,
          "parent-consistency",
          S9_GA,
          prefix,
        );
        assertSameJson(
          identitySet(xItem.context),
          [S9_FILE, S9_G, S9_GA].sort(),
          `${prefix}: g.a.x's decomposition item's context is the child's ` +
            `ancestor chain (SPEC 10.7)`,
        );
        assertSameJson(
          identitySet(yItem.context),
          [S9_FILE, S9_G, S9_GA].sort(),
          `${prefix}: g.a.y's decomposition item's context is the child's ` +
            `ancestor chain (SPEC 10.7)`,
        );
        assertSameJson(
          identitySet(pcGAItem.context),
          [S9_GAX, S9_GAY].sort(),
          `${prefix}: the scope root's parent-consistency item's context is ` +
            `the child subtrees (SPEC 10.7)`,
        );
        assertBlockedBy(
          pcGAItem,
          [scX, scY],
          `${prefix}: the scope root's parent-consistency item is blocked ` +
            `by the child items (the original's blockedBy was empty, so ` +
            `inheritance adds nothing here — the audit arm discriminates it)`,
        );
        for (const [item, what] of [
          [xItem, "g.a.x's"],
          [yItem, "g.a.y's"],
          [pcGAItem, "g.a's parent-consistency"],
        ] as const) {
          assertSameJson(
            identitySet(item.origin),
            [S9_GA],
            `${prefix}: ${what} decomposition item's origin is the ` +
              `originating nodes within its scope and context — the changed ` +
              `g.a (SPEC 5.6, 10.7)`,
          );
        }
        // Every item blocked by the original becomes blocked by all
        // decomposition items (SPEC 10.7).
        assertBlockedBy(
          requireItem(exported.items, "parent-consistency", S9_G, prefix),
          [scX, scY, pcGA],
          `${prefix}: g's parent-consistency item — blocked by the original ` +
            `— becomes blocked by all items of the decomposition (SPEC 10.7)`,
        );

        // The childless refusal: g.a.x's item is subtree-coherence with a
        // childless scope root — split refused, exit 1, rows unchanged.
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", scX],
          1,
          `${prefix} \`review split s <g.a.x's item>\` — split on a ` +
            `subtree-coherence item whose scope root has no children is ` +
            `refused (SPEC 10.7)`,
        );
        assertSameJson(
          rowSequence(await sessionStatus(product, workspace, "s", prefix)),
          rowSequence(afterSplit),
          `${prefix}: the refused childless split changes nothing (SPEC 10.7)`,
        );

        // The decomposition governs re-derivation and the removed id is
        // never reused (SPEC 10.5, 10.7): author g.a.z, then resolve
        // `updated` — z's item enters through the decomposition (one item
        // per current child subtree) with a fresh id; no subtree-coherence
        // item for g.a is re-added.
        await workspace.file(S9_FILE, s9Spec("Gaa own v1.", true));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after authoring g.a.z`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          scX,
          "updated",
          `${prefix} \`resolve s <g.a.x's item> --status updated\` — ` +
            `triggers re-derivation (SPEC 10.5)`,
        );
        const derived = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          derived.items.map((row) => `${row.kind} ${row.scope}`).sort(),
          [
            `parent-consistency ${S9_G}`,
            `parent-consistency ${S9_GA}`,
            `subtree-coherence ${S9_GAX}`,
            `subtree-coherence ${S9_GAY}`,
            `subtree-coherence ${S9_GAZ}`,
          ].sort(),
          `${prefix} after the re-derivation: the decomposed ` +
            `subtree-coherence item for g.a is never re-added — its ` +
            `decomposition applies over the current child subtrees, so ` +
            `g.a.z's item enters (SPEC 10.5, 10.7)`,
        );
        const scZ = requireRow(derived, "subtree-coherence", S9_GAZ, prefix);
        const priorIds = [scGA, pcG, scX, scY, pcGA];
        if (priorIds.includes(scZ.id)) {
          fail(
            `${prefix}: g.a.z's item takes a fresh id — the removed ` +
              `original's id (and every live id) is never reused ` +
              `(SPEC 10.7); got ${scZ.id}`,
          );
        }
        if (scZ.status !== "unresolved") {
          fail(
            `${prefix}: g.a.z's item is created unresolved (SPEC 10.2); ` +
              `got ${scZ.status}`,
          );
        }
        for (const [id, scope, kind] of [
          [scX, S9_GAX, "subtree-coherence"],
          [scY, S9_GAY, "subtree-coherence"],
          [pcGA, S9_GA, "parent-consistency"],
          [pcG, S9_G, "parent-consistency"],
        ] as const) {
          if (requireRow(derived, kind, scope, prefix).id !== id) {
            fail(
              `${prefix}: the matched ${kind} item at ${scope} keeps its id ` +
                `across the re-derivation (SPEC 10.5)`,
            );
          }
        }
        const derivedExport = await exportSession(
          product,
          workspace,
          "s",
          prefix,
        );
        assertBlockedBy(
          requireItem(derivedExport.items, "parent-consistency", S9_GA, prefix),
          [scX, scY, scZ.id],
          `${prefix} after the re-derivation: g.a's parent-consistency item ` +
            `is blocked by the current child items (SPEC 10.5, 10.7)`,
        );
        assertBlockedBy(
          requireItem(derivedExport.items, "parent-consistency", S9_G, prefix),
          [scX, scY, scZ.id, pcGA],
          `${prefix} after the re-derivation: the reference to g.a's ` +
            `decomposed item in g's blockedBy is replaced by all items of ` +
            `its decomposition (SPEC 10.5, 10.7)`,
        );
      },
    );

    // --- audit arm ------------------------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [S9_H_FILE]: s9HSpec(false, false) },
      async (workspace) => {
        const prefix = "T10.7-9 audit arm";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await createAuditSession(product, workspace, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          rowSequence(initial),
          [
            `subtree-coherence ${S9_H_FILE} unresolved`,
            `subtree-coherence ${S9_H} unresolved`,
            `subtree-coherence ${S9_HA} unresolved`,
          ],
          `${prefix} staging premise: the audit items (SPEC 10.6)`,
        );
        const idRoot = requireRow(
          initial,
          "subtree-coherence",
          S9_H_FILE,
          prefix,
        ).id;
        const idH = requireRow(initial, "subtree-coherence", S9_H, prefix).id;
        const idHA = requireRow(initial, "subtree-coherence", S9_HA, prefix).id;

        // Resolve h.a's item, then h's (so a RESOLVED original is split),
        // and capture h.a's recorded state for the reuse assertion.
        await resolveOk(
          product,
          workspace,
          "s",
          idHA,
          "no-change",
          `${prefix} \`resolve s <h.a's item> --status no-change\``,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          idH,
          "no-change",
          `${prefix} \`resolve s <h's item> --status no-change\``,
        );
        const haBefore = await showItem(product, workspace, "s", idHA, prefix);

        // Author h.b after create: no re-derivation, so no item exists for
        // it and h's item's blockedBy still names only h.a's item — the
        // discriminating stale blocker set the split's inheritance rule is
        // asserted against.
        await workspace.file(S9_H_FILE, s9HSpec(true, false));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after authoring h.b`,
        );
        assertSameJson(
          rowSequence(await sessionStatus(product, workspace, "s", prefix))
            .map((row) => row.split(" ").slice(0, 2).join(" "))
            .sort(),
          [
            `subtree-coherence ${S9_H_FILE}`,
            `subtree-coherence ${S9_H}`,
            `subtree-coherence ${S9_HA}`,
          ].sort(),
          `${prefix} staging premise: authoring h.b alone adds no item — ` +
            `new items enter only through re-derivation or split ` +
            `(SPEC 10.5, 10.7)`,
        );

        // Split h's resolved item: one item per CURRENT child subtree —
        // h.a's existing item is reused (id, status, recorded state kept),
        // h.b's is newly created (unresolved, inheriting the original's
        // blockedBy [h.a's item]) — plus h's parent-consistency item
        // (blockedBy: the child items; origin empty in audit).
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", idH],
          0,
          `${prefix} \`review split s <h's resolved item>\``,
        );
        const afterSplit = await exportSession(product, workspace, "s", prefix);
        assertSameJson(
          [...exportKindScopeSequence(afterSplit.items)].sort(),
          [
            `parent-consistency ${S9_H}`,
            `subtree-coherence ${S9_H_FILE}`,
            `subtree-coherence ${S9_HA}`,
            `subtree-coherence ${S9_HB}`,
          ].sort(),
          `${prefix} after the split: the original is removed; one ` +
            `subtree-coherence item per current child subtree plus h's ` +
            `parent-consistency item (SPEC 10.7)`,
        );
        const haAfter = requireItem(
          afterSplit.items,
          "subtree-coherence",
          S9_HA,
          prefix,
        );
        if (haAfter.id !== idHA || haAfter.status !== "no-change") {
          fail(
            `${prefix}: h.a's existing item is reused by the split — id and ` +
              `status kept (SPEC 10.7); got id ${haAfter.id}, status ` +
              `${haAfter.status}`,
          );
        }
        assertSameInformation(
          haAfter.current,
          haBefore.current,
          `${prefix}: the reused item's recorded state is kept across the ` +
            `split (SPEC 10.7)`,
        );
        const hbItem = requireItem(
          afterSplit.items,
          "subtree-coherence",
          S9_HB,
          prefix,
        );
        if (hbItem.status !== "unresolved") {
          fail(
            `${prefix}: h.b's newly created decomposition item enters ` +
              `unresolved — the original's no-change must not propagate ` +
              `(SPEC 10.2, 10.7); got ${hbItem.status}`,
          );
        }
        if (hbItem.id === idH || hbItem.id === idRoot || hbItem.id === idHA) {
          fail(
            `${prefix}: h.b's item takes a fresh id (SPEC 10.2, 10.7); got ` +
              hbItem.id,
          );
        }
        assertBlockedBy(
          hbItem,
          [idHA],
          `${prefix}: h.b's newly created decomposition item inherits the ` +
            `original's blockedBy — h.a's item, the original's stale ` +
            `blocker set from before h.b existed (SPEC 10.7; a product not ` +
            `inheriting reports an empty blockedBy here)`,
        );
        const pcH = requireItem(
          afterSplit.items,
          "parent-consistency",
          S9_H,
          prefix,
        );
        assertSameJson(
          identitySet(pcH.context),
          [S9_HA, S9_HB].sort(),
          `${prefix}: h's parent-consistency item's context is the child ` +
            `subtrees (SPEC 10.7)`,
        );
        assertBlockedBy(
          pcH,
          [idHA, hbItem.id],
          `${prefix}: h's parent-consistency item is blocked by the child ` +
            `items (SPEC 10.7)`,
        );
        for (const item of [hbItem, pcH]) {
          assertSameJson(
            identitySet(item.origin),
            [],
            `${prefix}: decomposition items' origin is empty in an audit ` +
              `session (SPEC 10.7)`,
          );
        }
        // Every item blocked by the original becomes blocked by all
        // decomposition items: the root's item.
        assertBlockedBy(
          requireItemById(afterSplit.items, idRoot, prefix),
          [idHA, hbItem.id, pcH.id],
          `${prefix}: the root's item — blocked by the original — becomes ` +
            `blocked by all items of the decomposition (SPEC 10.7)`,
        );

        // Re-derivation in the audit session (SPEC 10.5 holds for every
        // strategy): author h.c, then resolve h.b's item `updated` (it is
        // unblocked: h.a's item is resolved). The decomposed kind+scope for
        // h is never re-added; h.c's item enters with a fresh id; blockedBy
        // is recomputed per the audit rule — h.b's inherited blocker is
        // dropped — with decomposed references replaced by the decomposition.
        await workspace.file(S9_H_FILE, s9HSpec(true, true));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after authoring h.c`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          hbItem.id,
          "updated",
          `${prefix} \`resolve s <h.b's item> --status updated\` — triggers ` +
            `re-derivation (SPEC 10.5)`,
        );
        const derived = await exportSession(product, workspace, "s", prefix);
        assertSameJson(
          exportKindScopeSequence(derived.items),
          [
            `subtree-coherence ${S9_H_FILE}`,
            `parent-consistency ${S9_H}`,
            `subtree-coherence ${S9_HA}`,
            `subtree-coherence ${S9_HB}`,
            `subtree-coherence ${S9_HC}`,
          ],
          `${prefix} after the re-derivation: no subtree-coherence item for ` +
            `h is re-added (its decomposition applies); h.c's item enters ` +
            `at its place in audit item order (SPEC 10.5, 10.6, 10.7)`,
        );
        const hcItem = requireItem(
          derived.items,
          "subtree-coherence",
          S9_HC,
          prefix,
        );
        const auditPriorIds = [idRoot, idH, idHA, hbItem.id, pcH.id];
        if (auditPriorIds.includes(hcItem.id)) {
          fail(
            `${prefix}: h.c's item takes a fresh id — the split-removed ` +
              `original's id is never reused, across re-derivations too ` +
              `(SPEC 10.7); got ${hcItem.id}`,
          );
        }
        if (hcItem.status !== "unresolved") {
          fail(
            `${prefix}: h.c's item is created unresolved — the trigger's ` +
              `updated must not propagate (SPEC 10.2); got ${hcItem.status}`,
          );
        }
        assertBlockedBy(
          requireItemById(derived.items, hbItem.id, prefix),
          [],
          `${prefix} after the re-derivation: blockedBy is recomputed per ` +
            `the audit rule — the childless h.b's item's inherited blocker ` +
            `is dropped (SPEC 10.5, 10.6)`,
        );
        assertBlockedBy(
          requireItemById(derived.items, pcH.id, prefix),
          [idHA, hbItem.id, hcItem.id],
          `${prefix} after the re-derivation: h's parent-consistency item ` +
            `is blocked by the current child items (SPEC 10.5, 10.7)`,
        );
        assertBlockedBy(
          requireItemById(derived.items, idRoot, prefix),
          [idHA, hbItem.id, hcItem.id, pcH.id],
          `${prefix} after the re-derivation: the root's blockedBy — its ` +
            `child section's item — has the decomposed reference replaced ` +
            `by all items of the decomposition (SPEC 10.5, 10.6, 10.7)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.7-10 — resolve
// ---------------------------------------------------------------------------

const R10_FILE = "specs/R.mdx";
const R10_P = "specs/R.mdx#p";
const R10_PA = "specs/R.mdx#p.a";

function r10Spec(paText: string): string {
  return [
    '<S id="p">',
    "Pee own line.",
    "",
    '<S id="p.a">',
    paText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const R10_NOTE = "reviewed; left as-is pending spec sync";

const T10_7_10 = defineProductTest({
  id: "T10.7-10",
  title:
    "`review resolve` sets the status and records the current relevant state — `current` holds the resolve-moment hash captures and, after a re-resolve bracketing an edit, the new moment's values and not the old (pairwise-distinct `query node` captures discriminate); it works on any unblocked item regardless of status: flipping a resolved `no-change` to `skipped` without any edit works, and re-resolving an `invalidated` item works and clears the invalidation; resolving a blocked item is refused (exit 1) leaving the session's rows unchanged; an unknown session name or item ID is exit 2 with byte-empty stdout under `--json`; `--note` text is stored and reported by `show` and `export` (SPEC 10.2, 10.3, 10.4, 10.7, 12.0)",
  timeoutMs: 360_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [R10_FILE]: r10Spec("Paa line v0.") },
      async (workspace) => {
        const prefix = "T10.7-10";
        await buildOk(product, workspace, `${prefix} \`build\` at v0`);
        await createAuditSession(product, workspace, "s", prefix);
        const v0 = await queryNode(
          product,
          workspace,
          R10_PA,
          `${prefix} v0 capture`,
        );

        const initial = await sessionStatus(product, workspace, "s", prefix);
        const idP = requireRow(initial, "subtree-coherence", R10_P, prefix).id;
        const idPA = requireRow(
          initial,
          "subtree-coherence",
          R10_PA,
          prefix,
        ).id;
        const pRow = requireRow(initial, "subtree-coherence", R10_P, prefix);
        if (!pRow.blocked) {
          fail(
            `${prefix} staging premise: p's item is blocked by p.a's ` +
              `unresolved item (SPEC 10.3, 10.6)`,
          );
        }

        // Resolving a blocked item is refused: exit 1, rows unchanged.
        await expectExit(
          product,
          workspace,
          ["review", "resolve", "s", idP, "--status", "no-change"],
          1,
          `${prefix} \`review resolve s <p's blocked item> --status ` +
            `no-change\` — resolving a blocked item is refused (SPEC 10.7)`,
        );
        assertSameJson(
          rowSequence(await sessionStatus(product, workspace, "s", prefix)),
          rowSequence(initial),
          `${prefix}: the refused resolve changes nothing about the session ` +
            `(SPEC 10.7)`,
        );

        // Unknown session and unknown item are usage errors (SPEC 10.7,
        // 12.0): exit 2, byte-empty stdout under --json.
        for (const [argv, why] of [
          [
            ["review", "resolve", "nosuch", idPA, "--status", "no-change"],
            "an unknown session name",
          ],
          [
            ["review", "resolve", "s", "no-such-item", "--status", "no-change"],
            "an unknown item ID",
          ],
        ] as const) {
          const context = `${prefix} \`${argv.join(" ")} --json\` (${why})`;
          const result = await expectExit(
            product,
            workspace,
            [...argv, "--json"],
            2,
            `${context} — unknown names in a review command's arguments are ` +
              `usage errors (SPEC 10.7, 12.0)`,
          );
          assertStdoutEmpty(
            result,
            `${context} — under --json, stdout is byte-empty on exit 2 ` +
              `(SPEC 12.0, H-5)`,
          );
        }

        // Resolve with --note: status set, current relevant state recorded
        // (the v0 hashes), note stored and reported by show and export.
        await expectExit(
          product,
          workspace,
          [
            "review",
            "resolve",
            "s",
            idPA,
            "--status",
            "no-change",
            "--note",
            R10_NOTE,
          ],
          0,
          `${prefix} \`review resolve s <p.a's item> --status no-change ` +
            `--note <text>\``,
        );
        const noted = await showItem(product, workspace, "s", idPA, prefix);
        if (noted.status !== "no-change") {
          fail(
            `${prefix}: resolve sets the status (SPEC 10.7); expected ` +
              `no-change, got ${noted.status}`,
          );
        }
        if (noted.note !== R10_NOTE) {
          fail(
            `${prefix}: the --note text is stored and reported (SPEC 10.2, ` +
              `10.7); expected ${JSON.stringify(R10_NOTE)}, got ` +
              JSON.stringify(noted.note),
          );
        }
        assertRecordedHolds(
          noted.current,
          v0.hashes.subtreeHash,
          "the resolve-moment (v0) subtreeHash",
          `${prefix} post-resolve \`current\``,
        );
        assertRecordedHolds(
          noted.current,
          v0.hashes.metadataHash,
          "the scope node's metadataHash",
          `${prefix} post-resolve \`current\``,
        );
        const exportedNote = requireItemById(
          (await exportSession(product, workspace, "s", prefix)).items,
          idPA,
          prefix,
        ).note;
        if (exportedNote !== R10_NOTE) {
          fail(
            `${prefix}: \`export\` reports the stored note too (SPEC 10.2, ` +
              `10.7); expected ${JSON.stringify(R10_NOTE)}, got ` +
              JSON.stringify(exportedNote),
          );
        }

        // Flipping a resolved status works — no edit in between: no-change
        // becomes skipped on the same unblocked item.
        await resolveOk(
          product,
          workspace,
          "s",
          idPA,
          "skipped",
          `${prefix} \`review resolve s <p.a's resolved item> --status ` +
            `skipped\` — resolve applies to any unblocked item regardless ` +
            `of status (SPEC 10.7)`,
        );
        if (
          (await showItem(product, workspace, "s", idPA, prefix)).status !==
          "skipped"
        ) {
          fail(
            `${prefix}: flipping a resolved status works — the item now ` +
              `reports skipped (SPEC 10.3, 10.7)`,
          );
        }

        // Invalidate the resolution: edit p.a, with hash premises, then
        // re-resolve the invalidated item — it works like any resolve and
        // records the new current state (v1), clearing the invalidation.
        await workspace.file(R10_FILE, r10Spec("Paa line v1."));
        await buildOk(product, workspace, `${prefix} \`build\` at v1`);
        const v1 = await queryNode(
          product,
          workspace,
          R10_PA,
          `${prefix} v1 capture`,
        );
        assertPairwiseDistinct(
          [
            ["the v0 subtreeHash", v0.hashes.subtreeHash],
            ["the v1 subtreeHash", v1.hashes.subtreeHash],
            ["p.a's metadataHash", v0.hashes.metadataHash],
          ],
          prefix,
        );
        const staleRow = requireRow(
          await sessionStatus(product, workspace, "s", prefix),
          "subtree-coherence",
          R10_PA,
          prefix,
        );
        if (staleRow.status !== "invalidated") {
          fail(
            `${prefix} staging premise: after the edit, p.a's resolved item ` +
              `reads invalidated (SPEC 10.4); got ${staleRow.status}`,
          );
        }
        await resolveOk(
          product,
          workspace,
          "s",
          idPA,
          "no-change",
          `${prefix} \`review resolve s <p.a's invalidated item> --status ` +
            `no-change\` — re-resolving an invalidated item works (SPEC 10.7)`,
        );
        const reResolved = await showItem(
          product,
          workspace,
          "s",
          idPA,
          prefix,
        );
        if (reResolved.status !== "no-change") {
          fail(
            `${prefix}: the re-resolve set the status and recorded the ` +
              `current state, so the item no longer reads invalidated ` +
              `(SPEC 10.4, 10.7); got ${reResolved.status}`,
          );
        }
        assertRecordedHolds(
          reResolved.current,
          v1.hashes.subtreeHash,
          "the re-resolve-moment (v1) subtreeHash",
          `${prefix} post-re-resolve \`current\``,
        );
        assertRecordedLacks(
          reResolved.current,
          v0.hashes.subtreeHash,
          "the previous resolve's (v0) subtreeHash",
          `${prefix} post-re-resolve \`current\``,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.7-11 — coverage re-derivation
// ---------------------------------------------------------------------------

// D.mdx's `src` covers one K.mdx leaf via a direct `d` edge; the edit swaps
// which one. k1 is declared before k2, so the newly uncovered k1's item must
// order BEFORE the retained k2's — document order, not append order.
const C11_D = "specs/D.mdx";
const C11_SRC = "specs/D.mdx#src";
const C11_K = "specs/K.mdx";
const C11_K1 = "specs/K.mdx#k1";
const C11_K2 = "specs/K.mdx#k2";

function c11DSpec(target: "k1" | "k2"): string {
  return [
    'import K from "./K.xspec"',
    "",
    `<S id="src" d={K.${target}}>`,
    "Src line.",
    "</S>",
    "",
  ].join("\n");
}

const C11_K_SOURCE = [
  '<S id="k1">',
  "Kay-one line.",
  "</S>",
  "",
  '<S id="k2">',
  "Kay-two line.",
  "</S>",
  "",
].join("\n");

const T10_7_11 = defineProductTest({
  id: "T10.7-11",
  title:
    "coverage re-derivation: resolving an `uncovered-requirement` item `updated` re-derives with the session's recorded profile against the current workspace — after swapping the one covering `d` edge from k1 to k2, the newly uncovered k1 gains an `uncovered-requirement` item created `unresolved` (the trigger's `updated` does not propagate) at its place in coverage item order (before the retained k2's item — document order, not append order); the meanwhile-covered k2's item is no longer generated and remains in the session with its resolved status and recorded state; the still-generated src item matching an existing kind and scope node keeps its id, status, and recorded state (SPEC 8, 10.2, 10.5, 10.7)",
  timeoutMs: 300_000,
  run: async (product) => {
    await withWorkspace(
      COVERAGE_CONFIG,
      { [C11_D]: c11DSpec("k1"), [C11_K]: C11_K_SOURCE },
      async (workspace) => {
        const prefix = "T10.7-11";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await createCoverageSession(product, workspace, "p", "c", prefix);

        // At create: src (nothing covers it) and k2 are the uncovered
        // required leaves; k1 is covered by src's d edge (SPEC 8, 10.7).
        const initial = await sessionStatus(product, workspace, "c", prefix);
        assertSameJson(
          rowSequence(initial),
          [
            `uncovered-requirement ${C11_SRC} unresolved`,
            `uncovered-requirement ${C11_K2} unresolved`,
          ],
          `${prefix} staging premise: the create-time uncovered required ` +
            `nodes, in coverage item order (SPEC 8, 10.7)`,
        );
        const idSrc = requireRow(
          initial,
          "uncovered-requirement",
          C11_SRC,
          prefix,
        ).id;
        const idK2 = requireRow(
          initial,
          "uncovered-requirement",
          C11_K2,
          prefix,
        ).id;

        // Resolve k2's item so its retention keeps a discriminating status,
        // and capture its recorded state.
        await resolveOk(
          product,
          workspace,
          "c",
          idK2,
          "no-change",
          `${prefix} \`resolve c <k2's item> --status no-change\``,
        );
        const k2Before = await showItem(product, workspace, "c", idK2, prefix);

        // The swap: src's covering edge moves from k1 to k2 — k1 newly
        // uncovered, k2 covered. k2's relevant hashes (its own subtree and
        // metadata hashes, SPEC 10.4) are untouched by an incoming-edge
        // change, so its resolution stands.
        await workspace.file(C11_D, c11DSpec("k2"));
        await buildOk(product, workspace, `${prefix} \`build\` after the swap`);
        const k2Stable = requireRow(
          await sessionStatus(product, workspace, "c", prefix),
          "uncovered-requirement",
          C11_K2,
          prefix,
        );
        if (k2Stable.status !== "no-change") {
          fail(
            `${prefix} staging premise: the d-edge swap must leave k2's ` +
              `resolution standing — an incoming edge changes none of k2's ` +
              `relevant hashes (SPEC 5.5, 10.4); got ${k2Stable.status}`,
          );
        }

        // The updated resolve of src's item re-derives with the recorded
        // profile against the current workspace (SPEC 10.5: every strategy;
        // 10.7).
        await resolveOk(
          product,
          workspace,
          "c",
          idSrc,
          "updated",
          `${prefix} \`resolve c <src's item> --status updated\` — triggers ` +
            `re-derivation (SPEC 10.5, 10.7)`,
        );
        const derived = await sessionStatus(product, workspace, "c", prefix);
        assertSameJson(
          rowSequence(derived),
          [
            `uncovered-requirement ${C11_SRC} updated`,
            `uncovered-requirement ${C11_K1} unresolved`,
            `uncovered-requirement ${C11_K2} no-change`,
          ],
          `${prefix} after the updated resolve: the newly uncovered k1 ` +
            `gains an item, created unresolved (the trigger's updated does ` +
            `not propagate), ordered at its document position before the ` +
            `retained k2's item; the meanwhile-covered k2's item is no ` +
            `longer generated and remains with its status; src's matching ` +
            `item keeps its status (SPEC 10.2, 10.5, 10.7)`,
        );
        const k1Row = requireRow(
          derived,
          "uncovered-requirement",
          C11_K1,
          prefix,
        );
        if (k1Row.id === idSrc || k1Row.id === idK2) {
          fail(
            `${prefix}: k1's new item takes a fresh id (SPEC 10.2); got ` +
              `${k1Row.id}, colliding with an existing item id`,
          );
        }
        if (
          requireRow(derived, "uncovered-requirement", C11_SRC, prefix).id !==
            idSrc ||
          requireRow(derived, "uncovered-requirement", C11_K2, prefix).id !==
            idK2
        ) {
          fail(
            `${prefix}: matching items keep their ids across the ` +
              `re-derivation (SPEC 10.5)`,
          );
        }
        const exported = await exportSession(product, workspace, "c", prefix);
        assertSameInformation(
          requireItemById(exported.items, idK2, prefix).current,
          k2Before.current,
          `${prefix}: the no-longer-generated k2 item retains its recorded ` +
            `state across the re-derivation (SPEC 10.5)`,
        );
        assertSameJson(
          exportKindScopeSequence(exported.items),
          [
            `uncovered-requirement ${C11_SRC}`,
            `uncovered-requirement ${C11_K1}`,
            `uncovered-requirement ${C11_K2}`,
          ],
          `${prefix}: \`export\` presents the coverage item order too ` +
            `(SPEC 10.5, 10.7)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.7-12 — payload text contract
// ---------------------------------------------------------------------------

// Sub-fixture A: a baseline (path-blocks) session generating every built-in
// kind except uncovered-requirement (sub-fixture C's coverage session
// supplies that one). One spec file plus one code file added after the
// baseline. The staged nodes:
//   par { par.n { par.n.c } }  par's own text embeds `emb` (the expansion
//                              pin); par.n's own text is edited v0→v1 (the
//                              changed node) and again v1→v2 after create
//                              (the origin re-edit), so origin sides differ
//                              and neither equals the create-time value.
//   host [ host.n ]            host.n is added at v1: host becomes `changed`
//                              (its own content gains a child, SPEC 5.5/5.6)
//                              and host.n, under a changed ancestor, gets no
//                              item of its own — it enters payloads as an
//                              origin/context node added since the baseline.
//   gone                       own text edited v0→v1, section deleted at v2:
//                              an absent scope with create-time provenance
//                              and a since-deleted origin node (after side
//                              absent).
//   m { m.k }                  d target swapped told→tnew at v1: the
//                              metadata-changed node (scope own text; its
//                              added and removed d targets are context with
//                              subtree text).
//   told, tnew { tnew.c }      m's removed and added d targets (unchanged).
//   dep { dep.k }              depends on wt throughout: the
//                              dependency-consistency scope (own text).
//   wt { wt.c }                own text edited v0→v1: dep's changed target.
//   emb                        the embedded target (unchanged).
// src/ref.ts (added at v1) references par.n and host.n at the top level: the
// impacted code location (whole-file identity, SPEC 4.6, 9.2).
const M12_FILE = "specs/A.mdx";
const M12_ROOT = "specs/A.mdx";
const M12_PAR = "specs/A.mdx#par";
const M12_PARN = "specs/A.mdx#par.n";
const M12_HOST = "specs/A.mdx#host";
const M12_HOSTN = "specs/A.mdx#host.n";
const M12_GONE = "specs/A.mdx#gone";
const M12_M = "specs/A.mdx#m";
const M12_TOLD = "specs/A.mdx#told";
const M12_TNEW = "specs/A.mdx#tnew";
const M12_DEP = "specs/A.mdx#dep";
const M12_WT = "specs/A.mdx#wt";
const M12_CODE = "src/ref.ts";

const M12_EMBEDDED_TEXT = "Embedded target text.";

interface M12SpecState {
  readonly parN: string;
  readonly nova: boolean;
  readonly gone: string | null;
  readonly mTarget: "told" | "tnew";
  readonly wt: string;
}

function m12Spec(state: M12SpecState): string {
  return [
    '<S id="par">',
    'Par own {text("emb")} line.',
    "",
    '<S id="par.n">',
    state.parN,
    "",
    '<S id="par.n.c">',
    "Junior constant line.",
    "</S>",
    "</S>",
    "</S>",
    "",
    '<S id="host">',
    "Host own line.",
    ...(state.nova ? ["", '<S id="host.n">', "Nova line.", "</S>"] : []),
    "</S>",
    "",
    ...(state.gone === null ? [] : ['<S id="gone">', state.gone, "</S>", ""]),
    `<S id="m" d={"${state.mTarget}"}>`,
    "Em own line.",
    "",
    '<S id="m.k">',
    "Em kid line.",
    "</S>",
    "</S>",
    "",
    '<S id="told">',
    "Told line.",
    "</S>",
    "",
    '<S id="tnew">',
    "Tnew own line.",
    "",
    '<S id="tnew.c">',
    "Tnew kid line.",
    "</S>",
    "</S>",
    "",
    '<S id="dep" d={"wt"}>',
    "Dep own line.",
    "",
    '<S id="dep.k">',
    "Dep kid line.",
    "</S>",
    "</S>",
    "",
    '<S id="wt">',
    state.wt,
    "",
    '<S id="wt.c">',
    "Wt kid line.",
    "</S>",
    "</S>",
    "",
    '<S id="emb">',
    M12_EMBEDDED_TEXT,
    "</S>",
    "",
  ].join("\n");
}

const M12_V0: M12SpecState = {
  parN: "Node own v0 line.",
  nova: false,
  gone: "Gone own v0 line.",
  mTarget: "told",
  wt: "Wt own v0 line.",
};
const M12_V1: M12SpecState = {
  parN: "Node own v1 line.",
  nova: true,
  gone: "Gone own v1 line.",
  mTarget: "tnew",
  wt: "Wt own v1 line.",
};
const M12_V2: M12SpecState = {
  parN: "Node own v2 line.",
  nova: true,
  gone: null,
  mTarget: "tnew",
  wt: "Wt own v1 line.",
};

const M12_CODE_SOURCE = [
  'import A from "../specs/A.xspec";',
  "",
  "A.par.n;",
  "A.host.n;",
  "",
].join("\n");

// Sub-fixture B: the absent-node provenance arms. px.x is edited between the
// baseline and create, then deleted after create (its item's scope presents
// the create-time value, not the baseline's, and keeps it across a
// re-derivation that runs without it). yq.y is deleted before create while
// dm's `d` reference to it is removed — the removed target enters mc dm's
// context, recorded at create while already absent, so it presents its
// baseline value (no mutating derivation ever saw newer text).
const B12_FILE = "specs/B.mdx";
const B12_PX = "specs/B.mdx#px";
const B12_PXX = "specs/B.mdx#px.x";
const B12_DM = "specs/B.mdx#dm";
const B12_YQ = "specs/B.mdx#yq";
const B12_YQY = "specs/B.mdx#yq.y";

function b12Spec(
  xLine: string | null,
  withY: boolean,
  dmWithD: boolean,
): string {
  return [
    '<S id="px">',
    "Pex own line.",
    ...(xLine === null ? [] : ["", '<S id="px.x">', xLine, "</S>"]),
    "</S>",
    "",
    dmWithD ? '<S id="dm" d={"yq.y"}>' : '<S id="dm">',
    "Dee own line.",
    "</S>",
    "",
    '<S id="yq">',
    "Ykew own line.",
    ...(withY ? ["", '<S id="yq.y">', "Wye baseline-only line.", "</S>"] : []),
    "</S>",
    "",
  ].join("\n");
}

// Sub-fixture C: the uncovered-requirement payload. `targets: "all"` makes
// the branch node `top` required, so an uncovered scope exists whose subtree
// text differs from its own text; cov's d edge covers top.in.
const U12_FILE = "specs/U.mdx";
const U12_ROOT = "specs/U.mdx";
const U12_TOP = "specs/U.mdx#top";
const U12_COV = "specs/U.mdx#cov";

const U12_SOURCE = [
  '<S id="top">',
  "Top own line.",
  "",
  '<S id="top.in">',
  "Inner line.",
  "</S>",
  "</S>",
  "",
  '<S id="cov" d={"top.in"}>',
  "Cov line.",
  "</S>",
  "",
].join("\n");

const T10_7_12 = defineProductTest({
  id: "T10.7-12",
  title:
    "payload text contract: a baseline fixture generating every built-in kind (a coverage session supplying `uncovered-requirement`), texts byte-asserted against `query node` captures in `export`, identically via `show` per item, and identically in `next --json` through a full walk of each session (one payload rule), with an embedding inside asserted texts to pin 1.6 expansion (the expanded target's bytes present, the unexpanded `text(` spelling absent); scope text by kind — the scope root's subtree text for `subtree-coherence`, the scope node's subtree text for `uncovered-requirement`, the scope node's own text (differing from its subtree text by fixture) for `parent-consistency`, `dependency-consistency`, and `metadata-consistency`, and a `code-impact` scope as identity and presence alone with no text and no source range; context text — own text for ancestor-chain contexts (`subtree-coherence`, `uncovered-requirement`), subtree text otherwise (`parent-consistency` branch children; `dependency-consistency`, `metadata-consistency`, and `code-impact` targets); origin text — a before/after pair of own text, before from the item's baseline and after from the current graph (an originating node re-edited after `create` differs on both sides from the create-time value), with the before side absent (no text) for a node added since the baseline and the after side absent for a since-deleted node; source ranges on present nodes byte-equal to `query node`'s and absent on absent nodes; absent-node provenance — a node edited between the baseline and `create`, recorded into an item's scope or context at `create`, then deleted, presents the create-time text (not the differing baseline value) and still does after an `updated` resolve re-derives the session without it, while a node deleted since the baseline and never seen by a mutating derivation with newer text presents its baseline value (SPEC 1.6, 1.7, 5.6, 9.2, 10.2, 10.4, 10.5, 10.7)",
  timeoutMs: 600_000,
  run: async (product) => {
    // --- sub-fixture A: the per-kind matrix over a path-blocks session -------
    await withWorkspace(
      SPECS_CODE_CONFIG,
      { [M12_FILE]: m12Spec(M12_V0) },
      async (workspace) => {
        const prefix = "T10.7-12 matrix";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await buildOk(product, workspace, `${prefix} \`build\` at v0`);

        // Baseline captures (origin `before` sides; gone's discrimination).
        const capture = async (identity: string, moment: string) =>
          await queryNode(
            product,
            workspace,
            identity,
            `${prefix} ${moment} capture`,
          );
        const parN0 = await capture(M12_PARN, "v0");
        const host0 = await capture(M12_HOST, "v0");
        const gone0 = await capture(M12_GONE, "v0");
        const m0 = await capture(M12_M, "v0");
        const wt0 = await capture(M12_WT, "v0");

        // v1 — the reviewed differences; then create.
        await workspace.file(M12_FILE, m12Spec(M12_V1));
        await workspace.file(M12_CODE, M12_CODE_SOURCE);
        await buildOk(product, workspace, `${prefix} \`build\` at v1`);
        const parN1 = await capture(M12_PARN, "v1");
        const gone1 = await capture(M12_GONE, "v1");
        if (gone1.subtreeText === gone0.subtreeText) {
          fail(
            `${prefix} staging premise: gone's v0→v1 edit must change its ` +
              `subtree text (SPEC 1.6) so create-time provenance is ` +
              `distinguishable from the baseline value`,
          );
        }
        await createBaseSession(product, workspace, base, "s", prefix);

        // v2 — the post-create re-edit of the originating node par.n, and
        // gone's deletion. No re-derivation runs (the walk resolves
        // `no-change` only), so the item set is fixed at the create-time
        // derivation.
        await workspace.file(M12_FILE, m12Spec(M12_V2));
        await buildOk(product, workspace, `${prefix} \`build\` at v2`);

        // Current-state captures (present nodes' texts and ranges).
        const root2 = await capture(M12_ROOT, "v2");
        const par2 = await capture(M12_PAR, "v2");
        const parN2 = await capture(M12_PARN, "v2");
        const host2 = await capture(M12_HOST, "v2");
        const hostN2 = await capture(M12_HOSTN, "v2");
        const m2 = await capture(M12_M, "v2");
        const told2 = await capture(M12_TOLD, "v2");
        const tnew2 = await capture(M12_TNEW, "v2");
        const dep2 = await capture(M12_DEP, "v2");
        const wt2 = await capture(M12_WT, "v2");

        // Staging premises: every own-vs-subtree discrimination is real, the
        // origin moments are pairwise distinct, and the embedding expanded.
        for (const [report, node] of [
          [par2, "par"],
          [m2, "m"],
          [dep2, "dep"],
          [parN2, "par.n"],
          [tnew2, "tnew"],
          [wt2, "wt"],
        ] as const) {
          if (report.ownText === report.subtreeText) {
            fail(
              `${prefix} staging premise: ${node}'s own text must differ ` +
                `from its subtree text (SPEC 1.6) — the fixture gives it a ` +
                `child so the payload's text-kind selection is discriminating`,
            );
          }
        }
        assertPairwiseDistinct(
          [
            ["par.n's v0 own text", parN0.ownText],
            ["par.n's v1 own text", parN1.ownText],
            ["par.n's v2 own text", parN2.ownText],
          ],
          prefix,
        );
        if (
          !par2.ownText.includes(M12_EMBEDDED_TEXT) ||
          par2.ownText.includes("text(")
        ) {
          fail(
            `${prefix} staging premise: par's own text embeds emb — the ` +
              `expanded target bytes must appear and the unexpanded ` +
              `\`text(\` spelling must not (SPEC 1.6, 2.3); got ` +
              JSON.stringify(par2.ownText),
          );
        }

        // The reference read: export, then the per-item matrix.
        const exported = await exportSession(product, workspace, "s", prefix);
        assertSameJson(
          [...exportKindScopeSequence(exported.items)].sort(),
          [
            `subtree-coherence ${M12_PARN}`,
            `subtree-coherence ${M12_HOST}`,
            `subtree-coherence ${M12_GONE}`,
            `subtree-coherence ${M12_WT}`,
            `parent-consistency ${M12_PAR}`,
            `metadata-consistency ${M12_M}`,
            `dependency-consistency ${M12_DEP}`,
            `code-impact ${M12_CODE}`,
          ].sort(),
          `${prefix}: the staged differences derive exactly one item per ` +
            `built-in path-blocks kind — the four changed nodes' ` +
            `subtree-coherence items, par's parent-consistency item, m's ` +
            `metadata-consistency item, dep's dependency-consistency item, ` +
            `and the impacted location's code-impact item (SPEC 5.6, 9.2, ` +
            `10.5)`,
        );

        // subtree-coherence par.n: scope subtree text (current), context =
        // ancestor chain with own texts, origin pair v0/v2 (neither the
        // create-time v1 value).
        {
          const item = requireItem(
            exported.items,
            "subtree-coherence",
            M12_PARN,
            prefix,
          );
          const label = `${prefix} subtree-coherence(par.n)`;
          assertPresentState(
            item.scope,
            {
              node: M12_PARN,
              text: parN2.subtreeText,
              sourceRange: parN2.sourceRange,
            },
            `${label} scope — the scope root's subtree text, from the ` +
              `current graph`,
          );
          assertSameJson(
            identitySet(item.context),
            [M12_ROOT, M12_PAR].sort(),
            `${label}: context is the ancestor chain (SPEC 10.5)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_PAR, label),
            {
              node: M12_PAR,
              text: par2.ownText,
              sourceRange: par2.sourceRange,
            },
            `${label} context entry par — ancestor-chain context carries ` +
              `own text (the embedding-expanded value)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_ROOT, label),
            {
              node: M12_ROOT,
              text: root2.ownText,
              sourceRange: root2.sourceRange,
            },
            `${label} context entry root — ancestor-chain context carries ` +
              `own text`,
          );
          assertSameJson(
            identitySet(item.origin),
            [M12_PARN],
            `${label}: origin is the changed node (SPEC 10.5)`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_PARN, label),
            {
              before: { present: true, text: parN0.ownText },
              after: { present: true, text: parN2.ownText },
            },
            `${label} origin pair — before from the item's baseline (v0), ` +
              `after from the current graph (v2): the post-create re-edit ` +
              `makes both sides differ from the create-time v1 value`,
          );
        }

        // parent-consistency par: scope OWN text (not subtree — the fixture
        // makes them differ), context = the changed branch child par.n with
        // SUBTREE text, origin pair as above. The embedding pin runs on this
        // asserted scope text directly.
        {
          const item = requireItem(
            exported.items,
            "parent-consistency",
            M12_PAR,
            prefix,
          );
          const label = `${prefix} parent-consistency(par)`;
          assertPresentState(
            item.scope,
            {
              node: M12_PAR,
              text: par2.ownText,
              sourceRange: par2.sourceRange,
            },
            `${label} scope — the scope node's own text, not its subtree text`,
          );
          if (
            item.scope.text === undefined ||
            !item.scope.text.includes(M12_EMBEDDED_TEXT) ||
            item.scope.text.includes("text(")
          ) {
            fail(
              `${label}: the asserted scope text embeds emb — it must ` +
                `contain the expanded target text ` +
                `${JSON.stringify(M12_EMBEDDED_TEXT)} and no unexpanded ` +
                `\`text(\` spelling (SPEC 1.6, 2.3, 10.7); got ` +
                JSON.stringify(item.scope.text),
            );
          }
          assertSameJson(
            identitySet(item.context),
            [M12_PARN],
            `${label}: context is the changed branch's child (SPEC 10.5)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_PARN, label),
            {
              node: M12_PARN,
              text: parN2.subtreeText,
              sourceRange: parN2.sourceRange,
            },
            `${label} context entry par.n — a parent-consistency branch ` +
              `child carries subtree text (a product reporting own text ` +
              `fails: they differ by fixture)`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_PARN, label),
            {
              before: { present: true, text: parN0.ownText },
              after: { present: true, text: parN2.ownText },
            },
            `${label} origin pair`,
          );
        }

        // subtree-coherence host: origin holds both origin-pair shapes —
        // host present on both sides, host.n added since the baseline (its
        // before side is the absent side, no text).
        {
          const item = requireItem(
            exported.items,
            "subtree-coherence",
            M12_HOST,
            prefix,
          );
          const label = `${prefix} subtree-coherence(host)`;
          assertPresentState(
            item.scope,
            {
              node: M12_HOST,
              text: host2.subtreeText,
              sourceRange: host2.sourceRange,
            },
            `${label} scope — subtree text`,
          );
          assertSameJson(
            identitySet(item.origin),
            [M12_HOST, M12_HOSTN].sort(),
            `${label}: origin is the changed nodes in scope — host (its own ` +
              `content gained a child) and the added host.n (SPEC 5.5, 5.6, ` +
              `10.5)`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_HOST, label),
            {
              before: { present: true, text: host0.ownText },
              after: { present: true, text: host2.ownText },
            },
            `${label} origin pair for host`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_HOSTN, label),
            {
              before: { present: false },
              after: { present: true, text: hostN2.ownText },
            },
            `${label} origin pair for host.n — added since the baseline: ` +
              `the before side is the absent side, presented absent with no ` +
              `text (SPEC 10.7)`,
          );
        }

        // subtree-coherence gone: the absent scope — create-time (v1)
        // subtree text, no source range — and the since-deleted origin
        // node's after side absent.
        {
          const item = requireItem(
            exported.items,
            "subtree-coherence",
            M12_GONE,
            prefix,
          );
          const label = `${prefix} subtree-coherence(gone)`;
          assertAbsentState(
            item.scope,
            { node: M12_GONE, text: gone1.subtreeText },
            `${label} scope — deleted after create: its text is the value ` +
              `of the most recent graph state containing it, the ` +
              `create-time derivation (v1), not the baseline (SPEC 10.7)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_ROOT, label),
            {
              node: M12_ROOT,
              text: root2.ownText,
              sourceRange: root2.sourceRange,
            },
            `${label} context entry root — still present, own text from the ` +
              `current graph`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_GONE, label),
            {
              before: { present: true, text: gone0.ownText },
              after: { present: false },
            },
            `${label} origin pair — for a since-deleted node the after side ` +
              `is the absent side, presented absent with no text (SPEC 10.7)`,
          );
        }

        // metadata-consistency m: scope own text; context = the added and
        // removed d targets with subtree texts; origin pair of m's own text
        // (unchanged — both sides equal).
        {
          const item = requireItem(
            exported.items,
            "metadata-consistency",
            M12_M,
            prefix,
          );
          const label = `${prefix} metadata-consistency(m)`;
          assertPresentState(
            item.scope,
            { node: M12_M, text: m2.ownText, sourceRange: m2.sourceRange },
            `${label} scope — the scope node's own text, not its subtree text`,
          );
          assertSameJson(
            identitySet(item.context),
            [M12_TOLD, M12_TNEW].sort(),
            `${label}: context is the added and removed d targets (SPEC 10.5)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_TOLD, label),
            {
              node: M12_TOLD,
              text: told2.subtreeText,
              sourceRange: told2.sourceRange,
            },
            `${label} context entry told (removed target) — subtree text`,
          );
          assertPresentState(
            requireContextEntry(item, M12_TNEW, label),
            {
              node: M12_TNEW,
              text: tnew2.subtreeText,
              sourceRange: tnew2.sourceRange,
            },
            `${label} context entry tnew (added target) — subtree text (a ` +
              `product reporting own text fails: tnew has a child)`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_M, label),
            {
              before: { present: true, text: m0.ownText },
              after: { present: true, text: m2.ownText },
            },
            `${label} origin pair — m's own text is untouched, so both ` +
              `sides carry the same value`,
          );
        }

        // dependency-consistency dep: scope own text; context = the changed
        // target wt with subtree text; origin = wt's v0→v1 own-text pair.
        {
          const item = requireItem(
            exported.items,
            "dependency-consistency",
            M12_DEP,
            prefix,
          );
          const label = `${prefix} dependency-consistency(dep)`;
          assertPresentState(
            item.scope,
            {
              node: M12_DEP,
              text: dep2.ownText,
              sourceRange: dep2.sourceRange,
            },
            `${label} scope — the scope node's own text, not its subtree text`,
          );
          assertSameJson(
            identitySet(item.context),
            [M12_WT],
            `${label}: context is the changed upstream target (SPEC 10.5)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_WT, label),
            {
              node: M12_WT,
              text: wt2.subtreeText,
              sourceRange: wt2.sourceRange,
            },
            `${label} context entry wt — a dependency-consistency target ` +
              `carries subtree text`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_WT, label),
            {
              before: { present: true, text: wt0.ownText },
              after: { present: true, text: wt2.ownText },
            },
            `${label} origin pair for wt`,
          );
        }

        // code-impact: the scope enters as identity and presence alone — no
        // text, no source range (SPEC 10.7, 1.7); context = the targets that
        // make it impacted (the added host.n included) with subtree texts;
        // origin = those targets' originating nodes with their pairs.
        {
          const item = requireItem(
            exported.items,
            "code-impact",
            M12_CODE,
            prefix,
          );
          const label = `${prefix} code-impact(src/ref.ts)`;
          assertPresentState(
            item.scope,
            { node: M12_CODE, text: undefined, sourceRange: undefined },
            `${label} scope — a code location has no text value and no ` +
              `source range: identity and presence alone (SPEC 10.7, 1.7)`,
          );
          assertSameJson(
            identitySet(item.context),
            [M12_PARN, M12_HOSTN].sort(),
            `${label}: context is the impact-edge targets that make the ` +
              `location impacted, added targets included (SPEC 9.2, 10.5)`,
          );
          assertPresentState(
            requireContextEntry(item, M12_PARN, label),
            {
              node: M12_PARN,
              text: parN2.subtreeText,
              sourceRange: parN2.sourceRange,
            },
            `${label} context entry par.n — code-impact targets carry ` +
              `subtree text`,
          );
          assertPresentState(
            requireContextEntry(item, M12_HOSTN, label),
            {
              node: M12_HOSTN,
              text: hostN2.subtreeText,
              sourceRange: hostN2.sourceRange,
            },
            `${label} context entry host.n`,
          );
          assertSameJson(
            identitySet(item.origin),
            [M12_PARN, M12_HOSTN].sort(),
            `${label}: origin is the originating nodes of the targets' ` +
              `changes (SPEC 5.6, 10.5)`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_PARN, label),
            {
              before: { present: true, text: parN0.ownText },
              after: { present: true, text: parN2.ownText },
            },
            `${label} origin pair for par.n`,
          );
          assertOriginPair(
            requireOriginEntry(item, M12_HOSTN, label),
            {
              before: { present: false },
              after: { present: true, text: hostN2.ownText },
            },
            `${label} origin pair for host.n — added since the baseline`,
          );
        }

        // One payload rule (SPEC 10.7): `show` presents each item with the
        // identical payload, and a full `next` walk returns every item once
        // with the identical payload.
        for (const item of exported.items) {
          const shown = await showItem(
            product,
            workspace,
            "s",
            item.id,
            `${prefix} show/export compare`,
          );
          assertSameInformation(
            payloadProjection(shown),
            payloadProjection(item),
            `${prefix}: \`show\` of item ${item.id} (${item.kind} ` +
              `${item.scope.node}) presents the same self-contained text ` +
              `payload as \`export\` (SPEC 10.7)`,
          );
        }
        await walkNextAgainstReference(
          product,
          workspace,
          "s",
          exported.items,
          `${prefix} next walk`,
        );
      },
    );

    // --- sub-fixture B: absent-node provenance across re-derivation ----------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [B12_FILE]: b12Spec("Ex line T0.", true, true) },
      async (workspace) => {
        const prefix = "T10.7-12 provenance";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await buildOk(product, workspace, `${prefix} \`build\` at v0`);
        const x0 = await queryNode(
          product,
          workspace,
          B12_PXX,
          `${prefix} v0 capture of px.x`,
        );
        const y0 = await queryNode(
          product,
          workspace,
          B12_YQY,
          `${prefix} v0 capture of yq.y`,
        );

        // v1: px.x edited (T0→T1); yq.y deleted with dm's d reference to it
        // removed in the same write (so no unresolved reference exists).
        await workspace.file(B12_FILE, b12Spec("Ex line T1.", false, false));
        await buildOk(product, workspace, `${prefix} \`build\` at v1`);
        const x1 = await queryNode(
          product,
          workspace,
          B12_PXX,
          `${prefix} v1 capture of px.x`,
        );
        if (x1.subtreeText === x0.subtreeText) {
          fail(
            `${prefix} staging premise: px.x's v0→v1 edit must change its ` +
              `subtree text (SPEC 1.6) — the create-time and baseline ` +
              `values must differ for the provenance discrimination`,
          );
        }
        await createBaseSession(product, workspace, base, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          rowSequence(initial)
            .map((row) => row.split(" ").slice(0, 2).join(" "))
            .sort(),
          [
            `metadata-consistency ${B12_DM}`,
            `parent-consistency ${B12_PX}`,
            `subtree-coherence ${B12_PXX}`,
            `subtree-coherence ${B12_YQ}`,
          ].sort(),
          `${prefix} staging premise: the create-time items — px.x changed ` +
            `(edit), yq changed (its child yq.y deleted, so yq.y itself is ` +
            `skipped under its changed ancestor), dm metadata-changed (d ` +
            `removed) (SPEC 5.6, 10.5)`,
        );
        const idPXX = requireRow(
          initial,
          "subtree-coherence",
          B12_PXX,
          prefix,
        ).id;
        const idDM = requireRow(
          initial,
          "metadata-consistency",
          B12_DM,
          prefix,
        ).id;

        // v2: delete px.x after create.
        await workspace.file(B12_FILE, b12Spec(null, false, false));
        await buildOk(product, workspace, `${prefix} \`build\` at v2`);

        const assertProvenance = async (stage: string): Promise<void> => {
          // Arm 1: px.x — edited between the baseline and create, recorded
          // as its item's scope at create, then deleted: it presents the
          // create-time (v1) subtree text, not the baseline's.
          const xItem = await showItem(
            product,
            workspace,
            "s",
            idPXX,
            `${prefix} ${stage}`,
          );
          assertAbsentState(
            xItem.scope,
            { node: B12_PXX, text: x1.subtreeText },
            `${prefix} ${stage}, px.x's item scope — the most recent graph ` +
              `state containing px.x is the create-time derivation (v1), ` +
              `not the baseline: the values differ by fixture (SPEC 10.7)`,
          );
          // Arm 2: yq.y — deleted since the baseline before create, never
          // seen by a mutating derivation with newer text: its context
          // entry in dm's item presents the baseline subtree text.
          const dmItem = await showItem(
            product,
            workspace,
            "s",
            idDM,
            `${prefix} ${stage}`,
          );
          assertSameJson(
            identitySet(dmItem.context),
            [B12_YQY],
            `${prefix} ${stage}: dm's metadata-consistency context is its ` +
              `removed d target yq.y (SPEC 10.5)`,
          );
          assertAbsentState(
            requireContextEntry(dmItem, B12_YQY, `${prefix} ${stage}`),
            { node: B12_YQY, text: y0.subtreeText },
            `${prefix} ${stage}, yq.y in dm's context — deleted since the ` +
              `baseline and never seen by a mutating derivation with newer ` +
              `text: it presents its baseline value (SPEC 10.7)`,
          );
          // One payload rule: export presents the same values.
          const exported = await exportSession(
            product,
            workspace,
            "s",
            `${prefix} ${stage}`,
          );
          assertSameInformation(
            payloadProjection(requireItemById(exported.items, idPXX, prefix)),
            payloadProjection(xItem),
            `${prefix} ${stage}: \`export\` presents px.x's item with the ` +
              `same payload as \`show\` (SPEC 10.7)`,
          );
          assertSameInformation(
            payloadProjection(requireItemById(exported.items, idDM, prefix)),
            payloadProjection(dmItem),
            `${prefix} ${stage}: \`export\` presents dm's item with the ` +
              `same payload as \`show\` (SPEC 10.7)`,
          );
        };

        await assertProvenance("after the px.x deletion");

        // The `updated` resolve re-derives the session against a graph
        // containing neither px.x nor yq.y: a state not containing the node
        // contributes nothing, so both provenance texts are unchanged.
        await resolveOk(
          product,
          workspace,
          "s",
          idDM,
          "updated",
          `${prefix} \`resolve s <dm's item> --status updated\` — triggers ` +
            `re-derivation without px.x and yq.y (SPEC 10.5)`,
        );
        await assertProvenance("after the updated-resolve re-derivation");
      },
    );

    // --- sub-fixture C: the uncovered-requirement payload ---------------------
    await withWorkspace(
      COVERAGE_ALL_CONFIG,
      { [U12_FILE]: U12_SOURCE },
      async (workspace) => {
        const prefix = "T10.7-12 coverage";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await createCoverageSession(product, workspace, "p", "c", prefix);

        const top = await queryNode(
          product,
          workspace,
          U12_TOP,
          `${prefix} capture of top`,
        );
        const cov = await queryNode(
          product,
          workspace,
          U12_COV,
          `${prefix} capture of cov`,
        );
        const root = await queryNode(
          product,
          workspace,
          U12_ROOT,
          `${prefix} capture of the root`,
        );
        if (top.ownText === top.subtreeText) {
          fail(
            `${prefix} staging premise: top's own text must differ from its ` +
              `subtree text (SPEC 1.6) — \`targets: "all"\` makes the ` +
              `branch node required so the uncovered-requirement scope-text ` +
              `kind is discriminating`,
          );
        }

        const exported = await exportSession(product, workspace, "c", prefix);
        assertSameJson(
          exportKindScopeSequence(exported.items),
          [
            `uncovered-requirement ${U12_TOP}`,
            `uncovered-requirement ${U12_COV}`,
          ],
          `${prefix}: the uncovered required nodes — the branch top ` +
            `(required under targets: "all") and the leaf cov; top.in is ` +
            `covered by cov's d edge (SPEC 8, 8.1, 10.7)`,
        );
        const topItem = requireItem(
          exported.items,
          "uncovered-requirement",
          U12_TOP,
          prefix,
        );
        const label = `${prefix} uncovered-requirement(top)`;
        assertPresentState(
          topItem.scope,
          {
            node: U12_TOP,
            text: top.subtreeText,
            sourceRange: top.sourceRange,
          },
          `${label} scope — the scope node's SUBTREE text (a product ` +
            `reporting own text fails: they differ by fixture)`,
        );
        assertSameJson(
          identitySet(topItem.context),
          [U12_ROOT],
          `${label}: context is the node's ancestor chain (SPEC 10.7)`,
        );
        assertPresentState(
          requireContextEntry(topItem, U12_ROOT, label),
          { node: U12_ROOT, text: root.ownText, sourceRange: root.sourceRange },
          `${label} context entry root — ancestor-chain context carries own ` +
            `text`,
        );
        assertSameJson(
          identitySet(topItem.origin),
          [],
          `${label}: a coverage item's origin is empty (SPEC 10.7)`,
        );
        const covItem = requireItem(
          exported.items,
          "uncovered-requirement",
          U12_COV,
          prefix,
        );
        assertPresentState(
          covItem.scope,
          {
            node: U12_COV,
            text: cov.subtreeText,
            sourceRange: cov.sourceRange,
          },
          `${prefix} uncovered-requirement(cov) scope — subtree text`,
        );

        // One payload rule over the coverage session too: show per item and
        // the full next walk.
        for (const item of exported.items) {
          assertSameInformation(
            payloadProjection(
              await showItem(product, workspace, "c", item.id, prefix),
            ),
            payloadProjection(item),
            `${prefix}: \`show\` of item ${item.id} presents the same ` +
              `payload as \`export\` (SPEC 10.7)`,
          );
        }
        await walkNextAgainstReference(
          product,
          workspace,
          "c",
          exported.items,
          `${prefix} next walk`,
        );
      },
    );
  },
});

/** TEST-SPEC §10.7 second half, in canonical ID order (SUITE-39). */
export const section107iiTests: readonly ProductTestEntry[] = [
  T10_7_7,
  T10_7_8,
  T10_7_9,
  T10_7_10,
  T10_7_11,
  T10_7_12,
];
