// TEST-SPEC §6.5 (move) — SUITE-25: T6.5-1…T6.5-6.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 6.5: `xspec move <old-file> <new-file>` relocates a source file (IDs
// unchanged, identities change file part only, the moved file's own import
// specifiers and other files' imports of its generated module rewritten so
// everything resolves); `xspec move <file>#<id> <target-file>#<new-id>`
// extracts a section subtree, re-identified by prefix replacement, with exact
// text edits: the moved text is the construct's own characters (or the
// self-closing tag's own characters, 1.1); origin lines left empty or
// whitespace-only purely by the deletion are dropped with their terminators
// (rule of 3); insertion is immediately before the target parent's closing
// tag (end of file for a top-level `new-id`), followed by U+000A and preceded
// by one when the insertion point is not at the start of a line; a
// self-closing target parent is first rewritten to paired form; the target
// file is created when absent. Beyond these edits, the identity and reference
// rewrites, and the finishing regeneration, a move changes no bytes. All
// references are rewritten to resolve, converting between local and imported
// forms; imports are added binding fresh, non-colliding identifiers and
// removed exactly when a binding had references and the rewrite leaves it
// with none; the full mapping is appended to the journal in both forms;
// rewritten content is byte-deterministic. Validation mirrors rename (6.4) in
// identity terms, plus move-specific refusals; a nonexistent origin file or
// ID is a usage error (12.0).
//
// Conservative operationalizations (noted per H-4):
// - T6.5-1 "rewritten so everything resolves": SPEC pins resolution, not the
//   rewritten specifier's spelling (several relative paths resolve to one
//   file), so specifiers are asserted as: the stale quoted spelling gone, a
//   spelling naming the moved module's file stem present (every resolving
//   specifier ends in `Moved.xspec` / `Other.xspec`), and `check` exit 0 —
//   which enforces that all imports and references actually resolve (12.2).
// - "Mapping appended to the journal" uses the SUITE-21 operationalization:
//   the journal (absent before the first journaled operation, SPEC 6.1) is a
//   plain file holding exactly one line-oriented entry after the one move;
//   entry content stays opaque (H-4). T6.5-1 asserts it for the file form,
//   T6.5-3 for the section form — "the full mapping … (6.5: both forms)".
// - T6.5-1/T6.5-3 "finishing regeneration as T6.4-7" is the H-6 two-directory
//   protocol: a second workspace is seeded with the post-move configuration,
//   sources, and journal (derived files are reproducible from those,
//   SPEC 13.4), `xspec build` runs there, and the two workspace roots are
//   compared as whole byte trees, normalizing nothing.
// - T6.5-2 compares every staged source file byte-exactly after the move; an
//   uninvolved bystander file in each arm witnesses "no other byte changes".
//   The finishing regeneration's derived files are deliberately outside these
//   compares (they are T6.5-1/T6.5-3's fresh-build business).
// - T6.5-3 identifier choice and placement for added imports are
//   deterministic per SPEC 6.5/6.1 but their concrete spelling is
//   product-chosen, so freshness/non-collision is asserted through the
//   observable contract: the target file already binds the identifier `Keep`
//   (to another module) that the added `./Keep.xspec` import would naturally
//   take, so a non-fresh choice becomes a duplicate binding (14.15) and fails
//   the post-move `check`; byte determinism itself is the H-6 two-directory
//   protocol over the whole move (rewritten sources, derived files, and
//   journal alike). Conversion spellings that 6.4's rules do pin — converted
//   references become double-quoted string literals, kept forms keep their
//   quote style — are asserted as exact substrings (`d={"tm"}`,
//   `{text("tm.k1")}`, `d={"tm.k1"}`).
// - T6.5-4 refusal report content is deliberately unasserted (12.0 classes
//   refusals exit 1; TEST-SPEC pins no report content), so refusal arms run
//   without `--json`; "modifies nothing" is a whole-workspace-root byte
//   snapshot compare around each refused command with the pre-refusal
//   `build`'s derived files present (the T6.4-3 protocol). Because each arm
//   proves it modified nothing, the arms share one staged workspace. The
//   not-valid-UTF-8 destination is staged on the Linux leg only (mirroring
//   T1.5-2's platform note): argv bytes exist as a channel there, carried by
//   the subprocess driver's raw-byte argv support.
// - T6.5-5 exit-2 arms run with `--json`: stdout byte-empty (H-5: no report,
//   no validation findings — the 12.0-ordering discriminator) and the usage
//   error message on stderr (presence, not wording). The masking arm asserts
//   exit 1 with exactly one 14.20 finding naming the unparseable origin file.
// - T6.5-6's unstageable clauses are documented at the test, per TEST-SPEC:
//   the collision clause's after-the-removal qualifier admits no
//   discriminating fixture (structural IDs make the vacated set exactly the
//   moved subtree's IDs, so a `<new-id>` matching only vacated identities is
//   always independently refused), and the mirrored "all rewritten references
//   resolve" clause is unstageable for T6.4-3's reason.

import { Buffer } from "node:buffer";
import type { GraphEdge } from "../../helpers/adapters/index.js";
import {
  decodeEdgesReport,
  decodeFindingsReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  assertFileBytes,
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { assertAcrossDirectoriesDeterministic } from "../../helpers/determinism.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  assertDirectoriesEqual,
  assertLeavesUnchanged,
} from "../../helpers/snapshot.js";
import { runProduct } from "../../helpers/subprocess.js";
import type {
  ArgvValue,
  ProductBinding,
  RunResult,
} from "../../helpers/subprocess.js";
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

// Exactly one spec group (SPEC 7), for the byte-exact edit and identity-terms
// fixtures.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus Markdown emission (SPEC 7.3), so T6.5-3's fresh-build
// compare covers generated modules, Markdown output, and graph data alike.
const SPECS_MD_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

// Specs, code, and Markdown emission, for the T6.5-1 file-form fixture whose
// rewrites span MDX and TypeScript sources and whose fresh-build compare
// covers every derived-file kind (the T6.4-7 configuration).
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

// The T6.5-4 refusal configuration: the second spec glob admits `.mdx`-less
// destinations under `specs/plain/` (isolating the lacking-`.mdx` refusal
// from the no-spec-group one), and the code group overlaps the spec globs at
// `specs/dual/` (the belonging-to-a-code-group-as-well refusal, 14.14). Both
// extra globs match no staged file, so the workspace itself stays valid.
const REFUSAL_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx", "specs/plain/**"]
  },
  code: {
    dual: ["specs/dual/**"]
  }
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

/** Assert the journal holds exactly one line-oriented entry (SPEC 6.1, 6.5). */
async function assertJournalHoldsOneEntry(
  workspace: TestWorkspace,
  context: string,
): Promise<void> {
  const journal = await readJournal(workspace, context);
  const lines = journalLineCount(journal);
  if (lines !== 1) {
    fail(
      `${context}: the move must append its full mapping to the journal as ` +
        `exactly one line-oriented entry — the journal came into existence ` +
        `with this first journaled operation (SPEC 6.5, 6.1); found ` +
        `${String(lines)} line(s) in ${String(journal.length)} bytes`,
    );
  }
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
 * The workspace's complete edge set of one dependency kind, via
 * `query edges --kinds <kind>` (SPEC 11), for exact-set comparison (5.2).
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

/** Assert a rewritten source still contains `needle` (SPEC 6.5), diagnosed. */
function assertContains(
  text: string,
  rel: string,
  needle: string,
  why: string,
  context: string,
): void {
  if (!text.includes(needle)) {
    fail(
      `${context}: ${rel} does not contain ${JSON.stringify(needle)} — ${why}`,
    );
  }
}

/** Assert a rewritten source no longer contains `needle`, diagnosed. */
function assertLacks(
  text: string,
  rel: string,
  needle: string,
  why: string,
  context: string,
): void {
  if (text.includes(needle)) {
    fail(
      `${context}: ${rel} still contains ${JSON.stringify(needle)} — ${why}`,
    );
  }
}

/** Human rendering of an argv that may carry raw-byte elements. */
function renderArgv(argv: readonly ArgvValue[]): string {
  return argv
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : `<bytes 0x${Buffer.from(arg).toString("hex")}>`,
    )
    .join(" ");
}

