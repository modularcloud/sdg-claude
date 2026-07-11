// TEST-SPEC §6.1 (the journal) — SUITE-21: T6.1-1…T6.1-3.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), and rejects a product only via diagnosed
// assertion failures (H-8).
//
// SPEC 6.1: the journal is a plain-text, append-only file at `.xspec/journal`
// with one entry per line, written only by `rename` and `move`; absent file =
// empty journal, and the file comes into existence with the first journaled
// operation. It is durable (13.4): never modified or deleted by other
// commands. Entries are byte-deterministic for a given operation and
// workspace state; content is otherwise opaque — assertions here stick to the
// stated observable contract (line-oriented, append-only form; H-4).
//
// Staging constraint (CERTIFICATIONS.md §CONF-CORE — T6.1-1 and T6.1-2 are
// in-scope): their fixtures stay within CONF-CORE's scope — one configured
// spec group of `.mdx` sources without imports, embeddings, `d` props, or
// tags; no `code`, `markdown`, `coverage`, or `policy` keys; no git; the only
// mutating commands driven are `rename` and file-form `move`. In this
// git-less scope `impact --base` is the exit-2 unreadable-baseline case
// (SPEC 6.3, 12.0).
//
// Conservative operationalizations (noted per H-4):
// - "One entry per line" + "the journal is written only by rename and move"
//   (SPEC 6.1) pin the line count: after N journaled operations the journal
//   holds exactly N lines. The line count tolerates both line conventions
//   (final line terminated or not); T6.1-1 asserts the count after every
//   operation, which realizes "appends exactly one line-oriented entry".
// - "Rewrites nothing above it" is asserted as: the prior journal bytes are
//   a strict byte prefix of the new journal bytes.
// - T6.1-3 "naming the line": entry content is opaque, so the harness accepts
//   any of — a location within the garbage line's byte window in
//   `.xspec/journal`, the message echoing the garbage line's text, or the
//   message citing line/entry 2 (`line 2`, `entry 2`, or a `journal:2`
//   file:line form). The garbage sits on line 2 (one legitimate entry
//   precedes it), so a finding pointing at line 1 or at the whole file
//   without naming the line fails — the discrimination the TEST-SPEC asks
//   for.

import { Buffer } from "node:buffer";
import type { Finding } from "../../helpers/adapters/index.js";
import { decodeFindingsReport } from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk, expectExit } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group, no
// other keys — the CONF-CORE workspace shape.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// Importless `.mdx` sources: no imports, embeddings, `d` props, or tags
// (CONF-CORE scope). A.mdx carries a child so `rename` exercises descendant
// rewriting; B.mdx is the file-form `move` subject.
const CORE_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": SPECS_ONLY_CONFIG,
  "specs/A.mdx": [
    '<S id="a">',
    "Alpha text.",
    '<S id="a.k">',
    "Kid text.",
    "</S>",
    "</S>",
    "",
  ].join("\n"),
  "specs/B.mdx": ['<S id="b">', "Beta text.", "</S>", ""].join("\n"),
};

const JOURNAL_PATH = ".xspec/journal";
const LF = 0x0a;

