// TEST-SPEC §2.4 (static argument rule) — SUITE-08: T2.4-1 … T2.4-4.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8). The
// T2.4-4 type-error arm exercises the generated module under standard
// TypeScript tooling with no xspec runtime dependency (SPEC 13.1, HARNESS-05).
//
// SPEC 2.4: the argument to `text(...)` and every reference in `d` MUST be a
// static string literal (a plain single- or double-quoted string — template
// literals are not static) or a static property chain rooted at an imported
// spec module: the import binding followed by zero or more segments, each a
// non-computed property access whose name is an identifier (`.login`) or a
// computed access whose index is a static string literal (`["login-v2"]`).
// No other syntax participates in a chain — optional chaining, non-null
// assertions, parentheses, and any other index or expression form make the
// reference dynamic — and a `text(...)` call MUST have exactly one argument;
// dynamic references and other arities are invalid (14.8). A chain segment is
// exactly one ID segment, and no segment contains `.` (1.4), so a dotted
// computed index resolves to nothing (14.5/14.6/14.7 by context), while a
// local string names a whole dotted path (2.2).
//
// Location assertions: fixtures are pure ASCII and composed as
// `prefix + construct + suffix` with exactly known parts, so string indices
// are byte offsets and each finding must fall within the offending
// construct's own byte window (end-widened by one byte for line-granular
// locations, see support.ts byteWindow); every other staged construct lies
// outside the widened window.

import type { GraphEdge } from "../../helpers/adapters/index.js";
import { decodeEdgesReport } from "../../helpers/adapters/index.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import {
  assertCompileErrorAt,
  ConsumerProject,
} from "../../helpers/tooling.js";
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

// Minimal declarative configuration (SPEC 7): exactly one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus one code group, for T2.4-4's TypeScript marker arm
// (SPEC 7.2): the marker's file must be a discovered code source for `build`
// to analyze it (4.5, 14.7).
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
 * The workspace's complete edge set of one dependency kind, via
 * `query edges --kinds <kind>` (SPEC 11). Asserted against an exact expected
 * set, this pins every recorded edge of the kind — none missing, none
 * phantom, no duplicates (edges of each kind form a set, SPEC 5.2).
 */
async function queryEdgesOfKind(
  product: ProductBinding,
  workspace: TestWorkspace,
  kind: "depends" | "embeds",
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

// ---------------------------------------------------------------------------
// T2.4-1
// ---------------------------------------------------------------------------

// Every accepted static form (SPEC 2.4) in one workspace, each exercised in
// `d` and in `text(...)`: double- and single-quoted string literals, a
// dot-access chain, computed access via a static string literal (double- and
// single-quoted index alike — "a plain single- or double-quoted string"), and
// mixed chains (dot-then-computed and computed-then-dot). The imported module
// carries non-identifier segments (`login-v2`, `pin-2`, `auth.sub-x`) so the
// computed arms use the form 2.4 defines them for (1.4).
const T2_4_1_BASE = [
  '<S id="login-v2">',
  "Dashed target.",
  "</S>",
  "",
  '<S id="pin-2">',
  "Second dashed target.",
  "</S>",
  "",
  '<S id="auth">',
  "Auth intro.",
  "",
  '<S id="auth.login">',
  "Login behavior.",
  "</S>",
  "",
  '<S id="auth.sub-x">',
  "Dashed child.",
  "</S>",
  "</S>",
  "",
].join("\n");

// Every arm targets its own distinct node (or declares from a distinct
// section), so the expected edge sets never rely on duplicate collapse
// (that is T2.2-3's subject) and each accepted form is pinned to its own
// recorded edge.
const T2_4_1_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="alpha">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="beta">',
  "Beta behavior.",
  "</S>",
  "",
  '<S id="dq" d={"alpha"}>',
  "Double-quoted local string.",
  "</S>",
  "",
  "<S id=\"sq\" d={'alpha'}>",
  "Single-quoted local string.",
  "</S>",
  "",
  '<S id="dot" d={BASE.auth.login}>',
  "Dot-access chain.",
  "</S>",
  "",
  '<S id="computed" d={[BASE["login-v2"], BASE[\'pin-2\']]}>',
  "Computed access via double- and single-quoted static string literals.",
  "</S>",
  "",
  '<S id="mixed" d={[BASE.auth["sub-x"], BASE["auth"].login]}>',
  "Mixed dot and computed chains.",
  "</S>",
  "",
  '<S id="embed">',
  'Double: {text("alpha")}',
  "Single: {text('beta')}",
  "Dot: {text(BASE.auth.login)}",
  'Computed: {text(BASE["login-v2"])}',
  'Mixed: {text(BASE.auth["sub-x"])}',
  "</S>",
  "",
].join("\n");

