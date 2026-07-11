// TEST-SPEC §2.1 (imports) — SUITE-06: T2.1-1 … T2.1-5.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 2.1: the only imports permitted in an xspec source file are other spec
// modules, as a single default binding of a relative `./`/`../` specifier
// ending in `.xspec` whose designated `.mdx` file is a discovered source of a
// configured spec group; any other specifier, target, or binding form is
// invalid (14.15), import cycles are invalid (14.9), and an unused import is
// valid and records no edges.
//
// Location assertions: every offending import statement is staged at the very
// start of its file (prefix ""), all pure ASCII, so string indices are byte
// offsets and the 14.15 finding must fall within the import statement's own
// byte window (end-widened by one byte for line-granular locations, see
// support.ts byteWindow); every other staged construct lies beyond the
// following blank line, outside the widened window.

import type { Finding } from "../../helpers/adapters/index.js";
import {
  DEPENDENCY_EDGE_KINDS,
  decodeEdgesReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertEdgeSetEqual,
  assertFindingLocated,
  buildFindings,
  buildOk,
  byteWindow,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. Files
// outside `specs/` (the exists-but-undiscovered arm) belong to no group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

/** Stage a fresh workspace (config plus `files`), run `body`, dispose (H-1). */
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

// The importing file's body after its import statement(s): a blank separator
// line plus one ordinary section. It starts two bytes past the last import
// line's end, so it lies outside every import's end-widened byte window — and
// for the `S`/`Spec` binding arms it is the probe that construct recognition
// stays unambiguous (SPEC 2.1: the compiler-provided names are never
// shadowed), since a product that lets the offending import shadow `<S>`
// would report phantom conditions beside the one 14.15 and fail the
// exact-count assertion.
const IMPORTING_FILE_REST = '\n\n<S id="alpha">\nAlpha behavior.\n</S>\n';

// A valid imported module for arms where the target file legitimately exists.
const VALID_BASE_FILES = {
  "specs/BASE.mdx": '<S id="core">\nCore behavior.\n</S>\n',
} as const;

/** One invalid-import arm: a workspace differing only in its import line. */
interface InvalidImportArm {
  /** Which SPEC 2.1 invalid case this is (failure diagnostics). */
  readonly name: string;
  /** The offending import statement, staged at the very start of the file. */
  readonly importLine: string;
  /** Files staged beside the importing file and the configuration. */
  readonly extraFiles: Readonly<Record<string, string>>;
}

/**
 * Run one invalid-import arm: `build --json` exits 1 with exactly one
 * finding, condition 14.15, located within the import statement's own byte
 * window in the importing file (SPEC 14: errors identify file and location).
 */
async function runInvalidImportArm(
  product: ProductBinding,
  arm: InvalidImportArm,
  testId: string,
): Promise<void> {
  const context = `${testId} \`build --json\` over ${arm.name}`;
  await withWorkspace(
    {
      ...arm.extraFiles,
      "specs/A.mdx": arm.importLine + IMPORTING_FILE_REST,
    },
    async (workspace) => {
      const findings = await buildFindings(product, workspace, context);
      assertConditionCounts(findings, { "14.15": 1 }, context);
      assertFindingLocated(
        findings[0]!,
        { file: "specs/A.mdx", window: byteWindow("", arm.importLine) },
        `${context}: the 14.15 finding`,
      );
    },
  );
}

// T2.1-1: the SPEC 2.1 worked form. `BASE.mdx` is a discovered file of the
// configured spec group; a `d` reference through the binding must resolve to
// the imported file's node (an unresolved reference would be 14.5, and a
// misresolved one records the wrong edge target).
const T2_1_1_BASE_SOURCE = [
  '<S id="auth">',
  "Auth behavior.",
  "",
  '<S id="auth.login">',
  "Login behavior.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T2_1_1_IMPORTER_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="derived" d={BASE.auth.login}>',
  "Derived behavior.",
  "</S>",
  "",
].join("\n");

const T2_1_1 = defineProductTest({
  id: "T2.1-1",
  title:
    "a valid default import of a discovered spec-group file builds, and references through the binding resolve (SPEC 2.1)",
  run: async (product) => {
    await withWorkspace(
      {
        "specs/BASE.mdx": T2_1_1_BASE_SOURCE,
        "specs/A.mdx": T2_1_1_IMPORTER_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.1-1 `build` with a valid spec import",
        );
        const context = "T2.1-1 `query edges --from specs/A.mdx#derived`";
        const edges = decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--from", "specs/A.mdx#derived"],
            context,
          ),
          context,
        );
        // `derived` is a childless section, so the reference through the
        // binding is its complete outgoing edge set: exactly one `depends`
        // edge to the imported file's node (SPEC 2.1, 2.2, 5.2).
        assertEdgeSetEqual(
          edges,
          [
            {
              from: "specs/A.mdx#derived",
              to: "specs/BASE.mdx#auth.login",
              kind: "depends",
            },
          ],
          `${context}: the reference through the import binding resolves to the ` +
            "imported file's node (SPEC 2.1)",
        );
      },
    );
  },
});

