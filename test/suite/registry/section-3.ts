// TEST-SPEC §3 (Markdown compilation) — SUITE-11: T3-1, T3-2, T3-3, T3-4,
// T3-5, T3-6.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), and byte-asserts the emitted Markdown files
// (H-4: SPEC 3 fixes the output bytes exactly) — every expectation below is a
// hand-derived byte string from the fixture's known source and the
// removal/replacement/line-drop/terminator rules of SPEC 3. All tests run
// with `markdown: { emit: true }` except T3-6, which is the emission-scope
// test itself (SPEC 7.3, 13.2).
//
// Certification staging constraints (CERTIFICATIONS.md §CONF-MD,
// §VIOL-MD-CLASS, §VIOL-MD-CR), binding alongside the test text:
// - U+00A0, U+0085, and U+2028 appear on removal-affected lines only in
//   T3-3's class-boundary arms; every other fixture in this module keeps
//   them out entirely.
// - A lone U+000D appears only in T3-4's fixtures; every other fixture uses
//   LF terminators exclusively (CRLF appears only in T3-4).
// - T3-1 stages sections carrying the full prop set of 2.7 — `id`, `d`
//   (external and local forms, resolving as staged), `coverage`, and `tags`.

import { assertFileBytes, fail } from "../../helpers/assertions.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import { defineProductTest } from "../../helpers/registry.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk } from "./support.js";

// Minimal declarative configuration (SPEC 7): one spec group. The spec-group
// glob matches only `.mdx` files, so no glob matches a Markdown emit
// destination (`specs/**/*.md`, SPEC 7.3).
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

// ---------------------------------------------------------------------------
// T3-1
// ---------------------------------------------------------------------------

// Import target for the external `d` references and the removed import line.
const REMOVALS_BASE_SOURCE = '<S id="base">\nBase text.\n</S>\n';
const REMOVALS_BASE_COMPILED = "Base text.\n";

// A fixture exercising every removal kind of SPEC 3 — the import, `<S>` and
// `<Spec>` opening/closing tags carrying the full prop set of 2.7 (`id`, `d`
// in external and local forms, `coverage`, `tags`), and MDX comments (own-line
// and in-line) — amid content that must survive byte-for-byte: a heading, a
// table, a code fence, trailing spaces, and blank lines. Dependencies are
// acyclic: alpha → {BASE.base, beta}, beta → BASE.base (SPEC 5.3).
const REMOVALS_SOURCE = [
  'import BASE from "./BASE.xspec"', // removed; line drops (SPEC 3)
  "",
  "# Removals fixture",
  "",
  '<S id="alpha" d={[BASE.base, "beta"]} coverage="none" tags="one two">', // removed with all props
  "Alpha keeps trailing spaces:   ", // trailing spaces preserved
  "",
  "| Key | Value |",
  "| --- | ----- |",
  "| a   | 1     |",
  "",
  "{/* an own-line comment, removed with its line */}",
  "```text",
  "fenced   content with spaces   ",
  "```",
  "",
  "Middle {/* in-line comment, removed in place */}word.",
  "</S>",
  "",
  '<Spec id="beta" d={BASE.base} coverage="required" tags="three.dot">',
  "Beta prose.",
  "</Spec>",
  "",
  '<S id="gamma">Gamma keeps this line.', // tag deleted in place, content kept
  "More gamma prose.",
  "</S>",
  "",
].join("\n");

// Hand-derived (SPEC 3): each construct is deleted exactly, in place; every
// line left empty purely by removals drops with its terminator; every other
// line — author whitespace included — is preserved byte-for-byte.
const REMOVALS_COMPILED = [
  "",
  "# Removals fixture",
  "",
  "Alpha keeps trailing spaces:   ",
  "",
  "| Key | Value |",
  "| --- | ----- |",
  "| a   | 1     |",
  "",
  "```text",
  "fenced   content with spaces   ",
  "```",
  "",
  "Middle word.", // "Middle " + "word." after exact in-place comment deletion
  "",
  "Beta prose.",
  "",
  "Gamma keeps this line.", // the in-place-deleted opening tag's line, kept
  "More gamma prose.",
  "",
].join("\n");

