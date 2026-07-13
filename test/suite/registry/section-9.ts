// TEST-SPEC §9 through §9.2 (impact analysis: baseline plumbing, requirement
// categories, impacted code) — SUITE-31: T9-1, T9.1-1, T9.2-1…T9.2-5.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// Impacted-code evaluation (SPEC 9.2) runs over the impact edges of a code
// location — the union of its `references` and `embeds` edges in the baseline
// graph and in the current graph, identities mapped through the journal
// (6.3) — and a node present on only one side, added or deleted, counts as
// one whose subtreeHash and effectiveHash changed. Baselines are committed
// git sources only (no build output at the ref; HARNESS-01: pinned identities
// and timestamps); the current side is the edited working tree, rebuilt
// (`build`, exit 0) before every `impact` run — the SUITE-20/22 protocol.
// Code locations here are whole files (SPEC 4.6): every marker and `text(...)`
// call sits at the top level of its `src/*.ts` file, enclosed by no named
// code unit.
//
// Conservative operationalizations (noted per H-4):
// - Impacted-code entries are asserted whole ({location, edge, path}) and
//   compared as sorted sets per group: SPEC 9.3 gives each impacted location
//   one entry per code category, and in every fixture here the qualifying
//   edge and its shortest witness path are unique, so the entry content is
//   spec-fixed; the order of entries within a group is not asserted (SPEC 9.3
//   fixes the grouping; T12.0-7 owns ordering determinism).
// - The witness edge is asserted with `from` equal to the reported location:
//   a location's impact edges are its own `references`/`embeds` edges
//   (SPEC 9.2), and the reported edge is the one targeting the chosen path's
//   first node (9.3), so it runs from the location itself.
// - Requirement-level entries are T9.1-1's and T5.6-*'s business; the T9.2-*
//   bodies assert the code groups only.
// - T9-1's no-difference arms assert the empty report through the suite's
//   fixed T1.5-1 convention (SPEC 9.3 groups output by category, so an
//   uncategorized node appears under none — `requirements` empty) plus empty
//   code groups. Its human (non-`--json`) runs assert exit 0 (impact is
//   informational, SPEC 9.3) and, with differences present, that the report
//   on stdout mentions the changed node's identity (12.0: reports are
//   standard-output content; H-3 robust matching, never wording).

import * as fsp from "node:fs/promises";
import type {
  ImpactReport,
  ImpactedCodeEntry,
} from "../../helpers/adapters/index.js";
import { assertReportMentions } from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  SPECS_ONLY_CONFIG,
  assertImpactCategories,
  impactAgainst,
  workedExample,
  workedExampleLeafEditExpectations,
} from "./section-5.6.js";
import { assertSameJson, buildOk, expectExit } from "./support.js";

// One spec group plus one code group (SPEC 7.2) for the impacted-code
// fixtures of T9.2-*.
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
 * Assert both impacted-code groups against their complete expected entry
 * sets (module header, H-4): each group must hold exactly the expected
 * entries — location, witness edge ({from, to, kind}), and witness path all
 * equal — compared order-insensitively via a canonical rendering (SPEC 9.2,
 * 9.3). A location missing from a group, present in the wrong group,
 * duplicated, or reported with a different edge or path is diagnosed.
 */
function assertImpactedCode(
  report: ImpactReport,
  expected: {
    readonly direct: readonly ImpactedCodeEntry[];
    readonly transitive: readonly ImpactedCodeEntry[];
  },
  context: string,
): void {
  const render = (entries: readonly ImpactedCodeEntry[]): string[] =>
    entries
      .map((entry) =>
        JSON.stringify({
          location: entry.location,
          edge: {
            from: entry.edge.from,
            to: entry.edge.to,
            kind: entry.edge.kind,
          },
          path: entry.path,
        }),
      )
      .sort();
  for (const group of ["direct", "transitive"] as const) {
    assertSameJson(
      render(report.code[group]),
      render(expected[group]),
      `${context}: the ${group === "direct" ? "directly" : "transitively"} ` +
        `impacted code group must hold exactly the expected entries — each ` +
        `impacted location once, with the one qualifying witness edge and ` +
        `the one shortest propagation path, both unique in this fixture ` +
        `(SPEC 9.2, 9.3)`,
    );
  }
}

/**
 * Read a workspace source file as UTF-8 text, failing diagnosed (H-8) when
 * the path does not hold a plain file.
 */
