// TEST-SPEC §6.4 (rename) — SUITE-24: T6.4-1…T6.4-7.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 6.4: `xspec rename <file> <old-id> <new-id>` renames a requirement ID,
// rewrites descendant IDs by prefix replacement, rewrites every reference to
// the affected identities across all configured spec and code sources (`id`
// attributes, `d` references, `text(...)` references, TypeScript markers),
// and appends the mapping to the journal. Rewrites are minimal in-place
// edits, preserving each reference's quote style and access form (2.4); where
// a form cannot be kept, the rewritten part uses dot access for segments that
// are valid TypeScript identifiers, double-quoted computed access for
// segments that are not, and double-quoted string literals. Type-level
// references record no edges and are not rewritten. A nonexistent `<file>` or
// old ID is a usage error (12.0) checked before source validation, but an old
// ID inside an unparseable origin file is masked (14.20, 14); every other
// validation failure refuses the rename (exit 1), the valid-workspace
// precondition included, before modifying anything. A successful rename
// finishes by regenerating derived files exactly as `xspec build` does.
//
// Conservative operationalizations (noted per H-4):
// - T6.4-1 "all edges retarget (query-asserted)": the workspace-wide edge set
//   of each dependency kind (`query edges --kinds depends|embeds|references`)
//   is asserted exactly, before and after the rename; `contains` retargeting
//   is asserted through the full incoming/outgoing edge sets of the two
//   renamed nodes (`query node`), whose contains inventory the fixture pins
//   completely — the workspace-wide `contains` inventory (root edges
//   included) is §11's business, not this test's.
// - T6.4-1 "mapping appended to journal" uses the SUITE-21
//   operationalization: the journal (absent before the first journaled
//   operation, SPEC 6.1) exists as a plain file holding exactly one
//   line-oriented entry after the one rename; entry content stays opaque
//   (H-4).
// - T6.4-2 stages every *affected* reference part in dot access or
//   double-quoted form, so each expected byte is pinned whichever way 6.4's
//   preserve-then-default rule is read; single-quoted spellings appear only
//   in untouched parts and untouched references, whose byte-wise preservation
//   T6.4-2 pins explicitly. Whole rewritten source files are compared
//   byte-exactly ("only the affected parts change" pins all other bytes).
// - T6.4-3/T6.4-6 "modifies nothing" is a whole-workspace-root byte snapshot
//   compare around the refused command, with the pre-refusal `build`'s
//   derived files present — a product that rewrites before validating, or
//   regenerates on refusal, fails the compare. Refusal report content is
//   deliberately unasserted (12.0 classes refusals exit 1; TEST-SPEC pins no
//   report content for them), so refusal arms run without `--json`.
// - T6.4-4 exit-2 arms run with `--json`: stdout byte-empty (H-5: no report,
//   no validation findings — the 12.0-ordering discriminator) and the usage
//   error message on stderr (12.0), asserted for presence, not wording. The
//   masking arm asserts exit 1 with a findings report of exactly one 14.20
//   naming the unparseable file with a location (SPEC 14, H-3).
// - T6.4-7 "byte-identical to a fresh build of the rewritten sources" is the
//   H-6 two-directory protocol: a second workspace is seeded with the
//   post-rename configuration, sources, and journal (derived files are
//   reproducible from sources, configuration, and the journal, SPEC 13.4),
//   `xspec build` runs there, and the two workspace roots are compared as
//   whole byte trees — generated modules, Markdown output, and graph data
//   all included, normalizing nothing.

import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { GraphEdge, NodeReport } from "../../helpers/adapters/index.js";
import {
  decodeEdgesReport,
  decodeFindingsReport,
  decodeNodeReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import {
  assertFileBytes,
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import {
  assertDirectoriesEqual,
  assertLeavesUnchanged,
} from "../../helpers/snapshot.js";
import type { ProductBinding, RunResult } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertEdgeSetEqual,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// One spec group plus one code group (SPEC 7.2), for fixtures whose rewrites
// span MDX and TypeScript sources.
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

// Exactly one spec group (SPEC 7), for the refusal and usage-error fixtures.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// Specs, code, and Markdown emission (SPEC 7.3), so T6.4-7's compare covers
// generated modules, Markdown output, and graph data alike.
const FULL_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  markdown: { emit: true }
})
`;

const JOURNAL_PATH = ".xspec/journal";
const LF = 0x0a;

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
 * Read the journal's exact bytes, failing diagnosed (H-8) when the path does
 * not hold a plain file (SPEC 6.1: the file comes into existence with the
 * first journaled operation; 13.4: durable files are plain files).
 */
async function readJournal(
  workspace: TestWorkspace,
  context: string,
): Promise<Uint8Array> {
  const kind = await workspace.kind(JOURNAL_PATH);
  if (kind !== "file") {
    fail(
      `${context}: expected the journal as a plain file at ${JOURNAL_PATH} ` +
        `(SPEC 6.1, 13.4); found ${kind}`,
    );
  }
  return await workspace.readBytes(JOURNAL_PATH);
}

/**
 * Lines in a line-oriented file, tolerating a terminated or unterminated
 * final line (0 for an empty file) — the fixed H-4 operationalization of
 * "one entry per line" (SUITE-21).
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
 * The workspace's complete edge set of one dependency kind, via
 * `query edges --kinds <kind>` (SPEC 11). Asserted against an exact expected
 * set, this pins every recorded edge of the kind — none missing, none
 * phantom, no duplicates (edges of each kind form a set, SPEC 5.2).
 */
async function queryEdgesOfKind(
  product: ProductBinding,
  workspace: TestWorkspace,
  kind: "depends" | "embeds" | "references",
  context: string,
): Promise<readonly GraphEdge[]> {
  const label = `${context} \`query edges --kinds ${kind}\``;
  return decodeEdgesReport(
    await runJson(
      product,
      workspace,
      ["query", "edges", "--kinds", kind],
      label,
    ),
    label,
  );
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

