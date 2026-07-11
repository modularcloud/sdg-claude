// TEST-SPEC §2.7 (permitted constructs) — SUITE-10: T2.7-1 … T2.7-3.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4 — emitted Markdown per SPEC 3, own/subtree text per SPEC 1.6), decodes
// output through the H-3 adapters, and rejects a product only via diagnosed
// assertion failures (H-8).
//
// SPEC 2.7: beyond standard Markdown content, a source file may contain only
// spec module imports, `<S>`/`<Spec>` sections, `{text(...)}` embeddings, and
// MDX comments — any other JSX element, any other expression container, and
// any export statement are invalid (14.16). Comments are pure annotations:
// they do not enter own text or any hash, and Markdown output removes them
// (3). The defined props are `id`, `d`, `coverage`, and `tags`; a repeated
// prop (defined or unknown), an unknown prop, and a spread attribute are
// invalid (14.17); `id`/`coverage`/`tags` values MUST be quoted-form static
// string literals — single- or double-quoted alike (2.4) — and any other
// value form is invalid (14.17); `d` MUST be a braced expression — a quoted
// or valueless `d` is invalid (14.17), and a braced `d` value that is not a
// static reference or an array literal of them is a dynamic argument (14.8).
//
// Location assertions follow the SUITE-08 discipline: negative fixtures are
// pure ASCII, composed as `prefix + construct + suffix` with exactly known
// parts, so string indices are byte offsets and each finding must fall within
// the offending construct's own byte window (end-widened by one byte, see
// support.ts byteWindow); the valid sibling section and every other staged
// construct lie outside the widened window.
//
// No certification fixture scopes any T2.7 test (CERTIFICATIONS.md keeps the
// 2.7 negative matrix among the representatively-certified ones), so only
// TEST-SPEC's own requirements bind these fixtures.

import type {
  ImpactReport,
  ImpactRequirementEntry,
  NodeReport,
} from "../../helpers/adapters/index.js";
import {
  decodeImpactReport,
  decodeNodeReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertFileBytes,
  fail,
} from "../../helpers/assertions.js";
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
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group — the
// negative arms need nothing else.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// Markdown emission next to each source (SPEC 7.3, 13.2) for the arms that
// byte-assert compiled output (T2.7-2's comment removal, T2.7-3's quoting
// equivalence).
const EMIT_TRUE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

// Shared negative-arm template (the SUITE-02/03 discipline): a valid sibling
// first, so the offending construct is a proper sub-range of the file and the
// location assertion has teeth.
const SIBLING = '<S id="ok">\nA valid sibling section.\n</S>\n\n';

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
 * `query node <identity>` decoded through the H-3 adapter, with the resolved
 * identity checked so a mis-addressed report cannot satisfy the assertions.
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

/** Assert an opaque hash value changed across an edit (H-4: self-compare). */
function assertHashChanged(
  before: string,
  after: string,
  what: string,
  context: string,
): void {
  if (before === after) {
    fail(
      `${context}: ${what} must change across the edit (SPEC 5.5), but it is ` +
        `byte-identical: ${JSON.stringify(before)}`,
    );
  }
}