// T2.1-2, invalid-specifier arms (SPEC 2.1: a specifier must be relative,
// begin with `./` or `../`, end in `.xspec`, and designate a discovered
// spec-group source). Each arm stages a legitimately existing `specs/BASE.mdx`
// so the specifier's form or target is the only defect.
const INVALID_SPECIFIER_ARMS: readonly InvalidImportArm[] = [
  {
    name: "an absolute specifier",
    importLine: 'import BASE from "/specs/BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "a bare (non-relative) specifier",
    importLine: 'import BASE from "BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "a relative specifier not ending in `.xspec` (naming the `.mdx` file directly)",
    importLine: 'import BASE from "./BASE.mdx"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    // `../docs/EXTRA.xspec` from `specs/` designates `docs/EXTRA.mdx`, which
    // exists on disk but is matched by no configured spec group.
    name: "a specifier designating a file that exists but is not a discovered source of any configured spec group",
    importLine: 'import EXTRA from "../docs/EXTRA.xspec"',
    extraFiles: {
      ...VALID_BASE_FILES,
      "docs/EXTRA.mdx": '<S id="extra">\nOutside every spec group.\n</S>\n',
    },
  },
  {
    name: "a relative `.xspec` specifier whose designated file does not exist (`./typo.xspec` with no `typo.mdx`)",
    importLine: 'import TYPO from "./typo.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
];

// T2.1-2, positive arm: `../` resolves against the importing file's
// directory. Run from the workspace root, `../BASE.xspec` resolves correctly
// only relative to `specs/sub/` — a product resolving against the working
// directory or the workspace root would escape the root or miss the file, and
// one resolving to any other node records the wrong edge target.
const PARENT_SPECIFIER_IMPORTER = [
  'import BASE from "../BASE.xspec"',
  "",
  '<S id="derived" d={BASE.core}>',
  "Derived behavior.",
  "</S>",
  "",
].join("\n");

const T2_1_2 = defineProductTest({
  id: "T2.1-2",
  title:
    "`../` specifiers resolve against the importing file's directory; absolute, bare, non-`.xspec`, undiscovered-target, and nonexistent-target specifiers each fail with 14.15 (SPEC 2.1, 14.15)",
  run: async (product) => {
    await withWorkspace(
      {
        ...VALID_BASE_FILES,
        "specs/sub/A.mdx": PARENT_SPECIFIER_IMPORTER,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.1-2 `build` with a `../` specifier",
        );
        const context = "T2.1-2 `query edges --from specs/sub/A.mdx#derived`";
        const edges = decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--from", "specs/sub/A.mdx#derived"],
            context,
          ),
          context,
        );
        assertEdgeSetEqual(
          edges,
          [
            {
              from: "specs/sub/A.mdx#derived",
              to: "specs/BASE.mdx#core",
              kind: "depends",
            },
          ],
          `${context}: \`../BASE.xspec\` resolves against the importing file's ` +
            "directory (specs/sub/) to specs/BASE.mdx (SPEC 2.1)",
        );
      },
    );
    for (const arm of INVALID_SPECIFIER_ARMS) {
      await runInvalidImportArm(product, arm, "T2.1-2");
    }
  },
});

