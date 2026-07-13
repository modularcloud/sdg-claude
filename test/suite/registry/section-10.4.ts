// TEST-SPEC §10.4 (relevant hashes and invalidation) — SUITE-35:
// T10.4-1…T10.4-5.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 10.4: resolving an item records its relevant hashes (per kind) and
// every scope/context/origin node's presence; a resolved item becomes
// `invalidated` when that recorded state differs from the current graph — a
// recorded hash changed, a presence changed in either direction, or the
// item's generator-derived context set changed. Recorded nodes compare as
// canonical identities (5.4), so journaled renames and moves duplicate no
// item, discard no status, and by themselves invalidate nothing; reads
// present recorded nodes under current identities and never write the
// session file.
//
// Conservative operationalizations (noted per H-3/H-4):
// - Invalidation is observed through `review status --json` rows (read-time
//   invalidation applies to every read, SPEC 10.4); T10.4-5 additionally pins
//   all four reads — `status`, `next`, `show`, `export` — on both the
//   invalidated reporting and session-file byte-identity.
// - Every sensitivity arm asserts its staging premises via `query node`
//   captures bracketing the edit: the hashes the arm targets must change and
//   the hashes it must isolate must not (SPEC 5.5), and every control edit
//   must demonstrably change the edited node — so no arm passes or fails for
//   the wrong reason (H-8).
// - Re-resolves between arms use `--status no-change` (no re-derivation,
//   SPEC 10.5), so each arm starts from a freshly recorded state matching the
//   graph; T10.4-4's reintroduction arm is the one place `--status updated`
//   (re-derivation) is staged, exactly as its TEST-SPEC text prescribes.
// - "Recorded state intact" across a journaled rename/move (T10.4-4) is
//   asserted as: statuses preserved and not invalidated, plus the reported
//   `current` record still holding the pre-operation hash values captured via
//   `query node` among its string leaves (H-4: opaque record shape,
//   spec-fixed values) — meaningful because 6.2 purity keeps those hash
//   values byte-identical across the operation, asserted as a premise.
// - T10.4-5 byte-compares exactly the session file
//   (`.xspec/reviews/<name>.json`, SPEC 10.1) around each read — the object
//   whose byte-identity SPEC 10.4 pins ("reads never write the session
//   file") — not the whole workspace, whose other files are governed by
//   other tests (T6.1-1, T13.4-5, T12.0-11).
// - Fixture edits are followed by an explicit `build` before any read, so no
//   read relies on the 13.3 refresh path (that path is T13.3-*'s business).

import { Buffer } from "node:buffer";
import type {
  ItemStatus,
  NodeHashes,
  NodeReport,
  ReviewItem,
  SessionStatusReport,
  SessionStatusRow,
} from "../../helpers/adapters/index.js";
import {
  ITEM_STATUSES,
  decodeExportReport,
  decodeItemReport,
  decodeNextReport,
  decodeNodeReport,
  decodeSessionListReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  bytesEqual,
  fail,
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

// Spec group plus a code group (SPEC 7.2) — the `code-impact` scenario needs
// an impacted code location (SPEC 9.2, 10.5).
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

// Spec group plus a direct coverage profile over it (SPEC 7.4) — the
// `uncovered-requirement` scenario: an uncovered required leaf yields an
// `uncovered-requirement` item in a coverage session (SPEC 10.7).
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
 * missing or duplicated (SPEC 10.5: at most one item per kind and scope
 * node).
 */
function requireRow(
  report: SessionStatusReport,
  kind: SessionStatusRow["kind"],
  scope: string,
  context: string,
): SessionStatusRow {
  const rows = report.items.filter(
    (row) => row.kind === kind && row.scope === scope,
  );
  if (rows.length !== 1) {
    fail(
      `${context}: expected exactly one ${kind} item scoped at ${scope} ` +
        `(SPEC 10.5: a session never contains two items with the same kind ` +
        `and scope node); found ${String(rows.length)} among ` +
        JSON.stringify(report.items.map((row) => `${row.kind} ${row.scope}`)),
    );
  }
  return rows[0];
}

/** The unique status row with the given item id, diagnosed when absent. */
function requireRowById(
  report: SessionStatusReport,
  id: string,
  context: string,
): SessionStatusRow {
  const rows = report.items.filter((row) => row.id === id);
  if (rows.length !== 1) {
    fail(
      `${context}: expected exactly one item with id ${JSON.stringify(id)} ` +
        `(SPEC 10.2: item ids are unique within the session); found ` +
        `${String(rows.length)} among ` +
        JSON.stringify(report.items.map((row) => row.id)),
    );
  }
  return rows[0];
}

/** The export/next item with the given id, diagnosed when absent. */
function requireItem(
  items: readonly ReviewItem[],
  id: string,
  context: string,
): ReviewItem {
  const matches = items.filter((item) => item.id === id);
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one item with id ${JSON.stringify(id)} ` +
        `(SPEC 10.2: item ids are unique within the session); found ` +
        `${String(matches.length)} among ${JSON.stringify(items.map((item) => item.id))}`,
    );
  }
  return matches[0];
}

/** Read `status` and assert one item's reported status (SPEC 10.4). */
async function expectItemStatus(
  product: ProductBinding,
  workspace: TestWorkspace,
  session: string,
  itemId: string,
  expected: ItemStatus,
  context: string,
): Promise<void> {
  const report = await sessionStatus(product, workspace, session, context);
  const row = requireRowById(report, itemId, context);
  if (row.status !== expected) {
    fail(
      `${context}: expected the item to be reported ${expected}, got ` +
        `${row.status} (SPEC 10.4: a resolved item invalidates iff a ` +
        `recorded relevant hash changed, a recorded node's presence ` +
        `changed, or its generator-derived context set changed — and only ` +
        `then; reads apply this without persisting anything)`,
    );
  }
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
 * The recorded state must hold the given hash value among its string leaves
 * (SPEC 10.2/10.4: `current` holds the item's relevant hashes; the value is
 * the one `query node` reported at the recorded moment).
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
      `(SPEC 10.2, 10.4; H-4: opaque shape, spec-fixed values) — but it ` +
      `appears nowhere in ${JSON.stringify(recorded)}`,
  );
}

/** Totals by status, compared as `totals[status] ?? 0` per defined status. */
function assertTotals(
  report: SessionStatusReport,
  expected: Readonly<Record<ItemStatus, number>>,
  context: string,
): void {
  for (const status of ITEM_STATUSES) {
    const actual = report.totals[status] ?? 0;
    if (actual !== expected[status]) {
      fail(
        `${context}: \`review status\` totals must count ${String(expected[status])} ` +
          `item(s) with status ${status} (read-time invalidation applied, ` +
          `SPEC 10.4, 10.7); got ${String(actual)}`,
      );
    }
  }
}

/** Sorted node-identity set of a payload node list. */
function identitySet(
  states: readonly { readonly node: string }[],
): readonly string[] {
  return states.map((state) => state.node).sort();
}

/** Sorted `kind scope` rendering of a session's items (staging sanity). */
function kindScopeSet(report: SessionStatusReport): readonly string[] {
  return report.items.map((row) => `${row.kind} ${row.scope}`).sort();
}

/** Assert `firstId` precedes `secondId` in a reported item sequence. */
function assertPrecedes(
  items: readonly { readonly id: string }[],
  firstId: string,
  secondId: string,
  context: string,
): void {
  const firstIndex = items.findIndex((item) => item.id === firstId);
  const secondIndex = items.findIndex((item) => item.id === secondId);
  if (firstIndex === -1 || secondIndex === -1) {
    fail(
      `${context}: both items must be present — ${firstId} at index ` +
        `${String(firstIndex)}, ${secondId} at index ${String(secondIndex)} ` +
        `among ${JSON.stringify(items.map((item) => item.id))}`,
    );
  }
  if (firstIndex >= secondIndex) {
    fail(
      `${context}: item ${firstId} (index ${String(firstIndex)}) must ` +
        `precede item ${secondId} (index ${String(secondIndex)}) — item ` +
        `order compares scope nodes under their current identities ` +
        `(SPEC 10.4, 10.5, 10.6)`,
    );
  }
}

// ---------------------------------------------------------------------------
// T10.4-1 — per-kind sensitivity machinery
// ---------------------------------------------------------------------------

/** One hash of one node, probed as a staging premise (SPEC 5.5). */
interface HashProbe {
  readonly node: string;
  readonly hash: keyof NodeHashes;
}

/** One sensitivity arm: a single staged edit and its expected effect. */
interface SensitivityArm {
  /** Which relevant hash (or control) the arm exercises. */
  readonly label: string;
  /** Stage the arm's edit (rewrites fixture files; `build` follows). */
  readonly apply: () => Promise<void>;
  /** Whether the edit must invalidate the resolved item (SPEC 10.4). */
  readonly invalidates: boolean;
  /** Hashes the edit must change (staging premise, SPEC 5.5). */
  readonly changed: readonly HashProbe[];
  /** Hashes the edit must leave unchanged (isolation premise, SPEC 5.5). */
  readonly unchanged: readonly HashProbe[];
  /**
   * Item ids to re-resolve (in order, `--status no-change`) after an
   * invalidating arm, ending with the item under test; defaults to the item
   * under test alone. Blockers invalidated by the same edit come first
   * (SPEC 10.3: an invalidated blocker re-blocks its dependents).
   */
  readonly reresolve?: readonly string[];
}