/**
 * A refused move (SPEC 6.5: every validation failure beyond the argument
 * existence checks refuses with exit 1): assert exit 1 exactly and that the
 * refusal modifies nothing — a whole-workspace-root byte snapshot compare
 * around the command (derived files, sources, and the journal all included).
 * Accepts raw-byte argv elements for the Linux-leg non-UTF-8 destination arm.
 */
async function expectRefusalModifiesNothing(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly ArgvValue[],
  context: string,
): Promise<void> {
  const command = renderArgv(argv);
  await assertLeavesUnchanged(
    workspace.root,
    async () => {
      const result = await runProduct(product, {
        cwd: workspace.root,
        argv,
      });
      assertExitCode(
        result,
        1,
        `${context}: \`${command}\` — the refusal is a validation failure, ` +
          `exit 1 (SPEC 6.5, 12.0)`,
      );
    },
    `${context}: \`${command}\` refused — modifies nothing (SPEC 6.5)`,
  );
}

/**
 * A move usage error (SPEC 6.5, 12.0: nonexistent origin file or origin ID):
 * run with `--json`, assert exit 2 exactly, byte-empty stdout (H-5: no report
 * and no validation findings — the 12.0-ordering discriminator), and a usage
 * error message on stderr (presence, not wording).
 */
async function expectMoveUsageError(
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
    `${context}: \`${command} --json\` — a nonexistent origin file or origin ` +
      `ID is a usage error (SPEC 6.5, 12.0)`,
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
// T6.5-1 — file form
// ---------------------------------------------------------------------------

// The moved file imports another spec file (its own import specifier must be
// rewritten across the directory change) and its generated module is imported
// by a spec file and a code file (their import paths rewritten); its sections
// are referenced through `d`, MDX and TS `text(...)`, and a TS marker, so the
// post-move edge sets witness that everything resolves under the new
// identities — file part changed, IDs unchanged (SPEC 6.5).
const F1_OTHER = "specs/Other.mdx";
const F1_CORE = "specs/Core.mdx";
const F1_MOVED = "specs/sub/Moved.mdx";
const F1_REFS = "specs/Refs.mdx";
const F1_APP = "src/app.ts";

const F1_OTHER_SOURCE = [
  '<S id="oth">',
  "Outside target text.",
  "</S>",
  "",
].join("\n");

const F1_CORE_SOURCE = [
  'import Other from "./Other.xspec"',
  "",
  '<S id="core">',
  "Core holder text.",
  "",
  '<S id="core.mid" d={Other.oth}>',
  "Mid text.",
  "",
  '<S id="core.mid.leaf">',
  "Leaf embeds: {text(Other.oth)}",
  "</S>",
  "</S>",
  "</S>",
  "",
].join("\n");

const F1_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={Core.core.mid}>',
  "Refs embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "",
].join("\n");

const F1_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

const F1_UNCHANGED_IDENTITIES = [
  F1_OTHER,
  `${F1_OTHER}#oth`,
  F1_REFS,
  `${F1_REFS}#refs`,
];
const F1_PRE_IDENTITIES = [
  ...F1_UNCHANGED_IDENTITIES,
  F1_CORE,
  `${F1_CORE}#core`,
  `${F1_CORE}#core.mid`,
  `${F1_CORE}#core.mid.leaf`,
];
// Identities change only in their file part (SPEC 6.5): same IDs, new path.
const F1_POST_IDENTITIES = [
  ...F1_UNCHANGED_IDENTITIES,
  F1_MOVED,
  `${F1_MOVED}#core`,
  `${F1_MOVED}#core.mid`,
  `${F1_MOVED}#core.mid.leaf`,
];

/** The fixture's complete dependency-kind edge sets, per moved-file path. */
function f1Edges(coreFile: string): {
  depends: GraphEdge[];
  embeds: GraphEdge[];
  references: GraphEdge[];
} {
  return {
    depends: [
      {
        from: `${coreFile}#core.mid`,
        to: `${F1_OTHER}#oth`,
        kind: "depends",
      },
      {
        from: `${F1_REFS}#refs`,
        to: `${coreFile}#core.mid`,
        kind: "depends",
      },
    ],
    embeds: [
      {
        from: `${coreFile}#core.mid.leaf`,
        to: `${F1_OTHER}#oth`,
        kind: "embeds",
      },
      {
        from: `${F1_REFS}#refs`,
        to: `${coreFile}#core.mid.leaf`,
        kind: "embeds",
      },
      { from: F1_APP, to: `${coreFile}#core.mid`, kind: "embeds" },
    ],
    references: [
      { from: F1_APP, to: `${coreFile}#core.mid.leaf`, kind: "references" },
    ],
  };
}

/** Assert the workspace-wide edge set of each dependency kind (SPEC 5.2, 11). */
async function assertF1Edges(
  product: ProductBinding,
  workspace: TestWorkspace,
  coreFile: string,
  context: string,
): Promise<void> {
  const expected = f1Edges(coreFile);
  for (const kind of ["depends", "embeds", "references"] as const) {
    assertEdgeSetEqual(
      await queryEdgesOfKind(product, workspace, kind, context),
      expected[kind],
      `${context}: the workspace's complete \`${kind}\` edge set — every ` +
        `reference resolves to the moved file's new identities, whose file ` +
        `part alone changed (SPEC 6.5, 5.2)`,
    );
  }
}

// The non-derived workspace state seeded into the fresh-build directory:
// configuration, every source file (post-move bytes), and the journal
// (derived files are reproducible from those, SPEC 13.4).
const F1_SEED_FILES = [
  "xspec.config.ts",
  F1_OTHER,
  F1_MOVED,
  F1_REFS,
  F1_APP,
  JOURNAL_PATH,
] as const;

