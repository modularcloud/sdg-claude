// TEST-SPEC §10.5 (built-in strategy: path-blocks) — SUITE-36:
// T10.5-1…T10.5-6.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 10.5: for each `changed` node — skipping nodes with a `changed`
// ancestor — path-blocks derives one `subtree-coherence` item plus one
// `parent-consistency` item per non-root ancestor (a single item per
// ancestor, against the union of changed branches, blocked per branch by the
// child's item); metadata and dependency impact add one
// `metadata-consistency` item per `metadata-changed` node, one
// `dependency-consistency` item per node depending on a both-sides target
// whose effectiveHash changed, and one `code-impact` item per impacted
// location. Items are totally ordered (depth deepest-first, kind, file path,
// document order; `code-impact` last by location identity; absent scopes
// after present ones). Resolving `updated` re-derives the session with the
// recorded creation parameters; `split` decompositions apply recursively and
// are never re-added.
//
// Conservative operationalizations (noted per H-3/H-4):
// - `context` and `origin` are asserted as sorted identity sets: SPEC 10.5
//   fixes their membership, not a payload order; texts and byte-level payload
//   contracts are T10.7-12's business.
// - `blockedBy` is compared as a sorted id set (SPEC 10.5/10.7 fix which
//   items block, not an order within the field).
// - Item order is asserted as the exact `(kind, scope)` row sequence of
//   `status` and `export`; `next`'s presentation of the order is asserted by
//   walking the session (repeated `next` + `resolve --status no-change`),
//   which visits items in item order because every blocker in these fixtures
//   precedes its dependents.
// - The absent-scope ordering key exercised is scope-node identity, staged
//   discriminatingly (recorded document order opposite to identity order).
//   The final `item id` tiebreak needs two same-kind absent items with equal
//   identity strings — same kind forces distinct scope nodes (10.5), and
//   distinct nodes' identity strings only collide via journaled-rename
//   reintroduction (5.4), a staging that belongs to T10.4-4 — so it is not
//   independently staged here.
// - A resolved item whose recorded context set changes is expected
//   `invalidated` on reads even after a re-derivation updates its context
//   set (SPEC 10.5: a matched item whose context set changed "is updated
//   and, when resolved, becomes `invalidated`"), and stays so until
//   re-resolved.
// - Every fixture edit is followed by an explicit `build` before any read,
//   so no read relies on the 13.3 refresh path (T13.3-*'s business); hash
//   premises via `query node` bracket the edits that must isolate a single
//   sensitivity (SPEC 5.5), as in §10.4.

