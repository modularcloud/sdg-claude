// TEST-SPEC §4.5 (dependency markers) — SUITE-15: T4.5-1 … T4.5-7.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8). Runtime
// contracts run under standard TypeScript tooling with no xspec runtime
// dependency (SPEC 13.1) through helpers/tooling.ts, in the CommonJS-mode
// arrangement described in section-4.ts. Files under `src/` are discovered
// code-group sources.
//
// Conservative operationalizations (noted per H-4 — wording is free, so only
// the stated observables are asserted):
// - T4.5-1 "at runtime the program behaves as if the line were absent
//   (harmless property read) with no additional tooling installed": the
//   fixture stages two discovered code files differing in exactly the marker
//   line; both compile clean under standard tooling, and both compiled
//   programs run under plain Node (SPEC 13.1 — nothing installed beyond
//   standard TypeScript tooling) with identical observables: exit 0, stdout
//   exactly "Hello\n", empty stderr, the marker program's stdout
//   byte-compared to the marker-free program's.
// - T4.5-2 stages the root marker as the workspace's only dependency edge,
//   so every asserted value is forced: coverage can only be empty, the
//   impacted-code witness edge can only be the root-targeted `references`
//   edge, and with exactly one changed leaf there is exactly one qualifying
//   witness path (SPEC 9.3) — root → print → print.hello, every step
//   `contains`, every node's subtreeHash changed.
// - T4.5-3 arms stage exactly one defect each — the non-static form. Every
//   arm's chain would resolve to an existing node if read statically
//   (`SPEC[key]` with key = "a"; the `a.b` chains with `a.b` staged), so a
//   product cannot legitimately reclassify the finding as an unresolved
//   reference (14.7): the sole present condition is 14.8, and the exact
//   condition-count assertion simultaneously pins "not 14.18" (SPEC 4.5).
// - T4.5-5 arms likewise stage exactly one unsanctioned value-level use
//   each; the exact condition-count assertion {"14.18": 1} pins the
//   classification (SPEC 4.5, 14.18).
// - Location assertions: every offending statement is staged at a known byte
//   offset in a pure-ASCII `src/app.ts`, so string indices are byte offsets
//   and each finding must fall within the offending statement's own byte
//   window (end-widened by one byte for line-granular locations, support.ts
//   byteWindow).