async function readSourceText(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<string> {
  const kind = await workspace.kind(rel);
  if (kind !== "file") {
    fail(`${context}: expected a plain file at ${rel}; found ${kind}`);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    await workspace.readBytes(rel),
  );
}

// ---------------------------------------------------------------------------
// T9-1 — baseline plumbing
// ---------------------------------------------------------------------------

// Two sibling sections in one file: `alpha` is the edited node, `beta` the
// untouched control. The file root is `alpha`'s ancestor.
const P1_MAIN = "specs/Main.mdx";
const P1_ALPHA = "specs/Main.mdx#alpha";
const P1_BETA = "specs/Main.mdx#beta";

const p1Source = (alphaText: string): string =>
  [
    '<S id="alpha">',
    alphaText,
    "</S>",
    "",
    '<S id="beta">',
    "Beta text.",
    "</S>",
    "",
  ].join("\n");

const T9_1 = defineProductTest({
  id: "T9-1",
  title:
    "baseline plumbing: `impact --base <ref>` on a git fixture reconstructs the baseline at the ref (6.3) and exits 0 with differences and without (informational); `--json` is available — the empty report before any edit (commit hash and symbolic ref alike), the edited node's `changed` entry with its cascade after (SPEC 9, 9.3, 6.3, 12.0)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [P1_MAIN]: p1Source("Alpha text v1.") },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await buildOk(
          product,
          workspace,
          "T9-1 `build` over the staged workspace",
        );

        // Without differences: exit 0 both plain and under --json, and the
        // JSON report is empty (no node carries a category, no code group is
        // configured).
        await expectExit(
          product,
          workspace,
          ["impact", "--base", base],
          0,
          "T9-1 `impact --base <hash>` with no differences — impact is " +
            "informational and exits 0 whether or not differences exist " +
            "(SPEC 9.3)",
        );
        const emptyLabel =
          "T9-1 `impact --base <hash> --json` with no differences";
        const empty = await impactAgainst(product, workspace, base, emptyLabel);
        assertSameJson(
          empty.requirements,
          [],
          `${emptyLabel}: the working tree's sources equal the baseline ` +
            `ref's, so no node receives any category and the requirements ` +
            `list is empty (SPEC 5.6, 9.1; the T1.5-1 convention)`,
        );
        assertSameJson(
          empty.code,
          { direct: [], transitive: [] },
          `${emptyLabel}: no code groups are configured, so no code location ` +
            `is impacted (SPEC 9.2)`,
        );

        // Symbolic ref: HEAD names the same baseline commit (SPEC 9 takes a
        // git ref, not only a hash).
        const headLabel =
          "T9-1 `impact --base HEAD --json` (symbolic ref) with no differences";
        const viaHead = await impactAgainst(
          product,
          workspace,
          "HEAD",
          headLabel,
        );
        assertSameJson(
          viaHead.requirements,
          [],
          `${headLabel}: HEAD resolves to the same commit as the hash, so ` +
            `the report is equally empty (SPEC 9, 6.3)`,
        );
        assertSameJson(
          viaHead.code,
          { direct: [], transitive: [] },
          `${headLabel}: no code groups are configured (SPEC 9.2)`,
        );

        // With differences: still exit 0; the human report carries the
        // changed node's identity, and the JSON report the 5.6 categories —
        // the difference is computed against the ref's content, not the
        // working tree (SPEC 6.3).
        await workspace.file(P1_MAIN, p1Source("Alpha text v2."));
        await buildOk(
          product,
          workspace,
          "T9-1 `build` over the edited workspace",
        );
        const plain = await expectExit(
          product,
          workspace,
          ["impact", "--base", base],
          0,
          "T9-1 `impact --base <hash>` with differences — informational, " +
            "exit 0 (SPEC 9.3)",
        );
        assertReportMentions(
          plain,
          [P1_ALPHA],
          "T9-1 human `impact` report with differences: the report must " +
            "mention the changed node's identity (SPEC 9.3; 12.0: the report " +
            "is standard-output content; H-3 robust matching)",
        );
        const diffLabel = "T9-1 `impact --base <hash> --json` with differences";
        assertImpactCategories(
          await impactAgainst(product, workspace, base, diffLabel),
          [
            {
              identity: P1_ALPHA,
              categories: [{ category: "changed", within: [P1_ALPHA] }],
            },
            {
              identity: P1_MAIN,
              categories: [
                { category: "descendant-changed", exact: [P1_ALPHA] },
              ],
            },
            { identity: P1_BETA, categories: [] },
          ],
          diffLabel,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.1-1 — categories equal 5.6 (fixtures shared with T5.6-*)
// ---------------------------------------------------------------------------

const T9_1_1 = defineProductTest({
  id: "T9.1-1",
  title:
    "categories: requirement-level `impact` output equals the categories and attributions of 5.6, over fixtures shared with T5.6-* — the worked-example leaf edit (changed / descendant-changed / upstream-changed with exact attribution) against one baseline, then a `d`-target edit on the same fixture (metadata-changed with its upstream cascade attributed to D) against a second (SPEC 9.1, 5.6)",
  run: async (product) => {
    const wx = workedExample;
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [wx.treeFile]: wx.treeSource("Leaf text v1."),
        [wx.depsFile]: wx.depsSource("Tree.top.mid"),
      },
      async (workspace) => {
        await workspace.gitInit();
        const leafBase = await workspace.gitCommitAll("baseline");

        // Arm A's edit is committed as arm B's baseline before any build, so
        // both baselines hold sources only (the T5.6-4 pattern).
        await workspace.file(wx.treeFile, wx.treeSource("Leaf text v2."));
        const dBase = await workspace.gitCommitAll("leaf edited");
        await buildOk(
          product,
          workspace,
          "T9.1-1 `build` over the leaf-edited workspace",
        );

        // Arm A: the worked example's leaf edit — the categories and
        // attributions of SPEC 5.6's own example, the table shared with
        // T5.6-1.
        const leafLabel =
          "T9.1-1 `impact --base <baseline> --json` after the leaf edit " +
          "(fixture and expectation table shared with T5.6-1)";
        assertImpactCategories(
          await impactAgainst(product, workspace, leafBase, leafLabel),
          workedExampleLeafEditExpectations(),
          leafLabel,
        );

        // Arm B: onmid.dep's `d` list gains Tree.top.other on the same
        // fixture. D is `metadata-changed`; no node is `changed` or
        // `descendant-changed`; D's ancestors are `upstream-changed`
        // attributed to D; the gained target and the whole tree side stay
        // uncategorized (SPEC 5.6's d-target example).
        await workspace.file(
          wx.depsFile,
          wx.depsSource("[Tree.top.mid, Tree.top.other]"),
        );
        await buildOk(
          product,
          workspace,
          "T9.1-1 `build` over the d-target-edited workspace",
        );
        const ids = wx.identities;
        const dLabel =
          "T9.1-1 `impact --base <leaf-edited> --json` after the d-target " +
          "edit on the shared fixture";
        assertImpactCategories(
          await impactAgainst(product, workspace, dBase, dLabel),
          [
            // The one originating node: its `d` target set changed. Its own
            // edge additions are excluded from `upstream-changed` ("other
            // than the node itself", SPEC 5.6).
            {
              identity: ids.onmidDep,
              categories: [
                { category: "metadata-changed", within: [ids.onmidDep] },
              ],
            },
            // D's ancestors: `upstream-changed` attributed to D.
            {
              identity: ids.onmid,
              categories: [
                { category: "upstream-changed", exact: [ids.onmidDep] },
              ],
            },
            {
              identity: ids.deps,
              categories: [
                { category: "upstream-changed", exact: [ids.onmidDep] },
              ],
            },
            // The sibling holder subtree is untouched.
            { identity: ids.onleaf, categories: [] },
            { identity: ids.onleafDep, categories: [] },
            // The gained target only receives a new incoming edge — no
            // category — and the whole tree side is unchanged since arm B's
            // baseline.
            { identity: ids.tree, categories: [] },
            { identity: ids.top, categories: [] },
            { identity: ids.mid, categories: [] },
            { identity: ids.leaf, categories: [] },
            { identity: ids.sib, categories: [] },
            { identity: ids.sibInner, categories: [] },
            { identity: ids.other, categories: [] },
          ],
          dLabel,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.2-1 — directly impacted
// ---------------------------------------------------------------------------

// Four arms, one code location each (whole files, SPEC 4.6):
// - src/refs.ts: `references` marker to `ed`, whose own text is edited;
// - src/embeds.ts: `text(...)` embeds edge to `em`, whose descendant is
//   edited (em's subtreeHash changes, its ownHash does not);
// - src/dropped.ts: at the baseline, a marker to `doom`; currently both the
//   marker and the node are deleted — the impact edge exists only in the
//   baseline graph, and the deleted node counts as changed in both hashes;
// - src/added.ts: absent at the baseline; currently a marker to the equally
//   new `fresh` — the impact edge exists only in the current graph, and the
//   added node counts as changed in both hashes.
const C1_EDITED = "specs/Edited.mdx";
const C1_ED = "specs/Edited.mdx#ed";
const C1_EMBED = "specs/Embed.mdx";
const C1_EM = "specs/Embed.mdx#em";
const C1_EM_KID = "specs/Embed.mdx#em.kid";
const C1_DOOMED = "specs/Doomed.mdx";
const C1_DOOM = "specs/Doomed.mdx#doom";
const C1_FRESH = "specs/Fresh.mdx";
const C1_FRESH_NODE = "specs/Fresh.mdx#fresh";
const C1_REFS_TS = "src/refs.ts";
const C1_EMBEDS_TS = "src/embeds.ts";
const C1_DROPPED_TS = "src/dropped.ts";
const C1_ADDED_TS = "src/added.ts";

const c1EditedSource = (text: string): string =>
  ['<S id="ed">', text, "</S>", ""].join("\n");
const c1EmbedSource = (kidText: string): string =>
  [
    '<S id="em">',
    "Embed parent text.",
    "",
    '<S id="em.kid">',
    kidText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
const C1_DOOMED_SOURCE = [
  '<S id="doom">',
  "Doomed node text.",
  "</S>",
  "",
].join("\n");
const C1_FRESH_SOURCE = ['<S id="fresh">', "Fresh node text.", "</S>", ""].join(
  "\n",
);
const C1_REFS_TS_SOURCE = [
  'import ED from "../specs/Edited.xspec";',
  "",
  "ED.ed;",
  "",
].join("\n");
const C1_EMBEDS_TS_SOURCE = [
  'import EM, { text } from "../specs/Embed.xspec";',
  "",
  "text(EM.em);",
  "",
].join("\n");
const C1_DROPPED_TS_BASELINE = [
  'import DOOM from "../specs/Doomed.xspec";',
  "",
  "DOOM.doom;",
  "",
].join("\n");
const C1_DROPPED_TS_CURRENT = ["export const droppedMarker = true;", ""].join(
  "\n",
);
const C1_ADDED_TS_SOURCE = [
  'import FRESH from "../specs/Fresh.xspec";',
  "",
  "FRESH.fresh;",
  "",
].join("\n");

const T9_2_1 = defineProductTest({
  id: "T9.2-1",
  title:
    "directly impacted: a code location with an impact edge (in either graph) to a node whose subtreeHash changed is directly impacted — a `references` edge to an edited node, an `embeds` edge to a node with an edited descendant, an edge present only in the baseline (marker deleted, node deleted), and an edge present only in the current graph (marker added, node added); added/deleted nodes count as changed in both hashes, and none of these locations is transitively impacted (SPEC 9.2, 9.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [C1_EDITED]: c1EditedSource("Edited node text v1."),
        [C1_EMBED]: c1EmbedSource("Embedded kid text v1."),
        [C1_DOOMED]: C1_DOOMED_SOURCE,
        [C1_REFS_TS]: C1_REFS_TS_SOURCE,
        [C1_EMBEDS_TS]: C1_EMBEDS_TS_SOURCE,
        [C1_DROPPED_TS]: C1_DROPPED_TS_BASELINE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");

        await workspace.file(C1_EDITED, c1EditedSource("Edited node text v2."));
        await workspace.file(C1_EMBED, c1EmbedSource("Embedded kid text v2."));
        await fsp.rm(workspace.path(C1_DOOMED));
        await workspace.file(C1_DROPPED_TS, C1_DROPPED_TS_CURRENT);
        await workspace.file(C1_FRESH, C1_FRESH_SOURCE);
        await workspace.file(C1_ADDED_TS, C1_ADDED_TS_SOURCE);
        await buildOk(
          product,
          workspace,
          "T9.2-1 `build` over the edited workspace",
        );

        const label = "T9.2-1 `impact --base <baseline> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, label),
          {
            direct: [
              // The edited target itself: single-node path (SPEC 9.3).
              {
                location: C1_REFS_TS,
                edge: { from: C1_REFS_TS, to: C1_ED, kind: "references" },
                path: [C1_ED],
              },
              // The embeds target's descendant was edited: the target's
              // subtreeHash changed, so the location is directly impacted,
              // with the all-`contains` path down to the edited child.
              {
                location: C1_EMBEDS_TS,
                edge: { from: C1_EMBEDS_TS, to: C1_EM, kind: "embeds" },
                path: [C1_EM, C1_EM_KID],
              },
              // Edge only in the baseline graph; the deleted node counts as
              // changed in both hashes (SPEC 9.2): single-node path.
              {
                location: C1_DROPPED_TS,
                edge: { from: C1_DROPPED_TS, to: C1_DOOM, kind: "references" },
                path: [C1_DOOM],
              },
              // Edge only in the current graph; the added node counts as
              // changed in both hashes (SPEC 9.2): single-node path.
              {
                location: C1_ADDED_TS,
                edge: {
                  from: C1_ADDED_TS,
                  to: C1_FRESH_NODE,
                  kind: "references",
                },
                path: [C1_FRESH_NODE],
              },
            ],
            // Every impact edge above targets a node whose subtreeHash
            // changed, so no location qualifies as transitively impacted
            // (SPEC 9.2: effectiveHash changed but subtreeHash did not).
            transitive: [],
          },
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.2-2 — transitively impacted
// ---------------------------------------------------------------------------

// src/app.ts holds a marker to `tgt`, which depends on `up` in another file;
// only `up`'s text is edited. `tgt`'s effectiveHash changes through the
// dependency while its subtreeHash stays put, so the location is transitively
// impacted — and not directly.
const C2_DOWN = "specs/Down.mdx";
const C2_TGT = "specs/Down.mdx#tgt";
const C2_UP = "specs/Up.mdx";
const C2_UP_NODE = "specs/Up.mdx#up";
const C2_APP_TS = "src/app.ts";

const c2UpSource = (text: string): string =>
  ['<S id="up">', text, "</S>", ""].join("\n");
const C2_DOWN_SOURCE = [
  'import Up from "./Up.xspec"',
  "",
  '<S id="tgt" d={Up.up}>',
  "Target text with an upstream dependency.",
  "</S>",
  "",
].join("\n");
const C2_APP_TS_SOURCE = [
  'import DOWN from "../specs/Down.xspec";',
  "",
  "DOWN.tgt;",
  "",
].join("\n");

const T9_2_2 = defineProductTest({
  id: "T9.2-2",
  title:
    "transitively impacted: a location whose impact-edge target changed only in effectiveHash (upstream dependency edit) is transitively impacted, not directly — the directly impacted group is empty and the transitive witness path runs from the target through the dependency edge to the edited upstream node (SPEC 9.2, 9.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [C2_DOWN]: C2_DOWN_SOURCE,
        [C2_UP]: c2UpSource("Upstream text v1."),
        [C2_APP_TS]: C2_APP_TS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");

        await workspace.file(C2_UP, c2UpSource("Upstream text v2."));
        await buildOk(
          product,
          workspace,
          "T9.2-2 `build` over the upstream-edited workspace",
        );

        const label = "T9.2-2 `impact --base <baseline> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, label),
          {
            // `tgt`'s subtreeHash did not change (a dependency target's text
            // is no part of its own content, SPEC 5.5), so the location is
            // not directly impacted.
            direct: [],
            transitive: [
              {
                location: C2_APP_TS,
                edge: { from: C2_APP_TS, to: C2_TGT, kind: "references" },
                // Every node on a transitive path has changed effectiveHash;
                // the path ends at the node whose own edit explains the
                // change (SPEC 9.3).
                path: [C2_TGT, C2_UP_NODE],
              },
            ],
          },
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.2-3 — deleted code location
// ---------------------------------------------------------------------------

const C3_MAIN = "specs/Main.mdx";
const C3_N = "specs/Main.mdx#n";
const C3_GONE_TS = "src/gone.ts";

const c3Source = (text: string): string =>
  ['<S id="n">', text, "</S>", ""].join("\n");
const C3_GONE_TS_SOURCE = [
  'import M from "../specs/Main.xspec";',
  "",
  "M.n;",
  "",
].join("\n");

const T9_2_3 = defineProductTest({
  id: "T9.2-3",
  title:
    "deleted code location: a code location absent from the current graph (its file deleted) is reported under its baseline identity — its baseline impact edge to the since-edited node makes it directly impacted (SPEC 9.2, 9.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [C3_MAIN]: c3Source("Node text v1."),
        [C3_GONE_TS]: C3_GONE_TS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");

        await workspace.file(C3_MAIN, c3Source("Node text v2."));
        await fsp.rm(workspace.path(C3_GONE_TS));
        await buildOk(
          product,
          workspace,
          "T9.2-3 `build` over the workspace with the code file deleted",
        );

        const label = "T9.2-3 `impact --base <baseline> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, label),
          {
            direct: [
              {
                // The location exists only in the baseline graph; it is
                // reported under its baseline identity (SPEC 9.2).
                location: C3_GONE_TS,
                edge: { from: C3_GONE_TS, to: C3_N, kind: "references" },
                path: [C3_N],
              },
            ],
            transitive: [],
          },
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.2-4 — category independence
// ---------------------------------------------------------------------------

// One location, two impact edges: one to `dt` (subtreeHash changed through
// its edited child), one to `tt` (effectiveHash alone changed through the
// edited upstream `up`). The location appears in both groups, each entry's
// edge and path minimized per category (SPEC 9.3).
const C4_DIRECT = "specs/Direct.mdx";
const C4_DT = "specs/Direct.mdx#dt";
const C4_DT_KID = "specs/Direct.mdx#dt.kid";
const C4_TRANS = "specs/Trans.mdx";
const C4_TT = "specs/Trans.mdx#tt";
const C4_UP = "specs/Up.mdx";
const C4_UP_NODE = "specs/Up.mdx#up";
const C4_BOTH_TS = "src/both.ts";

const c4DirectSource = (kidText: string): string =>
  [
    '<S id="dt">',
    "Direct target text.",
    "",
    '<S id="dt.kid">',
    kidText,
    "</S>",
    "</S>",
    "",
  ].join("\n");
const C4_TRANS_SOURCE = [
  'import Up from "./Up.xspec"',
  "",
  '<S id="tt" d={Up.up}>',
  "Transitive target text.",
  "</S>",
  "",
].join("\n");
const c4UpSource = (text: string): string =>
  ['<S id="up">', text, "</S>", ""].join("\n");
const C4_BOTH_TS_SOURCE = [
  'import DIRECT from "../specs/Direct.xspec";',
  'import TRANS from "../specs/Trans.xspec";',
  "",
  "DIRECT.dt;",
  "TRANS.tt;",
  "",
].join("\n");

const T9_2_4 = defineProductTest({
  id: "T9.2-4",
  title:
    "category independence: one code location with two impact edges — one to a node whose subtreeHash changed, one to a node whose effectiveHash alone changed — appears in both the directly and the transitively impacted group, each entry's edge and path minimized per category: the direct entry reports the subtree-changed target's edge with its all-`contains` path, the transitive entry the other edge with its effectiveHash path (SPEC 9.2, 9.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [C4_DIRECT]: c4DirectSource("Direct kid text v1."),
        [C4_TRANS]: C4_TRANS_SOURCE,
        [C4_UP]: c4UpSource("Upstream text v1."),
        [C4_BOTH_TS]: C4_BOTH_TS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");

        await workspace.file(C4_DIRECT, c4DirectSource("Direct kid text v2."));
        await workspace.file(C4_UP, c4UpSource("Upstream text v2."));
        await buildOk(
          product,
          workspace,
          "T9.2-4 `build` over the doubly-edited workspace",
        );

        const label = "T9.2-4 `impact --base <baseline> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, label),
          {
            direct: [
              {
                location: C4_BOTH_TS,
                // Only the edge to `dt` qualifies for the direct category
                // (`tt`'s subtreeHash is unchanged); its qualifying path is
                // all-`contains`, ending at the edited child.
                edge: { from: C4_BOTH_TS, to: C4_DT, kind: "references" },
                path: [C4_DT, C4_DT_KID],
              },
            ],
            transitive: [
              {
                location: C4_BOTH_TS,
                // Only the edge to `tt` qualifies for the transitive
                // category (`dt`'s subtreeHash changed); its path follows
                // changed effectiveHashes to the edited upstream node.
                edge: { from: C4_BOTH_TS, to: C4_TT, kind: "references" },
                path: [C4_TT, C4_UP_NODE],
              },
            ],
          },
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T9.2-5 — impact edges mapped through the journal
// ---------------------------------------------------------------------------

const C5_SPEC = "specs/Spec.mdx";
const C5_BETA = "specs/Spec.mdx#beta";
const C5_APP_TS = "src/app.ts";

const c5Source = (text: string): string =>
  ['<S id="alpha">', text, "</S>", ""].join("\n");
const C5_APP_TS_SOURCE = [
  'import SPEC from "../specs/Spec.xspec";',
  "",
  "SPEC.alpha;",
  "",
].join("\n");

const T9_2_5 = defineProductTest({
  id: "T9.2-5",
  title:
    "impact edges mapped through the journal: after a journaled `rename alpha→beta` and a text edit to the renamed node, the code location whose marker was rewritten appears in the directly impacted group exactly once — its witness edge targeting the current identity `beta` with the single-node path — and not in the transitively impacted group: the baseline edge (old identity) and the current edge (new identity) unify into one impact edge to one changed node; the positive counterpart of T6.2-1's emptiness arm (SPEC 9.2, 9.3, 6.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [C5_SPEC]: c5Source("Renamed node text v1."),
        [C5_APP_TS]: C5_APP_TS_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-rename baseline");
        await buildOk(
          product,
          workspace,
          "T9.2-5 `build` over the staged workspace",
        );

        await expectExit(
          product,
          workspace,
          ["rename", "specs/Spec.mdx", "alpha", "beta"],
          0,
          "T9.2-5 `rename specs/Spec.mdx alpha beta`",
        );

        // Premise (crisp diagnosis ahead of the impact assertion): the
        // rename rewrote the code-side marker to the new identity (SPEC 6.4).
        const appText = await readSourceText(
          workspace,
          C5_APP_TS,
          "T9.2-5 rewrite premise",
        );
        if (appText.includes("alpha") || !appText.includes("beta")) {
          fail(
            `T9.2-5 rewrite premise: after the rename, ${C5_APP_TS} must ` +
              `reference the new identity (\`beta\`) and no longer spell the ` +
              `old one (\`alpha\`) — rename rewrites every reference across ` +
              `all configured spec and code sources (SPEC 6.4); got: ` +
              JSON.stringify(appText),
          );
        }

        // The real edit: the renamed node's own text run, applied to the
        // rewritten source (read-modify-write keeps the test independent of
        // the rename's exact byte-level rewrite, T6.4-2's business).
        const specText = await readSourceText(
          workspace,
          C5_SPEC,
          "T9.2-5 edit staging",
        );
        if (!specText.includes("Renamed node text v1.")) {
          fail(
            `T9.2-5 edit staging: the renamed source must still carry the ` +
              `node's text run ${JSON.stringify("Renamed node text v1.")} — ` +
              `rename rewrites identities and reference spellings only ` +
              `(SPEC 6.2, 6.4); got: ${JSON.stringify(specText)}`,
          );
        }
        await workspace.file(
          C5_SPEC,
          specText.replace("Renamed node text v1.", "Renamed node text v2."),
        );
        await buildOk(
          product,
          workspace,
          "T9.2-5 `build` over the post-rename edited workspace",
        );

        const label = "T9.2-5 `impact --base <pre-rename ref> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, label),
          {
            // Exactly one direct entry: the baseline edge (to old `alpha`,
            // mapped through the journal) and the current edge (to `beta`)
            // unify into one impact edge to one changed node (SPEC 9.2, 6.3).
            // A product that drops journal-mapped edges reports the location
            // unimpacted; one that treats the identities as a deletion plus
            // an addition reports a wrong target or a duplicate entry.
            direct: [
              {
                location: C5_APP_TS,
                edge: { from: C5_APP_TS, to: C5_BETA, kind: "references" },
                path: [C5_BETA],
              },
            ],
            transitive: [],
          },
          label,
        );
      },
    );
  },
});

/** TEST-SPEC §9 through §9.2, in canonical ID order (SUITE-31). */
export const section9Tests: readonly ProductTestEntry[] = [
  T9_1,
  T9_1_1,
  T9_2_1,
  T9_2_2,
  T9_2_3,
  T9_2_4,
  T9_2_5,
];