// T2.1-3, invalid binding forms (SPEC 2.1: the only permitted form is a
// single default binding, and no import may bind `S`, `Spec`, or `text`).
const INVALID_BINDING_ARMS: readonly InvalidImportArm[] = [
  {
    name: "a named import from a `.xspec` specifier",
    importLine: 'import { core } from "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "a namespace import from a `.xspec` specifier",
    importLine: 'import * as BASE from "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "a side-effect-only import from a `.xspec` specifier",
    importLine: 'import "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "an import binding the compiler-provided identifier `S`",
    importLine: 'import S from "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "an import binding the compiler-provided identifier `Spec`",
    importLine: 'import Spec from "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
  {
    name: "an import binding the compiler-provided identifier `text`",
    importLine: 'import text from "./BASE.xspec"',
    extraFiles: VALID_BASE_FILES,
  },
];

// T2.1-3, positive arm: two imports binding the same module under different
// names. Each binding is exercised by its own section's `d` reference, so
// validity is grounded in both bindings actually resolving.
const TWO_LEAF_BASE_SOURCE = [
  '<S id="a">',
  "Leaf a.",
  "</S>",
  "",
  '<S id="b">',
  "Leaf b.",
  "</S>",
  "",
].join("\n");

const TWO_NAMES_IMPORTER_SOURCE = [
  'import BASE from "./BASE.xspec"',
  'import ALSO from "./BASE.xspec"',
  "",
  '<S id="one" d={BASE.a}>',
  "Uses the first binding.",
  "</S>",
  "",
  '<S id="two" d={ALSO.b}>',
  "Uses the second binding.",
  "</S>",
  "",
].join("\n");

// T2.1-3, duplicate-binding arm: two imports of two different modules binding
// the one identifier `BASE` (SPEC 2.1: no two imports in a file may bind the
// same identifier — 14.15, not a parse failure). Each import line is a known
// byte range for the location assertion.
const DUP_BINDING_FIRST = 'import BASE from "./B1.xspec"';
const DUP_BINDING_SECOND = 'import BASE from "./B2.xspec"';
const DUP_BINDING_SOURCE = `${DUP_BINDING_FIRST}\n${DUP_BINDING_SECOND}${IMPORTING_FILE_REST}`;

const T2_1_3 = defineProductTest({
  id: "T2.1-3",
  title:
    "named, namespace, and side-effect-only imports, duplicate-identifier bindings, and bindings of `S`/`Spec`/`text` each fail with 14.15; two imports binding one module under different names are valid (SPEC 2.1, 14.15)",
  run: async (product) => {
    for (const arm of INVALID_BINDING_ARMS) {
      await runInvalidImportArm(product, arm, "T2.1-3");
    }

    // Positive arm: same module, two names — valid, and both bindings work.
    await withWorkspace(
      {
        "specs/BASE.mdx": TWO_LEAF_BASE_SOURCE,
        "specs/A.mdx": TWO_NAMES_IMPORTER_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.1-3 `build` with two imports binding one module under different names",
        );
        const context = "T2.1-3 `query edges --kinds depends`";
        const edges = decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--kinds", "depends"],
            context,
          ),
          context,
        );
        assertEdgeSetEqual(
          edges,
          [
            {
              from: "specs/A.mdx#one",
              to: "specs/BASE.mdx#a",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#two",
              to: "specs/BASE.mdx#b",
              kind: "depends",
            },
          ],
          `${context}: both bindings of the one module resolve (SPEC 2.1)`,
        );
      },
    );

    // Duplicate-binding arm. SPEC 2.1 defines one condition over the
    // colliding pair; whether a product reports the collision once or per
    // import is not fixed, so one or two findings are accepted — every one
    // of them must be 14.15, name the file, and point at one of the two
    // import statements.
    const dupContext =
      "T2.1-3 `build --json` over two imports binding the same identifier";
    await withWorkspace(
      {
        "specs/B1.mdx": '<S id="b1">\nFirst module.\n</S>\n',
        "specs/B2.mdx": '<S id="b2">\nSecond module.\n</S>\n',
        "specs/A.mdx": DUP_BINDING_SOURCE,
      },
      async (workspace) => {
        const findings = await buildFindings(product, workspace, dupContext);
        const conditions = findings.map((finding) => finding.condition);
        if (
          findings.length < 1 ||
          findings.length > 2 ||
          conditions.some((condition) => condition !== "14.15")
        ) {
          fail(
            `${dupContext}: expected the colliding pair to report condition 14.15 — ` +
              `one finding for the collision, or one per import — got ` +
              `${JSON.stringify(conditions)}`,
          );
        }
        const windows = [
          byteWindow("", DUP_BINDING_FIRST),
          byteWindow(`${DUP_BINDING_FIRST}\n`, DUP_BINDING_SECOND),
        ];
        for (const finding of findings) {
          const findingContext = `${dupContext}: a 14.15 finding`;
          assertFindingLocated(
            finding,
            { file: "specs/A.mdx" },
            findingContext,
          );
          const { location } = finding;
          const within = windows.some(
            (window) =>
              location !== undefined &&
              location.start >= window.start &&
              location.end <= window.end,
          );
          if (!within) {
            fail(
              `${findingContext}: its location [${String(location?.start)}, ` +
                `${String(location?.end)}) must point at one of the two colliding ` +
                `import statements (byte windows ${JSON.stringify(windows)})`,
            );
          }
        }
      },
    );
  },
});

