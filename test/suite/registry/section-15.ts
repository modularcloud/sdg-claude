// TEST-SPEC §15 (example) — SUITE-50: T15-1, the canonical walkthrough over
// SPEC.md §15's exact workspace.
//
// Registered product-facing body (C-2 "one code path"): it builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// The fixture is SPEC.md §15's exact workspace — `specs/SPEC.mdx`,
// `specs/DERIVED.mdx`, `src/hello.ts`, byte for byte — plus a matching
// configuration (§15 shows none): the two spec files in their own spec groups
// so the coverage profile's required set is exactly `print.hello` (SPEC 8.1:
// default `targets: "leaves"` over the group holding SPEC.mdx), the code
// group named `src` (T15-1: "`src` as code boundary"), and one transitive
// coverage profile targeting `print.hello` with `src` as boundary
// (boundaryKind inferred — the name is unambiguous, SPEC 7.4).
//
// One integration test walks SPEC 15's narrative in one workspace:
// build → the six listed graph edges exactly → the satisfied coverage
// profile → the `print.hello` text edit with its categories, impacted code,
// and the default path-blocks session → the rename taken *instead* (the edit
// reverted to its exact baseline bytes first, so the rename runs against the
// same pre-rename baseline) with its journal mapping and no-change impact
// run.
//
// Conservative operationalizations (noted per H-3/H-4):
// - The six edges are the complete unfiltered `query edges` set, compared
//   order-insensitively (SPEC 5.2: edges of each kind form a set; SPEC 11).
// - "Satisfied via hello → derived.hello → print.hello" is the profile's
//   covered row for `print.hello` with exactly that path (unique in this
//   fixture: the location's one references edge, then the one depends edge),
//   an empty uncovered list, and `coverage --check` exiting 0 (SPEC 8.2:
//   1 iff any required node is uncovered).
// - The categories follow the SUITE-20 conventions: entries merged per node
//   identity; an uncategorized node appears in no entry (the T1.5-1
//   convention); the propagated categories' attribution is pinned to
//   `print.hello` (SPEC 15: "via print.hello"; SPEC 5.6's worked
//   single-leaf-edit example attributes the whole cascade to the leaf) and
//   the originating `changed` attribution is bounded within {print.hello}.
//   The impacted-code groups are asserted whole (SUITE-31): `hello.ts#hello`
//   transitively impacted — its one impact edge targets `derived.hello`,
//   whose effectiveHash alone changed — and no location directly impacted.
// - "A default path-blocks session" is created with `review create --base`
//   and no `--strategy` (SPEC 10.7); "exactly the four listed items" is the
//   exact kind+scope set, and "blocked by it" the parent-consistency item's
//   blockedBy = {the subtree-coherence item's id} with every other item's
//   blockedBy empty (SPEC 10.2: empty except where the strategy assigns;
//   10.5 assigns blockers only to parent-consistency items). Item payloads
//   in depth are T10.5-1's business.
// - "The journal records the mapping" sticks to SPEC 6.1's observable
//   contract (entry content is opaque, H-4): absent before the rename (the
//   file comes into existence with the first journaled operation; nothing
//   else may write it), a plain file with exactly one line-oriented entry
//   after it, and the mapping's effect — the pre-rename baseline's impact
//   run reports no changes because identities map through the journal
//   (SPEC 6.2, 6.3). A rewrite premise on DERIVED.mdx's reference spelling
//   (SPEC 6.4) fails a missing rewrite crisply ahead of the impact
//   assertion; byte-exact rewrites are T6.4-2's business.

import type { GraphEdge, ReviewItem } from "../../helpers/adapters/index.js";
import {
  decodeCoverageReport,
  decodeEdgesReport,
  decodeExportReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { assertRequirementCategories, impactAgainst } from "./section-5.6.js";
import { assertImpactedCode, readSourceText } from "./section-9.js";
import {
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
} from "./support.js";

// The matching configuration (module header): the profile targets exactly
// `print.hello`, with the code group `src` as its transitive boundary.
const WALKTHROUGH_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    spec: ["specs/SPEC.mdx"],
    derived: ["specs/DERIVED.mdx"]
  },
  code: {
    src: ["src/**/*.ts"]
  },
  coverage: [
    {
      name: "print-covered",
      target: "spec",
      boundary: "src",
      mode: "transitive"
    }
  ]
})
`;

// SPEC.md §15's exact sources. The hello leaf's text is parameterized for the
// walkthrough's edit and its byte-exact revert.
const SPEC_FILE = "specs/SPEC.mdx";
const DERIVED_FILE = "specs/DERIVED.mdx";
const CODE_FILE = "src/hello.ts";

const specSource = (helloText: string): string =>
  [
    '<S id="print">',
    "Print behavior.",
    "",
    '<S id="print.hello" tags="critical">',
    helloText,
    "</S>",
    "</S>",
    "",
  ].join("\n");

const DERIVED_SOURCE = [
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

const CODE_SOURCE = [
  'import DERIVED from "../specs/DERIVED.xspec"',
  "",
  "export function hello() {",
  "  DERIVED.derived.hello",
  '  console.log("Hello")',
  "}",
  "",
].join("\n");

const SPEC_ROOT = "specs/SPEC.mdx";
const PRINT = "specs/SPEC.mdx#print";
const HELLO = "specs/SPEC.mdx#print.hello";
const DERIVED_ROOT = "specs/DERIVED.mdx";
const DERIVED_NODE = "specs/DERIVED.mdx#derived";
const DERIVED_HELLO = "specs/DERIVED.mdx#derived.hello";
// The marker sits inside `export function hello()`, so the code location is
// the named unit `src/hello.ts#hello` (SPEC 4.6) — §15's "hello.ts#hello".
const LOCATION = "src/hello.ts#hello";

