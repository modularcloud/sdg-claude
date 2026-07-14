// TEST-SPEC §12.1 (`xspec build`) and §12.2 (`xspec check`) — SUITE-43:
// T12.1-1, T12.1-3, T12.1-4, T12.2-1, T12.2-2, T12.2-3.
//
// T12.1-2 (no policy) is a pure cross-reference in TEST-SPEC — its whole text
// is "T7.5-6." — so no separate body is registered here: its content runs as
// T7.5-6 (test/suite/registry/section-7.4-7.5.ts: build succeeds and
// regenerates output on a workspace full of policy violations, only `check`
// reports them), and the H-7 map ties SPEC 12.1's no-policy sentence to that
// test. A registered T12.1-2 body would either re-run T7.5-6 (duplicated
// execution) or pass vacuously against the stub, violating H-8 — the same
// treatment T12.0-10 received (section-12.0-ii.ts).
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 12.1: `build` parses configured sources, validates, resolves
// dependencies, generates TypeScript modules (13.1), optionally emits
// Markdown (13.2), and writes graph data (13.3); rebuilding regenerates every
// derived file and removes recorded derived files that the current sources
// and configuration no longer generate; a failed `build` — validation errors
// (exit 1) or a configuration error (exit 2) — modifies nothing. SPEC 12.2:
// `check` performs all build validations without accepting stale outputs and
// additionally verifies generated-output freshness and orphan absence
// (14.10), reference resolution, acyclicity, journal integrity (14.13),
// policy (14.12), and session integrity (14.21), exiting 1 on any finding;
// SPEC 13.3: `check` never refreshes — it reports staleness instead.
//
// Conservative operationalizations (noted per H-3/H-4):
// - T12.1-1 "downstream commands succeed without rebuilding": after one
//   `build`, the graph-data consumers of SPEC 13.3 that need no git baseline
//   (`check`, `ids`, `show`, `query`, `coverage`, `review list`; `impact`
//   requires `--base`, whose git fixture is T12.0-11/T9's subject) each exit
//   0 with no further `build`, and the whole workspace stays byte-identical
//   around the read block: fresh graph data means no refresh (13.3), so the
//   reads answer from what `build` wrote. (A product rewriting identical
//   bytes passes the byte compare — 12.0 determinism makes rewrites
//   byte-identical — so the compare asserts exactly the no-behavioral-write
//   contract, not scheduling.)
// - T12.1-3's companion sweep: every companion file is named `NAME.xspec.`
//   plus a suffix beside the module (SPEC 13.1), so filtering the source
//   directory's listing by that prefix is a complete companion check without
//   knowing the product's companion set.
// - T12.1-4 and T12.2-3 compare the WHOLE workspace root around the failing
//   `build` / the stale `check`: "every derived file and all graph data
//   byte-identical" plus the facts that sources are product-written only by
//   `rename`/`move` (6.4/6.5) and durable files only by their owning
//   commands (13.4) leave no path a failed `build` or any `check` may
//   legitimately change.
// - T12.2-2 runs one workspace per finding family. Families staged as
//   invalid sources or corrupted durable state cannot fix whether a product
//   additionally reports 14.10 staleness: whether prior derived state is
//   detectably stale when "what the current sources generate" is undefined
//   (invalid sources, unreplayable journal) is not settled by SPEC 13.3/14 —
//   a regeneration-comparing product reports nothing (masked, 14), a
//   hash-comparing product reports staleness. Family assertions therefore
//   count the non-14.10 findings exactly (the family condition may never be
//   missing, and no phantom non-staleness condition is accepted) and set
//   14.10 findings aside. The staleness family itself asserts the reverse:
//   every finding is 14.10, names its file, and instructs rebuilding.
// - The 14.10 arms pin the exact finding where the fixture has exactly one
//   stale file (hand-edited module, hand-deleted module: sources, config,
//   and every other derived file stay fresh). The edited-source and
//   disabled-emission arms cannot enumerate the product's stale set (which
//   companions embed text, and how graph data records derived paths, are
//   opaque — 13.1/13.3), so they assert: all findings are 14.10 and the one
//   file SPEC fixes as stale/orphaned — the emitted Markdown, whose bytes
//   are the compiled source (3, 13.2) — is among the named files.
// - 14.21 identification: the corrupt-session finding must let the user find
//   the session — accepted as the finding naming the session file path or
//   the message naming the session (H-3 information presence, never exact
//   wording). Line-level 14.13 naming is T6.1-3's subject; here the family
//   asserts the condition itself.
// - "All build validations" (T12.2-2's first family) is asserted through
//   representatives with unambiguous finding counts (14.1 missing ID, 14.4
//   invalid segment) staged by editing two files of a previously built valid
//   workspace: the family's discriminating content is the re-validation
//   twist — a product answering from the persisting derived state or graph
//   data would exit 0 — while per-condition breadth is owned by the section
//   1–7 negative tests and T14-1's completeness matrix. The separately
//   listed families (references, cycles, journal, policy, sessions) get
//   their own workspaces below.