import type {
  CoverageProfileReport,
  CoverageReport,
  GraphEdge,
  ImpactedCodeEntry,
} from "../../helpers/adapters/index.js";
import {
  decodeCoverageReport,
  decodeEdgesReport,
  decodeImpactReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  assertStderrEmpty,
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

// One spec group plus one code group (SPEC 7.2): TypeScript files under
// `src/` are discovered code sources, so `build` analyzes their spec-module
// usage (4, 4.5).
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

// A two-level document (root → print → print.hello), so a leaf edit changes
// the root's subtreeHash through a two-step contains chain (SPEC 5.5).
const PRINT_SPEC_SOURCE = [
  '<S id="print">',
  "Print behavior.",
  "",
  '<S id="print.hello">',
  "Prints a greeting.",
  "</S>",
  "</S>",
  "",
].join("\n");

// One spec source with a nested `a.b`, shared by the 14.8/14.18 arms and the
// edge-kind fixtures, so every staged chain resolves if read statically —
// the form (or the usage) is each arm's sole defect.
const AB_SPEC_FILES = {
  "specs/A.mdx":
    '<S id="a">\nAlpha behavior.\n<S id="a.b">\nBeta behavior.\n</S>\n</S>\n',
} as const;

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

/** `query edges --from <graph-node>`, decoded (SPEC 11). */
async function queryEdgesFrom(
  product: ProductBinding,
  workspace: TestWorkspace,
  from: string,
  context: string,
): Promise<readonly GraphEdge[]> {
  const label = `${context} \`query edges --from ${from}\``;
  return decodeEdgesReport(
    await runJson(
      product,
      workspace,
      ["query", "edges", "--from", from],
      label,
    ),
    label,
  );
}

/** Workspace-wide `query edges --kinds <kind>`, decoded (SPEC 11). */
async function queryEdgesOfKind(
  product: ProductBinding,
  workspace: TestWorkspace,
  kind: string,
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

/** Emit a consumer project's JavaScript, failing diagnosed when skipped. */
function emitConsumer(project: ConsumerProject, context: string): void {
  const emitted = project.emit();
  if (emitted.emitSkipped) {
    fail(
      `${context}: consumer emit was skipped; diagnostics:\n` +
        emitted.diagnostics
          .map((diagnostic) => `  ${formatConsumerDiagnostic(diagnostic)}`)
          .join("\n"),
    );
  }
}

/** One offending-statement arm: a workspace differing only in src/app.ts. */
interface OffendingStatementArm {
  /** Which SPEC 4.5 case this is (failure diagnostics). */
  readonly name: string;
  /** The lines of `src/app.ts`, pure ASCII, one statement per line. */
  readonly lines: readonly string[];
  /** The offending statement — exactly one of the lines. */
  readonly offending: string;
}

/**
 * Stage one arm over the shared `a`/`a.b` spec source and assert `build
 * --json` reports exactly one finding of `condition`, located within the
 * offending statement's byte window. The exact condition-count assertion is
 * simultaneously the classification assertion (14.8 vs 14.18, SPEC 4.5).
 */
async function assertArmFailsWith(
  product: ProductBinding,
  testId: string,
  arm: OffendingStatementArm,
  condition: string,
): Promise<void> {
  const at = arm.lines.indexOf(arm.offending);
  if (at === -1 || arm.lines.lastIndexOf(arm.offending) !== at) {
    // A harness defect (never a product failure): the offending statement
    // must appear exactly once among the staged lines.
    throw new Error(
      `${testId} fixture broke: the offending statement must appear exactly ` +
        `once (${arm.name}) — fix the arm table in section-4.5.ts`,
    );
  }
  const source = arm.lines.map((line) => line + "\n").join("");
  const prefix = arm.lines
    .slice(0, at)
    .map((line) => line + "\n")
    .join("");
  const window = byteWindow(prefix, arm.offending);
  const context = `${testId} \`build --json\` over ${arm.name}`;
  await withWorkspace(
    SPEC_AND_CODE_CONFIG,
    { ...AB_SPEC_FILES, "src/app.ts": source },
    async (workspace) => {
      const findings = await buildFindings(product, workspace, context);
      assertConditionCounts(findings, { [condition]: 1 }, context);
      assertFindingLocated(
        findings[0]!,
        { file: "src/app.ts", window },
        `${context}: the ${condition} finding`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// T4.5-1 — marker semantics and runtime harmlessness
// ---------------------------------------------------------------------------

// The SPEC 4.5 worked shape: a bare requirement reference as an expression
// statement inside a function. The control program is the identical file
// minus exactly the marker line.
const T4_5_1_MARKER_LINE = "  SPEC.print.hello;";
const T4_5_1_APP_LINES = [
  'import SPEC from "../specs/MAIN.xspec";',
  "",
  "function printHello(): void {",
  T4_5_1_MARKER_LINE,
  '  console.log("Hello");',
  "}",
  "",
  "printHello();",
  "",
];
const T4_5_1_APP_SOURCE = T4_5_1_APP_LINES.join("\n");
const T4_5_1_CONTROL_SOURCE = T4_5_1_APP_LINES.filter(
  (line) => line !== T4_5_1_MARKER_LINE,
).join("\n");
const T4_5_1_EXPECTED_STDOUT = "Hello\n";

const T4_5_1 = defineProductTest({
  id: "T4.5-1",
  title:
    "a bare requirement reference as an expression statement is a dependency marker: it records a `references` edge from the enclosing code location, and at runtime the program behaves as if the line were absent — the compiled program under plain Node matches the marker-free control byte for byte (SPEC 4.5, 4.6, 13.1)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/MAIN.mdx": PRINT_SPEC_SOURCE,
        "src/app.ts": T4_5_1_APP_SOURCE,
        "src/control.ts": T4_5_1_CONTROL_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.5-1 `build` over the marker program and its marker-free control",
        );

        // The marker records a `references` edge from its enclosing code
        // location — the function unit (SPEC 4.5, 4.6) — and that is the
        // workspace's complete `references` edge set: the control, identical
        // but for the marker line, contributes nothing.
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.5-1"),
          [
            {
              from: "src/app.ts#printHello",
              to: "specs/MAIN.mdx#print.hello",
              kind: "references",
            },
          ],
          "T4.5-1 the marker records a `references` edge from the enclosing " +
            "code location (SPEC 4.5, 4.6), and nothing else records one",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T4.5-1"),
          [],
          "T4.5-1 a marker is a `references` edge, not an `embeds` edge " +
            "(SPEC 4.5, 5.2)",
        );

        // Runtime harmlessness under standard tooling only (SPEC 13.1): both
        // programs compile clean, and the compiled marker program under
        // plain Node behaves exactly like the marker-free control — exit 0,
        // stdout "Hello\n", empty stderr, byte-compared.
        const project = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["src/app.ts", "src/control.ts"],
        });
        assertNoCompileErrors(
          project,
          "T4.5-1 the marker program and its marker-free control under " +
            "standard TypeScript tooling (SPEC 4.5: markers are valid with " +
            "no additional tooling installed)",
        );
        emitConsumer(project, "T4.5-1 marker and control programs");
        const appRun = await runConsumer({
          dir: workspace.root,
          entry: "src/app.js",
        });
        const controlRun = await runConsumer({
          dir: workspace.root,
          entry: "src/control.js",
        });
        for (const [label, run] of [
          ["marker program", appRun],
          ["marker-free control", controlRun],
        ] as const) {
          assertExitCode(
            run,
            0,
            `T4.5-1 compiled ${label} under plain Node (SPEC 4.5, 13.1)`,
          );
          assertStderrEmpty(
            run,
            `T4.5-1 compiled ${label} under plain Node (SPEC 4.5: a marker ` +
              "is a harmless property read)",
          );
          assertBytesEqual(
            run.stdoutBytes,
            T4_5_1_EXPECTED_STDOUT,
            `T4.5-1 stdout of the ${label} (SPEC 4.5)`,
          );
        }
        assertBytesEqual(
          appRun.stdoutBytes,
          controlRun.stdoutBytes,
          "T4.5-1 at runtime the marker program behaves as if the marker " +
            "line were absent — stdout byte-identical to the marker-free " +
            "control (SPEC 4.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.5-2 — root marker: references edge, no coverage, impacted code
// ---------------------------------------------------------------------------

// Coverage profiles over both modes, target = the spec group, boundary = the
// code group (`boundaryKind` inferred, the name is unambiguous, SPEC 7.4).
// `edgeKinds` defaults to all three, so the root-targeted `references` edge
// is the one candidate edge in every profile.
const T4_5_2_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  coverage: [
    {
      name: "direct",
      target: "main",
      boundary: "app",
      mode: "direct"
    },
    {
      name: "trans",
      target: "main",
      targets: "all",
      boundary: "app",
      mode: "transitive"
    }
  ]
})
`;

// The bare reference to the default export, at file top level — the root
// marker, and the workspace's only dependency edge.
const T4_5_2_APP_SOURCE = [
  'import SPEC from "../specs/MAIN.xspec";',
  "",
  "SPEC;",
  "",
].join("\n");

// The leaf edit: one own-content run of print.hello changes, so the root's
// subtreeHash (and effectiveHash) change through the contains chain
// (SPEC 5.5) while no other file is touched.
const T4_5_2_EDITED_SPEC_SOURCE = PRINT_SPEC_SOURCE.replace(
  "Prints a greeting.",
  "Prints a much louder greeting.",
);

/** Resolve one named profile from a coverage report, diagnosed (H-8). */
function profileByName(
  report: CoverageReport,
  name: string,
  context: string,
): CoverageProfileReport {
  const profile = report.profiles.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    fail(
      `${context}: profile ${JSON.stringify(name)} missing from the ` +
        `coverage report (SPEC 8.2: \`coverage\` runs all profiles); got ` +
        JSON.stringify(report.profiles.map((candidate) => candidate.name)),
    );
  }
  return profile;
}

/** Readable rendering of an impacted-code entry (order-stable fields). */
function renderImpactedCodeEntry(entry: ImpactedCodeEntry): string {
  return (
    `${entry.location} | edge ${entry.edge.kind}: ${entry.edge.from} -> ` +
    `${entry.edge.to} | path: ${entry.path.join(" > ")}`
  );
}

const T4_5_2 = defineProductTest({
  id: "T4.5-2",
  title:
    "a bare reference to the default export records a `references` edge to the root; it grants no coverage in any profile — root-targeted edges never extend a covering path — but the code location is directly impacted by a text edit changing the root's subtreeHash, witnessed by the root-targeted edge (SPEC 4.5, 8, 9.2, 9.3)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": T4_5_2_CONFIG,
        "specs/MAIN.mdx": PRINT_SPEC_SOURCE,
        "src/app.ts": T4_5_2_APP_SOURCE,
      },
    });
    try {
      await workspace.gitInit();
      await buildOk(
        product,
        workspace,
        "T4.5-2 `build` over the root-marker workspace",
      );

      // The root marker records a `references` edge to the root — the bare
      // path identity (SPEC 1.5) — from the file (top level, SPEC 4.6), and
      // that is the file's complete outgoing edge set.
      assertEdgeSetEqual(
        await queryEdgesFrom(product, workspace, "src/app.ts", "T4.5-2"),
        [{ from: "src/app.ts", to: "specs/MAIN.mdx", kind: "references" }],
        "T4.5-2 the root marker records a `references` edge to the root " +
          "node, and nothing else leaves the file (SPEC 4.5, 1.5)",
      );

      // No coverage in any profile: the root-targeted edge never extends a
      // covering path (SPEC 8), so with it as the only dependency edge every
      // profile's covered set is empty and every required node stays
      // uncovered — the root itself never among them (8.1).
      const coverageLabel = "T4.5-2 `coverage --json`";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageLabel,
        ),
        coverageLabel,
      );
      assertSameJson(
        coverage.profiles.map((profile) => profile.name).sort(),
        ["direct", "trans"],
        `${coverageLabel}: all configured profiles run (SPEC 8.2)`,
      );
      for (const [name, expectedUncovered] of [
        ["direct", ["specs/MAIN.mdx#print.hello"]],
        ["trans", ["specs/MAIN.mdx#print", "specs/MAIN.mdx#print.hello"]],
      ] as const) {
        const profile = profileByName(coverage, name, coverageLabel);
        if (profile.counts.covered !== 0 || profile.covered.length !== 0) {
          fail(
            `${coverageLabel}: the root marker must grant no coverage in ` +
              `profile ${JSON.stringify(name)} (SPEC 4.5, 8: roots never ` +
              `appear in coverage paths and root-targeted edges never ` +
              `extend one); got covered count ` +
              `${String(profile.counts.covered)} with covered nodes ` +
              JSON.stringify(sortedIdentities(profile.covered)),
          );
        }
        assertSameJson(
          [...profile.uncovered].sort(),
          expectedUncovered,
          `${coverageLabel}: profile ${JSON.stringify(name)} leaves every ` +
            "required node uncovered, the root never listed (SPEC 8, 8.1)",
        );
      }

      // Impact: commit the baseline, edit the leaf's text — the root's
      // subtreeHash changes (SPEC 5.5) — and the code location is directly
      // impacted (9.2) via its root-targeted edge. With one impact edge and
      // one changed leaf, the witness edge and path are forced (9.3): the
      // path runs root → print → print.hello, every step `contains`.
      const baseline = await workspace.gitCommitAll("baseline");
      await workspace.file("specs/MAIN.mdx", T4_5_2_EDITED_SPEC_SOURCE);
      const impactLabel = `T4.5-2 \`impact --base ${baseline} --json\``;
      const impact = decodeImpactReport(
        await runJson(
          product,
          workspace,
          ["impact", "--base", baseline, "--json"],
          impactLabel,
        ),
        impactLabel,
      );
      assertSameJson(
        impact.code.direct.map(renderImpactedCodeEntry),
        [
          "src/app.ts | edge references: src/app.ts -> specs/MAIN.mdx | " +
            "path: specs/MAIN.mdx > specs/MAIN.mdx#print > " +
            "specs/MAIN.mdx#print.hello",
        ],
        `${impactLabel}: the root marker makes its code location directly ` +
          "impacted by a leaf text edit — the root's subtreeHash changed — " +
          "witnessed by the root-targeted `references` edge and the " +
          "contains-step path to the edited leaf (SPEC 4.5, 9.2, 9.3)",
      );
      assertSameJson(
        impact.code.transitive.map(renderImpactedCodeEntry),
        [],
        `${impactLabel}: the location's only impact edge targets the root, ` +
          "whose subtreeHash changed, so it is directly — not " +
          "transitively — impacted (SPEC 9.2)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T4.5-3 — non-static bare references in expression-statement position (14.8)
// ---------------------------------------------------------------------------

const T4_5_3_IMPORT = 'import SPEC from "../specs/A.xspec";';

const T4_5_3_ARMS: readonly OffendingStatementArm[] = [
  {
    name:
      "a computed index by variable as a bare expression statement " +
      "(SPEC 2.4, 4.5)",
    lines: [T4_5_3_IMPORT, "", 'const key = "a";', "SPEC[key];"],
    offending: "SPEC[key];",
  },
  {
    name:
      "an optional-chaining chain as a bare expression statement " +
      "(SPEC 2.4, 4.5)",
    lines: [T4_5_3_IMPORT, "", "SPEC.a?.b;"],
    offending: "SPEC.a?.b;",
  },
  {
    name:
      "a non-null-assertion chain as a bare expression statement " +
      "(SPEC 2.4, 4.5)",
    lines: [T4_5_3_IMPORT, "", "SPEC.a!.b;"],
    offending: "SPEC.a!.b;",
  },
  {
    name: "a parenthesized chain as a bare expression statement (SPEC 2.4, 4.5)",
    lines: [T4_5_3_IMPORT, "", "(SPEC.a).b;"],
    offending: "(SPEC.a).b;",
  },
  {
    name:
      "a template-literal computed index as a bare expression statement " +
      "(template literals are not static, SPEC 2.4, 4.5)",
    lines: [T4_5_3_IMPORT, "", "SPEC[`a`];"],
    offending: "SPEC[`a`];",
  },
];

const T4_5_3 = defineProductTest({
  id: "T4.5-3",
  title:
    "a non-static bare reference in expression-statement position — computed index by variable, optional chaining, non-null assertion, parentheses, template-literal index — fails with exactly one located 14.8 finding (invalid argument, not 14.18) (SPEC 4.5, 2.4, 14.8)",
  run: async (product) => {
    for (const arm of T4_5_3_ARMS) {
      await assertArmFailsWith(product, "T4.5-3", arm, "14.8");
    }
  },
});

// ---------------------------------------------------------------------------
// T4.5-4 — shadowing: chains rooted at a local are not spec references
// ---------------------------------------------------------------------------

// The identical statement text `SPEC.a.b;` appears twice: once at top level
// rooted at the import binding (a marker, the control), once inside a
// function whose local `const SPEC` shadows the import — TypeScript scoping
// resolves that chain to the local, so it is not a spec reference (SPEC 4.5:
// rooting is scope-aware and value-level).
const T4_5_4_APP_SOURCE = [
  'import SPEC from "../specs/A.xspec";',
  "",
  "SPEC.a.b;",
  "",
  "function localScope(): string {",
  '  const SPEC = { a: { b: "shadow value" } };',
  "  SPEC.a.b;",
  "  return SPEC.a.b;",
  "}",
  "",
  "localScope();",
  "",
].join("\n");

const T4_5_4 = defineProductTest({
  id: "T4.5-4",
  title:
    "a local declaration shadowing the import binding: chains rooted at the local are not spec references — no edge, no error, the program builds — while the identical statement rooted at the import records its marker edge (SPEC 4.5)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { ...AB_SPEC_FILES, "src/app.ts": T4_5_4_APP_SOURCE },
      async (workspace) => {
        // No error: the shadowed chains fall under no condition (SPEC 4.5) —
        // build and check both succeed.
        await buildOk(
          product,
          workspace,
          "T4.5-4 `build` with chains rooted at a local shadowing the " +
            "import binding",
        );
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T4.5-4 `check` over the same workspace (the shadowed chains " +
            "trigger no finding, SPEC 4.5)",
        );

        // No edge: the workspace's complete `references` edge set is the
        // top-level control marker's file-attributed edge — a product that
        // ignored scoping would record a second edge from the function unit.
        const expected: readonly GraphEdge[] = [
          { from: "src/app.ts", to: "specs/A.mdx#a.b", kind: "references" },
        ];
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.5-4"),
          expected,
          "T4.5-4 chains rooted at the shadowing local record no edge; the " +
            "identical top-level statement rooted at the import records " +
            "exactly its marker edge (SPEC 4.5, 4.6)",
        );
        assertEdgeSetEqual(
          await queryEdgesFrom(product, workspace, "src/app.ts", "T4.5-4"),
          expected,
          "T4.5-4 the file's complete outgoing edge set is the control " +
            "marker's edge (SPEC 4.5, 4.6)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.5-5 — sanctioned uses only: every other value-level use is 14.18
// ---------------------------------------------------------------------------

const T4_5_5_IMPORT_DEFAULT = 'import SPEC from "../specs/A.xspec";';
const T4_5_5_IMPORT_TEXT = 'import { text } from "../specs/A.xspec";';
// A plain local function: passing a node (or `text`) to it is not a call to
// a spec module's `text` export (SPEC 4.5).
const T4_5_5_SINK = "function sink(value: unknown): void { void value; }";

const T4_5_5_ARMS: readonly OffendingStatementArm[] = [
  {
    name: "aliasing a node to a variable (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", "const alias = SPEC.a;"],
    offending: "const alias = SPEC.a;",
  },
  {
    name: "destructuring the module (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", "const { a } = SPEC;"],
    offending: "const { a } = SPEC;",
  },
  {
    name: "re-exporting the binding (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", "export { SPEC };"],
    offending: "export { SPEC };",
  },
  {
    name: "storing a node in an array (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", "const stored = [SPEC.a];"],
    offending: "const stored = [SPEC.a];",
  },
  {
    name: "storing a node in an object (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", "const stored = { node: SPEC.a };"],
    offending: "const stored = { node: SPEC.a };",
  },
  {
    name:
      "passing a node to a function other than a spec module's `text` " +
      "export (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_DEFAULT, "", T4_5_5_SINK, "sink(SPEC.a);"],
    offending: "sink(SPEC.a);",
  },
  {
    name: "passing `text` as a value instead of using it as a callee (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_TEXT, "", T4_5_5_SINK, "sink(text);"],
    offending: "sink(text);",
  },
  {
    name: "storing `text` as a value instead of using it as a callee (SPEC 4.5)",
    lines: [T4_5_5_IMPORT_TEXT, "", "const stored = text;"],
    offending: "const stored = text;",
  },
];

