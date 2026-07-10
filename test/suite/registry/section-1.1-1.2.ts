// TEST-SPEC §1.1 (requirement section) and §1.2 (implicit root) — SUITE-01:
// T1.1-1, T1.1-2, T1.1-3, T1.2-1, T1.2-2, T1.2-3.
//
// Registered product-facing bodies (C-2 "one code path"): each receives only
// the product binding, builds its own fresh workspace (H-1), drives the
// product strictly as a subprocess (H-2), asserts exact exit codes (H-5) and
// exact bytes where SPEC.md fixes bytes (H-4), decodes JSON output through
// the H-3 adapters, and rejects a product only via diagnosed assertion
// failures (H-8). Consumer-side contracts — the generated-module skeleton
// (SPEC 4.1) and `text()` at runtime (SPEC 4.3) — are exercised under
// standard TypeScript tooling with no xspec runtime dependency (SPEC 13.1)
// through helpers/tooling.ts. Consumer workspaces carry no package.json, so
// consumer files compile and run in CommonJS mode under the driver's NodeNext
// defaults — the standard-tooling arrangement in which the spec-fixed
// specifier `./NAME.xspec` (SPEC 4) resolves by Node's extension lookup.

import {
  decodeCoverageReport,
  decodeNodeReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  assertFilesEqual,
  fail,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  assertCompileErrorAt,
  assertNoCompileErrors,
  ConsumerProject,
  formatConsumerDiagnostic,
  runConsumer,
} from "../../helpers/tooling.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
  runJson,
  sortedIdentities,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// As above with Markdown emission enabled (SPEC 7.3; default destination:
// next to each source file, `specs/A.mdx` → `specs/A.md`).
const MARKDOWN_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

