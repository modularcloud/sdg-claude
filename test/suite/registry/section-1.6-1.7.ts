// TEST-SPEC §1.6 (own text, subtree text, and own content) and §1.7 (source
// ranges) — SUITE-05: T1.6-1, T1.6-2, T1.6-3, T1.6-4, T1.6-5, T1.7-1.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4) — both text values are exact bytes (SPEC 1.6), so every expectation
// below is a hand-derived byte string from the fixture's known source and the
// removal/replacement/line-drop rules of SPEC 3 — decodes output through the
// H-3 adapters, and rejects a product only via diagnosed assertion failures
// (H-8). The `text(node)` runtime arm of T1.6-3 compiles and runs a consumer
// program under standard TypeScript tooling with no xspec runtime dependency
// (SPEC 13.1) through helpers/tooling.ts, following the CommonJS-mode
// arrangement described in section-1.1-1.2.ts.

import { Buffer } from "node:buffer";
import type { Finding, NodeReport } from "../../helpers/adapters/index.js";
import {
  decodeImpactReport,
  decodeNextReport,
  decodeNodeReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  assertFileBytes,
  fail,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import {
  assertNoCompileErrors,
  ConsumerProject,
  formatConsumerDiagnostic,
  runConsumer,
} from "../../helpers/tooling.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertSameJson,
  buildFindings,
  buildOk,
  expectExit,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): one spec group. The spec-group
// globs match only `.mdx` files, so no glob matches a Markdown emit
// destination (`specs/*.md`, SPEC 7.3) — the discovered set is identical
// under every `markdown` variant, as T1.6-1's parity arm requires.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// As above with `markdown: { emit: false }` (SPEC 7.3).
const EMIT_FALSE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: false }
})
`;

// As above with emission enabled (default destination: next to each source
// file, `specs/A.mdx` → `specs/A.md`; SPEC 7.3, 13.2).
const EMIT_TRUE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

/**
 * `query node <identity>` decoded through the H-3 adapter, with the resolved
 * identity checked so a mis-addressed report cannot satisfy text assertions.
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

/** Byte-assert a node's own and subtree text (SPEC 1.6: exact bytes). */
function assertNodeTexts(
  node: NodeReport,
  expected: { readonly own: string; readonly subtree: string },
  context: string,
): void {
  assertBytesEqual(
    node.subtreeText,
    expected.subtree,
    `${context}: subtree text (SPEC 1.6 — the section construct's contribution to compiled Markdown)`,
  );
  assertBytesEqual(
    node.ownText,
    expected.own,
    `${context}: own text (SPEC 1.6 — subtree text with each child's contribution excised, runs joined at the excision points)`,
  );
}

// ---------------------------------------------------------------------------
// T1.6-1
// ---------------------------------------------------------------------------

// A parent with interleaved prose and two children (root-level prose keeps
// the parent's contribution a proper part of the file's compiled output).
const INTERLEAVED_BODY = [
  '<S id="parent">',
  "Intro prose.",
  "",
  '<S id="parent.one">',
  "One text.",
  "</S>",
  "",
  "Middle prose.",
  "",
  '<S id="parent.two">',
  "Two text.",
  "</S>",
  "",
  "Outro prose.",
  "</S>",
].join("\n");

const INTERLEAVED_SOURCE = [
  "Root prose.",
  "",
  INTERLEAVED_BODY,
  "",
  "Root outro.",
  "",
].join("\n");

// The same workspace extended with a `{text(...)}` embedding, so expansion is
// at stake in the parity arm (T1.6-1's configuration-independence arm).
const EMBEDDING_SECTION = [
  '<S id="summary">',
  "Summary:",
  "",
  '{text("parent.one")}',
  "</S>",
].join("\n");

const EXTENDED_SOURCE = [
  "Root prose.",
  "",
  INTERLEAVED_BODY,
  "",
  EMBEDDING_SECTION,
  "",
  "Root outro.",
  "",
].join("\n");

// Expected values, derived by hand from SPEC 3: every tag-only line is
// emptied purely by removals and dropped with its terminator; all other lines
// are preserved byte-for-byte; `{text(...)}` is replaced by the target's
// compiled subtree text.
const ONE_TEXT = "One text.\n";
const TWO_TEXT = "Two text.\n";
// The parent's contribution: children interleaved at their document
// positions, not appended after the parent's own prose.
const PARENT_SUBTREE =
  "Intro prose.\n\nOne text.\n\nMiddle prose.\n\nTwo text.\n\nOutro prose.\n";
// Own text: the three runs the two child constructs divide —
// "Intro prose.\n\n" ++ "\nMiddle prose.\n\n" ++ "\nOutro prose.\n" —
// joined exactly at the excision points.
const PARENT_OWN = "Intro prose.\n\n\nMiddle prose.\n\n\nOutro prose.\n";
// The whole file's compiled output (the root's subtree text, SPEC 1.2/1.6).
const INTERLEAVED_COMPILED =
  "Root prose.\n\nIntro prose.\n\nOne text.\n\nMiddle prose.\n\nTwo text.\n\nOutro prose.\n\nRoot outro.\n";