const T6_5_1 = defineProductTest({
  id: "T6.5-1",
  title:
    "file form: `xspec move old.mdx new.mdx` keeps IDs unchanged and changes identities only in their file part; the moved file's own import specifiers and other files' imports of its generated module are rewritten so everything resolves; the mapping is appended to the journal; finishing regeneration as T6.4-7 — byte-identical to a fresh `build`, `check` clean (SPEC 6.5, 6.1, 12.1, 14.10)",
  run: async (product) => {
    await withWorkspace(
      FULL_CONFIG,
      {
        [F1_OTHER]: F1_OTHER_SOURCE,
        [F1_CORE]: F1_CORE_SOURCE,
        [F1_REFS]: F1_REFS_SOURCE,
        [F1_APP]: F1_APP_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.5-1 `build` over the staged workspace",
        );

        // Staging premises: no journal before the first journaled operation
        // (SPEC 6.1); the pre-move node and edge inventories are exactly as
        // staged, so the post-move assertions witness a real transition.
        const journalBefore = await workspace.kind(JOURNAL_PATH);
        if (journalBefore !== "absent") {
          fail(
            `T6.5-1: staging premise — no journal file exists before the ` +
              `first journaled operation (SPEC 6.1); found ${journalBefore} ` +
              `at ${JOURNAL_PATH}`,
          );
        }
        await assertNodeIdentities(
          product,
          workspace,
          F1_PRE_IDENTITIES,
          "staging premise — the pre-move enumeration is exactly the staged " +
            "node set (SPEC 11, 1.5)",
          "T6.5-1 pre-move",
        );
        await assertF1Edges(product, workspace, F1_CORE, "T6.5-1 pre-move");

        await expectExit(
          product,
          workspace,
          ["move", F1_CORE, F1_MOVED],
          0,
          "T6.5-1 file-form `move specs/Core.mdx specs/sub/Moved.mdx`",
        );

        // The file was relocated.
        const originKind = await workspace.kind(F1_CORE);
        if (originKind !== "absent") {
          fail(
            `T6.5-1: the origin file ${F1_CORE} must be gone after the ` +
              `file-form move (SPEC 6.5); found ${originKind}`,
          );
        }

        // Specifier rewrites (module header, H-4): the stale quoted spelling
        // is gone and a spelling naming the resolving module remains — the
        // moved file's own import, a spec file's import, a code file's
        // import (SPEC 6.5).
        const movedText = await readSourceText(
          workspace,
          F1_MOVED,
          "T6.5-1 rewrite check",
        );
        assertLacks(
          movedText,
          F1_MOVED,
          '"./Other.xspec"',
          "the moved file's own import specifiers are rewritten for its new " +
            "directory (SPEC 6.5); from specs/sub/ the old spelling no " +
            "longer resolves",
          "T6.5-1 rewrite check",
        );
        assertContains(
          movedText,
          F1_MOVED,
          "Other.xspec",
          "every resolving specifier for specs/Other.mdx ends in " +
            "`Other.xspec` (SPEC 2.1)",
          "T6.5-1 rewrite check",
        );
        for (const [rel, stale] of [
          [F1_REFS, '"./Core.xspec"'],
          [F1_APP, '"../specs/Core.xspec"'],
        ] as const) {
          const text = await readSourceText(
            workspace,
            rel,
            "T6.5-1 rewrite check",
          );
          assertLacks(
            text,
            rel,
            stale,
            "imports of the moved file's generated module are rewritten so " +
              "all references continue to resolve (SPEC 6.5)",
            "T6.5-1 rewrite check",
          );
          assertContains(
            text,
            rel,
            "Moved.xspec",
            "every resolving specifier for the moved module ends in " +
              "`Moved.xspec` (SPEC 2.1, 4)",
            "T6.5-1 rewrite check",
          );
        }

        // Mapping appended to the journal (SPEC 6.5, 6.1; SUITE-21
        // operationalization, content opaque per H-4).
        await assertJournalHoldsOneEntry(workspace, "T6.5-1 after the move");

        // Everything resolves and no stale output remains: `check` exit 0
        // immediately after the move (SPEC 6.5, 12.2, 14.10).
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T6.5-1 `check` immediately after the file-form move — all " +
            "rewritten imports and references resolve and the finishing " +
            "regeneration left no staleness (SPEC 6.5, 12.2, 14.10)",
        );

        // IDs unchanged; identities change file part only (query-asserted).
        await assertNodeIdentities(
          product,
          workspace,
          F1_POST_IDENTITIES,
          "after the file-form move, every moved identity keeps its ID and " +
            "changes only its file part; every other identity is unchanged " +
            "(SPEC 6.5, 1.5)",
          "T6.5-1 post-move",
        );
        await assertF1Edges(product, workspace, F1_MOVED, "T6.5-1 post-move");

        // Finishing regeneration as T6.4-7 (H-6 two-directory protocol):
        // seed a fresh workspace with the post-move sources, configuration,
        // and journal; `build`; compare the whole roots byte-for-byte.
        const fresh = await TestWorkspace.create();
        try {
          for (const rel of F1_SEED_FILES) {
            const kind = await workspace.kind(rel);
            if (kind !== "file") {
              fail(
                `T6.5-1: expected ${rel} as a plain file in the moved ` +
                  `workspace to seed the fresh-build directory (SPEC 6.5, ` +
                  `6.1, 13.4); found ${kind}`,
              );
            }
            await fresh.file(rel, await workspace.readBytes(rel));
          }
          await buildOk(
            product,
            fresh,
            "T6.5-1 fresh `build` over the post-move sources",
          );
          await assertDirectoriesEqual(
            workspace.root,
            fresh.root,
            "T6.5-1: the moved workspace vs a fresh `build` of the post-move " +
              "sources — generated modules, Markdown output, and graph data " +
              "must be byte-identical (SPEC 6.5: a successful move " +
              "regenerates derived files as rename does; 6.4, 12.0 " +
              "determinism; H-4/H-6, normalizing nothing)",
          );
        } finally {
          await fresh.dispose();
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.5-2 — section form text edits (byte-exact)
// ---------------------------------------------------------------------------

// Shared origin: the moved construct `a.mv` spans whole lines — its own
// characters run from the `<` of its opening tag through the `>` of its
// closing tag. Deleting them in place merges the three construct lines into
// one line holding only the closing tag's terminator; that line contained
// non-whitespace in the source and is left empty purely by the deletion, so
// it is dropped with its terminator (rule of 3), while the blank line above
// it — already empty in the source — is kept (SPEC 6.5, 3).
const X2_ORIGIN = "specs/A.mdx";
const X2_ORIGIN_BEFORE = [
  '<S id="a">',
  "Alpha holder.",
  "",
  '<S id="a.mv">',
  "Moved text.",
  "</S>",
  "</S>",
  "",
].join("\n");
const X2_ORIGIN_AFTER = ['<S id="a">', "Alpha holder.", "", "</S>", ""].join(
  "\n",
);

// Uninvolved bystander, asserted byte-identical in every arm: beyond the
// stated edits, the identity and reference rewrites, and the finishing
// regeneration, a move changes no bytes (SPEC 6.5).
const X2_ZED = "specs/Zed.mdx";
const X2_ZED_SOURCE = ['<S id="zed">', "Zed text.", "</S>", ""].join("\n");

/** One byte-exact arm: staged files, the move argv, expected file bytes. */
interface ByteExactArm {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly expected: Readonly<Record<string, string>>;
}

const X2_ARMS: readonly ByteExactArm[] = [
  {
    // Deletion drops the merged construct line (rule of 3), keeps the
    // pre-existing blank line; insertion immediately before the target
    // parent's closing tag, whose line start makes a preceding U+000A
    // unnecessary; the moved text travels verbatim except its re-identified
    // `id`, followed by U+000A.
    name: "line-start insertion + origin line-drop",
    files: {
      [X2_ORIGIN]: X2_ORIGIN_BEFORE,
      "specs/B.mdx": ['<S id="b">', "Beta holder.", "</S>", ""].join("\n"),
    },
    argv: ["move", "specs/A.mdx#a.mv", "specs/B.mdx#b.mv"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/B.mdx": [
        '<S id="b">',
        "Beta holder.",
        '<S id="b.mv">',
        "Moved text.",
        "</S>",
        "</S>",
        "",
      ].join("\n"),
    },
  },
  {
    // The target parent's closing tag is mid-line (preceded by `.`), so the
    // insertion is preceded by one U+000A as well as followed by one.
    name: "mid-line insertion point",
    files: {
      [X2_ORIGIN]: X2_ORIGIN_BEFORE,
      "specs/C.mdx": '<S id="c">Gamma holder.</S>\n',
    },
    argv: ["move", "specs/A.mdx#a.mv", "specs/C.mdx#c.mv"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/C.mdx": [
        '<S id="c">Gamma holder.',
        '<S id="c.mv">',
        "Moved text.",
        "</S>",
        "</S>",
        "",
      ].join("\n"),
    },
  },
  {
    // Top-level `new-id` into an absent target: the file is created, empty
    // before insertion; position 0 of the empty file is the start of a line,
    // so no preceding U+000A.
    name: "target file created when absent (top-level new-id)",
    files: { [X2_ORIGIN]: X2_ORIGIN_BEFORE },
    argv: ["move", "specs/A.mdx#a.mv", "specs/New.mdx#solo"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/New.mdx": ['<S id="solo">', "Moved text.", "</S>", ""].join("\n"),
    },
  },
  {
    // Top-level `new-id` into an existing file whose final line is
    // terminated: end-of-file insertion at the start of a line — no
    // preceding U+000A.
    name: "end-of-file insertion after a terminated final line",
    files: {
      [X2_ORIGIN]: X2_ORIGIN_BEFORE,
      "specs/D.mdx": ['<S id="d">', "Delta text.", "</S>", ""].join("\n"),
    },
    argv: ["move", "specs/A.mdx#a.mv", "specs/D.mdx#dm"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/D.mdx": [
        '<S id="d">',
        "Delta text.",
        "</S>",
        '<S id="dm">',
        "Moved text.",
        "</S>",
        "",
      ].join("\n"),
    },
  },
  {
    // Top-level `new-id` into an existing file whose final line has no
    // terminator (SPEC 3 allows it): the end of file is not at the start of
    // a line, so the insertion is preceded by one U+000A.
    name: "end-of-file insertion after an unterminated final line",
    files: {
      [X2_ORIGIN]: X2_ORIGIN_BEFORE,
      "specs/E.mdx": ['<S id="e">', "Echo text.", "</S>"].join("\n"),
    },
    argv: ["move", "specs/A.mdx#a.mv", "specs/E.mdx#em"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/E.mdx": [
        '<S id="e">',
        "Echo text.",
        "</S>",
        '<S id="em">',
        "Moved text.",
        "</S>",
        "",
      ].join("\n"),
    },
  },
  {
    // Self-closing moved section (1.1, 6.5): the moved text is exactly the
    // self-closing tag's own characters — it stays self-closing at the
    // destination, re-identified; its origin line is dropped (rule of 3).
    name: "self-closing moved section",
    files: {
      [X2_ORIGIN]: [
        '<S id="a">',
        "Alpha holder.",
        '<S id="a.todo" />',
        "</S>",
        "",
      ].join("\n"),
      "specs/B.mdx": ['<S id="b">', "Beta holder.", "</S>", ""].join("\n"),
    },
    argv: ["move", "specs/A.mdx#a.todo", "specs/B.mdx#b.todo"],
    expected: {
      [X2_ORIGIN]: ['<S id="a">', "Alpha holder.", "</S>", ""].join("\n"),
      "specs/B.mdx": [
        '<S id="b">',
        "Beta holder.",
        '<S id="b.todo" />',
        "</S>",
        "",
      ].join("\n"),
    },
  },
  {
    // Self-closing target parent (the TEST-SPEC worked example): its `/` and
    // the whitespace immediately before it are deleted, `</Spec>` — the
    // closing tag matching the opening tag's name — is appended immediately
    // after the tag's terminating `>`, and the insertion rule then applies
    // before that closing tag: `<Spec id="p" />` becomes `<Spec id="p">` +
    // U+000A + the moved text + U+000A + `</Spec>` (SPEC 6.5, 1.1).
    name: "self-closing target parent rewritten to paired form",
    files: {
      [X2_ORIGIN]: X2_ORIGIN_BEFORE,
      "specs/P.mdx": '<Spec id="p" />\n',
    },
    argv: ["move", "specs/A.mdx#a.mv", "specs/P.mdx#p.mv"],
    expected: {
      [X2_ORIGIN]: X2_ORIGIN_AFTER,
      "specs/P.mdx": [
        '<Spec id="p">',
        '<S id="p.mv">',
        "Moved text.",
        "</S>",
        "</Spec>",
        "",
      ].join("\n"),
    },
  },
];

