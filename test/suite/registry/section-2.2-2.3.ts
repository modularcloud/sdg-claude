// TEST-SPEC §2.2 (dependency prop) and §2.3 (embedding requirement text) —
// SUITE-07: T2.2-1 … T2.2-5, T2.3-1, T2.3-2.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4) — Markdown output is fixed by SPEC 3, so every emitted-file
// expectation below is a hand-derived byte string from the fixture's known
// source and the removal/replacement/line-drop rules — decodes output through
// the H-3 adapters, and rejects a product only via diagnosed assertion
// failures (H-8).
//
// SPEC 2.2: `d` accepts a single reference or an array literal of references,
// each either external (a static property chain rooted at an imported module
// — the bare module itself included, targeting that file's root node) or
// local (a static string literal naming a same-file ID), mixable in one
// array; duplicate references to one target collapse to a single edge (5.2);
// `d={[]}` declares no dependencies and is equivalent to omitting the prop;
// the prop records `depends` edges and does not render into Markdown (3).
// SPEC 2.3: `{text(...)}` replaces the expression with the target's compiled
// subtree text in Markdown output and records an `embeds` edge from the
// containing section, with the same external/local duality as `d`, targeting
// any depth, whole files via the module binding included.

import type { GraphEdge, NodeReport } from "../../helpers/adapters/index.js";
import {
  decodeEdgesReport,
  decodeNodeReport,
} from "../../helpers/adapters/index.js";
import { assertFileBytes, fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
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

// As above with Markdown emission enabled (default destination: next to each
// source file, `specs/A.mdx` → `specs/A.md`; SPEC 7.3, 13.2). The spec-group
// globs match only `.mdx` files, so no glob matches an emit destination and
// the discovered set is unaffected by emission (13.4).
const EMIT_TRUE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
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
 * `query edges --kinds <kind>` (SPEC 11: `edges --kinds` filters over the
 * edge kinds). Asserted against an exact expected set, this pins every
 * recorded edge of the kind — none missing, none phantom, no duplicates
 * (edges of each kind form a set, SPEC 5.2).
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

/**
 * `query node <identity>` decoded through the H-3 adapter, with the resolved
 * identity checked so a mis-addressed report cannot satisfy the assertions.
 */
async function queryNodeReport(
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

// ---------------------------------------------------------------------------
// T2.2-1
// ---------------------------------------------------------------------------

// One workspace holding each accepted `d` form (SPEC 2.2): a single external
// reference, a single local string (braced, per 2.7 — a quoted `d` is
// invalid), and an array mixing both. `alpha` is the local target; `BASE.core`
// the external one.
const T2_2_1_BASE = '<S id="core">\nCore behavior.\n</S>\n';

const T2_2_1_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="alpha">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="one" d={BASE.core}>',
  "Single external reference.",
  "</S>",
  "",
  '<S id="two" d={"alpha"}>',
  "Single local string.",
  "</S>",
  "",
  '<S id="three" d={[BASE.core, "alpha"]}>',
  "Array mixing external and local references.",
  "</S>",
  "",
].join("\n");

const T2_2_1 = defineProductTest({
  id: "T2.2-1",
  title:
    "a single external reference, a single local string, and an array mixing both each record `depends` edges observable via `query edges --kinds depends` (SPEC 2.2, 5.2)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/BASE.mdx": T2_2_1_BASE, "specs/A.mdx": T2_2_1_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.2-1 `build` with all three accepted `d` forms",
        );
        // These declarations are the workspace's complete `depends` edge set:
        // the external form resolves through the import binding, the local
        // string within the declaring file, and the array records one edge
        // per reference.
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "depends", "T2.2-1"),
          [
            {
              from: "specs/A.mdx#one",
              to: "specs/BASE.mdx#core",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#two",
              to: "specs/A.mdx#alpha",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#three",
              to: "specs/BASE.mdx#core",
              kind: "depends",
            },
            {
              from: "specs/A.mdx#three",
              to: "specs/A.mdx#alpha",
              kind: "depends",
            },
          ],
          "T2.2-1 the complete `depends` edge set — one edge per declared reference, " +
            "each form resolved to its target (SPEC 2.2, 5.2)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.2-2
// ---------------------------------------------------------------------------

// The bare imported module as a `d` target (SPEC 2.2: an external reference
// MAY be the module itself, with no property segments, targeting that file's
// root node). `BASE.mdx` has a section, so a product mis-targeting the file's
// first (or only) section instead of the root — identified by the path alone,
// SPEC 1.5 — is discriminated by the exact `to` identity.
const T2_2_2_BASE = '<S id="core">\nCore behavior.\n</S>\n';

const T2_2_2_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="whole" d={BASE}>',
  "Depends on the imported file as a whole.",
  "</S>",
  "",
].join("\n");

