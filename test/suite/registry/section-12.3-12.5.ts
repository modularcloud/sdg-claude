// TEST-SPEC §12.3 (`xspec ids`), §12.4 (`xspec show`), §12.5 (dispatch) —
// SUITE-44: T12.3-1, T12.3-2, T12.4-1, T12.5-1.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 12.3: `ids` lists requirement IDs grouped by file — files in byte
// order of workspace-relative path, IDs within a file in document order —
// with `--json` per 12.0. `--tree` renders each file's IDs as a tree
// following section nesting, in the same file and document order. `--file
// <glob>` restricts to files the glob matches (the rules of 7; a pattern
// resolving outside the workspace root is an invalid flag value, exit 2).
// `--unreferenced` restricts to requirement nodes with no incoming dependency
// edges from specs or code (`contains` does not count); unreferenced is not
// uncovered. When the listing is restricted and a listed node's parent is not
// listed, `--tree` nests the node under its nearest listed ancestor, or at
// its file's top level when no ancestor is listed: the tree contains exactly
// the listed IDs. SPEC 12.4: `show <node>` accepts `path#id` and bare `path`
// (root) and prints identity, source range (1.7), own and subtree text,
// hashes, tags, coverage attribute (absent for a root node, 11), and edges by
// kind; `query node` is the machine-facing equivalent. SPEC 12.5: `coverage`,
// `impact`, `review`, `query`, `rename`, `move` behave as sections 8, 9, 10,
// 11, and 6 specify; an unknown subcommand or command is a usage error
// (exit 2, 12.0).
//
// Conservative operationalizations (noted per H-3/H-4):
// - Tree node IDs are the full requirement IDs (`zeta.minor`), not bare
//   segments: SPEC 12.3 fixes "the tree contains exactly the listed IDs",
//   and a restricted tree nests a listed node under a non-parent ancestor or
//   at the file's top level — where a segment-only rendering could not carry
//   the listed ID at all. (Reconstructing full IDs from a differently shaped
//   but information-complete rendering would be an H-3 shape adjustment in
//   the adapter, never a value change.)
// - Whether a file with no listed IDs appears as an (empty) entry in a
//   restricted listing is not fixed by SPEC 12.3, so every listing
//   comparison first drops entries carrying no IDs/nodes; the surviving
//   entries — the listing's content — are asserted exactly, order included.
// - `--json` parity (SPEC 12.0: the JSON form carries the same information
//   as the report): the JSON document is decoded and asserted in full —
//   grouping, membership, and both spec-fixed orders — while the human form
//   is asserted to exit 0 and mention the same distinctive information
//   (file paths; full IDs in the flat listing; for tree renderings, segment
//   mentions that both a full-ID and an indented-segment rendering contain).
//   H-3 forbids wording/line-format assertions, so mention order is not
//   asserted — the ordered content lives in the JSON assertions.
// - T12.4-1's primary assertion is the adapter comparison: `show --json` and
//   `query node --json` for the same node are both decoded by the one node
//   adapter and compared field by field (orders SPEC fixes nothing about —
//   tag order, edge-list order — normalized first). Symmetric omission is
//   caught by pinning the discriminating fields on the `show` side directly:
//   tags, `coverage="none"`, and the root arm's absent coverage attribute.
//   The human form is asserted for distinctive information presence,
//   including the four hash values as reported by `query node` (12.4 prints
//   hashes; an abbreviation is not the same information) — source-range
//   presence is carried by the adapter compare, since bare digits are not
//   distinctive mentions.
// - T12.5-1's dispatch arms are minimal exit-0 probes — each named command
//   dispatches into its section's specified outcome on a small valid fixture
//   (deep behavior is covered in sections 8, 9, 10, 11, 6, per TEST-SPEC) —
//   so the unknown-command arms discriminate "unknown → exit 2" from a CLI
//   that exits 2 for everything. Unknown arms assert exit 2 exactly and,
//   under `--json`, byte-empty stdout (SPEC 12.0).
// - T12.3-2's coverage arm asserts the demonstration facts (the profile's
//   uncovered set, the referenced-yet-uncovered node among it) — full §8
//   report content is T8-*'s subject.