const T1_1_1 = defineProductTest({
  id: "T1.1-1",
  title:
    "a section becomes a requirement node: `query node` reports identity, text, hashes, and edges (SPEC 1.1)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": '<S id="login">\nThe product supports login.\n</S>\n',
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T1.1-1 `build` over one requirement section",
      );
      const label = "T1.1-1 `query node specs/A.mdx#login`";
      const node = decodeNodeReport(
        await runJson(
          product,
          workspace,
          ["query", "node", "specs/A.mdx#login"],
          label,
        ),
        label,
      );
      if (node.identity !== "specs/A.mdx#login") {
        fail(
          `${label}: expected the workspace-relative identity "specs/A.mdx#login" (SPEC 1.5), ` +
            `got ${JSON.stringify(node.identity)}`,
        );
      }
      // SPEC 1.6/3: the tag-only lines are removed and dropped with their
      // terminators, so the section's contribution — its subtree text, and
      // (leaf) its own text — is exactly the prose line.
      assertBytesEqual(
        node.subtreeText,
        "The product supports login.\n",
        `${label}: subtree text`,
      );
      assertBytesEqual(
        node.ownText,
        "The product supports login.\n",
        `${label}: own text (a leaf's own text equals its subtree text)`,
      );
      // All four hashes present as non-empty strings is enforced by the
      // adapter; the values are opaque (H-4).
      // Edges: exactly the structural `contains` edge from the file root —
      // nothing else exists in this workspace (SPEC 1.2, 5.2).
      assertEdgeSetEqual(node.outgoingEdges, [], `${label}: outgoing edges`);
      assertEdgeSetEqual(
        node.incomingEdges,
        [{ from: "specs/A.mdx", to: "specs/A.mdx#login", kind: "contains" }],
        `${label}: incoming edges`,
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// One source file in either tag style (T1.1-2): nested and props-bearing
// sections (`tags`, `coverage`, a local-form `d`), differing only in the tag
// name spelled.
function tagStyleSource(tag: "S" | "Spec"): string {
  return [
    `<${tag} id="login" tags="auth critical">`,
    "Login behavior.",
    "",
    `<${tag} id="login.validCredentials">`,
    "A user with valid credentials can log in.",
    `</${tag}>`,
    `</${tag}>`,
    "",
    `<${tag} id="meta" coverage="none" d={["login.validCredentials"]}>`,
    "Metadata section.",
    `</${tag}>`,
    "",
  ].join("\n");
}

const MIXED_TAGS_SOURCE = [
  '<S id="outer">',
  "Outer behavior.",
  "",
  '<Spec id="outer.inner">',
  "Inner behavior.",
  "</Spec>",
  "</S>",
  "",
  '<Spec id="solo" />',
  "",
].join("\n");

// The identical consumer compiles against both workspaces' generated modules:
// bare references are dependency markers (SPEC 4.5), so a clean compile of
// the full chain set demonstrates both modules expose the same skeleton.
const SKELETON_CONSUMER = [
  'import SPEC from "./specs/A.xspec";',
  "",
  "SPEC.login;",
  "SPEC.login.validCredentials;",
  "SPEC.meta;",
  "",
].join("\n");

const T1_1_2 = defineProductTest({
  id: "T1.1-2",
  title:
    "`<S>` and `<Spec>` are equivalent: same builds, byte-identical Markdown, same node set, same generated skeleton; mixing both in one file is valid (SPEC 1.1)",
  run: async (product) => {
    const sForm = await TestWorkspace.create({
      files: {
        "xspec.config.ts": MARKDOWN_CONFIG,
        "specs/A.mdx": tagStyleSource("S"),
      },
    });
    const specForm = await TestWorkspace.create({
      files: {
        "xspec.config.ts": MARKDOWN_CONFIG,
        "specs/A.mdx": tagStyleSource("Spec"),
      },
    });
    const mixedForm = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": MIXED_TAGS_SOURCE,
      },
    });
    try {
      await buildOk(product, sForm, "T1.1-2 `build` of the `<S>` workspace");
      await buildOk(
        product,
        specForm,
        "T1.1-2 `build` of the `<Spec>` workspace",
      );

      // Markdown outputs are byte-identical (the tags are removed either way,
      // SPEC 3; emitted next to the source, SPEC 7.3/13.2).
      await assertFilesEqual(
        sForm.path("specs/A.md"),
        specForm.path("specs/A.md"),
        "T1.1-2 emitted Markdown of the `<S>` workspace vs the `<Spec>` workspace",
      );

      // `query nodes` reports the same node set. Compared on identity, tags,
      // and coverage — source ranges are excluded, since the two spellings
      // legitimately differ in byte length.
      const nodeSetOf = async (
        workspace: TestWorkspace,
        label: string,
      ): Promise<
        { identity: string; tags: string[]; coverage: string | null }[]
      > => {
        const rows = decodeNodeRowsReport(
          await runJson(product, workspace, ["query", "nodes"], label),
          label,
        );
        return rows
          .map((row) => ({
            identity: row.identity,
            tags: [...row.tags].sort(),
            coverage: row.coverage ?? null,
          }))
          .sort((x, y) =>
            x.identity < y.identity ? -1 : x.identity > y.identity ? 1 : 0,
          );
      };
      const sNodes = await nodeSetOf(sForm, "T1.1-2 `query nodes` (`<S>`)");
      const specNodes = await nodeSetOf(
        specForm,
        "T1.1-2 `query nodes` (`<Spec>`)",
      );
      assertSameJson(
        specNodes,
        sNodes,
        "T1.1-2 node set (identity, tags, coverage) of the `<Spec>` workspace vs the `<S>` workspace",
      );
      for (const identity of [
        "specs/A.mdx#login",
        "specs/A.mdx#login.validCredentials",
        "specs/A.mdx#meta",
      ]) {
        if (!sNodes.some((row) => row.identity === identity)) {
          fail(
            `T1.1-2: expected ${identity} in the reported node set; got ` +
              JSON.stringify(sNodes.map((row) => row.identity)),
          );
        }
      }

      // Generated modules expose the same skeleton: the identical consumer
      // compiles cleanly against both (SPEC 4.1, 13.1).
      for (const [workspace, styleLabel] of [
        [sForm, "<S>"],
        [specForm, "<Spec>"],
      ] as const) {
        await workspace.file("consumer.ts", SKELETON_CONSUMER);
        const project = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["consumer.ts"],
        });
        assertNoCompileErrors(
          project,
          `T1.1-2 skeleton consumer against the ${styleLabel} workspace's generated module`,
        );
      }

      // Mixing both tag names in one file is valid.
      await buildOk(
        product,
        mixedForm,
        "T1.1-2 `build` of the mixed `<S>`/`<Spec>` workspace",
      );
      const mixedLabel = "T1.1-2 `query nodes` (mixed tag names)";
      const mixedRows = decodeNodeRowsReport(
        await runJson(product, mixedForm, ["query", "nodes"], mixedLabel),
        mixedLabel,
      );
      for (const identity of [
        "specs/A.mdx#outer",
        "specs/A.mdx#outer.inner",
        "specs/A.mdx#solo",
      ]) {
        if (!mixedRows.some((row) => row.identity === identity)) {
          fail(
            `${mixedLabel}: expected ${identity} among the nodes of the mixed-tag file; got ` +
              JSON.stringify(sortedIdentities(mixedRows)),
          );
        }
      }
    } finally {
      await Promise.all([
        sForm.dispose(),
        specForm.dispose(),
        mixedForm.dispose(),
      ]);
    }
  },
});