// The root's runs around the parent construct: "Root prose.\n\n" ++
// "\nRoot outro.\n" (the tag-only lines drop with their terminators).
const INTERLEAVED_ROOT_OWN = "Root prose.\n\n\nRoot outro.\n";

// Extended workspace: the summary's expansion line compiles to
// "One text.\n" (the expansion) followed by the line's own terminator.
const SUMMARY_TEXT = "Summary:\n\nOne text.\n\n";
const EXTENDED_COMPILED =
  "Root prose.\n\nIntro prose.\n\nOne text.\n\nMiddle prose.\n\nTwo text.\n\nOutro prose.\n\nSummary:\n\nOne text.\n\n\nRoot outro.\n";
// Root runs: "Root prose.\n\n" ++ "\n" (between parent and summary) ++
// "\nRoot outro.\n".
const EXTENDED_ROOT_OWN = "Root prose.\n\n\n\nRoot outro.\n";

const EXTENDED_EXPECTED: ReadonlyArray<{
  readonly identity: string;
  readonly own: string;
  readonly subtree: string;
}> = [
  {
    identity: "specs/A.mdx",
    own: EXTENDED_ROOT_OWN,
    subtree: EXTENDED_COMPILED,
  },
  { identity: "specs/A.mdx#parent", own: PARENT_OWN, subtree: PARENT_SUBTREE },
  { identity: "specs/A.mdx#parent.one", own: ONE_TEXT, subtree: ONE_TEXT },
  { identity: "specs/A.mdx#parent.two", own: TWO_TEXT, subtree: TWO_TEXT },
  { identity: "specs/A.mdx#summary", own: SUMMARY_TEXT, subtree: SUMMARY_TEXT },
];

// The three `markdown` variants of the parity arm (SPEC 1.6: the rules of 3
// define both text values whether or not Markdown emission is enabled; own
// content is likewise defined through the rules of 3, so the hashes of 5.5
// are emission-independent too).
const MARKDOWN_VARIANTS = [
  { key: "`markdown` absent", config: SPECS_ONLY_CONFIG },
  { key: "`markdown: { emit: false }`", config: EMIT_FALSE_CONFIG },
  { key: "`markdown: { emit: true }`", config: EMIT_TRUE_CONFIG },
] as const;

