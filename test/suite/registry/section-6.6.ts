// TEST-SPEC §6.6 (manual restructuring) — SUITE-24: T6.6-1.
//
// Registered product-facing body (C-2 "one code path"): it builds its own
// fresh workspaces (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 6.6: renames or moves performed by editing files directly, without the
// commands, produce no journal entries and are treated as deletions plus
// additions. The manually renamed node's text is kept byte-identical across
// the edit, so a product inferring continuity (journaling the edit, or
// mapping the old identity onto the new one) is maximally tempted — and
// diagnosed by the journal and impact assertions.
//
// Conservative operationalizations (noted per H-4):
// - "No journal entry" is realized through SPEC 6.1's strongest observable:
//   the journal file comes into existence with the first journaled operation,
//   and a manual edit is none — so `.xspec/journal` is asserted absent after
//   the direct edit and after every subsequent command (successful and
//   failing `build`s, `impact`).
// - "A deletion plus an addition (not continuity)" is asserted as the
//   complete per-node impact table of the fixture, in the SUITE-20
//   conventions: entries merged per node identity (SPEC 9.3 fixes the
//   grouping, not the adapter-level granularity); an uncategorized, undeleted
//   node has no requirement entry (the T1.5-1 convention); the old identity
//   reports as deleted and `changed` only, the new one as added — `changed`
//   only, not deleted (SPEC 5.6's added/deleted convention); the propagated
//   `descendant-changed` attributions are pinned exactly per T5.6-2's
//   precedent (the parent to the added and the removed child; the file root
//   to the parent and both children); the originating category `changed` is
//   attribution-bounded by the originating-node set, the empty list accepted.
//   A product treating the edit as continuity reports no categories at all —
//   or maps the vacated identity forward — and fails the table.
// - The 14.5 findings are located within the reference-bearing opening tag's
//   byte window (the T2.4-4 operationalization for unresolved-`d` findings).

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
import {
  assertConditionCounts,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  byteWindow,
  expectExit,
} from "./support.js";

// Exactly one spec group (SPEC 7). No code groups exist in these fixtures, so
// no code location can be impacted.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

const JOURNAL_PATH = ".xspec/journal";

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
 * Assert the journal file does not exist (SPEC 6.6, 6.1): manual
 * restructuring is never journaled, and the file comes into existence only
 * with the first journaled `rename`/`move` — so after direct edits and the
 * commands run on them, nothing may occupy `.xspec/journal`.
 */
async function assertNoJournal(
  workspace: TestWorkspace,
  moment: string,
  context: string,
): Promise<void> {
  const kind = await workspace.kind(JOURNAL_PATH);
  if (kind !== "absent") {
    fail(
      `${context}: ${moment}, ${JOURNAL_PATH} holds a ${kind} — a rename ` +
        `performed by editing the file directly produces no journal entry, ` +
        `and the journal file comes into existence only with the first ` +
        `journaled operation (SPEC 6.6, 6.1)`,
    );
  }
}

/**
 * `impact --base <ref> --json`: exit 0 (impact is informational, SPEC 9.3;
 * H-5) with exactly one JSON document, decoded as the impact report (H-3).
 */
