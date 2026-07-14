// TEST-SPEC §5.6 (change categories) — SUITE-20: T5.6-1…T5.6-6.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// Per the §5.6 preamble, every test here runs `impact --base <ref>` against a
// committed git baseline and asserts the SPEC 5.6 categories with attribution
// (SPEC 9.1). Baselines are committed sources only (no build output at the
// ref); the current side is the edited working tree.
//
// Conservative operationalizations (noted per H-4):
// - Impact entries: an uncategorized, undeleted node has no requirement entry
//   (SPEC 9.3 groups output by category) — the interpretation the suite fixed
//   in T1.5-1 and carried through T5.4-1.
// - Entry granularity: SPEC 9.3 fixes the grouping and the collapsing of
//   ancestor chains, not the adapter-level entry granularity, so assertions
//   here merge categories per node identity across entries — a per-node and a
//   per-category grouping both pass. Collapsing itself is T9.3-1's business.
// - Attribution: TEST-SPEC §5.6 pins the attribution of the propagated
//   categories — `descendant-changed` and `upstream-changed` ("attributed to
//   the leaf", "attributed to P and C", "attributed to D") — and those are
//   asserted exactly, the upstream cascade attributed to the same originating
//   nodes as the ancestors' cascade (SPEC 5.6: "all attributed to the leaf",
//   "the `upstream-changed` cascade follows as above"; the interpretation
//   T2.7-2 already pins). For the originating categories (`changed`,
//   `metadata-changed`) no test text pins an attribution; SPEC 5.6 still
//   bounds it ("every category MUST be attributed to its originating nodes"),
//   so their `attributedTo` is asserted to lie within the fixture's
//   originating-node set, the empty list accepted — attribution of an
//   originating node to itself may be left implicit.

import * as fsp from "node:fs/promises";
import type {
  ChangeCategory,
  ImpactReport,
} from "../../helpers/adapters/index.js";
import { decodeImpactReport } from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { assertSameJson, buildOk, expectExit } from "./support.js";

// Several definitions below are exported for test/suite/registry/section-9.ts:
// T9.1-1 asserts that requirement-level `impact` output equals the categories
// and attributions of 5.6 over fixtures shared with T5.6-* (TEST-SPEC §9), so
// it drives the same staging, fixture sources, and assertion machinery.

// Minimal declarative configuration (SPEC 7): exactly one spec group. No code
// groups exist in any fixture here, so no code location can be impacted.
export const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