/** Stage a fresh CONF-CORE-shaped workspace, run `body`, dispose (H-1). */
async function withCoreWorkspace<T>(
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({ files: CORE_FILES });
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
 * final line (0 for an empty file) — the H-4 operationalization of "one
 * entry per line" (see the module header).
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

/**
 * Assert one journaled operation appended exactly one line-oriented entry
 * and rewrote nothing above it: the prior bytes are a strict byte prefix of
 * the new bytes, and the journal now holds exactly `operationCount` lines
 * (SPEC 6.1; T6.1-1).
 */
function assertJournalAppend(
  before: Uint8Array,
  after: Uint8Array,
  operationCount: number,
  operationLabel: string,
  context: string,
): void {
  assertBytesEqual(
    after.subarray(0, before.length),
    before,
    `${context}: ${operationLabel} must rewrite nothing above the existing ` +
      `journal content — the prior journal bytes are a byte prefix of the ` +
      `new journal (SPEC 6.1 append-only)`,
  );
  if (after.length === before.length) {
    fail(
      `${context}: ${operationLabel} must append one journal entry, but the ` +
        `journal is byte-identical (${String(after.length)} bytes)`,
    );
  }
  const lines = journalLineCount(after);
  if (lines !== operationCount) {
    fail(
      `${context}: after ${String(operationCount)} journaled operation(s) the ` +
        `journal must hold exactly ${String(operationCount)} line-oriented ` +
        `entries — one entry per line, one entry per operation (SPEC 6.1); ` +
        `found ${String(lines)} line(s) in ${String(after.length)} bytes`,
    );
  }
}

/**
 * Byte-compare the journal around one command (T6.1-1 "never modify it"):
 * read it, run the command asserting the exact exit code (H-5), read it
 * again, assert byte identity — a deleted or replaced journal fails via
 * `readJournal`'s plain-file check.
 */
async function assertLeavesJournalUnchanged(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  exitCode: number,
  context: string,
): Promise<void> {
  const command = argv.join(" ");
  const before = await readJournal(
    workspace,
    `${context}: before \`${command}\``,
  );
  await expectExit(
    product,
    workspace,
    argv,
    exitCode,
    `${context}: \`${command}\``,
  );
  const after = await readJournal(
    workspace,
    `${context}: after \`${command}\``,
  );
  assertBytesEqual(
    after,
    before,
    `${context}: \`${command}\` must never modify the journal — it is ` +
      `written only by \`rename\` and \`move\` (byte-compare around the ` +
      `command; SPEC 6.1, 13.4)`,
  );
}

// ---------------------------------------------------------------------------
// T6.1-1 — lifecycle
// ---------------------------------------------------------------------------

const T6_1_1 = defineProductTest({
  id: "T6.1-1",
  title:
    "no journal exists after `build` in a fresh workspace; the file appears at .xspec/journal with the first rename/move; each subsequent operation appends exactly one line-oriented entry and rewrites nothing above it (byte-prefix asserted); build, check, coverage, impact, review, query never modify it (byte-compare around each) (SPEC 6.1, 13.4)",
  run: async (product) => {
    await withCoreWorkspace(async (workspace) => {
      // Fresh workspace: `build` succeeds and creates no journal.
      await buildOk(
        product,
        workspace,
        "T6.1-1 `build` in the fresh workspace",
      );
      const kindAfterBuild = await workspace.kind(JOURNAL_PATH);
      if (kindAfterBuild !== "absent") {
        fail(
          `T6.1-1: no journal file exists after \`build\` in a fresh ` +
            `workspace — the journal is written only by \`rename\` and ` +
            `\`move\` and comes into existence with the first journaled ` +
            `operation (SPEC 6.1); found ${kindAfterBuild} at ${JOURNAL_PATH}`,
        );
      }

      // The file appears with the first journaled operation. An absent
      // journal is an empty journal (SPEC 6.1), so the first append is
      // checked against the empty prefix like every later one.
      await expectExit(
        product,
        workspace,
        ["rename", "specs/A.mdx", "a", "a2"],
        0,
        "T6.1-1 first journaled operation: `rename specs/A.mdx a a2`",
      );
      const afterFirst = await readJournal(
        workspace,
        "T6.1-1 after the first journaled operation",
      );
      assertJournalAppend(
        new Uint8Array(0),
        afterFirst,
        1,
        "the first journaled operation (`rename`)",
        "T6.1-1",
      );

      // Each subsequent operation appends exactly one entry: a file-form
      // move, then another rename.
      await expectExit(
        product,
        workspace,
        ["move", "specs/B.mdx", "specs/Bmoved.mdx"],
        0,
        "T6.1-1 second journaled operation: file-form `move specs/B.mdx specs/Bmoved.mdx`",
      );
      const afterSecond = await readJournal(
        workspace,
        "T6.1-1 after the second journaled operation",
      );
      assertJournalAppend(
        afterFirst,
        afterSecond,
        2,
        "the second journaled operation (file-form `move`)",
        "T6.1-1",
      );

      await expectExit(
        product,
        workspace,
        ["rename", "specs/A.mdx", "a2", "a3"],
        0,
        "T6.1-1 third journaled operation: `rename specs/A.mdx a2 a3`",
      );
      const afterThird = await readJournal(
        workspace,
        "T6.1-1 after the third journaled operation",
      );
      assertJournalAppend(
        afterSecond,
        afterThird,
        3,
        "the third journaled operation (`rename`)",
        "T6.1-1",
      );

      // `build`, `check`, `coverage`, `impact`, `review`, `query` never
      // modify the journal — byte-compare around each, with the journal
      // present and non-empty so an append or truncation is visible. Exit
      // codes (H-5): `build` 0 (the workspace is valid); `check` 0 (rename
      // and move finish by regenerating derived files exactly as `build`
      // does, SPEC 6.4/6.5, and the product-written journal is well-formed);
      // `coverage` 0 reporting zero profiles (no `coverage` key, SPEC 7.4);
      // `impact --base HEAD` 2 — the git-less workspace makes the baseline
      // unreadable, a usage error (SPEC 6.3, 12.0), and even the refused
      // invocation must leave the journal untouched; `review list` 0 (a read
      // subcommand, informational with no sessions, SPEC 12.0); `query
      // nodes` 0.
      const readArms: readonly {
        readonly argv: readonly string[];
        readonly exitCode: number;
      }[] = [
        { argv: ["build"], exitCode: 0 },
        { argv: ["check"], exitCode: 0 },
        { argv: ["coverage"], exitCode: 0 },
        { argv: ["impact", "--base", "HEAD"], exitCode: 2 },
        { argv: ["review", "list"], exitCode: 0 },
        { argv: ["query", "nodes"], exitCode: 0 },
      ];
      for (const arm of readArms) {
        await assertLeavesJournalUnchanged(
          product,
          workspace,
          arm.argv,
          arm.exitCode,
          "T6.1-1 read sweep",
        );
      }
    });
  },
});

// ---------------------------------------------------------------------------
// T6.1-2 — entry determinism
// ---------------------------------------------------------------------------

const T6_1_2 = defineProductTest({
  id: "T6.1-2",
  title:
    "the same operation on the same workspace state — two identical directories — appends byte-identical journal entries, for the creating rename and for a subsequent file-form move appending to a non-empty journal (SPEC 6.1, 12.0)",
  run: async (product) => {
    const first = await TestWorkspace.create({ files: CORE_FILES });
    const second = await TestWorkspace.create({ files: CORE_FILES });
    try {
      const directories: readonly (readonly [string, TestWorkspace])[] = [
        ["directory 1", first],
        ["directory 2", second],
      ];

      // The same rename in each of the two identical directories. The
      // created journal consists of exactly the appended entry, so comparing
      // the files compares the entries.
      for (const [label, workspace] of directories) {
        await expectExit(
          product,
          workspace,
          ["rename", "specs/A.mdx", "a", "a2"],
          0,
          `T6.1-2 \`rename specs/A.mdx a a2\` in ${label}`,
        );
      }
      assertBytesEqual(
        await readJournal(second, "T6.1-2 directory 2 after the rename"),
        await readJournal(first, "T6.1-2 directory 1 after the rename"),
        "T6.1-2 the same `rename` on the same workspace state (two identical " +
          "directories) appends byte-identical entries — the created journal " +
          "is exactly the first entry (SPEC 6.1; directories differ only in " +
          "their absolute paths, which never enter output or stored data, " +
          "SPEC 12.0)",
      );

      // Premise guard for the second comparison: the rename rewrote the
      // source byte-identically in both directories (rewritten file content
      // is byte-deterministic for a given operation and workspace state,
      // SPEC 6.1), so the second operation again runs on the same workspace
      // state.
      assertBytesEqual(
        await second.readBytes("specs/A.mdx"),
        await first.readBytes("specs/A.mdx"),
        "T6.1-2 the rename's source rewrite is byte-identical across the two " +
          "directories (SPEC 6.1) — the same-workspace-state premise for " +
          "comparing the second appended entry",
      );

      // The same file-form move in each directory appends the second entry
      // to a non-empty journal; the journals stay byte-identical, so the
      // appended entries are.
      for (const [label, workspace] of directories) {
        await expectExit(
          product,
          workspace,
          ["move", "specs/B.mdx", "specs/C.mdx"],
          0,
          `T6.1-2 file-form \`move specs/B.mdx specs/C.mdx\` in ${label}`,
        );
      }
      assertBytesEqual(
        await readJournal(second, "T6.1-2 directory 2 after the move"),
        await readJournal(first, "T6.1-2 directory 1 after the move"),
        "T6.1-2 the same `move` appended to the same journal on the same " +
          "workspace state yields byte-identical journals — the appended " +
          "entries are byte-identical (SPEC 6.1)",
      );
    } finally {
      await first.dispose();
      await second.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T6.1-3 — integrity (14.13 at `check`)
// ---------------------------------------------------------------------------

// Deliberately structureless bytes no conforming entry format accepts — the
// TEST-SPEC-sanctioned malformed-journal arm (garbage, never a duplicate or
// recombination of product-written entries, whose acceptance would be
// product-dependent; see T6.1-3's own rationale).
const GARBAGE_LINE = "?? harness-injected garbage: not a journal entry ??";

/**
 * `check --json` over a workspace staged with a journal error: exit 1 with
 * at least one condition-14.13 finding (SPEC 12.2, 14.13). Other findings are
 * tolerated — whether the journal error masks or cascades into further
 * findings is not pinned here. Returns the 14.13 findings.
 */
async function checkReportsJournalError(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<readonly Finding[]> {
  const label = `${context}: \`check --json\``;
  const result = await expectExit(
    product,
    workspace,
    ["check", "--json"],
    1,
    label,
  );
  const findings = decodeFindingsReport(
    parseJsonStdout(result, label),
    label,
  ).findings;
  const journalFindings = findings.filter(
    (finding) => finding.condition === "14.13",
  );
  if (journalFindings.length === 0) {
    fail(
      `${context}: \`check\` must report the journal error with condition ` +
        `14.13 (SPEC 12.2, 13.4, 14.13); reported conditions: ` +
        `${JSON.stringify(findings.map((finding) => finding.condition))}`,
    );
  }
  return journalFindings;
}

/**
 * Does a 14.13 finding name the garbage line (line 2)? Accepted forms (H-4
 * operationalization, see the module header): a location within the garbage
 * line's byte window in `.xspec/journal`; the message echoing the garbage
 * line; or the message citing line/entry 2.
 */
function findingNamesGarbageLine(
  finding: Finding,
  window: { readonly start: number; readonly end: number },
): boolean {
  if (finding.message.includes(GARBAGE_LINE)) return true;
  if (/\b(?:line|entry)\s*#?\s*2\b/i.test(finding.message)) return true;
  if (finding.message.includes("journal:2")) return true;
  return (
    finding.location !== undefined &&
    (finding.file === undefined || finding.file === JOURNAL_PATH) &&
    finding.location.start >= window.start &&
    finding.location.end <= window.end + 1
  );
}

const T6_1_3 = defineProductTest({
  id: "T6.1-3",
  title:
    "`check` reports a malformed journal (garbage line) with 14.13, naming the line, and reports a journal path occupied by a directory or by a symbolic link as a journal error 14.13 (SPEC 6.1, 12.2, 13.4, 14.13)",
  run: async (product) => {
    // --- Garbage line: one legitimate entry, then harness-appended garbage
    // on line 2 ---
    await withCoreWorkspace(async (workspace) => {
      const context = "T6.1-3 garbage-line arm";
      await expectExit(
        product,
        workspace,
        ["rename", "specs/A.mdx", "a", "a2"],
        0,
        `${context}: the legitimate journaled operation \`rename specs/A.mdx a a2\``,
      );
      const legitimate = await readJournal(
        workspace,
        `${context}: after the legitimate operation`,
      );
      if (journalLineCount(legitimate) !== 1) {
        fail(
          `${context}: staging premise — one journaled operation yields a ` +
            `one-line journal (SPEC 6.1), so the garbage lands on line 2; ` +
            `found ${String(journalLineCount(legitimate))} line(s)`,
        );
      }
      // Append the garbage as its own line: terminate the product's final
      // line first if it left the terminator off, so the tampering is a
      // whole-line append under either line convention.
      const needsTerminator =
        legitimate.length > 0 && legitimate[legitimate.length - 1] !== LF;
      const garbageStart = legitimate.length + (needsTerminator ? 1 : 0);
      const tampered = Buffer.concat([
        legitimate,
        Buffer.from(
          (needsTerminator ? "\n" : "") + GARBAGE_LINE + "\n",
          "utf8",
        ),
      ]);
      await workspace.file(JOURNAL_PATH, tampered);
      const window = {
        start: garbageStart,
        end: garbageStart + Buffer.byteLength(GARBAGE_LINE, "utf8"),
      };

      const journalFindings = await checkReportsJournalError(
        product,
        workspace,
        context,
      );
      if (
        !journalFindings.some((finding) =>
          findingNamesGarbageLine(finding, window),
        )
      ) {
        fail(
          `${context}: the 14.13 finding must name the malformed line — the ` +
            `garbage on line 2 (SPEC 14.13 "naming the lines"): a location ` +
            `within bytes [${String(window.start)}, ${String(window.end)}] of ` +
            `${JOURNAL_PATH}, the garbage line's text, or a line/entry-2 ` +
            `citation; got ${JSON.stringify(journalFindings)}`,
        );
      }
    });

    // --- Journal path occupied by a directory ---
    await withCoreWorkspace(async (workspace) => {
      const context = "T6.1-3 directory-occupant arm";
      await buildOk(
        product,
        workspace,
        `${context}: \`build\` before occupying the journal path`,
      );
      await workspace.dir(JOURNAL_PATH);
      await checkReportsJournalError(product, workspace, context);
    });

    // --- Journal path occupied by a symbolic link ---
    // The link resolves to an empty plain file — an empty journal is a valid
    // journal, so a product that follows the link instead of treating the
    // occupied path as a journal error (13.4: never read through it) sees
    // nothing wrong and fails this arm.
    await withCoreWorkspace(async (workspace) => {
      const context = "T6.1-3 symlink-occupant arm";
      await buildOk(
        product,
        workspace,
        `${context}: \`build\` before occupying the journal path`,
      );
      await workspace.file(".xspec/journal-target", "");
      await workspace.symlink(JOURNAL_PATH, "journal-target");
      await checkReportsJournalError(product, workspace, context);
    });
  },
});

/** TEST-SPEC §6.1, in canonical ID order (SUITE-21). */
export const section61Tests: readonly ProductTestEntry[] = [
  T6_1_1,
  T6_1_2,
  T6_1_3,
];
