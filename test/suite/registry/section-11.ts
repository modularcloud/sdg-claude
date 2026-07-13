// TEST-SPEC §11 (query) — SUITE-40: T11-1 … T11-7.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 11: `xspec query` is JSON-only — a single JSON document is its only
// output form, with or without `--json` (12.0). `<node>` is a
// requirement-node identity (`path#id`, or a bare `path` for a file's root
// node, 1.5); `<graph-node>` is any graph-node identity — a requirement node
// or a code location (`path`, `path#unit`, `path#unit@N`; 4.6); whether a
// bare path names a root node or a code file follows from the file's group
// (7), and a path in no configured group is unknown (12.0). `node` returns
// identity, source range (1.7), own and subtree text (expanded, 1.6), all
// four hashes (5.5), tags, coverage attribute (absent for a root, 5.5), and
// incoming and outgoing edges by kind. `nodes` filters (`--group`, `--file`,
// `--tag`, `--coverage`) combine conjunctively over requirement-node rows;
// `--coverage` matches no root; `--group` accepts only a spec group's name —
// a code group's name is an invalid flag value (12.0, the wrong-kind group
// reference of 14.14); `--file` uses the glob rules of 7, the outside-root
// rule included. `nodes`, `subtree`, and `ancestors` share one row contract:
// identity, source range, tags, coverage attribute (absent for roots).
// `subtree` returns the queried node plus all descendants in document order;
// `ancestors` returns the proper ancestors nearest-first ending at the file
// root. `reachable` reports whether a dependency path — one or more edges; a
// zero-length path is not one — exists under the given kinds (default: the
// three dependency kinds, never `contains`) and, when one does, one shortest
// witness path with the 12.0 byte-least tie-break; `reachable --kinds`
// rejects `contains` while `edges --kinds` filters over all four kinds and
// defaults to no filter. All results use stable, deterministic ordering.
//
// Conservative operationalizations (noted per H-4/H-3):
// - Both-forms comparison (the §11 preamble): each subcommand's primary arm
//   runs with and without `--json`, decodes both stdout documents through the
//   same H-3 adapter, and asserts the same information — SPEC 11 fixes
//   JSON-only output and information content, not byte-identity between the
//   two invocation forms. Before comparing, exactly the orderings SPEC 11
//   leaves open are normalized (`nodes` row order, `edges` list order, tag
//   order); document order, nearest-first ancestor order, and witness-path
//   sequences are information and compared exactly.
// - `nodes` and `edges` result order: SPEC 11 fixes no particular order for
//   them (only determinism, T11-7), so membership is asserted
//   order-insensitively; `subtree`/`ancestors` orders are spec-fixed and
//   asserted exactly, with document order for a subtree read as pre-order —
//   the queried node first (T11-3 "the node plus its descendants"; a parent's
//   construct begins at or before its descendants'), then constructs by
//   source position.
// - Root rows: `nodes` rows are requirement nodes and a file's root is one
//   (1.2), so unfiltered/`--group`/`--file` results include roots — SPEC 11
//   singles out `--coverage` as matching no root. A non-root node without the
//   attribute reports the default `required` (2.5; the suite-wide reading
//   established by T2.5-1), a root reports the attribute absent.
// - Witness paths are decoded as the inclusive node-identity sequence from
//   the `--from` node to the `--to` node (the H-3 adapter's model; the
//   element-wise byte-least tie-break of 12.0 is asserted on that sequence
//   over a two-equal-paths fixture).
// - `--to` with a code location is accepted (SPEC 11: `--from`/`--to` accept
//   code locations) and — since no edge kind targets a code location (5.2) —
//   yields an empty edge list at exit 0.

import { Buffer } from "node:buffer";
import type {
  GraphEdge,
  NodeReport,
  NodeRow,
  SourceRange,
} from "../../helpers/adapters/index.js";
import {
  decodeEdgesReport,
  decodeNodeReport,
  decodeNodeRowsReport,
  decodeReachableReport,
} from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import {
  assertAcrossDirectoriesDeterministic,
  assertRunOutcomesEqual,
  assertRunTwiceDeterministic,
} from "../../helpers/determinism.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { runProduct } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus one code group (SPEC 7.2): TypeScript files under
// `src/` are discovered code sources, so code-side `embeds`/`references`
// edges and code locations (4.5, 4.6) enter the graph.
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

// Two spec groups plus one code group — T11-2's filter material: `--group`
// distinguishes the spec groups, and `app` is the code group whose name is a
// wrong-kind `--group` value (SPEC 11, 14.14).
const TWO_SPEC_GROUP_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    alpha: ["specs/alpha/**/*.mdx"],
    beta: ["specs/beta/**/*.mdx"]
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

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The source range of a construct staged exactly once inside `source`
 * (zero-based byte offsets, start-inclusive, end-exclusive; SPEC 1.7).
 * Non-unique or missing constructs are fixture bugs and fail at module load,
 * not as product observations.
 */
function rangeOf(source: string, construct: string): SourceRange {
  const index = source.indexOf(construct);
  if (index === -1) {
    throw new Error(
      `section-11 fixture bug: construct not found in source: ${JSON.stringify(construct)}`,
    );
  }
  if (source.indexOf(construct, index + 1) !== -1) {
    throw new Error(
      `section-11 fixture bug: construct is not unique in source: ${JSON.stringify(construct)}`,
    );
  }
  const start = utf8Length(source.slice(0, index));
  return { start, end: start + utf8Length(construct) };
}

/** A root node's source range: the entire file (SPEC 1.7). */
function wholeFileRange(source: string): SourceRange {
  return { start: 0, end: utf8Length(source) };
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

/** A `query node` report with SPEC-unordered members normalized (H-3). */
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

/** One row with tag order normalized (row order handled by the caller). */
function normalizedRow(row: NodeRow): unknown {
  return {
    identity: row.identity,
    sourceRange: row.sourceRange,
    tags: sortedTags(row.tags),
    coverage: row.coverage,
  };
}

/** Rows normalized for order-insensitive comparison (`nodes`). */
function normalizedRowSet(rows: readonly NodeRow[]): unknown {
  return [...rows]
    .sort((a, b) =>
      a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
    )
    .map(normalizedRow);
}

/** Rows normalized keeping order (`subtree`/`ancestors`: order is fixed). */
function normalizedRowSequence(rows: readonly NodeRow[]): unknown {
  return rows.map(normalizedRow);
}

interface BothFormsOptions<T> {
  readonly product: ProductBinding;
  readonly workspace: TestWorkspace;
  /** The query invocation, without `--json`. */
  readonly argv: readonly string[];
  readonly decode: (doc: unknown, context?: string) => T;
  /**
   * Normalization applied to both decoded documents before comparison —
   * sorts exactly what SPEC 11 leaves unordered. Defaults to identity.
   */
  readonly normalize?: (value: T) => unknown;
  readonly context: string;
}

/**
 * The §11 preamble, per subcommand: run with and without `--json`; both exit
 * 0 with exactly one JSON document as the entire stdout (JSON-only, SPEC 11,
 * 12.0; H-5); decode both through the same H-3 adapter and assert the same
 * information. Returns the `--json` form's decoded document for the caller's
 * content assertions.
 */
async function queryBothForms<T>(options: BothFormsOptions<T>): Promise<T> {
  const { product, workspace, argv, decode, context } = options;
  const normalize = options.normalize ?? ((value: T): unknown => value);
  const jsonLabel = `${context} (--json)`;
  const withJson = decode(
    await runJson(product, workspace, [...argv, "--json"], jsonLabel),
    jsonLabel,
  );
  const bareLabel = `${context} (without --json)`;
  const bareResult = await expectExit(product, workspace, argv, 0, bareLabel);
  const withoutJson = decode(parseJsonStdout(bareResult, bareLabel), bareLabel);
  assertSameJson(
    normalize(withoutJson),
    normalize(withJson),
    `${context}: query output is JSON-only — the form without --json emits ` +
      `one JSON document carrying the same information as with --json ` +
      `(SPEC 11, 12.0)`,
  );
  return withJson;
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
    `${context} — ${why} is a usage error, exit 2 (SPEC 11, 12.0)`,
  );
  assertStdoutEmpty(
    result,
    `${context} — under --json, stdout is byte-empty on exit 2: the usage ` +
      `error prevents emitting the single JSON document (SPEC 12.0, H-5)`,
  );
}