/**
 * Assert `query nodes` enumerates exactly the expected requirement-node
 * identities (SPEC 11; the workspace-relative identity form of SPEC 1.5).
 */
async function assertNodeIdentities(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: readonly string[],
  reason: string,
  context: string,
): Promise<void> {
  const label = `${context} \`query nodes\``;
  const rows = decodeNodeRowsReport(
    await runJson(product, workspace, ["query", "nodes"], label),
    label,
  );
  assertSameJson(
    sortedIdentities(rows),
    [...expected].sort(),
    `${label}: ${reason}`,
  );
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

/**
 * Premise check that the rename rewrote a source's references (SPEC 6.4):
 * the stale spelling is gone and the rewritten spelling is present.
 * Deliberately substring-level (byte-exact rewrite content is T6.4-2's
 * business); this makes a missing rewrite fail with a crisp diagnosis ahead
 * of the query-level assertions.
 */
function assertRewriteHappened(
  text: string,
  rel: string,
  staleSpelling: string,
  rewrittenSpelling: string,
  context: string,
): void {
  if (text.includes(staleSpelling)) {
    fail(
      `${context}: ${rel} still contains the stale spelling ` +
        `${JSON.stringify(staleSpelling)} — the rename rewrites every ` +
        `reference to the affected identities across all configured spec and ` +
        `code sources (SPEC 6.4)`,
    );
  }
  if (!text.includes(rewrittenSpelling)) {
    fail(
      `${context}: ${rel} does not contain the rewritten spelling ` +
        `${JSON.stringify(rewrittenSpelling)} (SPEC 6.4)`,
    );
  }
}

/**
 * A refused rename (SPEC 6.4: every validation failure beyond the argument
 * existence checks refuses with exit 1): assert exit 1 exactly and that the
 * refusal modifies nothing — a whole-workspace-root byte snapshot compare
 * around the command (derived files, sources, and the journal's absence all
 * included).
 */
async function expectRefusalModifiesNothing(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  context: string,
): Promise<void> {
  const command = argv.join(" ");
  await assertLeavesUnchanged(
    workspace.root,
    async () =>
      await expectExit(
        product,
        workspace,
        argv,
        1,
        `${context}: \`${command}\` — the refusal is a validation failure, ` +
          `exit 1 (SPEC 6.4, 12.0)`,
      ),
    `${context}: \`${command}\` refused — modifies nothing (SPEC 6.4)`,
  );
}

/**
 * A rename usage error (SPEC 6.4, 12.0: nonexistent `<file>` or old ID): run
 * with `--json`, assert exit 2 exactly, byte-empty stdout (H-5: no report and
 * no validation findings — the 12.0-ordering discriminator), and a usage
 * error message on stderr (12.0: standard-error content; presence, not
 * wording).
 */
async function expectRenameUsageError(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  context: string,
): Promise<RunResult> {
  const command = argv.join(" ");
  const result = await expectExit(
    product,
    workspace,
    [...argv, "--json"],
    2,
    `${context}: \`${command} --json\` — a nonexistent <file> or old ID is a ` +
      `usage error (SPEC 6.4, 12.0)`,
  );
  assertStdoutEmpty(
    result,
    `${context}: \`${command} --json\` — under --json, stdout is byte-empty ` +
      `on exit 2: the usage error emits no report and no validation findings ` +
      `(SPEC 12.0, H-5)`,
  );
  if (result.stderrBytes.length === 0) {
    fail(
      `${context}: \`${command} --json\` — usage error messages are ` +
        `standard-error content (SPEC 12.0), but stderr is empty`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// T6.4-1 — rewrites
// ---------------------------------------------------------------------------

// The rename subject `core.mid` is mid-tree with a descendant (prefix
// replacement) and carries a local string `d` itself (the rewritten *source*
// of an edge). References to the affected identities cover every listed
// surface: local string references (`d` and `text(...)` in the same file),
// external chain references in another spec file (`d` and `text(...)`), and
// a TS marker plus a TS `text(...)` call in a code file (SPEC 6.4).
const R1_CORE = "specs/Core.mdx";
const R1_REFS = "specs/Refs.mdx";
const R1_APP = "src/app.ts";

const R1_CORE_SOURCE = [
  '<S id="core">',
  "Core holder text.",
  "",
  '<S id="core.mid" d={"core.plain"}>',
  "Mid text.",
  "",
  '<S id="core.mid.leaf">',
  "Leaf text.",
  "</S>",
  "</S>",
  "",
  '<S id="core.sib" d={"core.mid"}>',
  'Sib embeds: {text("core.mid.leaf")}',
  "</S>",
  "",
  '<S id="core.plain">',
  "Plain text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const R1_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={Core.core.mid}>',
  "Refs embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "",
].join("\n");

const R1_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

const R1_UNCHANGED_IDENTITIES = [
  "specs/Core.mdx",
  "specs/Core.mdx#core",
  "specs/Core.mdx#core.sib",
  "specs/Core.mdx#core.plain",
  "specs/Refs.mdx",
  "specs/Refs.mdx#refs",
];
const R1_PRE_IDENTITIES = [
  ...R1_UNCHANGED_IDENTITIES,
  "specs/Core.mdx#core.mid",
  "specs/Core.mdx#core.mid.leaf",
];
const R1_POST_IDENTITIES = [
  ...R1_UNCHANGED_IDENTITIES,
  "specs/Core.mdx#core.hub",
  "specs/Core.mdx#core.hub.leaf",
];

/** The fixture's complete dependency-kind edge sets, parameterized on the
 * renamed identities (`mid` pre-rename, `hub` post-rename). */
function r1Edges(
  subject: string,
  leaf: string,
): {
  depends: GraphEdge[];
  embeds: GraphEdge[];
  references: GraphEdge[];
} {
  return {
    depends: [
      { from: subject, to: "specs/Core.mdx#core.plain", kind: "depends" },
      { from: "specs/Core.mdx#core.sib", to: subject, kind: "depends" },
      { from: "specs/Refs.mdx#refs", to: subject, kind: "depends" },
    ],
    embeds: [
      { from: "specs/Core.mdx#core.sib", to: leaf, kind: "embeds" },
      { from: "specs/Refs.mdx#refs", to: leaf, kind: "embeds" },
      { from: "src/app.ts", to: subject, kind: "embeds" },
    ],
    references: [{ from: "src/app.ts", to: leaf, kind: "references" }],
  };
}

/** Assert the workspace-wide edge set of each dependency kind (SPEC 5.2, 11). */
async function assertDependencyEdges(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: ReturnType<typeof r1Edges>,
  context: string,
): Promise<void> {
  for (const kind of ["depends", "embeds", "references"] as const) {
    assertEdgeSetEqual(
      await queryEdgesOfKind(product, workspace, kind, context),
      expected[kind],
      `${context}: the workspace's complete \`${kind}\` edge set — every ` +
        `edge whose endpoint is a renamed identity retargets to the new ` +
        `identity, sources and targets alike (SPEC 6.4, 5.2)`,
    );
  }
}

const T6_4_1 = defineProductTest({
  id: "T6.4-1",
  title:
    "rewrites: renaming a mid-tree ID rewrites its `id`, all descendant `id`s by prefix replacement, local string references, external chain references in other files, `text(...)` targets in MDX and TS, and TS markers — the workspace builds, all edges retarget (query-asserted), and the mapping is appended to the journal (SPEC 6.4, 6.1)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [R1_CORE]: R1_CORE_SOURCE,
        [R1_REFS]: R1_REFS_SOURCE,
        [R1_APP]: R1_APP_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.4-1 `build` over the staged workspace",
        );

        // Staging premises: no journal before the first journaled operation
        // (SPEC 6.1); the pre-rename node and edge inventories are exactly as
        // staged, so "retarget" below is a real transition.
        const journalBefore = await workspace.kind(JOURNAL_PATH);
        if (journalBefore !== "absent") {
          fail(
            `T6.4-1: staging premise — no journal file exists before the ` +
              `first journaled operation (SPEC 6.1); found ${journalBefore} ` +
              `at ${JOURNAL_PATH}`,
          );
        }
        await assertNodeIdentities(
          product,
          workspace,
          R1_PRE_IDENTITIES,
          "staging premise — the pre-rename enumeration is exactly the " +
            "staged node set (SPEC 11, 1.5)",
          "T6.4-1 pre-rename",
        );
        await assertDependencyEdges(
          product,
          workspace,
          r1Edges("specs/Core.mdx#core.mid", "specs/Core.mdx#core.mid.leaf"),
          "T6.4-1 pre-rename",
        );

        await expectExit(
          product,
          workspace,
          ["rename", "specs/Core.mdx", "core.mid", "core.hub"],
          0,
          "T6.4-1 `rename specs/Core.mdx core.mid core.hub`",
        );

        // The rewrites, per source surface: stale spellings gone, rewritten
        // spellings present (byte-exact edit content is T6.4-2's business).
        for (const [rel, surface] of [
          [R1_CORE, "`id` attributes and local string references"],
          [R1_REFS, "external chain references and the MDX `text(...)` target"],
          [R1_APP, "the TS marker and the TS `text(...)` target"],
        ] as const) {
          assertRewriteHappened(
            await readSourceText(workspace, rel, "T6.4-1 rewrite check"),
            rel,
            "core.mid",
            "core.hub",
            `T6.4-1 rewrite check (${surface})`,
          );
        }

        // Mapping appended to the journal: the file came into existence with
        // this first journaled operation and holds exactly one line-oriented
        // entry (SPEC 6.1; entry content opaque, H-4).
        const journal = await readJournal(workspace, "T6.4-1 after the rename");
        const lines = journalLineCount(journal);
        if (lines !== 1) {
          fail(
            `T6.4-1: the rename must append its mapping to the journal as ` +
              `exactly one line-oriented entry — the journal came into ` +
              `existence with this first journaled operation (SPEC 6.4, 6.1); ` +
              `found ${String(lines)} line(s) in ${String(journal.length)} bytes`,
          );
        }

        // The rewritten workspace builds (SPEC 6.4: rename only ever rewrites
        // a valid workspace into a valid one).
        await buildOk(
          product,
          workspace,
          "T6.4-1 `build` over the rewritten workspace",
        );

        // All identities and all edges retarget (query-asserted).
        await assertNodeIdentities(
          product,
          workspace,
          R1_POST_IDENTITIES,
          "the renamed node and its descendant are enumerated under the new " +
            "identities (prefix replacement) and every other identity is " +
            "unchanged (SPEC 6.4, 1.5)",
          "T6.4-1 post-rename",
        );
        await assertDependencyEdges(
          product,
          workspace,
          r1Edges("specs/Core.mdx#core.hub", "specs/Core.mdx#core.hub.leaf"),
          "T6.4-1 post-rename",
        );

        // The renamed nodes' complete edge inventories, `contains` included
        // (the fixture pins them fully; module header, H-4).
        const hub = await queryNode(
          product,
          workspace,
          "specs/Core.mdx#core.hub",
          "T6.4-1 post-rename",
        );
        assertEdgeSetEqual(
          hub.incomingEdges,
          [
            {
              from: "specs/Core.mdx#core",
              to: "specs/Core.mdx#core.hub",
              kind: "contains",
            },
            {
              from: "specs/Core.mdx#core.sib",
              to: "specs/Core.mdx#core.hub",
              kind: "depends",
            },
            {
              from: "specs/Refs.mdx#refs",
              to: "specs/Core.mdx#core.hub",
              kind: "depends",
            },
            {
              from: "src/app.ts",
              to: "specs/Core.mdx#core.hub",
              kind: "embeds",
            },
          ],
          "T6.4-1: the renamed node's incoming edges — `contains` from its " +
            "parent and every dependency edge — retarget to the new identity " +
            "(SPEC 6.4, 5.2)",
        );
        assertEdgeSetEqual(
          hub.outgoingEdges,
          [
            {
              from: "specs/Core.mdx#core.hub",
              to: "specs/Core.mdx#core.hub.leaf",
              kind: "contains",
            },
            {
              from: "specs/Core.mdx#core.hub",
              to: "specs/Core.mdx#core.plain",
              kind: "depends",
            },
          ],
          "T6.4-1: the renamed node's outgoing edges originate at the new " +
            "identity — its `contains` to the re-identified descendant and " +
            "its own `d` edge (SPEC 6.4, 5.2)",
        );
        const leaf = await queryNode(
          product,
          workspace,
          "specs/Core.mdx#core.hub.leaf",
          "T6.4-1 post-rename",
        );
        assertEdgeSetEqual(
          leaf.incomingEdges,
          [
            {
              from: "specs/Core.mdx#core.hub",
              to: "specs/Core.mdx#core.hub.leaf",
              kind: "contains",
            },
            {
              from: "specs/Core.mdx#core.sib",
              to: "specs/Core.mdx#core.hub.leaf",
              kind: "embeds",
            },
            {
              from: "specs/Refs.mdx#refs",
              to: "specs/Core.mdx#core.hub.leaf",
              kind: "embeds",
            },
            {
              from: "src/app.ts",
              to: "specs/Core.mdx#core.hub.leaf",
              kind: "references",
            },
          ],
          "T6.4-1: the re-identified descendant's incoming edges — MDX and " +
            "TS `text(...)` targets and the TS marker — retarget to the new " +
            "identity (SPEC 6.4, 5.2)",
        );
        assertEdgeSetEqual(
          leaf.outgoingEdges,
          [],
          "T6.4-1: the re-identified descendant has no outgoing edges",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-2 — minimal edits (byte-exact)
// ---------------------------------------------------------------------------

// Arm A: the new segment `neo` is a valid TypeScript identifier, so every
// staged form is keepable and every rewrite is the minimal in-place edit —
// dot stays dot, double-quoted computed stays double-quoted computed,
// double-quoted string literals stay double-quoted. Untouched parts carry the
// contrasting spellings (single-quoted computed segments before and after the
// affected segment, a single-quoted local string, a whole untouched
// single-quoted-computed reference) and must be preserved byte-wise.
const M2A_CORE_BEFORE = [
  '<S id="top">',
  "Top text.",
  "",
  '<S id="top.mid">',
  "Mid text.",
  "",
  '<S id="top.mid.kid-x">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="top.aid" d={["top.mid", \'top.res\']}>',
  "Embeds: {text(\"top.mid.kid-x\")} and {text('top.res')}",
  "</S>",
  "",
  '<S id="top.res">',
  "Res text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const M2A_CORE_AFTER = [
  '<S id="top">',
  "Top text.",
  "",
  '<S id="top.neo">',
  "Mid text.",
  "",
  '<S id="top.neo.kid-x">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="top.aid" d={["top.neo", \'top.res\']}>',
  "Embeds: {text(\"top.neo.kid-x\")} and {text('top.res')}",
  "</S>",
  "",
  '<S id="top.res">',
  "Res text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const M2A_REFS_BEFORE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={[Core.top.mid, Core.top["mid"], Core[\'top\'].mid]}>',
  'Embeds: {text(Core.top.mid["kid-x"])}',
  "Also: {text(Core.top.mid['kid-x'])}",
  "Watch: {text(Core.top['res'])}",
  "</S>",
  "",
].join("\n");

const M2A_REFS_AFTER = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={[Core.top.neo, Core.top["neo"], Core[\'top\'].neo]}>',
  'Embeds: {text(Core.top.neo["kid-x"])}',
  "Also: {text(Core.top.neo['kid-x'])}",
  "Watch: {text(Core.top['res'])}",
  "</S>",
  "",
].join("\n");

const M2A_APP_BEFORE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.top.mid;",
  'CORE.top.mid["kid-x"];',
  "CORE['top'].mid;",
  'text(CORE.top["mid"]);',
  "",
].join("\n");

const M2A_APP_AFTER = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.top.neo;",
  'CORE.top.neo["kid-x"];',
  "CORE['top'].neo;",
  'text(CORE.top["neo"]);',
  "",
].join("\n");

// Arm B: the new segment `neo-2` is not a TypeScript identifier. A dot-access
// affected part cannot keep its form and is written as double-quoted computed
// access; a double-quoted computed affected part keeps its form; untouched
// dot parts after the converted segment, and string-literal forms (which hold
// any segment), are preserved.
const M2B_CORE_BEFORE = [
  '<S id="top">',
  "Top text.",
  "",
  '<S id="top.mid">',
  "Mid text.",
  "",
  '<S id="top.mid.kid">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="top.aid" d={"top.mid"}>',
  'Embeds: {text("top.mid.kid")}',
  "</S>",
  "</S>",
  "",
].join("\n");

const M2B_CORE_AFTER = [
  '<S id="top">',
  "Top text.",
  "",
  '<S id="top.neo-2">',
  "Mid text.",
  "",
  '<S id="top.neo-2.kid">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="top.aid" d={"top.neo-2"}>',
  'Embeds: {text("top.neo-2.kid")}',
  "</S>",
  "</S>",
  "",
].join("\n");

const M2B_REFS_BEFORE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={[Core.top.mid, Core.top["mid"]]}>',
  "Embeds: {text(Core.top.mid.kid)}",
  "</S>",
  "",
].join("\n");

const M2B_REFS_AFTER = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={[Core.top["neo-2"], Core.top["neo-2"]]}>',
  'Embeds: {text(Core.top["neo-2"].kid)}',
  "</S>",
  "",
].join("\n");

const M2B_APP_BEFORE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.top.mid;",
  "text(CORE.top.mid.kid);",
  "",
].join("\n");

const M2B_APP_AFTER = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  'CORE.top["neo-2"];',
  'text(CORE.top["neo-2"].kid);',
  "",
].join("\n");

/** One T6.4-2 arm: stage, build, rename, byte-compare every rewritten file. */
async function runMinimalEditArm(
  product: ProductBinding,
  newId: string,
  sources: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  context: string,
): Promise<void> {
  await withWorkspace(SPEC_AND_CODE_CONFIG, sources, async (workspace) => {
    await buildOk(product, workspace, `${context}: \`build\``);
    await expectExit(
      product,
      workspace,
      ["rename", "specs/Core.mdx", "top.mid", newId],
      0,
      `${context}: \`rename specs/Core.mdx top.mid ${newId}\``,
    );
    for (const [rel, bytes] of Object.entries(expected)) {
      await assertFileBytes(
        workspace.path(rel),
        bytes,
        `${context}: ${rel} after the rename — rewrites are minimal in-place ` +
          `edits: quote style and access form of untouched reference parts ` +
          `are preserved byte-wise and only the affected parts change; where ` +
          `a form cannot be kept, a non-identifier segment is written as ` +
          `double-quoted computed access (SPEC 6.4, 2.4; H-4)`,
      );
    }
  });
}

const T6_4_2 = defineProductTest({
  id: "T6.4-2",
  title:
    "minimal edits: quote style (single vs double) and access form (dot vs computed) of untouched reference parts are preserved byte-wise and only the affected parts change; where the form cannot be kept, a new segment that is not a TS identifier is written as double-quoted computed access (SPEC 6.4, 2.4)",
  run: async (product) => {
    // Arm A: keepable forms — every rewrite is the in-place minimal edit.
    await runMinimalEditArm(
      product,
      "top.neo",
      {
        "specs/Core.mdx": M2A_CORE_BEFORE,
        "specs/Refs.mdx": M2A_REFS_BEFORE,
        "src/app.ts": M2A_APP_BEFORE,
      },
      {
        "specs/Core.mdx": M2A_CORE_AFTER,
        "specs/Refs.mdx": M2A_REFS_AFTER,
        "src/app.ts": M2A_APP_AFTER,
      },
      "T6.4-2 identifier-segment arm (top.mid → top.neo)",
    );

    // Arm B: the dot form cannot hold `neo-2` — double-quoted computed access.
    await runMinimalEditArm(
      product,
      "top.neo-2",
      {
        "specs/Core.mdx": M2B_CORE_BEFORE,
        "specs/Refs.mdx": M2B_REFS_BEFORE,
        "src/app.ts": M2B_APP_BEFORE,
      },
      {
        "specs/Core.mdx": M2B_CORE_AFTER,
        "specs/Refs.mdx": M2B_REFS_AFTER,
        "src/app.ts": M2B_APP_AFTER,
      },
      "T6.4-2 non-identifier-segment arm (top.mid → top.neo-2)",
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-3 — validation refusals (exit 1, nothing modified)
// ---------------------------------------------------------------------------

// A valid workspace whose staged IDs isolate each refusal cause: `a.then`
// fails only 1.4 (forbidden name), `a.mi d` only 1.4 (whitespace), `a.mid`
// only the differs-from-old check, `a.sib` only the collision check, `x.mid`
// and `b.c` only the structural parent rules. The remaining 6.4 clause — all
// rewritten references resolve — admits no discriminating fixture (TEST-SPEC
// T6.4-3) and is exercised as the always-passing side of T6.4-1.
const V3_FILE = "specs/A.mdx";
const V3_SOURCE = [
  '<S id="a">',
  "Holder text.",
  "",
  '<S id="a.mid">',
  "Mid text.",
  "",
  '<S id="a.mid.kid">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="a.sib">',
  "Sib text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T6_4_3 = defineProductTest({
  id: "T6.4-3",
  title:
    "validation refusals (exit 1): a new ID that is invalid (1.4), equal to the old ID, colliding with an existing ID, or violating structural parent rules each refuses the rename and modifies nothing (workspace byte-compare) (SPEC 6.4, 1.4, 1.3, 12.0)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [V3_FILE]: V3_SOURCE },
      async (workspace) => {
        // Build first, so the modifies-nothing compares include intact
        // derived files (module header, H-4).
        await buildOk(
          product,
          workspace,
          "T6.4-3 `build` over the staged workspace",
        );

        const cases: readonly (readonly [string, string])[] = [
          [
            "a.then",
            "new ID invalid per 1.4 — its segment is the forbidden name `then`",
          ],
          [
            "a.mi d",
            "new ID invalid per 1.4 — its segment contains whitespace",
          ],
          ["a.mid", "new ID equal to the old ID"],
          ["a.sib", "new ID colliding with an existing ID in the file"],
          [
            "x.mid",
            "new ID violating the structural parent rules — the node is nested " +
              "inside `a`, so its ID must be `a` plus one segment (1.3)",
          ],
        ];
        for (const [newId, reason] of cases) {
          await expectRefusalModifiesNothing(
            product,
            workspace,
            ["rename", V3_FILE, "a.mid", newId],
            `T6.4-3 (${reason})`,
          );
        }
        // The top-level structural arm: a top-level section's ID is checked
        // against the empty prefix — exactly one segment (SPEC 1.3).
        await expectRefusalModifiesNothing(
          product,
          workspace,
          ["rename", V3_FILE, "a", "b.c"],
          "T6.4-3 (new ID violating the structural parent rules — a " +
            "top-level section's ID has exactly one segment, 1.3)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-4 — usage errors (exit 2) and unparseable-origin masking
// ---------------------------------------------------------------------------

const U4_FILE = "specs/A.mdx";
const U4_SOURCE = [
  '<S id="a">',
  "Alpha text.",
  "",
  '<S id="a.mid">',
  "Mid text.",
  "</S>",
  "</S>",
  "",
].join("\n");

// The ordering arm's unrelated validation error: an unresolved local `d`
// reference (14.5) in a file untouched by the rename arguments.
const U4_BAD_FILE = "specs/Bad.mdx";
const U4_BAD_SOURCE = [
  '<S id="bad" d={"nope"}>',
  "Bad text depending on nothing that exists.",
  "</S>",
  "",
].join("\n");

// The masking arm's unparseable origin file: an unclosed section tag (14.20).
const U4_BROKEN_FILE = "specs/Broken.mdx";
const U4_BROKEN_SOURCE = [
  '<S id="broken">',
  "Text that never closes.",
  "",
].join("\n");

const T6_4_4 = defineProductTest({
  id: "T6.4-4",
  title:
    "usage errors (exit 2): a nonexistent `<file>` and a nonexistent old ID are usage errors checked before source validation — the same exit 2 even when the workspace also has unrelated validation errors (12.0 ordering) — but an old ID inside an unparseable origin file is masked: the validation findings are reported and the command exits 1 (SPEC 6.4, 12.0, 14, 14.20)",
  run: async (product) => {
    // --- Base arm: a valid workspace ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [U4_FILE]: U4_SOURCE },
      async (workspace) => {
        const context = "T6.4-4 valid-workspace arm";
        await buildOk(product, workspace, `${context}: \`build\``);
        await expectRenameUsageError(
          product,
          workspace,
          ["rename", "specs/Missing.mdx", "a", "a2"],
          `${context}, nonexistent <file>`,
        );
        await expectRenameUsageError(
          product,
          workspace,
          ["rename", U4_FILE, "nope", "nope2"],
          `${context}, nonexistent old ID`,
        );
      },
    );

    // --- Ordering arm: the workspace also fails build validation ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [U4_FILE]: U4_SOURCE, [U4_BAD_FILE]: U4_BAD_SOURCE },
      async (workspace) => {
        const context = "T6.4-4 ordering arm";
        // Staging premise: the workspace really fails build validation, so
        // the exit-2/empty-stdout observations below discriminate — a
        // product that validates sources before the argument existence
        // checks exits 1 with these findings instead.
        const findings = await buildFindings(
          product,
          workspace,
          `${context}: \`build --json\` premise — the staged workspace fails ` +
            `build validation (unresolved d reference, SPEC 14.5)`,
        );
        if (findings.length === 0) {
          fail(
            `${context}: staging premise — the failing \`build\` must report ` +
              `at least one validation finding (SPEC 14)`,
          );
        }
        await expectRenameUsageError(
          product,
          workspace,
          ["rename", "specs/Missing.mdx", "a", "a2"],
          `${context}, nonexistent <file> with unrelated validation errors ` +
            `present — the existence checks precede source validation (12.0)`,
        );
        await expectRenameUsageError(
          product,
          workspace,
          ["rename", U4_FILE, "nope", "nope2"],
          `${context}, nonexistent old ID with unrelated validation errors ` +
            `present — the existence checks precede source validation (12.0)`,
        );
      },
    );

    // --- Masking arm: the old ID lives inside an unparseable origin file ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [U4_FILE]: U4_SOURCE, [U4_BROKEN_FILE]: U4_BROKEN_SOURCE },
      async (workspace) => {
        const context = "T6.4-4 masking arm";
        const command = `rename ${U4_BROKEN_FILE} broken broken2 --json`;
        const result = await expectExit(
          product,
          workspace,
          ["rename", U4_BROKEN_FILE, "broken", "broken2", "--json"],
          1,
          `${context}: \`${command}\` — an old ID inside an unparseable ` +
            `origin file (14.20) is masked: the validation findings are ` +
            `reported and the command exits 1, not 2 (SPEC 6.4, 12.0, 14)`,
        );
        const findings = decodeFindingsReport(
          parseJsonStdout(result, `${context}: \`${command}\``),
          `${context}: \`${command}\``,
        ).findings;
        assertConditionCounts(
          findings,
          { "14.20": 1 },
          `${context}: the reported findings are exactly the workspace's one ` +
            `unparseable-source condition (SPEC 14.20; the unparseable file ` +
            `masks the conditions inside itself, SPEC 14)`,
        );
        assertFindingLocated(
          findings[0]!,
          { file: U4_BROKEN_FILE },
          `${context}: the 14.20 finding identifies the unparseable origin ` +
            `file and the location of the parse failure (SPEC 14, 14.20)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-5 — type-level references
// ---------------------------------------------------------------------------

const T5_CORE = "specs/Core.mdx";
const T5_CORE_SOURCE = [
  '<S id="core">',
  "Core text.",
  "",
  '<S id="core.mid">',
  "Mid text.",
  "</S>",
  "</S>",
  "",
].join("\n");

// One code file bearing a value-level marker (rewritten, 6.4) and a
// `typeof`-level reference to the same node (not rewritten, 4.5) — the
// contrast within one file discriminates a product that rewrites type-level
// chains from one that skips the file entirely (whose stale marker would then
// fail T6.4-1-style rewriting and the `check` below).
const T5_APP = "src/app.ts";
const T5_APP_BEFORE = [
  'import CORE from "../specs/Core.xspec";',
  "",
  "CORE.core.mid;",
  "type MidNode = typeof CORE.core.mid;",
  "",
].join("\n");
const T5_APP_AFTER = [
  'import CORE from "../specs/Core.xspec";',
  "",
  "CORE.core.hub;",
  "type MidNode = typeof CORE.core.mid;",
  "",
].join("\n");

const T6_4_5 = defineProductTest({
  id: "T6.4-5",
  title:
    "type-level references: a `typeof`-level reference to the old identity is not rewritten by rename, and the workspace stays xspec-valid — the consumer type error is outside xspec's validations, so `build` and `check` report no finding for it (SPEC 6.4, 4.5)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { [T5_CORE]: T5_CORE_SOURCE, [T5_APP]: T5_APP_BEFORE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.4-5 `build` over the staged workspace",
        );
        await expectExit(
          product,
          workspace,
          ["rename", T5_CORE, "core.mid", "core.hub"],
          0,
          "T6.4-5 `rename specs/Core.mdx core.mid core.hub`",
        );
        await assertFileBytes(
          workspace.path(T5_APP),
          T5_APP_AFTER,
          "T6.4-5: the code file after the rename — the value-level marker is " +
            "rewritten to the new identity while the `typeof`-level reference " +
            "keeps naming the vacated identity byte-for-byte: type-level " +
            "references record no edges and are not rewritten (SPEC 6.4, 4.5)",
        );
        // The workspace stays xspec-valid: neither `build` nor `check`
        // reports any finding for the type-level reference to the vacated
        // identity (SPEC 6.4: a consumer type error outside xspec's
        // validations; 4.5: type-level references are unrestricted).
        await buildOk(
          product,
          workspace,
          "T6.4-5 `build` after the rename — no finding for the type-level " +
            "reference to the vacated identity",
        );
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T6.4-5 `check` after the rename — no finding for the type-level " +
            "reference to the vacated identity (SPEC 6.4, 4.5, 12.2)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-6 — valid-workspace precondition
// ---------------------------------------------------------------------------

const P6_FILE = "specs/A.mdx";
const P6_SOURCE = [
  '<S id="a">',
  "Holder text.",
  "",
  '<S id="a.mid">',
  "Mid text.",
  "</S>",
  "</S>",
  "",
].join("\n");

// Valid at staging (so the pre-refusal `build` succeeds and leaves derived
// files in the snapshot), then overwritten with an unresolved local `d`
// reference (14.5) — the pre-existing validation error elsewhere.
const P6_OTHER_FILE = "specs/Other.mdx";
const P6_OTHER_VALID = ['<S id="oth">', "Other text.", "</S>", ""].join("\n");
const P6_OTHER_INVALID = [
  '<S id="oth" d={"nope"}>',
  "Other text.",
  "</S>",
  "",
].join("\n");

const T6_4_6 = defineProductTest({
  id: "T6.4-6",
  title:
    "valid-workspace precondition: with a pre-existing validation error elsewhere, rename refuses (exit 1) before modifying anything — the rename's own arguments are valid, so the refusal is the 6.4 precondition that rename only ever rewrites a valid workspace (SPEC 6.4, 12.1)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [P6_FILE]: P6_SOURCE, [P6_OTHER_FILE]: P6_OTHER_VALID },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.4-6 `build` over the staged workspace",
        );
        // Introduce the pre-existing validation error elsewhere; the rename
        // subject and its file stay untouched and its arguments valid.
        await workspace.file(P6_OTHER_FILE, P6_OTHER_INVALID);
        await expectRefusalModifiesNothing(
          product,
          workspace,
          ["rename", P6_FILE, "a.mid", "a.hub"],
          "T6.4-6 (the workspace fails the validations of `xspec build` — an " +
            "unresolved d reference in specs/Other.mdx, SPEC 14.5 — so the " +
            "rename refuses before modifying anything: no source rewrite, no " +
            "journal entry, no derived-file change)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.4-7 — finishing regeneration
// ---------------------------------------------------------------------------

const F7_CORE = "specs/Core.mdx";
const F7_REFS = "specs/Refs.mdx";
const F7_APP = "src/app.ts";

const F7_CORE_SOURCE = [
  '<S id="core">',
  "Core holder text.",
  "",
  '<S id="core.mid">',
  "Mid text.",
  "",
  '<S id="core.mid.leaf">',
  "Leaf text.",
  "</S>",
  "</S>",
  "",
  '<S id="core.sib" d={"core.mid"}>',
  'Sib embeds: {text("core.mid.leaf")}',
  "</S>",
  "</S>",
  "",
].join("\n");

const F7_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={Core.core.mid}>',
  "Refs embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "",
].join("\n");

const F7_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

// The non-derived workspace state seeded into the fresh-build directory: the
// configuration, every source file (their post-rename bytes), and the journal
// (derived files are reproducible from sources, configuration, and the
// journal, SPEC 13.4).
const F7_SEED_FILES = [
  "xspec.config.ts",
  F7_CORE,
  F7_REFS,
  F7_APP,
  JOURNAL_PATH,
] as const;

const T6_4_7 = defineProductTest({
  id: "T6.4-7",
  title:
    "finishing regeneration: after a successful rename, generated modules, Markdown output, and graph data are byte-identical to a fresh `build` of the rewritten sources (two-directory whole-tree compare), and `check` immediately after reports no staleness (SPEC 6.4, 12.1, 13.1–13.4, 14.10)",
  run: async (product) => {
    await withWorkspace(
      FULL_CONFIG,
      {
        [F7_CORE]: F7_CORE_SOURCE,
        [F7_REFS]: F7_REFS_SOURCE,
        [F7_APP]: F7_APP_SOURCE,
      },
      async (renamed) => {
        await buildOk(
          product,
          renamed,
          "T6.4-7 `build` over the staged workspace",
        );
        await expectExit(
          product,
          renamed,
          ["rename", F7_CORE, "core.mid", "core.hub"],
          0,
          "T6.4-7 `rename specs/Core.mdx core.mid core.hub`",
        );
        // `check` immediately after the rename: exit 0 — in particular no
        // stale-output finding (14.10): the finishing regeneration left
        // generated modules, Markdown output, and graph data matching the
        // rewritten sources (SPEC 6.4, 12.2).
        await expectExit(
          product,
          renamed,
          ["check"],
          0,
          "T6.4-7 `check` immediately after the rename — no staleness (14.10), " +
            "no other finding",
        );

        // Fresh-build comparison (H-6 two-directory protocol): seed a second
        // workspace with the rewritten sources, configuration, and journal;
        // `build`; compare the whole roots byte-for-byte.
        const fresh = await TestWorkspace.create();
        try {
          for (const rel of F7_SEED_FILES) {
            const kind = await renamed.kind(rel);
            if (kind !== "file") {
              fail(
                `T6.4-7: expected ${rel} as a plain file in the renamed ` +
                  `workspace to seed the fresh-build directory (SPEC 6.4, ` +
                  `6.1, 13.4); found ${kind}`,
              );
            }
            await fresh.file(rel, await renamed.readBytes(rel));
          }
          await buildOk(
            product,
            fresh,
            "T6.4-7 fresh `build` over the rewritten sources",
          );
          await assertDirectoriesEqual(
            renamed.root,
            fresh.root,
            "T6.4-7: the renamed workspace vs a fresh `build` of the " +
              "rewritten sources — generated modules, Markdown output, and " +
              "graph data must be byte-identical (SPEC 6.4: a successful " +
              "rename finishes by regenerating derived files exactly as " +
              "`xspec build` does; 12.0 determinism; H-4/H-6, normalizing " +
              "nothing)",
          );
        } finally {
          await fresh.dispose();
        }
      },
    );
  },
});

/** TEST-SPEC §6.4, in canonical ID order (SUITE-24). */
export const section64Tests: readonly ProductTestEntry[] = [
  T6_4_1,
  T6_4_2,
  T6_4_3,
  T6_4_4,
  T6_4_5,
  T6_4_6,
  T6_4_7,
];
