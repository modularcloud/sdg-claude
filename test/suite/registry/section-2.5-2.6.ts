// TEST-SPEC §2.5 (coverage attribute) and §2.6 (tags) — SUITE-09:
// T2.5-1 … T2.5-3, T2.6-1 … T2.6-3.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4 — T2.6-3's emitted Markdown), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 2.5: every non-root node without the attribute is coverage-required;
// `coverage="none"` excludes the node as a coverage target (it can still be a
// `d` target, still appears in impact reports, and its descendants retain
// their own coverage behavior); the only defined values are `required`
// (default) and `none` — anything else is invalid (14.17, 2.7).
// SPEC 2.6: `tags` is a whitespace-separated list split on runs of 1.4
// whitespace with leading/trailing whitespace ignored; duplicates collapse; a
// value yielding no tags is equivalent to omitting the prop; tags are
// recorded in the graph, do not render into Markdown, are not inherited, and
// select in coverage target filters (7.4) and policy selectors (7.5).
//
// CONF-VALID in-scope: T2.6-1, T2.6-2 (CERTIFICATIONS.md §CONF-VALID). Their
// fixtures stay within that entry's scope — one configured spec group of
// `.mdx` sources whose sections carry `id`/`tags` props only; no imports,
// `d` props, coverage attributes, `code`/`markdown`/`coverage`/`policy`
// keys, or git; the command surface is `build`, `query node`, and
// `query nodes`, decoded through the minimal identity/tags/metadataHash
// adapters so nothing beyond the entry's scoped query surface is demanded of
// the fixture product. Certification staging constraints honored here
// (§VIOL-VALID-WIDE, §VIOL-VALID-CTRL): T2.6-1/T2.6-2 split only on the true
// whitespace characters of SPEC 1.4 — U+00A0/U+0085/U+2028 and non-whitespace
// control characters appear nowhere in their fixtures.