import type {
  IdsReport,
  IdsTreeNode,
  IdsTreeReport,
  NodeReport,
} from "../../helpers/adapters/index.js";
import {
  assertReportMentions,
  decodeCoverageReport,
  decodeIdsReport,
  decodeIdsTreeReport,
  decodeImpactReport,
  decodeNodeReport,
  decodeNodeRowsReport,
  decodeSessionListReport,
} from "../../helpers/adapters/index.js";
import type { Mention } from "../../helpers/adapters/index.js";
import type { GraphEdge } from "../../helpers/adapters/index.js";
import { assertStdoutEmpty, fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// ---------------------------------------------------------------------------
// Shared fixture material and helpers
// ---------------------------------------------------------------------------

// Minimal declarative configuration (SPEC 7): exactly one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus one code group (SPEC 7.2), so code-side `references`
// edges (4.5) enter the graph.
const SPEC_AND_CODE_CONFIG = `import { defineConfig } from "xspec"

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

/**
 * A usage-error arm: exit 2 exactly (H-5) and, under `--json`, byte-empty
 * stdout — the exit-2 error prevents emitting the single JSON document
 * (SPEC 12.0). `why` names the staged error class in the diagnosis.
 */
async function expectUsageError(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  why: string,
  context: string,
): Promise<void> {
  const result = await expectExit(
    product,
    workspace,
    [...argv, "--json"],
    2,
    `${context} — ${why} is a usage error, exit 2 (SPEC 12.5, 12.0)`,
  );
  assertStdoutEmpty(
    result,
    `${context} — under --json, stdout is byte-empty on exit 2: the usage ` +
      `error prevents emitting the single JSON document (SPEC 12.0, H-5)`,
  );
}

/** One expected flat-listing entry (SPEC 12.3). */
interface FlatEntry {
  readonly file: string;
  readonly ids: readonly string[];
}

/** One expected tree node: a full requirement ID plus nested children. */
interface TreeNode {
  readonly id: string;
  readonly children: readonly TreeNode[];
}

interface TreeEntry {
  readonly file: string;
  readonly nodes: readonly TreeNode[];
}

function tnode(id: string, children: readonly TreeNode[] = []): TreeNode {
  return { id, children };
}

/**
 * The decoded flat listing projected for comparison: entries carrying no IDs
 * dropped (module header — their presence is not fixed by SPEC 12.3), the
 * rest as plain `{ file, ids }` in the reported order.
 */
function flatListing(report: IdsReport): FlatEntry[] {
  return report.files
    .filter((entry) => entry.ids.length > 0)
    .map((entry) => ({ file: entry.file, ids: entry.ids }));
}

function projectTreeNode(node: IdsTreeNode): TreeNode {
  return { id: node.id, children: node.children.map(projectTreeNode) };
}

/** The decoded tree listing projected like {@link flatListing}. */
function treeListing(report: IdsTreeReport): TreeEntry[] {
  return report.files
    .filter((entry) => entry.nodes.length > 0)
    .map((entry) => ({
      file: entry.file,
      nodes: entry.nodes.map(projectTreeNode),
    }));
}

/** Run `ids` with the given flags and assert the exact flat listing. */
async function expectFlatListing(
  product: ProductBinding,
  workspace: TestWorkspace,
  flags: readonly string[],
  expected: readonly FlatEntry[],
  context: string,
): Promise<void> {
  const report = decodeIdsReport(
    await runJson(product, workspace, ["ids", ...flags, "--json"], context),
    context,
  );
  assertSameJson(
    flatListing(report),
    expected,
    `${context}: requirement IDs grouped by file — files in byte order of ` +
      `workspace-relative path, IDs within a file in document order ` +
      `(SPEC 12.3; entries carrying no IDs dropped per the module header)`,
  );
}

/** Run `ids --tree` with the given flags and assert the exact tree. */
async function expectTreeListing(
  product: ProductBinding,
  workspace: TestWorkspace,
  flags: readonly string[],
  expected: readonly TreeEntry[],
  context: string,
): Promise<void> {
  const report = decodeIdsTreeReport(
    await runJson(
      product,
      workspace,
      ["ids", "--tree", ...flags, "--json"],
      context,
    ),
    context,
  );
  assertSameJson(
    treeListing(report),
    expected,
    `${context}: per-file nesting in the same file and document order, tree ` +
      `nodes carrying the full requirement IDs (SPEC 12.3; module header)`,
  );
}

/** A human-form run: exit 0 plus the distinctive information (H-3). */
async function expectHumanListing(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  mentions: readonly Mention[],
  context: string,
): Promise<void> {
  const result = await expectExit(
    product,
    workspace,
    argv,
    0,
    `${context} — the listing is an informational report, exit 0 (SPEC 12.0)`,
  );
  assertReportMentions(
    result,
    mentions,
    `${context}: the human report carries the same information as the JSON ` +
      `form (SPEC 12.0; robust matching, never wording — H-3)`,
  );
}

function sortedTags(tags: readonly string[]): string[] {
  return [...tags].sort();
}

function edgeSortKey(edge: GraphEdge): string {
  return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
}

/** Edges in a canonical order — for comparisons where SPEC fixes no order. */
function sortedEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) => {
    const keyA = edgeSortKey(a);
    const keyB = edgeSortKey(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

/** A node report with SPEC-unordered members normalized (H-3). */
function normalizedNodeReport(report: NodeReport): unknown {
  return {
    identity: report.identity,
    sourceRange: report.sourceRange,
    ownText: report.ownText,
    subtreeText: report.subtreeText,
    hashes: report.hashes,
    tags: sortedTags(report.tags),
    coverage: report.coverage,
    incomingEdges: sortedEdges(report.incomingEdges),
    outgoingEdges: sortedEdges(report.outgoingEdges),
  };
}

// ---------------------------------------------------------------------------
// T12.3-1 — `ids`: ordering, `--tree`, `--file`, restricted tree, parity
// ---------------------------------------------------------------------------

// Ordering workspace: configuration order (group order and per-group glob
// order) is the exact reverse of the byte order of the workspace-relative
// paths, and document order inside Z.mdx differs from the byte order of the
// IDs at both nesting levels — a product listing files in
// configuration/discovery order, or IDs sorted, fails.
const T12_3_1_ORDERING_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    zulu: ["zpecs/**/*.mdx"],
    apex: ["apecs/nested/**/*.mdx", "apecs/*.mdx"]
  }
})
`;

const T12_3_1_Z = [
  '<S id="zeta">',
  "Zeta intro.",
  "",
  '<S id="zeta.minor">',
  "Minor point.",
  "</S>",
  "",
  '<S id="zeta.aleph">',
  "Aleph point.",
  "</S>",
  "</S>",
  "",
  '<S id="alpha">',
  "Alpha line.",
  "</S>",
  "",
].join("\n");

const T12_3_1_M = '<S id="emm">\nEmm line.\n</S>\n';
const T12_3_1_N = '<S id="enn">\nEnn line.\n</S>\n';

// Files in byte order of workspace-relative path; IDs in document order.
const T12_3_1_FLAT: readonly FlatEntry[] = [
  { file: "apecs/M.mdx", ids: ["emm"] },
  { file: "apecs/nested/N.mdx", ids: ["enn"] },
  {
    file: "zpecs/Z.mdx",
    ids: ["zeta", "zeta.minor", "zeta.aleph", "alpha"],
  },
];

const T12_3_1_TREE: readonly TreeEntry[] = [
  { file: "apecs/M.mdx", nodes: [tnode("emm")] },
  { file: "apecs/nested/N.mdx", nodes: [tnode("enn")] },
  {
    file: "zpecs/Z.mdx",
    nodes: [
      tnode("zeta", [tnode("zeta.minor"), tnode("zeta.aleph")]),
      tnode("alpha"),
    ],
  },
];

// Restricted-tree workspace: `grand.par` and `solo` are referenced from code
// (4.5 markers), so `--unreferenced` lists `grand`, `grand.par.leaf`, and
// `solo.kid` — a listed node under an unlisted parent with a listed
// grandparent, and one with no listed ancestor at all.
const T12_3_1_T = [
  '<S id="grand">',
  "Grand line.",
  "",
  '<S id="grand.par">',
  "Par line.",
  "",
  '<S id="grand.par.leaf">',
  "Leaf line.",
  "</S>",
  "</S>",
  "</S>",
  "",
  '<S id="solo">',
  "Solo line.",
  "",
  '<S id="solo.kid">',
  "Kid line.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T12_3_1_APP = [
  'import SPEC from "../specs/T.xspec";',
  "",
  "export function touchPar(): void {",
  "  SPEC.grand.par;",
  "}",
  "",
  "export function touchSolo(): void {",
  "  SPEC.solo;",
  "}",
  "",
].join("\n");

const T12_3_1 = defineProductTest({
  id: "T12.3-1",
  title:
    "`ids` groups requirement IDs by file — files in byte order of workspace-relative path (differing from configuration order), IDs within a file in document order (differing from their byte order); `--tree` renders per-file nesting in the same orders; `--file <glob>` restricts by the rules of SPEC 7 with an outside-root pattern an invalid flag value (exit 2); a restricted `--tree` (`--unreferenced`) nests a listed node under its nearest listed ancestor or at its file's top level, containing exactly the listed IDs; the human form carries the same information as `--json` (SPEC 12.3, 7, 12.0)",
  run: async (product) => {
    await withWorkspace(
      T12_3_1_ORDERING_CONFIG,
      {
        "zpecs/Z.mdx": T12_3_1_Z,
        "apecs/M.mdx": T12_3_1_M,
        "apecs/nested/N.mdx": T12_3_1_N,
      },
      async (workspace) => {
        await buildOk(product, workspace, "T12.3-1 `build` (ordering)");

        // Flat listing: both spec-fixed orders, asserted exactly.
        await expectFlatListing(
          product,
          workspace,
          [],
          T12_3_1_FLAT,
          "T12.3-1 `ids --json`",
        );

        // `--tree`: per-file nesting in the same file and document order.
        await expectTreeListing(
          product,
          workspace,
          [],
          T12_3_1_TREE,
          "T12.3-1 `ids --tree --json`",
        );

        // `--json` parity: the human forms exit 0 and mention the same
        // distinctive information (module header; H-3).
        await expectHumanListing(
          product,
          workspace,
          ["ids"],
          [
            "apecs/M.mdx",
            "apecs/nested/N.mdx",
            "zpecs/Z.mdx",
            "emm",
            "enn",
            "zeta.minor",
            "zeta.aleph",
            "alpha",
          ],
          "T12.3-1 `ids` (human form)",
        );
        await expectHumanListing(
          product,
          workspace,
          ["ids", "--tree"],
          [
            "apecs/M.mdx",
            "apecs/nested/N.mdx",
            "zpecs/Z.mdx",
            "emm",
            "enn",
            "zeta",
            "minor",
            "aleph",
            "alpha",
          ],
          "T12.3-1 `ids --tree` (human form)",
        );

        // `--file <glob>` restricts to files the glob matches (the rules of
        // SPEC 7: `**` spans segments, `*` never crosses `/`).
        await expectFlatListing(
          product,
          workspace,
          ["--file", "apecs/**/*.mdx"],
          [
            { file: "apecs/M.mdx", ids: ["emm"] },
            { file: "apecs/nested/N.mdx", ids: ["enn"] },
          ],
          "T12.3-1 `ids --file apecs/**/*.mdx --json`",
        );
        await expectFlatListing(
          product,
          workspace,
          ["--file", "apecs/*.mdx"],
          [{ file: "apecs/M.mdx", ids: ["emm"] }],
          "T12.3-1 `ids --file apecs/*.mdx --json` (a single `*` never " +
            "crosses `/`, SPEC 7)",
        );

        // A `--file` pattern resolving outside the workspace root is an
        // invalid flag value — exit 2, like its configuration-time
        // counterpart (SPEC 12.3, 7, 14.14, 12.0).
        await expectUsageError(
          product,
          workspace,
          ["ids", "--file", "../*.mdx"],
          "a `--file` pattern resolving outside the workspace root",
          "T12.3-1 `ids --file ../*.mdx`",
        );
      },
    );

    // Restricted `--tree`: nesting under the nearest listed ancestor, or at
    // the file's top level; the tree contains exactly the listed IDs.
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/T.mdx": T12_3_1_T, "src/app.ts": T12_3_1_APP },
      async (workspace) => {
        await buildOk(product, workspace, "T12.3-1 `build` (restricted tree)");

        // Premise: the restriction lists exactly grand, grand.par.leaf, and
        // solo.kid — `grand.par` and `solo` carry incoming `references`
        // edges from the code markers.
        await expectFlatListing(
          product,
          workspace,
          ["--unreferenced"],
          [
            {
              file: "specs/T.mdx",
              ids: ["grand", "grand.par.leaf", "solo.kid"],
            },
          ],
          "T12.3-1 `ids --unreferenced --json` (the restriction premise)",
        );

        // grand.par.leaf's parent is unlisted, so it nests under its nearest
        // listed ancestor (grand); solo.kid has no listed ancestor, so it
        // sits at the file's top level. Exact equality also asserts "the
        // tree contains exactly the listed IDs" — neither grand.par nor solo
        // appears.
        await expectTreeListing(
          product,
          workspace,
          ["--unreferenced"],
          [
            {
              file: "specs/T.mdx",
              nodes: [
                tnode("grand", [tnode("grand.par.leaf")]),
                tnode("solo.kid"),
              ],
            },
          ],
          "T12.3-1 `ids --unreferenced --tree --json` (restricted tree)",
        );

        // Parity for the restricted tree's human form: mentions both a
        // full-ID and an indented-segment rendering contain (H-3).
        await expectHumanListing(
          product,
          workspace,
          ["ids", "--unreferenced", "--tree"],
          ["specs/T.mdx", "grand", "leaf", "kid"],
          "T12.3-1 `ids --unreferenced --tree` (human form)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.3-2 — `--unreferenced`: incoming dependency edges only; ≠ uncovered
// ---------------------------------------------------------------------------

// Two code groups, one of them the coverage boundary: `won` is referenced
// from boundary code (covered), `ref` is referenced from code outside the
// boundary (referenced yet uncovered — the demonstration), `quoted` carries
// an incoming `embeds` edge, `par.dep` an incoming `depends` edge, and `par`
// and `silent` have no incoming dependency edges at all — `par` although its
// child is referenced and it carries `contains` edges both ways.
const T12_3_2_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    inner: ["binside/**/*.ts"],
    outer: ["boutside/**/*.ts"]
  },
  coverage: [
    {
      name: "gate",
      target: "main",
      boundary: "inner",
      mode: "direct"
    }
  ]
})
`;

const T12_3_2_C = [
  '<S id="won">',
  "Won line.",
  "",
  '{text("quoted")}',
  "</S>",
  "",
  '<S id="quoted">',
  "Quoted line.",
  "</S>",
  "",
  '<S id="ref" d={"par.dep"}>',
  "Ref line.",
  "</S>",
  "",
  '<S id="par">',
  "Par line.",
  "",
  '<S id="par.dep">',
  "Dep line.",
  "</S>",
  "</S>",
  "",
  '<S id="silent">',
  "Silent line.",
  "</S>",
  "",
].join("\n");

const T12_3_2_INNER = [
  'import SPEC from "../specs/C.xspec";',
  "",
  "export function useWon(): void {",
  "  SPEC.won;",
  "}",
  "",
].join("\n");

const T12_3_2_OUTER = [
  'import SPEC from "../specs/C.xspec";',
  "",
  "export function useRef(): void {",
  "  SPEC.ref;",
  "}",
  "",
].join("\n");

const T12_3_2_REF = "specs/C.mdx#ref";

const T12_3_2 = defineProductTest({
  id: "T12.3-2",
  title:
    "`ids --unreferenced` lists only nodes with no incoming `depends`/`embeds`/`references` edges — `contains` does not count, so a parent whose child is referenced still lists when itself unreferenced — and unreferenced ≠ uncovered: a node referenced from outside the profile's coverage boundary is absent from the listing yet uncovered in that profile (SPEC 12.3, 8)",
  run: async (product) => {
    await withWorkspace(
      T12_3_2_CONFIG,
      {
        "specs/C.mdx": T12_3_2_C,
        "binside/use.ts": T12_3_2_INNER,
        "boutside/far.ts": T12_3_2_OUTER,
      },
      async (workspace) => {
        await buildOk(product, workspace, "T12.3-2 `build`");

        // The listing: exactly the nodes with no incoming dependency edges,
        // in document order. `par` lists although its child `par.dep` is
        // referenced (incoming `depends`) and although `par` carries
        // `contains` edges (from the root, to its child) — `contains` does
        // not count. `won` (references from boundary code), `quoted`
        // (embeds), `ref` (references from non-boundary code), and `par.dep`
        // (depends) are all excluded.
        await expectFlatListing(
          product,
          workspace,
          ["--unreferenced"],
          [{ file: "specs/C.mdx", ids: ["par", "silent"] }],
          "T12.3-2 `ids --unreferenced --json`",
        );

        // Unreferenced ≠ uncovered: `ref` is referenced (absent from the
        // listing above) yet uncovered in profile `gate` — its only incoming
        // dependency edge comes from code outside the profile's boundary
        // group (SPEC 8: a permitted path must start at a boundary node).
        const coverageContext = "T12.3-2 `coverage --json`";
        const coverage = decodeCoverageReport(
          await runJson(
            product,
            workspace,
            ["coverage", "--json"],
            coverageContext,
          ),
          coverageContext,
        );
        const gate = coverage.profiles.find(
          (profile) => profile.name === "gate",
        );
        if (gate === undefined) {
          fail(
            `${coverageContext}: the report carries the one configured ` +
              `profile "gate" (SPEC 8.2: \`coverage\` runs all profiles); ` +
              `got profiles ${JSON.stringify(
                coverage.profiles.map((profile) => profile.name),
              )}`,
          );
        }
        assertSameJson(
          [...gate.uncovered].sort(),
          [
            "specs/C.mdx#par.dep",
            "specs/C.mdx#quoted",
            T12_3_2_REF,
            "specs/C.mdx#silent",
          ],
          `${coverageContext}: profile gate's uncovered required nodes — ` +
            `${T12_3_2_REF} is referenced yet uncovered (its reference ` +
            `comes from outside the boundary), demonstrating unreferenced ` +
            `≠ uncovered (SPEC 12.3, 8, 8.1)`,
        );
        if (!gate.covered.some((node) => node.identity === "specs/C.mdx#won")) {
          fail(
            `${coverageContext}: specs/C.mdx#won is referenced from the ` +
              `boundary code group, a single permitted edge in direct mode, ` +
              `so it is covered (SPEC 8); covered: ${JSON.stringify(
                gate.covered.map((node) => node.identity),
              )}`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.4-1 — `show`: the full enumeration, adapter-compared to `query node`
// ---------------------------------------------------------------------------

// Discriminating fixture (TEST-SPEC 12.4): the non-root node carries tags and
// coverage="none" (a `show` omitting either fails), plus edges of all four
// kinds across the workspace — incoming contains/embeds, outgoing
// contains/depends/embeds on `star`; the code marker gives `peer` an incoming
// `references` edge.
const T12_4_1_S = [
  '<S id="star" tags="amber vital" coverage="none" d={"peer"}>',
  "Star intro.",
  "",
  '<S id="star.point">',
  "Point line.",
  "</S>",
  "",
  '{text("peer")}',
  "</S>",
  "",
  '<S id="peer">',
  "Peer line.",
  "</S>",
  "",
].join("\n");

const T12_4_1_APP = [
  'import SPEC, { text } from "../specs/S.xspec";',
  "",
  "export function embedStar(): string {",
  "  return text(SPEC.star);",
  "}",
  "",
  "export function markPeer(): void {",
  "  SPEC.peer;",
  "}",
  "",
].join("\n");

const T12_4_1_STAR = "specs/S.mdx#star";
const T12_4_1_ROOT = "specs/S.mdx";

const T12_4_1 = defineProductTest({
  id: "T12.4-1",
  title:
    '`show` accepts `path#id` and bare `path` (root) and prints the full 12.4 enumeration — identity, source range, own and subtree text, hashes, tags, coverage attribute, and edges by kind — each field equal to the corresponding `query node` field for the same node (adapter-compared); the staged tags and coverage="none" are pinned on the `show` side, and the root arm reports the coverage attribute absent (SPEC 12.4, 11, 1.7)',
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/S.mdx": T12_4_1_S, "src/app.ts": T12_4_1_APP },
      async (workspace) => {
        await buildOk(product, workspace, "T12.4-1 `build`");

        const decodeBoth = async (
          node: string,
          label: string,
        ): Promise<{ show: NodeReport; query: NodeReport }> => {
          const showContext = `T12.4-1 \`show ${node} --json\` (${label})`;
          const show = decodeNodeReport(
            await runJson(
              product,
              workspace,
              ["show", node, "--json"],
              showContext,
            ),
            showContext,
          );
          const queryContext = `T12.4-1 \`query node ${node} --json\` (${label})`;
          const query = decodeNodeReport(
            await runJson(
              product,
              workspace,
              ["query", "node", node, "--json"],
              queryContext,
            ),
            queryContext,
          );
          assertSameJson(
            normalizedNodeReport(show),
            normalizedNodeReport(query),
            `T12.4-1 (${label}): every \`show\` field — identity, source ` +
              `range, own and subtree text, hashes, tags, coverage ` +
              `attribute, and edges by kind — equals the corresponding ` +
              `\`query node\` field for ${node} (SPEC 12.4, 11; H-3, ` +
              `spec-unordered members normalized)`,
          );
          assertSameJson(
            show.identity,
            node,
            `T12.4-1 (${label}): \`show ${node}\` reports the addressed ` +
              `node's identity (SPEC 12.4, 1.5)`,
          );
          return { show, query };
        };

        // path#id arm: the discriminating fields pinned on the show side —
        // the adapter compare alone would accept a symmetric omission.
        const star = await decodeBoth(T12_4_1_STAR, "path#id arm");
        assertSameJson(
          sortedTags(star.show.tags),
          ["amber", "vital"],
          `T12.4-1: \`show ${T12_4_1_STAR}\` reports the staged tags — a ` +
            `show omitting tags fails (SPEC 12.4, 2.6)`,
        );
        if (star.show.coverage !== "none") {
          fail(
            `T12.4-1: \`show ${T12_4_1_STAR}\` reports the staged ` +
              `coverage="none" attribute — a show omitting the coverage ` +
              `attribute fails (SPEC 12.4, 2.5); got ` +
              `${star.show.coverage === undefined ? "absent" : JSON.stringify(star.show.coverage)}`,
          );
        }

        // bare-path (root) arm: the coverage attribute is reported absent
        // (SPEC 12.4: absent for a root node, 11).
        const root = await decodeBoth(T12_4_1_ROOT, "bare-path root arm");
        if (root.show.coverage !== undefined) {
          fail(
            `T12.4-1: \`show ${T12_4_1_ROOT}\` reports the coverage ` +
              `attribute as absent for a root node (SPEC 12.4, 11); got ` +
              `${JSON.stringify(root.show.coverage)}`,
          );
        }

        // Human form: exit 0 with the enumeration's distinctive information
        // — identity, tags, the coverage value, edge peers across the four
        // kinds, text fragments (the embedding expanded, 1.6), and the four
        // hash values as reported by `query node` (module header; H-3).
        const humanContext = `T12.4-1 \`show ${T12_4_1_STAR}\` (human form)`;
        const human = await expectExit(
          product,
          workspace,
          ["show", T12_4_1_STAR],
          0,
          `${humanContext} — an informational report, exit 0 (SPEC 12.0)`,
        );
        assertReportMentions(
          human,
          [
            T12_4_1_STAR,
            "amber",
            "vital",
            "none",
            "specs/S.mdx#star.point",
            "specs/S.mdx#peer",
            "src/app.ts#embedStar",
            "Star intro.",
            "Point line.",
            "Peer line.",
            star.query.hashes.ownHash,
            star.query.hashes.subtreeHash,
            star.query.hashes.effectiveHash,
            star.query.hashes.metadataHash,
          ],
          `${humanContext}: the full 12.4 enumeration's distinctive ` +
            `information — identity, tags, coverage value, edge endpoints ` +
            `by kind, expanded text (1.6), and the four hashes \`query ` +
            `node\` reports (SPEC 12.4; robust matching, never wording — H-3)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.5-1 — dispatch: the six commands reach their sections; unknown → 2
// ---------------------------------------------------------------------------

const T12_5_1_D = [
  '<S id="anchor">',
  "Anchor line.",
  "",
  '<S id="anchor.sub">',
  "Sub line.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T12_5_1 = defineProductTest({
  id: "T12.5-1",
  title:
    "`coverage`, `impact`, `review`, `query`, `rename`, and `move` dispatch into their sections' specified outcomes (behavior covered in sections 8, 9, 10, 11, 6); an unknown command or an unknown `query`/`review` subcommand is a usage error, exit 2 (SPEC 12.5, 12.0)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/D.mdx": T12_5_1_D,
      },
    });
    try {
      // A pinned git fixture (E-6/H-1) so `impact --base` has a baseline.
      await workspace.gitInit();
      const baseRef = await workspace.gitCommitAll("baseline sources");
      await buildOk(product, workspace, "T12.5-1 `build`");

      // `coverage` (SPEC 8.2): zero configured profiles — a valid, empty
      // report at exit 0 (T7-3's reading).
      const coverageContext = "T12.5-1 `coverage --json` (dispatch)";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageContext,
        ),
        coverageContext,
      );
      assertSameJson(
        coverage.profiles.map((profile) => profile.name),
        [],
        `${coverageContext}: no coverage profiles are configured, so ` +
          `\`coverage\` runs zero profiles and reports none (SPEC 8.2, 7.4)`,
      );

      // `impact --base` (SPEC 9.3): the workspace equals the baseline
      // commit, so the informational report carries no differences.
      const impactContext = `T12.5-1 \`impact --base ${baseRef} --json\` (dispatch)`;
      const impact = decodeImpactReport(
        await runJson(
          product,
          workspace,
          ["impact", "--base", baseRef, "--json"],
          impactContext,
        ),
        impactContext,
      );
      assertSameJson(
        {
          requirements: impact.requirements,
          direct: impact.code.direct,
          transitive: impact.code.transitive,
        },
        { requirements: [], direct: [], transitive: [] },
        `${impactContext}: the current workspace is byte-identical to the ` +
          `baseline commit, so impact reports no requirement or code ` +
          `differences and exits 0 (SPEC 9.3, 12.0)`,
      );

      // `review` (SPEC 10.7): `list` with no sessions — every session
      // reported, none exist, exit 0.
      const listContext = "T12.5-1 `review list --json` (dispatch)";
      const sessions = decodeSessionListReport(
        await runJson(
          product,
          workspace,
          ["review", "list", "--json"],
          listContext,
        ),
        listContext,
      );
      assertSameJson(
        sessions.sessions,
        [],
        `${listContext}: no sessions exist, so \`review list\` reports ` +
          `none and exits 0 (SPEC 10.7, 12.0)`,
      );

      // `query` (SPEC 11): the workspace's requirement nodes.
      const nodesContext = "T12.5-1 `query nodes --json` (dispatch)";
      const rows = decodeNodeRowsReport(
        await runJson(
          product,
          workspace,
          ["query", "nodes", "--json"],
          nodesContext,
        ),
        nodesContext,
      );
      assertSameJson(
        sortedIdentities(rows),
        ["specs/D.mdx", "specs/D.mdx#anchor", "specs/D.mdx#anchor.sub"],
        `${nodesContext}: \`query nodes\` rows are the workspace's ` +
          `requirement nodes, the root included (SPEC 11, 1.2)`,
      );

      // Unknown command and unknown subcommands → exit 2 (SPEC 12.5, 12.0).
      await expectUsageError(
        product,
        workspace,
        ["transmogrify"],
        "an unknown command",
        "T12.5-1 `transmogrify`",
      );
      await expectExit(
        product,
        workspace,
        ["transmogrify"],
        2,
        "T12.5-1 `transmogrify` (without --json) — an unknown command is a " +
          "usage error, exit 2 (SPEC 12.5, 12.0)",
      );
      await expectUsageError(
        product,
        workspace,
        ["query", "transmogrify"],
        "an unknown `query` subcommand",
        "T12.5-1 `query transmogrify`",
      );
      await expectUsageError(
        product,
        workspace,
        ["review", "transmogrify"],
        "an unknown `review` subcommand",
        "T12.5-1 `review transmogrify`",
      );

      // `rename` (SPEC 6.4) and file-form `move` (SPEC 6.5) dispatch into
      // their journaled mutations — run last, since they rewrite the
      // workspace. Both emit one JSON document under --json (SPEC 12.0).
      await runJson(
        product,
        workspace,
        ["rename", "specs/D.mdx", "anchor.sub", "anchor.part", "--json"],
        "T12.5-1 `rename specs/D.mdx anchor.sub anchor.part --json` " +
          "(dispatch) — a valid rename succeeds (SPEC 6.4)",
      );
      await runJson(
        product,
        workspace,
        ["move", "specs/D.mdx", "specs/E.mdx", "--json"],
        "T12.5-1 `move specs/D.mdx specs/E.mdx --json` (dispatch) — a valid " +
          "file-form move succeeds (SPEC 6.5)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

export const section123to125Tests: readonly ProductTestEntry[] = [
  T12_3_1,
  T12_3_2,
  T12_4_1,
  T12_5_1,
];