async function impactAgainst(
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
interface ExpectedCategory {
  readonly category: ChangeCategory;
  /** Attribution pinned exactly. Exactly one of `exact`/`within`. */
  readonly exact?: readonly string[];
  /** Attribution bounded: the merged `attributedTo` must be a subset. */
  readonly within?: readonly string[];
}

/** The complete expectation for one node identity of the fixture. */
interface ExpectedNodeImpact {
  /** Current identity; the baseline identity for the deleted node. */
  readonly identity: string;
  /** Whether entries naming the node must flag it deleted (default false). */
  readonly deleted?: boolean;
  /** The node's exact category set; empty = must receive no category. */
  readonly categories: readonly ExpectedCategory[];
}

/**
 * Assert an impact report's requirement-level content against the complete
 * per-node expectation table of the fixture (SPEC 5.6, 6.6, 9.1, 9.3) — the
 * SUITE-20 conventions restated in the module header.
 */
function assertImpactTable(
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
    for (const category of expectation.categories) {
      if ((category.exact === undefined) === (category.within === undefined)) {
        throw new Error(
          `fixture bug: category ${category.category} of ` +
            `${expectation.identity} must declare exactly one of exact/within`,
        );
      }
    }
    expectedBy.set(expectation.identity, expectation);
  }

  // Merge the report per node identity (SPEC 9.3 fixes the grouping, not the
  // adapter-level entry granularity — the SUITE-20 convention).
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
          `${context}: the report names ${JSON.stringify(identity)}, which is ` +
            `no current node of the fixture and no staged deleted identity ` +
            `(in the workspace-relative identity form of SPEC 1.5); ` +
            `entry: ${JSON.stringify(entry)}`,
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
          `${context}: ${expected.identity} must receive no category ` +
            `(SPEC 5.6) and so appear in no requirement entry (SPEC 9.3 ` +
            `groups output by category; the T1.5-1 convention), but the ` +
            `report names it with categories ` +
            `${JSON.stringify([...merged.attributions.keys()].sort())}`,
        );
      }
      continue;
    }
    if (merged === undefined) {
      fail(
        `${context}: ${expected.identity} must carry exactly the categories ` +
          `${JSON.stringify(expectedNames)} — a manual rename is a deletion ` +
          `plus an addition, never continuity (SPEC 6.6, 5.6) — but no ` +
          `requirement entry names it`,
      );
    }

    const expectedDeleted = expected.deleted ?? false;
    for (const flag of merged.deletedFlags) {
      if (flag !== expectedDeleted) {
        fail(
          `${context}: ${expected.identity} must be reported ` +
            `${expectedDeleted ? "as deleted, under its baseline identity" : "as present, not deleted"} ` +
            `(SPEC 6.6, 5.6, 9.3); an entry naming it has deleted: ${String(flag)}`,
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
          `${context}: the ${category.category} category of ` +
            `${expected.identity} must be attributed to exactly its ` +
            `originating node(s) (SPEC 5.6, 9.1)`,
        );
      } else {
        for (const identity of attributed) {
          if (!category.within?.includes(identity)) {
            fail(
              `${context}: the ${category.category} category of ` +
                `${expected.identity} is attributed to ` +
                `${JSON.stringify(identity)}, which is no originating node ` +
                `of this change (SPEC 5.6: every category is attributed to ` +
                `its originating nodes); originating nodes: ` +
                JSON.stringify([...(category.within ?? [])].sort()),
            );
          }
        }
      }
    }
  }

  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: no code groups are configured, so no code location is ` +
      `impacted (SPEC 9.2)`,
  );
}

// ---------------------------------------------------------------------------
// T6.6-1 — manual restructuring
// ---------------------------------------------------------------------------

// Impact arm: `a.mid` is manually renamed to `a.neo` by overwriting the file;
// everything but the one `id` attribute — the renamed node's text included —
// is byte-identical across the edit, and nothing references the node, so the
// edited workspace stays valid and the deletion-plus-addition semantics are
// observable in isolation. `a.keep` is the untouched sibling that must stay
// uncategorized.
const I1_FILE = "specs/A.mdx";
const I1_TOP = "specs/A.mdx#a";
const I1_MID = "specs/A.mdx#a.mid";
const I1_NEO = "specs/A.mdx#a.neo";
const I1_KEEP = "specs/A.mdx#a.keep";

const impactArmSource = (midId: string): string =>
  [
    '<S id="a">',
    "Holder text.",
    "",
    `<S id="${midId}">`,
    "Mid text staying byte-identical across the manual rename.",
    "</S>",
    "",
    '<S id="a.keep">',
    "Keeper text.",
    "</S>",
    "</S>",
    "",
  ].join("\n");

// The originating nodes of the manual edit (SPEC 5.6: those carrying
// `changed` — the deleted old node, the added new node, and the parent whose
// own content lost one child reference and gained another).
const I1_ORIGINATORS = [I1_MID, I1_NEO, I1_TOP];

// Validation arm: the manually renamed node has two dependents referencing
// the old identity — a same-file local string and a cross-file imported
// chain — each staged as an exact prefix + opening-tag construct so the 14.5
// findings' locations are pinned to byte windows (SPEC 14; the T2.4-4
// operationalization).
const V2_ORIGIN = "specs/B.mdx";
const V2_WATCH = "specs/Watch.mdx";

function originSource(
  midId: string,
  depRef: string,
): { text: string; prefix: string; construct: string } {
  const prefix = [
    '<S id="b">',
    "Holder text.",
    "",
    `<S id="${midId}">`,
    "Mid text.",
    "</S>",
    "",
    "",
  ].join("\n");
  const construct = `<S id="b.dep" d={"${depRef}"}>`;
  const text = `${prefix}${construct}\nSame-file dependent text.\n</S>\n</S>\n`;
  return { text, prefix, construct };
}

function watchSource(ref: string): {
  text: string;
  prefix: string;
  construct: string;
} {
  const prefix = 'import B from "./B.xspec"\n\n';
  const construct = `<S id="watch" d={B.${ref}}>`;
  const text = `${prefix}${construct}\nCross-file dependent text.\n</S>\n`;
  return { text, prefix, construct };
}

const T6_6_1 = defineProductTest({
  id: "T6.6-1",
  title:
    "manual restructuring: renaming an ID by editing the file directly produces no journal entry, impact reports a deletion plus an addition (not continuity), and dependents referencing the old identity fail validation (14.5) until rewritten (SPEC 6.6, 6.1, 5.6, 9.3, 14)",
  run: async (product) => {
    // --- Impact arm: deletion plus addition, never continuity ---
    await withWorkspace(
      { [I1_FILE]: impactArmSource("a.mid") },
      async (workspace) => {
        const context = "T6.6-1 impact arm";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-edit baseline");
        await buildOk(product, workspace, `${context}: \`build\``);
        await assertNoJournal(
          workspace,
          "before any journaled operation (staging premise)",
          context,
        );

        // The manual rename: only the one `id` attribute changes; the node's
        // text is byte-identical, tempting continuity inference (SPEC 6.6).
        await workspace.file(I1_FILE, impactArmSource("a.neo"));

        await buildOk(
          product,
          workspace,
          `${context}: \`build\` after the direct edit — nothing references ` +
            `the vacated identity, so the workspace stays valid`,
        );
        await assertNoJournal(
          workspace,
          "after the direct edit and the `build` over it",
          context,
        );

        const label = `${context}: \`impact --base <pre-edit ref> --json\``;
        assertImpactTable(
          await impactAgainst(product, workspace, base, label),
          [
            // The old identity: deleted and `changed` only — a manual rename
            // is treated as a deletion plus an addition (SPEC 6.6, 5.6).
            {
              identity: I1_MID,
              deleted: true,
              categories: [{ category: "changed", within: I1_ORIGINATORS }],
            },
            // The new identity: added, `changed` only — and not deleted.
            {
              identity: I1_NEO,
              categories: [{ category: "changed", within: I1_ORIGINATORS }],
            },
            // The parent: its own content lost the child reference to the
            // old identity and gained one to the new (5.5: child constructs
            // hash by canonical identity, and no journal maps them) —
            // `changed` — plus `descendant-changed` attributed to the
            // removed and the added child (T5.6-2's precedent).
            {
              identity: I1_TOP,
              categories: [
                { category: "changed", within: I1_ORIGINATORS },
                { category: "descendant-changed", exact: [I1_MID, I1_NEO] },
              ],
            },
            // The file root: `descendant-changed` attributed to P and C.
            {
              identity: I1_FILE,
              categories: [
                {
                  category: "descendant-changed",
                  exact: [I1_TOP, I1_MID, I1_NEO],
                },
              ],
            },
            // The untouched sibling: no category.
            { identity: I1_KEEP, categories: [] },
          ],
          label,
        );
        await assertNoJournal(workspace, "after `impact --base`", context);
      },
    );

    // --- Validation arm: dependents fail 14.5 until rewritten ---
    const staleOrigin = originSource("b.neo", "b.mid");
    const staleWatch = watchSource("b.mid");
    await withWorkspace(
      {
        [V2_ORIGIN]: originSource("b.mid", "b.mid").text,
        [V2_WATCH]: staleWatch.text,
      },
      async (workspace) => {
        const context = "T6.6-1 validation arm";
        await buildOk(product, workspace, `${context}: \`build\``);
        await assertNoJournal(
          workspace,
          "before any journaled operation (staging premise)",
          context,
        );

        // The manual rename, leaving both dependents naming the old identity.
        await workspace.file(V2_ORIGIN, staleOrigin.text);

        const staleLabel = `${context}: \`build --json\` with the dependents still naming the vacated identity`;
        const findings = await buildFindings(product, workspace, staleLabel);
        assertConditionCounts(
          findings,
          { "14.5": 2 },
          `${staleLabel} — each dependent's \`d\` reference to the vacated ` +
            `identity is an unknown dependency: the manual rename carries no ` +
            `continuity, so the references resolve to nothing (SPEC 6.6, 14.5)`,
        );
        for (const [file, source, surface] of [
          [V2_ORIGIN, staleOrigin, "same-file local string reference"],
          [V2_WATCH, staleWatch, "cross-file imported chain reference"],
        ] as const) {
          const located = findings.filter((finding) => finding.file === file);
          if (located.length !== 1) {
            fail(
              `${staleLabel}: expected exactly one 14.5 finding naming ` +
                `${file} (the ${surface}); got ${String(located.length)} — ` +
                `findings: ${JSON.stringify(findings)}`,
            );
          }
          assertFindingLocated(
            located[0]!,
            { file, window: byteWindow(source.prefix, source.construct) },
            `${staleLabel}: the 14.5 finding for the ${surface}`,
          );
        }
        await assertNoJournal(
          workspace,
          "after the direct edit and the failing `build`",
          context,
        );

        // "Until rewritten": manually retarget both dependents to the new
        // identity — validation passes again, and still no journal entry.
        await workspace.file(V2_ORIGIN, originSource("b.neo", "b.neo").text);
        await workspace.file(V2_WATCH, watchSource("b.neo").text);
        await buildOk(
          product,
          workspace,
          `${context}: \`build\` after rewriting both dependents to the new ` +
            `identity — the workspace validates again (SPEC 6.6, 14.5)`,
        );
        await assertNoJournal(
          workspace,
          "after the dependents were rewritten and the `build` over them",
          context,
        );
      },
    );
  },
});

/** TEST-SPEC §6.6, in canonical ID order (SUITE-24). */
export const section66Tests: readonly ProductTestEntry[] = [T6_6_1];