/** Stage a fresh spec-only workspace, run `body`, dispose (H-1). */
async function withWorkspace<T>(
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({
    files: { "xspec.config.ts": SPECS_ONLY_CONFIG, ...files },
  });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/**
 * `impact --base <ref> --json`: exit 0 (impact is informational, SPEC 9.3;
 * H-5) with exactly one JSON document, decoded as the impact report (H-3).
 */
export async function impactAgainst(
  product: ProductBinding,
  workspace: TestWorkspace,
  ref: string,
  context: string,
): Promise<ImpactReport> {
  const result = await expectExit(
    product,
    workspace,
    ["impact", "--base", ref, "--json"],
    0,
    context,
  );
  return decodeImpactReport(parseJsonStdout(result, context), context);
}

/** Expected attribution for one category of one node (module header, H-4). */
export interface ExpectedCategory {
  readonly category: ChangeCategory;
  /**
   * Attribution pinned by TEST-SPEC text: the merged `attributedTo` must
   * equal exactly this set. Exactly one of `exact`/`within` per category.
   */
  readonly exact?: readonly string[];
  /**
   * Attribution unpinned by TEST-SPEC (originating categories): the merged
   * `attributedTo` must be a subset of this set — SPEC 5.6's bound that every
   * category is attributed to originating nodes. Empty attribution passes.
   */
  readonly within?: readonly string[];
}

/** The complete expectation for one node identity of a fixture. */
export interface ExpectedNodeImpact {
  /** Current identity; the (journal-mapped) baseline identity when deleted. */
  readonly identity: string;
  /** Whether entries naming the node must flag it deleted (default false). */
  readonly deleted?: boolean;
  /** The node's exact category set; empty = must receive no category. */
  readonly categories: readonly ExpectedCategory[];
}

/**
 * Assert an impact report's full content for a fixture without code groups:
 * the requirement-level expectation table of
 * {@link assertRequirementCategories} plus empty directly/transitively
 * impacted code — no code group is configured, so no code location can be
 * impacted (SPEC 9.2). Fixtures whose impacted-code groups are non-empty
 * (T15-1) call {@link assertRequirementCategories} directly and assert the
 * code groups separately.
 */
export function assertImpactCategories(
  report: ImpactReport,
  expectations: readonly ExpectedNodeImpact[],
  context: string,
): void {
  assertRequirementCategories(report, expectations, context);
  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: no code groups are configured, so no code location is impacted (SPEC 9.2)`,
  );
}

/**
 * Assert an impact report's requirement-level content against the complete
 * per-node expectation table of a fixture (SPEC 5.6, 9.1):
 *
 * - every identity named by any entry must be in the table — a category for a
 *   node outside it is a phantom;
 * - a node whose expected category set is empty must be named by no entry
 *   (the T1.5-1 convention: SPEC 9.3 groups output by category, so an
 *   uncategorized node appears under none);
 * - every entry naming a node must agree with its expected deleted flag;
 * - the categories merged across entries naming the node must equal the
 *   expected set exactly, each attribution checked per its expectation.
 *
 * The impacted-code groups are not touched: fixtures without code groups use
 * {@link assertImpactCategories}, which adds the empty-code assertion.
 */
export function assertRequirementCategories(
  report: ImpactReport,
  expectations: readonly ExpectedNodeImpact[],
  context: string,
): void {
  const expectedBy = new Map<string, ExpectedNodeImpact>();
  for (const expectation of expectations) {
    if (expectedBy.has(expectation.identity)) {
      throw new Error(
        `fixture bug: duplicate expectation for ${expectation.identity}`,
      );
    }
    expectedBy.set(expectation.identity, expectation);
  }

  // Merge the report per node identity (module header: SPEC 9.3 fixes the
  // grouping, not the adapter-level entry granularity).
  interface MergedNode {
    readonly deletedFlags: Set<boolean>;
    readonly attributions: Map<ChangeCategory, string[]>;
  }
  const actualBy = new Map<string, MergedNode>();
  for (const entry of report.requirements) {
    for (const identity of entry.nodes) {
      const expected = expectedBy.get(identity);
      if (expected === undefined) {
        fail(
          `${context}: the report names ${JSON.stringify(identity)}, which is no ` +
            `node of the fixture (in the workspace-relative identity form of ` +
            `SPEC 1.5) and no staged deleted identity; entry: ${JSON.stringify(entry)}`,
        );
      }
      let merged = actualBy.get(identity);
      if (merged === undefined) {
        merged = { deletedFlags: new Set(), attributions: new Map() };
        actualBy.set(identity, merged);
      }
      merged.deletedFlags.add(entry.deleted);
      for (const category of entry.categories) {
        const attributed = merged.attributions.get(category.category) ?? [];
        attributed.push(...category.attributedTo);
        merged.attributions.set(category.category, attributed);
      }
    }
  }

  for (const expected of expectations) {
    const merged = actualBy.get(expected.identity);
    const expectedNames = expected.categories
      .map((category) => category.category)
      .sort();

    if (expectedNames.length === 0) {
      if (merged !== undefined) {
        fail(
          `${context}: ${expected.identity} must receive no category (SPEC 5.6) ` +
            `and so appear in no requirement entry (SPEC 9.3 groups output by ` +
            `category; the T1.5-1 convention), but the report names it with ` +
            `categories ${JSON.stringify([...merged.attributions.keys()].sort())}`,
        );
      }
      continue;
    }
    if (merged === undefined) {
      fail(
        `${context}: ${expected.identity} must carry exactly the categories ` +
          `${JSON.stringify(expectedNames)} (SPEC 5.6), but no requirement ` +
          `entry names it`,
      );
    }

    const expectedDeleted = expected.deleted ?? false;
    for (const flag of merged.deletedFlags) {
      if (flag !== expectedDeleted) {
        fail(
          `${context}: ${expected.identity} must be reported ` +
            `${expectedDeleted ? "as deleted, under its baseline identity" : "as present on both sides, not deleted"} ` +
            `(SPEC 5.6, 9.3); an entry naming it has deleted: ${String(flag)}`,
        );
      }
    }

    assertSameJson(
      [...merged.attributions.keys()].sort(),
      expectedNames,
      `${context}: the exact category set of ${expected.identity} (SPEC 5.6 — ` +
        `categories are independent flags; none missing, none extra)`,
    );

    for (const category of expected.categories) {
      const attributed = [
        ...new Set(merged.attributions.get(category.category) ?? []),
      ].sort();
      if (category.exact !== undefined) {
        assertSameJson(
          attributed,
          [...category.exact].sort(),
          `${context}: the ${category.category} category of ${expected.identity} ` +
            `must be attributed to exactly its originating node(s) (SPEC 5.6, 9.1)`,
        );
      } else if (category.within !== undefined) {
        for (const identity of attributed) {
          if (!category.within.includes(identity)) {
            fail(
              `${context}: the ${category.category} category of ${expected.identity} ` +
                `is attributed to ${JSON.stringify(identity)}, which is no ` +
                `originating node of this change — every category is attributed ` +
                `to its originating nodes, those carrying \`changed\` or ` +
                `\`metadata-changed\` (SPEC 5.6); originating nodes: ` +
                JSON.stringify([...category.within].sort()),
            );
          }
        }
      } else {
        throw new Error(
          `fixture bug: category ${category.category} of ${expected.identity} ` +
            `declares neither an exact nor a within attribution expectation`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// T5.6-1 — leaf edit (SPEC.md 5.6's worked example)
// ---------------------------------------------------------------------------

// The edited tree: leaf under two ancestors plus the file root, with a
// sibling subtree beside the leaf (`sib` + `sib.inner`) and a sibling subtree
// beside its parent (`other`) — both must stay uncategorized.
const T1_TREE = "specs/Tree.mdx";
const T1_LEAF = "specs/Tree.mdx#top.mid.leaf";
const T1_MID = "specs/Tree.mdx#top.mid";
const T1_TOP = "specs/Tree.mdx#top";
const T1_SIB = "specs/Tree.mdx#top.mid.sib";
const T1_SIB_INNER = "specs/Tree.mdx#top.mid.sib.inner";
const T1_OTHER = "specs/Tree.mdx#top.other";

const treeSource = (leafText: string): string =>
  [
    '<S id="top">',
    "Top text.",
    "",
    '<S id="top.mid">',
    "Mid text.",
    "",
    '<S id="top.mid.leaf">',
    leafText,
    "</S>",
    "",
    '<S id="top.mid.sib">',
    "Sibling text.",
    "",
    '<S id="top.mid.sib.inner">',
    "Inner sibling text.",
    "</S>",
    "</S>",
    "</S>",
    "",
    '<S id="top.other">',
    "Other subtree text.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

// Dependents of two distinct nodes on the leaf-to-root path (the leaf itself
// and its ancestor `top.mid`), each under its own holder so the holders and
// the file root exercise the dependents'-ancestors cascade.
const T1_DEPS = "specs/Deps.mdx";
const T1_ONLEAF = "specs/Deps.mdx#onleaf";
const T1_ONLEAF_DEP = "specs/Deps.mdx#onleaf.dep";
const T1_ONMID = "specs/Deps.mdx#onmid";
const T1_ONMID_DEP = "specs/Deps.mdx#onmid.dep";

// Parameterized by onmid.dep's `d` expression: T5.6-1 uses the single target
// on the leaf-to-root path; T9.1-1's second arm edits the target list on this
// shared fixture (metadata-changed with its upstream cascade, SPEC 5.6).
const depsSource = (onmidD: string): string =>
  [
    'import Tree from "./Tree.xspec"',
    "",
    '<S id="onleaf">',
    "On-leaf holder text.",
    "",
    '<S id="onleaf.dep" d={Tree.top.mid.leaf}>',
    "Depends on the edited leaf.",
    "</S>",
    "</S>",
    "",
    '<S id="onmid">',
    "On-mid holder text.",
    "",
    `<S id="onmid.dep" d={${onmidD}}>`,
    "Depends on an ancestor on the path.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

const T1_DEPS_SOURCE = depsSource("Tree.top.mid");

/**
 * The worked-example fixture of T5.6-1 (SPEC 5.6's leaf-edit example) —
 * exported because T9.1-1 asserts the categories and attributions of 5.6
 * over fixtures shared with T5.6-* (TEST-SPEC §9, §5.6). File paths double
 * as the file roots' identities (SPEC 1.5).
 */
export const workedExample = {
  treeFile: T1_TREE,
  depsFile: T1_DEPS,
  /** Tree source, parameterized by the leaf's text run (the edited run). */
  treeSource,
  /** Deps source, parameterized by onmid.dep's `d` expression. */
  depsSource,
  identities: {
    tree: T1_TREE,
    top: T1_TOP,
    mid: T1_MID,
    leaf: T1_LEAF,
    sib: T1_SIB,
    sibInner: T1_SIB_INNER,
    other: T1_OTHER,
    deps: T1_DEPS,
    onleaf: T1_ONLEAF,
    onleafDep: T1_ONLEAF_DEP,
    onmid: T1_ONMID,
    onmidDep: T1_ONMID_DEP,
  },
} as const;

/**
 * The complete per-node expectation table for the worked example's leaf edit
 * (SPEC 5.6's own worked example, 9.1) — asserted by T5.6-1 and, over the
 * shared fixture, by T9.1-1.
 */
export function workedExampleLeafEditExpectations(): readonly ExpectedNodeImpact[] {
  return [
    // The one originating node: its own-text run was edited.
    {
      identity: T1_LEAF,
      categories: [{ category: "changed", within: [T1_LEAF] }],
    },
    // Every ancestor: `descendant-changed` attributed to the leaf.
    {
      identity: T1_MID,
      categories: [{ category: "descendant-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_TOP,
      categories: [{ category: "descendant-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_TREE,
      categories: [{ category: "descendant-changed", exact: [T1_LEAF] }],
    },
    // Sibling subtrees receive no category.
    { identity: T1_SIB, categories: [] },
    { identity: T1_SIB_INNER, categories: [] },
    { identity: T1_OTHER, categories: [] },
    // Dependents of nodes on the path, and their ancestors:
    // `upstream-changed`, all attributed to the leaf.
    {
      identity: T1_ONLEAF_DEP,
      categories: [{ category: "upstream-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_ONMID_DEP,
      categories: [{ category: "upstream-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_ONLEAF,
      categories: [{ category: "upstream-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_ONMID,
      categories: [{ category: "upstream-changed", exact: [T1_LEAF] }],
    },
    {
      identity: T1_DEPS,
      categories: [{ category: "upstream-changed", exact: [T1_LEAF] }],
    },
  ];
}

const T5_6_1 = defineProductTest({
  id: "T5.6-1",
  title:
    "leaf edit, SPEC.md's worked example: `impact --base <ref>` reports the leaf `changed`; every ancestor `descendant-changed` attributed to the leaf; sibling subtrees uncategorized; dependents of nodes on the path (the leaf and an ancestor) and those dependents' ancestors `upstream-changed`, all attributed to the leaf (SPEC 5.6, 9.1)",
  run: async (product) => {
    await withWorkspace(
      { [T1_TREE]: treeSource("Leaf text v1."), [T1_DEPS]: T1_DEPS_SOURCE },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(T1_TREE, treeSource("Leaf text v2."));
        await buildOk(
          product,
          workspace,
          "T5.6-1 `build` over the leaf-edited workspace",
        );

        const label =
          "T5.6-1 `impact --base <baseline> --json` after the leaf edit";
        assertImpactCategories(
          await impactAgainst(product, workspace, base, label),
          workedExampleLeafEditExpectations(),
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.6-2 — child add/remove
// ---------------------------------------------------------------------------

// Add arm: `wrap.parent` gains child `new` (its sibling `old` untouched).
const T2_ADD = "specs/Add.mdx";
const T2_WRAP = "specs/Add.mdx#wrap";
const T2_P_ADD = "specs/Add.mdx#wrap.parent";
const T2_OLD = "specs/Add.mdx#wrap.parent.old";
const T2_NEW = "specs/Add.mdx#wrap.parent.new";

const T2_ADD_HEAD = [
  '<S id="wrap">',
  "Wrap text.",
  "",
  '<S id="wrap.parent">',
  "Parent text.",
  "",
  '<S id="wrap.parent.old">',
  "Existing child text.",
  "</S>",
];
const T2_ADD_TAIL = ["</S>", "</S>", ""];
const T2_ADD_BASELINE = [...T2_ADD_HEAD, ...T2_ADD_TAIL].join("\n");
const T2_ADD_CURRENT = [
  ...T2_ADD_HEAD,
  "",
  '<S id="wrap.parent.new">',
  "Added child text.",
  "</S>",
  ...T2_ADD_TAIL,
].join("\n");

// Remove arm: `wrap2.parent2` loses child `gone` (its sibling `keep` stays).
const T2_REM = "specs/Rem.mdx";
const T2_WRAP2 = "specs/Rem.mdx#wrap2";
const T2_P_REM = "specs/Rem.mdx#wrap2.parent2";
const T2_KEEP = "specs/Rem.mdx#wrap2.parent2.keep";
const T2_GONE = "specs/Rem.mdx#wrap2.parent2.gone";

const T2_REM_HEAD = [
  '<S id="wrap2">',
  "Wrap-two text.",
  "",
  '<S id="wrap2.parent2">',
  "Parent-two text.",
  "",
  '<S id="wrap2.parent2.keep">',
  "Kept child text.",
  "</S>",
];
const T2_REM_GONE = [
  "",
  '<S id="wrap2.parent2.gone">',
  "Removed child text.",
  "</S>",
];
const T2_REM_TAIL = ["</S>", "</S>", ""];
const T2_REM_BASELINE = [...T2_REM_HEAD, ...T2_REM_GONE, ...T2_REM_TAIL].join(
  "\n",
);
const T2_REM_CURRENT = [...T2_REM_HEAD, ...T2_REM_TAIL].join("\n");

// One dependent of each parent, each in its own file, so the upstream cascade
// of each arm attributes to exactly that arm's originating nodes.
const T2_ADD_DEPS = "specs/AddDeps.mdx";
const T2_HOLDADD = "specs/AddDeps.mdx#holdadd";
const T2_HOLDADD_DEP = "specs/AddDeps.mdx#holdadd.dep";
const T2_ADD_DEPS_SOURCE = [
  'import Add from "./Add.xspec"',
  "",
  '<S id="holdadd">',
  "Add-side holder text.",
  "",
  '<S id="holdadd.dep" d={Add.wrap.parent}>',
  "Depends on the parent gaining a child.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T2_REM_DEPS = "specs/RemDeps.mdx";
const T2_HOLDREM = "specs/RemDeps.mdx#holdrem";
const T2_HOLDREM_DEP = "specs/RemDeps.mdx#holdrem.dep";
const T2_REM_DEPS_SOURCE = [
  'import Rem from "./Rem.xspec"',
  "",
  '<S id="holdrem">',
  "Remove-side holder text.",
  "",
  '<S id="holdrem.dep" d={Rem.wrap2.parent2}>',
  "Depends on the parent losing a child.",
  "</S>",
  "</S>",
  "",
].join("\n");

// The originating nodes of the two staged edits (SPEC 5.6: those carrying
// `changed` — structural edits originate at the parent, and the added and the
// removed child are `changed` themselves).
const T2_ORIGINATORS = [T2_NEW, T2_P_ADD, T2_GONE, T2_P_REM];

const T5_6_2 = defineProductTest({
  id: "T5.6-2",
  title:
    "child add/remove: the added child C is `changed`; the removed child reports as deleted and `changed`; each parent P is `changed` and `descendant-changed` attributed to C; P's ancestors are `descendant-changed` attributed to P and C; and the upstream cascade follows as in T5.6-1, attributed to the originating nodes (SPEC 5.6, 9.1, 9.3)",
  run: async (product) => {
    await withWorkspace(
      {
        [T2_ADD]: T2_ADD_BASELINE,
        [T2_REM]: T2_REM_BASELINE,
        [T2_ADD_DEPS]: T2_ADD_DEPS_SOURCE,
        [T2_REM_DEPS]: T2_REM_DEPS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(T2_ADD, T2_ADD_CURRENT);
        await workspace.file(T2_REM, T2_REM_CURRENT);
        await buildOk(
          product,
          workspace,
          "T5.6-2 `build` over the child-added/child-removed workspace",
        );

        const label =
          "T5.6-2 `impact --base <baseline> --json` after the child add and remove";
        assertImpactCategories(
          await impactAgainst(product, workspace, base, label),
          [
            // Add arm.
            {
              identity: T2_NEW,
              categories: [{ category: "changed", within: T2_ORIGINATORS }],
            },
            {
              identity: T2_P_ADD,
              categories: [
                { category: "changed", within: T2_ORIGINATORS },
                { category: "descendant-changed", exact: [T2_NEW] },
              ],
            },
            {
              identity: T2_WRAP,
              categories: [
                { category: "descendant-changed", exact: [T2_P_ADD, T2_NEW] },
              ],
            },
            {
              identity: T2_ADD,
              categories: [
                { category: "descendant-changed", exact: [T2_P_ADD, T2_NEW] },
              ],
            },
            { identity: T2_OLD, categories: [] },
            {
              identity: T2_HOLDADD_DEP,
              categories: [
                { category: "upstream-changed", exact: [T2_P_ADD, T2_NEW] },
              ],
            },
            {
              identity: T2_HOLDADD,
              categories: [
                { category: "upstream-changed", exact: [T2_P_ADD, T2_NEW] },
              ],
            },
            {
              identity: T2_ADD_DEPS,
              categories: [
                { category: "upstream-changed", exact: [T2_P_ADD, T2_NEW] },
              ],
            },
            // Remove arm: the removed child reports as deleted and `changed`.
            {
              identity: T2_GONE,
              deleted: true,
              categories: [{ category: "changed", within: T2_ORIGINATORS }],
            },
            {
              identity: T2_P_REM,
              categories: [
                { category: "changed", within: T2_ORIGINATORS },
                { category: "descendant-changed", exact: [T2_GONE] },
              ],
            },
            {
              identity: T2_WRAP2,
              categories: [
                { category: "descendant-changed", exact: [T2_P_REM, T2_GONE] },
              ],
            },
            {
              identity: T2_REM,
              categories: [
                { category: "descendant-changed", exact: [T2_P_REM, T2_GONE] },
              ],
            },
            { identity: T2_KEEP, categories: [] },
            {
              identity: T2_HOLDREM_DEP,
              categories: [
                { category: "upstream-changed", exact: [T2_P_REM, T2_GONE] },
              ],
            },
            {
              identity: T2_HOLDREM,
              categories: [
                { category: "upstream-changed", exact: [T2_P_REM, T2_GONE] },
              ],
            },
            {
              identity: T2_REM_DEPS,
              categories: [
                { category: "upstream-changed", exact: [T2_P_REM, T2_GONE] },
              ],
            },
          ],
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.6-3 — d-target edit
// ---------------------------------------------------------------------------

// Two arms in one workspace, each with its own originating node D so the
// `attributed to D` assertions discriminate per arm: `grow` gains a `d`
// target, `shrink` loses one. The targets themselves are in a third file and
// must stay uncategorized (edges point from D at them).
const T3_TARGETS = "specs/Targets.mdx";
const T3_T1 = "specs/Targets.mdx#t1";
const T3_T2 = "specs/Targets.mdx#t2";
const T3_TARGETS_SOURCE = [
  '<S id="t1">',
  "Target one text.",
  "</S>",
  "",
  '<S id="t2">',
  "Target two text.",
  "</S>",
  "",
].join("\n");

const T3_GROW_FILE = "specs/Grow.mdx";
const T3_OUTERGROW = "specs/Grow.mdx#outergrow";
const T3_GROW = "specs/Grow.mdx#outergrow.grow";
const growSource = (d: string): string =>
  [
    'import Targets from "./Targets.xspec"',
    "",
    '<S id="outergrow">',
    "Grow-side outer text.",
    "",
    `<S id="outergrow.grow" d={${d}}>`,
    "Node whose target set gains a member.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

const T3_SHRINK_FILE = "specs/Shrink.mdx";
const T3_OUTERSHRINK = "specs/Shrink.mdx#outershrink";
const T3_SHRINK = "specs/Shrink.mdx#outershrink.shrink";
const shrinkSource = (d: string): string =>
  [
    'import Targets from "./Targets.xspec"',
    "",
    '<S id="outershrink">',
    "Shrink-side outer text.",
    "",
    `<S id="outershrink.shrink" d={${d}}>`,
    "Node whose target set loses a member.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

// Per-arm dependents: a direct dependent of D, a transitive dependent of that
// dependent (the "transitively" clause), and their shared ancestors.
const T3_GROW_DEPS = "specs/GrowDeps.mdx";
const T3_GROWHOLD = "specs/GrowDeps.mdx#growhold";
const T3_GROWHOLD_DIRECT = "specs/GrowDeps.mdx#growhold.direct";
const T3_GROWHOLD_CHAIN = "specs/GrowDeps.mdx#growhold.chain";
const T3_GROW_DEPS_SOURCE = [
  'import Grow from "./Grow.xspec"',
  "",
  '<S id="growhold">',
  "Grow-dependent holder text.",
  "",
  '<S id="growhold.direct" d={Grow.outergrow.grow}>',
  "Direct dependent of the growing node.",
  "</S>",
  "",
  '<S id="growhold.chain" d={"growhold.direct"}>',
  "Transitive dependent through the direct dependent.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T3_SHRINK_DEPS = "specs/ShrinkDeps.mdx";
const T3_SHRINKHOLD = "specs/ShrinkDeps.mdx#shrinkhold";
const T3_SHRINKHOLD_DIRECT = "specs/ShrinkDeps.mdx#shrinkhold.direct";
const T3_SHRINKHOLD_CHAIN = "specs/ShrinkDeps.mdx#shrinkhold.chain";
const T3_SHRINK_DEPS_SOURCE = [
  'import Shrink from "./Shrink.xspec"',
  "",
  '<S id="shrinkhold">',
  "Shrink-dependent holder text.",
  "",
  '<S id="shrinkhold.direct" d={Shrink.outershrink.shrink}>',
  "Direct dependent of the shrinking node.",
  "</S>",
  "",
  '<S id="shrinkhold.chain" d={"shrinkhold.direct"}>',
  "Transitive dependent through the direct dependent.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T5_6_3 = defineProductTest({
  id: "T5.6-3",
  title:
    "d-target edit: adding a `d` target on one node and removing one on another makes each D `metadata-changed`; no node anywhere is `changed` or `descendant-changed`; and every node whose effectiveHash changed — D's ancestors, dependents, dependents' dependents, and their ancestors, transitively — is `upstream-changed` attributed to its arm's D (SPEC 5.6, 9.1)",
  run: async (product) => {
    await withWorkspace(
      {
        [T3_TARGETS]: T3_TARGETS_SOURCE,
        [T3_GROW_FILE]: growSource("Targets.t1"),
        [T3_SHRINK_FILE]: shrinkSource("[Targets.t1, Targets.t2]"),
        [T3_GROW_DEPS]: T3_GROW_DEPS_SOURCE,
        [T3_SHRINK_DEPS]: T3_SHRINK_DEPS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(
          T3_GROW_FILE,
          growSource("[Targets.t1, Targets.t2]"),
        );
        await workspace.file(T3_SHRINK_FILE, shrinkSource("Targets.t1"));
        await buildOk(
          product,
          workspace,
          "T5.6-3 `build` over the d-target-edited workspace",
        );

        const label =
          "T5.6-3 `impact --base <baseline> --json` after the d-target add and remove";
        const impact = await impactAgainst(product, workspace, base, label);

        // The test's global clause first: a d-target-only edit makes no node
        // `changed` or `descendant-changed` (SPEC 5.6).
        for (const entry of impact.requirements) {
          for (const category of entry.categories) {
            if (
              category.category === "changed" ||
              category.category === "descendant-changed"
            ) {
              fail(
                `${label}: an edit that only adds or removes \`d\` targets makes no ` +
                  `node \`changed\` or \`descendant-changed\` (SPEC 5.6 — d targets ` +
                  `enter metadataHash and effectiveHash, never ownHash or ` +
                  `subtreeHash); got ${JSON.stringify(entry)}`,
              );
            }
          }
        }

        const growCascade = {
          category: "upstream-changed",
          exact: [T3_GROW],
        } as const;
        const shrinkCascade = {
          category: "upstream-changed",
          exact: [T3_SHRINK],
        } as const;
        assertImpactCategories(
          impact,
          [
            // The two originating nodes: `metadata-changed`, and never
            // `upstream-changed` — a node's own dependency-edge edits are
            // excluded from that category ("other than the node itself").
            {
              identity: T3_GROW,
              categories: [
                { category: "metadata-changed", within: [T3_GROW, T3_SHRINK] },
              ],
            },
            {
              identity: T3_SHRINK,
              categories: [
                { category: "metadata-changed", within: [T3_GROW, T3_SHRINK] },
              ],
            },
            // The targets gain and lose incoming edges only: uncategorized.
            { identity: T3_T1, categories: [] },
            { identity: T3_T2, categories: [] },
            { identity: T3_TARGETS, categories: [] },
            // Grow arm cascade: ancestors, dependents, their dependents, and
            // the dependents' ancestors — all attributed to the grow node.
            { identity: T3_OUTERGROW, categories: [growCascade] },
            { identity: T3_GROW_FILE, categories: [growCascade] },
            { identity: T3_GROWHOLD_DIRECT, categories: [growCascade] },
            { identity: T3_GROWHOLD_CHAIN, categories: [growCascade] },
            { identity: T3_GROWHOLD, categories: [growCascade] },
            { identity: T3_GROW_DEPS, categories: [growCascade] },
            // Shrink arm cascade, attributed to the shrink node.
            { identity: T3_OUTERSHRINK, categories: [shrinkCascade] },
            { identity: T3_SHRINK_FILE, categories: [shrinkCascade] },
            { identity: T3_SHRINKHOLD_DIRECT, categories: [shrinkCascade] },
            { identity: T3_SHRINKHOLD_CHAIN, categories: [shrinkCascade] },
            { identity: T3_SHRINKHOLD, categories: [shrinkCascade] },
            { identity: T3_SHRINK_DEPS, categories: [shrinkCascade] },
          ],
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.6-4 — coverage/tags-only edit
// ---------------------------------------------------------------------------

// One workspace, two sequential baselines: arm 1 edits only the coverage
// attribute, arm 2 only the tags. The node's dependent and ancestors are
// staged controls: a metadata edit touching only coverage or tags changes no
// effectiveHash and propagates no category (SPEC 5.6).
const T4_META = "specs/Meta.mdx";
const T4_OUTER = "specs/Meta.mdx#outer";
const T4_M = "specs/Meta.mdx#outer.m";
const T4_DEP = "specs/Meta.mdx#outer.dep";

const metaSource = (coverage: string, tags: string): string =>
  [
    '<S id="outer">',
    "Outer holder text.",
    "",
    `<S id="outer.m" coverage="${coverage}" tags="${tags}">`,
    "Metadata-bearing node text.",
    "</S>",
    "",
    '<S id="outer.dep" d={"outer.m"}>',
    "Depends on the metadata-bearing node.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

const T5_6_4 = defineProductTest({
  id: "T5.6-4",
  title:
    "coverage/tags-only edit: changing only the node's coverage attribute, and only its tags, each make the node `metadata-changed` and give no other node — dependent and ancestors included — any category (SPEC 5.6, 9.1: such an edit changes no effectiveHash and propagates nothing)",
  run: async (product) => {
    await withWorkspace(
      { [T4_META]: metaSource("required", "alpha beta") },
      async (workspace) => {
        await workspace.gitInit();
        const coverageBase = await workspace.gitCommitAll("baseline");

        // Arm 1: coverage `required` → `none` (both defined values, SPEC 2.5).
        await workspace.file(T4_META, metaSource("none", "alpha beta"));
        // Commit arm 2's baseline before any build, so both baselines hold
        // sources only.
        const tagsBase = await workspace.gitCommitAll("coverage edited");
        await buildOk(
          product,
          workspace,
          "T5.6-4 `build` over the coverage-edited workspace",
        );
        const coverageLabel =
          "T5.6-4 `impact --base <baseline> --json` after the coverage-only edit";
        const expectations = (): ExpectedNodeImpact[] => [
          {
            identity: T4_M,
            categories: [{ category: "metadata-changed", within: [T4_M] }],
          },
          { identity: T4_DEP, categories: [] },
          { identity: T4_OUTER, categories: [] },
          { identity: T4_META, categories: [] },
        ];
        assertImpactCategories(
          await impactAgainst(product, workspace, coverageBase, coverageLabel),
          expectations(),
          coverageLabel,
        );

        // Arm 2: tags `alpha beta` → `alpha gamma` against the second
        // baseline, so the tags edit is the only difference.
        await workspace.file(T4_META, metaSource("none", "alpha gamma"));
        await buildOk(
          product,
          workspace,
          "T5.6-4 `build` over the tags-edited workspace",
        );
        const tagsLabel =
          "T5.6-4 `impact --base <coverage-edited> --json` after the tags-only edit";
        assertImpactCategories(
          await impactAgainst(product, workspace, tagsBase, tagsLabel),
          expectations(),
          tagsLabel,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.6-5 — multiple flags
// ---------------------------------------------------------------------------

// `x` is edited itself AND depends on the edited `t` in another file, so it
// carries both `changed` and `upstream-changed` (categories are independent
// flags, SPEC 5.6). `x`'s file root is the mirror multi-flag node:
// `descendant-changed` through `x`'s own edit and `upstream-changed` through
// the dependency of a node in its subtree.
const T5_UP = "specs/Up.mdx";
const T5_T = "specs/Up.mdx#t";
const T5_X_FILE = "specs/X.mdx";
const T5_X = "specs/X.mdx#x";

const upSource = (text: string): string =>
  ['<S id="t">', text, "</S>", ""].join("\n");
const xSource = (text: string): string =>
  [
    'import Up from "./Up.xspec"',
    "",
    '<S id="x" d={Up.t}>',
    text,
    "</S>",
    "",
  ].join("\n");

const T5_6_5 = defineProductTest({
  id: "T5.6-5",
  title:
    "multiple flags: a node with an own edit plus a dependency-target edit carries both `changed` and `upstream-changed` (categories are independent flags); its file root likewise carries `descendant-changed` and `upstream-changed` (SPEC 5.6, 9.1)",
  run: async (product) => {
    await withWorkspace(
      {
        [T5_UP]: upSource("Upstream target text v1."),
        [T5_X_FILE]: xSource("Own text of x v1."),
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(T5_UP, upSource("Upstream target text v2."));
        await workspace.file(T5_X_FILE, xSource("Own text of x v2."));
        await buildOk(
          product,
          workspace,
          "T5.6-5 `build` over the doubly-edited workspace",
        );

        const label =
          "T5.6-5 `impact --base <baseline> --json` after the own edit plus dependency-target edit";
        assertImpactCategories(
          await impactAgainst(product, workspace, base, label),
          [
            // The node under test: both categories simultaneously. Its
            // `upstream-changed` originates at the edited target `t`; its own
            // edit is no upstream cause (SPEC 5.6's category definition).
            {
              identity: T5_X,
              categories: [
                { category: "changed", within: [T5_X, T5_T] },
                { category: "upstream-changed", exact: [T5_T] },
              ],
            },
            {
              identity: T5_T,
              categories: [{ category: "changed", within: [T5_X, T5_T] }],
            },
            {
              identity: T5_UP,
              categories: [{ category: "descendant-changed", exact: [T5_T] }],
            },
            // The mirror multi-flag node: `x`'s subtree change and the
            // subtree-borne dependency on `t`, each attributed to its own
            // originating node.
            {
              identity: T5_X_FILE,
              categories: [
                { category: "descendant-changed", exact: [T5_X] },
                { category: "upstream-changed", exact: [T5_T] },
              ],
            },
          ],
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.6-6 — added/deleted convention
// ---------------------------------------------------------------------------

// `Present.mdx` persists across the baseline: `tgt` is edited (so the added
// and the deleted subtree root each carry a `d` target to a node also edited
// since the baseline), `emb` is the embedding target. `Doomed.mdx` exists
// only at the baseline, `Fresh.mdx` only in the current workspace; both
// subtree roots carry the full feature set — `d` targets, `coverage="none"`,
// tags, children, and an embedding — yet their nodes are `changed` only:
// baseline hash comparison is defined only for nodes present on both sides
// (SPEC 5.6).
const T6_PRESENT = "specs/Present.mdx";
const T6_TGT = "specs/Present.mdx#tgt";
const T6_EMB = "specs/Present.mdx#emb";
const presentSource = (text: string): string =>
  [
    '<S id="tgt">',
    text,
    "</S>",
    "",
    '<S id="emb">',
    "Embedding target text.",
    "</S>",
    "",
  ].join("\n");

const T6_DOOMED = "specs/Doomed.mdx";
const T6_GONE = "specs/Doomed.mdx#gone";
const T6_GONE_KID = "specs/Doomed.mdx#gone.kid";
const T6_GONE_KID2 = "specs/Doomed.mdx#gone.kid2";
const T6_DOOMED_SOURCE = [
  'import Present from "./Present.xspec"',
  "",
  '<S id="gone" d={[Present.tgt, Present.emb]} coverage="none" tags="legacy stale">',
  "Doomed subtree root embedding: {text(Present.emb)}",
  "",
  '<S id="gone.kid">',
  "Doomed child text.",
  "</S>",
  "",
  '<S id="gone.kid2">',
  "Second doomed child text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T6_FRESH = "specs/Fresh.mdx";
const T6_BORN = "specs/Fresh.mdx#born";
const T6_BORN_KID = "specs/Fresh.mdx#born.kid";
const T6_BORN_KID2 = "specs/Fresh.mdx#born.kid2";
const T6_FRESH_SOURCE = [
  'import Present from "./Present.xspec"',
  "",
  '<S id="born" d={[Present.tgt, Present.emb]} coverage="none" tags="fresh added">',
  "Added subtree root embedding: {text(Present.emb)}",
  "",
  '<S id="born.kid">',
  "Added child text.",
  "</S>",
  "",
  '<S id="born.kid2">',
  "Second added child text.",
  "</S>",
  "</S>",
  "",
].join("\n");

// Every node carrying `changed`: the edited target plus all added and all
// deleted nodes (added/deleted nodes are originating nodes — they carry
// `changed`, SPEC 5.6).
const T6_ORIGINATORS = [
  T6_TGT,
  T6_FRESH,
  T6_BORN,
  T6_BORN_KID,
  T6_BORN_KID2,
  T6_DOOMED,
  T6_GONE,
  T6_GONE_KID,
  T6_GONE_KID2,
];

const T5_6_6 = defineProductTest({
  id: "T5.6-6",
  title:
    'added/deleted convention: every node of an added file-and-subtree whose root carries `d` targets (one to a node also edited since the baseline), `coverage="none"`, tags, children, and an embedding is `changed` only — never `metadata-changed`, `descendant-changed`, or `upstream-changed`; every node of a deleted subtree with the same features reports as deleted and `changed` only (SPEC 5.6, 9.1, 9.3)',
  run: async (product) => {
    await withWorkspace(
      {
        [T6_PRESENT]: presentSource("Edited target text v1."),
        [T6_DOOMED]: T6_DOOMED_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await workspace.file(
          T6_PRESENT,
          presentSource("Edited target text v2."),
        );
        await fsp.rm(workspace.path(T6_DOOMED));
        await workspace.file(T6_FRESH, T6_FRESH_SOURCE);
        await buildOk(
          product,
          workspace,
          "T5.6-6 `build` over the workspace with the added subtree and without the deleted one",
        );

        const label =
          "T5.6-6 `impact --base <baseline> --json` after the subtree add, subtree delete, and target edit";
        const changedOnly = (
          identity: string,
          deleted: boolean,
        ): ExpectedNodeImpact => ({
          identity,
          deleted,
          categories: [{ category: "changed", within: T6_ORIGINATORS }],
        });
        assertImpactCategories(
          await impactAgainst(product, workspace, base, label),
          [
            // The persisting side: the edited target and its cascade.
            {
              identity: T6_TGT,
              categories: [{ category: "changed", within: T6_ORIGINATORS }],
            },
            {
              identity: T6_PRESENT,
              categories: [{ category: "descendant-changed", exact: [T6_TGT] }],
            },
            { identity: T6_EMB, categories: [] },
            // Every added node — the created file's root included — is
            // `changed` only, whatever metadata, children, or dependency
            // edges it carries.
            changedOnly(T6_FRESH, false),
            changedOnly(T6_BORN, false),
            changedOnly(T6_BORN_KID, false),
            changedOnly(T6_BORN_KID2, false),
            // Every deleted node reports as deleted, under its baseline
            // identity, and `changed` only.
            changedOnly(T6_DOOMED, true),
            changedOnly(T6_GONE, true),
            changedOnly(T6_GONE_KID, true),
            changedOnly(T6_GONE_KID2, true),
          ],
          label,
        );
      },
    );
  },
});

/** TEST-SPEC §5.6, in canonical ID order (SUITE-20). */
export const section56Tests: readonly ProductTestEntry[] = [
  T5_6_1,
  T5_6_2,
  T5_6_3,
  T5_6_4,
  T5_6_5,
  T5_6_6,
];