const T2_1_4 = defineProductTest({
  id: "T2.1-4",
  title:
    "an import whose binding is never used builds successfully and records no edges (SPEC 2.1, 5.2)",
  run: async (product) => {
    await withWorkspace(
      {
        "specs/BASE.mdx": '<S id="beta">\nBeta behavior.\n</S>\n',
        "specs/A.mdx": 'import BASE from "./BASE.xspec"' + IMPORTING_FILE_REST,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.1-4 `build` with an unused import",
        );
        // `query edges --from` each of the importing file's nodes (the root
        // and its one section): the unused import records no edges, so no
        // dependency-kind edge (depends/embeds/references — the only kinds
        // source constructs record, SPEC 5.2) and no edge toward the imported
        // file may leave them. Structural `contains` edges inside the
        // importing file are document structure, present with or without the
        // import, and permitted.
        for (const node of ["specs/A.mdx", "specs/A.mdx#alpha"]) {
          const context = `T2.1-4 \`query edges --from ${node}\``;
          const edges = decodeEdgesReport(
            await runJson(
              product,
              workspace,
              ["query", "edges", "--from", node],
              context,
            ),
            context,
          );
          const recorded = edges.filter(
            (edge) =>
              (DEPENDENCY_EDGE_KINDS as readonly string[]).includes(
                edge.kind,
              ) || edge.to.startsWith("specs/BASE.mdx"),
          );
          if (recorded.length > 0) {
            fail(
              `${context}: an unused import records no edges (SPEC 2.1) — no ` +
                `dependency-kind edge, and none toward the imported file, may ` +
                `leave the importing file's nodes; got ${JSON.stringify(recorded)}`,
            );
          }
        }
      },
    );
  },
});