import * as fsp from "node:fs/promises";
import type { Finding } from "../../helpers/adapters/index.js";
import { decodeFindingsReport } from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import { assertLeavesUnchanged } from "../../helpers/snapshot.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  buildFindings,
  buildOk,
  expectConfigurationError,
  expectExit,
  readGeneratedModule,
  runJson,
} from "./support.js";

// ---------------------------------------------------------------------------
// Shared fixture material and helpers
// ---------------------------------------------------------------------------

/** One spec group over `specs/`, Markdown emission on or off (SPEC 7, 7.3). */
function markdownConfig(emit: boolean): string {
  return `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: ${String(emit)} }
})
`;
}

/** Stage a fresh workspace with the given files, run `body`, dispose (H-1). */
async function withWorkspace<T>(
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({ files });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/**
 * Run `check --json` expecting findings: exit 1 (findings are exit-1
 * outcomes, SPEC 12.0, 12.2; H-5) with exactly one JSON document as the
 * entire stdout, decoded as the findings report (H-3).
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
    `${context} — \`check\` exits 1 on any finding (SPEC 12.2, 12.0)`,
  );
  return decodeFindingsReport(parseJsonStdout(result, context), context)
    .findings;
}

/**
 * The T12.2-2 family assertion: `check` exits 1 and the non-14.10 findings
 * are exactly the staged family conditions. 14.10 staleness findings are set
 * aside — whether a product reports prior derived state as stale when the
 * staged corruption makes current generation uncomputable is not settled by
 * SPEC (see the module header) — while the family condition may never be
 * missing and no phantom condition is accepted.
 */
async function checkFamilyFindings(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: Readonly<Record<string, number>>,
  context: string,
): Promise<readonly Finding[]> {
  const findings = await checkFindings(product, workspace, context);
  const nonStale = findings.filter((finding) => finding.condition !== "14.10");
  assertConditionCounts(
    nonStale,
    expected,
    `${context} — the staged family conditions, counted over the non-14.10 ` +
      `findings (14.10 staleness against the staged corruption is neither ` +
      `required nor forbidden; see the module header)`,
  );
  return findings;
}

/**
 * Every finding is a 14.10 staleness finding that names its file and
 * instructs rebuilding (SPEC 14.10: "the error names the file and instructs
 * rebuilding" — operationalized as the message naming `build`; `rebuild`
 * qualifies, H-3).
 */
function assertAllStale(findings: readonly Finding[], context: string): void {
  if (findings.length === 0) {
    fail(
      `${context}: expected at least one 14.10 staleness finding — ` +
        `\`check\` verifies generated files are content-identical to what ` +
        `the current sources and configuration generate and reports ` +
        `staleness instead of refreshing (SPEC 12.2, 13.3, 14.10); got none`,
    );
  }
  for (const finding of findings) {
    if (finding.condition !== "14.10") {
      fail(
        `${context}: staleness is the fixture's only staged error condition, ` +
          `so every finding must be 14.10 (SPEC 14.10); got ` +
          `${JSON.stringify(finding.condition)} (message: ${JSON.stringify(finding.message)})`,
      );
    }
    if (finding.file === undefined) {
      fail(
        `${context}: a 14.10 finding names the stale or orphaned file ` +
          `(SPEC 14.10); got a finding without a file (message: ` +
          `${JSON.stringify(finding.message)})`,
      );
    }
    if (!/build/i.test(finding.message)) {
      fail(
        `${context}: a 14.10 finding instructs rebuilding (SPEC 14.10) — ` +
          `any message naming \`build\` qualifies (H-3); got ` +
          `${JSON.stringify(finding.message)}`,
      );
    }
  }
}

/** Exactly one 14.10 finding, naming exactly the given file. */
function assertSingleStaleFile(
  findings: readonly Finding[],
  rel: string,
  context: string,
): void {
  assertAllStale(findings, context);
  if (findings.length !== 1 || findings[0]!.file !== rel) {
    fail(
      `${context}: the fixture's only stale file is ${JSON.stringify(rel)} — ` +
        `sources, configuration, and every other derived file are fresh — so ` +
        `exactly one 14.10 finding naming it is expected (SPEC 14.10); got ` +
        JSON.stringify(
          findings.map(({ condition, file }) => ({ condition, file })),
        ),
    );
  }
}

/** Some 14.10 finding names the given file. */
function assertStaleFileNamed(
  findings: readonly Finding[],
  rel: string,
  context: string,
): void {
  if (!findings.some((finding) => finding.file === rel)) {
    fail(
      `${context}: a 14.10 finding must name ${JSON.stringify(rel)} (SPEC ` +
        `14.10: the error names the file); named files: ` +
        JSON.stringify(findings.map((finding) => finding.file)),
    );
  }
}

/** Assert a plain file exists at `rel`, diagnosed with the SPEC cite. */
async function expectFile(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<void> {
  const kind = await workspace.kind(rel);
  if (kind !== "file") {
    fail(`${context}: expected a plain file at ${rel}; found ${kind}`);
  }
}

/** Assert nothing exists at `rel`, diagnosed with the SPEC cite. */
async function expectAbsent(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<void> {
  const kind = await workspace.kind(rel);
  if (kind !== "absent") {
    fail(`${context}: expected nothing at ${rel}; found ${kind}`);
  }
}

/**
 * Assert no generated module or companion for `specs/<stem>.mdx` remains:
 * every companion is named `<stem>.xspec.` plus a suffix beside the module
 * (SPEC 13.1), so a prefix filter over the directory listing is complete.
 */
async function expectNoModuleOrCompanions(
  workspace: TestWorkspace,
  stem: string,
  context: string,
): Promise<void> {
  const names = await workspace.readdirNames("specs");
  const leftovers = names.filter((name) => name.startsWith(`${stem}.xspec.`));
  if (leftovers.length > 0) {
    fail(
      `${context}: rebuilding removes recorded derived files the current ` +
        `sources no longer generate — the module and every companion carry ` +
        `\`${stem}.xspec.\` in their names (SPEC 12.1, 13.1, 13.4); left ` +
        `over: ${JSON.stringify(leftovers)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T12.1-1 — products of a successful build
// ---------------------------------------------------------------------------

// Two spec files whose validity requires dependency resolution (B imports A
// and depends on its node), Markdown emission enabled.
const PRODUCTS_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": markdownConfig(true),
  "specs/A.mdx": ['<S id="a1">', "Alpha behavior.", "</S>", ""].join("\n"),
  "specs/B.mdx": [
    'import A from "./A.xspec"',
    "",
    '<S id="b1" d={A.a1}>',
    "Beta depends on alpha.",
    "</S>",
    "",
  ].join("\n"),
};

const T12_1_1 = defineProductTest({
  id: "T12.1-1",
  title:
    "a successful `build` parses and validates sources, resolves dependencies, writes generated modules beside their sources, emits Markdown when enabled, and writes graph data under `.xspec/` — and the downstream graph-data consumers succeed without rebuilding, changing no bytes (SPEC 12.1, 13.1, 13.2, 13.3)",
  run: async (product) => {
    await withWorkspace(PRODUCTS_FILES, async (workspace) => {
      // Success itself requires parsing, validation, and dependency
      // resolution: B.mdx's `d={A.a1}` resolves through its import.
      await buildOk(
        product,
        workspace,
        "T12.1-1 `build` over a valid two-file workspace with a cross-file " +
          "dependency (SPEC 12.1)",
      );

      // Generated modules (13.1) and emitted Markdown (13.2), each beside
      // its source.
      for (const rel of [
        "specs/A.xspec.ts",
        "specs/B.xspec.ts",
        "specs/A.md",
        "specs/B.md",
      ]) {
        await expectFile(
          workspace,
          rel,
          "T12.1-1 after `build` — NAME.mdx generates NAME.xspec.ts and " +
            "emits NAME.md beside the source when emission is enabled " +
            "(SPEC 12.1, 13.1, 13.2, 7.3 default placement)",
        );
      }

      // Graph data under `.xspec/` (13.3): existence only — content is
      // opaque (H-4; 13.3 fixes the location, not the bytes).
      const xspecKind = await workspace.kind(".xspec");
      if (xspecKind !== "dir") {
        fail(
          `T12.1-1 after \`build\`: expected graph data under .xspec/ — a ` +
            `directory at the workspace root (SPEC 12.1, 13.3); found ${xspecKind}`,
        );
      }
      if ((await workspace.readdirNames(".xspec")).length === 0) {
        fail(
          "T12.1-1 after `build`: .xspec/ exists but is empty — `build` " +
            "writes graph data under .xspec/ (SPEC 12.1, 13.3)",
        );
      }

      // Downstream commands succeed without rebuilding, and the read block
      // changes no bytes: graph data is fresh, so no refresh occurs (13.3)
      // and the answers come from what `build` wrote. `impact` is excluded
      // (it requires a git baseline, SPEC 9); `review list` is the read of
      // 10.7 needing no session.
      await assertLeavesUnchanged(
        workspace.root,
        async () => {
          const downstream: readonly (readonly string[])[] = [
            ["check"],
            ["ids"],
            ["show", "specs/B.mdx#b1"],
            ["coverage"],
            ["review", "list"],
          ];
          for (const argv of downstream) {
            await expectExit(
              product,
              workspace,
              argv,
              0,
              `T12.1-1 \`${argv.join(" ")}\` after one \`build\` — the ` +
                `downstream graph-data consumers succeed without rebuilding ` +
                `(SPEC 12.1, 13.3; coverage without profiles and \`review ` +
                `list\` without sessions are informational successes, 12.0)`,
            );
          }
          await runJson(
            product,
            workspace,
            ["query", "node", "specs/B.mdx#b1", "--json"],
            "T12.1-1 `query node specs/B.mdx#b1 --json` after one `build` " +
              "(SPEC 12.1, 13.3, 11)",
          );
        },
        "T12.1-1: the downstream reads over fresh graph data answer from " +
          "what `build` wrote — no refresh, no byte changes anywhere " +
          "(SPEC 13.3)",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T12.1-3 — regeneration and orphan removal
// ---------------------------------------------------------------------------

// Two independent spec files (no cross-references), so removal and manual
// renaming keep the workspace valid (SPEC 6.6: manual restructuring is a
// deletion plus an addition).
const REGEN_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": markdownConfig(true),
  "specs/A.mdx": ['<S id="a1">', "Alpha behavior.", "</S>", ""].join("\n"),
  "specs/B.mdx": ['<S id="b1">', "Beta behavior.", "</S>", ""].join("\n"),
};

const T12_1_3 = defineProductTest({
  id: "T12.1-3",
  title:
    "rebuilding removes the derived files it no longer generates: after removing a source, its module, companions, and Markdown disappear; after manually renaming a source, old derived paths disappear and new ones appear; after disabling emission, the Markdown disappears (SPEC 12.1, 13.1, 13.2, 13.4)",
  run: async (product) => {
    await withWorkspace(REGEN_FILES, async (workspace) => {
      await buildOk(
        product,
        workspace,
        "T12.1-3 initial `build` over two independent sources (SPEC 12.1)",
      );
      for (const rel of [
        "specs/A.xspec.ts",
        "specs/B.xspec.ts",
        "specs/A.md",
        "specs/B.md",
      ]) {
        await expectFile(
          workspace,
          rel,
          "T12.1-3 after the initial `build` (SPEC 13.1, 13.2)",
        );
      }

      // Arm 1 — removing a source: B's module, companions, and Markdown
      // disappear; A's derived files survive.
      await fsp.rm(workspace.path("specs/B.mdx"));
      await buildOk(
        product,
        workspace,
        "T12.1-3 `build` after removing specs/B.mdx (SPEC 12.1)",
      );
      const arm1 =
        "T12.1-3 after removing specs/B.mdx and rebuilding — `build` " +
        "removes the derived files it no longer generates (SPEC 12.1)";
      await expectNoModuleOrCompanions(workspace, "B", arm1);
      await expectAbsent(workspace, "specs/B.md", arm1);
      await expectFile(workspace, "specs/A.xspec.ts", `${arm1} (A survives)`);
      await expectFile(workspace, "specs/A.md", `${arm1} (A survives)`);

      // Arm 2 — manually renaming a source (6.6: deletion plus addition):
      // A's old derived paths disappear, C's appear.
      const sourceBytes = await workspace.readBytes("specs/A.mdx");
      await workspace.file("specs/C.mdx", sourceBytes);
      await fsp.rm(workspace.path("specs/A.mdx"));
      await buildOk(
        product,
        workspace,
        "T12.1-3 `build` after manually renaming specs/A.mdx to " +
          "specs/C.mdx (SPEC 12.1, 6.6)",
      );
      const arm2 =
        "T12.1-3 after renaming specs/A.mdx to specs/C.mdx and rebuilding " +
        "— old derived paths disappear and new ones appear (SPEC 12.1)";
      await expectNoModuleOrCompanions(workspace, "A", arm2);
      await expectAbsent(workspace, "specs/A.md", arm2);
      await expectFile(workspace, "specs/C.xspec.ts", arm2);
      await expectFile(workspace, "specs/C.md", arm2);

      // Arm 3 — disabling emission: the emitted Markdown disappears, the
      // module stays (SPEC 7.3: with emit false, no path is a Markdown emit
      // destination).
      await workspace.file("xspec.config.ts", markdownConfig(false));
      await buildOk(
        product,
        workspace,
        "T12.1-3 `build` after disabling Markdown emission (SPEC 12.1, 7.3)",
      );
      const arm3 =
        "T12.1-3 after disabling emission and rebuilding — `build` removes " +
        "the Markdown it no longer generates and keeps the module " +
        "(SPEC 12.1, 7.3, 13.2)";
      await expectAbsent(workspace, "specs/C.md", arm3);
      await expectFile(workspace, "specs/C.xspec.ts", arm3);
    });
  },
});

// ---------------------------------------------------------------------------
// T12.1-4 — failed build modifies nothing
// ---------------------------------------------------------------------------

const FAILED_BUILD_VALID_SOURCE = [
  '<S id="a1">',
  "Alpha behavior.",
  "</S>",
  "",
].join("\n");

// The valid source with a nested section lacking `id` — condition 14.1, the
// staged validation error.
const FAILED_BUILD_INVALID_SOURCE = [
  '<S id="a1">',
  "Alpha behavior.",
  "",
  "<S>",
  "Nested section without an id.",
  "</S>",
  "</S>",
  "",
].join("\n");

// The valid configuration plus one unknown top-level key — a configuration
// error (SPEC 7, 14.14).
const FAILED_BUILD_BOGUS_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true },
  bogus: true
})
`;

const T12_1_4 = defineProductTest({
  id: "T12.1-4",
  title:
    "against a workspace with prior derived state, a `build` failing with validation errors (exit 1) or with a configuration error (exit 2) modifies nothing — the whole workspace, derived files and graph data included, stays byte-identical (SPEC 12.1, 12.0, 14.14)",
  run: async (product) => {
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(true),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
      },
      async (workspace) => {
        // Prior derived state.
        await buildOk(
          product,
          workspace,
          "T12.1-4 initial `build` (staging: prior derived state, SPEC 12.1)",
        );

        // Arm 1 — validation error: exit 1, nothing modified.
        await workspace.file("specs/A.mdx", FAILED_BUILD_INVALID_SOURCE);
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const context =
              "T12.1-4 `build --json` after introducing a validation error " +
              "(a nested section without id, SPEC 14.1)";
            const findings = await buildFindings(product, workspace, context);
            assertConditionCounts(findings, { "14.1": 1 }, context);
          },
          "T12.1-4: a `build` failing with validation errors modifies " +
            "nothing — every derived file and all graph data byte-identical " +
            "(SPEC 12.1)",
        );

        // Arm 2 — configuration error: exit 2, nothing modified. The source
        // is restored first so the staged configuration defect is the
        // workspace's only defect.
        await workspace.file("specs/A.mdx", FAILED_BUILD_VALID_SOURCE);
        await workspace.file("xspec.config.ts", FAILED_BUILD_BOGUS_CONFIG);
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            await expectConfigurationError(
              product,
              workspace,
              ["build"],
              "T12.1-4 `build` under a configuration with an unknown " +
                "top-level key (SPEC 7, 14.14)",
            );
          },
          "T12.1-4: a `build` refused by a configuration error modifies " +
            "nothing (SPEC 12.1, 14.14)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.2-1 — check green path
// ---------------------------------------------------------------------------

const T12_2_1 = defineProductTest({
  id: "T12.2-1",
  title:
    "on a freshly built valid workspace, `check` exits 0 — in human form and as `--json` with exactly one JSON document (SPEC 12.2, 12.0)",
  run: async (product) => {
    await withWorkspace(PRODUCTS_FILES, async (workspace) => {
      await buildOk(
        product,
        workspace,
        "T12.2-1 `build` (staging: a freshly built valid workspace, SPEC 12.1)",
      );
      await expectExit(
        product,
        workspace,
        ["check"],
        0,
        "T12.2-1 `check` on a freshly built valid workspace — no finding, " +
          "exit 0 (SPEC 12.2)",
      );
      await runJson(
        product,
        workspace,
        ["check", "--json"],
        "T12.2-1 `check --json` on a freshly built valid workspace — exit 0 " +
          "with exactly one JSON document as the entire stdout (SPEC 12.2, 12.0)",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T12.2-2 — per-family finding scope
// ---------------------------------------------------------------------------

// Family: unresolved and non-static references. One spec file staging 14.5
// (unknown `d` target), 14.6 (unknown `text(...)` target), and 14.8 (a
// non-static `d` value), plus one code file staging 14.7 (an unresolved
// TypeScript marker). Every reference targets a distinct missing name, so no
// condition masks another (SPEC 14: each present condition is reported).
const REFERENCES_FAMILY_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  }
})
`,
  "specs/A.mdx": [
    '<S id="a1" d={"nope"}>',
    "Unknown dependency target.",
    "</S>",
    "",
    '<S id="a2">',
    "Unknown text target below.",
    "",
    '{text("nada")}',
    "</S>",
    "",
    '<S id="a3" d={42}>',
    "Non-static dependency value.",
    "</S>",
    "",
  ].join("\n"),
  "src/app.ts": [
    'import A from "../specs/A.xspec";',
    "",
    "function marker(): void {",
    "  A.missing;",
    "}",
    "",
  ].join("\n"),
};