/** Assert an opaque hash value is byte-identical across an edit. */
function assertHashStable(
  before: string,
  after: string,
  what: string,
  context: string,
): void {
  if (before !== after) {
    fail(
      `${context}: ${what} must be byte-identical across the edit (SPEC 5.5), ` +
        `but it changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T2.7-1
// ---------------------------------------------------------------------------

// One representative per forbidden construct class of SPEC 2.7 (each the only
// defect in its otherwise valid fixture). The JSX-element and
// expression-container arms sit inside a section — nesting inside `<S>` earns
// no exemption; the export statement is top-level ESM with a valid section
// after it, so its window has content on both sides.
const T2_7_1_SECTION_PREFIX = `${SIBLING}<S id="sec">\nSection text.\n\n`;

interface ForeignConstructArm {
  /** Which SPEC 2.7 forbidden class this is (failure diagnostics). */
  readonly name: string;
  /** Everything before the offending construct, exactly. */
  readonly prefix: string;
  /** The offending construct's own characters, exactly. */
  readonly construct: string;
  /** Everything after the offending construct, exactly. */
  readonly suffix: string;
}

const FOREIGN_CONSTRUCT_ARMS: readonly ForeignConstructArm[] = [
  {
    name: "a JSX element other than `<S>`/`<Spec>`",
    prefix: T2_7_1_SECTION_PREFIX,
    construct: "<div>foreign block</div>",
    suffix: "\n</S>\n",
  },
  {
    name: "an expression container other than `text(...)` or an MDX comment",
    prefix: T2_7_1_SECTION_PREFIX,
    construct: "{40 + 2}",
    suffix: "\n</S>\n",
  },
  {
    name: "an export statement",
    prefix: SIBLING,
    construct: "export const flag = 1",
    suffix: '\n\n<S id="sec">\nSection text.\n</S>\n',
  },
];

const T2_7_1 = defineProductTest({
  id: "T2.7-1",
  title:
    "a JSX element other than `<S>`/`<Spec>`, an expression container other than `text(...)` or an MDX comment, and an export statement each fail with 14.16 (SPEC 2.7)",
  run: async (product) => {
    for (const arm of FOREIGN_CONSTRUCT_ARMS) {
      const context = `T2.7-1 \`build --json\` with ${arm.name}`;
      await withWorkspace(
        SPECS_ONLY_CONFIG,
        { "specs/A.mdx": arm.prefix + arm.construct + arm.suffix },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { "14.16": 1 }, context);
          assertFindingLocated(
            findings[0]!,
            {
              file: "specs/A.mdx",
              window: byteWindow(arm.prefix, arm.construct),
            },
            `${context}: the 14.16 finding (SPEC 2.7: only imports, sections, ` +
              "`text(...)` embeddings, and MDX comments are permitted)",
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T2.7-2
// ---------------------------------------------------------------------------

// The comment workspace: one section carrying an inline comment (sharing its
// line with retained non-whitespace) and an own-line comment, plus a
// dependent section so the boundary arm observes the full 5.6 cascade
// (`changed` at the section, `descendant-changed` at the root,
// `upstream-changed` at the dependent and — through its subtree — the root).
const T2_7_2_BASELINE = [
  '<S id="sec">',
  "Alpha text {/* inline note */} beta.",
  "",
  "{/* own-line note */}",
  "",
  "Gamma text.",
  "</S>",
  "",
  '<S id="dep" d={"sec"}>',
  "Dep text.",
  "</S>",
  "",
].join("\n");

// Hand-derived per SPEC 3 (cross-checked against the S-6 oracle): tag-only
// and comment-only lines are emptied purely by removals and drop with their
// terminators; the inline comment is deleted exactly in place (leaving the
// author's two spaces); already-empty lines are kept. No comment byte
// survives anywhere in these constants.
const T2_7_2_COMPILED = "Alpha text  beta.\n\n\nGamma text.\n\nDep text.\n";
const T2_7_2_SEC_TEXT = "Alpha text  beta.\n\n\nGamma text.\n";
const T2_7_2_DEP_TEXT = "Dep text.\n";

// The boundary variant: only the own-line comment's construct characters are
// deleted, so its line — previously dropped as left empty purely by removals
// — is now already empty in the source and kept, contributing its terminator
// (SPEC 3; TEST-SPEC T3-3): one more U+000A in the section's contribution.
const T2_7_2_BOUNDARY_COMPILED =
  "Alpha text  beta.\n\n\n\nGamma text.\n\nDep text.\n";
const T2_7_2_BOUNDARY_SEC_TEXT = "Alpha text  beta.\n\n\n\nGamma text.\n";

// The stability arms: each applies exactly one comment-only edit to the
// committed baseline. Every variant compiles to T2_7_2_COMPILED — comments
// (and their whole-line deletion) leave own content untouched (SPEC 1.6, 3).
const T2_7_2_STABILITY_ARMS: readonly { name: string; source: string }[] = [
  {
    name: "editing only the inline comment's content",
    source: T2_7_2_BASELINE.replace(
      "{/* inline note */}",
      "{/* inline note, reworded */}",
    ),
  },
  {
    name: "editing only the own-line comment's content",
    source: T2_7_2_BASELINE.replace(
      "{/* own-line note */}",
      "{/* a different remark */}",
    ),
  },
  {
    name: "deleting the inline comment sharing its line with retained non-whitespace content",
    source: T2_7_2_BASELINE.replace("{/* inline note */}", ""),
  },
  {
    name: "deleting the own-line comment together with its entire line (construct plus terminator)",
    source: T2_7_2_BASELINE.replace("{/* own-line note */}\n", ""),
  },
];

const T2_7_2_BOUNDARY = T2_7_2_BASELINE.replace("{/* own-line note */}", "");

const T2_7_2_ROOT = "specs/A.mdx";
const T2_7_2_SEC = "specs/A.mdx#sec";
const T2_7_2_DEP = "specs/A.mdx#dep";
const T2_7_2_IDENTITIES = [T2_7_2_ROOT, T2_7_2_SEC, T2_7_2_DEP] as const;

/** Full node reports of the workspace's three nodes, keyed by identity. */
async function captureReports(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<Map<string, NodeReport>> {
  const reports = new Map<string, NodeReport>();
  for (const identity of T2_7_2_IDENTITIES) {
    reports.set(
      identity,
      await queryNode(product, workspace, identity, context),
    );
  }
  return reports;
}

/**
 * The impact entry containing `identity`, asserted to cover exactly that one
 * present node (with distinct category sets on every node here, no 9.3
 * ancestor chain may collapse).
 */
function soleEntryFor(
  impact: ImpactReport,
  identity: string,
  context: string,
): ImpactRequirementEntry {
  const entries = impact.requirements.filter((entry) =>
    entry.nodes.includes(identity),
  );
  if (entries.length !== 1) {
    fail(
      `${context}: expected exactly one requirement entry containing ${identity} ` +
        `(SPEC 5.6, 9.3); got ${String(entries.length)} among entries for ` +
        JSON.stringify(impact.requirements.map((entry) => entry.nodes)),
    );
  }
  const entry = entries[0]!;
  assertSameJson(
    entry.nodes,
    [identity],
    `${context}: the entry containing ${identity} covers exactly that node ` +
      "(SPEC 9.3: its category set differs from every neighbor's, so no " +
      "ancestor chain collapses onto it)",
  );
  assertSameJson(
    entry.deleted,
    false,
    `${context}: ${identity} is present on both sides of the comparison`,
  );
  return entry;
}

const T2_7_2 = defineProductTest({
  id: "T2.7-2",
  title:
    "an MDX comment inside a section is absent from Markdown output and not part of own text; comment-content edits, inline-comment deletion, and whole-line own-line-comment deletion change no hash and produce no change categories against a committed baseline; deleting only an own-line comment's construct characters — leaving the emptied line — changes the section's ownHash and makes it `changed` with the 5.6 cascades, the kept line contributing its terminator (SPEC 2.7, 1.6, 3, 5.5, 5.6)",
  run: async (product) => {
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/A.mdx": T2_7_2_BASELINE },
      async (workspace) => {
        await workspace.gitInit();
        const baseCommit = await workspace.gitCommitAll("baseline");

        // Absent from Markdown output: byte equality of the whole emitted
        // file against the hand-derived compilation — no comment byte can
        // survive anywhere (SPEC 2.7, 3).
        await buildOk(
          product,
          workspace,
          "T2.7-2 `build` with emission over the comment-bearing baseline",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_7_2_COMPILED,
          "T2.7-2 emitted Markdown (SPEC 3) — both comments are removed; the " +
            "comment-only line drops with its terminator, the inline comment " +
            "is deleted exactly in place (SPEC 2.7)",
        );

        // Not part of own text (`query node`): exact bytes (SPEC 1.6).
        const baseline = await captureReports(
          product,
          workspace,
          "T2.7-2 baseline:",
        );
        const baselineSec = baseline.get(T2_7_2_SEC)!;
        assertBytesEqual(
          baselineSec.ownText,
          T2_7_2_SEC_TEXT,
          "T2.7-2 own text of the comment-bearing section — comments are not " +
            "part of own text (SPEC 2.7, 1.6)",
        );
        assertBytesEqual(
          baselineSec.subtreeText,
          T2_7_2_SEC_TEXT,
          "T2.7-2 subtree text of the comment-bearing section (no children, " +
            "so it equals own text; SPEC 1.6)",
        );
        assertBytesEqual(
          baseline.get(T2_7_2_DEP)!.ownText,
          T2_7_2_DEP_TEXT,
          "T2.7-2 own text of the dependent section",
        );
        assertBytesEqual(
          baseline.get(T2_7_2_ROOT)!.subtreeText,
          T2_7_2_COMPILED,
          "T2.7-2 the root's subtree text equals the file's compiled output " +
            "(SPEC 1.6) — comment-free there too",
        );

        // Hash and category stability, each arm one edit against the
        // committed baseline: comments enter no hash (SPEC 2.7, 1.6, 5.5),
        // so all four hashes of every node are byte-identical and `impact`
        // reports no change category for any node (SPEC 5.6, 9.1).
        for (const arm of T2_7_2_STABILITY_ARMS) {
          const context = `T2.7-2 (${arm.name})`;
          await workspace.file("specs/A.mdx", arm.source);
          const after = await captureReports(product, workspace, context);
          for (const identity of T2_7_2_IDENTITIES) {
            assertSameJson(
              after.get(identity)!.hashes,
              baseline.get(identity)!.hashes,
              `${context}: all four hashes of ${identity} — comments enter no ` +
                "hash (SPEC 2.7, 1.6, 5.5)",
            );
          }
          const impactLabel = `${context} \`impact --base <baseline> --json\``;
          const impact = decodeImpactReport(
            await runJson(
              product,
              workspace,
              ["impact", "--base", baseCommit, "--json"],
              impactLabel,
            ),
            impactLabel,
          );
          assertSameJson(
            impact.requirements,
            [],
            `${impactLabel}: the comment-only edit produces no change ` +
              "categories for any node (SPEC 2.7, 5.6, 9.1)",
          );
          assertSameJson(
            impact.code.direct,
            [],
            `${impactLabel}: no directly impacted code (SPEC 9.2)`,
          );
          assertSameJson(
            impact.code.transitive,
            [],
            `${impactLabel}: no transitively impacted code (SPEC 9.2)`,
          );
        }

        // Boundary: deleting only the own-line comment's construct
        // characters leaves the emptied line in place — already empty in the
        // source, it is kept and contributes its terminator (SPEC 3;
        // TEST-SPEC T3-3), so the section's own content gains that byte.
        const boundary =
          "T2.7-2 (boundary: own-line comment's construct characters deleted, emptied line kept)";
        await workspace.file("specs/A.mdx", T2_7_2_BOUNDARY);
        await buildOk(product, workspace, `${boundary} \`build\``);
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_7_2_BOUNDARY_COMPILED,
          `${boundary}: the line, previously dropped as left empty purely by ` +
            "removals, is now already empty in the source and kept, " +
            "contributing its terminator (SPEC 3)",
        );
        const after = await captureReports(product, workspace, boundary);
        const afterSec = after.get(T2_7_2_SEC)!;
        assertBytesEqual(
          afterSec.ownText,
          T2_7_2_BOUNDARY_SEC_TEXT,
          `${boundary}: the section's own text gains the kept line's terminator (SPEC 1.6, 3)`,
        );

        // The containing section: ownHash changed (and with it subtreeHash
        // and effectiveHash); metadata untouched (SPEC 5.5).
        const secContext = `${boundary} section ${T2_7_2_SEC}`;
        assertHashChanged(
          baselineSec.hashes.ownHash,
          afterSec.hashes.ownHash,
          "ownHash (the kept empty line's terminator entered the own content sequence)",
          secContext,
        );
        assertHashChanged(
          baselineSec.hashes.subtreeHash,
          afterSec.hashes.subtreeHash,
          "subtreeHash",
          secContext,
        );
        assertHashChanged(
          baselineSec.hashes.effectiveHash,
          afterSec.hashes.effectiveHash,
          "effectiveHash",
          secContext,
        );
        assertHashStable(
          baselineSec.hashes.metadataHash,
          afterSec.hashes.metadataHash,
          "metadataHash (no d/coverage/tags change)",
          secContext,
        );

        // The root: descendant propagation only — its own content runs are
        // untouched (SPEC 5.5).
        const rootContext = `${boundary} root ${T2_7_2_ROOT}`;
        const rootBefore = baseline.get(T2_7_2_ROOT)!.hashes;
        const rootAfter = after.get(T2_7_2_ROOT)!.hashes;
        assertHashStable(
          rootBefore.ownHash,
          rootAfter.ownHash,
          "ownHash (the edit is inside the child construct, not a root-level run)",
          rootContext,
        );
        assertHashChanged(
          rootBefore.subtreeHash,
          rootAfter.subtreeHash,
          "subtreeHash",
          rootContext,
        );
        assertHashChanged(
          rootBefore.effectiveHash,
          rootAfter.effectiveHash,
          "effectiveHash",
          rootContext,
        );
        assertHashStable(
          rootBefore.metadataHash,
          rootAfter.metadataHash,
          "metadataHash",
          rootContext,
        );

        // The dependent: upstream propagation only (SPEC 5.5).
        const depContext = `${boundary} dependent ${T2_7_2_DEP}`;
        const depBefore = baseline.get(T2_7_2_DEP)!.hashes;
        const depAfter = after.get(T2_7_2_DEP)!.hashes;
        assertHashStable(
          depBefore.ownHash,
          depAfter.ownHash,
          "ownHash",
          depContext,
        );
        assertHashStable(
          depBefore.subtreeHash,
          depAfter.subtreeHash,
          "subtreeHash",
          depContext,
        );
        assertHashChanged(
          depBefore.effectiveHash,
          depAfter.effectiveHash,
          "effectiveHash (its dependency-edge target's effectiveHash changed)",
          depContext,
        );
        assertHashStable(
          depBefore.metadataHash,
          depAfter.metadataHash,
          "metadataHash",
          depContext,
        );

        // The cascades of 5.6 in `impact --base`: the section is `changed`;
        // the dependent is `upstream-changed`; the root is both
        // `descendant-changed` (its subtree changed) and `upstream-changed`
        // (its subtree holds the dependent) — every category attributed to
        // the section, the one originating node.
        const impactLabel = `${boundary} \`impact --base <baseline> --json\``;
        const impact = decodeImpactReport(
          await runJson(
            product,
            workspace,
            ["impact", "--base", baseCommit, "--json"],
            impactLabel,
          ),
          impactLabel,
        );
        assertSameJson(
          impact.requirements.length,
          3,
          `${impactLabel}: exactly the section, the dependent, and the root ` +
            "carry categories, each in its own entry (SPEC 5.6, 9.3 — the " +
            "three category sets are pairwise distinct, so nothing collapses)",
        );
        assertSameJson(
          soleEntryFor(impact, T2_7_2_SEC, impactLabel).categories.map(
            (entry) => entry.category,
          ),
          ["changed"],
          `${impactLabel}: the containing section is exactly \`changed\` — its ` +
            "ownHash changed; it has no descendants and no dependencies (SPEC 5.6)",
        );
        assertSameJson(
          soleEntryFor(impact, T2_7_2_DEP, impactLabel).categories,
          [{ category: "upstream-changed", attributedTo: [T2_7_2_SEC] }],
          `${impactLabel}: the dependent is exactly \`upstream-changed\`, ` +
            "attributed to the section (SPEC 5.6)",
        );
        assertSameJson(
          [...soleEntryFor(impact, T2_7_2_ROOT, impactLabel).categories].sort(
            (a, b) => (a.category < b.category ? -1 : 1),
          ),
          [
            { category: "descendant-changed", attributedTo: [T2_7_2_SEC] },
            { category: "upstream-changed", attributedTo: [T2_7_2_SEC] },
          ],
          `${impactLabel}: the root is \`descendant-changed\` and — its subtree ` +
            "holding the dependent — `upstream-changed`, both attributed to " +
            "the section (SPEC 5.6)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.7-3
// ---------------------------------------------------------------------------

// The invalid-prop matrix (SPEC 2.7 → 14.17/14.8), each arm a fresh minimal
// workspace whose offending opening tag is the one staged defect. The quoted
// `d` names the existing sibling, so a product wrongly accepting quoted-form
// `d` resolves it and builds clean — caught by the exit-1 expectation rather
// than accidentally passing via an unresolved-reference finding.
interface InvalidPropArm {
  /** Which SPEC 2.7 prop rule this violates (failure diagnostics). */
  readonly name: string;
  /** The offending opening tag, exactly. */
  readonly construct: string;
  /** The SPEC 14 condition the arm must report. */
  readonly condition: "14.17" | "14.8";
}

const INVALID_PROP_ARMS: readonly InvalidPropArm[] = [
  {
    name: "a repeated defined prop (`tags` twice)",
    construct: '<S id="sec" tags="a" tags="b">',
    condition: "14.17",
  },
  {
    name: "an unknown prop",
    construct: '<S id="sec" wibble="x">',
    condition: "14.17",
  },
  {
    name: "a spread attribute",
    construct: '<S id="sec" {...extra}>',
    condition: "14.17",
  },
  {
    name: "a braced `id` value",
    construct: '<S id={"login"}>',
    condition: "14.17",
  },
  {
    name: "a braced `coverage` value",
    construct: '<S id="sec" coverage={"none"}>',
    condition: "14.17",
  },
  {
    name: "a braced `tags` value",
    construct: '<S id="sec" tags={"a"}>',
    condition: "14.17",
  },
  {
    name: "a quoted `d` value",
    construct: '<S id="sec" d="ok">',
    condition: "14.17",
  },
  {
    name: "a valueless `d`",
    construct: '<S id="sec" d>',
    condition: "14.17",
  },
  {
    name: "a braced `d` holding a number",
    construct: '<S id="sec" d={42}>',
    condition: "14.8",
  },
  {
    name: "a braced `d` holding an object literal",
    construct: '<S id="sec" d={{a: 1}}>',
    condition: "14.8",
  },
];

// A repeated unknown prop is simultaneously repeated and unknown — two causes
// of the one condition 14.17, so SPEC fixes the condition of every finding
// but not one exact count. Its arm asserts all findings are 14.17 at the
// construct instead of a count.
const REPEATED_UNKNOWN_CONSTRUCT = '<S id="sec" wibble="a" wibble="b">';

// The positive quoting arm (SPEC 2.7: single- or double-quoted alike; 2.4):
// the two spellings of one workspace, rebuilt in place. Byte equality is
// asserted where SPEC.md fixes bytes — the emitted Markdown (3) — and the
// spellings' equivalence everywhere else through the full `query node`
// reports (identity, source ranges — equal offsets, the quotes are
// same-length — texts, all four hashes, tags, coverage, edges): the hash
// inputs of 5.5 are identical across the spellings, so equal hashes are a
// SPEC consequence, compared product-to-itself (H-4). Generated-module and
// graph-data bytes are not pinned across the *different* sources: SPEC fixes
// their information, not their bytes (13.1, 13.3; H-4) — the T1.1-2
// tag-equivalence precedent.
const T2_7_3_DOUBLE_QUOTED =
  '<S id="login" coverage="none" tags="a b">\nLogin behavior.\n</S>\n';
const T2_7_3_SINGLE_QUOTED =
  "<S id='login' coverage='none' tags='a b'>\nLogin behavior.\n</S>\n";
const T2_7_3_QUOTED_COMPILED = "Login behavior.\n";
const T2_7_3_QUOTED_IDENTITIES = ["specs/A.mdx", "specs/A.mdx#login"] as const;

const T2_7_3 = defineProductTest({
  id: "T2.7-3",
  title:
    "repeated props (defined or unknown), unknown props, spread attributes, braced `id`/`coverage`/`tags` values, and quoted or valueless `d` fail with 14.17; a braced `d` holding a non-reference expression fails with 14.8; single-quoted `id`/`coverage`/`tags` build byte-identically in outputs to the double-quoted variants (SPEC 2.7, 2.4)",
  run: async (product) => {
    for (const arm of INVALID_PROP_ARMS) {
      const context = `T2.7-3 \`build --json\` with ${arm.name}`;
      await withWorkspace(
        SPECS_ONLY_CONFIG,
        { "specs/A.mdx": `${SIBLING}${arm.construct}\nBody text.\n</S>\n` },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { [arm.condition]: 1 }, context);
          assertFindingLocated(
            findings[0]!,
            {
              file: "specs/A.mdx",
              window: byteWindow(SIBLING, arm.construct),
            },
            `${context}: the ${arm.condition} finding (SPEC 2.7)`,
          );
        },
      );
    }

    // Repeated unknown prop: every finding is 14.17, at the construct.
    const repeatedUnknown =
      "T2.7-3 `build --json` with a repeated unknown prop";
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        "specs/A.mdx": `${SIBLING}${REPEATED_UNKNOWN_CONSTRUCT}\nBody text.\n</S>\n`,
      },
      async (workspace) => {
        const findings = await buildFindings(
          product,
          workspace,
          repeatedUnknown,
        );
        if (findings.length === 0) {
          fail(
            `${repeatedUnknown}: the repeated unknown prop must be reported ` +
              "(SPEC 2.7, 14.17); the findings report is empty",
          );
        }
        for (const finding of findings) {
          assertSameJson(
            finding.condition,
            "14.17",
            `${repeatedUnknown}: every finding carries condition 14.17 — the ` +
              "prop is both repeated and unknown, each an invalid-prop cause " +
              `(SPEC 2.7, 14.17); message: ${JSON.stringify(finding.message)}`,
          );
          assertFindingLocated(
            finding,
            {
              file: "specs/A.mdx",
              window: byteWindow(SIBLING, REPEATED_UNKNOWN_CONSTRUCT),
            },
            `${repeatedUnknown}: a 14.17 finding`,
          );
        }
      },
    );

    // Positive quoting arm.
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/A.mdx": T2_7_3_DOUBLE_QUOTED },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.7-3 `build` with double-quoted `id`/`coverage`/`tags`",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_7_3_QUOTED_COMPILED,
          "T2.7-3 emitted Markdown of the double-quoted variant (SPEC 3)",
        );
        const before: NodeReport[] = [];
        for (const identity of T2_7_3_QUOTED_IDENTITIES) {
          before.push(
            await queryNode(
              product,
              workspace,
              identity,
              "T2.7-3 (double-quoted):",
            ),
          );
        }

        await workspace.file("specs/A.mdx", T2_7_3_SINGLE_QUOTED);
        await buildOk(
          product,
          workspace,
          "T2.7-3 `build` with single-quoted `id`/`coverage`/`tags` — " +
            "single- or double-quoted alike (SPEC 2.7, 2.4)",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_7_3_QUOTED_COMPILED,
          "T2.7-3 emitted Markdown of the single-quoted variant — " +
            "byte-identical output (SPEC 2.7, 3)",
        );
        for (const [index, identity] of T2_7_3_QUOTED_IDENTITIES.entries()) {
          assertSameJson(
            await queryNode(
              product,
              workspace,
              identity,
              "T2.7-3 (single-quoted):",
            ),
            before[index],
            `T2.7-3 the full \`query node ${identity}\` report — identity, ` +
              "source range, texts, hashes, tags, coverage, and edges all " +
              "equal the double-quoted variant's: the spellings are " +
              "equivalent (SPEC 2.7, 2.4, 5.5)",
          );
        }
      },
    );
  },
});

/** TEST-SPEC §2.7, in canonical ID order (SUITE-10). */
export const section27Tests: readonly ProductTestEntry[] = [
  T2_7_1,
  T2_7_2,
  T2_7_3,
];