import type {
  CoverageProfileReport,
  Finding,
  NodeMetadataSummary,
  NodeReport,
  NodeRow,
  NodeSummary,
} from "../../helpers/adapters/index.js";
import {
  decodeCoverageReport,
  decodeEdgesReport,
  decodeFindingsReport,
  decodeImpactReport,
  decodeNodeMetadataSummary,
  decodeNodeReport,
  decodeNodeRowsReport,
  decodeNodeSummaryRowsReport,
} from "../../helpers/adapters/index.js";
import {
  assertFileBytes,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertEdgeSetEqual,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  byteWindow,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// SPEC 1.4's whitespace class, exactly — the separators 2.6 splits on.
// Constructed from hex escapes (visible, tool-safe, immune to editor and
// formatter normalization, per the SUITE-03 discipline); the workspace
// builder writes the resulting strings as their exact raw bytes (S-2).
const TAB = "\u0009";
const LF = "\u000A";
const VT = "\u000B";
const FF = "\u000C";
const CR = "\u000D";

// Minimal declarative configuration (SPEC 7): exactly one spec group — the
// CONF-VALID scope (T2.6-1, T2.6-2) and the negative 14.17 arms.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One coverage profile in default (`leaves`) targeting, boundary and target
// both the sole spec group ("main" is unambiguous, so boundaryKind MUST be
// inferred, SPEC 7.4). With no dependency edges staged, every required node
// is observable in the profile's uncovered set.
const PROFILE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "prof",
      target: "main",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

// As above with `targets: "all"`, so T2.5-2's non-leaf `coverage="none"` node
// is excluded from the required set for exactly one reason — the attribute —
// and its leaf child is required despite default targeting being irrelevant.
const ALL_TARGETS_PROFILE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "prof",
      target: "main",
      targets: "all",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

// Markdown emission next to each source (SPEC 7.3, 13.2) for T2.6-3's
// tags-do-not-render arm.
const EMIT_TRUE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

// Tag selection surfaces (T2.6-3): a coverage profile restricted by
// `targetTags` (SPEC 7.4) and a forbidden policy rule whose `from` and `to`
// are both `tags` selectors (SPEC 7.5).
const TAG_SELECT_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "byTag",
      target: "main",
      targetTags: ["core"],
      boundary: "main",
      mode: "direct"
    }
  ],
  policy: [
    {
      name: "no-ui-to-core",
      type: "forbidden",
      from: { tags: ["ui"] },
      to: { tags: ["core"] }
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

/** Reported tags in byte order — SPEC fixes the set, not the row order. */
function sortedTags(tags: readonly string[]): string[] {
  return [...tags].sort();
}

/**
 * `query node <identity>` decoded through the full H-3 node adapter, with
 * the resolved identity checked so a mis-addressed report cannot satisfy the
 * assertions. For tests outside every certification scope.
 */
async function queryNode(
  product: ProductBinding,
  workspace: TestWorkspace,
  identity: string,
  context: string,
): Promise<NodeReport> {
  const label = `${context} \`query node ${identity}\``;
  const node = decodeNodeReport(
    await runJson(product, workspace, ["query", "node", identity], label),
    label,
  );
  if (node.identity !== identity) {
    fail(
      `${label}: expected the report to be about ${JSON.stringify(identity)} (SPEC 1.5), ` +
        `got identity ${JSON.stringify(node.identity)}`,
    );
  }
  return node;
}

/**
 * `query node <identity>` decoded to the CONF-VALID-scoped surface —
 * identity, tags, metadataHash — for the certified tests T2.6-1/T2.6-2
 * (CERTIFICATIONS.md §CONF-VALID): nothing beyond that scoped surface is
 * demanded of a fixture product.
 */
async function queryNodeMetadata(
  product: ProductBinding,
  workspace: TestWorkspace,
  identity: string,
  context: string,
): Promise<NodeMetadataSummary> {
  const label = `${context} \`query node ${identity}\``;
  const summary = decodeNodeMetadataSummary(
    await runJson(product, workspace, ["query", "node", identity], label),
    label,
  );
  if (summary.identity !== identity) {
    fail(
      `${label}: expected the report to be about ${JSON.stringify(identity)} (SPEC 1.5), ` +
        `got identity ${JSON.stringify(summary.identity)}`,
    );
  }
  return summary;
}

/** `query nodes` with the given filter flags, decoded to full rows (H-3). */
async function queryNodeRows(
  product: ProductBinding,
  workspace: TestWorkspace,
  filters: readonly string[],
  context: string,
): Promise<NodeRow[]> {
  const label = `${context} \`query nodes ${filters.join(" ")}\``;
  return decodeNodeRowsReport(
    await runJson(product, workspace, ["query", "nodes", ...filters], label),
    label,
  );
}

/**
 * `query nodes` decoded to identity/tags summary rows — the CONF-VALID-scoped
 * variant of {@link queryNodeRows} for T2.6-1.
 */
async function queryNodeSummaryRows(
  product: ProductBinding,
  workspace: TestWorkspace,
  filters: readonly string[],
  context: string,
): Promise<NodeSummary[]> {
  const label = `${context} \`query nodes ${filters.join(" ")}\``;
  return decodeNodeSummaryRowsReport(
    await runJson(product, workspace, ["query", "nodes", ...filters], label),
    label,
  );
}

/**
 * `coverage --json` decoded (H-3), asserting the report holds exactly the
 * one configured profile (SPEC 8.2: `xspec coverage` runs all profiles).
 */
async function soleCoverageProfile(
  product: ProductBinding,
  workspace: TestWorkspace,
  expectedName: string,
  context: string,
): Promise<CoverageProfileReport> {
  const label = `${context} \`coverage --json\``;
  const report = decodeCoverageReport(
    await runJson(product, workspace, ["coverage", "--json"], label),
    label,
  );
  if (report.profiles.length !== 1) {
    fail(
      `${label}: exactly one coverage profile is configured, so the report must hold ` +
        `exactly one (SPEC 8.2); got ${String(report.profiles.length)}`,
    );
  }
  const profile = report.profiles[0]!;
  if (profile.name !== expectedName) {
    fail(
      `${label}: expected the profile ${JSON.stringify(expectedName)}, got ` +
        JSON.stringify(profile.name),
    );
  }
  return profile;
}

/** Assert a profile's four counts (SPEC 8.2), order-independently. */
function assertCoverageCounts(
  profile: CoverageProfileReport,
  expected: {
    required: number;
    covered: number;
    uncovered: number;
    ignored: number;
  },
  context: string,
): void {
  assertSameJson(
    [
      profile.counts.required,
      profile.counts.covered,
      profile.counts.uncovered,
      profile.counts.ignored,
    ],
    [expected.required, expected.covered, expected.uncovered, expected.ignored],
    `${context}: the [required, covered, uncovered, ignored] counts (SPEC 8.2)`,
  );
}

/**
 * `check --json` over a workspace staged to produce findings: exit 1 (H-5;
 * SPEC 12.0) with exactly one JSON document, decoded as the findings report.
 */
async function checkFindings(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<readonly Finding[]> {
  const result = await expectExit(
    product,
    workspace,
    ["check", "--json"],
    1,
    context,
  );
  return decodeFindingsReport(parseJsonStdout(result, context), context)
    .findings;
}

// ---------------------------------------------------------------------------
// T2.5-1
// ---------------------------------------------------------------------------

// Two non-root leaves, neither carrying the coverage attribute. With no
// dependency edges, both are required and uncovered; the file root is the
// profile's only ignored node (SPEC 8.1 always excludes roots; 8.2 reports
// the excluded nodes of the target group).
const T2_5_1_SOURCE = [
  '<S id="alpha">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="beta">',
  "Beta behavior.",
  "</S>",
  "",
].join("\n");

const T2_5_1_NODES = ["specs/A.mdx#alpha", "specs/A.mdx#beta"];

const T2_5_1 = defineProductTest({
  id: "T2.5-1",
  title:
    "a non-root node without the coverage attribute is coverage-required: it appears in a profile's required set and `query nodes --coverage required` lists it (SPEC 2.5, 8.1)",
  run: async (product) => {
    await withWorkspace(
      PROFILE_CONFIG,
      { "specs/A.mdx": T2_5_1_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.5-1 `build` over attribute-less nodes",
        );

        const profile = await soleCoverageProfile(
          product,
          workspace,
          "prof",
          "T2.5-1",
        );
        assertCoverageCounts(
          profile,
          { required: 2, covered: 0, uncovered: 2, ignored: 1 },
          "T2.5-1 both attribute-less leaves are required (SPEC 2.5, 8.1) and, with " +
            "no dependency edges, uncovered; only the root is ignored",
        );
        assertSameJson(
          [...profile.uncovered].sort(),
          T2_5_1_NODES,
          "T2.5-1 the required set is observable as the uncovered identities — both " +
            "attribute-less nodes appear (SPEC 2.5, 8.1, 8.2)",
        );
        assertSameJson(
          profile.covered,
          [],
          "T2.5-1 nothing is covered (no dependency edges are staged)",
        );
        assertSameJson(
          sortedIdentities(profile.ignored),
          ["specs/A.mdx"],
          "T2.5-1 the ignored set holds exactly the root — neither attribute-less node " +
            "is excluded from the required set (SPEC 8.1, 8.2)",
        );

        const rows = await queryNodeRows(
          product,
          workspace,
          ["--coverage", "required"],
          "T2.5-1",
        );
        assertSameJson(
          sortedIdentities(rows),
          T2_5_1_NODES,
          "T2.5-1 `query nodes --coverage required` lists exactly the two " +
            "attribute-less nodes (SPEC 2.5, 11 — the filter matches no root)",
        );
        for (const row of rows) {
          assertSameJson(
            row.coverage,
            "required",
            `T2.5-1 the reported coverage attribute of ${row.identity} — \`required\` ` +
              "is the default (SPEC 2.5, 11)",
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.5-2
// ---------------------------------------------------------------------------

// One workspace observing every stated consequence of `coverage="none"`
// (SPEC 2.5): `meta` carries the attribute and has a child (the child's own
// coverage behavior is unaffected); `user` declares `d={"meta"}` (the node
// can still be a `d` target); a committed git baseline lets an edit to
// `meta`'s own text surface in `impact --base` (the node still appears in
// impact reports when changed).
const T2_5_2_BASELINE = [
  '<S id="meta" coverage="none">',
  "Meta text.",
  "",
  '<S id="meta.child">',
  "Child text.",
  "</S>",
  "</S>",
  "",
  '<S id="user" d={"meta"}>',
  "User text.",
  "</S>",
  "",
].join("\n");

// The same workspace with exactly one edit: `meta`'s own text (its ownHash
// changes, so `meta` is `changed` relative to the baseline, SPEC 5.5/5.6).
const T2_5_2_EDITED = T2_5_2_BASELINE.replace(
  "Meta text.",
  "Meta text, edited.",
);

const T2_5_2_META = "specs/A.mdx#meta";
const T2_5_2_CHILD = "specs/A.mdx#meta.child";
const T2_5_2_USER = "specs/A.mdx#user";

const T2_5_2 = defineProductTest({
  id: "T2.5-2",
  title:
    '`coverage="none"`: the node is excluded from coverage targets (ignored with its reason), can still be a `d` target, still appears in impact reports when changed, and its children remain coverage-required — one workspace (SPEC 2.5, 8.1, 8.2, 9)',
  run: async (product) => {
    await withWorkspace(
      ALL_TARGETS_PROFILE_CONFIG,
      { "specs/A.mdx": T2_5_2_BASELINE },
      async (workspace) => {
        await workspace.gitInit();
        const baseCommit = await workspace.gitCommitAll("baseline");

        // `d={"meta"}` resolves: the build succeeds and records the edge —
        // `coverage="none"` does not stop the node being a `d` target.
        await buildOk(
          product,
          workspace,
          "T2.5-2 `build` with a `d` reference targeting the coverage-none node",
        );
        const edgesLabel = "T2.5-2 `query edges --kinds depends`";
        assertEdgeSetEqual(
          decodeEdgesReport(
            await runJson(
              product,
              workspace,
              ["query", "edges", "--kinds", "depends"],
              edgesLabel,
            ),
            edgesLabel,
          ),
          [{ from: T2_5_2_USER, to: T2_5_2_META, kind: "depends" }],
          "T2.5-2 the complete `depends` edge set — the coverage-none node is an " +
            "ordinary `d` target (SPEC 2.5, 2.2)",
        );

        // Coverage under `targets: "all"`: the attribute is the one exclusion
        // in play, so `meta` is ignored for exactly that reason while its
        // child (and `user`) remain required.
        const profile = await soleCoverageProfile(
          product,
          workspace,
          "prof",
          "T2.5-2",
        );
        assertCoverageCounts(
          profile,
          { required: 2, covered: 0, uncovered: 2, ignored: 2 },
          "T2.5-2 the child and `user` are required; `meta` and the root are ignored " +
            "(SPEC 2.5, 8.1)",
        );
        assertSameJson(
          [...profile.uncovered].sort(),
          [T2_5_2_CHILD, T2_5_2_USER],
          "T2.5-2 the required set — the coverage-none node's child remains " +
            "coverage-required; nothing covers it (SPEC 2.5, 8.1, 8.2)",
        );
        assertSameJson(
          sortedIdentities(profile.ignored),
          ["specs/A.mdx", T2_5_2_META],
          "T2.5-2 exactly the root and the coverage-none node are excluded from the " +
            "required set (SPEC 8.1, 8.2)",
        );
        const metaIgnored = profile.ignored.find(
          (node) => node.identity === T2_5_2_META,
        );
        if (metaIgnored === undefined) {
          fail(
            "T2.5-2 the coverage-none node must be reported ignored (SPEC 8.2); it is " +
              "not in the ignored set",
          );
        }
        if (
          metaIgnored.reasons.length !== 1 ||
          !/none/i.test(metaIgnored.reasons[0]!)
        ) {
          fail(
            "T2.5-2 the ignored entry for the coverage-none node must carry exactly " +
              'its one applicable exclusion reason, identifying `coverage="none"` ' +
              `(SPEC 8.2; targets: "all" makes leaf-ness irrelevant); got ` +
              JSON.stringify(metaIgnored.reasons),
          );
        }

        // The `--coverage` filter view of the same facts (SPEC 2.5, 11).
        assertSameJson(
          sortedIdentities(
            await queryNodeRows(
              product,
              workspace,
              ["--coverage", "required"],
              "T2.5-2",
            ),
          ),
          [T2_5_2_CHILD, T2_5_2_USER],
          "T2.5-2 `query nodes --coverage required` — the coverage-none node's child " +
            "remains coverage-required, the node itself is absent (SPEC 2.5)",
        );
        assertSameJson(
          sortedIdentities(
            await queryNodeRows(
              product,
              workspace,
              ["--coverage", "none"],
              "T2.5-2",
            ),
          ),
          [T2_5_2_META],
          "T2.5-2 `query nodes --coverage none` lists exactly the coverage-none node " +
            "(SPEC 2.5, 11)",
        );

        // Edit only `meta`'s own text: the node still appears in impact
        // reports (SPEC 2.5) — as `changed` against the committed baseline.
        await workspace.file("specs/A.mdx", T2_5_2_EDITED);
        const impactLabel = "T2.5-2 `impact --base <baseline> --json`";
        const impact = decodeImpactReport(
          await runJson(
            product,
            workspace,
            ["impact", "--base", baseCommit, "--json"],
            impactLabel,
          ),
          impactLabel,
        );
        const metaEntries = impact.requirements.filter((entry) =>
          entry.nodes.includes(T2_5_2_META),
        );
        if (metaEntries.length !== 1) {
          fail(
            "T2.5-2 the edited coverage-none node must appear in the impact report " +
              `in exactly one requirement entry (SPEC 2.5, 9.1); found ` +
              `${String(metaEntries.length)} entries containing ${T2_5_2_META}`,
          );
        }
        const metaEntry = metaEntries[0]!;
        if (metaEntry.deleted) {
          fail(
            "T2.5-2 the edited node exists on both sides of the comparison; its " +
              "entry must not be flagged deleted (SPEC 9.3)",
          );
        }
        assertSameJson(
          metaEntry.categories.map((entry) => entry.category).sort(),
          ["changed"],
          "T2.5-2 the coverage-none node's own-text edit makes it exactly `changed` " +
            "(SPEC 5.6) — coverage exclusion does not suppress impact reporting (SPEC 2.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.5-3
// ---------------------------------------------------------------------------

// Two variants of one file, differing only in `coverage="required"` versus no
// attribute, built in the same directory: SPEC 2.5 makes `required` the
// default, so the explicit spelling must be accepted and indistinguishable —
// same required-set membership, same reported attribute, same metadataHash
// (the coverage attribute is a metadataHash input, SPEC 5.5).
const T2_5_3_EXPLICIT =
  '<S id="node" coverage="required">\nNode behavior.\n</S>\n';
const T2_5_3_OMITTED = '<S id="node">\nNode behavior.\n</S>\n';
const T2_5_3_NODE = "specs/A.mdx#node";

// Shared negative-arm template (the SUITE-02/03 discipline): a valid sibling
// first, so the offending construct is a proper sub-range of the file and the
// location assertion has teeth.
const SIBLING = '<S id="ok">\nA valid sibling section.\n</S>\n\n';

// Representatives of "any other value" (SPEC 2.5, 2.7 → 14.17): an unknown
// token, a case variant (values compare byte-wise, no case folding — SPEC
// 12.0), and the empty string.
const INVALID_COVERAGE_VALUES: readonly string[] = ["optional", "None", ""];

function coverageConstruct(value: string): string {
  return `<S id="sec" coverage="${value}">\nSection with the coverage value under test.\n</S>`;
}

async function expectVariantRequired(
  product: ProductBinding,
  workspace: TestWorkspace,
  variant: string,
): Promise<NodeReport> {
  const context = `T2.5-3 (${variant})`;
  const node = await queryNode(product, workspace, T2_5_3_NODE, context);
  assertSameJson(
    node.coverage,
    "required",
    `${context}: the reported coverage attribute (SPEC 2.5: \`required\` is the ` +
      "default; SPEC 11)",
  );
  const profile = await soleCoverageProfile(
    product,
    workspace,
    "prof",
    context,
  );
  assertCoverageCounts(
    profile,
    { required: 1, covered: 0, uncovered: 1, ignored: 1 },
    `${context}: the node is coverage-required (SPEC 2.5, 8.1); only the root is ignored`,
  );
  assertSameJson(
    profile.uncovered,
    [T2_5_3_NODE],
    `${context}: the node appears in the profile's required set (SPEC 8.1, 8.2)`,
  );
  assertSameJson(
    sortedIdentities(
      await queryNodeRows(
        product,
        workspace,
        ["--coverage", "required"],
        context,
      ),
    ),
    [T2_5_3_NODE],
    `${context}: \`query nodes --coverage required\` lists the node (SPEC 2.5, 11)`,
  );
  return node;
}

const T2_5_3 = defineProductTest({
  id: "T2.5-3",
  title:
    '`coverage="required"` is accepted and behaves as the default (same required-set membership, reported attribute, and metadataHash as the omitted variant); any other value fails with 14.17 (SPEC 2.5, 2.7)',
  run: async (product) => {
    await withWorkspace(
      PROFILE_CONFIG,
      { "specs/A.mdx": T2_5_3_EXPLICIT },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          'T2.5-3 `build` with the explicit `coverage="required"`',
        );
        const explicit = await expectVariantRequired(
          product,
          workspace,
          'coverage="required"',
        );

        await workspace.file("specs/A.mdx", T2_5_3_OMITTED);
        await buildOk(
          product,
          workspace,
          "T2.5-3 `build` with the attribute omitted",
        );
        const omitted = await expectVariantRequired(
          product,
          workspace,
          "attribute omitted",
        );

        assertSameJson(
          explicit.hashes.metadataHash,
          omitted.hashes.metadataHash,
          `T2.5-3 metadataHash of ${T2_5_3_NODE} — \`coverage="required"\` is the ` +
            "default spelled out, so both variants hash the same coverage attribute " +
            "(with the same `d` target set and tags, SPEC 2.5, 5.5)",
        );
      },
    );

    for (const value of INVALID_COVERAGE_VALUES) {
      const construct = coverageConstruct(value);
      const context = `T2.5-3 \`build --json\` with coverage=${JSON.stringify(value)}`;
      await withWorkspace(
        SPECS_ONLY_CONFIG,
        { "specs/A.mdx": `${SIBLING}${construct}\n` },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { "14.17": 1 }, context);
          assertFindingLocated(
            findings[0]!,
            { file: "specs/A.mdx", window: byteWindow(SIBLING, construct) },
            `${context}: the 14.17 finding (SPEC 2.5: the only defined values are ` +
              "`required` and `none`)",
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T2.6-1
// ---------------------------------------------------------------------------

// Four spellings that must all yield exactly the tag set {a, b} (SPEC 2.6):
// a single space; a run mixing tab, vertical tab, form feed, and space; a
// run containing the line terminators CR LF plus a tab (line endings inside
// a quoted attribute value are well-formed MDX in flow context, and both CR
// and LF are 1.4 whitespace, so the split result is terminator-normalization
// independent); and leading/trailing whitespace around a single-space
// separator. Every separator character is drawn from SPEC 1.4's exact
// whitespace class — never U+00A0/U+0085/U+2028 (CERTIFICATIONS.md
// §VIOL-VALID-WIDE: T2.6-1 splits only on true 1.4 whitespace).
const T2_6_1_ARM_IDS = [
  "plain",
  "mixed",
  "terminators",
  "padded",
] as readonly string[];

const T2_6_1_SOURCE = [
  '<S id="plain" tags="a b">',
  "Single-space separator.",
  "</S>",
  "",
  `<S id="mixed" tags="a${TAB}${VT}${FF} b">`,
  "Run of mixed whitespace as the separator.",
  "</S>",
  "",
  `<S id="terminators" tags="a${CR}${LF}${TAB}b">`,
  "Separator run containing line terminators.",
  "</S>",
  "",
  `<S id="padded" tags="  a b${TAB} ">`,
  "Leading and trailing whitespace ignored.",
  "</S>",
  "",
  '<S id="other" tags="c">',
  "Different tag - the filter discriminator.",
  "</S>",
  "",
  '<S id="untagged">',
  "No tags prop.",
  "</S>",
  "",
].join("\n");

const T2_6_1 = defineProductTest({
  id: "T2.6-1",
  title:
    '`tags="a b"`, runs of mixed 1.4 whitespace as separators, and leading/trailing whitespace all yield tags {a, b} — asserted via `query node` and `query nodes --tag` (SPEC 2.6, 1.4)',
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/A.mdx": T2_6_1_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.6-1 `build` over the tag-splitting spellings",
        );

        // Every arm reports exactly the set {a, b} (as sorted tags), and —
        // since the metadataHash input is the split, sorted tag set together
        // with the (empty) `d` set and default coverage (SPEC 5.5) — all
        // arms' metadataHashes are identical: the spellings are equivalent.
        const hashes = new Set<string>();
        for (const id of T2_6_1_ARM_IDS) {
          const identity = `specs/A.mdx#${id}`;
          const summary = await queryNodeMetadata(
            product,
            workspace,
            identity,
            "T2.6-1",
          );
          assertSameJson(
            sortedTags(summary.tags),
            ["a", "b"],
            `T2.6-1 tags of ${identity} — the spelling splits to exactly {a, b} (SPEC 2.6)`,
          );
          hashes.add(summary.metadataHash);
        }
        if (hashes.size !== 1) {
          fail(
            "T2.6-1 all four spellings carry identical metadata (empty `d` set, " +
              "default coverage, tag set {a, b}), so their metadataHashes must be " +
              `identical (SPEC 2.6, 5.5); got ${String(hashes.size)} distinct values: ` +
              JSON.stringify([...hashes]),
          );
        }

        // The `--tag` filter view (SPEC 2.6, 11): each of `a` and `b`
        // selects exactly the four arms — never `other` or `untagged` — and
        // `c` selects exactly `other`.
        const armIdentities = T2_6_1_ARM_IDS.map(
          (id) => `specs/A.mdx#${id}`,
        ).sort();
        for (const tag of ["a", "b"]) {
          const rows = await queryNodeSummaryRows(
            product,
            workspace,
            ["--tag", tag],
            "T2.6-1",
          );
          assertSameJson(
            sortedIdentities(rows),
            armIdentities,
            `T2.6-1 \`query nodes --tag ${tag}\` lists exactly the four spellings' ` +
              "nodes (SPEC 2.6, 11)",
          );
          for (const row of rows) {
            assertSameJson(
              sortedTags(row.tags),
              ["a", "b"],
              `T2.6-1 tags reported for ${row.identity} by \`query nodes --tag ${tag}\``,
            );
          }
        }
        assertSameJson(
          sortedIdentities(
            await queryNodeSummaryRows(
              product,
              workspace,
              ["--tag", "c"],
              "T2.6-1",
            ),
          ),
          ["specs/A.mdx#other"],
          "T2.6-1 `query nodes --tag c` lists exactly the differently-tagged node " +
            "(SPEC 2.6, 11)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.6-2
// ---------------------------------------------------------------------------

// Static file: a duplicate-spelling node and a plain-spelling control with
// the identical resulting tag set.
const T2_6_2_STATIC = [
  '<S id="dup" tags="a b a a">',
  "Duplicate spellings collapse.",
  "</S>",
  "",
  '<S id="plain" tags="a b">',
  "Plain spelling.",
  "</S>",
  "",
].join("\n");

// Variant file, rebuilt in place (same directory, same identity): the tags
// prop omitted, empty, and whitespace-only — the latter two must behave as
// omitted (SPEC 2.6), observable as an equal metadataHash (SPEC 5.5). The
// whitespace-only value uses only true 1.4 whitespace (§VIOL-VALID-WIDE).
const T2_6_2_OMITTED = '<S id="node">\nVariant node.\n</S>\n';
const T2_6_2_EMPTY = '<S id="node" tags="">\nVariant node.\n</S>\n';
const T2_6_2_WS_ONLY = `<S id="node" tags=" ${TAB} ">\nVariant node.\n</S>\n`;
const T2_6_2_NODE = "specs/B.mdx#node";

const T2_6_2 = defineProductTest({
  id: "T2.6-2",
  title:
    'duplicate tags collapse; `tags=""` and whitespace-only values behave as omitting the prop — the metadataHash equals the omitted variant\'s (SPEC 2.6, 5.5)',
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/A.mdx": T2_6_2_STATIC, "specs/B.mdx": T2_6_2_OMITTED },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.6-2 `build` with duplicate tags and the omitted-variant node",
        );

        // Duplicates collapse: the reported tags are the two-element set, and
        // the metadataHash equals the plain spelling's (the hash input is the
        // collapsed, sorted tag set, SPEC 2.6, 5.5).
        const dup = await queryNodeMetadata(
          product,
          workspace,
          "specs/A.mdx#dup",
          "T2.6-2",
        );
        assertSameJson(
          sortedTags(dup.tags),
          ["a", "b"],
          'T2.6-2 tags of the `tags="a b a a"` node — duplicates collapse to the set ' +
            "{a, b} (SPEC 2.6)",
        );
        const plain = await queryNodeMetadata(
          product,
          workspace,
          "specs/A.mdx#plain",
          "T2.6-2",
        );
        assertSameJson(
          dup.metadataHash,
          plain.metadataHash,
          'T2.6-2 metadataHash of `tags="a b a a"` equals `tags="a b"` — the collapsed ' +
            "tag set is the hash input (SPEC 2.6, 5.5)",
        );

        // Empty and whitespace-only values behave as omitted.
        const omitted = await queryNodeMetadata(
          product,
          workspace,
          T2_6_2_NODE,
          "T2.6-2 (tags prop omitted):",
        );
        assertSameJson(
          omitted.tags,
          [],
          "T2.6-2 the omitted-prop variant carries no tags (SPEC 2.6)",
        );

        const variants: readonly { label: string; source: string }[] = [
          { label: 'tags=""', source: T2_6_2_EMPTY },
          { label: "whitespace-only tags value", source: T2_6_2_WS_ONLY },
        ];
        for (const variant of variants) {
          await workspace.file("specs/B.mdx", variant.source);
          await buildOk(
            product,
            workspace,
            `T2.6-2 \`build\` with ${variant.label}`,
          );
          const summary = await queryNodeMetadata(
            product,
            workspace,
            T2_6_2_NODE,
            `T2.6-2 (${variant.label}):`,
          );
          assertSameJson(
            summary.tags,
            [],
            `T2.6-2 ${variant.label} yields no tags (SPEC 2.6)`,
          );
          assertSameJson(
            summary.metadataHash,
            omitted.metadataHash,
            `T2.6-2 metadataHash with ${variant.label} — a value yielding no tags is ` +
              "equivalent to omitting the prop (SPEC 2.6, 5.5)",
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.6-3
// ---------------------------------------------------------------------------

// Rendering and inheritance workspace. The in-line section is the sharp
// rendering probe: its line is kept (non-whitespace remains after tag
// removal), so any surviving byte of a `tags` prop lands in the kept line
// and fails the byte comparison; the parent's tag-bearing line drops
// entirely (SPEC 3).
const T2_6_3_MD_SOURCE = [
  '<S id="parent" tags="ptag render-probe">',
  "Parent text.",
  "",
  '<S id="parent.child">',
  "Child text.",
  "</S>",
  "</S>",
  "",
  '<S id="inline" tags="itag">Inline kept text.</S>',
  "",
].join("\n");

// Hand-derived per SPEC 3: tag-only lines are emptied purely by removals and
// drop with their terminators; the prose lines, the blank separator lines,
// and the in-line section's remaining content are kept byte-for-byte.
const T2_6_3_MD_COMPILED = "Parent text.\n\nChild text.\n\nInline kept text.\n";

// Tag-selection workspace (SPEC 7.4, 7.5): `tagged` carries the profile's
// target tag; `src` carries the policy's `from` tag and depends on `tagged`;
// `untagged` and `srcPlain` carry no tags — their edge is the negative
// control for the policy rule, and `untagged` for `targetTags`.
const T2_6_3_SELECT_SOURCE = [
  '<S id="tagged" tags="core">',
  "Core-tagged leaf.",
  "</S>",
  "",
  '<S id="untagged">',
  "Untagged leaf.",
  "</S>",
  "",
  '<S id="src" tags="ui" d={"tagged"}>',
  "The ui-tagged source depends on the core-tagged leaf.",
  "</S>",
  "",
  '<S id="srcPlain" d={"untagged"}>',
  "The untagged source depends on the untagged leaf.",
  "</S>",
  "",
].join("\n");

const T2_6_3_TAGGED = "specs/A.mdx#tagged";
const T2_6_3_UNTAGGED = "specs/A.mdx#untagged";
const T2_6_3_SRC = "specs/A.mdx#src";
const T2_6_3_SRC_PLAIN = "specs/A.mdx#srcPlain";

const T2_6_3 = defineProductTest({
  id: "T2.6-3",
  title:
    "tags do not render into Markdown, are not inherited by children, and select in coverage `targetTags` and policy `tags` selectors (SPEC 2.6, 3, 7.4, 7.5)",
  run: async (product) => {
    // Arm 1+2: rendering and inheritance.
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/A.mdx": T2_6_3_MD_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.6-3 `build` with emission over tagged sections",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_6_3_MD_COMPILED,
          "T2.6-3 emitted Markdown (SPEC 3) — byte equality of the whole output, so " +
            "no trace of any `tags` prop can survive (SPEC 2.6)",
        );
        const parent = await queryNode(
          product,
          workspace,
          "specs/A.mdx#parent",
          "T2.6-3",
        );
        assertSameJson(
          sortedTags(parent.tags),
          ["ptag", "render-probe"],
          "T2.6-3 the parent carries its own tags (the inheritance control)",
        );
        const child = await queryNode(
          product,
          workspace,
          "specs/A.mdx#parent.child",
          "T2.6-3",
        );
        assertSameJson(
          child.tags,
          [],
          "T2.6-3 the child does not inherit its parent's tags (SPEC 2.6)",
        );
        assertSameJson(
          sortedIdentities(
            await queryNodeRows(
              product,
              workspace,
              ["--tag", "ptag"],
              "T2.6-3",
            ),
          ),
          ["specs/A.mdx#parent"],
          "T2.6-3 `query nodes --tag ptag` lists exactly the parent — never the " +
            "child (SPEC 2.6, 11)",
        );
      },
    );

    // Arm 3+4: coverage `targetTags` and policy `tags` selectors.
    await withWorkspace(
      TAG_SELECT_CONFIG,
      { "specs/A.mdx": T2_6_3_SELECT_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.6-3 `build` of the tag-selection workspace",
        );

        // Both staged edges exist — so the policy finding's silence about
        // the untagged edge below is selection, not absence.
        const edgesLabel = "T2.6-3 `query edges --kinds depends`";
        assertEdgeSetEqual(
          decodeEdgesReport(
            await runJson(
              product,
              workspace,
              ["query", "edges", "--kinds", "depends"],
              edgesLabel,
            ),
            edgesLabel,
          ),
          [
            { from: T2_6_3_SRC, to: T2_6_3_TAGGED, kind: "depends" },
            { from: T2_6_3_SRC_PLAIN, to: T2_6_3_UNTAGGED, kind: "depends" },
          ],
          "T2.6-3 the complete `depends` edge set (SPEC 2.2, 5.2)",
        );

        // Coverage `targetTags`: the target set is restricted to nodes
        // carrying at least one listed tag (SPEC 7.4) — of the four leaves
        // only `tagged` is required, covered by `src`'s edge in direct mode.
        const profile = await soleCoverageProfile(
          product,
          workspace,
          "byTag",
          "T2.6-3",
        );
        assertCoverageCounts(
          profile,
          { required: 1, covered: 1, uncovered: 0, ignored: 4 },
          'T2.6-3 `targetTags: ["core"]` restricts the required set to the one ' +
            "core-tagged leaf (SPEC 2.6, 7.4, 8.1)",
        );
        assertSameJson(
          sortedIdentities(profile.covered),
          [T2_6_3_TAGGED],
          "T2.6-3 the core-tagged leaf is the profile's sole required (and covered) " +
            "node (SPEC 7.4, 8.1)",
        );
        assertSameJson(
          profile.covered[0]!.path,
          [T2_6_3_SRC, T2_6_3_TAGGED],
          "T2.6-3 the covering path — the single direct edge from the boundary node " +
            "(SPEC 8, 8.2)",
        );
        assertSameJson(
          sortedIdentities(profile.ignored),
          ["specs/A.mdx", T2_6_3_SRC, T2_6_3_SRC_PLAIN, T2_6_3_UNTAGGED],
          "T2.6-3 every target-group node lacking the tag (plus the root) is ignored " +
            "(SPEC 7.4, 8.1, 8.2)",
        );
        const untaggedIgnored = profile.ignored.find(
          (node) => node.identity === T2_6_3_UNTAGGED,
        );
        if (untaggedIgnored === undefined) {
          fail(
            "T2.6-3 the untagged leaf must be reported ignored (SPEC 8.2); it is not " +
              "in the ignored set",
          );
        }
        if (
          untaggedIgnored.reasons.length !== 1 ||
          !/tag/i.test(untaggedIgnored.reasons[0]!)
        ) {
          fail(
            "T2.6-3 the untagged leaf's ignored entry must carry exactly its one " +
              "applicable exclusion reason, identifying the missing `targetTags` tag " +
              `(SPEC 8.2); got ${JSON.stringify(untaggedIgnored.reasons)}`,
          );
        }

        // Policy `tags` selectors: the rule forbids edges from a ui-tagged
        // source to a core-tagged target — exactly `src -> tagged` violates;
        // the untagged edge matches neither selector (SPEC 7.5).
        const findings = await checkFindings(
          product,
          workspace,
          "T2.6-3 `check --json` over the forbidden tags-selector rule",
        );
        assertConditionCounts(
          findings,
          { "14.12": 1 },
          "T2.6-3 exactly one policy violation (SPEC 7.5): the tags selectors match " +
            "the tagged edge alone",
        );
        const violation = findings[0]!;
        assertSameJson(
          violation.rule,
          "no-ui-to-core",
          "T2.6-3 the violation names its rule (SPEC 7.5)",
        );
        assertSameJson(
          violation.edge,
          { from: T2_6_3_SRC, to: T2_6_3_TAGGED, kind: "depends" },
          "T2.6-3 the violation reports the offending edge — selected by the nodes' " +
            "tags (SPEC 2.6, 7.5)",
        );
      },
    );
  },
});

/** TEST-SPEC §2.5–2.6, in canonical ID order (SUITE-09). */
export const section25to26Tests: readonly ProductTestEntry[] = [
  T2_5_1,
  T2_5_2,
  T2_5_3,
  T2_6_1,
  T2_6_2,
  T2_6_3,
];