const T1_6_1 = defineProductTest({
  id: "T1.6-1",
  title:
    "subtree text is the section's contribution to compiled Markdown with children interleaved; own text excises child contributions; texts and all four hashes are identical under every `markdown` configuration (SPEC 1.6, 3, 5.5, 7.3)",
  run: async (product) => {
    // Base arm: emission enabled, so the expected compiled output is realized
    // on disk and the query-node expectations are verified byte-wise against
    // the workspace's actual compiled output (T1.6-1's byte anchor).
    const base = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": INTERLEAVED_SOURCE,
      },
    });
    try {
      await buildOk(product, base, "T1.6-1 `build` of the interleaved fixture");
      await assertFileBytes(
        base.path("specs/A.md"),
        INTERLEAVED_COMPILED,
        "T1.6-1 emitted Markdown of the interleaved fixture (SPEC 3 — the byte anchor the text expectations are verified against)",
      );
      assertNodeTexts(
        await queryNode(product, base, "specs/A.mdx#parent", "T1.6-1"),
        { own: PARENT_OWN, subtree: PARENT_SUBTREE },
        "T1.6-1 parent with interleaved prose and two children",
      );
      assertNodeTexts(
        await queryNode(product, base, "specs/A.mdx#parent.one", "T1.6-1"),
        { own: ONE_TEXT, subtree: ONE_TEXT },
        "T1.6-1 first child",
      );
      assertNodeTexts(
        await queryNode(product, base, "specs/A.mdx#parent.two", "T1.6-1"),
        { own: TWO_TEXT, subtree: TWO_TEXT },
        "T1.6-1 second child",
      );
      assertNodeTexts(
        await queryNode(product, base, "specs/A.mdx", "T1.6-1"),
        { own: INTERLEAVED_ROOT_OWN, subtree: INTERLEAVED_COMPILED },
        "T1.6-1 root (subtree text = the entire compiled output, SPEC 1.2/1.6)",
      );
    } finally {
      await base.dispose();
    }

    // Configuration-independence arm: the same workspace, extended with a
    // `{text(...)}` embedding so expansion is at stake, rebuilt and queried
    // under each `markdown` variant in turn. Texts are byte-anchored per
    // variant (so identical-but-unexpanded reporting cannot pass), and all
    // four hashes must be byte-identical across the variants (so a product
    // computing expanded text values, or own-content-derived hashes, only
    // when emission is enabled is discriminated; SPEC 1.6, 5.5).
    const extended = await TestWorkspace.create({
      files: { "specs/A.mdx": EXTENDED_SOURCE },
    });
    try {
      const byVariant = new Map<string, Map<string, NodeReport>>();
      for (const variant of MARKDOWN_VARIANTS) {
        await extended.file("xspec.config.ts", variant.config);
        await buildOk(
          product,
          extended,
          `T1.6-1 \`build\` of the extended fixture under ${variant.key}`,
        );
        const reports = new Map<string, NodeReport>();
        for (const expected of EXTENDED_EXPECTED) {
          const node = await queryNode(
            product,
            extended,
            expected.identity,
            `T1.6-1 under ${variant.key}:`,
          );
          assertNodeTexts(
            node,
            expected,
            `T1.6-1 ${expected.identity} under ${variant.key}`,
          );
          reports.set(expected.identity, node);
        }
        byVariant.set(variant.key, reports);
      }
      const reference = byVariant.get(MARKDOWN_VARIANTS[0].key)!;
      for (const variant of MARKDOWN_VARIANTS.slice(1)) {
        const reports = byVariant.get(variant.key)!;
        for (const expected of EXTENDED_EXPECTED) {
          assertSameJson(
            reports.get(expected.identity)!.hashes,
            reference.get(expected.identity)!.hashes,
            `T1.6-1 all four hashes of ${expected.identity} under ${variant.key} vs ` +
              `${MARKDOWN_VARIANTS[0].key} — the rules of 3 define text values and own ` +
              `content whether or not emission is enabled (SPEC 1.6, 5.5)`,
          );
        }
      }
    } finally {
      await extended.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T1.6-2
// ---------------------------------------------------------------------------

// Empty-run boundary cases (SPEC 1.6: N child constructs divide a node's
// contribution into exactly N + 1 runs, empty runs included):
// - `p`: a child at the very start (its opening tag immediately follows the
//   parent's) and a child at the very end (its closing tag immediately
//   precedes the parent's) — runs ["", "\nMid.\n\n", ""].
// - `q`: adjacent children with no bytes between them — runs
//   ["head", "", "tail"].
// - the root: its first child construct starts at byte 0 —
//   runs ["", "\n", "\n"].
const RUNS_SOURCE = [
  '<S id="p"><S id="p.a">',
  "Alpha.",
  "</S>",
  "",
  "Mid.",
  "",
  '<S id="p.b">',
  "Beta.",
  "</S></S>",
  "",
  '<S id="q">head<S id="q.a">A</S><S id="q.b">B</S>tail</S>',
  "",
].join("\n");

// Compiled output (SPEC 3): the lines emptied purely by removals — including
// the `<S id="p"><S id="p.a">` and `</S></S>` lines — drop with their
// terminators; the in-line `q` line keeps its remaining content and
// terminator.
const RUNS_COMPILED = "Alpha.\n\nMid.\n\nBeta.\n\nheadABtail\n";
const P_SUBTREE = "Alpha.\n\nMid.\n\nBeta.\n";
const P_OWN = "\nMid.\n\n";
// `q` ends at its closing tag's `>`; the kept line's terminator lies outside
// the construct and belongs to the root's own text.
const Q_SUBTREE = "headABtail";
const Q_OWN = "headtail";
const RUNS_ROOT_OWN = "\n\n";

const T1_6_2 = defineProductTest({
  id: "T1.6-2",
  title:
    "N child constructs produce N+1 own-text runs, empty runs included: adjacent children, a child at the very start, a child at the very end (SPEC 1.6, 3)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": RUNS_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T1.6-2 `build`");
      await assertFileBytes(
        workspace.path("specs/A.md"),
        RUNS_COMPILED,
        "T1.6-2 emitted Markdown (SPEC 3 — the byte anchor for the run expectations)",
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#p", "T1.6-2"),
        { own: P_OWN, subtree: P_SUBTREE },
        'T1.6-2 `p` (children at the very start and very end: runs ["", "\\nMid.\\n\\n", ""])',
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#p.a", "T1.6-2"),
        { own: "Alpha.\n", subtree: "Alpha.\n" },
        "T1.6-2 `p.a`",
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#p.b", "T1.6-2"),
        { own: "Beta.\n", subtree: "Beta.\n" },
        "T1.6-2 `p.b`",
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#q", "T1.6-2"),
        { own: Q_OWN, subtree: Q_SUBTREE },
        'T1.6-2 `q` (adjacent children with no bytes between them: runs ["head", "", "tail"])',
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#q.a", "T1.6-2"),
        { own: "A", subtree: "A" },
        "T1.6-2 `q.a` (an in-line construct contributes no line terminator of its own)",
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx#q.b", "T1.6-2"),
        { own: "B", subtree: "B" },
        "T1.6-2 `q.b`",
      );
      assertNodeTexts(
        await queryNode(product, workspace, "specs/A.mdx", "T1.6-2"),
        { own: RUNS_ROOT_OWN, subtree: RUNS_COMPILED },
        'T1.6-2 root (first child construct at byte 0: runs ["", "\\n", "\\n"])',
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T1.6-3
// ---------------------------------------------------------------------------

// A two-level embedding chain, so "fully expanded" is recursive: `summary`
// embeds `BASE.mid` (external node form), which embeds `leaf` (local string
// form). The summary also has a child, so its own text and subtree text
// differ and both carry the expansion.
const CHAIN_BASE_SOURCE = [
  '<S id="leaf">',
  "Leaf text.",
  "</S>",
  "",
  '<S id="mid">',
  'Mid: {text("leaf")}',
  "</S>",
  "",
].join("\n");

const CHAIN_TOP_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  "# Alpha file",
  "",
  '<S id="summary">',
  "Top: {text(BASE.mid)}",
  "",
  '<S id="summary.extra">',
  "Extra prose.",
  "</S>",
  "</S>",
  "",
].join("\n");

const LEAF_TEXT = "Leaf text.\n";
// `Mid: {text("leaf")}` compiles to "Mid: " + expansion + the line's own
// terminator (SPEC 3 replacement is in place; the expansion ends in "\n").
const MID_TEXT = "Mid: Leaf text.\n\n";
// `Top: {text(BASE.mid)}` compiles to "Top: " + MID_TEXT + "\n"; the blank
// line before the child adds one more "\n" to the first own-text run.
const SUMMARY_OWN = "Top: Mid: Leaf text.\n\n\n\n";
const SUMMARY_SUBTREE = "Top: Mid: Leaf text.\n\n\n\nExtra prose.\n";
// The top file root's own text: the import line drops with its terminator;
// the heading prose stays; the summary construct's lines drop.
const TOP_ROOT_OWN = "\n# Alpha file\n\n";

const SUMMARY_ID = "specs/A.mdx#summary";
const EXTRA_ID = "specs/A.mdx#summary.extra";
const REVIEW_SESSION = "expansion";

// `text(node)` at runtime (SPEC 4.3): the compiled consumer prints the
// expanded subtree text — requirement text reaches it only through `text`.
const EXPANSION_CONSUMER = [
  'import SPEC, { text } from "./specs/A.xspec";',
  "",
  "process.stdout.write(text(SPEC.summary));",
  "",
].join("\n");

const T1_6_3 = defineProductTest({
  id: "T1.6-3",
  title:
    "with `{text(...)}` embeddings present, own and subtree text via `query`, `show`, and review payloads carry the embedded text fully expanded, and `text(node)` returns expanded subtree text at runtime (SPEC 1.6, 4.3, 10.2, 10.7)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": CHAIN_TOP_SOURCE,
        "specs/BASE.mdx": CHAIN_BASE_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T1.6-3 `build`");

      // The middle of the chain is itself expanded (grounds "fully").
      assertNodeTexts(
        await queryNode(product, workspace, "specs/BASE.mdx#mid", "T1.6-3"),
        { own: MID_TEXT, subtree: MID_TEXT },
        "T1.6-3 `mid` (its own embedding of `leaf` expanded)",
      );
      // `query node`: own and subtree text both expanded, through two levels.
      assertNodeTexts(
        await queryNode(product, workspace, SUMMARY_ID, "T1.6-3"),
        { own: SUMMARY_OWN, subtree: SUMMARY_SUBTREE },
        "T1.6-3 `summary` via `query node` (leaf's text reaches it through `mid`)",
      );

      // `show` (SPEC 12.4): the same expanded values.
      const showLabel = `T1.6-3 \`show ${SUMMARY_ID} --json\``;
      const shown = decodeNodeReport(
        await runJson(
          product,
          workspace,
          ["show", SUMMARY_ID, "--json"],
          showLabel,
        ),
        showLabel,
      );
      assertNodeTexts(
        shown,
        { own: SUMMARY_OWN, subtree: SUMMARY_SUBTREE },
        showLabel,
      );

      // Review payload (SPEC 10.2, 10.7): an audit session's
      // `subtree-coherence` item for `summary` carries the scope root's
      // subtree text and the ancestor chain's own text — every text value the
      // expanded value of 1.6. The summary's item is blocked by its child's
      // (SPEC 10.6), so the child item is resolved first via `status`
      // lookup + `resolve`.
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", REVIEW_SESSION],
        0,
        "T1.6-3 `review create --strategy audit`",
      );
      const statusLabel = `T1.6-3 \`review status ${REVIEW_SESSION} --json\``;
      const status = decodeSessionStatusReport(
        await runJson(
          product,
          workspace,
          ["review", "status", REVIEW_SESSION, "--json"],
          statusLabel,
        ),
        statusLabel,
      );
      const extraRow = status.items.find((row) => row.scope === EXTRA_ID);
      if (extraRow === undefined) {
        fail(
          `${statusLabel}: expected an audit item scoped to ${EXTRA_ID} (SPEC 10.6: one ` +
            `subtree-coherence item per requirement node); got scopes ` +
            JSON.stringify(status.items.map((row) => row.scope)),
        );
      }
      await expectExit(
        product,
        workspace,
        [
          "review",
          "resolve",
          REVIEW_SESSION,
          extraRow.id,
          "--status",
          "no-change",
        ],
        0,
        "T1.6-3 `review resolve` of the child's item (unblocks the summary's item, SPEC 10.3)",
      );
      const nextLabel = `T1.6-3 \`review next ${REVIEW_SESSION} --json\``;
      const next = decodeNextReport(
        await runJson(
          product,
          workspace,
          ["review", "next", REVIEW_SESSION, "--json"],
          nextLabel,
        ),
        nextLabel,
      );
      if (next.fullyResolved || next.item === undefined) {
        fail(
          `${nextLabel}: expected the summary's unblocked, unresolved item — the session ` +
            `is not fully resolved (SPEC 10.6, 10.7)`,
        );
      }
      const item = next.item;
      if (item.kind !== "subtree-coherence" || item.scope.node !== SUMMARY_ID) {
        fail(
          `${nextLabel}: expected the subtree-coherence item scoped to ${SUMMARY_ID} — ` +
            `specs/A.mdx sorts first and its only unblocked needing-review item is the ` +
            `summary's (SPEC 10.6, 10.7); got kind ${JSON.stringify(item.kind)}, scope ` +
            JSON.stringify(item.scope.node),
        );
      }
      if (!item.scope.present || item.scope.text === undefined) {
        fail(
          `${nextLabel}: the payload must carry the present scope node's text — the scope ` +
            `root's subtree text for subtree-coherence (SPEC 10.7); got present ` +
            `${String(item.scope.present)}, text ${item.scope.text === undefined ? "absent" : "present"}`,
        );
      }
      assertBytesEqual(
        item.scope.text,
        SUMMARY_SUBTREE,
        `${nextLabel}: scope text — the scope root's subtree text, embedded text fully expanded (SPEC 1.6, 10.7)`,
      );
      assertSameJson(
        item.context.map((entry) => entry.node),
        ["specs/A.mdx"],
        `${nextLabel}: context — the scope node's ancestor chain (SPEC 10.6)`,
      );
      const contextEntry = item.context[0]!;
      if (!contextEntry.present || contextEntry.text === undefined) {
        fail(
          `${nextLabel}: the payload must carry the present context node's text — own text ` +
            `for an ancestor-chain context (SPEC 10.7); got present ` +
            `${String(contextEntry.present)}, text ${contextEntry.text === undefined ? "absent" : "present"}`,
        );
      }
      assertBytesEqual(
        contextEntry.text,
        TOP_ROOT_OWN,
        `${nextLabel}: context text — the root ancestor's own text (SPEC 1.6, 10.7)`,
      );

      // `text(node)` at runtime (SPEC 4.3, 13.1): expanded subtree text.
      await workspace.file("main.ts", EXPANSION_CONSUMER);
      const project = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["main.ts"],
      });
      assertNoCompileErrors(
        project,
        "T1.6-3 consumer passing `SPEC.summary` to `text()`",
      );
      const emitted = project.emit();
      if (emitted.emitSkipped) {
        fail(
          "T1.6-3: consumer emit was skipped; diagnostics:\n" +
            emitted.diagnostics
              .map((diagnostic) => `  ${formatConsumerDiagnostic(diagnostic)}`)
              .join("\n"),
        );
      }
      const run = await runConsumer({
        dir: workspace.root,
        entry: "main.js",
      });
      assertExitCode(
        run,
        0,
        "T1.6-3 compiled consumer under plain Node (SPEC 13.1)",
      );
      assertBytesEqual(
        run.stdoutBytes,
        SUMMARY_SUBTREE,
        "T1.6-3 `text(SPEC.summary)` at runtime — expanded subtree text (SPEC 1.6, 4.3)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T1.6-4
// ---------------------------------------------------------------------------

const EMBED_TARGET_BEFORE = [
  '<S id="target">',
  "Original target text.",
  "</S>",
  "",
].join("\n");

const EMBED_TARGET_AFTER = [
  '<S id="target">',
  "Edited target text.",
  "</S>",
  "",
].join("\n");

const EMBEDDER_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="embedder">',
  "See: {text(BASE.target)}",
  "</S>",
  "",
].join("\n");

const TARGET_ID = "specs/BASE.mdx#target";
const EMBEDDER_ID = "specs/A.mdx#embedder";
const TARGET_TEXT_BEFORE = "Original target text.\n";
const TARGET_TEXT_AFTER = "Edited target text.\n";
const EMBEDDER_TEXT_BEFORE = "See: Original target text.\n\n";
const EMBEDDER_TEXT_AFTER = "See: Edited target text.\n\n";

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

const T1_6_4 = defineProductTest({
  id: "T1.6-4",
  title:
    "editing an embedding's target changes the target's hashes but not the embedder's ownHash or subtreeHash; in impact the embedder is `upstream-changed`, not `changed` (SPEC 1.6, 5.5, 5.6, 9)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": EMBEDDER_SOURCE,
        "specs/BASE.mdx": EMBED_TARGET_BEFORE,
      },
    });
    try {
      // Baseline commit (sources only), then the target-only edit.
      await workspace.gitInit();
      await workspace.gitCommitAll("baseline");

      const targetBefore = await queryNode(
        product,
        workspace,
        TARGET_ID,
        "T1.6-4 before the edit:",
      );
      assertBytesEqual(
        targetBefore.subtreeText,
        TARGET_TEXT_BEFORE,
        "T1.6-4 target subtree text before the edit",
      );
      const embedderBefore = await queryNode(
        product,
        workspace,
        EMBEDDER_ID,
        "T1.6-4 before the edit:",
      );
      assertBytesEqual(
        embedderBefore.subtreeText,
        EMBEDDER_TEXT_BEFORE,
        "T1.6-4 embedder subtree text before the edit (expanded, SPEC 1.6)",
      );

      await workspace.file("specs/BASE.mdx", EMBED_TARGET_AFTER);

      const targetAfter = await queryNode(
        product,
        workspace,
        TARGET_ID,
        "T1.6-4 after the edit:",
      );
      assertBytesEqual(
        targetAfter.subtreeText,
        TARGET_TEXT_AFTER,
        "T1.6-4 target subtree text after the edit",
      );
      const embedderAfter = await queryNode(
        product,
        workspace,
        EMBEDDER_ID,
        "T1.6-4 after the edit:",
      );
      // The embedder's *text* follows the target (expansion, SPEC 1.6)...
      assertBytesEqual(
        embedderAfter.subtreeText,
        EMBEDDER_TEXT_AFTER,
        "T1.6-4 embedder subtree text after the edit — `text(...)` output stays fully expanded (SPEC 1.6, 5.5)",
      );

      // ...while hashing uses own content, not the expanded values (SPEC 1.6).
      const targetContext = `T1.6-4 target ${TARGET_ID}`;
      assertHashChanged(
        targetBefore.hashes.ownHash,
        targetAfter.hashes.ownHash,
        "ownHash",
        targetContext,
      );
      assertHashChanged(
        targetBefore.hashes.subtreeHash,
        targetAfter.hashes.subtreeHash,
        "subtreeHash",
        targetContext,
      );
      assertHashChanged(
        targetBefore.hashes.effectiveHash,
        targetAfter.hashes.effectiveHash,
        "effectiveHash",
        targetContext,
      );
      assertHashStable(
        targetBefore.hashes.metadataHash,
        targetAfter.hashes.metadataHash,
        "metadataHash (no d/coverage/tags change)",
        targetContext,
      );
      const embedderContext = `T1.6-4 embedder ${EMBEDDER_ID}`;
      assertHashStable(
        embedderBefore.hashes.ownHash,
        embedderAfter.hashes.ownHash,
        "ownHash (an embedded target's text is no part of the embedder's own content)",
        embedderContext,
      );
      assertHashStable(
        embedderBefore.hashes.subtreeHash,
        embedderAfter.hashes.subtreeHash,
        "subtreeHash",
        embedderContext,
      );
      assertHashStable(
        embedderBefore.hashes.metadataHash,
        embedderAfter.hashes.metadataHash,
        "metadataHash (embedded references surface through ownHash, never metadataHash)",
        embedderContext,
      );
      assertHashChanged(
        embedderBefore.hashes.effectiveHash,
        embedderAfter.hashes.effectiveHash,
        "effectiveHash (a dependency-edge target's effectiveHash changed)",
        embedderContext,
      );

      // Impact categories (SPEC 5.6, 9): the embedder is upstream-changed —
      // attributed to the target — and nothing else; the target is changed.
      const impactLabel = "T1.6-4 `impact --base HEAD --json`";
      const impact = decodeImpactReport(
        await runJson(
          product,
          workspace,
          ["impact", "--base", "HEAD", "--json"],
          impactLabel,
        ),
        impactLabel,
      );
      const targetEntry = impact.requirements.find((entry) =>
        entry.nodes.includes(TARGET_ID),
      );
      const embedderEntry = impact.requirements.find((entry) =>
        entry.nodes.includes(EMBEDDER_ID),
      );
      if (targetEntry === undefined || embedderEntry === undefined) {
        fail(
          `${impactLabel}: expected entries for ${TARGET_ID} and ${EMBEDDER_ID} ` +
            `(SPEC 5.6, 9.3); got entries for ` +
            JSON.stringify(impact.requirements.map((entry) => entry.nodes)),
        );
      }
      assertSameJson(
        targetEntry.nodes,
        [TARGET_ID],
        `${impactLabel}: the edited target's entry covers exactly the target (its category is \`changed\`, so no ancestor chain collapses onto it, SPEC 9.3)`,
      );
      assertSameJson(
        targetEntry.deleted,
        false,
        `${impactLabel}: the target is present on both sides`,
      );
      assertSameJson(
        targetEntry.categories.map((category) => category.category),
        ["changed"],
        `${impactLabel}: the edited target's only category (SPEC 5.6)`,
      );
      assertSameJson(
        embedderEntry.nodes,
        [EMBEDDER_ID],
        `${impactLabel}: the embedder's entry covers exactly the embedder`,
      );
      assertSameJson(
        embedderEntry.deleted,
        false,
        `${impactLabel}: the embedder is present on both sides`,
      );
      assertSameJson(
        embedderEntry.categories,
        [{ category: "upstream-changed", attributedTo: [TARGET_ID] }],
        `${impactLabel}: the embedder is \`upstream-changed\` attributed to the target — ` +
          `never \`changed\` or \`descendant-changed\`, its ownHash and subtreeHash did ` +
          `not change (SPEC 1.6, 5.5, 5.6)`,
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T1.6-5
// ---------------------------------------------------------------------------

// One spec group plus one code group, for the code-source arms (SPEC 7.2).
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

// 0xFF can occur in no valid UTF-8 sequence; everything else in the file is
// valid, so 14.20 is the file's only condition.
function withInvalidUtf8Byte(prefix: string, suffix: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.from([0xff]),
    Buffer.from(suffix, "utf8"),
  ]);
}

// A UTF-8 byte-order mark followed by otherwise-valid content: the fixture
// isolates the BOM rule from the invalid-UTF-8 rule (SPEC 1.6: a source that
// begins with a BOM is unparseable, 14.20). U+FEFF encodes to EF BB BF; the
// workspace builder writes string contents with BOMs kept (S-2).
const BOM = "\u{FEFF}";

const VALID_SECTION_SOURCE = '<S id="ok">\nValid content.\n</S>\n';

/**
 * Exactly one finding names the file, and it carries condition 14.20 (SPEC
 * 14: errors identify the file; 14.20 is a whole-file condition, so no
 * in-file location is demanded of it).
 */
function assertUnparseableFinding(
  findings: readonly Finding[],
  file: string,
  context: string,
): void {
  const matching = findings.filter((finding) => finding.file === file);
  if (matching.length !== 1) {
    fail(
      `${context}: expected exactly one finding naming ${JSON.stringify(file)} ` +
        `(SPEC 14, 14.20); got ${String(matching.length)} among ` +
        JSON.stringify(
          findings.map((finding) => ({
            condition: finding.condition,
            file: finding.file ?? null,
          })),
        ),
    );
  }
  if (matching[0]!.condition !== "14.20") {
    fail(
      `${context}: the finding for ${JSON.stringify(file)} must carry condition 14.20 ` +
        `(unparseable source: invalid UTF-8 or leading BOM, SPEC 1.6); got ` +
        `${JSON.stringify(matching[0]!.condition)} (message: ${JSON.stringify(matching[0]!.message)})`,
    );
  }
}

const T1_6_5 = defineProductTest({
  id: "T1.6-5",
  title:
    "a spec or code source that is invalid UTF-8, or begins with a BOM, fails `build` with 14.20 (SPEC 1.6, 14.20)",
  run: async (product) => {
    // Spec-source arms: one invalid-UTF-8 file, one BOM file.
    const specArm = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/bad-utf8.mdx": withInvalidUtf8Byte(
          '<S id="a">\nBad ',
          " byte.\n</S>\n",
        ),
        "specs/bom.mdx": BOM + '<S id="b">\nBom content.\n</S>\n',
      },
    });
    try {
      const context =
        "T1.6-5 `build --json` over the two unparseable spec sources";
      const findings = await buildFindings(product, specArm, context);
      assertConditionCounts(findings, { "14.20": 2 }, context);
      assertUnparseableFinding(findings, "specs/bad-utf8.mdx", context);
      assertUnparseableFinding(findings, "specs/bom.mdx", context);
    } finally {
      await specArm.dispose();
    }

    // Code-source arms: 14.20 covers discovered code sources too (SPEC 1.6
    // names spec and code sources alike); the spec source beside them is
    // valid, so the two conditions are the code files'.
    const codeArm = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPEC_AND_CODE_CONFIG,
        "specs/OK.mdx": VALID_SECTION_SOURCE,
        "src/bad-utf8.ts": withInvalidUtf8Byte("export const a = 1; // ", "\n"),
        "src/bom.ts": BOM + "export const b = 2;\n",
      },
    });
    try {
      const context =
        "T1.6-5 `build --json` over the two unparseable code sources";
      const findings = await buildFindings(product, codeArm, context);
      assertConditionCounts(findings, { "14.20": 2 }, context);
      assertUnparseableFinding(findings, "src/bad-utf8.ts", context);
      assertUnparseableFinding(findings, "src/bom.ts", context);
    } finally {
      await codeArm.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T1.7-1
// ---------------------------------------------------------------------------

// A fixture whose exact bytes are known, assembled from named parts so the
// expected offsets are precomputed from the parts' byte lengths — never from
// product output. An import line and multi-byte UTF-8 content precede the
// first section, so byte offsets into the source diverge from code-point
// offsets (é, ï: 1 code point, 2 bytes; 🦄: 1 code point, 4 bytes), from
// UTF-16 offsets (🦄: 2 units, 4 bytes), and from compiled-output offsets
// (the import line and tags are removed). Multi-byte content inside the first
// section makes the end offset diverge too.
const RANGE_IMPORT_LINE = 'import BASE from "./BASE.xspec"\n';
const RANGE_PREFIX = "\nPrélude 🦄 naïve prose — before any section.\n\n";
const RANGE_FIRST_CONSTRUCT = '<S id="first">\nFirst body — café.\n</S>';
const RANGE_BETWEEN = "\n\n";
const RANGE_EMPTY_CONSTRUCT = '<S id="empty" />';
const RANGE_SUFFIX = "\n\nTail prose.\n";
const RANGE_SOURCE =
  RANGE_IMPORT_LINE +
  RANGE_PREFIX +
  RANGE_FIRST_CONSTRUCT +
  RANGE_BETWEEN +
  RANGE_EMPTY_CONSTRUCT +
  RANGE_SUFFIX;

const RANGE_IMPORT_TARGET = '<S id="base">\nBase text.\n</S>\n';

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// Zero-based byte offsets, start-inclusive and end-exclusive (SPEC 1.7).
const FIRST_START = utf8Length(RANGE_IMPORT_LINE + RANGE_PREFIX);
const FIRST_RANGE = {
  start: FIRST_START,
  end: FIRST_START + utf8Length(RANGE_FIRST_CONSTRUCT),
};
const EMPTY_START = FIRST_RANGE.end + utf8Length(RANGE_BETWEEN);
const EMPTY_RANGE = {
  start: EMPTY_START,
  end: EMPTY_START + utf8Length(RANGE_EMPTY_CONSTRUCT),
};
const ROOT_RANGE = { start: 0, end: utf8Length(RANGE_SOURCE) };

const T1_7_1 = defineProductTest({
  id: "T1.7-1",
  title:
    "source ranges are zero-based byte offsets, start-inclusive end-exclusive: opening through closing tag for a section, exactly the self-closing tag, the entire file for the root — equal via `query node` and `show` (SPEC 1.7, 11, 12.4)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": RANGE_SOURCE,
        "specs/BASE.mdx": RANGE_IMPORT_TARGET,
      },
    });
    try {
      await buildOk(product, workspace, "T1.7-1 `build`");
      const expectations: ReadonlyArray<{
        readonly identity: string;
        readonly range: { readonly start: number; readonly end: number };
        readonly what: string;
      }> = [
        {
          identity: "specs/A.mdx#first",
          range: FIRST_RANGE,
          what: "the section construct's own characters, from the first character of its opening tag through the last character of its closing tag",
        },
        {
          identity: "specs/A.mdx#empty",
          range: EMPTY_RANGE,
          what: "exactly the self-closing tag's own characters",
        },
        {
          identity: "specs/A.mdx",
          range: ROOT_RANGE,
          what: "the entire file — start 0, end the file's byte length",
        },
      ];
      for (const expectation of expectations) {
        const node = await queryNode(
          product,
          workspace,
          expectation.identity,
          "T1.7-1",
        );
        assertSameJson(
          node.sourceRange,
          expectation.range,
          `T1.7-1 \`query node ${expectation.identity}\` source range — ${expectation.what}; ` +
            `zero-based byte offsets, start-inclusive and end-exclusive, so line/column ` +
            `pairs, 1-based, code-point-based, UTF-16, compiled-output, or end-inclusive ` +
            `ranges all fail (SPEC 1.7)`,
        );
        const showLabel = `T1.7-1 \`show ${expectation.identity} --json\``;
        const shown = decodeNodeReport(
          await runJson(
            product,
            workspace,
            ["show", expectation.identity, "--json"],
            showLabel,
          ),
          showLabel,
        );
        assertSameJson(
          shown.sourceRange,
          expectation.range,
          `${showLabel}: source range equals \`query node\`'s (SPEC 1.7, 12.4)`,
        );
      }
    } finally {
      await workspace.dispose();
    }
  },
});

/** TEST-SPEC §1.6–1.7, in canonical ID order (SUITE-05). */
export const section16to17Tests: readonly ProductTestEntry[] = [
  T1_6_1,
  T1_6_2,
  T1_6_3,
  T1_6_4,
  T1_6_5,
  T1_7_1,
];