// SPEC 15's graph listing, verbatim (SPEC 5.2, 2.1, 2.2, 4.5, 4.6).
const SIX_EDGES: readonly GraphEdge[] = [
  { from: SPEC_ROOT, to: PRINT, kind: "contains" },
  { from: PRINT, to: HELLO, kind: "contains" },
  { from: DERIVED_ROOT, to: DERIVED_NODE, kind: "contains" },
  { from: DERIVED_NODE, to: DERIVED_HELLO, kind: "contains" },
  { from: DERIVED_HELLO, to: HELLO, kind: "depends" },
  { from: LOCATION, to: DERIVED_HELLO, kind: "references" },
];

const SESSION = "walkthrough";
const JOURNAL_PATH = ".xspec/journal";
const LF = 0x0a;

/**
 * Lines in a line-oriented file, tolerating a terminated or unterminated
 * final line (0 for an empty file) — the H-4 operationalization of SPEC 6.1's
 * "one entry per line" (the SUITE-21 convention).
 */
function journalLineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) {
    if (byte === LF) count += 1;
  }
  if (bytes[bytes.length - 1] !== LF) count += 1;
  return count;
}

/**
 * The unique full item for a kind and scope node in an exported item list,
 * diagnosed loudly when missing or duplicated (SPEC 10.5: a session never
 * contains two items with the same kind and scope node).
 */
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