const T2_4_1 = defineProductTest({
  id: "T2.4-1",
  title:
    "double- and single-quoted string literals and property chains with dot access, computed access via static string literal, and mixed chains are all accepted in `d` and `text(...)` — the workspace builds and each form records its edge to the right target (SPEC 2.4, 2.2, 2.3)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/BASE.mdx": T2_4_1_BASE, "specs/A.mdx": T2_4_1_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.4-1 `build` with every accepted static form in `d` and `text(...)`",
        );
        // "All build" is grounded in the forms being accepted *as
        // references*: an unresolved reference would have failed the build
        // (14.5/14.6), and the exact edge sets pin each accepted form to the
        // target its spelling names (SPEC 2.2, 2.3) — a product that builds
        // by ignoring a form, or resolves a computed or mixed chain to the
        // wrong node, fails here.
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "depends", "T2.4-1"),
          [
            {
              from: "specs/A.mdx#dq",
              to: "specs/A.mdx#alpha",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#sq",
              to: "specs/A.mdx#alpha",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#dot",
              to: "specs/BASE.mdx#auth.login",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#computed",
              to: "specs/BASE.mdx#login-v2",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#computed",
              to: "specs/BASE.mdx#pin-2",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#mixed",
              to: "specs/BASE.mdx#auth.sub-x",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#mixed",
              to: "specs/BASE.mdx#auth.login",
              kind: "depends",
            },
          ],
          "T2.4-1 the complete `depends` edge set — one edge per accepted `d` form, " +
            "each resolved to the node its spelling names (SPEC 2.4, 2.2)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T2.4-1"),
          [
            {
              from: "specs/A.mdx#embed",
              to: "specs/A.mdx#alpha",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#embed",
              to: "specs/A.mdx#beta",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#embed",
              to: "specs/BASE.mdx#auth.login",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#embed",
              to: "specs/BASE.mdx#login-v2",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#embed",
              to: "specs/BASE.mdx#auth.sub-x",
              kind: "embeds",
            },
          ],
          "T2.4-1 the complete `embeds` edge set — one edge per accepted `text(...)` " +
            "form, each resolved to the node its spelling names (SPEC 2.4, 2.3)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.4-2
// ---------------------------------------------------------------------------

// The dynamic forms of SPEC 2.4, each run in `d` and in `text(...)`, in MDX.
// Every arm's workspace is otherwise valid — `specs/BASE.mdx` provides the
// `auth` node the chain forms name, and the local `alpha` node exists so a
// product wrongly treating the template literal as a static string would
// resolve it and exit 0 (caught by the exit-1 expectation) — making the one
// dynamic reference the only condition present (the exact count has teeth).
interface DynamicFormArm {
  /** Which SPEC 2.4 dynamic form this is (failure diagnostics). */
  readonly name: string;
  /** The offending reference expression, used verbatim in `d` and `text`. */
  readonly expression: string;
}

const DYNAMIC_FORM_ARMS: readonly DynamicFormArm[] = [
  { name: "a template literal argument", expression: "`alpha`" },
  { name: "an identifier as index", expression: "BASE[key]" },
  { name: "a call as index", expression: "BASE[getKey()]" },
  { name: "optional chaining", expression: "BASE?.auth" },
  { name: "a non-null assertion", expression: "BASE!.auth" },
  { name: "a parenthesized chain", expression: "(BASE.auth)" },
  {
    name: "a conditional expression",
    expression: "true ? BASE.auth : BASE.auth",
  },
];

// Shared preamble of every dynamic-form fixture: the import the chain forms
// are rooted at (unused imports are valid, SPEC 2.1, so it is harmless where
// a form never mentions BASE) and the `alpha` node. The offending construct
// starts exactly at this preamble's byte length.
const DYNAMIC_ARM_PREAMBLE =
  'import BASE from "./BASE.xspec"\n\n<S id="alpha">\nAlpha behavior.\n</S>\n\n';