const T4_5_5 = defineProductTest({
  id: "T4.5-5",
  title:
    "the sanctioned value-level uses are exact — aliasing a node to a variable, destructuring the module, re-exporting the binding, storing a node in an array or object, passing a node to a function other than a spec module's `text` export, and passing or storing `text` other than as a callee each fail with exactly one located 14.18 finding (SPEC 4.5, 14.18)",
  run: async (product) => {
    for (const arm of T4_5_5_ARMS) {
      await assertArmFailsWith(product, "T4.5-5", arm, "14.18");
    }
  },
});

// ---------------------------------------------------------------------------
// T4.5-6 — text(...) in statement position: valid, embeds, not a marker
// ---------------------------------------------------------------------------

const T4_5_6_APP_SOURCE = [
  'import SPEC, { text } from "../specs/A.xspec";',
  "",
  "text(SPEC.a);",
  "",
].join("\n");

const T4_5_6 = defineProductTest({
  id: "T4.5-6",
  title:
    "a `text(...)` call as an expression statement is valid, records an `embeds` edge, and is not a marker — the kind asserted via `query edges --kinds` (SPEC 4.5, 4.3, 5.2)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { ...AB_SPEC_FILES, "src/app.ts": T4_5_6_APP_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.5-6 `build` with a `text(...)` call in expression-statement " +
            "position (valid, SPEC 4.5)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T4.5-6"),
          [{ from: "src/app.ts", to: "specs/A.mdx#a", kind: "embeds" }],
          "T4.5-6 the statement-position `text(...)` call records its " +
            "`embeds` edge from the calling code location (SPEC 4.5, 4.3)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.5-6"),
          [],
          "T4.5-6 the statement-position `text(...)` call is not a marker: " +
            "no `references` edge exists anywhere (SPEC 4.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.5-7 — type-level freedom: no edges, not rewritten by rename