const T15_1 = defineProductTest({
  id: "T15-1",
  title:
    "canonical walkthrough: SPEC 15's exact workspace (specs/SPEC.mdx, specs/DERIVED.mdx, src/hello.ts, matching configuration) — the six listed graph edges exactly; a transitive coverage profile targeting print.hello with `src` as code boundary satisfied via hello → derived.hello → print.hello; after editing print.hello's text the listed categories (print.hello changed; print and the SPEC root descendant-changed via print.hello; derived.hello, derived, and the DERIVED root upstream-changed; hello.ts#hello transitively impacted); a default path-blocks session containing exactly the four listed items; and after `xspec rename` of print.hello instead, a journal mapping plus an impact run against the pre-rename baseline reporting no changes (SPEC 15, 5.6, 8, 9.2, 9.3, 10.5, 6.1–6.4, 11)",
  timeoutMs: 240_000,
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": WALKTHROUGH_CONFIG,
        [SPEC_FILE]: specSource("Print hello."),
        [DERIVED_FILE]: DERIVED_SOURCE,
        [CODE_FILE]: CODE_SOURCE,
      },
    });
    try {
      await workspace.gitInit();
      const base = await workspace.gitCommitAll("baseline");
      await buildOk(
        product,
        workspace,
        "T15-1 `build` over SPEC 15's workspace",
      );

      // --- The six listed graph edges, exactly (SPEC 15, 11) ---------------
      const edgesLabel = "T15-1 `query edges --json`";
      assertEdgeSetEqual(
        decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--json"],
            edgesLabel,
          ),
          edgesLabel,
        ),
        SIX_EDGES,
        `${edgesLabel}: the complete edge set is exactly SPEC 15's six ` +
          `listed edges — the two files' four contains edges, ` +
          `derived.hello's depends edge to print.hello, and the code ` +
          `location's references edge from src/hello.ts#hello (SPEC 15, ` +
          `5.2, 4.6, 11)`,
      );

      // --- The satisfied transitive coverage profile (SPEC 15, 8) ----------
      const coverageLabel = "T15-1 `coverage --json`";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageLabel,
        ),
        coverageLabel,
      );
      const profile = coverage.profiles.find(
        (candidate) => candidate.name === "print-covered",
      );
      if (profile === undefined) {
        fail(
          `${coverageLabel}: the report must carry profile "print-covered" — ` +
            `all configured profiles run by default (SPEC 8.2); got profiles ` +
            JSON.stringify(
              coverage.profiles.map((candidate) => candidate.name),
            ),
        );
      }
      assertSameJson(
        profile.covered.map((row) => ({
          identity: row.identity,
          path: [...row.path],
        })),
        [{ identity: HELLO, path: [LOCATION, DERIVED_HELLO, HELLO] }],
        `${coverageLabel} profile print-covered: the profile's one required ` +
          `node print.hello is covered via exactly the path hello → ` +
          `derived.hello → print.hello — the location's references edge, ` +
          `then the depends edge (SPEC 15, 8, 8.2)`,
      );
      assertSameJson(
        [...profile.uncovered],
        [],
        `${coverageLabel} profile print-covered: no required node is ` +
          `uncovered — the profile is satisfied (SPEC 15, 8.1, 8.2)`,
      );
      await expectExit(
        product,
        workspace,
        ["coverage", "--check"],
        0,
        "T15-1 `coverage --check` — the profile is satisfied, so no " +
          "required node is uncovered and --check exits 0 (SPEC 8.2)",
      );

      // --- Editing print.hello's text: the listed categories (SPEC 15) -----
      await workspace.file(SPEC_FILE, specSource("Print hello, edited."));
      await buildOk(
        product,
        workspace,
        "T15-1 `build` after editing print.hello's text",
      );
      const impactLabel =
        "T15-1 `impact --base <baseline> --json` after the edit";
      const impact = await impactAgainst(product, workspace, base, impactLabel);
      assertRequirementCategories(
        impact,
        [
          // The edited leaf itself.
          {
            identity: HELLO,
            categories: [{ category: "changed", within: [HELLO] }],
          },
          // "print and the SPEC root are descendant-changed via print.hello".
          {
            identity: PRINT,
            categories: [{ category: "descendant-changed", exact: [HELLO] }],
          },
          {
            identity: SPEC_ROOT,
            categories: [{ category: "descendant-changed", exact: [HELLO] }],
          },
          // "derived.hello, derived, and the DERIVED root are
          // upstream-changed" — the single-leaf-edit cascade, all attributed
          // to the leaf (SPEC 5.6).
          {
            identity: DERIVED_HELLO,
            categories: [{ category: "upstream-changed", exact: [HELLO] }],
          },
          {
            identity: DERIVED_NODE,
            categories: [{ category: "upstream-changed", exact: [HELLO] }],
          },
          {
            identity: DERIVED_ROOT,
            categories: [{ category: "upstream-changed", exact: [HELLO] }],
          },
        ],
        impactLabel,
      );
      // "hello.ts#hello is transitively impacted": its one impact edge
      // targets derived.hello, whose effectiveHash changed while its
      // subtreeHash did not — so it is not directly impacted; the witness
      // path runs from the edge's target to the edited node (SPEC 9.2, 9.3).
      assertImpactedCode(
        impact,
        {
          direct: [],
          transitive: [
            {
              location: LOCATION,
              edge: { from: LOCATION, to: DERIVED_HELLO, kind: "references" },
              path: [DERIVED_HELLO, HELLO],
            },
          ],
        },
        impactLabel,
      );

      // --- The default path-blocks session: exactly the four items ---------
      await expectExit(
        product,
        workspace,
        ["review", "create", "--base", base, "--name", SESSION],
        0,
        "T15-1 `review create --base <baseline> --name walkthrough` — " +
          "path-blocks is the default strategy for baseline-based sessions " +
          "(SPEC 10.5, 10.7)",
      );
      const statusLabel = `T15-1 \`review status ${SESSION} --json\``;
      const status = decodeSessionStatusReport(
        await runJson(
          product,
          workspace,
          ["review", "status", SESSION, "--json"],
          statusLabel,
        ),
        statusLabel,
      );
      assertSameJson(
        status.items.map((row) => `${row.kind} ${row.scope}`).sort(),
        [
          `code-impact ${LOCATION}`,
          `dependency-consistency ${DERIVED_HELLO}`,
          `parent-consistency ${PRINT}`,
          `subtree-coherence ${HELLO}`,
        ].sort(),
        `${statusLabel}: SPEC 15 — "a default path-blocks session for this ` +
          `change contains exactly: a subtree-coherence item for ` +
          `print.hello, a parent-consistency item for print blocked by it, ` +
          `a dependency-consistency item for derived.hello, and a ` +
          `code-impact item for hello.ts#hello"`,
      );
      const exportLabel = `T15-1 \`review export ${SESSION} --json\``;
      const exported = decodeExportReport(
        await runJson(
          product,
          workspace,
          ["review", "export", SESSION, "--json"],
          exportLabel,
        ),
        exportLabel,
      );
      const sc = requireItem(
        exported.items,
        "subtree-coherence",
        HELLO,
        exportLabel,
      );
      const pc = requireItem(
        exported.items,
        "parent-consistency",
        PRINT,
        exportLabel,
      );
      const dc = requireItem(
        exported.items,
        "dependency-consistency",
        DERIVED_HELLO,
        exportLabel,
      );
      const ci = requireItem(
        exported.items,
        "code-impact",
        LOCATION,
        exportLabel,
      );
      assertSameJson(
        [...pc.blockedBy],
        [sc.id],
        `${exportLabel}: print's parent-consistency item is blocked by ` +
          `print.hello's subtree-coherence item — SPEC 15's "blocked by it" ` +
          `(SPEC 10.5)`,
      );
      for (const [item, label] of [
        [sc, "print.hello's subtree-coherence item"],
        [dc, "derived.hello's dependency-consistency item"],
        [ci, "hello.ts#hello's code-impact item"],
      ] as const) {
        assertSameJson(
          [...item.blockedBy],
          [],
          `${exportLabel}: ${label} carries no blockers — blockedBy is ` +
            `empty except where the strategy assigns it, and path-blocks ` +
            `assigns blockers only to parent-consistency items (SPEC 10.2, ` +
            `10.5)`,
        );
      }

      // --- The rename taken instead: journal mapping, no-change impact -----
      // "Instead": the edit is reverted to its exact baseline bytes, so the
      // rename operates on the workspace as committed at `base`.
      await workspace.file(SPEC_FILE, specSource("Print hello."));
      await buildOk(
        product,
        workspace,
        "T15-1 `build` after reverting the edit (the rename replaces it)",
      );
      const preRenameKind = await workspace.kind(JOURNAL_PATH);
      if (preRenameKind !== "absent") {
        fail(
          `T15-1: before the first journaled operation the journal file ` +
            `must not exist — it comes into existence with the first ` +
            `journaled operation and is written only by rename and move ` +
            `(SPEC 6.1); found ${preRenameKind} at ${JOURNAL_PATH}`,
        );
      }
      await expectExit(
        product,
        workspace,
        ["rename", "specs/SPEC.mdx", "print.hello", "print.greet"],
        0,
        "T15-1 `rename specs/SPEC.mdx print.hello print.greet`",
      );
      const journalKind = await workspace.kind(JOURNAL_PATH);
      if (journalKind !== "file") {
        fail(
          `T15-1: the rename must record its mapping in the journal — a ` +
            `plain file at ${JOURNAL_PATH} after the first journaled ` +
            `operation (SPEC 6.1, 6.4, 13.4); found ${journalKind}`,
        );
      }
      const journal = await workspace.readBytes(JOURNAL_PATH);
      const journalLines = journalLineCount(journal);
      if (journal.length === 0 || journalLines !== 1) {
        fail(
          `T15-1: after the one journaled rename the journal must hold ` +
            `exactly one line-oriented entry — one self-contained record of ` +
            `the operation and the identity mapping it produced (SPEC 6.1); ` +
            `found ${String(journalLines)} line(s) in ` +
            `${String(journal.length)} bytes`,
        );
      }
      // Rewrite premise (crisp diagnosis ahead of the impact assertion): the
      // rename rewrote DERIVED.mdx's d reference to the new identity
      // (SPEC 6.4).
      const derivedText = await readSourceText(
        workspace,
        DERIVED_FILE,
        "T15-1 rewrite premise",
      );
      if (
        derivedText.includes("print.hello") ||
        !derivedText.includes("print.greet")
      ) {
        fail(
          `T15-1 rewrite premise: after the rename, ${DERIVED_FILE} must ` +
            `reference the new identity (print.greet) and no longer spell ` +
            `the old one (print.hello) — rename rewrites every reference ` +
            `across all configured spec and code sources (SPEC 6.4); got: ` +
            JSON.stringify(derivedText),
        );
      }
      const renameLabel =
        "T15-1 `impact --base <pre-rename baseline> --json` after the rename";
      const renameImpact = await impactAgainst(
        product,
        workspace,
        base,
        renameLabel,
      );
      assertSameJson(
        renameImpact.requirements,
        [],
        `${renameLabel}: a journaled rename is pure — the journal mapping ` +
          `carries every identity across, every hash is byte-identical, so ` +
          `no node receives any category and the requirements list is empty ` +
          `(SPEC 15, 6.1–6.3, 9.1; the T1.5-1 convention)`,
      );
      assertSameJson(
        renameImpact.code,
        { direct: [], transitive: [] },
        `${renameLabel}: no code location is impacted — the location's ` +
          `baseline and current impact edges unify through the journal ` +
          `(SPEC 15, 6.3, 9.2)`,
      );
    } finally {
      await workspace.dispose();
    }
  },
});

/** TEST-SPEC §15, in canonical ID order (SUITE-50). */
export const section15ExampleTests: readonly ProductTestEntry[] = [T15_1];