import type {
  ExportReport,
  ItemStatus,
  NodeHashes,
  NodeReport,
  ReviewItem,
  SessionStatusReport,
  SessionStatusRow,
} from "../../helpers/adapters/index.js";
import {
  decodeExportReport,
  decodeItemReport,
  decodeNextReport,
  decodeNodeReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
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

// Spec group plus a code group (SPEC 7.2) — fixtures deriving `code-impact`
// items need an impacted code location (SPEC 9.2, 10.5).
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

/** The unique full item for a kind and scope node in an export/next list. */
function requireItem(
  items: readonly ReviewItem[],
  kind: ReviewItem["kind"],
  scope: string,
  context: string,
): ReviewItem {
  const matches = items.filter(
    (item) => item.kind === kind && item.scope.node === scope,
  );
  if (matches.length !== 1) {
    fail(
      `${context}: expected exactly one ${kind} item scoped at ${scope} ` +
        `(SPEC 10.5: at most one item per kind and scope node); found ` +
        `${String(matches.length)} among ` +
        JSON.stringify(items.map((item) => `${item.kind} ${item.scope.node}`)),
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
  const rows = report.items.filter((row) => row.id === itemId);
  if (rows.length !== 1) {
    fail(
      `${context}: expected exactly one item with id ${JSON.stringify(itemId)} ` +
        `(SPEC 10.2: item ids are unique within the session); found ` +
        `${String(rows.length)} among ` +
        JSON.stringify(report.items.map((row) => row.id)),
    );
  }
  if (rows[0].status !== expected) {
    fail(
      `${context}: expected the item to be reported ${expected}, got ` +
        `${rows[0].status} (SPEC 10.4, 10.5)`,
    );
  }
}

/** Sorted node-identity set of a payload node list (membership compare). */
function identitySet(
  states: readonly { readonly node: string }[],
): readonly string[] {
  return states.map((state) => state.node).sort();
}

/** Sorted `kind scope` rendering of a session's items (membership compare). */
function kindScopeSet(report: SessionStatusReport): readonly string[] {
  return report.items.map((row) => `${row.kind} ${row.scope}`).sort();
}

/** In-order `kind scope` rendering of an item sequence (order compare). */
function kindScopeSequence(
  rows: readonly { readonly kind: string; readonly scope: string }[],
): readonly string[] {
  return rows.map((row) => `${row.kind} ${row.scope}`);
}

/** In-order `kind scope` rendering of export items (order compare). */
function exportKindScopeSequence(
  items: readonly ReviewItem[],
): readonly string[] {
  return items.map((item) => `${item.kind} ${item.scope.node}`);
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
    `${context}: blockedBy (compared as a sorted id set; SPEC 10.5, 10.7)`,
  );
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

// ---------------------------------------------------------------------------
// T10.5-1 — generation: SPEC 15's worked change, plus the skipping rule,
// subtree scope, and the shared-ancestor union
// ---------------------------------------------------------------------------

// The SPEC 15 example workspace, verbatim.
const S15_SPEC_FILE = "specs/SPEC.mdx";
const S15_DERIVED_FILE = "specs/DERIVED.mdx";
const S15_CODE_FILE = "src/hello.ts";

function s15Spec(helloText: string): string {
  return [
    '<S id="print">',
    "Print behavior.",
    "",
    '<S id="print.hello" tags="critical">',
    helloText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const S15_DERIVED_SOURCE = [
  'import SPEC from "./SPEC.xspec"',
  "",
  '<S id="derived">',
  "Derived behavior.",
  "",
  '<S id="derived.hello" d={SPEC.print.hello}>',
  "Derived hello behavior.",
  "</S>",
  "</S>",
  "",
].join("\n");

const S15_CODE_SOURCE = [
  'import DERIVED from "../specs/DERIVED.xspec"',
  "",
  "export function hello() {",
  "  DERIVED.derived.hello",
  '  console.log("Hello")',
  "}",
  "",
].join("\n");

const S15_ROOT = "specs/SPEC.mdx";
const S15_PRINT = "specs/SPEC.mdx#print";
const S15_HELLO = "specs/SPEC.mdx#print.hello";
const S15_DERIVED_HELLO = "specs/DERIVED.mdx#derived.hello";
const S15_LOCATION = "src/hello.ts#hello";

// Extended fixture (SPEC 10.5 rules 1–2): p and p.c both changed (the
// skipping rule and the origin of the surviving item); a.k and a.s both
// changed under the shared unchanged ancestor a (one parent-consistency item
// against the union of branches).
const X1_FILE = "specs/X.mdx";
const X1_P = "specs/X.mdx#p";
const X1_PC = "specs/X.mdx#p.c";
const X1_A = "specs/X.mdx#a";
const X1_AK = "specs/X.mdx#a.k";
const X1_AS = "specs/X.mdx#a.s";

function x1Spec(
  pOwn: string,
  cText: string,
  kText: string,
  sText: string,
): string {
  return [
    '<S id="p">',
    pOwn,
    "",
    '<S id="p.c">',
    cText,
    "</S>",
    "</S>",
    "",
    '<S id="a">',
    "Aye own text.",
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

const T10_5_1 = defineProductTest({
  id: "T10.5-1",
  title:
    "path-blocks generation: SPEC 15's worked change (a leaf text edit to print.hello) yields exactly the four listed items — print.hello's subtree-coherence item (context: its ancestor chain; origin: itself), print's parent-consistency item blocked by it (context/origin: print.hello), derived.hello's dependency-consistency item (context/origin: print.hello), and a code-impact item for src/hello.ts#hello (context: derived.hello, the impact-edge target that makes it impacted; origin: print.hello) — and the extended fixture pins the skipping rule (a changed node with a changed ancestor generates no own item; the ancestor's single subtree-coherence item carries both changed nodes as origin and its scope covers the node plus all descendants, its scope text the scope root's subtree text) and the shared-ancestor union (two changed leaves under one unchanged ancestor yield one parent-consistency item whose context and origin are the union of changed branches) (SPEC 5.6, 9.2, 10.5, 15)",
  timeoutMs: 300_000,
  run: async (product) => {
    // --- SPEC 15's worked change ---------------------------------------------
    await withWorkspace(
      SPECS_CODE_CONFIG,
      {
        [S15_SPEC_FILE]: s15Spec("Print hello."),
        [S15_DERIVED_FILE]: S15_DERIVED_SOURCE,
        [S15_CODE_FILE]: S15_CODE_SOURCE,
      },
      async (workspace) => {
        const prefix = "T10.5-1 SPEC 15 worked change";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(S15_SPEC_FILE, s15Spec("Print hello, edited."));
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await createBaseSession(product, workspace, base, "s", prefix);

        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `code-impact ${S15_LOCATION}`,
            `dependency-consistency ${S15_DERIVED_HELLO}`,
            `parent-consistency ${S15_PRINT}`,
            `subtree-coherence ${S15_HELLO}`,
          ].sort(),
          `${prefix}: SPEC 15 — "a default path-blocks session for this ` +
            `change contains exactly: a subtree-coherence item for ` +
            `print.hello, a parent-consistency item for print blocked by ` +
            `it, a dependency-consistency item for derived.hello, and a ` +
            `code-impact item for hello.ts#hello"`,
        );

        const exported = await exportSession(product, workspace, "s", prefix);
        const sc = requireItem(
          exported.items,
          "subtree-coherence",
          S15_HELLO,
          prefix,
        );
        const pc = requireItem(
          exported.items,
          "parent-consistency",
          S15_PRINT,
          prefix,
        );
        const dc = requireItem(
          exported.items,
          "dependency-consistency",
          S15_DERIVED_HELLO,
          prefix,
        );
        const ci = requireItem(
          exported.items,
          "code-impact",
          S15_LOCATION,
          prefix,
        );

        // subtree-coherence: context is N's ancestor chain (print and the
        // file root); origin is the changed nodes in scope (SPEC 10.5 rule 1).
        assertSameJson(
          identitySet(sc.context),
          [S15_ROOT, S15_PRINT].sort(),
          `${prefix}: the subtree-coherence item's context is print.hello's ` +
            `ancestor chain (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(sc.origin),
          [S15_HELLO],
          `${prefix}: the subtree-coherence item's origin is the changed ` +
            `node in scope (SPEC 10.5)`,
        );
        assertBlockedBy(sc, [], `${prefix} subtree-coherence item`);

        // parent-consistency: context is the changed branch beneath print —
        // print's child on it, print.hello; origin the branch's changed
        // node; blocked by the child's subtree-coherence item (SPEC 10.5
        // rule 2; SPEC 15: "blocked by it").
        assertSameJson(
          identitySet(pc.context),
          [S15_HELLO],
          `${prefix}: the parent-consistency item's context is the changed ` +
            `branch beneath print — print's child on that branch (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(pc.origin),
          [S15_HELLO],
          `${prefix}: the parent-consistency item's origin is the changed ` +
            `branch's changed node (SPEC 10.5)`,
        );
        assertBlockedBy(pc, [sc.id], `${prefix} parent-consistency item`);

        // dependency-consistency: context is the changed both-sides target;
        // origin the originating nodes of the target's change (SPEC 10.5).
        assertSameJson(
          identitySet(dc.context),
          [S15_HELLO],
          `${prefix}: the dependency-consistency item's context is the ` +
            `changed dependency target (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(dc.origin),
          [S15_HELLO],
          `${prefix}: the dependency-consistency item's origin is the ` +
            `originating node of the target's change (SPEC 5.6, 10.5)`,
        );
        assertBlockedBy(dc, [], `${prefix} dependency-consistency item`);

        // code-impact: context is the impact-edge target that makes the
        // location impacted (derived.hello, whose effectiveHash changed);
        // origin the originating node of that target's change (SPEC 9.2,
        // 10.5).
        if (ci.scope.node !== S15_LOCATION || ci.scope.present !== true) {
          fail(
            `${prefix}: the code-impact item's scope is the impacted ` +
              `location under its identity (SPEC 10.5, 9.2); expected ` +
              `{node: ${JSON.stringify(S15_LOCATION)}, present: true}, got ` +
              JSON.stringify(ci.scope),
          );
        }
        assertSameJson(
          identitySet(ci.context),
          [S15_DERIVED_HELLO],
          `${prefix}: the code-impact item's context is the impact-edge ` +
            `target that makes the location impacted (SPEC 9.2, 10.5)`,
        );
        assertSameJson(
          identitySet(ci.origin),
          [S15_HELLO],
          `${prefix}: the code-impact item's origin is the originating node ` +
            `of the target's change (SPEC 5.6, 10.5)`,
        );
        assertBlockedBy(ci, [], `${prefix} code-impact item`);
      },
    );

    // --- extended fixture: skipping, subtree scope, shared-ancestor union ----
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [X1_FILE]: x1Spec(
          "Pee own v0.",
          "Cee text v0.",
          "Kay text v0.",
          "Ess text v0.",
        ),
      },
      async (workspace) => {
        const prefix = "T10.5-1 extended fixture";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(
          X1_FILE,
          x1Spec("Pee own v1.", "Cee text v1.", "Kay text v1.", "Ess text v1."),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the edits`,
        );
        await createBaseSession(product, workspace, base, "s", prefix);

        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `parent-consistency ${X1_A}`,
            `subtree-coherence ${X1_AK}`,
            `subtree-coherence ${X1_AS}`,
            `subtree-coherence ${X1_P}`,
          ].sort(),
          `${prefix}: p.c is changed but has the changed ancestor p, so it ` +
            `generates no own item (skipping rule); a.k and a.s each get a ` +
            `subtree-coherence item and their shared unchanged ancestor a ` +
            `gets a single parent-consistency item (SPEC 10.5)`,
        );

        const exported = await exportSession(product, workspace, "s", prefix);
        const scP = requireItem(
          exported.items,
          "subtree-coherence",
          X1_P,
          prefix,
        );
        // Origin: the changed nodes in scope — the skipped descendant's
        // change is attributed inside the ancestor's item (SPEC 10.5 rule 1).
        assertSameJson(
          identitySet(scP.origin),
          [X1_P, X1_PC].sort(),
          `${prefix}: p's subtree-coherence item's origin is the changed ` +
            `nodes in scope — p and the skipped p.c (SPEC 10.5)`,
        );
        // Scope: the node plus all descendants — the scope root is p and its
        // scope text is p's subtree text (SPEC 10.5, 10.7: scope text for
        // subtree-coherence is the scope root's subtree text).
        if (scP.scope.node !== X1_P || scP.scope.present !== true) {
          fail(
            `${prefix}: p's subtree-coherence scope root is p (SPEC 10.5: ` +
              `a subtree-coherence item's scope node is its subtree root); ` +
              `expected {node: ${JSON.stringify(X1_P)}, present: true}, got ` +
              JSON.stringify(scP.scope),
          );
        }
        const pReport = await queryNode(product, workspace, X1_P, prefix);
        if (pReport.subtreeText === pReport.ownText) {
          fail(
            `${prefix} staging premise: p's subtree text must differ from ` +
              `its own text (the descendant p.c contributes) so the scope ` +
              `assertion discriminates subtree scope from own-node scope ` +
              `(SPEC 1.6)`,
          );
        }
        if (scP.scope.text !== pReport.subtreeText) {
          fail(
            `${prefix}: p's subtree-coherence item covers the node plus all ` +
              `descendants — its scope text is p's subtree text (SPEC 10.5, ` +
              `10.7); \`query node\` reports ` +
              `${JSON.stringify(pReport.subtreeText)}, the item's scope ` +
              `carries ${JSON.stringify(scP.scope.text)}`,
          );
        }

        // Shared ancestor: one parent-consistency item for a against the
        // union of changed branches (SPEC 10.5 rule 2). requireItem already
        // asserted uniqueness.
        const pcA = requireItem(
          exported.items,
          "parent-consistency",
          X1_A,
          prefix,
        );
        assertSameJson(
          identitySet(pcA.context),
          [X1_AK, X1_AS].sort(),
          `${prefix}: a's single parent-consistency item's context is the ` +
            `union of changed branches — a's child on each (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(pcA.origin),
          [X1_AK, X1_AS].sort(),
          `${prefix}: a's parent-consistency item's origin is the changed ` +
            `branches' changed nodes (SPEC 10.5)`,
        );
        const scAK = requireItem(
          exported.items,
          "subtree-coherence",
          X1_AK,
          prefix,
        );
        const scAS = requireItem(
          exported.items,
          "subtree-coherence",
          X1_AS,
          prefix,
        );
        assertBlockedBy(
          pcA,
          [scAK.id, scAS.id],
          `${prefix} a's parent-consistency item — one blocker per changed ` +
            `branch, the child's subtree-coherence item`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.5-2 — blocking chains
// ---------------------------------------------------------------------------

// a > a.b > a.b.c (deep change) and a > a.k (child-is-changed-node branch);
// m's tag edit yields a metadata-consistency item, dep's dependency on a.b.c
// a dependency-consistency item, and src/ci.ts (referencing a.k) a
// code-impact item — all three with empty blockedBy.
const K_FILE = "specs/K.mdx";
const K_A = "specs/K.mdx#a";
const K_AB = "specs/K.mdx#a.b";
const K_ABC = "specs/K.mdx#a.b.c";
const K_AK = "specs/K.mdx#a.k";
const K_M = "specs/K.mdx#m";
const K_DEP = "specs/K.mdx#dep";
const K_CODE = "src/ci.ts";

function kSpec(abcText: string, akText: string, mTags: string): string {
  return [
    '<S id="a">',
    "Aye own text.",
    "",
    '<S id="a.b">',
    "Abe own text.",
    "",
    '<S id="a.b.c">',
    abcText,
    "</S>",
    "</S>",
    "",
    '<S id="a.k">',
    akText,
    "</S>",
    "</S>",
    "",
    `<S id="m" tags="${mTags}">`,
    "Em text.",
    "</S>",
    "",
    '<S id="dep" d={"a.b.c"}>',
    "Dep text.",
    "</S>",
    "",
  ].join("\n");
}

const K_CODE_SOURCE = [
  'import K from "../specs/K.xspec";',
  "",
  "K.a.k;",
  "",
].join("\n");

const T10_5_2 = defineProductTest({
  id: "T10.5-2",
  title:
    "blocking chains: a's parent-consistency item is blocked by, per changed branch, the child's subtree-coherence item where the child is the changed node (a.k) or the child's parent-consistency item for a deeper change (a.b, whose own item is blocked by a.b.c's subtree-coherence item — the chain extends to the last non-root ancestor); only those two kinds block parent-consistency items (the fixture's metadata-consistency, dependency-consistency, and code-impact items appear in no blockedBy), and metadata-consistency, dependency-consistency, and code-impact items have empty blockedBy; blocked flags in `status` reflect exactly the parent-consistency items (SPEC 10.3, 10.5)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_CODE_CONFIG,
      {
        [K_FILE]: kSpec("Abc text v0.", "Ack text v0.", "m0"),
        [K_CODE]: K_CODE_SOURCE,
      },
      async (workspace) => {
        const prefix = "T10.5-2";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(
          K_FILE,
          kSpec("Abc text v1.", "Ack text v1.", "m1"),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the edits`,
        );
        await createBaseSession(product, workspace, base, "s", prefix);

        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `code-impact ${K_CODE}`,
            `dependency-consistency ${K_DEP}`,
            `metadata-consistency ${K_M}`,
            `parent-consistency ${K_A}`,
            `parent-consistency ${K_AB}`,
            `subtree-coherence ${K_ABC}`,
            `subtree-coherence ${K_AK}`,
          ].sort(),
          `${prefix}: the two changed branches, the metadata-changed node, ` +
            `the depender on a changed target, and the impacted location ` +
            `yield exactly these items (SPEC 10.5)`,
        );

        const exported = await exportSession(product, workspace, "s", prefix);
        const scABC = requireItem(
          exported.items,
          "subtree-coherence",
          K_ABC,
          prefix,
        );
        const scAK = requireItem(
          exported.items,
          "subtree-coherence",
          K_AK,
          prefix,
        );
        const pcAB = requireItem(
          exported.items,
          "parent-consistency",
          K_AB,
          prefix,
        );
        const pcA = requireItem(
          exported.items,
          "parent-consistency",
          K_A,
          prefix,
        );
        const mc = requireItem(
          exported.items,
          "metadata-consistency",
          K_M,
          prefix,
        );
        const dc = requireItem(
          exported.items,
          "dependency-consistency",
          K_DEP,
          prefix,
        );
        const ci = requireItem(exported.items, "code-impact", K_CODE, prefix);

        // The full blockedBy map (SPEC 10.5): subtree-coherence items carry
        // no blockers under path-blocks; each parent-consistency item is
        // blocked per changed branch by its child's item — the child's
        // subtree-coherence item when the child is the changed node, its
        // parent-consistency item for a deeper change — and by nothing else.
        assertBlockedBy(scABC, [], `${prefix} a.b.c subtree-coherence item`);
        assertBlockedBy(scAK, [], `${prefix} a.k subtree-coherence item`);
        assertBlockedBy(
          pcAB,
          [scABC.id],
          `${prefix} a.b parent-consistency item — the branch's changed ` +
            `node is a.b's child a.b.c, so its subtree-coherence item blocks`,
        );
        assertBlockedBy(
          pcA,
          [pcAB.id, scAK.id],
          `${prefix} a parent-consistency item — branch b carries the ` +
            `deeper change (a.b's parent-consistency item blocks), branch k ` +
            `the changed child itself (a.k's subtree-coherence item blocks); ` +
            `only those two kinds block parent-consistency items`,
        );
        assertBlockedBy(mc, [], `${prefix} metadata-consistency item`);
        assertBlockedBy(dc, [], `${prefix} dependency-consistency item`);
        assertBlockedBy(ci, [], `${prefix} code-impact item`);

        // Blocked flags follow blockedBy alone (SPEC 10.3, 10.5): with every
        // item unresolved, exactly the parent-consistency items are blocked.
        for (const row of status.items) {
          const expectBlocked = row.kind === "parent-consistency";
          if (row.blocked !== expectBlocked) {
            fail(
              `${prefix}: with all items unresolved, ${row.kind} ${row.scope} ` +
                `must report blocked=${String(expectBlocked)} (SPEC 10.3: an ` +
                `item is blocked while any blockedBy item is not resolved; ` +
                `SPEC 10.5: only parent-consistency items carry blockers); ` +
                `got blocked=${String(row.blocked)}`,
            );
          }
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.5-3 — metadata, dependency, and code items
// ---------------------------------------------------------------------------

// Top-level sections so no parent-consistency noise arises; h holds the
// added/deleted children (its own item absorbs them via the skipping rule,
// keeping the root unchanged).
const N_FILE = "specs/N.mdx";
const N_X = "specs/N.mdx#x";
const N_Y = "specs/N.mdx#y";
const N_M = "specs/N.mdx#m";
const N_M2 = "specs/N.mdx#m2";
const N_T = "specs/N.mdx#t";
const N_DEP1 = "specs/N.mdx#dep1";
const N_DEP2 = "specs/N.mdx#dep2";
const N_H = "specs/N.mdx#h";
const N_H_GONE = "specs/N.mdx#h.gone";
const N_H_NEWT = "specs/N.mdx#h.newt";
const N_H_BORN = "specs/N.mdx#h.born";
const N_CODE = "src/ci3.ts";

const N_BASELINE = [
  '<S id="x">',
  "Ex text.",
  "</S>",
  "",
  '<S id="y">',
  "Wye text.",
  "</S>",
  "",
  '<S id="m" d={"x"}>',
  "Em text.",
  "</S>",
  "",
  '<S id="m2" tags="alpha">',
  "Em two text.",
  "</S>",
  "",
  '<S id="t">',
  "Tee text v0.",
  "</S>",
  "",
  '<S id="dep1" d={"t"}>',
  "Dep one text.",
  "</S>",
  "",
  '<S id="dep2">',
  "Dep two text.",
  "</S>",
  "",
  '<S id="h">',
  "Aitch own text.",
  "",
  '<S id="h.gone">',
  "Gone text.",
  "</S>",
  "",
  '<S id="h.keep">',
  "Keep text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const N_CURRENT = [
  '<S id="x">',
  "Ex text.",
  "</S>",
  "",
  '<S id="y">',
  "Wye text.",
  "</S>",
  "",
  '<S id="m" d={"y"}>',
  "Em text.",
  "</S>",
  "",
  '<S id="m2" tags="alpha beta" coverage="none">',
  "Em two text.",
  "</S>",
  "",
  '<S id="t">',
  "Tee text v1.",
  "</S>",
  "",
  '<S id="dep1" d={"t"}>',
  "Dep one text.",
  "</S>",
  "",
  '<S id="dep2" d={"h.newt"}>',
  "Dep two text.",
  "</S>",
  "",
  '<S id="h">',
  "Aitch own text.",
  "",
  '<S id="h.newt">',
  "Newt text.",
  "</S>",
  "",
  '<S id="h.born">',
  "Born text.",
  "</S>",
  "",
  '<S id="h.keep">',
  "Keep text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const N_CODE_BASELINE = [
  'import N from "../specs/N.xspec";',
  "",
  "N.h.gone;",
  "N.h.keep;",
  "",
].join("\n");

const N_CODE_CURRENT = [
  'import N from "../specs/N.xspec";',
  "",
  "N.h.born;",
  "N.h.keep;",
  "",
].join("\n");

const T10_5_3 = defineProductTest({
  id: "T10.5-3",
  title:
    "metadata, dependency, and code items: one metadata-consistency item per metadata-changed node — m's d retargeting (context: the added and removed d targets), m2's coverage and tags edits (empty context; both changes described in the reason), and dep2's added d edge — one dependency-consistency item per node with a dependency edge to a both-sides target whose effectiveHash changed (dep1 against t; context: the changed target; origin: its originating node), while dep2, whose only affected target h.newt was added since the baseline, gets no dependency-consistency item — the change is reviewed at its source as dep2's own metadata-consistency item (context: the added target); and one code-impact item per impacted location with context the impact-edge targets that make it impacted, deleted (h.gone) and added (h.born) targets included, unchanged targets excluded (SPEC 5.6, 9.2, 10.5)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_CODE_CONFIG,
      { [N_FILE]: N_BASELINE, [N_CODE]: N_CODE_BASELINE },
      async (workspace) => {
        const prefix = "T10.5-3";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(N_FILE, N_CURRENT);
        await workspace.file(N_CODE, N_CODE_CURRENT);
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the edits`,
        );
        await createBaseSession(product, workspace, base, "s", prefix);

        const status = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(status),
          [
            `code-impact ${N_CODE}`,
            `dependency-consistency ${N_DEP1}`,
            `metadata-consistency ${N_DEP2}`,
            `metadata-consistency ${N_M}`,
            `metadata-consistency ${N_M2}`,
            `subtree-coherence ${N_H}`,
            `subtree-coherence ${N_T}`,
          ].sort(),
          `${prefix}: one metadata-consistency item per metadata-changed ` +
            `node (m, m2, dep2), one dependency-consistency item for dep1 ` +
            `alone — dep2's only affected target was added since the ` +
            `baseline, so its change is reviewed at its source — one ` +
            `code-impact item for the impacted location, and the ` +
            `subtree-coherence items of the changed nodes t and h (h's ` +
            `child additions and deletion originate at h; the skipped ` +
            `children generate no own items) (SPEC 5.6, 10.5)`,
        );
        const dcRows = status.items.filter(
          (row) => row.kind === "dependency-consistency",
        );
        if (dcRows.length !== 1 || dcRows[0].scope !== N_DEP1) {
          fail(
            `${prefix}: exactly one dependency-consistency item exists, ` +
              `scoped at dep1 — an edge to a target added since the ` +
              `baseline yields no such item (SPEC 10.5, 5.6); got ` +
              JSON.stringify(dcRows.map((row) => row.scope)),
          );
        }

        const exported = await exportSession(product, workspace, "s", prefix);

        // m: d retargeted x -> y; context is the added and removed targets.
        const mcM = requireItem(
          exported.items,
          "metadata-consistency",
          N_M,
          prefix,
        );
        assertSameJson(
          identitySet(mcM.context),
          [N_X, N_Y].sort(),
          `${prefix}: m's metadata-consistency context is the added and ` +
            `removed d targets (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(mcM.origin),
          [N_M],
          `${prefix}: a metadata-consistency item's scope and origin are ` +
            `the metadata-changed node itself (SPEC 10.5)`,
        );

        // m2: coverage and tags edits — no d change, so no context targets;
        // both changes are described in the reason (SPEC 10.5; H-3:
        // information presence, wording free).
        const mcM2 = requireItem(
          exported.items,
          "metadata-consistency",
          N_M2,
          prefix,
        );
        assertSameJson(
          identitySet(mcM2.context),
          [],
          `${prefix}: m2's metadata-consistency context is empty — its ` +
            `metadata change added or removed no d targets (SPEC 10.5)`,
        );
        if (!/tag/i.test(mcM2.reason) || !/coverage/i.test(mcM2.reason)) {
          fail(
            `${prefix}: m2's item reason must describe its coverage and ` +
              `tags changes (SPEC 10.5: "coverage and tags changes are ` +
              `described in the item's reason"; H-3: any phrasing naming ` +
              `both qualifies); got ${JSON.stringify(mcM2.reason)}`,
          );
        }

        // dep2: the new d edge to the added target surfaces as dep2's own
        // metadata-consistency item, with the added target as context.
        const mcDep2 = requireItem(
          exported.items,
          "metadata-consistency",
          N_DEP2,
          prefix,
        );
        assertSameJson(
          identitySet(mcDep2.context),
          [N_H_NEWT],
          `${prefix}: dep2's new d edge surfaces as its own ` +
            `metadata-consistency item, the added target in context ` +
            `(SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(mcDep2.origin),
          [N_DEP2],
          `${prefix}: dep2's metadata-consistency origin is dep2 itself ` +
            `(SPEC 10.5)`,
        );

        // dep1: dependency edge to t, present on both sides with a changed
        // effectiveHash — context the changed target, origin its originating
        // node.
        const dc = requireItem(
          exported.items,
          "dependency-consistency",
          N_DEP1,
          prefix,
        );
        assertSameJson(
          identitySet(dc.context),
          [N_T],
          `${prefix}: dep1's dependency-consistency context is the changed ` +
            `both-sides target (SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(dc.origin),
          [N_T],
          `${prefix}: dep1's dependency-consistency origin is the ` +
            `originating node of the target's change (SPEC 5.6, 10.5)`,
        );

        // code-impact: context is the impact-edge targets that make the
        // location impacted — the deleted h.gone (a baseline-graph edge) and
        // the added h.born (a current-graph edge) both count as changed, the
        // unchanged h.keep does not (SPEC 9.2, 10.5).
        const ci = requireItem(exported.items, "code-impact", N_CODE, prefix);
        assertSameJson(
          identitySet(ci.context),
          [N_H_BORN, N_H_GONE].sort(),
          `${prefix}: the code-impact context is the impact-edge targets ` +
            `that make the location impacted, added and deleted included, ` +
            `the unchanged target excluded (SPEC 9.2, 10.5)`,
        );
        const gone = ci.context.filter((state) => state.node === N_H_GONE);
        const born = ci.context.filter((state) => state.node === N_H_BORN);
        if (gone.length !== 1 || gone[0].present !== false) {
          fail(
            `${prefix}: the deleted target h.gone is presented absent in ` +
              `the code-impact context (SPEC 10.4, 10.7); got ` +
              JSON.stringify(gone),
          );
        }
        if (born.length !== 1 || born[0].present !== true) {
          fail(
            `${prefix}: the added target h.born is presented present in ` +
              `the code-impact context (SPEC 10.4, 10.7); got ` +
              JSON.stringify(born),
          );
        }
        assertSameJson(
          identitySet(ci.origin),
          [N_H_BORN, N_H_GONE].sort(),
          `${prefix}: the code-impact origin is the originating nodes of ` +
            `the targets' changes — the added and deleted nodes themselves ` +
            `(SPEC 5.6, 10.5)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.5-4 — total item order
// ---------------------------------------------------------------------------

// Two spec files and two code files: items of every kind at controlled
// depths. v's children are declared in document order f, e, g — deliberately
// non-alphabetical, so the absent-scope identity ordering (e before f) is
// distinguishable from stale document order (f before e).
const O_A_FILE = "specs/A.mdx";
const O_B_FILE = "specs/B.mdx";
const O_ABC = "specs/A.mdx#a.b.c";
const O_AB = "specs/A.mdx#a.b";
const O_A = "specs/A.mdx#a";
const O_WM = "specs/A.mdx#w.m";
const O_V = "specs/A.mdx#v";
const O_VF = "specs/A.mdx#v.f";
const O_VE = "specs/A.mdx#v.e";
const O_VG = "specs/A.mdx#v.g";
const O_QD = "specs/B.mdx#q.d";
const O_Q = "specs/B.mdx#q";
const O_XD = "specs/B.mdx#x.d";
const O_ONE = "src/one.ts#f";
const O_TWO = "src/two.ts";

function oASpec(withVEF: boolean): string {
  const vChildren = withVEF
    ? [
        '<S id="v.f">',
        "Vef text v1.",
        "</S>",
        "",
        '<S id="v.e">',
        "Vee-e text v1.",
        "</S>",
        "",
      ]
    : [];
  return [
    '<S id="a">',
    "Aye own text.",
    "",
    '<S id="a.b">',
    "Abe own text.",
    "",
    '<S id="a.b.c">',
    "Abc text v1.",
    "</S>",
    "</S>",
    "</S>",
    "",
    '<S id="w">',
    "Dub own text.",
    "",
    '<S id="w.m" tags="w1">',
    "Wem text.",
    "</S>",
    "</S>",
    "",
    '<S id="v">',
    "Vee own text.",
    "",
    ...vChildren,
    '<S id="v.g">',
    "Veg text v1.",
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const O_A_BASELINE = [
  '<S id="a">',
  "Aye own text.",
  "",
  '<S id="a.b">',
  "Abe own text.",
  "",
  '<S id="a.b.c">',
  "Abc text v0.",
  "</S>",
  "</S>",
  "</S>",
  "",
  '<S id="w">',
  "Dub own text.",
  "",
  '<S id="w.m" tags="w0">',
  "Wem text.",
  "</S>",
  "</S>",
  "",
  '<S id="v">',
  "Vee own text.",
  "",
  '<S id="v.f">',
  "Vef text v0.",
  "</S>",
  "",
  '<S id="v.e">',
  "Vee-e text v0.",
  "</S>",
  "",
  '<S id="v.g">',
  "Veg text v0.",
  "</S>",
  "</S>",
  "",
].join("\n");

function oBSpec(qdText: string): string {
  return [
    'import A from "./A.xspec"',
    "",
    '<S id="q">',
    "Cue own text.",
    "",
    '<S id="q.d">',
    qdText,
    "</S>",
    "</S>",
    "",
    '<S id="x">',
    "Ex own text.",
    "",
    '<S id="x.d" d={A.a.b.c}>',
    "Exd text.",
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const O_ONE_SOURCE = [
  'import A from "../specs/A.xspec"',
  "",
  "export function f() {",
  "  A.a.b.c",
  "}",
  "",
].join("\n");

const O_TWO_SOURCE = ['import B from "../specs/B.xspec"', "", "B.q.d", ""].join(
  "\n",
);

// The expected total order before the deletions (SPEC 10.5): requirement
// scopes by depth deepest-first, then kind, then file path bytes, then
// document order; code-impact items last by location identity.
const O_INITIAL_ORDER: readonly string[] = [
  `subtree-coherence ${O_ABC}`, // depth 3
  `subtree-coherence ${O_VF}`, // depth 2, SC, A.mdx, document order f e g
  `subtree-coherence ${O_VE}`,
  `subtree-coherence ${O_VG}`,
  `subtree-coherence ${O_QD}`, // depth 2, SC, B.mdx
  `metadata-consistency ${O_WM}`, // depth 2, MC (after every depth-2 SC)
  `dependency-consistency ${O_XD}`, // depth 2, DC
  `parent-consistency ${O_AB}`, // depth 2, PC
  `parent-consistency ${O_A}`, // depth 1, PC, A.mdx, document order a v
  `parent-consistency ${O_V}`,
  `parent-consistency ${O_Q}`, // depth 1, PC, B.mdx
  `code-impact ${O_ONE}`, // code locations last, by identity bytes
  `code-impact ${O_TWO}`,
];

// After deleting v.e and v.f: among (depth 2, SC, A.mdx) the present v.g
// comes first (document order applies to present scopes only), the absent
// scopes follow ordered by identity — e before f, the reverse of their former
// document order.
const O_DELETED_ORDER: readonly string[] = [
  `subtree-coherence ${O_ABC}`,
  `subtree-coherence ${O_VG}`,
  `subtree-coherence ${O_VE}`,
  `subtree-coherence ${O_VF}`,
  `subtree-coherence ${O_QD}`,
  `metadata-consistency ${O_WM}`,
  `dependency-consistency ${O_XD}`,
  `parent-consistency ${O_AB}`,
  `parent-consistency ${O_A}`,
  `parent-consistency ${O_V}`,
  `parent-consistency ${O_Q}`,
  `code-impact ${O_ONE}`,
  `code-impact ${O_TWO}`,
];

const T10_5_4 = defineProductTest({
  id: "T10.5-4",
  title:
    "total item order across two spec files and two code locations: requirement-scoped items first by scope-node depth deepest-first, then kind order subtree-coherence, metadata-consistency, dependency-consistency, parent-consistency (kind precedes file path: an A.mdx metadata-consistency item follows a B.mdx subtree-coherence item of the same depth), then scope-node file path bytes, then document order; code-impact items last by location identity bytes; after deleting two scope sections the absent-scope items order after the same group's present one, by scope-node identity — the reverse of their former document order, discriminating the identity key from stale document positions; `status` and `export` present the full order and `next` presents it as the walk order of repeated next-plus-resolve rounds (SPEC 10.4, 10.5)",
  timeoutMs: 420_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_CODE_CONFIG,
      {
        [O_A_FILE]: O_A_BASELINE,
        [O_B_FILE]: oBSpec("Qud text v0."),
        "src/one.ts": O_ONE_SOURCE,
        "src/two.ts": O_TWO_SOURCE,
      },
      async (workspace) => {
        const prefix = "T10.5-4";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(O_A_FILE, oASpec(true));
        await workspace.file(O_B_FILE, oBSpec("Qud text v1."));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the edits`,
        );
        await createBaseSession(product, workspace, base, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(initial.items),
          O_INITIAL_ORDER,
          `${prefix} \`status\` before the deletions: the total item order ` +
            `— depth deepest-first, kind, file path bytes, document order; ` +
            `code-impact last by location identity (SPEC 10.5)`,
        );
        const initialExport = await exportSession(
          product,
          workspace,
          "s",
          prefix,
        );
        assertSameJson(
          exportKindScopeSequence(initialExport.items),
          O_INITIAL_ORDER,
          `${prefix} \`export\` before the deletions presents the same ` +
            `item order (SPEC 10.5, 10.7)`,
        );

        // Delete the v.e and v.f sections (a manual edit, SPEC 6.6) — their
        // items' scope nodes become absent; membership is untouched (no
        // re-derivation happens without an updated resolve).
        await workspace.file(O_A_FILE, oASpec(false));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after deleting v.e and v.f`,
        );
        const veRow = requireRow(initial, "subtree-coherence", O_VE, prefix);
        const afterShown = await showItem(
          product,
          workspace,
          "s",
          veRow.id,
          `${prefix} post-deletion premise`,
        );
        if (afterShown.scope.present !== false) {
          fail(
            `${prefix} staging premise: after the deletion, v.e's item ` +
              `scope must be absent (SPEC 10.4); got ` +
              JSON.stringify(afterShown.scope),
          );
        }

        const deleted = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(deleted.items),
          O_DELETED_ORDER,
          `${prefix} \`status\` after the deletions: present scopes first ` +
            `in document order, absent scopes after them ordered by ` +
            `scope-node identity — v.e before v.f, the reverse of their ` +
            `former document order (SPEC 10.5)`,
        );
        const deletedExport = await exportSession(
          product,
          workspace,
          "s",
          prefix,
        );
        assertSameJson(
          exportKindScopeSequence(deletedExport.items),
          O_DELETED_ORDER,
          `${prefix} \`export\` after the deletions presents the same ` +
            `item order (SPEC 10.5, 10.7)`,
        );

        // `next` presents the order as the walk order: every blocker in
        // this fixture precedes its dependents, so repeated next + resolve
        // rounds visit items exactly in item order (SPEC 10.5, 10.7).
        const expectedIds = deleted.items.map((row) => row.id);
        for (let index = 0; index < expectedIds.length; index += 1) {
          const stepLabel =
            `${prefix} \`review next s --json\` walk step ` +
            `${String(index + 1)} of ${String(expectedIds.length)}`;
          const next = decodeNextReport(
            await runJson(
              product,
              workspace,
              ["review", "next", "s", "--json"],
              stepLabel,
            ),
            stepLabel,
          );
          if (next.fullyResolved || next.item === undefined) {
            fail(
              `${stepLabel}: needing-review items remain, so \`next\` must ` +
                `return one (SPEC 10.7)`,
            );
          }
          if (next.item.id !== expectedIds[index]) {
            fail(
              `${stepLabel}: \`next\` returns the first needing-review ` +
                `unblocked item in item order (SPEC 10.5, 10.7) — expected ` +
                `${expectedIds[index]} (${O_DELETED_ORDER[index]}), got ` +
                `${next.item.id}`,
            );
          }
          await resolveOk(
            product,
            workspace,
            "s",
            next.item.id,
            "no-change",
            `${stepLabel} — \`resolve --status no-change\` to advance the walk`,
          );
        }
        const doneLabel = `${prefix} \`review next s --json\` after the walk`;
        const done = decodeNextReport(
          await runJson(
            product,
            workspace,
            ["review", "next", "s", "--json"],
            doneLabel,
          ),
          doneLabel,
        );
        if (!done.fullyResolved) {
          fail(
            `${doneLabel}: every item is resolved, so \`next\` reports the ` +
              `session fully resolved (SPEC 10.7)`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.5-5 — re-derivation on `updated`
// ---------------------------------------------------------------------------

// Sub-fixture A: two changed branches under distinct parents; p.b is the
// sibling subtree that enters only through re-derivation, r the family that
// stops generating after its edit is reverted.
const W_FILE = "specs/W.mdx";
const W_P = "specs/W.mdx#p";
const W_PA = "specs/W.mdx#p.a";
const W_PB = "specs/W.mdx#p.b";
const W_R = "specs/W.mdx#r";
const W_RC = "specs/W.mdx#r.c";

function wSpec(paText: string, pbText: string, rcText: string): string {
  return [
    '<S id="p">',
    "Pee own text.",
    "",
    '<S id="p.a">',
    paText,
    "</S>",
    "",
    '<S id="p.b">',
    pbText,
    "</S>",
    "</S>",
    "",
    '<S id="r">',
    "Arr own text.",
    "",
    '<S id="r.c">',
    rcText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

// Sub-fixture B: one changed branch g.a with a two-level substructure for
// recursive decomposition; g.a.z is authored later and enters only through
// the decomposition applied at re-derivation.
const V_FILE = "specs/V.mdx";
const V_G = "specs/V.mdx#g";
const V_GA = "specs/V.mdx#g.a";
const V_GAX = "specs/V.mdx#g.a.x";
const V_GAXK = "specs/V.mdx#g.a.x.k";
const V_GAY = "specs/V.mdx#g.a.y";
const V_GAZ = "specs/V.mdx#g.a.z";

function vSpec(gaOwn: string, withZ: boolean): string {
  const zLines = withZ ? ["", '<S id="g.a.z">', "Gaz text.", "</S>"] : [];
  return [
    '<S id="g">',
    "Gee own text.",
    "",
    '<S id="g.a">',
    gaOwn,
    "",
    '<S id="g.a.x">',
    "Gax own text.",
    "",
    '<S id="g.a.x.k">',
    "Gaxk text.",
    "</S>",
    "</S>",
    "",
    '<S id="g.a.y">',
    "Gay text.",
    "</S>",
    ...zLines,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const T10_5_5 = defineProductTest({
  id: "T10.5-5",
  title:
    "re-derivation on `updated`: resolving with no-change/skipped does not re-derive — after a sibling-subtree edit the item set is unchanged and the edit surfaces as read-time invalidation of the resolved parent-consistency item (context-set change with hash premises), not as new items; an `updated` resolve re-derives with the recorded baseline — the newly changed sibling's subtree-coherence item appears in item order created `unresolved` (the trigger's `updated` does not propagate), a matching kind+scope item keeps its id, status, and recorded state, and blockedBy is recomputed; items no longer generated (after reverting their edit) remain with their blockedBy and retain their recorded context set, presented unchanged by show/export after the re-derivation; after two nested `split`s a decomposed kind+scope is never re-added — its decomposition applies recursively, covering a child authored after the splits — and every blockedBy reference to a decomposed item is replaced by all items of its decomposition (SPEC 10.4, 10.5, 10.7)",
  timeoutMs: 480_000,
  run: async (product) => {
    // --- sub-fixture A: derivation basics ------------------------------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [W_FILE]: wSpec("Paa text v0.", "Pab text v0.", "Arc text v0.") },
      async (workspace) => {
        const prefix = "T10.5-5 re-derivation";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(
          W_FILE,
          wSpec("Paa text v1.", "Pab text v0.", "Arc text v1."),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the edits`,
        );
        await createBaseSession(product, workspace, base, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(initial.items),
          [
            `subtree-coherence ${W_PA}`,
            `subtree-coherence ${W_RC}`,
            `parent-consistency ${W_P}`,
            `parent-consistency ${W_R}`,
          ],
          `${prefix}: the two changed leaves yield their subtree-coherence ` +
            `items and their parents' parent-consistency items, in item ` +
            `order (SPEC 10.5)`,
        );
        const scPA = requireRow(initial, "subtree-coherence", W_PA, prefix).id;
        const scRC = requireRow(initial, "subtree-coherence", W_RC, prefix).id;
        const pcP = requireRow(initial, "parent-consistency", W_P, prefix).id;
        const pcR = requireRow(initial, "parent-consistency", W_R, prefix).id;

        await resolveOk(
          product,
          workspace,
          "s",
          scPA,
          "no-change",
          `${prefix} resolve of p.a's subtree-coherence item (the blocker)`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          pcP,
          "no-change",
          `${prefix} resolve of p's parent-consistency item (context {p.a})`,
        );

        // The sibling-subtree edit, with hash premises: p's own/metadata
        // hashes and p.a's subtreeHash must be untouched (SPEC 5.5), so any
        // invalidation of p's item can only come from the context-set change.
        const probes = [W_P, W_PA, W_PB];
        const before = await captureHashes(
          product,
          workspace,
          probes,
          `${prefix} pre-edit capture`,
        );
        await workspace.file(
          W_FILE,
          wSpec("Paa text v1.", "Pab text v1.", "Arc text v1."),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the p.b edit`,
        );
        const after = await captureHashes(
          product,
          workspace,
          probes,
          `${prefix} post-edit capture`,
        );
        for (const [node, hash] of [
          [W_P, "ownHash"],
          [W_P, "metadataHash"],
          [W_PA, "subtreeHash"],
        ] as const) {
          if (before.get(node)?.[hash] !== after.get(node)?.[hash]) {
            fail(
              `${prefix} staging premise: the p.b edit must leave ${node}'s ` +
                `${hash} unchanged (SPEC 5.5) so invalidation can only come ` +
                `from the context-set change`,
            );
          }
        }
        if (before.get(W_PB)?.subtreeHash === after.get(W_PB)?.subtreeHash) {
          fail(
            `${prefix} staging premise: the p.b edit must change p.b's ` +
              `subtreeHash (SPEC 5.5) — otherwise no new changed branch exists`,
          );
        }

        // A non-updated resolve after the edit re-derives nothing: the item
        // set is unchanged (no item for p.b), and the concurrent edit
        // surfaces as invalidation of p's resolved item.
        await resolveOk(
          product,
          workspace,
          "s",
          scRC,
          "skipped",
          `${prefix} \`resolve --status skipped\` after the p.b edit — ` +
            `no-change/skipped resolves do not re-derive (SPEC 10.5)`,
        );
        const preDerive = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(preDerive),
          [
            `parent-consistency ${W_P}`,
            `parent-consistency ${W_R}`,
            `subtree-coherence ${W_PA}`,
            `subtree-coherence ${W_RC}`,
          ].sort(),
          `${prefix}: after the sibling-subtree edit and a skipped resolve ` +
            `the item set is unchanged — sibling subtrees enter only ` +
            `through re-derivation, and neither reads nor ` +
            `no-change/skipped resolves re-derive (SPEC 10.5)`,
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          pcP,
          "invalidated",
          `${prefix}: the concurrent workspace edit surfaces as read-time ` +
            `invalidation of p's resolved parent-consistency item — its ` +
            `generator-derived context set gained the p.b branch while ` +
            `every recorded hash is unchanged (SPEC 10.4, 10.5)`,
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          scPA,
          "no-change",
          `${prefix}: p.a's resolved item is untouched by the p.b edit ` +
            `(SPEC 10.4)`,
        );

        // The `updated` resolve of r's item re-derives the session.
        await resolveOk(
          product,
          workspace,
          "s",
          pcR,
          "updated",
          `${prefix} \`resolve --status updated\` of r's parent-consistency ` +
            `item (unblocked: r.c is resolved) — triggers re-derivation ` +
            `(SPEC 10.5)`,
        );
        const derived = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(derived.items),
          [
            `subtree-coherence ${W_PA}`,
            `subtree-coherence ${W_PB}`,
            `subtree-coherence ${W_RC}`,
            `parent-consistency ${W_P}`,
            `parent-consistency ${W_R}`,
          ],
          `${prefix} after the updated resolve: the newly changed p.b's ` +
            `subtree-coherence item takes its place in item order ` +
            `(SPEC 10.5)`,
        );
        const scPB = requireRow(derived, "subtree-coherence", W_PB, prefix);
        if ([scPA, scRC, pcP, pcR].includes(scPB.id)) {
          fail(
            `${prefix}: the new p.b item's id must be fresh (SPEC 10.2); ` +
              `got ${scPB.id}, colliding with an existing item id`,
          );
        }
        if (scPB.status !== "unresolved") {
          fail(
            `${prefix}: a newly generated item is created unresolved ` +
              `(SPEC 10.2) — the triggering item's \`updated\` status must ` +
              `not propagate to it; got ${scPB.status}`,
          );
        }
        // Matching items keep id, status, and recorded state (SPEC 10.5).
        if (
          requireRow(derived, "subtree-coherence", W_PA, prefix).id !== scPA
        ) {
          fail(
            `${prefix}: p.a's item keeps its id across the re-derivation ` +
              `(SPEC 10.5)`,
          );
        }
        await expectItemStatus(
          product,
          workspace,
          "s",
          scPA,
          "no-change",
          `${prefix}: p.a's matching item keeps its status and recorded ` +
            `state across the re-derivation (SPEC 10.5)`,
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          scRC,
          "skipped",
          `${prefix}: r.c's matching item keeps its skipped status ` +
            `(SPEC 10.5)`,
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          pcR,
          "updated",
          `${prefix}: the trigger item keeps its just-resolved updated ` +
            `status — its context {r.c} did not change (SPEC 10.4, 10.5)`,
        );
        await expectItemStatus(
          product,
          workspace,
          "s",
          pcP,
          "invalidated",
          `${prefix}: p's item — resolved, with a context set that changed ` +
            `— is invalidated (SPEC 10.4, 10.5)`,
        );
        const derivedExport = await exportSession(
          product,
          workspace,
          "s",
          prefix,
        );
        assertBlockedBy(
          requireItem(derivedExport.items, "parent-consistency", W_P, prefix),
          [scPA, scPB.id],
          `${prefix} after the re-derivation, p's parent-consistency item ` +
            `— blockedBy is recomputed per branch`,
        );
        assertBlockedBy(
          requireItem(derivedExport.items, "parent-consistency", W_R, prefix),
          [scRC],
          `${prefix} after the re-derivation, r's parent-consistency item`,
        );
        assertSameJson(
          identitySet(
            requireItem(derivedExport.items, "parent-consistency", W_P, prefix)
              .context,
          ),
          [W_PA, W_PB].sort(),
          `${prefix}: p's matched item's context set is updated to the ` +
            `union of changed branches (SPEC 10.5)`,
        );

        // Revert r.c to its baseline text: r's family stops generating.
        await workspace.file(
          W_FILE,
          wSpec("Paa text v1.", "Pab text v1.", "Arc text v0."),
        );
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after reverting r.c`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          scPB.id,
          "updated",
          `${prefix} \`resolve --status updated\` of p.b's item — a second ` +
            `re-derivation, now generating nothing for r (SPEC 10.5)`,
        );
        const final = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(final),
          [
            `parent-consistency ${W_P}`,
            `parent-consistency ${W_R}`,
            `subtree-coherence ${W_PA}`,
            `subtree-coherence ${W_PB}`,
            `subtree-coherence ${W_RC}`,
          ].sort(),
          `${prefix}: items no longer generated remain in the session ` +
            `(SPEC 10.5)`,
        );
        const finalExport = await exportSession(
          product,
          workspace,
          "s",
          prefix,
        );
        assertBlockedBy(
          requireItem(finalExport.items, "parent-consistency", W_R, prefix),
          [scRC],
          `${prefix}: r's no-longer-generated item keeps its blockedBy ` +
            `(SPEC 10.5)`,
        );
        assertSameJson(
          identitySet(
            requireItem(finalExport.items, "parent-consistency", W_R, prefix)
              .context,
          ),
          [W_RC],
          `${prefix}: r's no-longer-generated item retains its recorded ` +
            `context set — \`export\` after the re-derivation presents it ` +
            `unchanged (SPEC 10.4, 10.5)`,
        );
        const shownPcR = await showItem(
          product,
          workspace,
          "s",
          pcR,
          `${prefix} post-re-derivation`,
        );
        assertSameJson(
          identitySet(shownPcR.context),
          [W_RC],
          `${prefix}: \`show\` presents the retained context unchanged too ` +
            `(SPEC 10.4, 10.5)`,
        );
      },
    );

    // --- sub-fixture B: split decompositions govern re-derivation ------------
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [V_FILE]: vSpec("Gaa own v0.", false) },
      async (workspace) => {
        const prefix = "T10.5-5 decomposition";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(V_FILE, vSpec("Gaa own v1.", false));
        await buildOk(product, workspace, `${prefix} \`build\` after the edit`);
        await createBaseSession(product, workspace, base, "s", prefix);

        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(initial),
          [`parent-consistency ${V_G}`, `subtree-coherence ${V_GA}`].sort(),
          `${prefix}: g.a's edit yields its subtree-coherence item and g's ` +
            `parent-consistency item (SPEC 10.5)`,
        );
        const scGA = requireRow(initial, "subtree-coherence", V_GA, prefix).id;
        const pcG = requireRow(initial, "parent-consistency", V_G, prefix).id;

        // First split: g.a's item decomposes into its child items plus g.a's
        // parent-consistency item (SPEC 10.7).
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", scGA],
          0,
          `${prefix} \`review split s <g.a item>\``,
        );
        const afterSplit1 = await sessionStatus(
          product,
          workspace,
          "s",
          prefix,
        );
        assertSameJson(
          kindScopeSet(afterSplit1),
          [
            `parent-consistency ${V_G}`,
            `parent-consistency ${V_GA}`,
            `subtree-coherence ${V_GAX}`,
            `subtree-coherence ${V_GAY}`,
          ].sort(),
          `${prefix} after the first split: one subtree-coherence item per ` +
            `child subtree plus g.a's parent-consistency item; the original ` +
            `is removed (SPEC 10.7)`,
        );
        const scX = requireRow(
          afterSplit1,
          "subtree-coherence",
          V_GAX,
          prefix,
        ).id;
        const scY = requireRow(
          afterSplit1,
          "subtree-coherence",
          V_GAY,
          prefix,
        ).id;
        const pcGA = requireRow(
          afterSplit1,
          "parent-consistency",
          V_GA,
          prefix,
        ).id;

        // Second split: g.a.x's item decomposes in turn.
        await expectExit(
          product,
          workspace,
          ["review", "split", "s", scX],
          0,
          `${prefix} \`review split s <g.a.x item>\``,
        );
        const afterSplit2 = await sessionStatus(
          product,
          workspace,
          "s",
          prefix,
        );
        const scK = requireRow(
          afterSplit2,
          "subtree-coherence",
          V_GAXK,
          prefix,
        ).id;
        const pcGAX = requireRow(
          afterSplit2,
          "parent-consistency",
          V_GAX,
          prefix,
        ).id;

        // Author a new child g.a.z after the splits (SPEC 6.6, a manual
        // edit): it enters only through the decomposition applied at
        // re-derivation — g.a.z itself is a changed node with the changed
        // ancestor g.a, so rule 1 skips it.
        await workspace.file(V_FILE, vSpec("Gaa own v1.", true));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after authoring g.a.z`,
        );

        // The `updated` resolve re-derives: the generated subtree-coherence
        // item for g.a is never re-added — its recorded decomposition
        // applies instead, recursively through g.a.x's decomposition, over
        // the current child subtrees (g.a.z included).
        await resolveOk(
          product,
          workspace,
          "s",
          scK,
          "updated",
          `${prefix} \`resolve --status updated\` of g.a.x.k's item — ` +
            `triggers re-derivation (SPEC 10.5)`,
        );
        const derived = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(derived.items),
          [
            `subtree-coherence ${V_GAXK}`,
            `subtree-coherence ${V_GAY}`,
            `subtree-coherence ${V_GAZ}`,
            `parent-consistency ${V_GAX}`,
            `parent-consistency ${V_GA}`,
            `parent-consistency ${V_G}`,
          ],
          `${prefix} after the re-derivation: no subtree-coherence item for ` +
            `g.a or g.a.x is re-added (their decompositions apply, ` +
            `recursively); g.a.z's item — one per current child subtree of ` +
            `the decomposed scope — takes its place in item order ` +
            `(SPEC 10.5, 10.7)`,
        );
        const scZ = requireRow(derived, "subtree-coherence", V_GAZ, prefix);
        const priorIds = [scGA, pcG, scX, scY, pcGA, scK, pcGAX];
        if (priorIds.includes(scZ.id)) {
          fail(
            `${prefix}: g.a.z's item id must be fresh — removed ids are ` +
              `never reused (SPEC 10.7); got ${scZ.id}`,
          );
        }
        if (scZ.status !== "unresolved") {
          fail(
            `${prefix}: g.a.z's item is created unresolved (SPEC 10.2); ` +
              `got ${scZ.status}`,
          );
        }
        for (const [id, node] of [
          [scK, V_GAXK],
          [scY, V_GAY],
          [pcGA, V_GA],
          [pcGAX, V_GAX],
          [pcG, V_G],
        ] as const) {
          const rows = derived.items.filter((row) => row.id === id);
          if (rows.length !== 1 || rows[0].scope !== node) {
            fail(
              `${prefix}: the existing item ${id} (scope ${node}) is ` +
                `matched and kept by the re-derivation (SPEC 10.5); rows: ` +
                JSON.stringify(rows),
            );
          }
        }

        const exported = await exportSession(product, workspace, "s", prefix);
        // blockedBy recomputation with decomposed references replaced by
        // their decompositions, recursively (SPEC 10.5, 10.7): g's item is
        // blocked by every item of g.a's recursive decomposition; g.a's
        // parent-consistency item by the current child items (g.a.x's
        // replaced by its decomposition); g.a.x's by its child item.
        assertBlockedBy(
          requireItem(exported.items, "parent-consistency", V_G, prefix),
          [scK, pcGAX, scY, scZ.id, pcGA],
          `${prefix} g's parent-consistency item — the reference to g.a's ` +
            `decomposed subtree-coherence item is replaced by all items of ` +
            `its decomposition, recursively`,
        );
        assertBlockedBy(
          requireItem(exported.items, "parent-consistency", V_GA, prefix),
          [scK, pcGAX, scY, scZ.id],
          `${prefix} g.a's parent-consistency item — blocked by the current ` +
            `child subtrees' items, g.a.x's entering via its decomposition`,
        );
        assertBlockedBy(
          requireItem(exported.items, "parent-consistency", V_GAX, prefix),
          [scK],
          `${prefix} g.a.x's parent-consistency item — blocked by its child ` +
            `subtree's item`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T10.5-6 — baseline recording
// ---------------------------------------------------------------------------

const C6_FILE = "specs/C.mdx";
const C6_PAR = "specs/C.mdx#par";
const C6_K = "specs/C.mdx#par.k";
const C6_S = "specs/C.mdx#par.s";

function c6Spec(kText: string, sText: string): string {
  return [
    '<S id="par">',
    "Par own text.",
    "",
    '<S id="par.k">',
    kText,
    "</S>",
    "",
    '<S id="par.s">',
    sText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
}

const T10_5_6 = defineProductTest({
  id: "T10.5-6",
  title:
    "baseline recording: the session records the commit identity `--base` resolved to at creation — after the session is created against a branch, the branch is renamed away and a decoy branch reusing the name is planted at a later commit (and HEAD moves past the reviewed edit), yet re-derivation on an `updated` resolve still diffs against the recorded commit: the parent-consistency item's recomputed context and blockedBy cover both changed branches (the pre-decoy edit included), where a product re-resolving the ref spelling or using HEAD would see only the newer edit (SPEC 6.3, 10.5, 10.7)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [C6_FILE]: c6Spec("Kay text v0.", "Ess text v0.") },
      async (workspace) => {
        const prefix = "T10.5-6";
        await workspace.gitInit();
        const c1 = await workspace.gitCommitAll("baseline");
        await workspace.git(["branch", "mark"]);

        await workspace.file(C6_FILE, c6Spec("Kay text v1.", "Ess text v0."));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the par.k edit`,
        );
        await createBaseSession(product, workspace, "mark", "s", prefix);
        const initial = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSet(initial),
          [`parent-consistency ${C6_PAR}`, `subtree-coherence ${C6_K}`].sort(),
          `${prefix}: the par.k edit against the mark baseline yields its ` +
            `subtree-coherence item and par's parent-consistency item ` +
            `(SPEC 10.5)`,
        );
        const scK = requireRow(initial, "subtree-coherence", C6_K, prefix).id;
        const pcPar = requireRow(
          initial,
          "parent-consistency",
          C6_PAR,
          prefix,
        ).id;

        // HEAD movement: commit the reviewed edit; then rename the baseline
        // branch away and plant a decoy branch reusing the name at the new
        // commit. A product that recorded the ref spelling instead of the
        // resolved commit identity now resolves `mark` to c2.
        const c2 = await workspace.gitCommitAll("advance");
        if (c2 === c1) {
          fail(
            `${prefix} staging premise: the advance commit must differ from ` +
              `the baseline commit`,
          );
        }
        await workspace.git(["branch", "-m", "mark", "mark-elsewhere"]);
        await workspace.git(["branch", "mark"]);
        const resolved = (
          await workspace.git(["rev-parse", "mark"])
        ).stdout.trim();
        if (resolved !== c2) {
          fail(
            `${prefix} staging premise: after the rename and re-plant, the ` +
              `ref spelling "mark" must resolve to the advance commit ` +
              `${c2}; git reports ${resolved}`,
          );
        }

        // A second changed branch, then the updated resolve: re-derivation
        // runs the generators against the recorded commit (c1), under which
        // par.k and par.s are both changed. Against the decoy `mark` or
        // HEAD (both c2), par.k's committed edit is invisible.
        await workspace.file(C6_FILE, c6Spec("Kay text v1.", "Ess text v1."));
        await buildOk(
          product,
          workspace,
          `${prefix} \`build\` after the par.s edit`,
        );
        await resolveOk(
          product,
          workspace,
          "s",
          scK,
          "updated",
          `${prefix} \`resolve --status updated\` of par.k's item — ` +
            `triggers re-derivation against the recorded baseline ` +
            `(SPEC 10.5, 10.7)`,
        );

        const derived = await sessionStatus(product, workspace, "s", prefix);
        assertSameJson(
          kindScopeSequence(derived.items),
          [
            `subtree-coherence ${C6_K}`,
            `subtree-coherence ${C6_S}`,
            `parent-consistency ${C6_PAR}`,
          ],
          `${prefix} after the re-derivation: par.s's item enters in item ` +
            `order (SPEC 10.5)`,
        );
        const scS = requireRow(derived, "subtree-coherence", C6_S, prefix);
        if (scS.status !== "unresolved") {
          fail(
            `${prefix}: par.s's new item is created unresolved (SPEC 10.2); ` +
              `got ${scS.status}`,
          );
        }
        const exported = await exportSession(product, workspace, "s", prefix);
        const pcItem = requireItem(
          exported.items,
          "parent-consistency",
          C6_PAR,
          prefix,
        );
        if (
          pcItem.id !== pcPar ||
          exported.items.filter((item) => item.id === scK).length !== 1
        ) {
          fail(
            `${prefix}: the existing items keep their ids across the ` +
              `re-derivation (SPEC 10.5)`,
          );
        }
        assertSameJson(
          identitySet(pcItem.context),
          [C6_K, C6_S].sort(),
          `${prefix}: par's recomputed context covers both changed branches ` +
            `— the generators ran against the recorded commit, not the ` +
            `moved HEAD or the decoy ref now bearing the --base spelling ` +
            `(SPEC 6.3, 10.5, 10.7: later HEAD movement or branch renames ` +
            `do not change what generators run against)`,
        );
        assertBlockedBy(
          pcItem,
          [scK, scS.id],
          `${prefix} par's parent-consistency item after the re-derivation ` +
            `— one blocker per changed branch relative to the recorded ` +
            `commit`,
        );
      },
    );
  },
});

/** TEST-SPEC §10.5, in canonical ID order (SUITE-36). */
export const section105Tests: readonly ProductTestEntry[] = [
  T10_5_1,
  T10_5_2,
  T10_5_3,
  T10_5_4,
  T10_5_5,
  T10_5_6,
];