/** What one row must carry (the T11-2/T11-3 row contract). */
interface ExpectedRow {
  readonly identity: string;
  readonly range: SourceRange;
  readonly tags: readonly string[];
  /** Coverage attribute value; omitted = absent (a root). */
  readonly coverage?: string;
}

/** Assert each reported row's fields against its expected row (by identity). */
function assertRowFields(
  rows: readonly NodeRow[],
  expected: readonly ExpectedRow[],
  context: string,
): void {
  const byIdentity = new Map(expected.map((row) => [row.identity, row]));
  for (const row of rows) {
    const want = byIdentity.get(row.identity);
    if (want === undefined) continue; // membership is asserted separately
    assertSameJson(
      row.sourceRange,
      want.range,
      `${context}: source range of ${row.identity} — zero-based byte ` +
        `offsets, start-inclusive and end-exclusive (SPEC 1.7, 11)`,
    );
    assertSameJson(
      sortedTags(row.tags),
      sortedTags(want.tags),
      `${context}: tags of ${row.identity} (SPEC 2.6, 11)`,
    );
    if (row.coverage !== want.coverage) {
      fail(
        `${context}: coverage attribute of ${row.identity} — expected ` +
          `${want.coverage === undefined ? "absent (a root node)" : JSON.stringify(want.coverage)}, ` +
          `got ${row.coverage === undefined ? "absent" : JSON.stringify(row.coverage)} ` +
          `(SPEC 2.5, 11: absent for roots, \`required\` by default otherwise)`,
      );
    }
  }
}

/** Exact row membership (order-insensitive) plus per-row fields. */
function assertRowSet(
  rows: readonly NodeRow[],
  expected: readonly ExpectedRow[],
  context: string,
): void {
  assertSameJson(
    sortedIdentities(rows),
    expected.map((row) => row.identity).sort(),
    `${context}: row membership (SPEC 11; order-insensitive — SPEC 11 fixes ` +
      `determinism, not a particular \`nodes\` order)`,
  );
  assertRowFields(rows, expected, context);
}

/** Exact row sequence (order is spec-fixed) plus per-row fields. */
function assertRowSequence(
  rows: readonly NodeRow[],
  expected: readonly ExpectedRow[],
  context: string,
): void {
  assertSameJson(
    rows.map((row) => row.identity),
    expected.map((row) => row.identity),
    `${context}: row order (SPEC 11: document order for \`subtree\`, ` +
      `nearest-first ending at the file root for \`ancestors\`)`,
  );
  assertRowFields(rows, expected, context);
}

// ---------------------------------------------------------------------------
// T11-1 — `query node`: the full node report
// ---------------------------------------------------------------------------

// One spec file exercising everything a node report carries: a tagged
// `coverage="none"` node with a child (own text ≠ subtree text), a same-file
// `d` dependency, and an own-line `{text(...)}` embedding (so both text
// values carry the expansion, SPEC 1.6); plus a code file contributing an
// `embeds` and a `references` edge (SPEC 4.3, 4.5).
const T11_1_CHILD = '<S id="alpha.child">\nChild text.\n</S>';
const T11_1_ALPHA =
  '<S id="alpha" tags="core deep" coverage="none" d={"omega"}>\n' +
  "Alpha intro.\n" +
  "\n" +
  `${T11_1_CHILD}\n` +
  "\n" +
  '{text("omega")}\n' +
  "</S>";
const T11_1_OMEGA = '<S id="omega">\nOmega text.\n</S>';
const T11_1_SOURCE = `${T11_1_ALPHA}\n\n${T11_1_OMEGA}\n`;

const T11_1_APP = [
  'import SPEC, { text } from "../specs/MAIN.xspec";',
  "",
  "export function useAlpha(): string {",
  "  return text(SPEC.alpha);",
  "}",
  "",
  "export function refOmega(): void {",
  "  SPEC.omega;",
  "}",
  "",
].join("\n");

// Text values computed by hand from SPEC 3 (removal, replacement, line-drop)
// and SPEC 1.6 (child-contribution excision; expansion is part of own text).
// omega's subtree text: its construct's contribution — the one kept line.
const T11_1_OMEGA_TEXT = "Omega text.\n";
// alpha's contribution: "Alpha intro." line, the source-empty line, the
// child's line, the second source-empty line, then the embedding line — the
// expression replaced by omega's subtree text ("Omega text.\n"), followed by
// the embedding line's own terminator.
const T11_1_ALPHA_SUBTREE = "Alpha intro.\n\nChild text.\n\nOmega text.\n\n";
// alpha's own text: the child's contribution ("Child text.\n") excised, the
// runs joined exactly at the excision point; the expansion remains (1.6).
const T11_1_ALPHA_OWN = "Alpha intro.\n\n\nOmega text.\n\n";
// The root's subtree text is the entire compiled output: alpha's
// contribution, the source-empty line between the top-level constructs, and
// omega's contribution.
const T11_1_ROOT_SUBTREE = `${T11_1_ALPHA_SUBTREE}\n${T11_1_OMEGA_TEXT}`;
// The root's own text: both top-level contributions excised, leaving the
// between-constructs empty line.
const T11_1_ROOT_OWN = "\n";

const T11_1_MAIN = "specs/MAIN.mdx";
const T11_1_ALPHA_ID = "specs/MAIN.mdx#alpha";
const T11_1_CHILD_ID = "specs/MAIN.mdx#alpha.child";
const T11_1_OMEGA_ID = "specs/MAIN.mdx#omega";