// Family: cycles. A self-`depends` is a dependency cycle of length one
// (SPEC 5.3) needing no import — so no spec import cycle is co-staged and
// the exact condition count holds.
const CYCLE_FAMILY_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": markdownConfig(false),
  "specs/A.mdx": ['<S id="s" d={"s"}>', "Depends on itself.", "</S>", ""].join(
    "\n",
  ),
};

// Family: policy (14.12, check-only). One forbidden rule, one violating
// edge; build-side silence is T7.5-6's subject (T12.1-2).
const POLICY_FAMILY_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    hi: ["hi/**/*.mdx"],
    lo: ["lo/**/*.mdx"]
  },
  policy: [
    {
      name: "no-hi-to-lo",
      type: "forbidden",
      from: { group: "hi" },
      to: { group: "lo" }
    }
  ]
})
`,
  "hi/H.mdx": [
    'import L from "../lo/L.xspec"',
    "",
    '<S id="h1" d={L.l1}>',
    "Violating dependence.",
    "</S>",
    "",
  ].join("\n"),
  "lo/L.mdx": ['<S id="l1">', "Low one.", "</S>", ""].join("\n"),
};

// TEST-SPEC-sanctioned malformed journal line (the T6.1-3 shape).
const GARBAGE_JOURNAL_LINE =
  "?? harness-injected garbage: not a journal entry ??\n";

const CORRUPT_SESSION_PATH = ".xspec/reviews/bad.json";

const T12_2_2 = defineProductTest({
  id: "T12.2-2",
  title:
    "one workspace per finding family, each reported by `check` with exit 1: build validations re-validated from the current sources against persisting derived state; stale generated output and orphaned recorded derived files (14.10) after hand-editing, hand-deleting, editing a source, and disabling emission; unresolved/non-static references; cycles; journal integrity (14.13); policy (14.12); corrupt sessions (14.21) (SPEC 12.2, 14)",
  timeoutMs: 240_000,
  run: async (product) => {
    // Family 1 — build validations, re-validated from the current sources.
    // Derived state from a prior valid build persists while the sources are
    // edited to be invalid; a product answering from the persisting outputs
    // or graph data would find nothing and exit 0.
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(true),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
        "specs/B.mdx": ['<S id="b1">', "Beta behavior.", "</S>", ""].join("\n"),
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T12.2-2 (build validations) initial `build` — staging: derived " +
            "state from a prior valid build persists (SPEC 12.1)",
        );
        await workspace.file("specs/A.mdx", FAILED_BUILD_INVALID_SOURCE);
        await workspace.file(
          "specs/B.mdx",
          ['<S id="bad name">', "Invalid segment.", "</S>", ""].join("\n"),
        );
        await checkFamilyFindings(
          product,
          workspace,
          { "14.1": 1, "14.4": 1 },
          "T12.2-2 (build validations) `check --json` after editing the " +
            "sources to be invalid — check performs all build validations " +
            "from the current sources rather than accepting the stale " +
            "outputs (SPEC 12.2, 14.1, 14.4)",
        );
      },
    );

    // Family 2 — 14.10 staleness and orphans, check-only, four arms.
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(true),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
      },
      async (workspace) => {
        const moduleRel = "specs/A.xspec.ts";
        await buildOk(
          product,
          workspace,
          "T12.2-2 (staleness) initial `build` (SPEC 12.1)",
        );

        // Arm 1 — hand-edited generated file: the module is the fixture's
        // only stale file.
        const original = await readGeneratedModule(
          workspace,
          moduleRel,
          "T12.2-2 (staleness) after the initial build (SPEC 13.1)",
        );
        await workspace.file(moduleRel, `${original}// tampered\n`);
        assertSingleStaleFile(
          await checkFindings(
            product,
            workspace,
            "T12.2-2 (staleness, hand-edited generated file) `check --json`",
          ),
          moduleRel,
          "T12.2-2 (staleness, hand-edited generated file) — a generated " +
            "file whose content does not match what the current sources " +
            "generate is a 14.10 finding (SPEC 12.2, 14.10)",
        );

        // Arm 2 — hand-deleted generated file.
        await buildOk(
          product,
          workspace,
          "T12.2-2 (staleness) rebuild between arms — rebuilding resolves " +
            "the tampered file (SPEC 12.1, 13.4)",
        );
        await fsp.rm(workspace.path(moduleRel));
        assertSingleStaleFile(
          await checkFindings(
            product,
            workspace,
            "T12.2-2 (staleness, hand-deleted generated file) `check --json`",
          ),
          moduleRel,
          "T12.2-2 (staleness, hand-deleted generated file) — a missing " +
            "generated file does not match what the current sources " +
            "generate: a 14.10 finding naming it (SPEC 12.2, 14.10)",
        );

        // Arm 3 — source edited without rebuilding: the emitted Markdown's
        // bytes are the compiled source (SPEC 3, 13.2), so it is stale for
        // certain; which further derived files change is opaque (module and
        // companion content beyond the 13.1 contract, graph data, 13.3).
        await buildOk(
          product,
          workspace,
          "T12.2-2 (staleness) rebuild between arms (SPEC 12.1)",
        );
        await workspace.file(
          "specs/A.mdx",
          ['<S id="a1">', "Alpha behavior, edited.", "</S>", ""].join("\n"),
        );
        const arm3Findings = await checkFindings(
          product,
          workspace,
          "T12.2-2 (staleness, source edited without rebuilding) `check --json`",
        );
        const arm3Context =
          "T12.2-2 (staleness, source edited without rebuilding) — every " +
          "finding is 14.10 and the emitted Markdown, whose bytes are the " +
          "compiled source, is among the named files (SPEC 12.2, 14.10, 3, 13.2)";
        assertAllStale(arm3Findings, arm3Context);
        assertStaleFileNamed(arm3Findings, "specs/A.md", arm3Context);

        // Arm 4 — emission disabled without rebuilding: the recorded
        // emitted Markdown remains at a path no longer generated — an
        // orphaned recorded derived file (SPEC 14.10's second clause).
        await buildOk(
          product,
          workspace,
          "T12.2-2 (staleness) rebuild between arms — regenerates from the " +
            "edited, still-valid source (SPEC 12.1)",
        );
        await workspace.file("xspec.config.ts", markdownConfig(false));
        const arm4Findings = await checkFindings(
          product,
          workspace,
          "T12.2-2 (staleness, emission disabled without rebuilding) `check --json`",
        );
        const arm4Context =
          "T12.2-2 (staleness, emission disabled without rebuilding) — the " +
          "recorded emitted Markdown remains at a path the current " +
          "configuration no longer generates: an orphaned recorded derived " +
          "file, reported as 14.10 (SPEC 12.2, 14.10, 7.3, 13.3)";
        assertAllStale(arm4Findings, arm4Context);
        assertStaleFileNamed(arm4Findings, "specs/A.md", arm4Context);
      },
    );

    // Family 3 — unresolved and non-static references (14.5, 14.6, 14.7,
    // 14.8), each staged against a distinct missing name.
    await withWorkspace(REFERENCES_FAMILY_FILES, async (workspace) => {
      await checkFamilyFindings(
        product,
        workspace,
        { "14.5": 1, "14.6": 1, "14.7": 1, "14.8": 1 },
        "T12.2-2 (references) `check --json` — an unknown `d` target, an " +
          "unknown `text(...)` target, an unresolved TypeScript marker, and " +
          "a non-static `d` value are each reported (SPEC 12.2, 14.5–14.8)",
      );
    });

    // Family 4 — cycles: a self-`depends` cycle of length one (no import
    // cycle co-staged).
    await withWorkspace(CYCLE_FAMILY_FILES, async (workspace) => {
      await checkFamilyFindings(
        product,
        workspace,
        { "14.9": 1 },
        "T12.2-2 (cycles) `check --json` — a dependency cycle is a finding " +
          "(SPEC 12.2, 5.3, 14.9)",
      );
    });

    // Family 5 — journal integrity (14.13): a malformed journal line.
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(false),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T12.2-2 (journal) initial `build` (staging, SPEC 12.1)",
        );
        await workspace.file(".xspec/journal", GARBAGE_JOURNAL_LINE);
        await checkFamilyFindings(
          product,
          workspace,
          { "14.13": 1 },
          "T12.2-2 (journal) `check --json` over a journal holding one " +
            "malformed line — the journal is well-formed and replayable or " +
            "a 14.13 finding (SPEC 12.2, 6.1, 14.13; line naming is " +
            "T6.1-3's subject)",
        );
      },
    );

    // Family 6 — policy (14.12, check-only): one forbidden rule, one
    // violating edge, freshly built so the violation is the only finding.
    await withWorkspace(POLICY_FAMILY_FILES, async (workspace) => {
      await buildOk(
        product,
        workspace,
        "T12.2-2 (policy) `build` — build does not evaluate policy " +
          "(SPEC 12.1; the build-vs-check contrast is T7.5-6's subject)",
      );
      await checkFamilyFindings(
        product,
        workspace,
        { "14.12": 1 },
        "T12.2-2 (policy) `check --json` — the violating edge is a 14.12 " +
          "finding (SPEC 12.2, 7.5, 14.12)",
      );
    });

    // Family 7 — corrupt sessions (14.21): a session file that cannot be
    // parsed is corrupt categorically (SPEC 10.1).
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(false),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T12.2-2 (sessions) initial `build` (staging, SPEC 12.1)",
        );
        await workspace.file(
          CORRUPT_SESSION_PATH,
          "{ this is not a parseable session",
        );
        const context =
          "T12.2-2 (sessions) `check --json` over one unparseable session " +
          "file — review sessions are not internally corrupt or a 14.21 " +
          "finding (SPEC 12.2, 10.1, 14.21)";
        const findings = await checkFamilyFindings(
          product,
          workspace,
          { "14.21": 1 },
          context,
        );
        const corrupt = findings.find(
          (finding) => finding.condition === "14.21",
        )!;
        if (
          corrupt.file !== CORRUPT_SESSION_PATH &&
          !/bad/.test(corrupt.message)
        ) {
          fail(
            `${context}: the 14.21 finding must identify the corrupt ` +
              `session — the finding naming the session file ` +
              `${CORRUPT_SESSION_PATH} or the message naming the session ` +
              `"bad" (SPEC 14, 14.21; H-3 information presence); got file ` +
              `${JSON.stringify(corrupt.file)}, message ${JSON.stringify(corrupt.message)}`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.2-3 — check never refreshes
// ---------------------------------------------------------------------------

const T12_2_3 = defineProductTest({
  id: "T12.2-3",
  title:
    "`check` on a stale workspace reports the staleness (exit 1, 14.10) and never refreshes: graph data and derived files — the whole workspace — stay byte-identical around both the human and the `--json` invocation (SPEC 12.2, 13.3, 14.10)",
  run: async (product) => {
    await withWorkspace(
      {
        "xspec.config.ts": markdownConfig(true),
        "specs/A.mdx": FAILED_BUILD_VALID_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T12.2-3 initial `build` (SPEC 12.1)",
        );
        // Stale: the source is edited (still valid) without rebuilding.
        await workspace.file(
          "specs/A.mdx",
          ['<S id="a1">', "Alpha behavior, edited.", "</S>", ""].join("\n"),
        );
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            await expectExit(
              product,
              workspace,
              ["check"],
              1,
              "T12.2-3 `check` on a stale workspace — staleness is a " +
                "finding, exit 1 (SPEC 12.2, 14.10)",
            );
            const findings = await checkFindings(
              product,
              workspace,
              "T12.2-3 `check --json` on a stale workspace",
            );
            assertAllStale(
              findings,
              "T12.2-3 — `check` reports the staleness: every finding is " +
                "14.10, naming its file and instructing rebuilding " +
                "(SPEC 12.2, 14.10)",
            );
          },
          "T12.2-3: `check` never refreshes — graph data and derived files " +
            "(the whole workspace) byte-identical around both invocations " +
            "(SPEC 13.3, 12.2)",
        );
      },
    );
  },
});

/** TEST-SPEC §12.1–12.2 T12.1-1…T12.2-3, in canonical ID order (SUITE-43). */
export const section121to122Tests: readonly ProductTestEntry[] = [
  T12_1_1,
  T12_1_3,
  T12_1_4,
  T12_2_1,
  T12_2_2,
  T12_2_3,
];
