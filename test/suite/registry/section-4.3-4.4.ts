// TEST-SPEC §4.3 (text) and §4.4 (module branding) — SUITE-14: T4.3-1,
// T4.3-2, T4.4-1, T4.4-2.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4), decodes reports through the H-3 adapters, and rejects a product only
// via diagnosed assertion failures (H-8). Consumer-side contracts run under
// standard TypeScript tooling with no xspec runtime dependency (SPEC 13.1)
// through helpers/tooling.ts, in the CommonJS-mode arrangement described in
// section-4.ts. Files under `consumer/` are matched by no configured group
// (never analyzed by the product); files under `src/` are discovered
// code-group sources.
//
// Conservative operationalizations (noted per H-4 — wording is free, so only
// the stated observables are asserted):
// - T4.3-1 "returns the node's subtree text as a `string`" is asserted at the
//   type level (each call result assigned to a `string`-annotated binding
//   compiles clean), at runtime (`typeof` is "string"), and on bytes (stdout
//   equals the hand-derived expansions, SPEC 1.6/3). "From the calling code
//   location": the calls sit at file top level, so the location is the file
//   (SPEC 4.6), asserted as the file's complete outgoing edge set.
// - T4.3-2 arms stage exactly one defect each — the string/dynamic form. The
//   dynamic arms' chains would resolve to existing nodes if read statically
//   (`SPEC[key]` with key = "a"; `SPEC.a?.b` with `a.b` staged), so a product
//   cannot legitimately reclassify them as unresolved references (14.7): the
//   sole present condition is 14.8 (SPEC 2.4, 4.3, 4.5). Each finding must
//   fall within the offending statement's byte window (support.ts
//   byteWindow).
// - T4.4-1 asserts the condition's three facets (SPEC 14.11: reported by
//   `build`/`check`, "additionally a TypeScript type error and a runtime
//   throw per 4.4"; TEST-SPEC §14 names T4.4-1 the primary test for 14.11):
//   the home-context finding — a discovered code file with the cross-module
//   call fails `build --json` with exactly one located 14.11 finding — plus,
//   over an undiscovered consumer, the TypeScript type error at the consumer
//   reference and the runtime throw, reached "via the emitted JS" (standard
//   tsc emits despite the asserted type error — the TEST-SPEC alternative to
//   suppressing it; either way at the consumer's responsibility).
// - T4.4-1 "an error identifying both A (the node's module) and B (the
//   called module)": the two spec sources carry distinctive name stems
//   (ALPHAMOD, BRAVOMOD) contained in every rendering of a module's identity
//   — file name, workspace-relative path, `.xspec` specifier, root-node
//   identity — and the assertion is that the thrown error's standard textual
//   renderings (String(error), its message, the JSON of its enumerable own
//   properties) contain both stems (H-3 robust matching; an error from which
//   neither module is recoverable identifies nothing).
// - T4.4-2 "each alias accepts only its own module's nodes": acceptance is
//   the clean compile of both own-module calls plus their byte-exact runtime
//   values; "only" is a compile error at each cross-module argument (the
//   failing location is the consumer reference under test, TEST-SPEC §4
//   preamble).