/** The four hashes of each probed node, captured via `query node`. */
async function captureHashes(
  product: ProductBinding,
  workspace: TestWorkspace,
  nodes: readonly string[],
  context: string,
): Promise<ReadonlyMap<string, NodeHashes>> {
  const captured = new Map<string, NodeHashes>();
  for (const node of nodes) {
    captured.set(
      node,
      (await queryNode(product, workspace, node, context)).hashes,
    );
  }
  return captured;
}

/**
 * Run one kind's sensitivity arms against its resolved item: per arm, assert
 * the staged edit's hash premises (SPEC 5.5), then that the item is reported
 * `invalidated` exactly when the arm touches relevant state (SPEC 10.4), and
 * re-resolve so the next arm starts from a freshly recorded state.
 */
async function runSensitivityArms(
  product: ProductBinding,
  workspace: TestWorkspace,
  session: string,
  itemId: string,
  arms: readonly SensitivityArm[],
  contextPrefix: string,
): Promise<void> {
  for (const arm of arms) {
    const context = `${contextPrefix} — ${arm.label}`;
    const probedNodes = [
      ...new Set([...arm.changed, ...arm.unchanged].map((probe) => probe.node)),
    ];
    // The pre-edit capture equals the state the last resolve recorded: no
    // edit intervenes between a resolve and the next arm's `apply`.
    const before = await captureHashes(
      product,
      workspace,
      probedNodes,
      `${context}, pre-edit capture`,
    );
    await arm.apply();
    await buildOk(product, workspace, `${context} — \`build\` after the edit`);
    const after = await captureHashes(
      product,
      workspace,
      probedNodes,
      `${context}, post-edit capture`,
    );
    for (const probe of arm.changed) {
      const beforeValue = before.get(probe.node)?.[probe.hash];
      const afterValue = after.get(probe.node)?.[probe.hash];
      if (beforeValue === afterValue) {
        fail(
          `${context}: staging premise — the edit must change ${probe.node}'s ` +
            `${probe.hash} (SPEC 5.5) for this arm to exercise it; both ` +
            `captures report ${JSON.stringify(afterValue)}`,
        );
      }
    }
    for (const probe of arm.unchanged) {
      const beforeValue = before.get(probe.node)?.[probe.hash];
      const afterValue = after.get(probe.node)?.[probe.hash];
      if (beforeValue !== afterValue) {
        fail(
          `${context}: staging premise — the edit must leave ${probe.node}'s ` +
            `${probe.hash} unchanged (SPEC 5.5) so the arm isolates its ` +
            `intended sensitivity; got ${JSON.stringify(beforeValue)} -> ` +
            JSON.stringify(afterValue),
        );
      }
    }
    await expectItemStatus(
      product,
      workspace,
      session,
      itemId,
      arm.invalidates ? "invalidated" : "no-change",
      `${context} — read after the edit`,
    );
    if (arm.invalidates) {
      for (const id of arm.reresolve ?? [itemId]) {
        await resolveOk(
          product,
          workspace,
          session,
          id,
          "no-change",
          `${context} — re-resolve item ${id} --status no-change to ` +
            `re-record its current relevant state (SPEC 10.4, 10.7; ` +
            `no-change: no re-derivation, SPEC 10.5)`,
        );
      }
      await expectItemStatus(
        product,
        workspace,
        session,
        itemId,
        "no-change",
        `${context} — after the re-resolve (the freshly recorded state ` +
          `matches the graph again)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// T10.4-1 — per-kind sensitivity fixtures
// ---------------------------------------------------------------------------

// subtree-coherence (--base session; SPEC 10.4: subtreeHash and metadataHash
// of each scope node). One top-level changed parent p with descendant p.c and
// an outside sibling o — the session holds exactly p's item (p has no
// non-root ancestor, so no parent-consistency items arise).
const SC_FILE = "specs/S.mdx";
const SC_P = "specs/S.mdx#p";
const SC_PC = "specs/S.mdx#p.c";
const SC_O = "specs/S.mdx#o";

function scSpec(
  pOwn: string,
  pAttrs: string,
  cText: string,
  cAttrs: string,
  oText: string,
): string {
  return [
    `<S id="p"${pAttrs}>`,
    pOwn,
    "",
    `<S id="p.c"${cAttrs}>`,
    cText,
    "</S>",
    "</S>",
    "",
    '<S id="o">',
    oText,
    "</S>",
    "",
  ].join("\n");
}

// parent-consistency (--base; SPEC 10.4: ownHash and metadataHash of the
// scope node; subtreeHash of each context node). A deep leaf edit under
// a > a.k > a.k.d makes a's item's context node a.k, with the changed branch
// two levels down; o is the sibling-subtree control.
const PC_FILE = "specs/P.mdx";
const PC_A = "specs/P.mdx#a";
const PC_AK = "specs/P.mdx#a.k";
const PC_AKD = "specs/P.mdx#a.k.d";
const PC_O = "specs/P.mdx#o";

function pcSpec(
  aOwn: string,
  aAttrs: string,
  dText: string,
  oText: string,
): string {
  return [
    `<S id="a"${aAttrs}>`,
    aOwn,
    "",
    '<S id="a.k">',
    "Branch child own text.",
    "",
    '<S id="a.k.d">',
    dText,
    "</S>",
    "</S>",
    "</S>",
    "",
    '<S id="o">',
    oText,
    "</S>",
    "",
  ].join("\n");
}

// dependency-consistency (--base; SPEC 10.4: ownHash and metadataHash of the
// scope node; subtreeHash of each upstream target in context). dep depends on
// t (whose staged own-text edit generates the item); t.c is the deep-edit
// handle under the target; u is the unrelated-node control.
const DC_FILE = "specs/D.mdx";
const DC_DEP = "specs/D.mdx#dep";
const DC_T = "specs/D.mdx#t";
const DC_U = "specs/D.mdx#u";

function dcSpec(
  depOwn: string,
  depAttrs: string,
  tOwn: string,
  tcText: string,
  uText: string,
): string {
  return [
    `<S id="dep" d={"t"}${depAttrs}>`,
    depOwn,
    "</S>",
    "",
    '<S id="t">',
    tOwn,
    "",
    '<S id="t.c">',
    tcText,
    "</S>",
    "</S>",
    "",
    '<S id="u">',
    uText,
    "</S>",
    "",
  ].join("\n");
}

// metadata-consistency (--base; SPEC 10.4: metadataHash of the scope node
// only). m's staged tag change generates the item; the control is a text
// edit of m itself — subtreeHash moves, metadataHash does not.
const MC_FILE = "specs/M.mdx";
const MC_M = "specs/M.mdx#m";

function mcSpec(mTags: string, mText: string): string {
  return [`<S id="m" tags="${mTags}">`, mText, "</S>", ""].join("\n");
}

// code-impact (--base; SPEC 10.4: subtreeHash and effectiveHash of each node
// targeted by the scoped location's impact edges). src/ref.ts references t;
// t depends on up (the effectiveHash-only upstream handle); w is the control
// node — no impact-edge target, upstream of nothing.
const CI_FILE = "specs/C.mdx";
const CI_T = "specs/C.mdx#t";
const CI_UP = "specs/C.mdx#up";
const CI_W = "specs/C.mdx#w";
const CI_CODE = "src/ref.ts";

function ciSpec(tText: string, upText: string, wText: string): string {
  return [
    '<S id="t" d={"up"}>',
    tText,
    "</S>",
    "",
    '<S id="up">',
    upText,
    "</S>",
    "",
    '<S id="w">',
    wText,
    "</S>",
    "",
  ].join("\n");
}

// A whole-file code location (SPEC 4.6): the bare-reference marker sits at
// the top level, so the `references` edge runs from `src/ref.ts` itself.
const CI_CODE_SOURCE = [
  'import C from "../specs/C.xspec";',
  "",
  "C.t;",
  "",
].join("\n");

// uncovered-requirement (coverage session; SPEC 10.4: subtreeHash and
// metadataHash of the scope node). Uncovered leaves u (under test) and e
// (the elsewhere-edit control), both required by the direct profile.
const UR_FILE = "specs/U.mdx";
const UR_U = "specs/U.mdx#u";
const UR_E = "specs/U.mdx#e";

function urSpec(uAttrs: string, uText: string, eText: string): string {
  return [
    `<S id="u"${uAttrs}>`,
    uText,
    "</S>",
    "",
    '<S id="e">',
    eText,
    "</S>",
    "",
  ].join("\n");
}

const T10_4_1 = defineProductTest({
  id: "T10.4-1",
  title:
    "per-kind relevant-hash sensitivity: for each built-in kind every relevant hash of SPEC 10.4 is exercised as an invalidating case with query-node hash premises bracketing the edit, plus a non-invalidating control touching none of the item's relevant state — subtree-coherence (subtree text edit; metadata-only edit on the scope root and, separately, on a descendant, which changes no subtreeHash and MUST still invalidate; control outside the subtree), parent-consistency (own-text and metadata edits of the scope node; deep text edit under a context child; sibling-subtree control), dependency-consistency (own-text and metadata edits of the scope node; text edit under the upstream target in context; unrelated-node control), metadata-consistency (metadata edit invalidates; a text edit of the scope node does not), code-impact (target text edit; upstream edit changing only the target's effectiveHash; control on a node that is no impact-edge target and upstream of none), uncovered-requirement (scope-subtree text edit; scope metadata edit; control elsewhere) (SPEC 5.5, 10.4, 10.5, 10.7)",
  timeoutMs: 480_000,
  run: async (product) => {
    // --- subtree-coherence -------------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [SC_FILE]: scSpec(
          "Parent own v0.",
          "",
          "Child text v0.",
          "",
          "Outside v0.",
        ),
      },
      async (workspace) => {
        const prefix = "T10.4-1 subtree-coherence";
        let pOwn = "Parent own v0.";
        let pAttrs = "";
        let cText = "Child text v0.";
        let cAttrs = "";
        let oText = "Outside v0.";
        const write = async (): Promise<void> => {
          await workspace.file(
            SC_FILE,
            scSpec(pOwn, pAttrs, cText, cAttrs, oText),
          );
        };

        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        pOwn = "Parent own v1."; // p `changed` relative to the baseline
        await write();
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          `${prefix} \`review create --base <baseline> --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [`subtree-coherence ${SC_P}`],
          `${prefix}: the top-level changed parent yields exactly its ` +
            `subtree-coherence item — no non-root ancestor exists for ` +
            `parent-consistency items (SPEC 10.5)`,
        );
        const itemId = requireRow(status, "subtree-coherence", SC_P, prefix).id;
        await resolveOk(
          product,
          workspace,
          "s",
          itemId,
          "no-change",
          `${prefix} initial \`review resolve s <item> --status no-change\``,
        );

        await runSensitivityArms(
          product,
          workspace,
          "s",
          itemId,
          [
            {
              label:
                "text edit inside the scope subtree (a scope node's subtreeHash)",
              apply: async () => {
                cText = "Child text v1.";
                await write();
              },
              invalidates: true,
              changed: [
                { node: SC_PC, hash: "subtreeHash" },
                { node: SC_P, hash: "subtreeHash" },
              ],
              unchanged: [
                { node: SC_P, hash: "metadataHash" },
                { node: SC_PC, hash: "metadataHash" },
              ],
            },
            {
              label: "metadata-only edit on the scope root (its metadataHash)",
              apply: async () => {
                pAttrs = ' tags="pt"';
                await write();
              },
              invalidates: true,
              changed: [{ node: SC_P, hash: "metadataHash" }],
              unchanged: [
                { node: SC_P, hash: "subtreeHash" },
                { node: SC_PC, hash: "subtreeHash" },
                { node: SC_PC, hash: "metadataHash" },
              ],
            },
            {
              label:
                "metadata-only edit on a descendant scope node — it changes " +
                "no subtreeHash and MUST still invalidate (the relevant " +
                "metadataHash is each scope node's)",
              apply: async () => {
                cAttrs = ' tags="ct"';
                await write();
              },
              invalidates: true,
              changed: [{ node: SC_PC, hash: "metadataHash" }],
              unchanged: [
                { node: SC_P, hash: "subtreeHash" },
                { node: SC_PC, hash: "subtreeHash" },
                { node: SC_P, hash: "metadataHash" },
              ],
            },
            {
              label: "control: an edit outside the scope subtree",
              apply: async () => {
                oText = "Outside v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: SC_O, hash: "subtreeHash" }],
              unchanged: [
                { node: SC_P, hash: "subtreeHash" },
                { node: SC_P, hash: "metadataHash" },
                { node: SC_PC, hash: "subtreeHash" },
                { node: SC_PC, hash: "metadataHash" },
              ],
            },
          ],
          prefix,
        );
      },
    );

    // --- parent-consistency ------------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [PC_FILE]: pcSpec("Alpha own v0.", "", "Deep leaf v0.", "Other v0."),
      },
      async (workspace) => {
        const prefix = "T10.4-1 parent-consistency";
        let aOwn = "Alpha own v0.";
        let aAttrs = "";
        let dText = "Deep leaf v0.";
        let oText = "Other v0.";
        const write = async (): Promise<void> => {
          await workspace.file(PC_FILE, pcSpec(aOwn, aAttrs, dText, oText));
        };

        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        dText = "Deep leaf v1."; // a.k.d `changed`
        await write();
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          `${prefix} \`review create --base <baseline> --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `parent-consistency ${PC_A}`,
            `parent-consistency ${PC_AK}`,
            `subtree-coherence ${PC_AKD}`,
          ].sort(),
          `${prefix}: the deep leaf edit yields its subtree-coherence item ` +
            `plus one parent-consistency item per non-root ancestor ` +
            `(SPEC 10.5)`,
        );
        const dId = requireRow(status, "subtree-coherence", PC_AKD, prefix).id;
        const kId = requireRow(status, "parent-consistency", PC_AK, prefix).id;
        const aId = requireRow(status, "parent-consistency", PC_A, prefix).id;
        // Bottom-up resolves: each parent-consistency item is blocked by the
        // item of its child on the changed branch (SPEC 10.5).
        for (const [id, label] of [
          [dId, "a.k.d subtree-coherence"],
          [kId, "a.k parent-consistency"],
          [aId, "a parent-consistency"],
        ] as const) {
          await resolveOk(
            product,
            workspace,
            "s",
            id,
            "no-change",
            `${prefix} initial resolve of the ${label} item (bottom-up, SPEC 10.5)`,
          );
        }

        await runSensitivityArms(
          product,
          workspace,
          "s",
          aId,
          [
            {
              label:
                "deep text edit under the context child (a context node's subtreeHash)",
              apply: async () => {
                dText = "Deep leaf v2.";
                await write();
              },
              invalidates: true,
              changed: [{ node: PC_AK, hash: "subtreeHash" }],
              unchanged: [
                { node: PC_A, hash: "ownHash" },
                { node: PC_A, hash: "metadataHash" },
              ],
              // The same edit invalidates the chain below a; an invalidated
              // blocker re-blocks its dependents (SPEC 10.3), so re-resolve
              // bottom-up.
              reresolve: [dId, kId, aId],
            },
            {
              label: "metadata edit of the scope node (its metadataHash)",
              apply: async () => {
                aAttrs = ' tags="at"';
                await write();
              },
              invalidates: true,
              changed: [{ node: PC_A, hash: "metadataHash" }],
              unchanged: [
                { node: PC_A, hash: "ownHash" },
                { node: PC_AK, hash: "subtreeHash" },
              ],
            },
            {
              label: "own-text edit of the scope node (its ownHash)",
              apply: async () => {
                aOwn = "Alpha own v1.";
                await write();
              },
              invalidates: true,
              changed: [{ node: PC_A, hash: "ownHash" }],
              unchanged: [
                { node: PC_A, hash: "metadataHash" },
                { node: PC_AK, hash: "subtreeHash" },
              ],
            },
            {
              label: "control: an edit in a sibling subtree of the scope node",
              apply: async () => {
                oText = "Other v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: PC_O, hash: "subtreeHash" }],
              unchanged: [
                { node: PC_A, hash: "ownHash" },
                { node: PC_A, hash: "metadataHash" },
                { node: PC_AK, hash: "subtreeHash" },
              ],
            },
          ],
          prefix,
        );
      },
    );

    // --- dependency-consistency --------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [DC_FILE]: dcSpec(
          "Dep own v0.",
          "",
          "Target own v0.",
          "Target child v0.",
          "Unrelated v0.",
        ),
      },
      async (workspace) => {
        const prefix = "T10.4-1 dependency-consistency";
        let depOwn = "Dep own v0.";
        let depAttrs = "";
        let tOwn = "Target own v0.";
        let tcText = "Target child v0.";
        let uText = "Unrelated v0.";
        const write = async (): Promise<void> => {
          await workspace.file(
            DC_FILE,
            dcSpec(depOwn, depAttrs, tOwn, tcText, uText),
          );
        };

        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        tOwn = "Target own v1."; // t `changed`: dep's target effectiveHash moves
        await write();
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          `${prefix} \`review create --base <baseline> --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `dependency-consistency ${DC_DEP}`,
            `subtree-coherence ${DC_T}`,
          ].sort(),
          `${prefix}: the target's own-text edit yields its ` +
            `subtree-coherence item and the depender's ` +
            `dependency-consistency item (SPEC 10.5)`,
        );
        const itemId = requireRow(
          status,
          "dependency-consistency",
          DC_DEP,
          prefix,
        ).id;
        await resolveOk(
          product,
          workspace,
          "s",
          itemId,
          "no-change",
          `${prefix} initial \`review resolve s <item> --status no-change\` ` +
            `(dependency-consistency items have empty blockedBy, SPEC 10.5)`,
        );

        await runSensitivityArms(
          product,
          workspace,
          "s",
          itemId,
          [
            {
              label: "own-text edit of the scope node (its ownHash)",
              apply: async () => {
                depOwn = "Dep own v1.";
                await write();
              },
              invalidates: true,
              changed: [{ node: DC_DEP, hash: "ownHash" }],
              unchanged: [
                { node: DC_DEP, hash: "metadataHash" },
                { node: DC_T, hash: "subtreeHash" },
              ],
            },
            {
              label: "metadata edit of the scope node (its metadataHash)",
              apply: async () => {
                depAttrs = ' tags="dt"';
                await write();
              },
              invalidates: true,
              changed: [{ node: DC_DEP, hash: "metadataHash" }],
              unchanged: [
                { node: DC_DEP, hash: "ownHash" },
                { node: DC_T, hash: "subtreeHash" },
              ],
            },
            {
              label:
                "text edit under the upstream target in context (target subtreeHash)",
              apply: async () => {
                tcText = "Target child v1.";
                await write();
              },
              invalidates: true,
              changed: [{ node: DC_T, hash: "subtreeHash" }],
              unchanged: [
                { node: DC_DEP, hash: "ownHash" },
                { node: DC_DEP, hash: "metadataHash" },
              ],
            },
            {
              label: "control: an edit to an unrelated node",
              apply: async () => {
                uText = "Unrelated v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: DC_U, hash: "subtreeHash" }],
              unchanged: [
                { node: DC_DEP, hash: "ownHash" },
                { node: DC_DEP, hash: "metadataHash" },
                { node: DC_T, hash: "subtreeHash" },
              ],
            },
          ],
          prefix,
        );
      },
    );

    // --- metadata-consistency ----------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [MC_FILE]: mcSpec("m0", "Em text v0.") },
      async (workspace) => {
        const prefix = "T10.4-1 metadata-consistency";
        let mTags = "m0";
        let mText = "Em text v0.";
        const write = async (): Promise<void> => {
          await workspace.file(MC_FILE, mcSpec(mTags, mText));
        };

        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        mTags = "m1"; // m `metadata-changed`
        await write();
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the tag edit`,
        );
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          `${prefix} \`review create --base <baseline> --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [`metadata-consistency ${MC_M}`],
          `${prefix}: a tags-only change yields exactly the ` +
            `metadata-consistency item — no node is changed (SPEC 5.6, 10.5)`,
        );
        const itemId = requireRow(
          status,
          "metadata-consistency",
          MC_M,
          prefix,
        ).id;
        await resolveOk(
          product,
          workspace,
          "s",
          itemId,
          "no-change",
          `${prefix} initial \`review resolve s <item> --status no-change\``,
        );

        await runSensitivityArms(
          product,
          workspace,
          "s",
          itemId,
          [
            {
              label: "metadata edit of the scope node (metadataHash only)",
              apply: async () => {
                mTags = "m2";
                await write();
              },
              invalidates: true,
              changed: [{ node: MC_M, hash: "metadataHash" }],
              unchanged: [{ node: MC_M, hash: "subtreeHash" }],
            },
            {
              label:
                "control: a text edit of the scope node does not invalidate " +
                "(only the metadataHash is relevant to this kind)",
              apply: async () => {
                mText = "Em text v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: MC_M, hash: "subtreeHash" }],
              unchanged: [{ node: MC_M, hash: "metadataHash" }],
            },
          ],
          prefix,
        );
      },
    );

    // --- code-impact --------------------------------------------------------
    await withWorkspace(
      SPECS_CODE_CONFIG,
      {
        [CI_FILE]: ciSpec("Target v0.", "Upstream v0.", "Watcher v0."),
        [CI_CODE]: CI_CODE_SOURCE,
      },
      async (workspace) => {
        const prefix = "T10.4-1 code-impact";
        let tText = "Target v0.";
        let upText = "Upstream v0.";
        let wText = "Watcher v0.";
        const write = async (): Promise<void> => {
          await workspace.file(CI_FILE, ciSpec(tText, upText, wText));
        };

        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        tText = "Target v1."; // t `changed`: src/ref.ts directly impacted
        await write();
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          `${prefix} \`review create --base <baseline> --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [`code-impact ${CI_CODE}`, `subtree-coherence ${CI_T}`].sort(),
          `${prefix}: the target's edit yields its subtree-coherence item ` +
            `and one code-impact item for the impacted location (SPEC 9.2, 10.5)`,
        );
        const itemId = requireRow(status, "code-impact", CI_CODE, prefix).id;
        await resolveOk(
          product,
          workspace,
          "s",
          itemId,
          "no-change",
          `${prefix} initial \`review resolve s <item> --status no-change\` ` +
            `(code-impact items have empty blockedBy, SPEC 10.5)`,
        );

        await runSensitivityArms(
          product,
          workspace,
          "s",
          itemId,
          [
            {
              label: "text edit of an impact-edge target (target subtreeHash)",
              apply: async () => {
                tText = "Target v2.";
                await write();
              },
              invalidates: true,
              changed: [{ node: CI_T, hash: "subtreeHash" }],
              unchanged: [{ node: CI_T, hash: "metadataHash" }],
            },
            {
              label:
                "upstream edit changing only the target's effectiveHash " +
                "(its subtreeHash stays put)",
              apply: async () => {
                upText = "Upstream v1.";
                await write();
              },
              invalidates: true,
              changed: [{ node: CI_T, hash: "effectiveHash" }],
              unchanged: [{ node: CI_T, hash: "subtreeHash" }],
            },
            {
              label:
                "control: an edit to a node that is no impact-edge target " +
                "and upstream of none",
              apply: async () => {
                wText = "Watcher v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: CI_W, hash: "subtreeHash" }],
              unchanged: [
                { node: CI_T, hash: "subtreeHash" },
                { node: CI_T, hash: "effectiveHash" },
              ],
            },
          ],
          prefix,
        );
      },
    );

    // --- uncovered-requirement ----------------------------------------------
    await withWorkspace(
      COVERAGE_CONFIG,
      { [UR_FILE]: urSpec("", "You leaf v0.", "Elsewhere v0.") },
      async (workspace) => {
        const prefix = "T10.4-1 uncovered-requirement";
        let uAttrs = "";
        let uText = "You leaf v0.";
        let eText = "Elsewhere v0.";
        const write = async (): Promise<void> => {
          await workspace.file(UR_FILE, urSpec(uAttrs, uText, eText));
        };

        await buildOk(product, workspace, `${prefix} \`build\``);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--coverage", "p", "--name", "s"],
          0,
          `${prefix} \`review create --coverage p --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `uncovered-requirement ${UR_E}`,
            `uncovered-requirement ${UR_U}`,
          ].sort(),
          `${prefix}: both uncovered required leaves get an ` +
            `uncovered-requirement item (SPEC 8.1, 10.7)`,
        );
        const itemId = requireRow(
          status,
          "uncovered-requirement",
          UR_U,
          prefix,
        ).id;
        await resolveOk(
          product,
          workspace,
          "s",
          itemId,
          "no-change",
          `${prefix} initial \`review resolve s <item> --status no-change\` ` +
            `(uncovered-requirement items have empty blockedBy, SPEC 10.7)`,
        );

        await runSensitivityArms(
          product,
          workspace,
          "s",
          itemId,
          [
            {
              label: "text edit in the scope node's subtree (its subtreeHash)",
              apply: async () => {
                uText = "You leaf v1.";
                await write();
              },
              invalidates: true,
              changed: [{ node: UR_U, hash: "subtreeHash" }],
              unchanged: [{ node: UR_U, hash: "metadataHash" }],
            },
            {
              label: "metadata edit of the scope node (its metadataHash)",
              apply: async () => {
                uAttrs = ' tags="ut"';
                await write();
              },
              invalidates: true,
              changed: [{ node: UR_U, hash: "metadataHash" }],
              unchanged: [{ node: UR_U, hash: "subtreeHash" }],
            },
            {
              label: "control: an edit elsewhere",
              apply: async () => {
                eText = "Elsewhere v1.";
                await write();
              },
              invalidates: false,
              changed: [{ node: UR_E, hash: "subtreeHash" }],
              unchanged: [
                { node: UR_U, hash: "subtreeHash" },
                { node: UR_U, hash: "metadataHash" },
              ],
            },
          ],
          prefix,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.4-2 — presence changes
// ---------------------------------------------------------------------------

const T2_FILE = "specs/X.mdx";
const T2_X = "specs/X.mdx#x";
const T2_Y = "specs/X.mdx#y";
const T2_ROOT = "specs/X.mdx";

function t2Spec(withX: boolean, yText: string): string {
  const lines = withX ? ['<S id="x">', "Ex text.", "</S>", ""] : [];
  return [...lines, '<S id="y">', yText, "</S>", ""].join("\n");
}

const T10_4_2 = defineProductTest({
  id: "T10.4-2",
  title:
    "presence changes: deleting a scope node after resolve invalidates the resolution (presence recorded present, node now absent); the item stays resolvable against absence, and a node already absent at resolve time does not invalidate by remaining absent across an unrelated edit — deletion review stays resolvable; restoring the node invalidates the resolution recorded against absence (presence changed in the other direction) (SPEC 10.2, 10.3, 10.4)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T2_FILE]: t2Spec(true, "Wye text v0.") },
      async (workspace) => {
        await buildOk(product, workspace, "T10.4-2 `build`");
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          "T10.4-2 `review create --strategy audit --name s`",
        );
        const status = await sessionStatus(product, workspace, "s", "T10.4-2");
        assertSameJson(
          kindScopeSet(status),
          [
            `subtree-coherence ${T2_ROOT}`,
            `subtree-coherence ${T2_X}`,
            `subtree-coherence ${T2_Y}`,
          ].sort(),
          "T10.4-2: audit creates one subtree-coherence item per node, " +
            "root included (SPEC 10.6)",
        );
        const xId = requireRow(status, "subtree-coherence", T2_X, "T10.4-2").id;

        await resolveOk(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-2 `review resolve s <x item> --status no-change` (present)",
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-2 sanity — the fresh resolution matches the graph",
        );

        // Deleting the scope node after resolve invalidates.
        await workspace.file(T2_FILE, t2Spec(false, "Wye text v0."));
        await buildOk(product, workspace, "T10.4-2 `build` after deleting x");
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "invalidated",
          "T10.4-2 after the deletion — a presence change in either " +
            "direction invalidates (SPEC 10.4)",
        );
        const afterLoss = await showItem(
          product,
          workspace,
          "s",
          xId,
          "T10.4-2 post-deletion read",
        );
        if (
          afterLoss.scope.node !== T2_X ||
          afterLoss.scope.present !== false
        ) {
          fail(
            `T10.4-2 post-deletion \`review show\`: the deleted scope node ` +
              `is presented under its identity with current presence ` +
              `(SPEC 10.4, 10.7); expected {node: ${JSON.stringify(T2_X)}, ` +
              `present: false}, got ${JSON.stringify(afterLoss.scope)}`,
          );
        }

        // Deletion review stays resolvable: resolve against absence.
        await resolveOk(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-2 `review resolve s <x item> --status no-change` against " +
            "absence — deletion review stays resolvable (SPEC 10.4)",
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-2 after resolving against absence",
        );

        // Remaining absent does not invalidate — even across an unrelated
        // edit that moves the graph.
        await workspace.file(T2_FILE, t2Spec(false, "Wye text v1."));
        await buildOk(product, workspace, "T10.4-2 `build` after the y edit");
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-2 after an unrelated edit with x still absent — a node " +
            "already absent at resolve time does not invalidate by " +
            "remaining absent (SPEC 10.4)",
        );

        // Restoring the node invalidates the resolution recorded against
        // absence.
        await workspace.file(T2_FILE, t2Spec(true, "Wye text v1."));
        await buildOk(product, workspace, "T10.4-2 `build` after restoring x");
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "invalidated",
          "T10.4-2 after restoring x — restoring a node invalidates a " +
            "resolution recorded against absence (SPEC 10.4)",
        );
        const afterRestore = await showItem(
          product,
          workspace,
          "s",
          xId,
          "T10.4-2 post-restore read",
        );
        if (
          afterRestore.scope.node !== T2_X ||
          afterRestore.scope.present !== true
        ) {
          fail(
            `T10.4-2 post-restore \`review show\`: the restored scope node ` +
              `is presented under its identity with current presence ` +
              `(SPEC 10.4, 10.7); expected {node: ${JSON.stringify(T2_X)}, ` +
              `present: true}, got ${JSON.stringify(afterRestore.scope)}`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.4-3 — context-set change
// ---------------------------------------------------------------------------

const T3_FILE = "specs/A.mdx";
const T3_A = "specs/A.mdx#a";
const T3_AK = "specs/A.mdx#a.k";
const T3_AS = "specs/A.mdx#a.s";

function t3Spec(kText: string, sText: string): string {
  return [
    '<S id="a">',
    "Alpha own text.",
    "",
    '<S id="a.k">',
    kText,
    "</S>",
    "",
    '<S id="a.s">',
    sText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const T10_4_3 = defineProductTest({
  id: "T10.4-3",
  title:
    "context-set change invalidates without any recorded hash changing: after resolving a parent-consistency item whose context is one changed branch, a text edit in a sibling branch under its scope makes the generators derive a two-branch context set — the item is reported invalidated although the scope node's ownHash and metadataHash and the recorded context node's subtreeHash are all byte-unchanged (asserted as premises via query node), while the sibling branch's own resolved item stays resolved (SPEC 5.5, 10.4, 10.5)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T3_FILE]: t3Spec("Kay text v0.", "Ess text v0.") },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(T3_FILE, t3Spec("Kay text v1.", "Ess text v0."));
        await buildOk(product, workspace, "T10.4-3 `build` after the a.k edit");
        await expectExit(
          product,
          workspace,
          ["review", "create", "--base", base, "--name", "s"],
          0,
          "T10.4-3 `review create --base <baseline> --name s`",
        );
        const status = await sessionStatus(product, workspace, "s", "T10.4-3");
        assertSameJson(
          kindScopeSet(status),
          [`parent-consistency ${T3_A}`, `subtree-coherence ${T3_AK}`].sort(),
          "T10.4-3: the single changed branch yields a.k's " +
            "subtree-coherence item and a's parent-consistency item " +
            "(SPEC 10.5)",
        );
        const kId = requireRow(
          status,
          "subtree-coherence",
          T3_AK,
          "T10.4-3",
        ).id;
        const aId = requireRow(
          status,
          "parent-consistency",
          T3_A,
          "T10.4-3",
        ).id;
        await resolveOk(
          product,
          workspace,
          "s",
          kId,
          "no-change",
          "T10.4-3 resolve of the a.k subtree-coherence item (the blocker)",
        );
        await resolveOk(
          product,
          workspace,
          "s",
          aId,
          "no-change",
          "T10.4-3 resolve of the a parent-consistency item",
        );

        // Premise: the recorded context set is the single changed branch.
        const resolved = await showItem(
          product,
          workspace,
          "s",
          aId,
          "T10.4-3 post-resolve read",
        );
        assertSameJson(
          identitySet(resolved.context),
          [T3_AK],
          "T10.4-3 staging premise: the resolved parent-consistency item's " +
            "context is the one changed branch — a's child on it (SPEC 10.5)",
        );

        // Captures of every recorded relevant hash (SPEC 10.4:
        // parent-consistency = ownHash and metadataHash of the scope node,
        // subtreeHash of each context node).
        const before = await captureHashes(
          product,
          workspace,
          [T3_A, T3_AK, T3_AS],
          "T10.4-3 pre-edit capture",
        );

        // The context-set change: a new changed branch under a.
        await workspace.file(T3_FILE, t3Spec("Kay text v1.", "Ess text v1."));
        await buildOk(product, workspace, "T10.4-3 `build` after the a.s edit");
        const after = await captureHashes(
          product,
          workspace,
          [T3_A, T3_AK, T3_AS],
          "T10.4-3 post-edit capture",
        );
        for (const [node, hash] of [
          [T3_A, "ownHash"],
          [T3_A, "metadataHash"],
          [T3_AK, "subtreeHash"],
        ] as const) {
          const beforeValue = before.get(node)?.[hash];
          const afterValue = after.get(node)?.[hash];
          if (beforeValue !== afterValue) {
            fail(
              `T10.4-3 staging premise: the sibling-branch edit must leave ` +
                `${node}'s ${hash} unchanged (SPEC 5.5) so the invalidation ` +
                `can only come from the context-set change; got ` +
                `${JSON.stringify(beforeValue)} -> ${JSON.stringify(afterValue)}`,
            );
          }
        }
        if (before.get(T3_AS)?.subtreeHash === after.get(T3_AS)?.subtreeHash) {
          fail(
            "T10.4-3 staging premise: the a.s edit must change a.s's " +
              "subtreeHash (SPEC 5.5) — otherwise no new changed branch " +
              "exists and the arm is vacuous",
          );
        }

        // The item is invalidated purely by the generator-derived context
        // set gaining the new branch (SPEC 10.4); the sibling branch's own
        // resolved item is untouched.
        await expectItemStatus(
          product,
          workspace,
          "s",
          aId,
          "invalidated",
          "T10.4-3 after the sibling-branch edit — a change that alters the " +
            "item's generator-derived context set invalidates without any " +
            "recorded hash changing (SPEC 10.4)",
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          kId,
          "no-change",
          "T10.4-3 the a.k item's recorded state and context (its ancestor " +
            "chain) are untouched by the a.s edit — it stays resolved " +
            "(SPEC 10.4, 10.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.4-4 — rename immunity
// ---------------------------------------------------------------------------

// Part 1 (rename): p with descendant p.c, plus q — rename p -> pp maps the
// scoped node of p's item and both a scope and a context node of p.c's item.
const T4R_FILE = "specs/R.mdx";
const T4R_ROOT = "specs/R.mdx";
const T4R_P = "specs/R.mdx#p";
const T4R_PC = "specs/R.mdx#p.c";
const T4R_Q = "specs/R.mdx#q";
const T4R_PP = "specs/R.mdx#pp";
const T4R_PPC = "specs/R.mdx#pp.c";

const T4R_SOURCE = [
  '<S id="p">',
  "Parent own text.",
  "",
  '<S id="p.c">',
  "Child text.",
  "</S>",
  "</S>",
  "",
  '<S id="q">',
  "Cue text.",
  "</S>",
  "",
].join("\n");

// The manual deletion of pp.c after the rename (SPEC 6.6: a plain edit).
const T4R_WITHOUT_CHILD = [
  '<S id="pp">',
  "Parent own text.",
  "</S>",
  "",
  '<S id="q">',
  "Cue text.",
  "</S>",
  "",
].join("\n");

// Part 2 (file-move order flip): specs/b.mdx before specs/d.mdx in byte
// order; moving d.mdx to a.mdx flips which file sorts first.
const T4M_B_FILE = "specs/b.mdx";
const T4M_D_FILE = "specs/d.mdx";
const T4M_A_FILE = "specs/a.mdx";
const T4M_M = "specs/b.mdx#m";
const T4M_R = "specs/b.mdx#r";
const T4M_N = "specs/d.mdx#n";
const T4M_W = "specs/d.mdx#w";
const T4M_AN = "specs/a.mdx#n";
const T4M_AW = "specs/a.mdx#w";

const T4M_B_SOURCE = [
  '<S id="m">',
  "Emm text.",
  "</S>",
  "",
  '<S id="r">',
  "Arr text.",
  "</S>",
  "",
].join("\n");

const T4M_D_SOURCE = [
  '<S id="n">',
  "Enn text.",
  "</S>",
  "",
  '<S id="w">',
  "Dub text.",
  "</S>",
  "",
].join("\n");

// Part 3 (reintroduction): top-level leaves a and s; rename a -> b, then a
// new section reintroduces the identity `a` (a fresh canonical chain, 5.4).
const T4I_FILE = "specs/E.mdx";
const T4I_ROOT = "specs/E.mdx";
const T4I_A = "specs/E.mdx#a";
const T4I_B = "specs/E.mdx#b";
const T4I_S = "specs/E.mdx#s";

const T4I_SOURCE = [
  '<S id="a">',
  "Aye original text.",
  "</S>",
  "",
  '<S id="s">',
  "Ess text.",
  "</S>",
  "",
].join("\n");

const T4I_NEW_SECTION = [
  "",
  '<S id="a">',
  "Fresh reintroduced text.",
  "</S>",
  "",
].join("\n");

const T10_4_4 = defineProductTest({
  id: "T10.4-4",
  title:
    "rename immunity: `xspec rename` on scoped and context nodes duplicates no item, loses no status, and invalidates nothing by the identity mapping alone — reads present recorded nodes under current identities, mapped forward through the journal, for present and absent nodes alike (a post-rename manual deletion presents the recorded node absent under its mapped identity); a journaled file `move` that flips which of two same-kind items' scope file paths sorts first flips their order in `status`, `next`, and `export` with statuses and recorded state intact; reintroduction arm: after resolving a's item, renaming a to b, authoring a new top-level section a, and resolving s's item `updated` (re-derivation), the item recorded against old-a keeps its id and resolved status under scope b, new-a's item enters as a distinct unresolved item, and the root item's blockedBy gains it — canonical identities with the journal-position pairing, never walked-back identity strings (SPEC 5.4, 6.2, 6.4, 6.5, 10.2, 10.4, 10.5, 10.6)",
  timeoutMs: 360_000,
  run: async (product) => {
    // --- rename on scoped and context nodes, present and absent -------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T4R_FILE]: T4R_SOURCE },
      async (workspace) => {
        const prefix = "T10.4-4 rename arm";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          `${prefix} \`review create --strategy audit --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `subtree-coherence ${T4R_ROOT}`,
            `subtree-coherence ${T4R_P}`,
            `subtree-coherence ${T4R_PC}`,
            `subtree-coherence ${T4R_Q}`,
          ].sort(),
          `${prefix}: audit creates one item per node (SPEC 10.6)`,
        );
        const rootId = requireRow(
          status,
          "subtree-coherence",
          T4R_ROOT,
          prefix,
        ).id;
        const pId = requireRow(status, "subtree-coherence", T4R_P, prefix).id;
        const pcId = requireRow(status, "subtree-coherence", T4R_PC, prefix).id;
        const qId = requireRow(status, "subtree-coherence", T4R_Q, prefix).id;

        // Resolve bottom-up (audit blocking, SPEC 10.6) with two distinct
        // resolved statuses so status preservation is discriminating.
        await resolveOk(
          product,
          workspace,
          "s",
          pcId,
          "no-change",
          `${prefix} resolve of p.c's item`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          pId,
          "no-change",
          `${prefix} resolve of p's item (unblocked once p.c resolved)`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          qId,
          "skipped",
          `${prefix} resolve of q's item`,
        );

        // Recorded hash values, for the recorded-state-intact check: 6.2
        // purity keeps them byte-identical across the rename.
        const pcHashBefore = (
          await queryNode(product, workspace, T4R_PC, `${prefix} pre-rename`)
        ).hashes.subtreeHash;

        await expectExit(
          product,
          workspace,
          ["rename", T4R_FILE, "p", "pp"],
          0,
          `${prefix} \`rename specs/R.mdx p pp\` (SPEC 6.4)`,
        );

        // Purity premise (SPEC 6.2): the renamed node's hashes are
        // byte-identical under its new identity.
        const pcHashAfter = (
          await queryNode(product, workspace, T4R_PPC, `${prefix} post-rename`)
        ).hashes.subtreeHash;
        if (pcHashAfter !== pcHashBefore) {
          fail(
            `${prefix}: cross-check with SPEC 6.2 — \`rename\` is pure and ` +
              `must leave every hash byte-identical; p.c's subtreeHash was ` +
              `${JSON.stringify(pcHashBefore)}, pp.c reports ` +
              JSON.stringify(pcHashAfter),
          );
        }

        // No duplicates, no lost statuses, nothing invalidated; scopes are
        // presented under current identities.
        const afterRename = await sessionStatus(
          product,
          workspace,
          "s",
          `${prefix} post-rename`,
        );
        assertSameJson(
          afterRename.items
            .map((row) => [row.id, row.kind, row.scope, row.status])
            .sort(),
          (
            [
              [rootId, "subtree-coherence", T4R_ROOT, "unresolved"],
              [pId, "subtree-coherence", T4R_PP, "no-change"],
              [pcId, "subtree-coherence", T4R_PPC, "no-change"],
              [qId, "subtree-coherence", T4R_Q, "skipped"],
            ] as const
          )
            .map((row) => [...row])
            .sort(),
          `${prefix} post-rename \`status\`: the identity mapping duplicates ` +
            `no item, discards no status, and by itself invalidates nothing; ` +
            `reads present recorded nodes under current identities ` +
            `(SPEC 10.4, 6.2)`,
        );

        // The context chain is mapped forward too, and the recorded state
        // still holds the (unchanged) recorded hash value.
        const shownAfterRename = await showItem(
          product,
          workspace,
          "s",
          pcId,
          `${prefix} post-rename`,
        );
        if (
          shownAfterRename.scope.node !== T4R_PPC ||
          shownAfterRename.scope.present !== true
        ) {
          fail(
            `${prefix} post-rename \`show\`: the recorded scope node is ` +
              `presented under its current identity (SPEC 10.4); expected ` +
              `{node: ${JSON.stringify(T4R_PPC)}, present: true}, got ` +
              JSON.stringify(shownAfterRename.scope),
          );
        }
        assertSameJson(
          identitySet(shownAfterRename.context),
          [T4R_ROOT, T4R_PP].sort(),
          `${prefix} post-rename \`show\`: the recorded context (the ` +
            `ancestor chain) is presented under current identities, the ` +
            `renamed parent mapped forward (SPEC 10.4, 10.6)`,
        );
        assertRecordedHolds(
          shownAfterRename.current,
          pcHashBefore,
          "the recorded subtreeHash of the (renamed) scope node",
          `${prefix} post-rename \`show\` — recorded state intact`,
        );

        // Absent node under a mapped identity: delete pp.c manually
        // (SPEC 6.6), then reads present the recorded node absent under its
        // current (journal-mapped) identity.
        await workspace.file(T4R_FILE, T4R_WITHOUT_CHILD);
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the manual deletion of pp.c`,
        );
        const shownAfterLoss = await showItem(
          product,
          workspace,
          "s",
          pcId,
          `${prefix} post-deletion`,
        );
        if (
          shownAfterLoss.scope.node !== T4R_PPC ||
          shownAfterLoss.scope.present !== false
        ) {
          fail(
            `${prefix} post-deletion \`show\`: reads present recorded nodes ` +
              `under current identities, for present and absent nodes alike ` +
              `(SPEC 10.4) — the node recorded as p.c maps forward to pp.c ` +
              `and is now absent; expected {node: ${JSON.stringify(T4R_PPC)}, ` +
              `present: false}, got ${JSON.stringify(shownAfterLoss.scope)}`,
          );
        }
        await expectItemStatus(
          product,
          workspace,
          "s",
          pcId,
          "invalidated",
          `${prefix} post-deletion — the presence change (not the earlier ` +
            `identity mapping) invalidates (SPEC 10.4)`,
        );
      },
    );

    // --- journaled file move flips item order --------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T4M_B_FILE]: T4M_B_SOURCE, [T4M_D_FILE]: T4M_D_SOURCE },
      async (workspace) => {
        const prefix = "T10.4-4 move arm";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          `${prefix} \`review create --strategy audit --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        const mId = requireRow(status, "subtree-coherence", T4M_M, prefix).id;
        const rId = requireRow(status, "subtree-coherence", T4M_R, prefix).id;
        const nId = requireRow(status, "subtree-coherence", T4M_N, prefix).id;
        const wId = requireRow(status, "subtree-coherence", T4M_W, prefix).id;
        const bRootId = requireRow(
          status,
          "subtree-coherence",
          T4M_B_FILE,
          prefix,
        ).id;
        const dRootId = requireRow(
          status,
          "subtree-coherence",
          T4M_D_FILE,
          prefix,
        ).id;

        // Distinct resolved statuses on the second leaf of each file; m and
        // n stay unresolved as the `next` order witnesses.
        await resolveOk(
          product,
          workspace,
          "s",
          rId,
          "no-change",
          `${prefix} resolve of r's item`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          wId,
          "skipped",
          `${prefix} resolve of w's item`,
        );

        const nHash = (
          await queryNode(product, workspace, T4M_N, `${prefix} pre-move`)
        ).hashes.subtreeHash;
        const wHash = (
          await queryNode(product, workspace, T4M_W, `${prefix} pre-move`)
        ).hashes.subtreeHash;

        // Pre-move order: b.mdx sorts before d.mdx (byte order, SPEC 10.6).
        const preStatus = await sessionStatus(
          product,
          workspace,
          "s",
          `${prefix} pre-move`,
        );
        assertPrecedes(
          preStatus.items,
          mId,
          nId,
          `${prefix} pre-move \`status\`: specs/b.mdx sorts before specs/d.mdx`,
        );
        const preExportLabel = `${prefix} pre-move \`review export s --json\``;
        const preExport = decodeExportReport(
          await runJson(
            product,
            workspace,
            ["review", "export", "s", "--json"],
            preExportLabel,
          ),
          preExportLabel,
        );
        assertPrecedes(preExport.items, mId, nId, preExportLabel);
        const preNextLabel = `${prefix} pre-move \`review next s --json\``;
        const preNext = decodeNextReport(
          await runJson(
            product,
            workspace,
            ["review", "next", "s", "--json"],
            preNextLabel,
          ),
          preNextLabel,
        );
        if (preNext.fullyResolved || preNext.item === undefined) {
          fail(`${preNextLabel}: unresolved items remain (SPEC 10.7)`);
        }
        if (preNext.item.id !== mId) {
          fail(
            `${preNextLabel}: the first needing-review unblocked item is m's ` +
              `— specs/b.mdx sorts first, its root item is blocked, and m ` +
              `precedes r in document order (SPEC 10.6, 10.7); expected ` +
              `${mId}, got ${preNext.item.id}`,
          );
        }

        // The journaled file move: specs/d.mdx -> specs/a.mdx flips which
        // scope file path sorts first.
        await expectExit(
          product,
          workspace,
          ["move", T4M_D_FILE, T4M_A_FILE],
          0,
          `${prefix} \`move specs/d.mdx specs/a.mdx\` (SPEC 6.5, file form)`,
        );

        // Purity premise (SPEC 6.2): hashes byte-identical under the moved
        // identities.
        const nHashAfter = (
          await queryNode(product, workspace, T4M_AN, `${prefix} post-move`)
        ).hashes.subtreeHash;
        const wHashAfter = (
          await queryNode(product, workspace, T4M_AW, `${prefix} post-move`)
        ).hashes.subtreeHash;
        if (nHashAfter !== nHash || wHashAfter !== wHash) {
          fail(
            `${prefix}: cross-check with SPEC 6.2 — the file form of ` +
              `\`move\` is pure and must leave every hash byte-identical; ` +
              `n: ${JSON.stringify(nHash)} -> ${JSON.stringify(nHashAfter)}, ` +
              `w: ${JSON.stringify(wHash)} -> ${JSON.stringify(wHashAfter)}`,
          );
        }

        // Statuses and recorded state intact; scopes mapped forward; order
        // flipped in status, next, and export.
        const postStatus = await sessionStatus(
          product,
          workspace,
          "s",
          `${prefix} post-move`,
        );
        assertSameJson(
          postStatus.items.map((row) => [row.id, row.scope, row.status]).sort(),
          (
            [
              [bRootId, T4M_B_FILE, "unresolved"],
              [mId, T4M_M, "unresolved"],
              [rId, T4M_R, "no-change"],
              [dRootId, T4M_A_FILE, "unresolved"],
              [nId, T4M_AN, "unresolved"],
              [wId, T4M_AW, "skipped"],
            ] as const
          )
            .map((row) => [...row])
            .sort(),
          `${prefix} post-move \`status\`: same six items, statuses intact, ` +
            `nothing invalidated, the moved file's scopes presented under ` +
            `their current identities (SPEC 10.4, 6.2, 6.5)`,
        );
        assertPrecedes(
          postStatus.items,
          nId,
          mId,
          `${prefix} post-move \`status\`: specs/a.mdx now sorts before ` +
            `specs/b.mdx — item order follows current identities (SPEC 10.5, 10.6)`,
        );
        const postExportLabel = `${prefix} post-move \`review export s --json\``;
        const postExport = decodeExportReport(
          await runJson(
            product,
            workspace,
            ["review", "export", "s", "--json"],
            postExportLabel,
          ),
          postExportLabel,
        );
        assertPrecedes(postExport.items, nId, mId, postExportLabel);
        const nItem = requireItem(postExport.items, nId, postExportLabel);
        const wItem = requireItem(postExport.items, wId, postExportLabel);
        assertRecordedHolds(
          nItem.current,
          nHash,
          "n's recorded subtreeHash (creation-time record)",
          `${postExportLabel} — recorded state intact across the move`,
        );
        assertRecordedHolds(
          wItem.current,
          wHash,
          "w's recorded subtreeHash (resolve-time record)",
          `${postExportLabel} — recorded state intact across the move`,
        );
        if (wItem.scope.node !== T4M_AW || wItem.scope.present !== true) {
          fail(
            `${postExportLabel}: w's item presents its scope under the ` +
              `current identity (SPEC 10.4); expected {node: ` +
              `${JSON.stringify(T4M_AW)}, present: true}, got ` +
              JSON.stringify(wItem.scope),
          );
        }
        const postNextLabel = `${prefix} post-move \`review next s --json\``;
        const postNext = decodeNextReport(
          await runJson(
            product,
            workspace,
            ["review", "next", "s", "--json"],
            postNextLabel,
          ),
          postNextLabel,
        );
        if (postNext.fullyResolved || postNext.item === undefined) {
          fail(`${postNextLabel}: unresolved items remain (SPEC 10.7)`);
        }
        if (postNext.item.id !== nId) {
          fail(
            `${postNextLabel}: the flip shows in \`next\` too — specs/a.mdx ` +
              `now sorts first, so n's item leads (SPEC 10.5, 10.6, 10.7); ` +
              `expected ${nId}, got ${postNext.item.id}`,
          );
        }
      },
    );

    // --- reintroduction arm ---------------------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T4I_FILE]: T4I_SOURCE },
      async (workspace) => {
        const prefix = "T10.4-4 reintroduction arm";
        await buildOk(product, workspace, `${prefix} \`build\``);
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          `${prefix} \`review create --strategy audit --name s\``,
        );
        const status = await sessionStatus(product, workspace, "s", prefix);
        const rootId = requireRow(
          status,
          "subtree-coherence",
          T4I_ROOT,
          prefix,
        ).id;
        const aId = requireRow(status, "subtree-coherence", T4I_A, prefix).id;
        const sId = requireRow(status, "subtree-coherence", T4I_S, prefix).id;

        await resolveOk(
          product,
          workspace,
          "s",
          aId,
          "no-change",
          `${prefix} resolve of a's item`,
        );
        await expectExit(
          product,
          workspace,
          ["rename", T4I_FILE, "a", "b"],
          0,
          `${prefix} \`rename specs/E.mdx a b\``,
        );

        // Author a new top-level leaf section `a` — appended to whatever the
        // rename left on disk, so the reintroduced identity starts a new
        // canonical chain after the journal entry that vacated it (SPEC 5.4).
        const renamed = await workspace.readBytes(T4I_FILE);
        await workspace.file(
          T4I_FILE,
          Buffer.concat([
            Buffer.from(renamed),
            Buffer.from(T4I_NEW_SECTION, "utf8"),
          ]),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after authoring the new section a`,
        );

        // Premises before the re-derivation: still three items — new items
        // enter only through re-derivation (SPEC 10.5) — the resolved item
        // presented under scope b, and the root blocked by exactly the two
        // recorded child items.
        const beforeRederive = await sessionStatus(
          product,
          workspace,
          "s",
          `${prefix} before the updated-resolve`,
        );
        assertSameJson(
          beforeRederive.items
            .map((row) => [row.id, row.scope, row.status])
            .sort(),
          (
            [
              [rootId, T4I_ROOT, "unresolved"],
              [aId, T4I_B, "no-change"],
              [sId, T4I_S, "unresolved"],
            ] as const
          )
            .map((row) => [...row])
            .sort(),
          `${prefix} before the updated-resolve: three items — the rename ` +
            `maps a's item to scope b without invalidating it, and new-a has ` +
            `no item yet (sibling subtrees enter only through re-derivation, ` +
            `SPEC 10.4, 10.5)`,
        );
        const rootBefore = await showItem(
          product,
          workspace,
          "s",
          rootId,
          `${prefix} root item before the updated-resolve`,
        );
        assertSameJson(
          [...rootBefore.blockedBy].sort(),
          [aId, sId].sort(),
          `${prefix}: the root item's blockedBy is still its recorded child ` +
            `items — blockedBy is recomputed only at re-derivation (SPEC 10.5, 10.6)`,
        );

        // The re-derivation: resolve s's item `updated` (SPEC 10.5, 10.6).
        await resolveOk(
          product,
          workspace,
          "s",
          sId,
          "updated",
          `${prefix} \`review resolve s <s item> --status updated\` — re-derivation`,
        );

        const after = await sessionStatus(
          product,
          workspace,
          "s",
          `${prefix} after the updated-resolve`,
        );
        // The recorded-against-old-a item keeps its id and resolved status,
        // presented under scope b; new-a's item is a distinct unresolved
        // item. A product matching by walked-back identity string collapses
        // both bearers onto `a` and loses one of these rows.
        const bRow = requireRow(
          after,
          "subtree-coherence",
          T4I_B,
          `${prefix} after the updated-resolve`,
        );
        const newARow = requireRow(
          after,
          "subtree-coherence",
          T4I_A,
          `${prefix} after the updated-resolve`,
        );
        if (bRow.id !== aId || bRow.status !== "no-change") {
          fail(
            `${prefix}: the item recorded against old-a keeps its id and ` +
              `resolved status, presented under scope b (SPEC 5.4, 10.4, ` +
              `10.5); expected id ${aId} with status no-change, got id ` +
              `${bRow.id} with status ${bRow.status}`,
          );
        }
        if ([rootId, aId, sId].includes(newARow.id)) {
          fail(
            `${prefix}: new-a's item enters as a distinct item (SPEC 5.4: ` +
              `the reintroduced identity starts a new canonical chain, so ` +
              `the two bearers never match); got the existing id ${newARow.id}`,
          );
        }
        if (newARow.status !== "unresolved") {
          fail(
            `${prefix}: new-a's item is created unresolved (SPEC 10.2); got ` +
              newARow.status,
          );
        }
        assertSameJson(
          after.items.map((row) => [row.id, row.scope, row.status]).sort(),
          (
            [
              [rootId, T4I_ROOT, "unresolved"],
              [aId, T4I_B, "no-change"],
              [sId, T4I_S, "updated"],
              [newARow.id, T4I_A, "unresolved"],
            ] as const
          )
            .map((row) => [...row])
            .sort(),
          `${prefix} after the updated-resolve: exactly four items — no ` +
            `duplicates, no lost statuses (SPEC 10.4, 10.5)`,
        );
        const rootAfter = await showItem(
          product,
          workspace,
          "s",
          rootId,
          `${prefix} root item after the updated-resolve`,
        );
        assertSameJson(
          [...rootAfter.blockedBy].sort(),
          [aId, sId, newARow.id].sort(),
          `${prefix}: the root item's recomputed blockedBy gains new-a's ` +
            `item (SPEC 10.5, 10.6)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.4-5 — reads never write
// ---------------------------------------------------------------------------

const T5_FILE = "specs/W.mdx";
const T5_X = "specs/W.mdx#x";
const T5_ROOT = "specs/W.mdx";
const T5_Y = "specs/W.mdx#y";
const T5_SESSION_FILE = ".xspec/reviews/s.json";

function t5Spec(xText: string): string {
  return [
    '<S id="x">',
    xText,
    "</S>",
    "",
    '<S id="y">',
    "Wye text.",
    "</S>",
    "",
  ].join("\n");
}

const T10_4_5 = defineProductTest({
  id: "T10.4-5",
  title:
    "reads never write: with a stale resolution in an audit session (the resolved scope node edited and rebuilt), `status`, `next`, `show`, and `export` each report the item `invalidated` while leaving the session file byte-identical; `review list` still counts the stored `no-change` status — read-time invalidation is computed and reported, never persisted — and the stored status and record are rewritten only by a mutating subcommand, whose `resolve` changes the session file's bytes and cures the staleness (SPEC 10.1, 10.4, 10.7)",
  timeoutMs: 240_000,
  run: async (product) => {
    // Staged within CONF-CORE's scope (CERTIFICATIONS.md): one importless
    // spec group, no tags/d/embeddings, no git, an audit-strategy session.
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T5_FILE]: t5Spec("Ex text v0.") },
      async (workspace) => {
        await buildOk(product, workspace, "T10.4-5 `build`");
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          "T10.4-5 `review create --strategy audit --name s`",
        );
        const status = await sessionStatus(product, workspace, "s", "T10.4-5");
        assertSameJson(
          kindScopeSet(status),
          [
            `subtree-coherence ${T5_ROOT}`,
            `subtree-coherence ${T5_X}`,
            `subtree-coherence ${T5_Y}`,
          ].sort(),
          "T10.4-5: audit creates one item per node (SPEC 10.6)",
        );
        const xId = requireRow(status, "subtree-coherence", T5_X, "T10.4-5").id;
        await resolveOk(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-5 `review resolve s <x item> --status no-change`",
        );

        // The staleness: edit the resolved scope node and rebuild, so every
        // subsequent read computes and reports invalidation (SPEC 10.4).
        await workspace.file(T5_FILE, t5Spec("Ex text v1."));
        await buildOk(product, workspace, "T10.4-5 `build` after the x edit");

        /** Run one read; assert the session file's bytes did not move. */
        const readLeavesSessionUntouched = async (
          argv: readonly string[],
          label: string,
        ): Promise<unknown> => {
          const before = await workspace.readBytes(T5_SESSION_FILE);
          const doc = await runJson(product, workspace, argv, label);
          const after = await workspace.readBytes(T5_SESSION_FILE);
          assertBytesEqual(
            after,
            before,
            `${label} — the read computed and reported invalidation yet ` +
              `must leave the session file byte-identical: read-time ` +
              `invalidation is never persisted (SPEC 10.4)`,
          );
          return doc;
        };

        // `status`: the stale resolution reports invalidated; totals apply
        // read-time invalidation.
        const statusLabel = "T10.4-5 `review status s --json`";
        const staleStatus = decodeSessionStatusReport(
          await readLeavesSessionUntouched(
            ["review", "status", "s", "--json"],
            statusLabel,
          ),
          statusLabel,
        );
        const staleRow = requireRowById(staleStatus, xId, statusLabel);
        if (staleRow.status !== "invalidated") {
          fail(
            `${statusLabel}: a stale resolution is never reported as ` +
              `resolved — the item is reported invalidated on read ` +
              `(SPEC 10.4); got ${staleRow.status}`,
          );
        }
        assertTotals(
          staleStatus,
          {
            unresolved: 2,
            invalidated: 1,
            updated: 0,
            "no-change": 0,
            skipped: 0,
          },
          statusLabel,
        );

        // `next`: the invalidated item needs review and leads (x precedes y
        // in document order; the root item is blocked, SPEC 10.6).
        const nextLabel = "T10.4-5 `review next s --json`";
        const next = decodeNextReport(
          await readLeavesSessionUntouched(
            ["review", "next", "s", "--json"],
            nextLabel,
          ),
          nextLabel,
        );
        if (next.fullyResolved || next.item === undefined) {
          fail(
            `${nextLabel}: the invalidated item needs review (SPEC 10.3, 10.4)`,
          );
        }
        if (next.item.id !== xId || next.item.status !== "invalidated") {
          fail(
            `${nextLabel}: expected the x item reported invalidated ` +
              `(SPEC 10.4, 10.6, 10.7); got ${next.item.id} with status ` +
              next.item.status,
          );
        }

        // `show`: same report, same byte-identity.
        const showLabel = "T10.4-5 `review show s <x item> --json`";
        const shown = decodeItemReport(
          await readLeavesSessionUntouched(
            ["review", "show", "s", xId, "--json"],
            showLabel,
          ),
          showLabel,
        );
        if (shown.status !== "invalidated") {
          fail(
            `${showLabel}: the stale resolution is reported invalidated ` +
              `(SPEC 10.4); got ${shown.status}`,
          );
        }

        // `export`: read-time invalidation applied, nothing persisted.
        const exportLabel = "T10.4-5 `review export s --json`";
        const exported = decodeExportReport(
          await readLeavesSessionUntouched(
            ["review", "export", "s", "--json"],
            exportLabel,
          ),
          exportLabel,
        );
        const exportedItem = requireItem(exported.items, xId, exportLabel);
        if (exportedItem.status !== "invalidated") {
          fail(
            `${exportLabel}: export applies read-time invalidation ` +
              `(SPEC 10.4, 10.7); got ${exportedItem.status}`,
          );
        }

        // `list` counts stored statuses without read-time invalidation
        // (SPEC 10.7): after all four reads, the stored status is still the
        // resolved one — the reads rewrote nothing.
        const listLabel = "T10.4-5 `review list --json`";
        const list = decodeSessionListReport(
          await readLeavesSessionUntouched(
            ["review", "list", "--json"],
            listLabel,
          ),
          listLabel,
        );
        const entries = list.sessions.filter((session) => session.name === "s");
        const entry = entries.length === 1 ? entries[0] : undefined;
        if (entry === undefined || entry.corrupt) {
          fail(
            `${listLabel}: expected exactly one non-corrupt session "s" ` +
              `(SPEC 10.1, 10.7); got ${JSON.stringify(list.sessions)}`,
          );
        }
        const counts = entry.counts;
        for (const [storedStatus, expected] of [
          ["no-change", 1],
          ["unresolved", 2],
          ["invalidated", 0],
          ["updated", 0],
          ["skipped", 0],
        ] as const) {
          if ((counts[storedStatus] ?? 0) !== expected) {
            fail(
              `${listLabel}: \`list\` counts stored statuses without ` +
                `read-time invalidation (SPEC 10.7) — the reads must not ` +
                `have rewritten the stored no-change status (SPEC 10.4); ` +
                `expected ${String(expected)} ${storedStatus} item(s), got ` +
                `${String(counts[storedStatus] ?? 0)} in ${JSON.stringify(counts)}`,
            );
          }
        }

        // The stored status is rewritten only by mutating subcommands: a
        // `resolve` re-records the current relevant state — the session
        // file's bytes change and the staleness is cured.
        const beforeResolve = await workspace.readBytes(T5_SESSION_FILE);
        await resolveOk(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-5 `review resolve s <x item> --status no-change` — the " +
            "mutating subcommand that rewrites the stored state (SPEC 10.4)",
        );
        const afterResolve = await workspace.readBytes(T5_SESSION_FILE);
        if (bytesEqual(afterResolve, beforeResolve)) {
          fail(
            "T10.4-5: the mutating `resolve` records the current relevant " +
              "state over the stale record (SPEC 10.4, 10.7), so the " +
              "session file's bytes must change — they are byte-identical",
          );
        }
        await expectItemStatus(
          product,
          workspace,
          "s",
          xId,
          "no-change",
          "T10.4-5 after the mutating resolve — the freshly recorded state " +
            "matches the graph, so the read reports the stored resolved " +
            "status again (SPEC 10.4)",
        );
      },
    );
  },
});

/** TEST-SPEC §10.4, in canonical ID order (SUITE-35). */
export const section104Tests: readonly ProductTestEntry[] = [
  T10_4_1,
  T10_4_2,
  T10_4_3,
  T10_4_4,
  T10_4_5,
];