const SELF_CLOSING_SOURCE = [
  '<S id="main">',
  "Main behavior.",
  "</S>",
  "",
  '<S id="todo" />',
  "",
  '<Spec id="empty" />',
  "",
].join("\n");

// A coverage profile over the one spec group (boundary = the same group,
// `boundaryKind` inferred since the name is unambiguous, SPEC 7.4): with no
// dependency edges staged, every required node is uncovered, making
// "coverage-required by default" observable for the self-closing leaves.
const LEAF_PROFILE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "p",
      target: "main",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

const VALID_LEAF_CONSUMER = [
  'import SPEC from "./specs/A.xspec";',
  "",
  "SPEC.main;",
  "SPEC.todo;",
  "SPEC.empty;",
  "",
].join("\n");

const CHILD_CHAIN_CONSUMER = [
  'import SPEC from "./specs/A.xspec";',
  "",
  "SPEC.todo.child;",
  "",
].join("\n");

const T1_1_3 = defineProductTest({
  id: "T1.1-3",
  title:
    "self-closing sections are empty leaves: empty texts, singleton subtree, no outgoing `contains`, childless skeleton, coverage-required (SPEC 1.1)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": LEAF_PROFILE_CONFIG,
        "specs/A.mdx": SELF_CLOSING_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T1.1-3 `build` of a file mixing paired and self-closing sections",
      );
      for (const id of ["todo", "empty"]) {
        const identity = `specs/A.mdx#${id}`;
        const label = `T1.1-3 \`query node ${identity}\``;
        const node = decodeNodeReport(
          await runJson(product, workspace, ["query", "node", identity], label),
          label,
        );
        if (node.identity !== identity) {
          fail(
            `${label}: a self-closing section is addressable like any section (SPEC 1.1/1.5); ` +
              `expected identity ${JSON.stringify(identity)}, got ${JSON.stringify(node.identity)}`,
          );
        }
        assertBytesEqual(
          node.ownText,
          "",
          `${label}: own text of an empty leaf`,
        );
        assertBytesEqual(
          node.subtreeText,
          "",
          `${label}: subtree text of an empty leaf`,
        );
        if (node.coverage !== "required") {
          fail(
            `${label}: a self-closing section is coverage-required by default (SPEC 2.5); ` +
              `got coverage ${JSON.stringify(node.coverage ?? null)}`,
          );
        }
        assertEdgeSetEqual(
          node.outgoingEdges,
          [],
          `${label}: no edge — in particular no \`contains\` — leaves an empty leaf`,
        );
        const subtreeLabel = `T1.1-3 \`query subtree ${identity}\``;
        const rows = decodeNodeRowsReport(
          await runJson(
            product,
            workspace,
            ["query", "subtree", identity],
            subtreeLabel,
          ),
          subtreeLabel,
        );
        assertSameJson(
          rows.map((row) => row.identity),
          [identity],
          `${subtreeLabel}: an empty leaf's subtree is only the node itself`,
        );
      }

      // Coverage-required by default (SPEC 2.5, 8.1): with no dependency
      // edges in the workspace, both leaves must show up as uncovered.
      const coverageLabel = "T1.1-3 `coverage --json`";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageLabel,
        ),
        coverageLabel,
      );
      const profile = coverage.profiles.find(
        (candidate) => candidate.name === "p",
      );
      if (!profile) {
        fail(
          `${coverageLabel}: profile "p" missing from the report; got profiles ` +
            JSON.stringify(
              coverage.profiles.map((candidate) => candidate.name),
            ),
        );
      }
      for (const identity of ["specs/A.mdx#todo", "specs/A.mdx#empty"]) {
        if (!profile.uncovered.includes(identity)) {
          fail(
            `${coverageLabel}: ${identity} is coverage-required by default (SPEC 2.5/8.1) and — ` +
              `with no dependency edges staged — must be uncovered; uncovered: ` +
              JSON.stringify([...profile.uncovered].sort()),
          );
        }
      }

      // Generated module (SPEC 4.1): the empty leaves exist as nodes with no
      // child properties — the full-chain consumer compiles, a child chain on
      // a leaf is a type error.
      await workspace.file("consumer.ts", VALID_LEAF_CONSUMER);
      await workspace.file("bad-consumer.ts", CHILD_CHAIN_CONSUMER);
      const valid = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["consumer.ts"],
      });
      assertNoCompileErrors(
        valid,
        "T1.1-3 consumer referencing the self-closing nodes",
      );
      const invalid = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["bad-consumer.ts"],
      });
      assertCompileErrorAt(
        invalid,
        invalid.locate("bad-consumer.ts", "SPEC.todo.child", {
          charOffset: "SPEC.todo.".length,
        }),
        {},
        "T1.1-3 child chain on an empty leaf (a missing requirement path is a type error, SPEC 4.1)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

const ROOT_ORDER_SOURCE = [
  "Intro prose.",
  "",
  '<S id="a">',
  "Alpha.",
  "",
  '<S id="a.b">',
  "Alpha bee.",
  "</S>",
  "</S>",
  "",
  '<S id="c">',
  "Sea.",
  "</S>",
  "",
].join("\n");

const T1_2_1 = defineProductTest({
  id: "T1.2-1",
  title:
    "the root node is queryable by bare path, has no id, and `query subtree` returns it first, then every section in document order (SPEC 1.2)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": ROOT_ORDER_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T1.2-1 `build`");
      const label = "T1.2-1 `query node specs/A.mdx`";
      const root = decodeNodeReport(
        await runJson(
          product,
          workspace,
          ["query", "node", "specs/A.mdx"],
          label,
        ),
        label,
      );
      if (root.identity !== "specs/A.mdx") {
        fail(
          `${label}: the root node has no id and is identified by the source file path alone ` +
            `(SPEC 1.2/1.5); expected identity "specs/A.mdx", got ${JSON.stringify(root.identity)}`,
        );
      }
      const subtreeLabel = "T1.2-1 `query subtree specs/A.mdx`";
      const rows = decodeNodeRowsReport(
        await runJson(
          product,
          workspace,
          ["query", "subtree", "specs/A.mdx"],
          subtreeLabel,
        ),
        subtreeLabel,
      );
      assertSameJson(
        rows.map((row) => row.identity),
        ["specs/A.mdx", "specs/A.mdx#a", "specs/A.mdx#a.b", "specs/A.mdx#c"],
        `${subtreeLabel}: the root first, then every section of the file in document order (SPEC 1.2, 11)`,
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// Exact bytes with the compiled output known by hand (SPEC 3: the tag-only
// lines are dropped with their terminators; everything else is preserved).
const ROOT_TEXT_SOURCE = [
  "# Title",
  "",
  "Intro prose.",
  "",
  '<S id="alpha">',
  "Alpha requirement.",
  "",
  '<S id="alpha.one">',
  "Alpha one.",
  "</S>",
  "</S>",
  "",
  '<S id="beta" />',
  "",
].join("\n");

const ROOT_TEXT_COMPILED =
  "# Title\n\nIntro prose.\n\nAlpha requirement.\n\nAlpha one.\n\n";

const ROOT_TEXT_CONSUMER = [
  'import SPEC, { text } from "./specs/A.xspec";',
  "",
  "process.stdout.write(text(SPEC));",
  "",
].join("\n");

const T1_2_2 = defineProductTest({
  id: "T1.2-2",
  title:
    "the generated module's default export is the root node: `text(default export)` returns the file's entire compiled Markdown output (SPEC 1.2, 4.3)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": ROOT_TEXT_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T1.2-2 `build`");
      await workspace.file("main.ts", ROOT_TEXT_CONSUMER);
      const project = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["main.ts"],
      });
      assertNoCompileErrors(
        project,
        "T1.2-2 consumer passing the default export to `text()`",
      );
      const emitted = project.emit();
      if (emitted.emitSkipped) {
        fail(
          "T1.2-2: consumer emit was skipped; diagnostics:\n" +
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
        "T1.2-2 compiled consumer under plain Node (SPEC 13.1)",
      );
      assertBytesEqual(
        run.stdoutBytes,
        ROOT_TEXT_COMPILED,
        "T1.2-2 `text(default export)`: the entire compiled Markdown output of the file — the root's subtree text (SPEC 1.2, 1.6, 3)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

const ROOT_COVERAGE_SOURCE = [
  '<S id="a" d={["b"]}>',
  "Alpha depends on beta.",
  "</S>",
  "",
  '<S id="b">',
  "Beta.",
  "</S>",
  "",
  '<S id="c" coverage="none">',
  "Gamma is not a coverage target.",
  "</S>",
  "",
].join("\n");

// `targets: "all"` (T1.2-3): the target set is not restricted to leaves, so
// only the root exclusion and `coverage="none"` shape the required set.
const ALL_TARGETS_PROFILE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "p",
      target: "main",
      targets: "all",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

const T1_2_3 = defineProductTest({
  id: "T1.2-3",
  title:
    "roots are never coverage targets: ignored with reason `root node`, absent from required/covered/uncovered, unmatched by `--coverage`, coverage attribute absent (SPEC 1.2, 8, 11)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": ALL_TARGETS_PROFILE_CONFIG,
        "specs/A.mdx": ROOT_COVERAGE_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T1.2-3 `build`");

      const coverageLabel = "T1.2-3 `coverage --json`";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageLabel,
        ),
        coverageLabel,
      );
      if (
        coverage.profiles.length !== 1 ||
        coverage.profiles[0]!.name !== "p"
      ) {
        fail(
          `${coverageLabel}: expected exactly the one configured profile "p" (SPEC 8.2); got ` +
            JSON.stringify(
              coverage.profiles.map((candidate) => candidate.name),
            ),
        );
      }
      const profile = coverage.profiles[0]!;
      // Required = {a, b}: the root is always excluded (SPEC 8.1) and c is
      // `coverage="none"` — the root is never counted or listed.
      if (profile.counts.required !== 2) {
        fail(
          `${coverageLabel}: the required set must be exactly {specs/A.mdx#a, specs/A.mdx#b} — ` +
            `roots are always excluded and c is coverage="none" (SPEC 8.1); got required count ` +
            String(profile.counts.required),
        );
      }
      assertSameJson(
        sortedIdentities(profile.covered),
        ["specs/A.mdx#b"],
        `${coverageLabel}: covered nodes (b via the boundary edge a -> b; no root listed)`,
      );
      assertSameJson(
        profile.covered[0]!.path,
        ["specs/A.mdx#a", "specs/A.mdx#b"],
        `${coverageLabel}: the covering path — roots never appear in a coverage path (SPEC 1.2, 8)`,
      );
      assertSameJson(
        [...profile.uncovered].sort(),
        ["specs/A.mdx#a"],
        `${coverageLabel}: uncovered nodes (no root listed)`,
      );
      const rootEntry = profile.ignored.find(
        (entry) => entry.identity === "specs/A.mdx",
      );
      if (!rootEntry) {
        fail(
          `${coverageLabel}: the root of a file in the target group must be reported ignored ` +
            `(SPEC 8.2); ignored entries: ` +
            JSON.stringify(profile.ignored.map((entry) => entry.identity)),
        );
      }
      assertSameJson(
        rootEntry.reasons,
        ["root node"],
        `${coverageLabel}: the root's exclusion reasons (SPEC 8.2 — only the root-node reason applies here)`,
      );

      // `query nodes --coverage …` matches no root (SPEC 11).
      const requiredLabel = "T1.2-3 `query nodes --coverage required`";
      const requiredRows = decodeNodeRowsReport(
        await runJson(
          product,
          workspace,
          ["query", "nodes", "--coverage", "required"],
          requiredLabel,
        ),
        requiredLabel,
      );
      assertSameJson(
        sortedIdentities(requiredRows),
        ["specs/A.mdx#a", "specs/A.mdx#b"],
        `${requiredLabel}: exactly the coverage-required sections — never a root (SPEC 11)`,
      );
      const noneLabel = "T1.2-3 `query nodes --coverage none`";
      const noneRows = decodeNodeRowsReport(
        await runJson(
          product,
          workspace,
          ["query", "nodes", "--coverage", "none"],
          noneLabel,
        ),
        noneLabel,
      );
      assertSameJson(
        sortedIdentities(noneRows),
        ["specs/A.mdx#c"],
        `${noneLabel}: exactly the coverage="none" section — never a root (SPEC 11)`,
      );

      // `query node` on a root reports the coverage attribute absent (SPEC 11).
      const rootLabel = "T1.2-3 `query node specs/A.mdx`";
      const root = decodeNodeReport(
        await runJson(
          product,
          workspace,
          ["query", "node", "specs/A.mdx"],
          rootLabel,
        ),
        rootLabel,
      );
      if (root.coverage !== undefined) {
        fail(
          `${rootLabel}: a root node's coverage attribute is reported as absent (SPEC 11); ` +
            `got ${JSON.stringify(root.coverage)}`,
        );
      }
    } finally {
      await workspace.dispose();
    }
  },
});

/** TEST-SPEC §1.1–1.2, in canonical ID order (SUITE-01). */
export const section11to12Tests: readonly ProductTestEntry[] = [
  T1_1_1,
  T1_1_2,
  T1_1_3,
  T1_2_1,
  T1_2_2,
  T1_2_3,
];