import type { GraphEdge } from "../../helpers/adapters/index.js";
import { decodeEdgesReport } from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import {
  assertCompileErrorAt,
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
  buildFindings,
  buildOk,
  byteWindow,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. The
// consumer files under `consumer/` are outside every group by construction.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus one code group (SPEC 7.2): TypeScript files under
// `src/` are discovered code sources, so `build` analyzes their imports and
// spec-module usage (4, 4.5).
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

// ---------------------------------------------------------------------------
// T4.3-1 — text(node) runtime value and embeds edge
// ---------------------------------------------------------------------------

// A parent whose subtree text interleaves its own runs with a child's
// contribution and expands an embedding of the sibling `lib` (SPEC 1.6, 3),
// so the runtime value is discriminating: own text alone, unexpanded text,
// or wrong interleaving each miss the expected bytes. The final line is the
// unterminated inline `lib` section, so lib's subtree text carries no
// trailing terminator.
const T4_3_1_SPEC_SOURCE = [
  '<S id="alpha">',
  "Alpha heading line.",
  '<S id="alpha.child">',
  "Child line one.",
  "</S>",
  'Alpha trailing {text("lib")} inline.',
  "</S>",
  '<S id="lib">EMBED-PAYLOAD core.</S>',
].join("\n");

// Hand-derived per SPEC 3/1.6: tag-only lines drop with their terminators,
// content lines keep theirs, the embedding expands to lib's subtree text.
const T4_3_1_ALPHA_SUBTREE =
  "Alpha heading line.\n" +
  "Child line one.\n" +
  "Alpha trailing EMBED-PAYLOAD core. inline.\n";
const T4_3_1_LIB_SUBTREE = "EMBED-PAYLOAD core.";

// Both calls sit at file top level in a discovered code-group file; the
// `string` annotations make the declared return type an assertion, and the
// runtime `typeof` line makes the runtime type one. Storing and passing the
// call *results* is unrestricted — the 4.5 usage rules bind the spec-module
// bindings, not the returned strings.
const T4_3_1_CONSUMER_SOURCE = [
  'import SPEC, { text } from "../specs/MAIN.xspec";',
  "",
  "const alpha: string = text(SPEC.alpha);",
  "const lib: string = text(SPEC.lib);",
  'process.stdout.write(JSON.stringify([typeof alpha, typeof lib]) + "\\n");',
  "process.stdout.write(alpha);",
  "process.stdout.write(lib);",
  "",
].join("\n");

const T4_3_1_EXPECTED_STDOUT =
  '["string","string"]\n' + T4_3_1_ALPHA_SUBTREE + T4_3_1_LIB_SUBTREE;

const T4_3_1 = defineProductTest({
  id: "T4.3-1",
  title:
    "`text(node)` returns the node's subtree text as a `string` at runtime — byte-compared to the expected expansion — and records an `embeds` edge from the calling code location to the node, observed via `query edges` (SPEC 4.3, 4.6, 1.6, 13.1)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/MAIN.mdx": T4_3_1_SPEC_SOURCE,
        "src/app.ts": T4_3_1_CONSUMER_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.3-1 `build` over the embedding spec source and the consuming " +
            "code file",
        );

        // Each `text(node)` call records an `embeds` edge from the calling
        // code location — the file, for top-level calls (SPEC 4.3, 4.6) —
        // and those are the file's complete outgoing edges.
        assertEdgeSetEqual(
          await queryEdgesFrom(product, workspace, "src/app.ts", "T4.3-1"),
          [
            { from: "src/app.ts", to: "specs/MAIN.mdx#alpha", kind: "embeds" },
            { from: "src/app.ts", to: "specs/MAIN.mdx#lib", kind: "embeds" },
          ],
          "T4.3-1 each `text(node)` call records an `embeds` edge from the " +
            "calling code location (SPEC 4.3, 4.6), and nothing else leaves " +
            "the file",
        );

        // Under standard tooling (SPEC 13.1): the `string`-annotated
        // bindings type-check, and the compiled consumer's stdout carries
        // the runtime `typeof`s plus both subtree texts, byte-exact.
        const project = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["src/app.ts"],
        });
        assertNoCompileErrors(
          project,
          "T4.3-1 consumer assigning each `text(node)` result to a " +
            "`string`-annotated binding (SPEC 4.3: returns the subtree text " +
            "as a `string`)",
        );
        emitConsumer(project, "T4.3-1 consumer");
        const run = await runConsumer({
          dir: workspace.root,
          entry: "src/app.js",
        });
        assertExitCode(
          run,
          0,
          "T4.3-1 compiled consumer under plain Node (SPEC 13.1)",
        );
        assertBytesEqual(
          run.stdoutBytes,
          T4_3_1_EXPECTED_STDOUT,
          'T4.3-1 `text(node)` at runtime: `typeof` is "string" for both ' +
            "calls and each value is the node's subtree text with embedded " +
            "text fully expanded, byte-exact (SPEC 4.3, 1.6, 3)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.3-2 — string and dynamic text arguments in TypeScript are 14.8
// ---------------------------------------------------------------------------

// One spec source with a nested `a.b`, shared by every arm, so each dynamic
// chain would resolve if read statically — the form is each arm's sole
// defect.
const T4_3_2_SPEC_FILES = {
  "specs/A.mdx":
    '<S id="a">\nAlpha behavior.\n<S id="a.b">\nBeta behavior.\n</S>\n</S>\n',
} as const;

/** One invalid `text` argument arm: a workspace differing only in src/app.ts. */
interface InvalidTextArgumentArm {
  /** Which SPEC 4.3/2.4 invalid case this is (failure diagnostics). */
  readonly name: string;
  /** The lines of `src/app.ts`, pure ASCII, one statement per line. */
  readonly lines: readonly string[];
  /** The offending statement — exactly one of the lines. */
  readonly offending: string;
}

const T4_3_2_ARMS: readonly InvalidTextArgumentArm[] = [
  {
    name: "a string argument to `text` (the string form is MDX-only, SPEC 4.3)",
    lines: ['import { text } from "../specs/A.xspec";', "", 'text("a");'],
    offending: 'text("a");',
  },
  {
    name:
      "a computed index by variable as the `text` argument (dynamic node " +
      "form, SPEC 2.4)",
    lines: [
      'import SPEC, { text } from "../specs/A.xspec";',
      "",
      'const key = "a";',
      "text(SPEC[key]);",
    ],
    offending: "text(SPEC[key]);",
  },
  {
    name:
      "an optional-chaining chain as the `text` argument (dynamic node " +
      "form, SPEC 2.4)",
    lines: [
      'import SPEC, { text } from "../specs/A.xspec";',
      "",
      "text(SPEC.a?.b);",
    ],
    offending: "text(SPEC.a?.b);",
  },
];

const T4_3_2 = defineProductTest({
  id: "T4.3-2",
  title:
    "a string argument to `text` in a TypeScript file fails with 14.8, and so does a dynamic node-form argument there — a computed index by variable and an optional-chaining chain, each as the `text` argument (SPEC 4.3, 2.4, 4.5)",
  run: async (product) => {
    for (const arm of T4_3_2_ARMS) {
      const at = arm.lines.indexOf(arm.offending);
      if (at === -1 || arm.lines.lastIndexOf(arm.offending) !== at) {
        // A harness defect (never a product failure): the offending
        // statement must appear exactly once among the staged lines.
        throw new Error(
          `T4.3-2 fixture broke: the offending statement must appear ` +
            `exactly once (${arm.name}) — fix T4_3_2_ARMS in ` +
            `section-4.3-4.4.ts`,
        );
      }
      const source = arm.lines.map((line) => line + "\n").join("");
      const prefix = arm.lines
        .slice(0, at)
        .map((line) => line + "\n")
        .join("");
      const window = byteWindow(prefix, arm.offending);
      const context = `T4.3-2 \`build --json\` over ${arm.name}`;
      await withWorkspace(
        SPEC_AND_CODE_CONFIG,
        { ...T4_3_2_SPEC_FILES, "src/app.ts": source },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { "14.8": 1 }, context);
          assertFindingLocated(
            findings[0]!,
            { file: "src/app.ts", window },
            `${context}: the 14.8 finding`,
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T4.4-1 — cross-module text call: finding, type error, runtime throw
// ---------------------------------------------------------------------------

// Two spec modules with distinctive name stems: every rendering of a module's
// identity — file name, workspace-relative path, `.xspec` specifier,
// root-node identity — contains its stem, so "an error identifying both
// modules" must contain both (module-header operationalization). Neither
// stem occurs anywhere else in the fixtures.
const ALPHAMOD_STEM = "ALPHAMOD";
const BRAVOMOD_STEM = "BRAVOMOD";
const T4_4_SPEC_FILES = {
  "specs/ALPHAMOD.mdx": '<S id="first">\nAlpha module first behavior.\n</S>\n',
  "specs/BRAVOMOD.mdx":
    '<S id="second">\nBravo module second behavior.\n</S>\n',
} as const;
// Hand-derived subtree texts (SPEC 3/1.6).
const ALPHA_FIRST_TEXT = "Alpha module first behavior.\n";
const BRAVO_SECOND_TEXT = "Bravo module second behavior.\n";

// The home-context finding arm: a discovered code-group file whose only
// defect is the cross-module call — the argument is a static chain (2.4)
// that resolves, the callee is a spec module's `text` export (4.5), only the
// modules differ (14.11).
const T4_4_1_IMPORT_PREFIX =
  'import ALPHA from "../specs/ALPHAMOD.xspec";\n' +
  'import { text as textB } from "../specs/BRAVOMOD.xspec";\n' +
  "\n";
const T4_4_1_CROSS_STATEMENT = "textB(ALPHA.first);";

// The consumer for the type-error and runtime facets, outside every group:
// the call carries the expected (asserted) type error, tsc emits regardless,
// and the emitted JS reports whether the call threw plus every standard
// textual rendering of the thrown error.
const T4_4_1_CONSUMER_SOURCE = [
  'import ALPHA from "../specs/ALPHAMOD.xspec";',
  'import { text as textB } from "../specs/BRAVOMOD.xspec";',
  "",
  "let threw = false;",
  "const renderings: string[] = [];",
  "try {",
  "  const returned: unknown = textB(ALPHA.first);",
  "  renderings.push(String(returned));",
  "} catch (error) {",
  "  threw = true;",
  "  renderings.push(String(error));",
  '  if (error !== null && typeof error === "object") {',
  "    const message = (error as { message?: unknown }).message;",
  '    if (typeof message === "string") {',
  "      renderings.push(message);",
  "    }",
  "    try {",
  "      renderings.push(JSON.stringify(error));",
  "    } catch {",
  '      renderings.push("[JSON.stringify threw]");',
  "    }",
  "  }",
  "}",
  "process.stdout.write(JSON.stringify({ threw, renderings }));",
  "",
].join("\n");

/** Decode the cross-module consumer's report (harness-authored contract). */
function decodeCrossOutcome(payload: unknown): {
  readonly threw: boolean;
  readonly renderings: readonly string[];
} {
  const candidate = payload as {
    threw?: unknown;
    renderings?: unknown;
  } | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.threw !== "boolean" ||
    !Array.isArray(candidate.renderings) ||
    candidate.renderings.some((value) => typeof value !== "string")
  ) {
    fail(
      "T4.4-1: the cross-module consumer must report " +
        "`{ threw, renderings }` — harness-authored consumer contract; got " +
        JSON.stringify(payload),
    );
  }
  return candidate as { threw: boolean; renderings: string[] };
}

const T4_4_1 = defineProductTest({
  id: "T4.4-1",
  title:
    "passing a node from module A to module B's `text` export is 14.11 — exactly one located finding from `build` — and a TypeScript type error at the consumer reference; executed via the emitted JS, the call throws at runtime with an error identifying both A (the node's module) and B (the called module) (SPEC 4.4, 14.11, 13.1)",
  run: async (product) => {
    // Facet 1 — the home-context condition: exactly one 14.11 finding,
    // located at the cross-module call in the discovered code file.
    {
      const context =
        "T4.4-1 `build --json` over a discovered code file passing module " +
        "A's node to module B's `text` export";
      const window = byteWindow(T4_4_1_IMPORT_PREFIX, T4_4_1_CROSS_STATEMENT);
      await withWorkspace(
        SPEC_AND_CODE_CONFIG,
        {
          ...T4_4_SPEC_FILES,
          "src/app.ts": T4_4_1_IMPORT_PREFIX + T4_4_1_CROSS_STATEMENT + "\n",
        },
        async (workspace) => {
          const findings = await buildFindings(product, workspace, context);
          assertConditionCounts(findings, { "14.11": 1 }, context);
          assertFindingLocated(
            findings[0]!,
            { file: "src/app.ts", window },
            `${context}: the 14.11 finding`,
          );
        },
      );
    }

    // Facets 2 and 3 — the consumer-side type error and the runtime throw,
    // over generated modules from a valid build (consumer outside every
    // group).
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { ...T4_4_SPEC_FILES, "consumer/cross.ts": T4_4_1_CONSUMER_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.4-1 `build` over the two spec modules",
        );
        const project = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["consumer/cross.ts"],
        });
        assertCompileErrorAt(
          project,
          project.locate("consumer/cross.ts", "textB(ALPHA.first)", {
            charOffset: "textB(".length,
          }),
          {},
          "T4.4-1 passing module A's node to module B's `text` export must " +
            "be a TypeScript type error at the consumer reference " +
            "(SPEC 4.4, 14.11)",
        );

        // "Executed via the emitted JS": standard tsc emits despite the
        // asserted type error, and the call must throw at runtime.
        emitConsumer(project, "T4.4-1 cross-module consumer");
        const run = await runConsumer({
          dir: workspace.root,
          entry: "consumer/cross.js",
        });
        assertExitCode(
          run,
          0,
          "T4.4-1 compiled cross-module consumer under plain Node — the " +
            "consumer catches the expected throw itself (SPEC 13.1)",
        );
        const outcome = decodeCrossOutcome(
          parseJsonStdout(run, "T4.4-1 cross-module consumer output"),
        );
        if (!outcome.threw) {
          fail(
            "T4.4-1: the cross-module call did not throw at runtime — " +
              "`textB(ALPHA.first)` returned " +
              JSON.stringify(outcome.renderings[0] ?? "") +
              " (SPEC 4.4: at runtime the call MUST throw an error " +
              "identifying both the node's module and the called module)",
          );
        }
        const combined = outcome.renderings.join("\n");
        for (const [stem, role] of [
          [ALPHAMOD_STEM, "A (the node's module)"],
          [BRAVOMOD_STEM, "B (the called module)"],
        ] as const) {
          if (!combined.includes(stem)) {
            fail(
              `T4.4-1: the runtime error must identify ${role} — no ` +
                `standard rendering of the thrown error (String(error), ` +
                `its message, the JSON of its enumerable own properties) ` +
                `mentions the module's distinctive source name ` +
                `${JSON.stringify(stem)}, which every rendering of the ` +
                `module's identity contains (SPEC 4.4); renderings: ` +
                JSON.stringify(outcome.renderings),
            );
          }
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.4-2 — two spec modules in one file, aliased text per module
// ---------------------------------------------------------------------------

// Acceptance: both own-module calls in one file compile clean and return
// their own module's subtree texts at runtime.
const T4_4_2_ACCEPT_SOURCE = [
  'import ALPHA, { text as textA } from "../specs/ALPHAMOD.xspec";',
  'import BRAVO, { text as textB } from "../specs/BRAVOMOD.xspec";',
  "",
  "process.stdout.write(textA(ALPHA.first));",
  "process.stdout.write(textB(BRAVO.second));",
  "",
].join("\n");

// "Only": each alias rejects the other module's node — a compile error at
// each cross-module argument.
const T4_4_2_REJECT_SOURCE = [
  'import ALPHA, { text as textA } from "../specs/ALPHAMOD.xspec";',
  'import BRAVO, { text as textB } from "../specs/BRAVOMOD.xspec";',
  "",
  "textA(BRAVO.second);",
  "textB(ALPHA.first);",
  "",
].join("\n");

const T4_4_2 = defineProductTest({
  id: "T4.4-2",
  title:
    "consuming two spec modules in one file with aliased `text` imports: each alias accepts only its own module's nodes — own-module calls compile clean and return their texts, cross-module arguments are TypeScript type errors at the consumer references (SPEC 4.4, 13.1)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        ...T4_4_SPEC_FILES,
        "consumer/accept.ts": T4_4_2_ACCEPT_SOURCE,
        "consumer/reject.ts": T4_4_2_REJECT_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.4-2 `build` over the two spec modules",
        );

        const accept = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["consumer/accept.ts"],
        });
        assertNoCompileErrors(
          accept,
          "T4.4-2 one file consuming two spec modules with aliased `text` " +
            "imports: each alias accepts its own module's nodes (SPEC 4.4)",
        );
        emitConsumer(accept, "T4.4-2 accept consumer");
        const run = await runConsumer({
          dir: workspace.root,
          entry: "consumer/accept.js",
        });
        assertExitCode(
          run,
          0,
          "T4.4-2 compiled accept consumer under plain Node (SPEC 13.1)",
        );
        assertBytesEqual(
          run.stdoutBytes,
          ALPHA_FIRST_TEXT + BRAVO_SECOND_TEXT,
          "T4.4-2 each aliased `text` returns its own module's subtree " +
            "text at runtime, byte-exact (SPEC 4.4, 4.3, 1.6)",
        );

        const reject = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["consumer/reject.ts"],
        });
        assertCompileErrorAt(
          reject,
          reject.locate("consumer/reject.ts", "textA(BRAVO.second)", {
            charOffset: "textA(".length,
          }),
          {},
          "T4.4-2 module B's node passed to module A's aliased `text` must " +
            "be a TypeScript type error at the consumer reference (SPEC 4.4)",
        );
        assertCompileErrorAt(
          reject,
          reject.locate("consumer/reject.ts", "textB(ALPHA.first)", {
            charOffset: "textB(".length,
          }),
          {},
          "T4.4-2 module A's node passed to module B's aliased `text` must " +
            "be a TypeScript type error at the consumer reference (SPEC 4.4)",
        );
      },
    );
  },
});

/** TEST-SPEC §4.3–4.4, in canonical ID order (SUITE-14). */
export const section43to44Tests: readonly ProductTestEntry[] = [
  T4_3_1,
  T4_3_2,
  T4_4_1,
  T4_4_2,
];
