// TEST-SPEC §13.1 (generated TypeScript) and §13.2 (Markdown output) —
// SUITE-45: T13.1-1, T13.1-2, T13.2-1.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5) and exact bytes where SPEC.md fixes bytes
// (H-4), and rejects a product only via diagnosed assertion failures (H-8).
// Consumer-side contracts run under standard TypeScript tooling with no xspec
// runtime dependency (SPEC 13.1) through helpers/tooling.ts, in the
// CommonJS-mode arrangement described in section-4.ts.
//
// Conservative operationalizations (noted per H-3/H-4):
// - T13.1-1's generated-file sweep diffs a whole-workspace byte snapshot
//   around `build` (helpers/snapshot.ts). With Markdown emission disabled,
//   SPEC 13.4 classifies everything a `build` may write as either generated
//   TypeScript — the module plus companions beside it, every one a plain
//   file named `NAME.xspec.` plus a suffix (13.1) — or graph data under
//   `.xspec/` (13.3), so the sweep is complete without knowing the product's
//   companion set: every entry `build` adds outside `.xspec/` must be a
//   plain file directly in its source's directory named `NAME.xspec.` plus a
//   non-empty suffix (hence every generated file carries `.xspec.` in its
//   name). "The set is recorded such that later builds remove orphans" is
//   asserted by its stated observable — deleting a source and rebuilding
//   removes the module and every companion — while the fuller orphan matrix
//   (manual rename, disabled emission) is T12.1-3's.
// - T13.1-2 is the section-4 umbrella E2E: ONE standalone consumer project,
//   staged beside the generated modules so the import is the spec-quoted
//   literal `import SPEC, { text } from "./NAME.xspec"` (SPEC 4, 13.1),
//   exercises representatives of every consumer-side contract end to end
//   under standard TypeScript tooling only — resolution and 4.1 type
//   checking (clean strict compile of node chains; a missing-path sibling
//   program failing at the consumer reference), 4.2 hover and
//   go-to-definition into the source `.mdx`, and 4.3–4.5 runtime behavior in
//   one compiled program: byte-exact `text` values, a second module consumed
//   through an aliased `text` export (4.4's aliasing rule, positive side),
//   and a dependency marker harmless at runtime (the begin/end frame plus
//   exact stdout show the program behaves as if the marker line were
//   absent). The consumer files are matched by no configured group (the §4
//   preamble arrangement), and the compiled program runs under plain Node
//   with NODE_PATH dropped (helpers/tooling.ts): "no xspec runtime
//   dependency", observed structurally. Per-contract negative matrices and
//   edge cases remain with T4-1…T4.6-4.
// - T13.2-1 asserts placement and exact bytes together ("content per section
//   3", hand-derived from the removal/replacement/line-drop rules): default
//   emission lands `NAME.md` next to each source, `outDir` emission lands it
//   under the directory preserving workspace-relative paths — the
//   subdirectory source makes both observable — and under `outDir` the
//   default next-to-source paths stay vacant ("placed per markdown.outDir",
//   13.2/7.3, means redirected, not duplicated). The embedded target is a
//   single-line inline section with no trailing terminator (SPEC 3: the
//   final line MAY have no terminator), so its mid-line expansion keeps the
//   embedder's line intact. The enablement matrix (markdown absent /
//   emit:false / emit:true) is T7.3-1's and T3-6's subject, not repeated
//   here.

import * as fsp from "node:fs/promises";
import {
  assertBytesEqual,
  assertExitCode,
  assertFileBytes,
  fail,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  describeEntry,
  displaySnapshotPath,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import {
  assertCompileErrorAt,
  assertNoCompileErrors,
  ConsumerProject,
  formatConsumerDiagnostic,
  runConsumer,
} from "../../helpers/tooling.js";
import type {
  FileOffset,
  SourceDefinitionTarget,
} from "../../helpers/tooling.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group, no
// `markdown` key — no path is a Markdown emit destination (SPEC 7.3), so
// everything `build` writes is 13.1 generated TypeScript or 13.3 graph data.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

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

// ---------------------------------------------------------------------------
// T13.1-1 — generated layout and orphan recording
// ---------------------------------------------------------------------------

// Two independent sources, one in a subdirectory, so "in the source file's
// directory" is observable per source and a companion landing in the wrong
// directory fails the sweep.
const LAYOUT_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": SPECS_ONLY_CONFIG,
  "specs/A.mdx": ['<S id="alpha">', "Alpha behavior.", "</S>", ""].join("\n"),
  "specs/sub/B.mdx": ['<S id="beta">', "Beta behavior.", "</S>", ""].join("\n"),
};