const DYNAMIC_ARM_BASE_FILES = {
  "specs/BASE.mdx": '<S id="auth">\nAuth behavior.\n</S>\n',
} as const;

/**
 * Run one rejected-form arm: `build --json` exits 1 with exactly one finding,
 * condition 14.8, located within the offending construct's own byte window in
 * `specs/A.mdx` (SPEC 14: errors identify file and location).
 */
async function runRejectedFormArm(
  product: ProductBinding,
  source: string,
  window: { readonly start: number; readonly end: number },
  context: string,
): Promise<void> {
  await withWorkspace(
    SPECS_ONLY_CONFIG,
    { ...DYNAMIC_ARM_BASE_FILES, "specs/A.mdx": source },
    async (workspace) => {
      const findings = await buildFindings(product, workspace, context);
      assertConditionCounts(findings, { "14.8": 1 }, context);
      assertFindingLocated(
        findings[0]!,
        { file: "specs/A.mdx", window },
        `${context}: the 14.8 finding`,
      );
    },
  );
}

const T2_4_2 = defineProductTest({
  id: "T2.4-2",
  title:
    "each dynamic form — template literal argument; identifier or call as index; optional chaining; non-null assertion; parenthesized chain; conditional expression — fails with 14.8, in `d` and in `text(...)`, in MDX (SPEC 2.4, 14.8)",
  run: async (product) => {
    for (const arm of DYNAMIC_FORM_ARMS) {
      // In `d`: the offending construct is the opening tag carrying the
      // braced reference (SPEC 2.7: a braced `d` value that is not a static
      // reference or array literal of them is a dynamic argument, 14.8).
      const dConstruct = `<S id="bad" d={${arm.expression}}>`;
      await runRejectedFormArm(
        product,
        DYNAMIC_ARM_PREAMBLE + dConstruct + "\nBad reference.\n</S>\n",
        byteWindow(DYNAMIC_ARM_PREAMBLE, dConstruct),
        `T2.4-2 \`build --json\` with ${arm.name} in \`d\``,
      );

      // In `text(...)`: the offending construct is the embedding expression
      // on its own line inside an otherwise valid section.
      const textConstruct = `{text(${arm.expression})}`;
      const textPrefix = DYNAMIC_ARM_PREAMBLE + '<S id="bad">\n';
      await runRejectedFormArm(
        product,
        textPrefix + textConstruct + "\n</S>\n",
        byteWindow(textPrefix, textConstruct),
        `T2.4-2 \`build --json\` with ${arm.name} in \`text(...)\``,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T2.4-3
// ---------------------------------------------------------------------------

// Arity (SPEC 2.4: a `text(...)` call MUST have exactly one argument). The
// two-argument arm passes two static, resolvable local strings — both target
// nodes exist — so the arity is the arm's only defect (a product accepting
// two arguments would build clean and fail the exit-1 expectation), and the
// zero-argument arm has nothing to resolve at all; either way exactly one
// 14.8 must be reported, at the call.
const ARITY_PREAMBLE =
  '<S id="alpha">\nAlpha behavior.\n</S>\n\n<S id="beta">\nBeta behavior.\n</S>\n\n<S id="bad">\n';

const ARITY_ARMS: readonly { name: string; construct: string }[] = [
  { name: "zero arguments", construct: "{text()}" },
  { name: "two arguments", construct: '{text("alpha", "beta")}' },
];

const T2_4_3 = defineProductTest({
  id: "T2.4-3",
  title:
    "`text()` with zero and with two arguments fails with 14.8 (SPEC 2.4, 14.8)",
  run: async (product) => {
    for (const arm of ARITY_ARMS) {
      const context = `T2.4-3 \`build --json\` with \`text\` called with ${arm.name}`;
      await withWorkspace(
        SPECS_ONLY_CONFIG,
        { "specs/A.mdx": ARITY_PREAMBLE + arm.construct + "\n</S>\n" },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { "14.8": 1 }, context);
          assertFindingLocated(
            findings[0]!,
            {
              file: "specs/A.mdx",
              window: byteWindow(ARITY_PREAMBLE, arm.construct),
            },
            `${context}: the 14.8 finding`,
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T2.4-4
// ---------------------------------------------------------------------------

// Computed access is segment-exact (SPEC 2.4, 1.4): a chain segment is
// exactly one ID segment and no segment contains `.`, so against a module
// whose file contains nodes `a` and `a.b`, the *static* chain `BASE["a.b"]`
// resolves to nothing — its single segment `a.b` can name no node — while
// `BASE["a"]["b"]` and `BASE.a.b` resolve to node `a.b` and the same-file
// local string `d={"a.b"}` names the whole dotted *path* (SPEC 2.2).
const SEGMENT_EXACT_BASE =
  '<S id="a">\nA text.\n\n<S id="a.b">\nB text.\n</S>\n</S>\n';

// 14.5 arm: the dotted computed index in `d`.
const T2_4_4_D_PREFIX = 'import BASE from "./BASE.xspec"\n\n';
const T2_4_4_D_CONSTRUCT = '<S id="bad" d={BASE["a.b"]}>';
const T2_4_4_D_SOURCE =
  T2_4_4_D_PREFIX + T2_4_4_D_CONSTRUCT + "\nDotted computed index.\n</S>\n";

// 14.6 arm: the same chain as the `text(...)` argument.
const T2_4_4_TEXT_PREFIX = 'import BASE from "./BASE.xspec"\n\n<S id="bad">\n';
const T2_4_4_TEXT_CONSTRUCT = '{text(BASE["a.b"])}';
const T2_4_4_TEXT_SOURCE =
  T2_4_4_TEXT_PREFIX + T2_4_4_TEXT_CONSTRUCT + "\n</S>\n";

// 14.7 arm: the same chain as a TypeScript dependency marker (SPEC 4.5). The
// file is staged valid first — `BASE.a` is a resolving marker — so the
// workspace shape (config, import form, marker position) is proven accepted
// before the dotted index becomes the one defect; the first build also
// generates the spec module (13.1), and the failing second build modifies
// nothing (12.1), leaving the generated module in place for the type-error
// arm compiled under standard TypeScript tooling (HARNESS-05, SPEC 13.1).
const T2_4_4_VALID_CONSUMER =
  'import BASE from "../specs/BASE.xspec";\n\nBASE.a;\n';
const T2_4_4_MARKER_PREFIX = 'import BASE from "../specs/BASE.xspec";\n\n';
const T2_4_4_MARKER_CONSTRUCT = 'BASE["a.b"];';
const T2_4_4_MARKER_CONSUMER =
  T2_4_4_MARKER_PREFIX + T2_4_4_MARKER_CONSTRUCT + "\n";

// Positive arms: segment-per-index computed chain and dot chain resolve to
// node `a.b`; the local string names the dotted path within the declaring
// file. The importing file carries its *own* `a`/`a.b` nodes: BASE's
// same-named nodes are the decoys — a product resolving the local string in
// the imported file records `to: specs/BASE.mdx#a.b` and fails the exact
// edge-set comparison.
const T2_4_4_POSITIVE_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="a">',
  "Local a text.",
  "",
  '<S id="a.b">',
  "Local b text.",
  "</S>",
  "</S>",
  "",
  '<S id="viaBrackets" d={BASE["a"]["b"]}>',
  "Segment-per-index computed chain.",
  "</S>",
  "",
  '<S id="viaDots" d={BASE.a.b}>',
  "Dot chain.",
  "</S>",
  "",
  '<S id="viaLocal" d={"a.b"}>',
  "Local string naming the two-segment path.",
  "</S>",
  "",
].join("\n");

const T2_4_4 = defineProductTest({
  id: "T2.4-4",
  title:
    'computed access is segment-exact: `BASE["a.b"]` fails with 14.5 in `d`, 14.6 in `text(...)`, and 14.7 as a TypeScript marker (also a type error against the generated module), while `BASE["a"]["b"]`, `BASE.a.b`, and the local string `d={"a.b"}` resolve to node `a.b` (SPEC 2.4, 1.4, 2.2, 4.5, 14.5–14.7)',
  run: async (product) => {
    // 14.5: unresolved `d` reference — the segment `a.b` names no node even
    // though the node `a.b` exists (its path is two segments, `a` then `b`).
    const dContext =
      'T2.4-4 `build --json` with `d={BASE["a.b"]}` (dotted computed index)';
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/BASE.mdx": SEGMENT_EXACT_BASE, "specs/A.mdx": T2_4_4_D_SOURCE },
      async (workspace) => {
        const findings = await buildFindings(product, workspace, dContext);
        assertConditionCounts(findings, { "14.5": 1 }, dContext);
        assertFindingLocated(
          findings[0]!,
          {
            file: "specs/A.mdx",
            window: byteWindow(T2_4_4_D_PREFIX, T2_4_4_D_CONSTRUCT),
          },
          `${dContext}: the 14.5 finding`,
        );
      },
    );

    // 14.6: the same unresolvable chain as the `text(...)` argument.
    const textContext =
      'T2.4-4 `build --json` with `text(BASE["a.b"])` (dotted computed index)';
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        "specs/BASE.mdx": SEGMENT_EXACT_BASE,
        "specs/A.mdx": T2_4_4_TEXT_SOURCE,
      },
      async (workspace) => {
        const findings = await buildFindings(product, workspace, textContext);
        assertConditionCounts(findings, { "14.6": 1 }, textContext);
        assertFindingLocated(
          findings[0]!,
          {
            file: "specs/A.mdx",
            window: byteWindow(T2_4_4_TEXT_PREFIX, T2_4_4_TEXT_CONSTRUCT),
          },
          `${textContext}: the 14.6 finding`,
        );
      },
    );

    // 14.7 + type error: the same chain as a TypeScript dependency marker.
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/BASE.mdx": SEGMENT_EXACT_BASE,
        "src/app.ts": T2_4_4_VALID_CONSUMER,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.4-4 `build` with the resolving marker `BASE.a` (staging: proves the " +
            "workspace shape valid and generates the spec module, SPEC 13.1)",
        );

        await workspace.file("src/app.ts", T2_4_4_MARKER_CONSUMER);
        const markerContext =
          'T2.4-4 `build --json` with the TypeScript marker `BASE["a.b"]`';
        const findings = await buildFindings(product, workspace, markerContext);
        assertConditionCounts(findings, { "14.7": 1 }, markerContext);
        assertFindingLocated(
          findings[0]!,
          {
            file: "src/app.ts",
            window: byteWindow(T2_4_4_MARKER_PREFIX, T2_4_4_MARKER_CONSTRUCT),
          },
          `${markerContext}: the 14.7 finding`,
        );

        // The failing build modified nothing (SPEC 12.1), so the module
        // generated by the passing build is still in place: under standard
        // TypeScript tooling the marker must be a type error (14.7 "this is
        // also a type error against the generated module") — located at the
        // dotted index, which lies within the reported span whether the
        // compiler blames the whole element access or the index expression.
        const consumer = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["src/app.ts"],
        });
        assertCompileErrorAt(
          consumer,
          consumer.locate("src/app.ts", '["a.b"]', { charOffset: 2 }),
          {},
          'T2.4-4 the marker `BASE["a.b"]` against the generated module — no segment ' +
            "contains `.`, so no property `a.b` exists on the root node (SPEC 2.4, " +
            "1.4, 4.1, 14.7)",
        );
      },
    );

    // Positive arms: segment-exact spellings resolve to node `a.b`, and the
    // local string form names the dotted path (SPEC 2.2).
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        "specs/BASE.mdx": SEGMENT_EXACT_BASE,
        "specs/A.mdx": T2_4_4_POSITIVE_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.4-4 `build` with the segment-exact and local-string spellings",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(
            product,
            workspace,
            "depends",
            "T2.4-4 positive arms:",
          ),
          [
            {
              from: "specs/A.mdx#viaBrackets",
              to: "specs/BASE.mdx#a.b",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#viaDots",
              to: "specs/BASE.mdx#a.b",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#viaLocal",
              to: "specs/A.mdx#a.b",
              kind: "depends",
            },
          ],
          'T2.4-4 the complete `depends` edge set — `BASE["a"]["b"]` and ' +
            "`BASE.a.b` resolve to the imported node `a.b`, and the local string " +
            '`"a.b"` names the path within the declaring file, not the imported ' +
            "decoy (SPEC 2.4, 2.2, 1.5)",
        );
      },
    );
  },
});

/** TEST-SPEC §2.4, in canonical ID order (SUITE-08). */
export const section24Tests: readonly ProductTestEntry[] = [
  T2_4_1,
  T2_4_2,
  T2_4_3,
  T2_4_4,
];