const T11_1 = defineProductTest({
  id: "T11-1",
  title:
    "`query node` returns identity, exact source range, own and subtree text (fully expanded, SPEC 1.6), all four hashes, tags, coverage attribute (absent for the root, `none`/default-`required` otherwise), and incoming and outgoing edges by kind across all four kinds — with and without `--json`, one JSON document carrying the same information (SPEC 11, 1.5, 1.6, 1.7, 5.5)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/MAIN.mdx": T11_1_SOURCE, "src/app.ts": T11_1_APP },
      async (workspace) => {
        await buildOk(product, workspace, "T11-1 `build`");

        // alpha — the primary arm, compared across both invocation forms.
        const alphaContext = `T11-1 \`query node ${T11_1_ALPHA_ID}\``;
        const alpha = await queryBothForms({
          product,
          workspace,
          argv: ["query", "node", T11_1_ALPHA_ID],
          decode: decodeNodeReport,
          normalize: normalizedNodeReport,
          context: alphaContext,
        });
        assertSameJson(
          alpha.identity,
          T11_1_ALPHA_ID,
          `${alphaContext}: identity (SPEC 1.5, 11)`,
        );
        assertSameJson(
          alpha.sourceRange,
          rangeOf(T11_1_SOURCE, T11_1_ALPHA),
          `${alphaContext}: source range spans the construct's own ` +
            `characters, opening tag through closing tag, as zero-based ` +
            `byte offsets (SPEC 1.7)`,
        );
        assertSameJson(
          alpha.ownText,
          T11_1_ALPHA_OWN,
          `${alphaContext}: own text — the child's contribution excised, ` +
            `the \`text(...)\` expansion included (SPEC 1.6, 3)`,
        );
        assertSameJson(
          alpha.subtreeText,
          T11_1_ALPHA_SUBTREE,
          `${alphaContext}: subtree text — the construct's compiled ` +
            `contribution with the embedding fully expanded (SPEC 1.6, 3)`,
        );
        assertSameJson(
          sortedTags(alpha.tags),
          ["core", "deep"],
          `${alphaContext}: tags (SPEC 2.6, 11)`,
        );
        if (alpha.coverage !== "none") {
          fail(
            `${alphaContext}: coverage attribute — expected "none" (staged ` +
              `coverage="none", SPEC 2.5); got ` +
              `${alpha.coverage === undefined ? "absent" : JSON.stringify(alpha.coverage)}`,
          );
        }
        assertEdgeSetEqual(
          alpha.incomingEdges,
          [
            { from: T11_1_MAIN, to: T11_1_ALPHA_ID, kind: "contains" },
            { from: "src/app.ts#useAlpha", to: T11_1_ALPHA_ID, kind: "embeds" },
          ],
          `${alphaContext}: incoming edges by kind (SPEC 5.2, 11)`,
        );
        assertEdgeSetEqual(
          alpha.outgoingEdges,
          [
            { from: T11_1_ALPHA_ID, to: T11_1_CHILD_ID, kind: "contains" },
            { from: T11_1_ALPHA_ID, to: T11_1_OMEGA_ID, kind: "depends" },
            { from: T11_1_ALPHA_ID, to: T11_1_OMEGA_ID, kind: "embeds" },
          ],
          `${alphaContext}: outgoing edges by kind (SPEC 5.2, 11)`,
        );

        // The root node: coverage attribute absent, range = the whole file,
        // subtree text = the entire compiled output (SPEC 1.6, 1.7, 5.5).
        const rootLabel = `T11-1 \`query node ${T11_1_MAIN} --json\` (root)`;
        const root = decodeNodeReport(
          await runJson(
            product,
            workspace,
            ["query", "node", T11_1_MAIN, "--json"],
            rootLabel,
          ),
          rootLabel,
        );
        assertSameJson(
          root.identity,
          T11_1_MAIN,
          `${rootLabel}: a root node's identity is the path alone (SPEC 1.5)`,
        );
        assertSameJson(
          root.sourceRange,
          wholeFileRange(T11_1_SOURCE),
          `${rootLabel}: a root's source range spans the entire file (SPEC 1.7)`,
        );
        assertSameJson(
          root.subtreeText,
          T11_1_ROOT_SUBTREE,
          `${rootLabel}: the root's subtree text is the entire compiled ` +
            `output (SPEC 1.6)`,
        );
        assertSameJson(
          root.ownText,
          T11_1_ROOT_OWN,
          `${rootLabel}: the root's own text — every top-level child ` +
            `contribution excised (SPEC 1.6)`,
        );
        assertSameJson(root.tags, [], `${rootLabel}: a root carries no tags`);
        if (root.coverage !== undefined) {
          fail(
            `${rootLabel}: the coverage attribute is reported as absent for ` +
              `a root node (SPEC 11, 5.5); got ${JSON.stringify(root.coverage)}`,
          );
        }
        assertEdgeSetEqual(
          root.incomingEdges,
          [],
          `${rootLabel}: incoming edges`,
        );
        assertEdgeSetEqual(
          root.outgoingEdges,
          [
            { from: T11_1_MAIN, to: T11_1_ALPHA_ID, kind: "contains" },
            { from: T11_1_MAIN, to: T11_1_OMEGA_ID, kind: "contains" },
          ],
          `${rootLabel}: outgoing edges — \`contains\` to each top-level ` +
            `section (SPEC 5.2, 1.2)`,
        );

        // omega: default-`required` coverage, and incoming edges spanning
        // the remaining kinds — `depends`, `embeds` (MDX), `references`
        // (TS), `contains` — with no outgoing edges.
        const omegaLabel = `T11-1 \`query node ${T11_1_OMEGA_ID} --json\``;
        const omega = decodeNodeReport(
          await runJson(
            product,
            workspace,
            ["query", "node", T11_1_OMEGA_ID, "--json"],
            omegaLabel,
          ),
          omegaLabel,
        );
        assertSameJson(
          omega.sourceRange,
          rangeOf(T11_1_SOURCE, T11_1_OMEGA),
          `${omegaLabel}: source range (SPEC 1.7)`,
        );
        assertSameJson(
          omega.ownText,
          T11_1_OMEGA_TEXT,
          `${omegaLabel}: own text (SPEC 1.6)`,
        );
        assertSameJson(
          omega.subtreeText,
          T11_1_OMEGA_TEXT,
          `${omegaLabel}: subtree text — a childless node's two values agree (SPEC 1.6)`,
        );
        if (omega.coverage !== "required") {
          fail(
            `${omegaLabel}: a non-root node without the attribute is ` +
              `coverage-required by default (SPEC 2.5); got ` +
              `${omega.coverage === undefined ? "absent" : JSON.stringify(omega.coverage)}`,
          );
        }
        assertEdgeSetEqual(
          omega.incomingEdges,
          [
            { from: T11_1_MAIN, to: T11_1_OMEGA_ID, kind: "contains" },
            { from: T11_1_ALPHA_ID, to: T11_1_OMEGA_ID, kind: "depends" },
            { from: T11_1_ALPHA_ID, to: T11_1_OMEGA_ID, kind: "embeds" },
            {
              from: "src/app.ts#refOmega",
              to: T11_1_OMEGA_ID,
              kind: "references",
            },
          ],
          `${omegaLabel}: incoming edges by kind — all four kinds ` +
            `represented across this workspace (SPEC 5.2, 11)`,
        );
        assertEdgeSetEqual(
          omega.outgoingEdges,
          [],
          `${omegaLabel}: outgoing edges`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-2 — `query nodes`: conjunctive filters, row contract, invalid values
// ---------------------------------------------------------------------------

const T11_2_A1 = '<S id="a1" tags="red">\nA one.\n</S>';
const T11_2_A2 = '<S id="a2" tags="red blue" coverage="none">\nA two.\n</S>';
const T11_2_A3 = '<S id="a3">\nA three.\n</S>';
const T11_2_A_SOURCE = `${T11_2_A1}\n\n${T11_2_A2}\n\n${T11_2_A3}\n`;
const T11_2_B1 = '<S id="b1" tags="red" coverage="none">\nB one.\n</S>';
const T11_2_B2 = '<S id="b2">\nB two.\n</S>';
const T11_2_B_SOURCE = `${T11_2_B1}\n\n${T11_2_B2}\n`;

// Every requirement node in the workspace with its full row contract —
// identity, exact source range, tags, coverage attribute (absent for the two
// roots, default `required` where unstated).
const T11_2_ROWS: readonly ExpectedRow[] = [
  {
    identity: "specs/alpha/A.mdx",
    range: wholeFileRange(T11_2_A_SOURCE),
    tags: [],
  },
  {
    identity: "specs/alpha/A.mdx#a1",
    range: rangeOf(T11_2_A_SOURCE, T11_2_A1),
    tags: ["red"],
    coverage: "required",
  },
  {
    identity: "specs/alpha/A.mdx#a2",
    range: rangeOf(T11_2_A_SOURCE, T11_2_A2),
    tags: ["blue", "red"],
    coverage: "none",
  },
  {
    identity: "specs/alpha/A.mdx#a3",
    range: rangeOf(T11_2_A_SOURCE, T11_2_A3),
    tags: [],
    coverage: "required",
  },
  {
    identity: "specs/beta/B.mdx",
    range: wholeFileRange(T11_2_B_SOURCE),
    tags: [],
  },
  {
    identity: "specs/beta/B.mdx#b1",
    range: rangeOf(T11_2_B_SOURCE, T11_2_B1),
    tags: ["red"],
    coverage: "none",
  },
  {
    identity: "specs/beta/B.mdx#b2",
    range: rangeOf(T11_2_B_SOURCE, T11_2_B2),
    tags: [],
    coverage: "required",
  },
];

/** Expected rows selected by identity; a typo fails at module load. */
function expectedRows(
  all: readonly ExpectedRow[],
  ids: readonly string[],
): readonly ExpectedRow[] {
  return ids.map((identity) => {
    const row = all.find((candidate) => candidate.identity === identity);
    if (row === undefined) {
      throw new Error(
        `section-11 fixture bug: no expected row with identity ${JSON.stringify(identity)}`,
      );
    }
    return row;
  });
}

const T11_2 = defineProductTest({
  id: "T11-2",
  title:
    "`query nodes` rows are requirement nodes carrying identity, source range, tags, and coverage attribute (absent for roots); `--group`, `--file <glob>`, `--tag`, and `--coverage` combine conjunctively; `--coverage` matches no root; a `--file` pattern resolving outside the workspace root and a `--group` naming a code group are invalid flag values, exit 2 (SPEC 11, 7, 12.0, 14.14)",
  run: async (product) => {
    await withWorkspace(
      TWO_SPEC_GROUP_CONFIG,
      {
        "specs/alpha/A.mdx": T11_2_A_SOURCE,
        "specs/beta/B.mdx": T11_2_B_SOURCE,
        "src/app.ts": "export {};\n",
      },
      async (workspace) => {
        await buildOk(product, workspace, "T11-2 `build`");

        // Unfiltered — the primary arm, compared across both forms: every
        // requirement node, the two roots included, each row on the one row
        // contract.
        const allContext = "T11-2 `query nodes` (unfiltered)";
        const allRows = await queryBothForms({
          product,
          workspace,
          argv: ["query", "nodes"],
          decode: decodeNodeRowsReport,
          normalize: normalizedRowSet,
          context: allContext,
        });
        assertRowSet(allRows, T11_2_ROWS, allContext);

        // Each filter alone; every set differs from every other, so the
        // conjunction arms below cannot pass by accident.
        const filterArms: readonly {
          readonly argv: readonly string[];
          readonly ids: readonly string[];
          readonly what: string;
        }[] = [
          {
            argv: ["query", "nodes", "--group", "alpha"],
            ids: [
              "specs/alpha/A.mdx",
              "specs/alpha/A.mdx#a1",
              "specs/alpha/A.mdx#a2",
              "specs/alpha/A.mdx#a3",
            ],
            what: "`--group alpha` restricts to the spec group's files, root included",
          },
          {
            argv: ["query", "nodes", "--file", "specs/beta/*.mdx"],
            ids: [
              "specs/beta/B.mdx",
              "specs/beta/B.mdx#b1",
              "specs/beta/B.mdx#b2",
            ],
            what: "`--file specs/beta/*.mdx` restricts by glob (the rules of SPEC 7)",
          },
          {
            argv: ["query", "nodes", "--tag", "red"],
            ids: [
              "specs/alpha/A.mdx#a1",
              "specs/alpha/A.mdx#a2",
              "specs/beta/B.mdx#b1",
            ],
            what: "`--tag red` matches exactly the nodes carrying the tag",
          },
          {
            argv: ["query", "nodes", "--tag", "blue"],
            ids: ["specs/alpha/A.mdx#a2"],
            what: "`--tag blue` matches the one node carrying it",
          },
          {
            argv: ["query", "nodes", "--coverage", "none"],
            ids: ["specs/alpha/A.mdx#a2", "specs/beta/B.mdx#b1"],
            what: "`--coverage none` matches exactly the coverage-excluded nodes",
          },
          {
            argv: ["query", "nodes", "--coverage", "required"],
            ids: [
              "specs/alpha/A.mdx#a1",
              "specs/alpha/A.mdx#a3",
              "specs/beta/B.mdx#b2",
            ],
            what:
              "`--coverage required` matches the default-required nodes and " +
              "no root — the coverage attribute is absent for roots (SPEC 11)",
          },
          {
            argv: [
              "query",
              "nodes",
              "--group",
              "alpha",
              "--file",
              "specs/**/*.mdx",
              "--tag",
              "red",
              "--coverage",
              "none",
            ],
            ids: ["specs/alpha/A.mdx#a2"],
            what:
              "all four filters combine conjunctively — each filter alone " +
              "yields a different set, so only the intersection remains",
          },
          {
            argv: ["query", "nodes", "--tag", "red", "--coverage", "required"],
            ids: ["specs/alpha/A.mdx#a1"],
            what: "`--tag` and `--coverage` combine conjunctively",
          },
        ];
        for (const arm of filterArms) {
          const context = `T11-2 \`${arm.argv.join(" ")}\` — ${arm.what}`;
          const rows = decodeNodeRowsReport(
            await runJson(product, workspace, [...arm.argv, "--json"], context),
            context,
          );
          assertRowSet(rows, expectedRows(T11_2_ROWS, arm.ids), context);
        }

        // Invalid flag values (SPEC 11, 12.0): a `--file` pattern resolving
        // outside the workspace root (the outside-root rule of 7, exit 2
        // like its configuration-time counterpart 14.14), and a `--group`
        // naming a code group (the wrong-kind group reference of 14.14).
        await expectUsageError(
          product,
          workspace,
          ["query", "nodes", "--file", "../*.mdx"],
          "a `--file` pattern resolving outside the workspace root",
          "T11-2 `query nodes --file ../*.mdx`",
        );
        await expectUsageError(
          product,
          workspace,
          ["query", "nodes", "--group", "app"],
          "a `--group` value naming a code group (a wrong-kind group reference, 14.14)",
          "T11-2 `query nodes --group app`",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-3 — `query subtree` / `query ancestors`: membership, order, row contract
// ---------------------------------------------------------------------------

const T11_3_DEEP = '<S id="top.first.deep">\nDeep text.\n</S>';
const T11_3_FIRST = `<S id="top.first">\nFirst text.\n\n${T11_3_DEEP}\n</S>`;
const T11_3_SECOND = '<S id="top.second">\nSecond text.\n</S>';
const T11_3_TOP = `<S id="top" tags="mid" coverage="none">\nTop text.\n\n${T11_3_FIRST}\n\n${T11_3_SECOND}\n</S>`;
const T11_3_AFTER = '<S id="after">\nAfter text.\n</S>';
const T11_3_SOURCE = `${T11_3_TOP}\n\n${T11_3_AFTER}\n`;

const T11_3_FILE = "specs/T.mdx";

const T11_3_ROW_ROOT: ExpectedRow = {
  identity: T11_3_FILE,
  range: wholeFileRange(T11_3_SOURCE),
  tags: [],
};
// The tagged coverage="none" row both subcommands must carry in full — a
// product omitting a row field from either subcommand fails on it or on the
// root row above (T11-3).
const T11_3_ROW_TOP: ExpectedRow = {
  identity: `${T11_3_FILE}#top`,
  range: rangeOf(T11_3_SOURCE, T11_3_TOP),
  tags: ["mid"],
  coverage: "none",
};
const T11_3_ROW_FIRST: ExpectedRow = {
  identity: `${T11_3_FILE}#top.first`,
  range: rangeOf(T11_3_SOURCE, T11_3_FIRST),
  tags: [],
  coverage: "required",
};
const T11_3_ROW_DEEP: ExpectedRow = {
  identity: `${T11_3_FILE}#top.first.deep`,
  range: rangeOf(T11_3_SOURCE, T11_3_DEEP),
  tags: [],
  coverage: "required",
};
const T11_3_ROW_SECOND: ExpectedRow = {
  identity: `${T11_3_FILE}#top.second`,
  range: rangeOf(T11_3_SOURCE, T11_3_SECOND),
  tags: [],
  coverage: "required",
};
const T11_3_ROW_AFTER: ExpectedRow = {
  identity: `${T11_3_FILE}#after`,
  range: rangeOf(T11_3_SOURCE, T11_3_AFTER),
  tags: [],
  coverage: "required",
};

const T11_3 = defineProductTest({
  id: "T11-3",
  title:
    '`query subtree` returns the queried node plus all descendants in document order (a root query returns the whole file); `query ancestors` returns the proper ancestors nearest-first ending at the file root, the queried node excluded and a root yielding none — every row carrying the one row contract (identity, source range, tags, coverage attribute), asserted including a tagged coverage="none" node and a root with the attribute absent (SPEC 11, 1.7, 2.5, 2.6)',
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [T11_3_FILE]: T11_3_SOURCE },
      async (workspace) => {
        await buildOk(product, workspace, "T11-3 `build`");

        // subtree of an inner node — the primary arm, both forms: the node
        // plus its descendants in document order; the sibling after the
        // closing tag and the root are excluded.
        const subtreeContext = `T11-3 \`query subtree ${T11_3_ROW_TOP.identity}\``;
        const subtreeRows = await queryBothForms({
          product,
          workspace,
          argv: ["query", "subtree", T11_3_ROW_TOP.identity],
          decode: decodeNodeRowsReport,
          normalize: normalizedRowSequence,
          context: subtreeContext,
        });
        assertRowSequence(
          subtreeRows,
          [T11_3_ROW_TOP, T11_3_ROW_FIRST, T11_3_ROW_DEEP, T11_3_ROW_SECOND],
          subtreeContext,
        );

        // subtree of a mid-level node: descendants only, siblings excluded.
        const firstContext = `T11-3 \`query subtree ${T11_3_ROW_FIRST.identity} --json\``;
        assertRowSequence(
          decodeNodeRowsReport(
            await runJson(
              product,
              workspace,
              ["query", "subtree", T11_3_ROW_FIRST.identity, "--json"],
              firstContext,
            ),
            firstContext,
          ),
          [T11_3_ROW_FIRST, T11_3_ROW_DEEP],
          firstContext,
        );

        // subtree of the root (bare path): the whole file — the root row
        // (coverage attribute absent) plus every node in document order.
        const rootSubtreeContext = `T11-3 \`query subtree ${T11_3_FILE} --json\` (root)`;
        assertRowSequence(
          decodeNodeRowsReport(
            await runJson(
              product,
              workspace,
              ["query", "subtree", T11_3_FILE, "--json"],
              rootSubtreeContext,
            ),
            rootSubtreeContext,
          ),
          [
            T11_3_ROW_ROOT,
            T11_3_ROW_TOP,
            T11_3_ROW_FIRST,
            T11_3_ROW_DEEP,
            T11_3_ROW_SECOND,
            T11_3_ROW_AFTER,
          ],
          rootSubtreeContext,
        );

        // ancestors of the deepest node — the primary arm, both forms:
        // proper ancestors nearest-first, ending at the file root; the
        // queried node itself excluded. The chain crosses the tagged
        // coverage="none" node and ends at the root row (attribute absent).
        const ancestorsContext = `T11-3 \`query ancestors ${T11_3_ROW_DEEP.identity}\``;
        const ancestorRows = await queryBothForms({
          product,
          workspace,
          argv: ["query", "ancestors", T11_3_ROW_DEEP.identity],
          decode: decodeNodeRowsReport,
          normalize: normalizedRowSequence,
          context: ancestorsContext,
        });
        assertRowSequence(
          ancestorRows,
          [T11_3_ROW_FIRST, T11_3_ROW_TOP, T11_3_ROW_ROOT],
          ancestorsContext,
        );

        // ancestors of a top-level node: the root alone.
        const afterContext = `T11-3 \`query ancestors ${T11_3_ROW_AFTER.identity} --json\``;
        assertRowSequence(
          decodeNodeRowsReport(
            await runJson(
              product,
              workspace,
              ["query", "ancestors", T11_3_ROW_AFTER.identity, "--json"],
              afterContext,
            ),
            afterContext,
          ),
          [T11_3_ROW_ROOT],
          afterContext,
        );

        // ancestors of the root: empty — a root has no proper ancestors.
        const rootAncestorsContext = `T11-3 \`query ancestors ${T11_3_FILE} --json\` (root)`;
        assertRowSequence(
          decodeNodeRowsReport(
            await runJson(
              product,
              workspace,
              ["query", "ancestors", T11_3_FILE, "--json"],
              rootAncestorsContext,
            ),
            rootAncestorsContext,
          ),
          [],
          rootAncestorsContext,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-4 — `query edges`: --from/--to over both node kinds, --kinds, exit 2
// ---------------------------------------------------------------------------

const T11_4_HUB = '<S id="hub" d={"leaf"}>\nHub: {text("leaf")}\n</S>';
const T11_4_LEAF = '<S id="leaf">\nLeaf text.\n</S>';
const T11_4_SOURCE = `${T11_4_HUB}\n\n${T11_4_LEAF}\n`;
const T11_4_APP = [
  'import SPEC, { text } from "../specs/E.xspec";',
  "",
  "export function embedder(): string {",
  "  return text(SPEC.leaf);",
  "}",
  "",
  "export function referrer(): void {",
  "  SPEC.hub;",
  "}",
  "",
].join("\n");

const T11_4_FILE = "specs/E.mdx";
const T11_4_HUB_ID = "specs/E.mdx#hub";
const T11_4_LEAF_ID = "specs/E.mdx#leaf";
const T11_4_EMBEDDER = "src/app.ts#embedder";
const T11_4_REFERRER = "src/app.ts#referrer";

// The workspace's complete edge set — all four kinds present.
const T11_4_ALL_EDGES: readonly GraphEdge[] = [
  { from: T11_4_FILE, to: T11_4_HUB_ID, kind: "contains" },
  { from: T11_4_FILE, to: T11_4_LEAF_ID, kind: "contains" },
  { from: T11_4_HUB_ID, to: T11_4_LEAF_ID, kind: "depends" },
  { from: T11_4_HUB_ID, to: T11_4_LEAF_ID, kind: "embeds" },
  { from: T11_4_EMBEDDER, to: T11_4_LEAF_ID, kind: "embeds" },
  { from: T11_4_REFERRER, to: T11_4_HUB_ID, kind: "references" },
];

function edgesWhere(
  predicate: (edge: GraphEdge) => boolean,
): readonly GraphEdge[] {
  return T11_4_ALL_EDGES.filter(predicate);
}

const T11_4 = defineProductTest({
  id: "T11-4",
  title:
    "`query edges`: `--from`/`--to` accept requirement nodes and code locations; `--kinds` filters over all four kinds via one comma-separated value and defaults to no filter, `contains` edges included; an unknown kind value is an invalid flag value, exit 2 (SPEC 11, 5.2, 12.0)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/E.mdx": T11_4_SOURCE, "src/app.ts": T11_4_APP },
      async (workspace) => {
        await buildOk(product, workspace, "T11-4 `build`");

        // Unfiltered — the primary arm, both forms: the complete edge set,
        // `contains` included (the default is no kind filter).
        const allContext = "T11-4 `query edges` (unfiltered)";
        const allEdges = await queryBothForms({
          product,
          workspace,
          argv: ["query", "edges"],
          decode: decodeEdgesReport,
          normalize: sortedEdges,
          context: allContext,
        });
        assertEdgeSetEqual(
          allEdges,
          T11_4_ALL_EDGES,
          `${allContext}: the complete edge set — no kind filter by ` +
            `default, \`contains\` edges included (SPEC 11)`,
        );

        const filterArms: readonly {
          readonly argv: readonly string[];
          readonly expected: readonly GraphEdge[];
          readonly what: string;
        }[] = [
          {
            argv: ["query", "edges", "--kinds", "contains"],
            expected: edgesWhere((edge) => edge.kind === "contains"),
            what: "`--kinds contains` — `edges` filters over all four kinds",
          },
          {
            argv: ["query", "edges", "--kinds", "depends,embeds"],
            expected: edgesWhere(
              (edge) => edge.kind === "depends" || edge.kind === "embeds",
            ),
            what: "`--kinds depends,embeds` — one comma-separated list value (SPEC 12.0)",
          },
          {
            argv: ["query", "edges", "--kinds", "references"],
            expected: edgesWhere((edge) => edge.kind === "references"),
            what: "`--kinds references`",
          },
          {
            argv: ["query", "edges", "--from", T11_4_HUB_ID],
            expected: edgesWhere((edge) => edge.from === T11_4_HUB_ID),
            what: "`--from` with a requirement node",
          },
          {
            argv: ["query", "edges", "--from", T11_4_REFERRER],
            expected: edgesWhere((edge) => edge.from === T11_4_REFERRER),
            what: "`--from` with a code location (SPEC 11: code locations accepted)",
          },
          {
            argv: ["query", "edges", "--to", T11_4_LEAF_ID],
            expected: edgesWhere((edge) => edge.to === T11_4_LEAF_ID),
            what: "`--to` with a requirement node",
          },
          {
            argv: ["query", "edges", "--to", T11_4_EMBEDDER],
            expected: [],
            what:
              "`--to` with a code location — accepted, and empty since no " +
              "edge kind targets a code location (SPEC 5.2)",
          },
        ];
        for (const arm of filterArms) {
          const context = `T11-4 \`${arm.argv.join(" ")}\` — ${arm.what}`;
          const edges = decodeEdgesReport(
            await runJson(product, workspace, [...arm.argv, "--json"], context),
            context,
          );
          assertEdgeSetEqual(edges, arm.expected, context);
        }

        await expectUsageError(
          product,
          workspace,
          ["query", "edges", "--kinds", "nonsense"],
          "an unknown edge-kind value",
          "T11-4 `query edges --kinds nonsense`",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-5 — `query reachable`: kinds, tie-break, zero-length, contains refusal
// ---------------------------------------------------------------------------

// The dependency graph (all edges within one file, local `d` references and
// one embedding; a code file adds a `references` origin):
//
//   src/r.ts#f --references--> start --depends--> mid-a --depends--> goal
//                              start --depends--> mid-b --depends--> goal
//                              goal --embeds--> tail
//   parent --contains--> parent.kid   (no dependency edge between them)
//
// start→goal has exactly two shortest witness candidates (via mid-a / via
// mid-b) — the two-equal-paths fixture for the 12.0 element-wise byte-least
// tie-break ("mid-a" < "mid-b").
const T11_5_SOURCE = [
  '<S id="start" d={["mid-a", "mid-b"]}>\nStart.\n</S>',
  '<S id="mid-a" d={"goal"}>\nMid A.\n</S>',
  '<S id="mid-b" d={"goal"}>\nMid B.\n</S>',
  '<S id="goal">\nGoal: {text("tail")}\n</S>',
  '<S id="tail">\nTail.\n</S>',
  '<S id="parent">\nParent.\n\n<S id="parent.kid">\nKid.\n</S>\n</S>',
].join("\n\n");
const T11_5_R = `${T11_5_SOURCE}\n`;
const T11_5_CODE = [
  'import SPEC from "../specs/R.xspec";',
  "",
  "export function f(): void {",
  "  SPEC.start;",
  "}",
  "",
].join("\n");

const T11_5_START = "specs/R.mdx#start";
const T11_5_MID_A = "specs/R.mdx#mid-a";
const T11_5_GOAL = "specs/R.mdx#goal";
const T11_5_TAIL = "specs/R.mdx#tail";
const T11_5_PARENT = "specs/R.mdx#parent";
const T11_5_KID = "specs/R.mdx#parent.kid";
const T11_5_F = "src/r.ts#f";

const T11_5 = defineProductTest({
  id: "T11-5",
  title:
    "`query reachable` reports whether a dependency path exists under the given kinds (default: all three dependency kinds, never `contains`) and one shortest witness path with the 12.0 byte-least tie-break over a two-equal-paths fixture; equal `--from` and `--to` on a node with both incoming and outgoing dependency edges reports no path (a zero-length path is not a path); `--kinds contains` is an invalid flag value, exit 2 (SPEC 11, 5.3, 12.0)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/R.mdx": T11_5_R, "src/r.ts": T11_5_CODE },
      async (workspace) => {
        await buildOk(product, workspace, "T11-5 `build`");

        // The primary arm, both forms: reachable with the tie-break — two
        // equal-length witness candidates exist, and the element-wise
        // byte-least node-identity sequence (via mid-a) must be reported.
        const tieContext = `T11-5 \`query reachable --from ${T11_5_START} --to ${T11_5_GOAL}\``;
        const tie = await queryBothForms({
          product,
          workspace,
          argv: [
            "query",
            "reachable",
            "--from",
            T11_5_START,
            "--to",
            T11_5_GOAL,
          ],
          decode: decodeReachableReport,
          context: tieContext,
        });
        if (!tie.reachable) {
          fail(
            `${tieContext}: a dependency path start→mid-a→goal exists under ` +
              `the default kinds, so the report must state one does (SPEC 11)`,
          );
        }
        assertSameJson(
          tie.path,
          [T11_5_START, T11_5_MID_A, T11_5_GOAL],
          `${tieContext}: one shortest witness path — two equal-length ` +
            `candidates exist (via mid-a and via mid-b), and the reported ` +
            `one must be the element-wise byte-least node-identity sequence ` +
            `("mid-a" < "mid-b"; SPEC 12.0, 11)`,
        );

        // Positive arms across the kind space: the default covers all three
        // dependency kinds (mixed depends+embeds; a references origin at a
        // code location), and `--kinds` restricts the path space.
        const positiveArms: readonly {
          readonly from: string;
          readonly to: string;
          readonly kinds?: string;
          readonly path: readonly string[];
          readonly what: string;
        }[] = [
          {
            from: T11_5_START,
            to: T11_5_TAIL,
            path: [T11_5_START, T11_5_MID_A, T11_5_GOAL, T11_5_TAIL],
            what:
              "default kinds are all three dependency kinds — the only " +
              "paths mix `depends` and `embeds` (tie-break again via mid-a)",
          },
          {
            from: T11_5_F,
            to: T11_5_GOAL,
            path: [T11_5_F, T11_5_START, T11_5_MID_A, T11_5_GOAL],
            what:
              "`references` is in the default kinds and `--from` accepts a " +
              "code location (SPEC 11)",
          },
          {
            from: T11_5_START,
            to: T11_5_GOAL,
            kinds: "depends",
            path: [T11_5_START, T11_5_MID_A, T11_5_GOAL],
            what: "`--kinds depends` still reaches goal over `depends` edges alone",
          },
          {
            from: T11_5_START,
            to: T11_5_TAIL,
            kinds: "depends,embeds",
            path: [T11_5_START, T11_5_MID_A, T11_5_GOAL, T11_5_TAIL],
            what: "`--kinds depends,embeds` — one comma-separated list value",
          },
          {
            from: T11_5_GOAL,
            to: T11_5_TAIL,
            kinds: "embeds",
            path: [T11_5_GOAL, T11_5_TAIL],
            what: "`--kinds embeds` follows the embedding edge",
          },
          {
            from: T11_5_F,
            to: T11_5_START,
            kinds: "references",
            path: [T11_5_F, T11_5_START],
            what: "`--kinds references` follows the code reference",
          },
        ];
        for (const arm of positiveArms) {
          const argv = [
            "query",
            "reachable",
            "--from",
            arm.from,
            "--to",
            arm.to,
            ...(arm.kinds === undefined ? [] : ["--kinds", arm.kinds]),
          ];
          const context = `T11-5 \`${argv.join(" ")}\` — ${arm.what}`;
          const report = decodeReachableReport(
            await runJson(product, workspace, [...argv, "--json"], context),
            context,
          );
          if (!report.reachable) {
            fail(
              `${context}: a path exists, so the report must state one does`,
            );
          }
          assertSameJson(
            report.path,
            arm.path,
            `${context}: the shortest witness path (SPEC 11, 12.0)`,
          );
        }

        // Negative arms: restricting kinds severs the path; `contains` never
        // participates (the parent→kid connection is contains-only); equal
        // endpoints report no path even on a node with incoming and outgoing
        // dependency edges — a zero-length path is not a path.
        const negativeArms: readonly {
          readonly from: string;
          readonly to: string;
          readonly kinds?: string;
          readonly what: string;
        }[] = [
          {
            from: T11_5_START,
            to: T11_5_TAIL,
            kinds: "depends",
            what:
              "`--kinds depends` severs the final `embeds` hop, so no path " +
              "exists under the given kinds",
          },
          {
            from: T11_5_START,
            to: T11_5_GOAL,
            kinds: "embeds",
            what: "`--kinds embeds` severs the `depends` hops",
          },
          {
            from: T11_5_PARENT,
            to: T11_5_KID,
            what:
              "the only connection is a `contains` edge, and the default " +
              "kinds never include `contains` (SPEC 11)",
          },
          {
            from: T11_5_MID_A,
            to: T11_5_MID_A,
            what:
              "equal --from and --to on a node bearing both incoming and " +
              "outgoing dependency edges: a zero-length path is not a path, " +
              "so no path exists (SPEC 11, 5.3)",
          },
        ];
        for (const arm of negativeArms) {
          const argv = [
            "query",
            "reachable",
            "--from",
            arm.from,
            "--to",
            arm.to,
            ...(arm.kinds === undefined ? [] : ["--kinds", arm.kinds]),
          ];
          const context = `T11-5 \`${argv.join(" ")}\` — ${arm.what}`;
          const report = decodeReachableReport(
            await runJson(product, workspace, [...argv, "--json"], context),
            context,
          );
          if (report.reachable) {
            fail(
              `${context}: no dependency path exists here, so the report ` +
                `must state that none does (the H-3 adapter enforces that ` +
                `no witness path accompanies an unreachable report)`,
            );
          }
        }

        // `reachable --kinds` accepts only the three dependency kinds:
        // `contains` — alone or inside the comma-separated list — is an
        // invalid flag value (SPEC 11, 12.0), unlike `edges --kinds` (T11-4).
        await expectUsageError(
          product,
          workspace,
          [
            "query",
            "reachable",
            "--from",
            T11_5_START,
            "--to",
            T11_5_GOAL,
            "--kinds",
            "contains",
          ],
          "`contains` as a `reachable` kind",
          "T11-5 `query reachable --kinds contains`",
        );
        await expectUsageError(
          product,
          workspace,
          [
            "query",
            "reachable",
            "--from",
            T11_5_START,
            "--to",
            T11_5_GOAL,
            "--kinds",
            "depends,contains",
          ],
          "`contains` inside a `reachable` kinds list",
          "T11-5 `query reachable --kinds depends,contains`",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-6 — identity resolution: bare paths, code units, unknown paths
// ---------------------------------------------------------------------------

const T11_6_S1 = '<S id="s1">\nS one.\n</S>';
const T11_6_S_SOURCE = `${T11_6_S1}\n`;
// One code file staging all three code-location identity forms (SPEC 4.6):
// a top-level marker attributed to the whole file (bare path), a getter
// (the first `Box.v` occurrence), and a setter (the second — `Box.v@2`,
// the spec's own getter/setter duplicate-chain example).
const T11_6_CODE = [
  'import SPEC, { text } from "../specs/S.xspec";',
  "",
  "SPEC.s1;",
  "",
  "export class Box {",
  "  get v(): string {",
  "    return text(SPEC.s1);",
  "  }",
  "  set v(value: string) {",
  "    SPEC.s1;",
  "  }",
  "}",
  "",
].join("\n");

const T11_6_ROOT = "specs/S.mdx";
const T11_6_S1_ID = "specs/S.mdx#s1";

const T11_6 = defineProductTest({
  id: "T11-6",
  title:
    "identity resolution: a bare `path` resolves to the root node for a spec-group file and to a code location for a code-group file; `path#unit` and `path#unit@N` address code locations (a getter/setter pair as the duplicate unit chain); a path in no configured group is unknown, exit 2 (SPEC 11, 1.5, 4.6, 12.0)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/S.mdx": T11_6_S_SOURCE,
        "src/code.ts": T11_6_CODE,
        "docs/N.mdx": "Plain notes outside every configured group.\n",
      },
      async (workspace) => {
        await buildOk(product, workspace, "T11-6 `build`");

        // A bare spec-group path names the file's root node (SPEC 1.5, 11):
        // `query node` answers with the root's report — identity is the path
        // alone, the source range spans the entire file, and the coverage
        // attribute is absent.
        const rootLabel = `T11-6 \`query node ${T11_6_ROOT} --json\``;
        const root = decodeNodeReport(
          await runJson(
            product,
            workspace,
            ["query", "node", T11_6_ROOT, "--json"],
            rootLabel,
          ),
          rootLabel,
        );
        assertSameJson(
          root.identity,
          T11_6_ROOT,
          `${rootLabel}: a bare path for a spec-group file resolves to the ` +
            `file's root node (SPEC 1.5, 11)`,
        );
        assertSameJson(
          root.sourceRange,
          wholeFileRange(T11_6_S_SOURCE),
          `${rootLabel}: the root's source range spans the entire file (SPEC 1.7)`,
        );
        if (root.coverage !== undefined) {
          fail(
            `${rootLabel}: the coverage attribute is absent for a root node ` +
              `(SPEC 11); got ${JSON.stringify(root.coverage)}`,
          );
        }

        // A bare code-group path names a code location — the whole file
        // (SPEC 4.6): as a `--from` graph node it selects exactly the edge
        // recorded for the top-level marker, which is attributed to the file
        // since no named unit encloses it.
        const codeArms: readonly {
          readonly from: string;
          readonly expected: readonly GraphEdge[];
          readonly what: string;
        }[] = [
          {
            from: "src/code.ts",
            expected: [
              { from: "src/code.ts", to: T11_6_S1_ID, kind: "references" },
            ],
            what:
              "a bare path for a code-group file resolves to the whole-file " +
              "code location (the top-level marker's attribution, SPEC 4.6)",
          },
          {
            from: "src/code.ts#Box.v",
            expected: [
              { from: "src/code.ts#Box.v", to: T11_6_S1_ID, kind: "embeds" },
            ],
            what:
              "`path#unit` addresses a named code unit — the getter, the " +
              "first `Box.v` occurrence (SPEC 4.6)",
          },
          {
            from: "src/code.ts#Box.v@2",
            expected: [
              {
                from: "src/code.ts#Box.v@2",
                to: T11_6_S1_ID,
                kind: "references",
              },
            ],
            what:
              "`path#unit@N` addresses the N-th occurrence of a duplicate " +
              "unit chain — the setter of the getter/setter pair (SPEC 4.6)",
          },
        ];
        for (const arm of codeArms) {
          const context = `T11-6 \`query edges --from ${arm.from}\` — ${arm.what}`;
          const edges = decodeEdgesReport(
            await runJson(
              product,
              workspace,
              ["query", "edges", "--from", arm.from, "--json"],
              context,
            ),
            context,
          );
          assertEdgeSetEqual(edges, arm.expected, context);
        }

        // A path in no configured group is unknown (SPEC 11, 12.0): the file
        // exists on disk, but discovery is controlled exclusively by
        // configuration (SPEC 7), so naming it is a usage error.
        await expectUsageError(
          product,
          workspace,
          ["query", "node", "docs/N.mdx"],
          "a path in no configured group (as a `<node>` argument)",
          "T11-6 `query node docs/N.mdx`",
        );
        await expectUsageError(
          product,
          workspace,
          ["query", "edges", "--from", "docs/N.mdx"],
          "a path in no configured group (as a `<graph-node>` argument)",
          "T11-6 `query edges --from docs/N.mdx`",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T11-7 — ordering determinism: repeated runs and across directories (H-6)
// ---------------------------------------------------------------------------

// Ordering material: two spec files (multi-file `nodes` and `edges` lists),
// nesting, tags, coverage, a dependency chain for `reachable`, and a code
// reference. The first `query` in a fresh directory refreshes graph data
// (SPEC 13.3), so the two-directory protocol also compares the refresh's
// written files byte-for-byte.
const T11_7_FILES: Readonly<Record<string, string>> = {
  "specs/A.mdx":
    '<S id="alpha" tags="t2 t1" coverage="none" d={"beta"}>\nAlpha.\n\n' +
    '<S id="alpha.child">\nChild.\n</S>\n</S>\n\n' +
    '<S id="beta" d={"gamma"}>\nBeta: {text("gamma")}\n</S>\n\n' +
    '<S id="gamma">\nGamma.\n</S>\n',
  "specs/B.mdx": '<S id="omega">\nOmega.\n</S>\n',
  "src/app.ts": [
    'import SPEC from "../specs/A.xspec";',
    "",
    "export function touch(): void {",
    "  SPEC.alpha;",
    "}",
    "",
  ].join("\n"),
};

const T11_7_IDENTITIES: readonly string[] = [
  "specs/A.mdx",
  "specs/A.mdx#alpha",
  "specs/A.mdx#alpha.child",
  "specs/A.mdx#beta",
  "specs/A.mdx#gamma",
  "specs/B.mdx",
  "specs/B.mdx#omega",
];

const T11_7_EDGES: readonly GraphEdge[] = [
  { from: "specs/A.mdx", to: "specs/A.mdx#alpha", kind: "contains" },
  { from: "specs/A.mdx", to: "specs/A.mdx#beta", kind: "contains" },
  { from: "specs/A.mdx", to: "specs/A.mdx#gamma", kind: "contains" },
  {
    from: "specs/A.mdx#alpha",
    to: "specs/A.mdx#alpha.child",
    kind: "contains",
  },
  { from: "specs/B.mdx", to: "specs/B.mdx#omega", kind: "contains" },
  { from: "specs/A.mdx#alpha", to: "specs/A.mdx#beta", kind: "depends" },
  { from: "specs/A.mdx#beta", to: "specs/A.mdx#gamma", kind: "depends" },
  { from: "specs/A.mdx#beta", to: "specs/A.mdx#gamma", kind: "embeds" },
  { from: "src/app.ts#touch", to: "specs/A.mdx#alpha", kind: "references" },
];

const T11_7_PRIMARY: readonly string[] = ["query", "nodes", "--json"];

// Every result-list-bearing subcommand, each with a content check keeping
// the determinism observation honest (and the test red against the stub,
// H-8): identical empty outputs would satisfy H-6 alone.
const T11_7_COMMANDS: readonly {
  readonly argv: readonly string[];
  readonly verify: (doc: unknown, context: string) => void;
}[] = [
  {
    argv: T11_7_PRIMARY,
    verify: (doc, context) => {
      assertSameJson(
        sortedIdentities(decodeNodeRowsReport(doc, context)),
        [...T11_7_IDENTITIES].sort(),
        `${context}: row membership`,
      );
    },
  },
  {
    argv: ["query", "node", "specs/A.mdx#alpha", "--json"],
    verify: (doc, context) => {
      assertSameJson(
        decodeNodeReport(doc, context).identity,
        "specs/A.mdx#alpha",
        `${context}: identity`,
      );
    },
  },
  {
    argv: ["query", "subtree", "specs/A.mdx", "--json"],
    verify: (doc, context) => {
      assertSameJson(
        decodeNodeRowsReport(doc, context).map((row) => row.identity),
        [
          "specs/A.mdx",
          "specs/A.mdx#alpha",
          "specs/A.mdx#alpha.child",
          "specs/A.mdx#beta",
          "specs/A.mdx#gamma",
        ],
        `${context}: the whole file in document order`,
      );
    },
  },
  {
    argv: ["query", "ancestors", "specs/A.mdx#alpha.child", "--json"],
    verify: (doc, context) => {
      assertSameJson(
        decodeNodeRowsReport(doc, context).map((row) => row.identity),
        ["specs/A.mdx#alpha", "specs/A.mdx"],
        `${context}: proper ancestors nearest-first`,
      );
    },
  },
  {
    argv: ["query", "edges", "--json"],
    verify: (doc, context) => {
      assertEdgeSetEqual(
        decodeEdgesReport(doc, context),
        T11_7_EDGES,
        `${context}: the complete edge set`,
      );
    },
  },
  {
    argv: [
      "query",
      "reachable",
      "--from",
      "specs/A.mdx#alpha",
      "--to",
      "specs/A.mdx#gamma",
      "--json",
    ],
    verify: (doc, context) => {
      const report = decodeReachableReport(doc, context);
      if (!report.reachable) {
        fail(`${context}: alpha→beta→gamma exists, so goal is reachable`);
      }
      assertSameJson(
        report.path,
        ["specs/A.mdx#alpha", "specs/A.mdx#beta", "specs/A.mdx#gamma"],
        `${context}: the witness path`,
      );
    },
  },
];

const T11_7 = defineProductTest({
  id: "T11-7",
  title:
    "every `query` result list is deterministic: for each subcommand, repeated runs are byte-identical (including the workspace byte state), and content-identical workspaces in different directories produce identical output — with the first query's graph-data refresh compared byte-for-byte across directories (SPEC 11, 12.0, 13.3; H-6)",
  run: async (product) => {
    const created: TestWorkspace[] = [];
    try {
      const makeWorkspace = async (): Promise<TestWorkspace> => {
        const workspace = await TestWorkspace.create({
          files: { "xspec.config.ts": SPEC_AND_CODE_CONFIG, ...T11_7_FILES },
        });
        created.push(workspace);
        return workspace;
      };
      // The H-6 two-directory protocol over the first query in two fresh,
      // never-built directories: byte-identical outputs, and byte-identical
      // written files — the refresh's graph data included (SPEC 13.3, 12.0:
      // no absolute paths or environment leakage in stored data).
      const { firstWorkspace, secondWorkspace } =
        await assertAcrossDirectoriesDeterministic({
          makeWorkspace,
          binding: product,
          makeRun: (workspace) => ({
            cwd: workspace.root,
            argv: T11_7_PRIMARY,
          }),
          context:
            "T11-7 H-6 two-directory `query nodes --json` over fresh " +
            "workspaces (the graph-data refresh compared byte-for-byte)",
        });

      for (const command of T11_7_COMMANDS) {
        const context = `T11-7 \`${command.argv.join(" ")}\``;
        // Repeated runs in one directory: byte-identical outputs and
        // workspace byte state (H-6 run-twice form).
        const pair = await assertRunTwiceDeterministic({
          binding: product,
          run: { cwd: firstWorkspace.root, argv: command.argv },
          context: `${context} — repeated runs (H-6)`,
        });
        // The same command in the content-identical second directory:
        // byte-identical output (workspace-relative identities, SPEC 1.5).
        const inOtherDirectory = await runProduct(product, {
          cwd: secondWorkspace.root,
          argv: command.argv,
        });
        assertRunOutcomesEqual(
          inOtherDirectory,
          pair.first,
          `${context} — content-identical workspaces in different ` +
            `directories produce identical output (H-6, SPEC 12.0)`,
          "the run in directory 2",
          "the run in directory 1",
        );
        // Content check: the determinism protocols alone would accept a
        // product that deterministically reports nothing (H-8).
        assertExitCode(pair.first, 0, context);
        command.verify(parseJsonStdout(pair.first, context), context);
      }
    } finally {
      for (const workspace of created) {
        await workspace.dispose();
      }
    }
  },
});

/** TEST-SPEC §11, in canonical ID order (SUITE-40). */
export const section11Tests: readonly ProductTestEntry[] = [
  T11_1,
  T11_2,
  T11_3,
  T11_4,
  T11_5,
  T11_6,
  T11_7,
];