// ---------------------------------------------------------------------------

// Type-level references in several positions: a type-alias `typeof` query on
// the root and on a chain, a type-level indexed access, an interface property
// annotation, and a parameter annotation. No value-level use of the binding
// exists anywhere in the file.
const T4_5_7_APP_SOURCE = [
  'import SPEC from "../specs/A.xspec";',
  "",
  "type Root = typeof SPEC;",
  "type Leaf = typeof SPEC.a.b;",
  'type Child = Root["a"];',
  "",
  "interface Holder {",
  "  node: typeof SPEC.a;",
  "}",
  "",
  "function annotated(node: typeof SPEC.a.b, holder: Holder): void {",
  "  void node;",
  "  void holder;",
  "}",
  "",
].join("\n");

const T4_5_7 = defineProductTest({
  id: "T4.5-7",
  title:
    "`typeof SPEC.a.b` and other type-level references are unrestricted: the workspace builds with no edges recorded, and rename rewrites nothing in the file — type-level references may be left naming vacated identities while the workspace stays valid (SPEC 4.5, 6.4)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { ...AB_SPEC_FILES, "src/app.ts": T4_5_7_APP_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.5-7 `build` with type-level references only (unrestricted, " +
            "SPEC 4.5)",
        );

        // No edges recorded: nothing leaves the file, and no dependency
        // edge of either TypeScript-recordable kind exists anywhere.
        assertEdgeSetEqual(
          await queryEdgesFrom(product, workspace, "src/app.ts", "T4.5-7"),
          [],
          "T4.5-7 type-level references record no edges (SPEC 4.5)",
        );
        for (const kind of ["references", "embeds"] as const) {
          assertEdgeSetEqual(
            await queryEdgesOfKind(product, workspace, kind, "T4.5-7"),
            [],
            `T4.5-7 no \`${kind}\` edge exists anywhere in the workspace ` +
              "(SPEC 4.5: type-level references are unrestricted and " +
              "record no edges)",
          );
        }

        // Not rewritten by rename: `rename a -> c` rewrites the spec source
        // and would rewrite value-level references, but type-level
        // references record no edges and are not rewritten (SPEC 6.4) — the
        // code file's bytes are untouched, and the workspace stays valid.
        await expectExit(
          product,
          workspace,
          ["rename", "specs/A.mdx", "a", "c"],
          0,
          "T4.5-7 `rename specs/A.mdx a c` over the valid workspace " +
            "(SPEC 6.4)",
        );
        assertBytesEqual(
          await workspace.readBytes("src/app.ts"),
          T4_5_7_APP_SOURCE,
          "T4.5-7 rename must not rewrite type-level references: the code " +
            "file's bytes are unchanged, its `typeof` chains left naming " +
            "the vacated identities (SPEC 4.5, 6.4)",
        );
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T4.5-7 `check` after the rename — dangling type-level " +
            "references are a consumer-side TypeScript matter, outside " +
            "xspec's validations; the workspace stays valid (SPEC 6.4)",
        );
      },
    );
  },
});

/** TEST-SPEC §4.5, in canonical ID order (SUITE-15). */
export const section45Tests: readonly ProductTestEntry[] = [
  T4_5_1,
  T4_5_2,
  T4_5_3,
  T4_5_4,
  T4_5_5,
  T4_5_6,
  T4_5_7,
];