// Where 13.1 files may appear: for each source, directly in its directory,
// named `<stem>.xspec.` plus a non-empty suffix.
const LAYOUT_SOURCES = [
  { module: "specs/A.xspec.ts", prefix: "specs/A.xspec." },
  { module: "specs/sub/B.xspec.ts", prefix: "specs/sub/B.xspec." },
] as const;

const T13_1_1 = defineProductTest({
  id: "T13.1-1",
  title:
    "NAME.mdx generates NAME.xspec.ts in the source file's directory plus companions each named NAME.xspec.<suffix> — every generated file carries `.xspec.` in its name — and the set is recorded such that a later build removes a deleted source's module and companions (SPEC 13.1, 13.3, 13.4, 12.1)",
  run: async (product) => {
    await withWorkspace(LAYOUT_FILES, async (workspace) => {
      const before = await snapshotDirectory(workspace.root);
      await buildOk(
        product,
        workspace,
        "T13.1-1 `build` over the two-directory workspace (SPEC 12.1)",
      );
      const after = await snapshotDirectory(workspace.root);

      // NAME.mdx generates NAME.xspec.ts in the source file's directory.
      for (const source of LAYOUT_SOURCES) {
        await expectFile(
          workspace,
          source.module,
          "T13.1-1 after `build` — NAME.mdx generates NAME.xspec.ts in " +
            "the source file's directory (SPEC 13.1)",
        );
      }

      // Companion sweep over everything `build` added: outside `.xspec/`
      // (graph data, SPEC 13.3 — content and layout under it are opaque and
      // out of 13.1's scope), each added entry must be a plain file directly
      // in its source's directory named `NAME.xspec.` plus a suffix.
      for (const [key, entry] of after.entries) {
        if (before.entries.has(key)) continue;
        const rel = displaySnapshotPath(key);
        if (rel === ".xspec" || rel.startsWith(".xspec/")) continue;
        const home = LAYOUT_SOURCES.find((source) =>
          rel.startsWith(source.prefix),
        );
        const suffix = home === undefined ? "" : rel.slice(home.prefix.length);
        if (home === undefined || suffix === "" || suffix.includes("/")) {
          fail(
            `T13.1-1: \`build\` created ${JSON.stringify(rel)} ` +
              `(${describeEntry(entry)}), which is not a permitted generated ` +
              `file: with Markdown emission disabled, everything \`build\` ` +
              `writes outside \`.xspec/\` is the generated module or a ` +
              `companion — each a file directly in its source's directory ` +
              `named \`NAME.xspec.\` plus a suffix, so every generated file ` +
              `carries \`.xspec.\` in its name (SPEC 13.1, 13.3, 13.4)`,
          );
        }
        if (entry.kind !== "file") {
          fail(
            `T13.1-1: the generated entry at ${JSON.stringify(rel)} must be ` +
              `a plain file (SPEC 13.4: every file xspec writes is a plain ` +
              `file; 13.1: companion files beside the module); found ` +
              describeEntry(entry),
          );
        }
      }

      // Orphan recording: the generated set is recorded such that a later
      // build removes what the current sources no longer generate — deleting
      // specs/sub/B.mdx orphans B's module and companions (SPEC 13.1, 12.1;
      // the fuller matrix is T12.1-3's).
      await fsp.rm(workspace.path("specs/sub/B.mdx"));
      await buildOk(
        product,
        workspace,
        "T13.1-1 `build` after removing specs/sub/B.mdx (SPEC 12.1)",
      );
      const armContext =
        "T13.1-1 after removing specs/sub/B.mdx and rebuilding — the " +
        "generated set is recorded such that later builds remove orphans " +
        "(SPEC 13.1, 12.1)";
      const subKind = await workspace.kind("specs/sub");
      if (subKind === "dir") {
        const leftovers = (await workspace.readdirNames("specs/sub")).filter(
          (name) => name.startsWith("B.xspec."),
        );
        if (leftovers.length > 0) {
          fail(
            `${armContext}; B's module and companions all carry ` +
              `\`B.xspec.\` in their names (SPEC 13.1), yet left over: ` +
              JSON.stringify(leftovers),
          );
        }
      } else if (subKind !== "absent") {
        fail(`${armContext}; specs/sub is now ${subKind}`);
      }
      await expectFile(
        workspace,
        "specs/A.xspec.ts",
        "T13.1-1 specs/A.xspec.ts must survive the rebuild that removes " +
          "B's orphans — A's source is unchanged (SPEC 12.1, 13.1)",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T13.1-2 — standalone consumption (the section-4 umbrella E2E)
// ---------------------------------------------------------------------------

// Pure ASCII (tooling UTF-16 offsets equal byte offsets), one sentinel per
// node so hover documentation is attributable to the hovered node and no
// requirement text collides with another node's.
const MAIN_SOURCE = [
  "MAIN-ROOT-TEXT preamble prose.",
  '<S id="alpha">',
  "MAIN-ALPHA-TEXT prose.",
  '<S id="alpha.beta">',
  "MAIN-BETA-TEXT prose.",
  "</S>",
  "</S>",
  "",
].join("\n");

const LIB_SOURCE = ['<S id="util">', "LIB-UTIL-TEXT prose.", "</S>", ""].join(
  "\n",
);

// Hand-derived subtree texts per SPEC 3/1.6 (tag-only lines drop with their
// terminators; content lines keep theirs; children interleave in document
// order).
const MAIN_ROOT_SUBTREE =
  "MAIN-ROOT-TEXT preamble prose.\n" +
  "MAIN-ALPHA-TEXT prose.\n" +
  "MAIN-BETA-TEXT prose.\n";
const MAIN_BETA_SUBTREE = "MAIN-BETA-TEXT prose.\n";
const LIB_UTIL_SUBTREE = "LIB-UTIL-TEXT prose.\n";

// The standalone consumer program, staged beside the generated modules so the
// first import is the spec-quoted literal form (SPEC 4, 13.1). The second
// module's `text` export is aliased on import (SPEC 4.4). `report` holds a
// dependency marker (a bare requirement reference as an expression statement,
// SPEC 4.5) followed by a `text` call, so the marker's runtime harmlessness
// is observable inside an executing function.
const UMBRELLA_CONSUMER = [
  'import SPEC, { text } from "./MAIN.xspec";',
  'import LIB, { text as libText } from "./LIB.xspec";',
  "",
  "function report(): string {",
  "  SPEC.alpha.beta;",
  "  return text(SPEC.alpha.beta);",
  "}",
  "",
  'process.stdout.write("begin\\n");',
  "process.stdout.write(text(SPEC));",
  "process.stdout.write(report());",
  "process.stdout.write(libText(LIB.util));",
  'process.stdout.write("end\\n");',
  "",
].join("\n");

// The program's whole stdout, byte-exact: the begin/end frame plus the
// hand-derived expansions — nothing from the marker line (SPEC 4.5: at
// runtime the program behaves as if the line were absent).
const UMBRELLA_STDOUT =
  "begin\n" +
  MAIN_ROOT_SUBTREE +
  MAIN_BETA_SUBTREE +
  LIB_UTIL_SUBTREE +
  "end\n";

// Negative arm of 4.1 type checking: a chain naming a missing requirement
// path is a TypeScript type error against the generated module.
const UMBRELLA_MISSING_CONSUMER = [
  'import SPEC from "./MAIN.xspec";',
  "",
  "SPEC.alpha.nope;",
  "",
].join("\n");

/** Render definition targets for failure diagnoses. */
function describeTargets(targets: readonly SourceDefinitionTarget[]): string {
  if (targets.length === 0) return "  <none>";
  return targets
    .map(
      (target) =>
        `  ${target.file}:${String(target.start.line)}:${String(target.start.column)} ` +
        `(offset ${String(target.start.offset)}; ` +
        (target.mapped
          ? `declaration-mapped from ${target.raw.file})`
          : "unmapped)"),
    )
    .join("\n");
}

/** Assert some editor-level definition target satisfies `predicate`. */
function assertSomeDefinition(
  targets: readonly SourceDefinitionTarget[],
  predicate: (target: SourceDefinitionTarget) => boolean,
  wanted: string,
  context: string,
): void {
  if (!targets.some(predicate)) {
    fail(
      `${context}: go-to-definition must yield a target ${wanted} ` +
        `(SPEC 4.2, 13.1); targets reported:\n${describeTargets(targets)}`,
    );
  }
}

/** Assert hover exists and its documentation contains `needle` (H-3). */
function assertHoverDocumentation(
  project: ConsumerProject,
  position: FileOffset,
  needle: string,
  context: string,
): void {
  const hover = project.hoverAt(position);
  if (hover === undefined) {
    fail(
      `${context}: hover reports nothing at the reference — the reference ` +
        `must show its documentation (SPEC 4.2)`,
    );
  }
  if (!hover.documentation.includes(needle)) {
    fail(
      `${context}: the hover documentation must contain ` +
        `${JSON.stringify(needle)} (the hovered node's own-text sentinel, ` +
        `SPEC 4.2); got documentation ${JSON.stringify(hover.documentation)}`,
    );
  }
}

const T13_1_2 = defineProductTest({
  id: "T13.1-2",
  title:
    'standalone consumption — the section-4 umbrella E2E: in a consumer project under standard TypeScript tooling only (no xspec runtime dependency), `import SPEC, { text } from "./NAME.xspec"` resolves; type checking (4.1), hover and go-to-definition into the source .mdx (4.2), and runtime text/markers (4.3–4.5) all work (SPEC 13.1, 4)',
  run: async (product) => {
    await withWorkspace(
      {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/MAIN.mdx": MAIN_SOURCE,
        "specs/LIB.mdx": LIB_SOURCE,
        "specs/app.ts": UMBRELLA_CONSUMER,
        "specs/missing.ts": UMBRELLA_MISSING_CONSUMER,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T13.1-2 `build` over the two spec sources (SPEC 12.1, 13.1)",
        );

        // (a) Resolution and 4.1 type checking, positive: the spec-quoted
        // `./NAME.xspec` imports resolve and the whole program — node
        // chains, `text` calls, the aliased second module, the marker —
        // compiles cleanly under strict standard tooling.
        const app = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["specs/app.ts"],
        });
        assertNoCompileErrors(
          app,
          "T13.1-2 the standalone consumer program: `import SPEC, { text } " +
            'from "./MAIN.xspec"` and the aliased second module resolve ' +
            "and type-check (SPEC 13.1, 4, 4.1, 4.4)",
        );

        // (b) 4.1 type checking, negative: a missing requirement path is a
        // TypeScript type error at the consumer reference.
        const missing = await ConsumerProject.load({
          rootDir: workspace.root,
          rootFiles: ["specs/missing.ts"],
        });
        assertCompileErrorAt(
          missing,
          missing.locate("specs/missing.ts", "SPEC.alpha.nope", {
            charOffset: "SPEC.alpha.".length,
          }),
          {},
          "T13.1-2 a chain naming a missing requirement path (`nope` under " +
            "`alpha`) must be a TypeScript type error at the consumer " +
            "reference (SPEC 4.1, 13.1)",
        );

        // (c) 4.2 navigation and hover on the checking program. Section
        // construct spans in the pure-ASCII source (SPEC 1.7): opening tag
        // through closing tag; alpha's own span excludes nested beta's.
        const alphaStart = MAIN_SOURCE.indexOf('<S id="alpha">');
        const betaStart = MAIN_SOURCE.indexOf('<S id="alpha.beta">');
        const betaEnd = MAIN_SOURCE.indexOf("</S>") + "</S>".length;
        const alphaEnd = MAIN_SOURCE.indexOf("</S>", betaEnd) + "</S>".length;
        const inBeta = (offset: number): boolean =>
          offset >= betaStart && offset < betaEnd;
        const inAlphaOwn = (offset: number): boolean =>
          offset >= alphaStart && offset < alphaEnd && !inBeta(offset);

        const rootRef = app.locate("specs/app.ts", "text(SPEC)", {
          charOffset: "text(".length,
        });
        const alphaRef = app.locate("specs/app.ts", "  SPEC.alpha.beta;", {
          charOffset: "  SPEC.".length,
        });
        const betaRef = app.locate("specs/app.ts", "  SPEC.alpha.beta;", {
          charOffset: "  SPEC.alpha.".length,
        });

        assertSomeDefinition(
          app.sourceDefinitionsAt(betaRef),
          (target) =>
            target.file === "specs/MAIN.mdx" && inBeta(target.start.offset),
          `in specs/MAIN.mdx within \`alpha.beta\`'s \`<S>\` construct ` +
            `[${String(betaStart)}, ${String(betaEnd)})`,
          "T13.1-2 go-to-definition on the marker's `beta` reference",
        );
        assertSomeDefinition(
          app.sourceDefinitionsAt(alphaRef),
          (target) =>
            target.file === "specs/MAIN.mdx" && inAlphaOwn(target.start.offset),
          `in specs/MAIN.mdx within \`alpha\`'s own \`<S>\` construct ` +
            `[${String(alphaStart)}, ${String(alphaEnd)}) excluding the ` +
            `nested \`alpha.beta\` construct`,
          "T13.1-2 go-to-definition on the mid-chain `alpha` reference",
        );
        assertSomeDefinition(
          app.sourceDefinitionsAt(rootRef),
          (target) =>
            target.file === "specs/MAIN.mdx" && target.start.offset === 0,
          "in specs/MAIN.mdx at the start of the file (offset 0 — the root " +
            "has no `<S>` section, SPEC 1.2, 4.2)",
          "T13.1-2 go-to-definition on the root reference (default export)",
        );

        assertHoverDocumentation(
          app,
          rootRef,
          "MAIN-ROOT-TEXT",
          "T13.1-2 hover on the root reference",
        );
        assertHoverDocumentation(
          app,
          alphaRef,
          "MAIN-ALPHA-TEXT",
          "T13.1-2 hover on the `alpha` reference",
        );
        assertHoverDocumentation(
          app,
          betaRef,
          "MAIN-BETA-TEXT",
          "T13.1-2 hover on the `beta` reference",
        );

        // (d) 4.3–4.5 runtime: compile with standard tooling, run under
        // plain Node (NODE_PATH dropped — no xspec runtime dependency), and
        // byte-compare the program's whole stdout: `text` returns the
        // subtree texts through both modules (the second via its alias) and
        // the marker line contributes nothing.
        const emitted = app.emit();
        if (emitted.emitSkipped) {
          fail(
            "T13.1-2: consumer emit was skipped; diagnostics:\n" +
              emitted.diagnostics
                .map(
                  (diagnostic) => `  ${formatConsumerDiagnostic(diagnostic)}`,
                )
                .join("\n"),
          );
        }
        const run = await runConsumer({
          dir: workspace.root,
          entry: "specs/app.js",
        });
        assertExitCode(
          run,
          0,
          "T13.1-2 the compiled consumer under plain Node — runtime `text` " +
            "and the marker work with no additional tooling installed " +
            "(SPEC 4.3, 4.5, 13.1)",
        );
        assertBytesEqual(
          run.stdoutBytes,
          UMBRELLA_STDOUT,
          "T13.1-2 the program's whole stdout: `text` returns the subtree " +
            "texts byte-exactly through both modules and the program " +
            "behaves as if the marker line were absent (SPEC 4.3, 4.4, " +
            "4.5, 1.6)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.2-1 — Markdown emission placement, content per section 3
// ---------------------------------------------------------------------------

/** One spec group plus the given `markdown` object literal (SPEC 7, 7.3). */
function emissionConfig(markdown: string): string {
  return `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: ${markdown}
})
`;
}

// A section-3-representative source — an import (removed, line dropped), a
// tag with props (removed), an own-line MDX comment (dropped with its line),
// a mid-line `text(...)` embedding (replaced with the target's subtree text),
// author whitespace preserved — plus a subdirectory target source, so the
// outDir arm observes preserved workspace-relative paths on both files.
const EMISSION_SOURCES: Readonly<Record<string, string>> = {
  "specs/A.mdx": [
    'import LIB from "./sub/LIB.xspec"',
    "",
    "# Guide",
    "",
    '<S id="alpha" tags="quote">',
    "Alpha keeps   spacing.",
    "{/* dropped comment line */}",
    "Quoting: {text(LIB.util)} inline.",
    "</S>",
    "",
    "Tail prose.",
    "",
  ].join("\n"),
  // A single unterminated line: util's subtree text carries no trailing
  // terminator (SPEC 3: the final line MAY have no terminator), so the
  // mid-line embedding above stays a single line.
  "specs/sub/LIB.mdx": '<S id="util">Util behavior text.</S>',
};

// Hand-derived per SPEC 3: the import line and the tag-only, comment-only
// lines drop with their terminators; the blank source lines and content
// lines keep theirs (author whitespace byte-preserved); the `text(...)`
// expression is replaced in place by util's subtree text.
const A_COMPILED =
  "\n" +
  "# Guide\n" +
  "\n" +
  "Alpha keeps   spacing.\n" +
  "Quoting: Util behavior text. inline.\n" +
  "\n" +
  "Tail prose.\n";
// Tag pair deleted in place; the line keeps its remaining content and its
// (absent) terminator.
const LIB_COMPILED = "Util behavior text.";

const T13_2_1 = defineProductTest({
  id: "T13.2-1",
  title:
    "NAME.mdx emits NAME.md next to it when enabled, and with outDir under that directory preserving workspace-relative paths — content per section 3, byte-exact (SPEC 13.2, 3, 7.3)",
  run: async (product) => {
    // (a) Default placement: next to each source.
    await withWorkspace(
      {
        "xspec.config.ts": emissionConfig("{ emit: true }"),
        ...EMISSION_SOURCES,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T13.2-1 `build` with emission enabled, default placement " +
            "(SPEC 13.2, 7.3)",
        );
        await assertFileBytes(
          workspace.path("specs/A.md"),
          A_COMPILED,
          "T13.2-1 specs/A.mdx emits specs/A.md next to it — content per " +
            "section 3: import removed, tag and props removed, comment " +
            "dropped with its line, `text(...)` replaced with the target's " +
            "subtree text, all other content and author whitespace " +
            "byte-preserved (SPEC 13.2, 3)",
        );
        await assertFileBytes(
          workspace.path("specs/sub/LIB.md"),
          LIB_COMPILED,
          "T13.2-1 specs/sub/LIB.mdx emits specs/sub/LIB.md next to it " +
            "(SPEC 13.2, 3)",
        );
      },
    );

    // (b) outDir placement: under the directory, preserving
    // workspace-relative paths; the default paths stay vacant (placed per
    // markdown.outDir — redirected, not duplicated).
    await withWorkspace(
      {
        "xspec.config.ts": emissionConfig('{ emit: true, outDir: "docs" }'),
        ...EMISSION_SOURCES,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T13.2-1 `build` with outDir docs (SPEC 13.2, 7.3)",
        );
        await assertFileBytes(
          workspace.path("docs/specs/A.md"),
          A_COMPILED,
          "T13.2-1 (outDir): specs/A.mdx emits docs/specs/A.md — under " +
            "outDir, preserving the workspace-relative path, content per " +
            "section 3 (SPEC 13.2, 7.3, 3)",
        );
        await assertFileBytes(
          workspace.path("docs/specs/sub/LIB.md"),
          LIB_COMPILED,
          "T13.2-1 (outDir): specs/sub/LIB.mdx emits docs/specs/sub/LIB.md " +
            "— subdirectory structure preserved under outDir (SPEC 13.2, " +
            "7.3, 3)",
        );
        for (const rel of ["specs/A.md", "specs/sub/LIB.md"]) {
          const kind = await workspace.kind(rel);
          if (kind !== "absent") {
            fail(
              `T13.2-1 (outDir): expected nothing at ${rel} — emitted ` +
                `files are placed per markdown.outDir, so under outDir the ` +
                `default next-to-source paths are not emit destinations ` +
                `(SPEC 13.2, 7.3); found ${kind}`,
            );
          }
        }
      },
    );
  },
});

/** TEST-SPEC §13.1–13.2, in canonical ID order (SUITE-45). */
export const section131to132Tests: readonly ProductTestEntry[] = [
  T13_1_1,
  T13_1_2,
  T13_2_1,
];