// T2.1-5, two-file arm. The import cycle is A ↔ B, while the requirement-
// level dependency edges are acyclic by construction — `x → y` and `z → w`
// reach only childless sections with no outgoing dependency edges, so the
// combined contains/depends/embeds graph of SPEC 5.3 has no cycle and 14.9
// can only be the spec import cycle.
const CYCLE_A_SOURCE = [
  'import B from "./B.xspec"',
  "",
  '<S id="x" d={B.y}>',
  "Depends across files, acyclically.",
  "</S>",
  "",
  '<S id="w">',
  "Target of the other file's dependency.",
  "</S>",
  "",
].join("\n");

const CYCLE_B_SOURCE = [
  'import A from "./A.xspec"',
  "",
  '<S id="y">',
  "Target of the other file's dependency.",
  "</S>",
  "",
  '<S id="z" d={A.w}>',
  "Depends across files, acyclically.",
  "</S>",
  "",
].join("\n");

// The self-import arm: the import cycle of length one exists whether or not
// the binding is used, so it stays unused — the import itself is the defect.
const SELF_IMPORT_SOURCE =
  'import SELF from "./SELF.xspec"' + IMPORTING_FILE_REST;

/**
 * Assert an import-cycle report: every finding is 14.9 (nothing else is
 * present in these fixtures — both files parse, and every reference
 * resolves), at most one finding per participating file (whether a product
 * reports a cycle once or per file is not fixed), and the report identifies
 * every participating file (SPEC 14: actionable errors identify the file)
 * through any of a finding's file, message, or cycle-path information.
 */
function assertImportCycleFindings(
  findings: readonly Finding[],
  expectedFiles: readonly string[],
  context: string,
): void {
  const conditions = findings.map((finding) => finding.condition);
  if (
    findings.length < 1 ||
    findings.length > expectedFiles.length ||
    conditions.some((condition) => condition !== "14.9")
  ) {
    fail(
      `${context}: expected the spec import cycle to report condition 14.9 — one ` +
        `finding for the cycle, or at most one per participating file ` +
        `(${String(expectedFiles.length)}) — got ${JSON.stringify(conditions)}`,
    );
  }
  const identified = findings
    .map((finding) =>
      [finding.message, finding.file ?? "", ...(finding.cycle ?? [])].join(
        "\n",
      ),
    )
    .join("\n");
  for (const file of expectedFiles) {
    if (!identified.includes(file)) {
      fail(
        `${context}: the 14.9 report must identify the cycle's participating file ` +
          `${JSON.stringify(file)} (SPEC 14: actionable errors identify the file); ` +
          `findings: ${JSON.stringify(findings)}`,
      );
    }
  }
}

const T2_1_5 = defineProductTest({
  id: "T2.1-5",
  title:
    "a two-file spec import cycle fails with 14.9 even when no requirement-level dependency cycle exists; a file importing itself fails as a length-one import cycle (SPEC 2.1, 14.9)",
  run: async (product) => {
    await withWorkspace(
      { "specs/A.mdx": CYCLE_A_SOURCE, "specs/B.mdx": CYCLE_B_SOURCE },
      async (workspace) => {
        const context =
          "T2.1-5 `build --json` over a two-file spec import cycle " +
          "(requirement-level dependencies acyclic)";
        assertImportCycleFindings(
          await buildFindings(product, workspace, context),
          ["specs/A.mdx", "specs/B.mdx"],
          context,
        );
      },
    );
    await withWorkspace(
      { "specs/SELF.mdx": SELF_IMPORT_SOURCE },
      async (workspace) => {
        const context = "T2.1-5 `build --json` over a file importing itself";
        assertImportCycleFindings(
          await buildFindings(product, workspace, context),
          ["specs/SELF.mdx"],
          context,
        );
      },
    );
  },
});

/** TEST-SPEC §2.1, in canonical ID order (SUITE-06). */
export const section21Tests: readonly ProductTestEntry[] = [
  T2_1_1,
  T2_1_2,
  T2_1_3,
  T2_1_4,
  T2_1_5,
];