const T3_1 = defineProductTest({
  id: "T3-1",
  title:
    "imports, `<S>`/`<Spec>` opening and closing tags with all their props (`id`, `d`, `coverage`, `tags`), and MDX comments are removed by exact textual deletion in place; tables, code fences, trailing spaces, and blank lines are preserved byte-for-byte (SPEC 3, 2.7)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": REMOVALS_SOURCE,
        "specs/BASE.mdx": REMOVALS_BASE_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T3-1 `build` with `markdown: { emit: true }`",
      );
      await assertFileBytes(
        workspace.path("specs/A.md"),
        REMOVALS_COMPILED,
        "T3-1 emitted specs/A.md — constructs deleted exactly in place, everything else preserved byte-for-byte (SPEC 3)",
      );
      await assertFileBytes(
        workspace.path("specs/BASE.md"),
        REMOVALS_BASE_COMPILED,
        "T3-1 emitted specs/BASE.md (SPEC 3)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T3-2
// ---------------------------------------------------------------------------

// A three-file embedding chain — A embeds B embeds C — so "fully expanded"
// is recursive across files, plus a same-file local-form embedding (a2 embeds
// a), so each `text(...)` occurrence is replaced.
const CHAIN_C_SOURCE = '<S id="c">\nC text.\n</S>\n';
// subtree(c) = "C text.\n" (tag-only lines drop, SPEC 3).
const CHAIN_C_COMPILED = "C text.\n";

const CHAIN_B_SOURCE = [
  'import C from "./C.xspec"',
  "",
  '<S id="b">',
  "B says: {text(C.c)}",
  "</S>",
  "",
].join("\n");
// The kept blank line, then "B says: " + subtree(c) + the line's own
// terminator. subtree(b) = "B says: C text.\n\n".
const CHAIN_B_COMPILED = "\nB says: C text.\n\n";

const CHAIN_A_SOURCE = [
  'import B from "./B.xspec"',
  "",
  '<S id="a">',
  "A says: {text(B.b)}",
  "</S>",
  "",
  '<S id="a2">',
  'Local: {text("a")}',
  "</S>",
  "",
].join("\n");
// "A says: " + subtree(b) + terminator = "A says: B says: C text.\n\n\n"
// (= subtree(a)); then the kept blank line; then "Local: " + subtree(a) +
// terminator — C's text reaches a2 through two levels of expansion.
const CHAIN_A_COMPILED =
  "\n" +
  "A says: B says: C text.\n\n\n" +
  "\n" +
  "Local: A says: B says: C text.\n\n\n\n";

const T3_2 = defineProductTest({
  id: "T3-2",
  title:
    "each `text(...)` expression is replaced by the target's compiled subtree text, fully expanded through chained embeddings (A embeds B embeds C) (SPEC 3, 2.3, 1.6)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": CHAIN_A_SOURCE,
        "specs/B.mdx": CHAIN_B_SOURCE,
        "specs/C.mdx": CHAIN_C_SOURCE,
      },
    });
    try {
      await buildOk(product, workspace, "T3-2 `build` of the embedding chain");
      await assertFileBytes(
        workspace.path("specs/C.md"),
        CHAIN_C_COMPILED,
        "T3-2 emitted specs/C.md — the chain's leaf (SPEC 3)",
      );
      await assertFileBytes(
        workspace.path("specs/B.md"),
        CHAIN_B_COMPILED,
        "T3-2 emitted specs/B.md — `text(C.c)` replaced by C's compiled subtree text, in place (SPEC 3, 2.3)",
      );
      await assertFileBytes(
        workspace.path("specs/A.md"),
        CHAIN_A_COMPILED,
        'T3-2 emitted specs/A.md — `text(B.b)` and local-form `text("a")` replaced fully expanded: C\'s text reaches A through B (SPEC 3, 1.6)',
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T3-3
// ---------------------------------------------------------------------------

// SPEC 1.4 boundary code points: neither whitespace nor line terminators.
const NBSP = "\u{00A0}";
const NEL = "\u{0085}";
const LS = "\u{2028}";

// One fixture, one arm per line, with distinct kept marker lines between arms
// so a misplaced drop is diagnosed precisely. LF terminators throughout, a
// final terminator present (lone CR and terminator edge cases are T3-4's).
// `sp` (subtree text exactly one space) and `empty` (self-closing: empty
// subtree text, SPEC 1.1) are defined before use; embeddings sit at root
// level, so the root embeds its own root-level sections — forward edges only,
// no cycle (SPEC 5.3 forbids embedding an *ancestor*).
const DROP_SOURCE = [
  'import BASE from "./BASE.xspec"', // drop: a line holding only an import
  "K1 after-import",
  'defs: x <S id="sp"> </S> y', // kept: removal-affected line retaining content
  '<S id="empty" />', // drop: left empty purely by removals
  "K2 after-defs",
  '<S id="sec">', // drop: a line holding only an opening tag
  "sec body line", // kept: a line keeping content keeps its terminator
  "</S>", // drop: a line holding only a closing tag
  "K3 after-sec",
  "{/* own-line comment */}", // drop: a line holding only a comment
  "K4 after-comment",
  '{text("empty")}', // drop: only a text(...) whose expansion is empty
  "K5 after-empty-expansion",
  "", // kept: already empty in the source
  "K6 after-blank",
  "pre {/* in-line */} post", // kept: retains other content → "pre  post"
  "K7 after-inline",
  '{text("sp")}', // kept: whitespace-only but non-empty expansion → " "
  "K8 after-space-expansion",
  "{/* c */}" + NBSP, // kept: left holding only U+00A0 — not whitespace (1.4)
  "K9 after-nbsp",
  "{/* c */}" + NEL, // kept: left holding only U+0085 — not whitespace (1.4)
  "K10 after-nel",
  "{/* c */}" + LS, // kept: left holding only U+2028 — not whitespace (1.4)
  "K11 after-ls",
  "{/* c */}\t", // drop: left holding only U+0009 — whitespace (1.4)
  "K12 after-tab-drop",
  "{/* c */} ", // drop: left holding only U+0020 — whitespace (1.4)
  "K13 after-space-drop",
  "foo {/* first", // multi-line comment with retained residue on both sides…
  "tail */} bar", // …deleted exactly: lines merge to "foo  bar"
  "K14 after-merge",
  "{/* own-lines", // own-lines multi-line comment (empty residues)…
  "multiline */}", // …merged line left empty purely by removals → drops
  "K15 final",
  "",
].join("\n");

// Hand-derived compiled output: exactly the kept lines above, in order.
const DROP_COMPILED = [
  "K1 after-import",
  "defs: x   y", // both of sp's tags deleted in place; the space content stays
  "K2 after-defs",
  "sec body line",
  "K3 after-sec",
  "K4 after-comment",
  "K5 after-empty-expansion",
  "",
  "K6 after-blank",
  "pre  post",
  "K7 after-inline",
  " ", // the kept single-space expansion, with the line's terminator
  "K8 after-space-expansion",
  NBSP,
  "K9 after-nbsp",
  NEL,
  "K10 after-nel",
  LS,
  "K11 after-ls",
  "K12 after-tab-drop",
  "K13 after-space-drop",
  "foo  bar", // the comment's own line terminator deleted with it: one line
  "K14 after-merge",
  "K15 final",
  "",
].join("\n");

const T3_3 = defineProductTest({
  id: "T3-3",
  title:
    "line-drop rule: lines left empty or whitespace-only purely by removals (import, tags, comments, empty expansion) drop with their terminators; already-empty, content-retaining, and whitespace-only-but-non-empty-expansion lines are kept; U+00A0/U+0085/U+2028 are not whitespace while U+0009/U+0020 are; multi-line comment deletion merges the surrounding residues (SPEC 3, 1.4)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": DROP_SOURCE,
        "specs/BASE.mdx": REMOVALS_BASE_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T3-3 `build` of the line-drop fixture",
      );
      await assertFileBytes(
        workspace.path("specs/A.md"),
        DROP_COMPILED,
        "T3-3 emitted specs/A.md — every drop arm, counter-case, class boundary, and multi-line-construct merge of the line-drop rule (SPEC 3, 1.4)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T3-4
// ---------------------------------------------------------------------------

// One fixture per terminator kind. Each stages a tag-only line between kept
// lines — the drop must consume exactly one terminator (both CRLF bytes; the
// lone LF; the lone CR) — and ends with a kept, terminator-less final line
// that must survive without gaining one. The lone-CR fixture also pins that
// kept CR terminators are preserved byte-for-byte, and discriminates a
// product that does not recognize lone U+000D as a terminator: such a product
// sees one single line and compiles to "one\r\rbody\r\rtail" instead
// (CERTIFICATIONS.md §VIOL-MD-CR).
const TERM_LF_SOURCE = 'one\n<S id="s">\nbody\n</S>\ntail';
const TERM_LF_COMPILED = "one\nbody\ntail";
const TERM_CRLF_SOURCE = 'one\r\n<S id="s">\r\nbody\r\n</S>\r\ntail';
const TERM_CRLF_COMPILED = "one\r\nbody\r\ntail";
const TERM_CR_SOURCE = 'one\r<S id="s">\rbody\r</S>\rtail';
const TERM_CR_COMPILED = "one\rbody\rtail";

const T3_4 = defineProductTest({
  id: "T3-4",
  title:
    "CRLF, lone LF, and lone CR are each recognized as one line terminator by the drop rule, and a final line without a terminator survives compilation without gaining one (SPEC 3)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/lf.mdx": TERM_LF_SOURCE,
        "specs/crlf.mdx": TERM_CRLF_SOURCE,
        "specs/cr.mdx": TERM_CR_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T3-4 `build` of the terminator fixtures",
      );
      await assertFileBytes(
        workspace.path("specs/lf.md"),
        TERM_LF_COMPILED,
        "T3-4 emitted specs/lf.md — lone-LF terminators; dropped lines take exactly their LF; the terminator-less final line gains none (SPEC 3)",
      );
      await assertFileBytes(
        workspace.path("specs/crlf.md"),
        TERM_CRLF_COMPILED,
        "T3-4 emitted specs/crlf.md — U+000D U+000A is one terminator: dropped lines take both bytes, leaving no stray CR or LF (SPEC 3)",
      );
      await assertFileBytes(
        workspace.path("specs/cr.md"),
        TERM_CR_COMPILED,
        "T3-4 emitted specs/cr.md — a lone U+000D is one terminator: line extents and drops follow it, and kept CR terminators are preserved byte-for-byte (SPEC 3)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T3-5
// ---------------------------------------------------------------------------

// SPEC 3's own example, byte-exact: transparent annotations, author
// responsibility for spacing around in-line tags.
const INLINE_TAGS_SOURCE = '<S id="a">Example:</S><S id="b">1. A</S>\n';
const INLINE_TAGS_COMPILED = "Example:1. A\n";

const T3_5 = defineProductTest({
  id: "T3-5",
  title:
    'in-line tags are transparent annotations: `<S id="a">Example:</S><S id="b">1. A</S>` compiles to `Example:1. A` (SPEC 3)',
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": EMIT_TRUE_CONFIG,
        "specs/A.mdx": INLINE_TAGS_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T3-5 `build` of the in-line-tags fixture",
      );
      await assertFileBytes(
        workspace.path("specs/A.md"),
        INLINE_TAGS_COMPILED,
        "T3-5 emitted specs/A.md — tags stripped in place with no inserted spacing (SPEC 3)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T3-6
// ---------------------------------------------------------------------------

const SCOPE_A_SOURCE = '<S id="a">\nAlpha.\n</S>\n';
const SCOPE_A_COMPILED = "Alpha.\n";
const SCOPE_B_SOURCE = '<S id="b">\nBeta.\n</S>\n';
const SCOPE_B_COMPILED = "Beta.\n";

/**
 * Assert nothing occupies a default Markdown emit destination (SPEC 7.3: with
 * `markdown` absent or `emit: false`, no path is a Markdown emit destination,
 * so no `.md` file is emitted for any source).
 */
async function assertNotEmitted(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<void> {
  const kind = await workspace.kind(rel);
  if (kind !== "absent") {
    fail(
      `${context}: expected no Markdown emission at ${rel} — with \`markdown\` absent or ` +
        `\`emit: false\`, no path is a Markdown emit destination (SPEC 7.3) — but found: ${kind}`,
    );
  }
}

// The three `markdown` variants of the emission-scope matrix (SPEC 7.3, 13.2).
const EMISSION_VARIANTS = [
  { key: "`markdown` absent", config: SPECS_ONLY_CONFIG, emits: false },
  {
    key: "`markdown: { emit: false }`",
    config: EMIT_FALSE_CONFIG,
    emits: false,
  },
  { key: "`markdown: { emit: true }`", config: EMIT_TRUE_CONFIG, emits: true },
] as const;

const T3_6 = defineProductTest({
  id: "T3-6",
  title:
    "with `markdown` absent or `emit: false`, no `.md` file is emitted for any source; with `emit: true`, every discovered spec source emits, subdirectory sources included (SPEC 7.3, 13.2)",
  run: async (product) => {
    // Each variant builds in its own fresh workspace, so no arm can observe a
    // leftover emission from a previous configuration.
    for (const variant of EMISSION_VARIANTS) {
      const workspace = await TestWorkspace.create({
        files: {
          "xspec.config.ts": variant.config,
          "specs/A.mdx": SCOPE_A_SOURCE,
          "specs/sub/B.mdx": SCOPE_B_SOURCE,
        },
      });
      try {
        await buildOk(
          product,
          workspace,
          `T3-6 \`build\` under ${variant.key}`,
        );
        if (variant.emits) {
          await assertFileBytes(
            workspace.path("specs/A.md"),
            SCOPE_A_COMPILED,
            `T3-6 under ${variant.key}: specs/A.mdx emits specs/A.md next to its source (SPEC 13.2, 7.3)`,
          );
          await assertFileBytes(
            workspace.path("specs/sub/B.md"),
            SCOPE_B_COMPILED,
            `T3-6 under ${variant.key}: specs/sub/B.mdx emits specs/sub/B.md — every discovered spec source emits (SPEC 13.2)`,
          );
        } else {
          await assertNotEmitted(
            workspace,
            "specs/A.md",
            `T3-6 under ${variant.key}`,
          );
          await assertNotEmitted(
            workspace,
            "specs/sub/B.md",
            `T3-6 under ${variant.key}`,
          );
        }
      } finally {
        await workspace.dispose();
      }
    }
  },
});

/** TEST-SPEC §3, in canonical ID order (SUITE-11). */
export const section3Tests: readonly ProductTestEntry[] = [
  T3_1,
  T3_2,
  T3_3,
  T3_4,
  T3_5,
  T3_6,
];