const T6_5_2 = defineProductTest({
  id: "T6.5-2",
  title:
    "section form text edits, byte-exact: moved text spans the opening tag's first character through the closing tag's last; origin deletion drops lines left empty/whitespace-only (rule of 3); insertion immediately before the target parent's closing tag (or end of file for top-level `new-id`), followed by U+000A and preceded by one when not at line start; target file created when absent; self-closing sections move as exactly their tag's characters and a self-closing target parent is first rewritten to paired form; no other byte changes (SPEC 6.5, 3, 1.1)",
  run: async (product) => {
    for (const arm of X2_ARMS) {
      await withWorkspace(
        SPECS_ONLY_CONFIG,
        { ...arm.files, [X2_ZED]: X2_ZED_SOURCE },
        async (workspace) => {
          const context = `T6.5-2 (${arm.name})`;
          await expectExit(
            product,
            workspace,
            arm.argv,
            0,
            `${context}: \`${arm.argv.join(" ")}\``,
          );
          for (const [rel, bytes] of Object.entries(arm.expected)) {
            await assertFileBytes(
              workspace.path(rel),
              bytes,
              `${context}: ${rel} after the move — the section form's text ` +
                `edits are exact (SPEC 6.5, 3, 1.1; H-4, normalizing nothing)`,
            );
          }
          await assertFileBytes(
            workspace.path(X2_ZED),
            X2_ZED_SOURCE,
            `${context}: ${X2_ZED} (uninvolved bystander) after the move — ` +
              `beyond the stated edits, the identity and reference rewrites, ` +
              `and the finishing regeneration, a move changes no bytes ` +
              `(SPEC 6.5)`,
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T6.5-3 — re-identification and reference conversion
// ---------------------------------------------------------------------------

// The conversion matrix in one move (`org.mv` → top-level `tm` in Target):
// - local → imported: the origin's remaining `org.usemv` references the moved
//   node locally (`d` and `text(...)`), so Origin.mdx needs an added import
//   of the target module (fresh binding).
// - imported → local: Target.mdx references the moved node through its `Org`
//   import; those references become local strings, leaving the `Org` binding
//   referenceless — removed, because it *had* references (exact removal).
// - import added to the target: the moved node's own `d={Keep.keep}` needs a
//   `./Keep.xspec` binding Target.mdx lacks; Target.mdx already binds the
//   identifier `Keep` (to `./Spare.xspec`), so the added import must choose a
//   fresh, non-colliding identifier or fail the post-move `check` (14.15).
// - import removed from the origin: the moved node was the origin's only
//   user of its `Keep` binding, so that import goes.
// - unreferenced import stays: Target.mdx's `Keep` → `./Spare.xspec` binding
//   had no references before the move and must survive byte-verbatim.
// - within the moved subtree: `org.mv.k2`'s local `d={"org.mv.k1"}` stays
//   local, re-identified by prefix replacement to `d={"tm.k1"}`.
const R3_KEEP = "specs/Keep.mdx";
const R3_SPARE = "specs/Spare.mdx";
const R3_ORIGIN = "specs/Origin.mdx";
const R3_TARGET = "specs/Target.mdx";

const R3_KEEP_SOURCE = ['<S id="keep">', "Keep text.", "</S>", ""].join("\n");
const R3_SPARE_SOURCE = ['<S id="sp">', "Spare text.", "</S>", ""].join("\n");

const R3_ORIGIN_SOURCE = [
  'import Keep from "./Keep.xspec"',
  "",
  '<S id="org">',
  "Origin holder text.",
  "",
  '<S id="org.mv" d={Keep.keep}>',
  "Moved root text.",
  "",
  '<S id="org.mv.k1">',
  "Moved first kid.",
  "</S>",
  "",
  '<S id="org.mv.k2" d={"org.mv.k1"}>',
  "Moved second kid.",
  "</S>",
  "</S>",
  "",
  '<S id="org.usemv" d={"org.mv"}>',
  'Uses the moved node: {text("org.mv.k1")}',
  "</S>",
  "</S>",
  "",
].join("\n");

const R3_TARGET_SOURCE = [
  'import Org from "./Origin.xspec"',
  'import Keep from "./Spare.xspec"',
  "",
  '<S id="tgt" d={Org.org.mv}>',
  "Target text: {text(Org.org.mv.k1)}",
  "</S>",
  "",
].join("\n");

const R3_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": SPECS_MD_CONFIG,
  [R3_KEEP]: R3_KEEP_SOURCE,
  [R3_SPARE]: R3_SPARE_SOURCE,
  [R3_ORIGIN]: R3_ORIGIN_SOURCE,
  [R3_TARGET]: R3_TARGET_SOURCE,
};

const R3_MOVE_ARGV = [
  "move",
  "specs/Origin.mdx#org.mv",
  "specs/Target.mdx#tm",
] as const;

// Subtree re-identified by prefix replacement: org.mv → tm, descendants too.
const R3_POST_IDENTITIES = [
  R3_KEEP,
  `${R3_KEEP}#keep`,
  R3_SPARE,
  `${R3_SPARE}#sp`,
  R3_ORIGIN,
  `${R3_ORIGIN}#org`,
  `${R3_ORIGIN}#org.usemv`,
  R3_TARGET,
  `${R3_TARGET}#tgt`,
  `${R3_TARGET}#tm`,
  `${R3_TARGET}#tm.k1`,
  `${R3_TARGET}#tm.k2`,
];

const R3_SEED_FILES = [
  "xspec.config.ts",
  R3_KEEP,
  R3_SPARE,
  R3_ORIGIN,
  R3_TARGET,
  JOURNAL_PATH,
] as const;

const T6_5_3 = defineProductTest({
  id: "T6.5-3",
  title:
    "re-identification and reference conversion: the moved subtree is re-identified by prefix replacement; references convert between local and imported forms; needed spec imports are added binding fresh, non-colliding identifiers and unneeded ones removed exactly (an import unreferenced before the move stays); rewritten content is byte-deterministic across two identical fixtures; the full mapping is appended to the journal; finishing regeneration as T6.4-7 (SPEC 6.5, 2.1, 6.1, 6.4, 12.1, 14.10)",
  run: async (product) => {
    const created: TestWorkspace[] = [];
    try {
      // Byte determinism (H-6, two-directory form): two identical fixtures,
      // the identical section-form move in each; run outputs and the written
      // files — rewritten sources, added/removed imports, derived files, and
      // the journal entry — must be byte-identical (SPEC 6.5, 6.1, 12.0).
      const { first, firstWorkspace } =
        await assertAcrossDirectoriesDeterministic({
          makeWorkspace: async () => {
            const workspace = await TestWorkspace.create({ files: R3_FILES });
            created.push(workspace);
            return workspace;
          },
          binding: product,
          makeRun: (workspace) => ({
            cwd: workspace.root,
            argv: [...R3_MOVE_ARGV],
          }),
          context:
            "T6.5-3 byte determinism of the section-form move (two identical " +
            "fixtures produce identical bytes; SPEC 6.5, 6.1, 12.0; H-6)",
        });
      assertExitCode(
        first,
        0,
        "T6.5-3 `move specs/Origin.mdx#org.mv specs/Target.mdx#tm`",
      );
      const workspace = firstWorkspace;

      // Conversion and import-rewrite observables (module header, H-4).
      const originText = await readSourceText(
        workspace,
        R3_ORIGIN,
        "T6.5-3 rewrite check",
      );
      assertLacks(
        originText,
        R3_ORIGIN,
        "org.mv",
        "the moved subtree left the origin and every remaining local " +
          "reference to it converts to the imported form under the new " +
          "identity (SPEC 6.5)",
        "T6.5-3 rewrite check",
      );
      assertContains(
        originText,
        R3_ORIGIN,
        "Target.xspec",
        "the origin's converted references need a binding of the target " +
          "module, so an import is added (SPEC 6.5, 2.1)",
        "T6.5-3 rewrite check",
      );
      assertLacks(
        originText,
        R3_ORIGIN,
        "Keep.xspec",
        "the origin's `Keep` binding had references (the moved node's " +
          "`d={Keep.keep}`) and the rewrite leaves it with none, so the " +
          "import is removed (SPEC 6.5, 2.1)",
        "T6.5-3 rewrite check",
      );
      const targetText = await readSourceText(
        workspace,
        R3_TARGET,
        "T6.5-3 rewrite check",
      );
      assertLacks(
        targetText,
        R3_TARGET,
        "Origin.xspec",
        "the target's `Org` binding had references and the rewrite converts " +
          "them all to local form, so the import is removed (SPEC 6.5, 2.1)",
        "T6.5-3 rewrite check",
      );
      assertLacks(
        targetText,
        R3_TARGET,
        "org.mv",
        "the moved subtree is re-identified by prefix replacement and every " +
          "reference to it is rewritten to the new identities (SPEC 6.5)",
        "T6.5-3 rewrite check",
      );
      assertContains(
        targetText,
        R3_TARGET,
        "Keep.xspec",
        "the moved node's `d={Keep.keep}` needs a `./Keep.xspec` binding the " +
          "target file lacks, so an import is added — binding a fresh " +
          "identifier, since `Keep` is already bound in the file (SPEC 6.5, " +
          "2.1, 4)",
        "T6.5-3 rewrite check",
      );
      assertContains(
        targetText,
        R3_TARGET,
        'import Keep from "./Spare.xspec"',
        "an import whose binding was already unreferenced before the move " +
          "stays, byte-verbatim — removal is exact: only a binding that had " +
          "references and lost them all is removed (SPEC 6.5, 2.1)",
        "T6.5-3 rewrite check",
      );
      // Conversion spellings 6.4's rules pin byte-wise: converted references
      // are double-quoted string literals; the kept local reference inside
      // the moved subtree keeps its double quotes, re-identified.
      assertContains(
        targetText,
        R3_TARGET,
        'd={"tm"}',
        "the target's imported reference to the moved node converts to the " +
          "local string form — a double-quoted string literal (SPEC 6.5, 6.4)",
        "T6.5-3 rewrite check",
      );
      assertContains(
        targetText,
        R3_TARGET,
        '{text("tm.k1")}',
        "the target's imported `text(...)` reference converts to the local " +
          "string form under the re-identified descendant (SPEC 6.5, 6.4)",
        "T6.5-3 rewrite check",
      );
      assertContains(
        targetText,
        R3_TARGET,
        'd={"tm.k1"}',
        "a local reference within the moved subtree stays local and is " +
          "re-identified by prefix replacement, preserving its quote style " +
          "(SPEC 6.5, 6.4)",
        "T6.5-3 rewrite check",
      );

      // The full mapping is appended to the journal — the section form
      // (SPEC 6.5: both forms; the file form is T6.5-1's assertion).
      await assertJournalHoldsOneEntry(workspace, "T6.5-3 after the move");

      // Re-identification and conversion resolve: enumeration under the new
      // identities, exact dependency-edge sets, and a clean `check`.
      await assertNodeIdentities(
        product,
        workspace,
        R3_POST_IDENTITIES,
        "the moved subtree is enumerated under the prefix-replaced " +
          "identities and every other identity is unchanged (SPEC 6.5, 1.5)",
        "T6.5-3 post-move",
      );
      assertEdgeSetEqual(
        await queryEdgesOfKind(
          product,
          workspace,
          "depends",
          "T6.5-3 post-move",
        ),
        [
          {
            from: `${R3_ORIGIN}#org.usemv`,
            to: `${R3_TARGET}#tm`,
            kind: "depends",
          },
          { from: `${R3_TARGET}#tgt`, to: `${R3_TARGET}#tm`, kind: "depends" },
          { from: `${R3_TARGET}#tm`, to: `${R3_KEEP}#keep`, kind: "depends" },
          {
            from: `${R3_TARGET}#tm.k2`,
            to: `${R3_TARGET}#tm.k1`,
            kind: "depends",
          },
        ],
        "T6.5-3: the complete `depends` edge set — every converted, added, " +
          "and re-identified reference resolves to the new identities " +
          "(SPEC 6.5, 5.2)",
      );
      assertEdgeSetEqual(
        await queryEdgesOfKind(
          product,
          workspace,
          "embeds",
          "T6.5-3 post-move",
        ),
        [
          {
            from: `${R3_ORIGIN}#org.usemv`,
            to: `${R3_TARGET}#tm.k1`,
            kind: "embeds",
          },
          {
            from: `${R3_TARGET}#tgt`,
            to: `${R3_TARGET}#tm.k1`,
            kind: "embeds",
          },
        ],
        "T6.5-3: the complete `embeds` edge set after conversion (SPEC 6.5, " +
          "5.2)",
      );
      await expectExit(
        product,
        workspace,
        ["check"],
        0,
        "T6.5-3 `check` immediately after the move — every rewritten " +
          "reference and import resolves (a non-fresh added-import " +
          "identifier would be a duplicate binding, 14.15), no dependency " +
          "or import cycles, and the finishing regeneration left no " +
          "staleness (SPEC 6.5, 12.2, 14.10)",
      );

      // Finishing regeneration as T6.4-7: fresh `build` of the post-move
      // sources, configuration, and journal; whole-tree byte compare.
      const fresh = await TestWorkspace.create();
      created.push(fresh);
      for (const rel of R3_SEED_FILES) {
        const kind = await workspace.kind(rel);
        if (kind !== "file") {
          fail(
            `T6.5-3: expected ${rel} as a plain file in the moved workspace ` +
              `to seed the fresh-build directory (SPEC 6.5, 6.1, 13.4); ` +
              `found ${kind}`,
          );
        }
        await fresh.file(rel, await workspace.readBytes(rel));
      }
      await buildOk(
        product,
        fresh,
        "T6.5-3 fresh `build` over the post-move sources",
      );
      await assertDirectoriesEqual(
        workspace.root,
        fresh.root,
        "T6.5-3: the moved workspace vs a fresh `build` of the post-move " +
          "sources — generated modules, Markdown output, and graph data " +
          "must be byte-identical (SPEC 6.5, 6.4, 12.0; H-4/H-6, " +
          "normalizing nothing)",
      );
    } finally {
      for (const workspace of created) {
        await workspace.dispose();
      }
    }
  },
});

// ---------------------------------------------------------------------------
// T6.5-4 — refusals (exit 1, nothing modified)
// ---------------------------------------------------------------------------

// One valid workspace stages every refusal cause in isolation:
// - `mv` depends locally on `keep` and is depended on by `user`, so moving
//   `mv` into B.mdx forces imports in both directions (A ↔ B): the spec
//   import cycle. Moving `mv` *under* `keep` in the same file makes it depend
//   on its own ancestor: the dependency cycle (5.3) — no imports involved.
// - `x`/`x.sub` carry no references: the collision and target-parent arms
//   refuse on exactly their stated grounds.
// - B.mdx exists (file-form destination), holds `y` (cross-file collision),
//   and has no `nope` (missing target parent).
// - The destination-path arms use the file form of the reference-free A.mdx,
//   each violating exactly one destination rule under REFUSAL_CONFIG.
const V4_A = "specs/A.mdx";
const V4_A_SOURCE = [
  '<S id="keep">',
  "Keep text.",
  "</S>",
  "",
  '<S id="mv" d={"keep"}>',
  "Moved candidate text.",
  "</S>",
  "",
  '<S id="user" d={"mv"}>',
  "User text.",
  "</S>",
  "",
  '<S id="x">',
  "X holder.",
  "",
  '<S id="x.sub">',
  "X sub text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const V4_B = "specs/B.mdx";
const V4_B_SOURCE = [
  '<S id="b">',
  "B holder text.",
  "</S>",
  "",
  '<S id="y">',
  "Y text.",
  "</S>",
  "",
].join("\n");

// The precondition arm's other file: valid at staging (so the pre-refusal
// `build` succeeds), then overwritten with an unresolved local `d` reference
// (14.5) — the pre-existing validation error elsewhere (as T6.4-6).
const V4_OTHER = "specs/Other.mdx";
const V4_OTHER_VALID = ['<S id="oth">', "Other text.", "</S>", ""].join("\n");
const V4_OTHER_INVALID = [
  '<S id="oth" d={"nope"}>',
  "Other text.",
  "</S>",
  "",
].join("\n");

// Destination path that is not valid UTF-8: `specs/<0xFF>.mdx` (Linux-leg
// staging — argv is a byte channel there; TEST-SPEC T6.5-4, T1.5-2's note).
const V4_NON_UTF8_DESTINATION: Uint8Array = Buffer.concat([
  Buffer.from("specs/", "utf8"),
  Buffer.from([0xff]),
  Buffer.from(".mdx", "utf8"),
]);

const T6_5_4 = defineProductTest({
  id: "T6.5-4",
  title:
    "refusals (exit 1, nothing modified): a move creating a spec import cycle or a dependency cycle; file form whose destination exists; section form with a 1.4-invalid `<new-id>` (forbidden name `then`; whitespace-bearing segment); the ordinary cross-file `<new-id>` collision; a missing target parent; a target parent within the moved subtree; and destination paths in no configured spec group, in a code group as well, containing `#`, not valid UTF-8 (Linux leg), or lacking `.mdx`; plus the valid-workspace precondition as T6.4-6 (SPEC 6.5, 5.3, 2.1, 1.4, 1.3, 14.14, 14.19, 12.0)",
  run: async (product) => {
    await withWorkspace(
      REFUSAL_CONFIG,
      { [V4_A]: V4_A_SOURCE, [V4_B]: V4_B_SOURCE },
      async (workspace) => {
        // Build first, so the modifies-nothing compares include intact
        // derived files (the T6.4-3 protocol).
        await buildOk(
          product,
          workspace,
          "T6.5-4 `build` over the staged workspace",
        );

        const cases: readonly (readonly [readonly string[], string])[] = [
          [
            ["move", "specs/A.mdx#mv", "specs/B.mdx#bmv"],
            "spec import cycle — the moved node's local `d` on `keep` needs " +
              "B.mdx to import A.mdx while `user`'s reference to the moved " +
              "node needs A.mdx to import B.mdx (SPEC 6.5, 2.1)",
          ],
          [
            ["move", "specs/A.mdx#mv", "specs/A.mdx#keep.mv"],
            "dependency cycle — the moved node depends on `keep` and would " +
              "become its child, a dependency on its own ancestor (SPEC 6.5, " +
              "5.3)",
          ],
          [
            ["move", "specs/A.mdx", "specs/B.mdx"],
            "file form whose destination file already exists (SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx#keep", "specs/B.mdx#then"],
            "section form whose <new-id> is invalid per 1.4 — the forbidden " +
              "name `then` (the mirrored new-ID-is-valid check, SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx#keep", "specs/B.mdx#ha lf"],
            "section form whose <new-id> is invalid per 1.4 — a " +
              "whitespace-bearing segment (SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx#x", "specs/B.mdx#y"],
            "the ordinary cross-file collision — <new-id> `y` collides with " +
              "the section `y` already present in the distinct target file " +
              "(SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx#keep", "specs/B.mdx#nope.k"],
            "section form whose target parent (`nope`, the <new-id> minus " +
              "its final segment) is missing from the target file (SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx#x", "specs/A.mdx#x.sub.q"],
            "section form whose target parent (`x.sub`) lies within the " +
              "moved subtree, leaving no insertion point after the removal " +
              "(SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx", "docs/Out.mdx"],
            "destination path belonging to no configured spec group — a " +
              "move never takes a node out of the workspace (SPEC 6.5)",
          ],
          [
            ["move", "specs/A.mdx", "specs/dual/Out.mdx"],
            "destination path belonging to a code group as well (SPEC 6.5, " +
              "14.14)",
          ],
          [
            ["move", "specs/A.mdx", "specs/Ha#sh.mdx"],
            "destination path containing `#` (SPEC 6.5, 1.5, 14.19)",
          ],
          [
            ["move", "specs/A.mdx", "specs/plain/Out.md"],
            "destination path lacking the `.mdx` extension — it matches the " +
              "`specs/plain/**` spec glob, isolating 14.19's extension rule " +
              "(SPEC 6.5, 7.1, 14.19)",
          ],
        ];
        for (const [argv, reason] of cases) {
          await expectRefusalModifiesNothing(
            product,
            workspace,
            argv,
            `T6.5-4 (${reason})`,
          );
        }

        // Not valid UTF-8, staged on the Linux leg per T6.5-4's own text:
        // Linux argv is a byte channel, so the destination is passed as raw
        // bytes (driver trampoline); other platforms cannot carry the
        // argument at all (the T1.5-2 platform note).
        if (process.platform === "linux") {
          await expectRefusalModifiesNothing(
            product,
            workspace,
            ["move", V4_A, V4_NON_UTF8_DESTINATION],
            "T6.5-4 (destination path not valid UTF-8 — Linux leg; " +
              "SPEC 6.5, 14.19)",
          );
        }
      },
    );

    // Valid-workspace precondition, as T6.4-6: with a pre-existing
    // validation error elsewhere, the move's own arguments being valid, the
    // move refuses (exit 1) before modifying anything.
    await withWorkspace(
      REFUSAL_CONFIG,
      {
        [V4_A]: V4_A_SOURCE,
        [V4_B]: V4_B_SOURCE,
        [V4_OTHER]: V4_OTHER_VALID,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.5-4 precondition arm `build` over the staged workspace",
        );
        await workspace.file(V4_OTHER, V4_OTHER_INVALID);
        await expectRefusalModifiesNothing(
          product,
          workspace,
          ["move", "specs/A.mdx#keep", "specs/B.mdx#kp"],
          "T6.5-4 (valid-workspace precondition as T6.4-6 — the workspace " +
            "fails the validations of `xspec build` through an unresolved d " +
            "reference in specs/Other.mdx, SPEC 14.5, so the move refuses " +
            "before modifying anything: no source rewrite, no journal " +
            "entry, no derived-file change; SPEC 6.5, 6.4, 12.1)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.5-5 — usage errors (exit 2)
// ---------------------------------------------------------------------------

const U5_A = "specs/A.mdx";
const U5_A_SOURCE = [
  '<S id="a">',
  "Alpha text.",
  "",
  '<S id="a.mid">',
  "Mid text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const U5_B = "specs/B.mdx";
const U5_B_SOURCE = ['<S id="b">', "Beta text.", "</S>", ""].join("\n");

// The ordering arm's unrelated validation error: an unresolved local `d`
// reference (14.5) in a file untouched by the move arguments.
const U5_BAD = "specs/Bad.mdx";
const U5_BAD_SOURCE = [
  '<S id="bad" d={"nope"}>',
  "Bad text depending on nothing that exists.",
  "</S>",
  "",
].join("\n");

// The masking arm's unparseable origin file: an unclosed section tag (14.20).
const U5_BROKEN = "specs/Broken.mdx";
const U5_BROKEN_SOURCE = [
  '<S id="broken">',
  "Text that never closes.",
  "",
].join("\n");

const U5_USAGE_CASES: readonly (readonly [readonly string[], string])[] = [
  [
    ["move", "specs/Missing.mdx", "specs/New.mdx"],
    "file form, nonexistent origin file",
  ],
  [
    ["move", "specs/Missing.mdx#a", "specs/B.mdx#z"],
    "section form, nonexistent origin file",
  ],
  [
    ["move", "specs/A.mdx#nope", "specs/B.mdx#z"],
    "section form, nonexistent origin ID",
  ],
];

const T6_5_5 = defineProductTest({
  id: "T6.5-5",
  title:
    "usage errors (exit 2): a nonexistent origin file (either form) and a nonexistent origin ID are usage errors checked before source validation — the same exit 2 even when the workspace also has unrelated validation errors (12.0 ordering, as T6.4-4) — but an origin ID inside an unparseable origin file is masked: the validation findings are reported and the command exits 1 (SPEC 6.5, 12.0, 14, 14.20)",
  run: async (product) => {
    // --- Base arm: a valid workspace ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [U5_A]: U5_A_SOURCE, [U5_B]: U5_B_SOURCE },
      async (workspace) => {
        const context = "T6.5-5 valid-workspace arm";
        await buildOk(product, workspace, `${context}: \`build\``);
        for (const [argv, label] of U5_USAGE_CASES) {
          await expectMoveUsageError(
            product,
            workspace,
            argv,
            `${context}, ${label}`,
          );
        }
      },
    );

    // --- Ordering arm: the workspace also fails build validation ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [U5_A]: U5_A_SOURCE,
        [U5_B]: U5_B_SOURCE,
        [U5_BAD]: U5_BAD_SOURCE,
      },
      async (workspace) => {
        const context = "T6.5-5 ordering arm";
        // Staging premise: the workspace really fails build validation, so
        // the exit-2/empty-stdout observations discriminate — a product that
        // validates sources before the argument existence checks exits 1
        // with these findings instead (SPEC 12.0).
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
        for (const [argv, label] of U5_USAGE_CASES) {
          await expectMoveUsageError(
            product,
            workspace,
            argv,
            `${context}, ${label}, with unrelated validation errors present ` +
              `— the existence checks precede source validation (SPEC 12.0)`,
          );
        }
      },
    );

    // --- Masking arm: the origin ID lives inside an unparseable file ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [U5_A]: U5_A_SOURCE,
        [U5_B]: U5_B_SOURCE,
        [U5_BROKEN]: U5_BROKEN_SOURCE,
      },
      async (workspace) => {
        const context = "T6.5-5 masking arm";
        const command = `move ${U5_BROKEN}#broken specs/B.mdx#bk --json`;
        const result = await expectExit(
          product,
          workspace,
          ["move", `${U5_BROKEN}#broken`, "specs/B.mdx#bk", "--json"],
          1,
          `${context}: \`${command}\` — an origin ID inside an unparseable ` +
            `origin file (14.20) is masked: the validation findings are ` +
            `reported and the command exits 1, not 2 (SPEC 6.5, 12.0, 14)`,
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
          { file: U5_BROKEN },
          `${context}: the 14.20 finding identifies the unparseable origin ` +
            `file and the location of the parse failure (SPEC 14, 14.20)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.5-6 — identity terms
// ---------------------------------------------------------------------------

// The new-identity checks read in identity terms (SPEC 6.5). Two clauses
// admit no discriminating fixture, per TEST-SPEC T6.5-6, and are documented
// rather than staged:
// - The collision clause's after-the-removal qualifier: structural IDs (1.3)
//   make the vacated set exactly the moved subtree's IDs, so a `<new-id>`
//   matching only vacated identities is always independently refused — as
//   the exact self-move, or because its target parent is missing or lies
//   within the moved subtree (T6.5-4).
// - The mirrored "all rewritten references resolve" clause, for T6.4-3's
//   reason: a move rewrites only valid workspaces and retargets every
//   affected reference to identities that exist after the operation; it is
//   exercised as the always-passing side of every successful move.
const I6_A = "specs/A.mdx";
const I6_A_SOURCE = [
  '<S id="a">',
  "Alpha text.",
  "</S>",
  "",
  '<S id="x">',
  "Ex text.",
  "</S>",
  "",
].join("\n");

const I6_B = "specs/B.mdx";
const I6_B_SOURCE = ['<S id="b">', "Bee text.", "</S>", ""].join("\n");

const T6_5_6 = defineProductTest({
  id: "T6.5-6",
  title:
    "identity terms: a cross-file section move keeping its ID (`a.mdx#x` → `b.mdx#x`, no `x` in `b.mdx`) is valid — the new identity differs in its file part; the exact self-move (`<target-file>#<new-id>` equal to `<file>#<id>`) is refused with exit 1, modifies nothing, and appends no journal entry (journal byte-compared around the attempt); a same-file move whose `<new-id>` collides with an ID remaining in the target file after the removal is refused (SPEC 6.5, 1.5, 6.1)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [I6_A]: I6_A_SOURCE, [I6_B]: I6_B_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T6.5-6 `build` over the staged workspace",
        );

        // Valid: the cross-file move keeping its ID — the new identity
        // specs/B.mdx#x differs from specs/A.mdx#x in its file part
        // (SPEC 6.5: "a cross-file section move keeping its ID is
        // therefore valid").
        await expectExit(
          product,
          workspace,
          ["move", "specs/A.mdx#x", "specs/B.mdx#x"],
          0,
          "T6.5-6 `move specs/A.mdx#x specs/B.mdx#x` — a cross-file section " +
            "move keeping its ID is valid: the identity check compares " +
            "identities, not IDs (SPEC 6.5, 1.5)",
        );
        await assertNodeIdentities(
          product,
          workspace,
          [I6_A, `${I6_A}#a`, I6_B, `${I6_B}#b`, `${I6_B}#x`],
          "the kept-ID move relocated the node: same ID, new file part " +
            "(SPEC 6.5, 1.5)",
          "T6.5-6 post-move",
        );
        await assertJournalHoldsOneEntry(
          workspace,
          "T6.5-6 after the kept-ID move",
        );

        // Refused: the exact self-move — `<target-file>#<new-id>` equal to
        // `<file>#<id>` — exit 1, modifies nothing, appends no journal
        // entry (byte-compared around the attempt).
        const journalBefore = await readJournal(
          workspace,
          "T6.5-6 before the exact self-move attempt",
        );
        await expectRefusalModifiesNothing(
          product,
          workspace,
          ["move", "specs/B.mdx#x", "specs/B.mdx#x"],
          "T6.5-6 (the exact self-move — the new identity equals the old " +
            "one, SPEC 6.5)",
        );
        assertBytesEqual(
          await readJournal(
            workspace,
            "T6.5-6 after the exact self-move attempt",
          ),
          journalBefore,
          "T6.5-6: the journal byte-compared around the refused exact " +
            "self-move — the refusal appends no journal entry (SPEC 6.5, 6.1)",
        );

        // Refused: a same-file move whose <new-id> collides with an ID
        // remaining in the target file after the removal — `b` remains in
        // B.mdx when `x`'s subtree is removed (SPEC 6.5).
        await expectRefusalModifiesNothing(
          product,
          workspace,
          ["move", "specs/B.mdx#x", "specs/B.mdx#b"],
          "T6.5-6 (same-file move whose <new-id> `b` collides with the ID " +
            "`b` remaining in the target file after the removal, SPEC 6.5)",
        );
      },
    );
  },
});

/** TEST-SPEC §6.5, in canonical ID order (SUITE-25). */
export const section65Tests: readonly ProductTestEntry[] = [
  T6_5_1,
  T6_5_2,
  T6_5_3,
  T6_5_4,
  T6_5_5,
  T6_5_6,
];