const T2_2_2 = defineProductTest({
  id: "T2.2-2",
  title:
    "`d={BASE}` (bare imported module) records a `depends` edge to the imported file's root node (SPEC 2.2, 1.5)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/BASE.mdx": T2_2_2_BASE, "specs/A.mdx": T2_2_2_SOURCE },
      async (workspace) => {
        await buildOk(product, workspace, "T2.2-2 `build` with `d={BASE}`");
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "depends", "T2.2-2"),
          [
            {
              from: "specs/A.mdx#whole",
              to: "specs/BASE.mdx",
              kind: "depends",
            },
          ],
          "T2.2-2 the complete `depends` edge set — exactly one edge, to the imported " +
            "file's root node (the path alone, SPEC 1.5), not to any section of it",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.2-3
// ---------------------------------------------------------------------------

// The TEST-SPEC's exact duplicated array: `[BASE.a.b, BASE.a.b, "x.y", "x.y"]`
// — each target referenced twice in one `d` array. Exactly one edge per
// target must be recorded (SPEC 2.2, 5.2: edges of each kind form a set).
const T2_2_3_BASE = [
  '<S id="a">',
  "A text.",
  "",
  '<S id="a.b">',
  "B text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T2_2_3_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="x">',
  "X text.",
  "",
  '<S id="x.y">',
  "Y text.",
  "</S>",
  "</S>",
  "",
  '<S id="dup" d={[BASE.a.b, BASE.a.b, "x.y", "x.y"]}>',
  "Duplicate references to each of two targets.",
  "</S>",
  "",
].join("\n");

const T2_2_3 = defineProductTest({
  id: "T2.2-3",
  title:
    "duplicate references to one target in a single `d` array collapse to exactly one edge per target (SPEC 2.2, 5.2)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/BASE.mdx": T2_2_3_BASE, "specs/A.mdx": T2_2_3_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.2-3 `build` with duplicated references in one `d` array",
        );
        // The exact-set comparison rejects both a product recording one edge
        // per declaration (four edges) and a query surface reporting the
        // collapsed edges more than once.
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "depends", "T2.2-3"),
          [
            {
              from: "specs/A.mdx#dup",
              to: "specs/BASE.mdx#a.b",
              kind: "depends",
            },
            { from: "specs/A.mdx#dup", to: "specs/A.mdx#x.y", kind: "depends" },
          ],
          "T2.2-3 the complete `depends` edge set — exactly one edge per target of " +
            '`d={[BASE.a.b, BASE.a.b, "x.y", "x.y"]}` (SPEC 2.2, 5.2)',
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.2-4
// ---------------------------------------------------------------------------

// Two variants of one file, differing only in `d={[]}` versus no `d` prop.
// SPEC 2.2: an empty array declares no dependencies and is equivalent to
// omitting the prop — no edges either way, and the node's metadataHash (the
// hash of its `d` target set, coverage attribute, and tags, SPEC 5.5) must be
// byte-identical across the variants. Both variants are built in the same
// workspace directory, so nothing but the prop's presence varies.
const T2_2_4_EMPTY_ARRAY = '<S id="node" d={[]}>\nNode behavior.\n</S>\n';
const T2_2_4_OMITTED = '<S id="node">\nNode behavior.\n</S>\n';
const T2_2_4_NODE = "specs/A.mdx#node";

const T2_2_4 = defineProductTest({
  id: "T2.2-4",
  title:
    "`d={[]}` builds like omitting the prop: no edges recorded, and the node's metadataHash equals the omitted-prop variant's (SPEC 2.2, 5.5)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/A.mdx": T2_2_4_EMPTY_ARRAY },
      async (workspace) => {
        await buildOk(product, workspace, "T2.2-4 `build` with `d={[]}`");
        assertEdgeSetEqual(
          await queryEdgesOfKind(
            product,
            workspace,
            "depends",
            "T2.2-4 with `d={[]}`:",
          ),
          [],
          "T2.2-4 `d={[]}` declares no dependencies — the workspace has no `depends` " +
            "edge (SPEC 2.2)",
        );
        const emptyArray = await queryNodeReport(
          product,
          workspace,
          T2_2_4_NODE,
          "T2.2-4 with `d={[]}`:",
        );

        await workspace.file("specs/A.mdx", T2_2_4_OMITTED);
        await buildOk(
          product,
          workspace,
          "T2.2-4 `build` with the `d` prop omitted",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(
            product,
            workspace,
            "depends",
            "T2.2-4 with the prop omitted:",
          ),
          [],
          "T2.2-4 the omitted-prop variant records no `depends` edge either (SPEC 2.2)",
        );
        const omitted = await queryNodeReport(
          product,
          workspace,
          T2_2_4_NODE,
          "T2.2-4 with the prop omitted:",
        );

        assertSameJson(
          emptyArray.hashes.metadataHash,
          omitted.hashes.metadataHash,
          `T2.2-4 metadataHash of ${T2_2_4_NODE} — \`d={[]}\` is equivalent to omitting ` +
            "the prop, so both variants hash the same empty `d` target set (with the " +
            "same coverage attribute and tags, SPEC 2.2, 5.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.2-5
// ---------------------------------------------------------------------------

// Every accepted `d` form under Markdown emission (SPEC 3: the output removes
// `<S>`/`<Spec>` tags together with their props — `d` included — and the `d`
// prop does not render, SPEC 2.2). The in-line section is the sharpest probe:
// its line is kept (non-whitespace content remains after tag removal), so any
// surviving byte of the `d` prop lands in the kept line and fails the byte
// comparison.
const T2_2_5_BASE = '<S id="core">\nCore behavior.\n</S>\n';

const T2_2_5_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="alpha">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="one" d={BASE.core}>',
  "One behavior.",
  "</S>",
  "",
  '<S id="two" d={[BASE.core, "alpha"]}>',
  "Two behavior.",
  "</S>",
  "",
  '<S id="three" d={BASE}>',
  "Three behavior.",
  "</S>",
  "",
  '<S id="inline" d={"alpha"}>Inline: kept text.</S>',
  "",
].join("\n");

// Hand-derived per SPEC 3: the import line and every tag-only line are
// emptied purely by removals and drop with their terminators; the blank
// separator lines were already empty in the source and are kept; the in-line
// section's line keeps its remaining content and terminator. No byte of any
// `d` form (external chain, array, bare module, local string) survives.
const T2_2_5_COMPILED =
  "\nAlpha behavior.\n\nOne behavior.\n\nTwo behavior.\n\nThree behavior.\n\nInline: kept text.\n";

const T2_2_5 = defineProductTest({
  id: "T2.2-5",
  title:
    "Markdown output contains no trace of the `d` prop in any of its forms (SPEC 2.2, 3)",
  run: async (product) => {
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/BASE.mdx": T2_2_5_BASE, "specs/A.mdx": T2_2_5_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.2-5 `build` with emission enabled over every `d` form",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_2_5_COMPILED,
          "T2.2-5 emitted Markdown (SPEC 3) — byte equality of the whole output, so " +
            "no trace of any `d` prop form can survive (SPEC 2.2)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.3-1
// ---------------------------------------------------------------------------

// The TEST-SPEC's exact expression, `{text(BASE.auth.login)}`. The target has
// a child, so its subtree text ("Login behavior.\n\nMFA required.\n") differs
// from its own text ("Login behavior.\n\n") — a product embedding own text
// instead of compiled subtree text fails the byte comparison (SPEC 2.3, 1.6).
const T2_3_1_BASE = [
  '<S id="auth">',
  "Auth intro.",
  "",
  '<S id="auth.login">',
  "Login behavior.",
  "",
  '<S id="auth.login.mfa">',
  "MFA required.",
  "</S>",
  "</S>",
  "</S>",
  "",
].join("\n");

const T2_3_1_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="summary">',
  "As specified:",
  "",
  "{text(BASE.auth.login)}",
  "</S>",
  "",
].join("\n");

// The target's compiled subtree text (SPEC 1.6, 3): within its construct the
// tag-only lines drop with their terminators; the prose lines and the blank
// separator are kept byte-for-byte.
const T2_3_1_TARGET_SUBTREE = "Login behavior.\n\nMFA required.\n";

// The embedding file's compiled output: import line and tag-only lines drop;
// the embedding line's expression is replaced in place by the target's
// subtree text, and the line — non-empty after replacement — keeps its
// remaining content and its own terminator (SPEC 3).
const T2_3_1_COMPILED = `\nAs specified:\n\n${T2_3_1_TARGET_SUBTREE}\n`;

const T2_3_1 = defineProductTest({
  id: "T2.3-1",
  title:
    "`{text(BASE.auth.login)}` replaces the expression with the target's compiled subtree text in Markdown output (byte-asserted) and records an `embeds` edge from the containing section (SPEC 2.3, 3, 1.6)",
  run: async (product) => {
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/BASE.mdx": T2_3_1_BASE, "specs/A.mdx": T2_3_1_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.3-1 `build` with a `{text(...)}` embedding",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_3_1_COMPILED,
          "T2.3-1 emitted Markdown — the expression replaced by the target's compiled " +
            "subtree text, its child's contribution included (SPEC 2.3, 3, 1.6)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T2.3-1"),
          [
            {
              from: "specs/A.mdx#summary",
              to: "specs/BASE.mdx#auth.login",
              kind: "embeds",
            },
          ],
          "T2.3-1 the complete `embeds` edge set — exactly one edge, from the " +
            "containing section to the embedded target (SPEC 2.3, 5.2)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T2.3-2
// ---------------------------------------------------------------------------

// Both argument forms at depth, plus a whole-file embedding (SPEC 2.3, 2.2):
// - `{text("x.y")}` — string form, resolved within the same file. BASE also
//   contains a node `x.y` (the decoy): a product resolving the local string
//   in the imported file records the wrong edge and embeds "Decoy deep
//   text.", failing both assertions.
// - `{text(BASE.a.b.c)}` — node form, three segments deep.
// - `{text(BASE)}` — the bare module binding: embeds the whole file, i.e. the
//   root's subtree text, which is the entire compiled output (SPEC 1.6) —
//   byte-anchored below against BASE's own emitted Markdown.
const T2_3_2_BASE = [
  '<S id="a">',
  "A text.",
  "",
  '<S id="a.b">',
  "B text.",
  "",
  '<S id="a.b.c">',
  "C text.",
  "</S>",
  "</S>",
  "</S>",
  "",
  '<S id="x">',
  "Decoy x.",
  "",
  '<S id="x.y">',
  "Decoy deep text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const T2_3_2_SOURCE = [
  'import BASE from "./BASE.xspec"',
  "",
  '<S id="x">',
  "X intro.",
  "",
  '<S id="x.y">',
  "Deep local text.",
  "</S>",
  "</S>",
  "",
  '<S id="summary">',
  'Local: {text("x.y")}',
  "Deep: {text(BASE.a.b.c)}",
  "Whole:",
  "",
  "{text(BASE)}",
  "</S>",
  "",
].join("\n");

// Hand-derived per SPEC 3 (tag-only and import lines drop with terminators;
// prose and blank source lines are kept; replacements are in place).
const T2_3_2_LOCAL_TARGET_SUBTREE = "Deep local text.\n";
const T2_3_2_DEEP_TARGET_SUBTREE = "C text.\n";
// BASE's entire compiled output — the root's subtree text (SPEC 1.6).
const T2_3_2_BASE_COMPILED =
  "A text.\n\nB text.\n\nC text.\n\nDecoy x.\n\nDecoy deep text.\n";
// The embedding file: each embedding line keeps its remaining content — the
// prefix plus the expansion — and its own terminator.
const T2_3_2_COMPILED =
  `\nX intro.\n\n${T2_3_2_LOCAL_TARGET_SUBTREE}\n` +
  `Local: ${T2_3_2_LOCAL_TARGET_SUBTREE}\n` +
  `Deep: ${T2_3_2_DEEP_TARGET_SUBTREE}\n` +
  `Whole:\n\n${T2_3_2_BASE_COMPILED}\n`;

const T2_3_2 = defineProductTest({
  id: "T2.3-2",
  title:
    "string-form `text(...)` resolves within the same file; both forms target any depth, including a whole file via the module binding (root target) (SPEC 2.3, 2.2, 1.6)",
  run: async (product) => {
    await withWorkspace(
      EMIT_TRUE_CONFIG,
      { "specs/BASE.mdx": T2_3_2_BASE, "specs/A.mdx": T2_3_2_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T2.3-2 `build` with string-form, deep, and whole-file embeddings",
        );
        // BASE's own emitted Markdown first: the whole-file expansion below
        // is anchored to the target file's actual compiled output.
        await assertFileBytes(
          workspace.path("specs/BASE.md"),
          T2_3_2_BASE_COMPILED,
          "T2.3-2 emitted Markdown of the embedded file (SPEC 3)",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          T2_3_2_COMPILED,
          "T2.3-2 emitted Markdown of the embedding file — the local string expands " +
            "to the same-file node's text (not the decoy's), the deep node form to " +
            "the depth-three target's subtree text, and `{text(BASE)}` to the whole " +
            "file's compiled output (SPEC 2.3, 3, 1.6)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T2.3-2"),
          [
            {
              from: "specs/A.mdx#summary",
              to: "specs/A.mdx#x.y",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#summary",
              to: "specs/BASE.mdx#a.b.c",
              kind: "embeds",
            },
            {
              from: "specs/A.mdx#summary",
              to: "specs/BASE.mdx",
              kind: "embeds",
            },
          ],
          "T2.3-2 the complete `embeds` edge set — the string form resolved within " +
            "the same file (specs/A.mdx#x.y, not the decoy specs/BASE.mdx#x.y), the " +
            "node form at depth three, and the bare module binding targeting the " +
            "imported file's root node (SPEC 2.3, 2.2, 1.5)",
        );
      },
    );
  },
});

/** TEST-SPEC §2.2–2.3, in canonical ID order (SUITE-07). */
export const section22to23Tests: readonly ProductTestEntry[] = [
  T2_2_1,
  T2_2_2,
  T2_2_3,
  T2_2_4,
  T2_2_5,
  T2_3_1,
  T2_3_2,
];
