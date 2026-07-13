// TEST-SPEC §10.1 (review sessions) — SUITE-33: T10.1-1…T10.1-4.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), and rejects a product only via diagnosed
// assertion failures (H-8).
//
// SPEC 10.1: a session lives at `.xspec/reviews/<name>.json` as a plain,
// deterministic file; names are one or more of `A–Z a–z 0–9 . _ -`, never
// beginning with `.`; names are case-sensitive everywhere except `create`'s
// ASCII-case-insensitive existing-name refusal; only a file directly under
// `.xspec/reviews/` named `<valid-name>.json` is a session — anything else
// there is ignored by every command; a session file that is not a plain file,
// cannot be parsed, or violates a session invariant is corrupt (14.21).
//
// Conservative operationalizations (noted per H-3/H-4):
// - "writes exactly `.xspec/reviews/<name>.json` and nothing else" is a
//   whole-workspace byte-state diff around `create` (H-4): the only tolerated
//   additions besides the session file are its parent directory entries
//   (`.xspec`, `.xspec/reviews`), which must exist for the file to. On the
//   stale-workspace arm the tolerated set widens to entries under `.xspec/`
//   outside `.xspec/reviews/` — the 13.3 graph-data refresh, whose content is
//   opaque (H-4) — while everything outside `.xspec/` (generated TypeScript
//   and Markdown included) and every other session must stay byte-identical.
// - "reports the corruption" (T10.1-4): 12.0 classes `review` subcommands
//   naming a corrupt session as exit-1 findings, and findings are reports —
//   standard-output content; SPEC.md's fixed vocabulary for the state is
//   "corrupt" (10.1, 10.7, 14.21). Operationalized as exit 1 with stdout
//   matching /corrupt/i (information presence, never exact wording, H-3).
// - "modifies nothing" is a whole-workspace snapshot compare around each
//   command (H-4); the compares run with fresh graph data, so no 13.3
//   refresh legitimately intervenes.
// - The directory/symlink occupant states name a placeholder item id in
//   `show`/`resolve`/`split`: 10.1 is categorical — every `review` subcommand
//   naming a corrupt session reports the corruption and exits 1 — and an
//   unreadable session has no item list to resolve an id against.
// - Single-casing probes (`status Foo` against only `foo` on disk; `status
//   NAME` against only `NAME.JSON`) stage exactly one casing, so the
//   Windows-leg rerun (E-6; implemented by CI-01 in test/windows/) meets a
//   case-insensitive filesystem with the discriminating state intact.
//
// T10.1-4 staging is blackbox (H-3): every shape-dependent corrupt fixture
// starts from a session file the product itself wrote and is corrupted
// through the adapter layer's shape-aware, value-blind transformations
// (helpers/adapters/session-staging.ts); only shape-independent states —
// unparseable bytes, truncation, a directory or symlink at the path — are
// staged directly. The harness never writes a session file from an assumed
// layout. The malformed-creation-parameters state uses a `coverage` session:
// it records the profile's resolved definition, where an `audit` session
// records none (SPEC 10.7), so there is a recorded value to garble.

import {
  assertReportMentions,
  decodeFindingsReport,
  decodeSessionListReport,
  decodeSessionStatusReport,
  stageBlockedByAbsentItem,
  stageBlockedByCycle,
  stageDeleteItemField,
  stageDuplicateItemEntry,
  stageGarbleCreationParameters,
  stageUnknownItemStatus,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  assertLeavesUnchanged,
  diffSnapshots,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertSameJson,
  buildOk,
  expectExit,
  runCli,
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

// The same spec group plus one coverage profile (SPEC 7.4) for the
// coverage-session arm of T10.1-4: `main`'s one leaf has no incoming
// dependency edge, so the profile leaves it uncovered and `create --coverage`
// derives at least one item while recording the profile definition.
const COVERAGE_CONFIG = `import { defineConfig } from "xspec"

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

const A_MDX = [
  '<S id="a">',
  "Alpha text.",
  '<S id="a.k">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
].join("\n");

// The staleness edit for T10.1-1: same structure, different leaf text — the
// graph data written by the earlier `build` no longer matches the sources.
const A_MDX_EDITED = A_MDX.replace("Kid text.", "Kid text, edited.");

const CORE_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": SPECS_ONLY_CONFIG,
  "specs/A.mdx": A_MDX,
};

const COVERAGE_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": COVERAGE_CONFIG,
  "specs/A.mdx": A_MDX,
};

const REVIEWS_DIR = ".xspec/reviews";

/** The session file's workspace-relative path (SPEC 10.1). */
function sessionRel(name: string): string {
  return `${REVIEWS_DIR}/${name}.json`;
}

/** Stage a fresh workspace, run `body`, dispose (H-1). */
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

/**
 * Read a session file's exact bytes, failing diagnosed (H-8) when the path
 * does not hold a plain file (SPEC 10.1, 13.4: a session is a plain file).
 */
async function readSessionBytes(
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<Uint8Array> {
  const rel = sessionRel(name);
  const kind = await workspace.kind(rel);
  if (kind !== "file") {
    fail(
      `${context}: expected the session as a plain file at ${rel} ` +
        `(SPEC 10.1, 13.4); found ${kind}`,
    );
  }
  return await workspace.readBytes(rel);
}

/**
 * Assert the session file is plain and parseable as exactly one JSON document
 * (SPEC 10.1) — the whole file is one `JSON.parse` input, so concatenated
 * documents or trailing garbage fail.
 */
async function assertSessionIsOneJsonDocument(
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<void> {
  const bytes = await readSessionBytes(workspace, name, context);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(
      `${context}: the session file at ${sessionRel(name)} is not valid ` +
        `UTF-8, so it is not parseable as a single JSON document (SPEC 10.1)`,
    );
  }
  try {
    JSON.parse(text);
  } catch (error) {
    fail(
      `${context}: the session file at ${sessionRel(name)} must be ` +
        `parseable as a single JSON document (SPEC 10.1): ` +
        `${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// T10.1-1 — storage
// ---------------------------------------------------------------------------

const T10_1_1 = defineProductTest({
  id: "T10.1-1",
  title:
    "`review create` on a freshly built workspace writes exactly `.xspec/reviews/<name>.json` and nothing else (whole-workspace byte-state diff); on a stale workspace it additionally performs the 13.3 graph-data refresh — writes confined to `.xspec/` outside `.xspec/reviews/`, no TypeScript or Markdown regenerated; the file is plain, parseable as one JSON document, and deterministic across two identical fixtures (SPEC 10.1, 13.3, 13.4)",
  run: async (product) => {
    await withWorkspace(CORE_FILES, async (workspace) => {
      await buildOk(product, workspace, "T10.1-1 `build`");

      // Fresh arm: the diff around `create` holds the session file and, at
      // most, its parent directory entries — nothing else (SPEC 10.1; the
      // workspace is freshly built, so no 13.3 refresh applies).
      const sessionKey = sessionRel("r1");
      const preFresh = await snapshotDirectory(workspace.root);
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "r1"],
        0,
        "T10.1-1 `review create --strategy audit --name r1` on the freshly built workspace",
      );
      const postFresh = await snapshotDirectory(workspace.root);
      const freshChanges = diffSnapshots(preFresh, postFresh);
      const allowedAdditions = new Set([".xspec", REVIEWS_DIR, sessionKey]);
      for (const change of freshChanges) {
        if (change.change !== "added" || !allowedAdditions.has(change.key)) {
          fail(
            `T10.1-1: on a freshly built workspace \`review create\` writes ` +
              `exactly ${sessionKey} and nothing else — its parent directory ` +
              `entries are the only tolerated additions (SPEC 10.1; H-4 ` +
              `byte-state diff); found ${change.change} ${change.path}: ` +
              change.detail,
          );
        }
      }
      if (!freshChanges.some((change) => change.key === sessionKey)) {
        fail(
          `T10.1-1: \`review create --name r1\` exited 0 but created no ` +
            `entry at ${sessionKey} (SPEC 10.1: a session is stored at ` +
            `.xspec/reviews/<session-name>.json)`,
        );
      }
      await assertSessionIsOneJsonDocument(
        workspace,
        "r1",
        "T10.1-1 the created session file",
      );

      // Stale arm: edit a source so the graph data no longer matches, then
      // create again. The additional writes are the 13.3 graph-data refresh —
      // confined to `.xspec/` outside `.xspec/reviews/` (graph-data content
      // is opaque, H-4): no TypeScript or Markdown is generated or removed
      // (everything outside `.xspec/` stays byte-identical) and the existing
      // session r1 is untouched.
      await workspace.file("specs/A.mdx", A_MDX_EDITED);
      const session2Key = sessionRel("r2");
      const preStale = await snapshotDirectory(workspace.root);
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "r2"],
        0,
        "T10.1-1 `review create --strategy audit --name r2` on the stale workspace",
      );
      const postStale = await snapshotDirectory(workspace.root);
      const staleChanges = diffSnapshots(preStale, postStale);
      let session2Added = false;
      for (const change of staleChanges) {
        if (change.key === session2Key) {
          if (change.change !== "added") {
            fail(
              `T10.1-1 stale arm: expected ${session2Key} to be added, ` +
                `found ${change.change}: ${change.detail}`,
            );
          }
          session2Added = true;
          continue;
        }
        const underXspec =
          change.key === ".xspec" || change.key.startsWith(".xspec/");
        const underReviews =
          change.key === REVIEWS_DIR ||
          change.key.startsWith(`${REVIEWS_DIR}/`);
        if (!underXspec || underReviews) {
          fail(
            `T10.1-1 stale arm: \`review create\` on a stale workspace ` +
              `writes the session file plus the 13.3 graph-data refresh — ` +
              `refresh writes are confined to .xspec/ outside ` +
              `.xspec/reviews/: no TypeScript or Markdown is generated or ` +
              `removed and no other session is touched (SPEC 10.1, 13.3); ` +
              `found ${change.change} ${change.path}: ${change.detail}`,
          );
        }
      }
      if (!session2Added) {
        fail(
          `T10.1-1 stale arm: \`review create --name r2\` exited 0 but ` +
            `created no entry at ${session2Key} (SPEC 10.1)`,
        );
      }
      await assertSessionIsOneJsonDocument(
        workspace,
        "r2",
        "T10.1-1 the second session file (stale-workspace arm)",
      );
    });

    // Determinism arm (H-6, two-directory form): two identical fixtures,
    // identically built and created — the session files are byte-identical
    // (SPEC 10.1 "plain, deterministic"; 12.0: no wall clock, no randomness,
    // no absolute paths in stored data).
    const first = await TestWorkspace.create({ files: CORE_FILES });
    const second = await TestWorkspace.create({ files: CORE_FILES });
    try {
      const directories: readonly (readonly [string, TestWorkspace])[] = [
        ["directory 1", first],
        ["directory 2", second],
      ];
      for (const [label, workspace] of directories) {
        await buildOk(
          product,
          workspace,
          `T10.1-1 determinism arm \`build\` in ${label}`,
        );
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "r1"],
          0,
          `T10.1-1 determinism arm \`review create --strategy audit --name r1\` in ${label}`,
        );
      }
      assertBytesEqual(
        await readSessionBytes(
          second,
          "r1",
          "T10.1-1 determinism arm, directory 2",
        ),
        await readSessionBytes(
          first,
          "r1",
          "T10.1-1 determinism arm, directory 1",
        ),
        "T10.1-1: two identical fixtures yield byte-identical session files " +
          "(SPEC 10.1 deterministic; H-6 two-directory protocol — the " +
          "directories differ only in their absolute paths, which never " +
          "enter stored data, SPEC 12.0)",
      );
    } finally {
      await first.dispose();
      await second.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T10.1-2 — names
// ---------------------------------------------------------------------------

const T10_1_2 = defineProductTest({
  id: "T10.1-2",
  title:
    "session names: the full `A–Z a–z 0–9 . _ -` alphabet is accepted; `/`, whitespace, empty, leading `.`, and non-ASCII names are usage errors (exit 2, nothing created); names are case-sensitive for every subcommand (`status Foo` does not find `foo` — single-casing probe, rerun on the Windows leg via CI-01) while `create` refuses a name matching an existing session ignoring ASCII case (exit 1, nothing created) (SPEC 10.1, 10.7, 12.0)",
  run: async (product) => {
    await withWorkspace(CORE_FILES, async (workspace) => {
      await buildOk(product, workspace, "T10.1-2 `build`");

      // Invalid names: usage error, exit 2, nothing created (SPEC 10.1,
      // 12.0). Byte-state compare around each attempt realizes "nothing
      // created"; with --json, exit 2 emits no JSON document (H-5).
      const invalidNames: readonly (readonly [string, string])[] = [
        ["a/b", "a path separator"],
        ["a b", "whitespace"],
        ["", "the empty name"],
        [".a", "a leading `.`"],
        ["é", "a non-ASCII character (U+00E9)"],
      ];
      for (const [name, why] of invalidNames) {
        const context = `T10.1-2 \`review create --strategy audit --name ${JSON.stringify(name)} --json\` (invalid name: ${why})`;
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const result = await expectExit(
              product,
              workspace,
              [
                "review",
                "create",
                "--strategy",
                "audit",
                "--name",
                name,
                "--json",
              ],
              2,
              `${context} — an invalid session name is a usage error (SPEC 10.1, 12.0)`,
            );
            assertStdoutEmpty(
              result,
              `${context} — under --json, stdout is byte-empty on exit 2 (SPEC 12.0, H-5)`,
            );
          },
          `${context} — nothing created`,
        );
      }

      // Valid names: one name drawing on all four character classes (and
      // interior `.`), one bare digit. Each create succeeds and stores the
      // session at .xspec/reviews/<name>.json as a plain file.
      for (const name of ["Az09._-", "0"]) {
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", name],
          0,
          `T10.1-2 \`review create --strategy audit --name ${name}\` (valid name)`,
        );
        const kind = await workspace.kind(sessionRel(name));
        if (kind !== "file") {
          fail(
            `T10.1-2: after \`create --name ${name}\`, expected a plain ` +
              `session file at ${sessionRel(name)} (SPEC 10.1); found ${kind}`,
          );
        }
      }

      // Case rules. Single-casing probe: only `foo` ever exists on disk in
      // this workspace (the refused creates below create nothing), so the
      // Windows-leg rerun (E-6, CI-01) meets a case-insensitive filesystem
      // with exactly one casing present — exposing a product that matches
      // session names via filesystem lookup.
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "foo"],
        0,
        "T10.1-2 `review create --strategy audit --name foo`",
      );
      await expectExit(
        product,
        workspace,
        ["review", "status", "foo"],
        0,
        "T10.1-2 control: `review status foo` finds the session under its exact name (SPEC 10.1)",
      );
      const probeContext =
        "T10.1-2 `review status Foo --json` — names are case-sensitive for " +
        "all subcommands, so `Foo` names no session: an unknown session is " +
        "a usage error (SPEC 10.1, 12.0; single-casing probe, rerun on the " +
        "Windows leg per E-6/CI-01)";
      const probe = await expectExit(
        product,
        workspace,
        ["review", "status", "Foo", "--json"],
        2,
        probeContext,
      );
      assertStdoutEmpty(
        probe,
        `${probeContext} — under --json, stdout is byte-empty on exit 2 (H-5)`,
      );

      // `create` alone folds ASCII case when checking for an existing
      // session: `FOO` matches `foo`, is treated as an existing session, and
      // is refused — exit 1 (a refused operation, SPEC 10.7, 12.0), nothing
      // created, `foo`'s file byte-identical.
      await assertLeavesUnchanged(
        workspace.root,
        async () => {
          await expectExit(
            product,
            workspace,
            ["review", "create", "--strategy", "audit", "--name", "FOO"],
            1,
            "T10.1-2 `review create --strategy audit --name FOO` — a name " +
              "matching existing `foo` ignoring ASCII case is treated as an " +
              "existing session and refused: exit 1 (SPEC 10.1, 10.7, 12.0)",
          );
        },
        "T10.1-2 the refused `create --name FOO` modifies nothing — no " +
          "FOO.json appears and foo.json stays byte-identical (SPEC 10.1)",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T10.1-3 — non-session files
// ---------------------------------------------------------------------------

// Deliberately unparseable content for every staged non-session file: a
// product that wrongly treats one as a session would classify it corrupt —
// caught by the list/check assertions below.
const NON_SESSION_GARBAGE = "not a session { this is deliberately not JSON [\n";

const T10_1_3 = defineProductTest({
  id: "T10.1-3",
  title:
    'non-session files under `.xspec/reviews/` — a stray `notes.txt`, a subdirectory (with a nested .json), invalid-stem `.foo.json` and `a b.json`, and wrong-case `NAME.JSON` — are ignored by `list` (neither sessions nor corrupt, exit 0), `check` (no 14.21), and every subcommand; naming them finds no session: `status .foo`/`status "a b"` exit 2 invalid name, `status NAME` exit 2 unknown session (single-casing probe, rerun on the Windows leg via CI-01) (SPEC 10.1, 12.0, 14.21)',
  run: async (product) => {
    await withWorkspace(CORE_FILES, async (workspace) => {
      await buildOk(product, workspace, "T10.1-3 `build`");
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "real"],
        0,
        "T10.1-3 `review create --strategy audit --name real`",
      );

      // Stage the non-session entries beside the real session. NAME.JSON is
      // staged in a single casing — no NAME.json exists anywhere (E-6).
      await workspace.file(`${REVIEWS_DIR}/notes.txt`, NON_SESSION_GARBAGE);
      await workspace.dir(`${REVIEWS_DIR}/sub`);
      await workspace.file(
        `${REVIEWS_DIR}/sub/inner.json`,
        NON_SESSION_GARBAGE,
      );
      await workspace.file(`${REVIEWS_DIR}/.foo.json`, NON_SESSION_GARBAGE);
      await workspace.file(`${REVIEWS_DIR}/a b.json`, NON_SESSION_GARBAGE);
      await workspace.file(`${REVIEWS_DIR}/NAME.JSON`, NON_SESSION_GARBAGE);

      // `list`: exactly the one real session — the strays are reported
      // neither as sessions nor as corrupt — and exit 0, since exit 1 is
      // reserved for an existing corrupt session (SPEC 10.1, 10.7).
      const listLabel = "T10.1-3 `review list --json`";
      const listResult = await expectExit(
        product,
        workspace,
        ["review", "list", "--json"],
        0,
        `${listLabel} — no session is corrupt (non-session files are ignored), so \`list\` exits 0 (SPEC 10.1, 10.7)`,
      );
      const list = decodeSessionListReport(
        parseJsonStdout(listResult, listLabel),
        listLabel,
      );
      assertSameJson(
        list.sessions.map(({ name, corrupt }) => ({ name, corrupt })),
        [{ name: "real", corrupt: false }],
        `${listLabel}: exactly the one real session — the stray file, ` +
          `subdirectory, nested .json, invalid-stem .json files, and ` +
          `wrong-case NAME.JSON are neither sessions nor corrupt (SPEC 10.1)`,
      );

      // `check`: no 14.21 — the workspace is freshly built and otherwise
      // clean, so with every stray correctly ignored `check` has no finding
      // at all and exits 0 (SPEC 10.1, 12.2, 14.21).
      await expectExit(
        product,
        workspace,
        ["check", "--json"],
        0,
        "T10.1-3 `check --json` — non-session files under .xspec/reviews/ " +
          "are no 14.21 finding (SPEC 10.1, 14.21); the workspace is " +
          "otherwise clean, so `check` exits 0",
      );

      // Naming the non-sessions finds no session (SPEC 10.1, 12.0): invalid
      // names are usage errors before any lookup; `NAME` is a valid name but
      // names no session, since NAME.JSON's extension differs byte-wise.
      const namingProbes: readonly (readonly [string, string])[] = [
        [".foo", "exit 2 invalid session name (leading `.`)"],
        ["a b", "exit 2 invalid session name (whitespace)"],
        [
          "NAME",
          "exit 2 unknown session — NAME.JSON is not a session, paths " +
            "compare byte-wise (SPEC 12.0; single-casing probe, rerun on " +
            "the Windows leg per E-6/CI-01)",
        ],
      ];
      for (const [name, why] of namingProbes) {
        const context = `T10.1-3 \`review status ${JSON.stringify(name)} --json\` — ${why}`;
        const result = await expectExit(
          product,
          workspace,
          ["review", "status", name, "--json"],
          2,
          context,
        );
        assertStdoutEmpty(
          result,
          `${context} — under --json, stdout is byte-empty on exit 2 (H-5)`,
        );
      }

      // Ignored by every subcommand: the real session is served unaffected,
      // and a session named after the stray's stem is creatable — notes.txt
      // is not a session, so the name `notes` is free (SPEC 10.1).
      await expectExit(
        product,
        workspace,
        ["review", "status", "real"],
        0,
        "T10.1-3 `review status real` — the real session is served unaffected by the strays",
      );
      await expectExit(
        product,
        workspace,
        ["review", "export", "real"],
        0,
        "T10.1-3 `review export real` — unaffected by the strays",
      );
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "notes"],
        0,
        "T10.1-3 `review create --strategy audit --name notes` — " +
          "notes.txt is not a session, so the name is free (SPEC 10.1)",
      );
      const list2Label = "T10.1-3 `review list --json` after creating `notes`";
      const list2Result = await expectExit(
        product,
        workspace,
        ["review", "list", "--json"],
        0,
        list2Label,
      );
      const list2 = decodeSessionListReport(
        parseJsonStdout(list2Result, list2Label),
        list2Label,
      );
      assertSameJson(
        list2.sessions.map(({ name, corrupt }) => ({ name, corrupt })),
        [
          { name: "notes", corrupt: false },
          { name: "real", corrupt: false },
        ],
        `${list2Label}: both real sessions in byte order of name, strays still ignored (SPEC 10.1, 10.7)`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T10.1-4 — corruption
// ---------------------------------------------------------------------------

// Item id passed to `show`/`resolve`/`split` for the occupant states, whose
// session cannot be read at all: 10.1's contract is categorical (corruption
// is reported whatever item the arguments name), so any plausible id serves.
const PLACEHOLDER_ITEM_ID = "item-1";

/** The corrupt session's name in every T10.1-4 staging. */
const CORRUPT_NAME = "cor";

/**
 * Build, create the session via the given argv, and capture one item id from
 * `status --json` before the file is corrupted (the pre-corruption read of a
 * product-written session).
 */
async function stageProductSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  createArgv: readonly string[],
  context: string,
): Promise<string> {
  await buildOk(product, workspace, `${context} \`build\``);
  await expectExit(
    product,
    workspace,
    createArgv,
    0,
    `${context} \`${createArgv.join(" ")}\``,
  );
  const label = `${context} \`review status ${CORRUPT_NAME} --json\` (pre-corruption item-id capture)`;
  const status = decodeSessionStatusReport(
    await runJson(
      product,
      workspace,
      ["review", "status", CORRUPT_NAME, "--json"],
      label,
    ),
    label,
  );
  if (status.items.length === 0) {
    fail(
      `${label}: staging premise — the created session must hold at least ` +
        `one item for the corruption transformations and the item-naming ` +
        `subcommands (SPEC 10.5–10.7); got none`,
    );
  }
  return status.items[0].id;
}

/** What `review list` must report for a staged corrupt state. */
interface ExpectedSessionEntry {
  readonly name: string;
  readonly corrupt: boolean;
}

/**
 * The full T10.1-4 contract for one staged corrupt state: every `review`
 * subcommand naming the session reports the corruption (exit 1, /corrupt/i
 * on stdout — see the module header) and modifies nothing (whole-workspace
 * snapshot compare); `list` reports the session corrupt in place of its
 * fields and exits 1; `check` reports condition 14.21.
 */
async function assertCorruptSessionContract(
  product: ProductBinding,
  workspace: TestWorkspace,
  state: string,
  itemId: string,
  expectedSessions: readonly ExpectedSessionEntry[],
): Promise<void> {
  const namingSubcommands: readonly (readonly string[])[] = [
    ["review", "status", CORRUPT_NAME],
    ["review", "next", CORRUPT_NAME],
    ["review", "show", CORRUPT_NAME, itemId],
    ["review", "export", CORRUPT_NAME],
    ["review", "resolve", CORRUPT_NAME, itemId, "--status", "updated"],
    ["review", "split", CORRUPT_NAME, itemId],
  ];
  for (const argv of namingSubcommands) {
    const context = `T10.1-4 [${state}] \`${argv.join(" ")}\``;
    await assertLeavesUnchanged(
      workspace.root,
      async () => {
        const result = await runCli(product, workspace, argv);
        assertExitCode(
          result,
          1,
          `${context} — every review subcommand naming a corrupt session ` +
            `reports the corruption and exits 1 (SPEC 10.1, 14.21; ` +
            `findings-class outcome, 12.0)`,
        );
        assertReportMentions(
          result,
          [/corrupt/i],
          `${context} — the report identifies the session as corrupt ` +
            `(SPEC 10.1/14.21 vocabulary; findings are standard-output ` +
            `content, 12.0; information presence, never exact wording, H-3)`,
        );
      },
      `${context} — a review subcommand naming a corrupt session modifies nothing (SPEC 10.1)`,
    );
  }

  const listContext = `T10.1-4 [${state}] \`review list --json\``;
  await assertLeavesUnchanged(
    workspace.root,
    async () => {
      const result = await runCli(product, workspace, [
        "review",
        "list",
        "--json",
      ]);
      assertExitCode(
        result,
        1,
        `${listContext} — \`list\` exits 1 when any corrupt session exists (SPEC 10.7, 14.21)`,
      );
      const report = decodeSessionListReport(
        parseJsonStdout(result, listContext),
        listContext,
      );
      assertSameJson(
        report.sessions.map(({ name, corrupt }) => ({ name, corrupt })),
        expectedSessions,
        `${listContext} — the corrupt session is reported by name as ` +
          `corrupt in place of its fields, sessions in byte order of name ` +
          `(SPEC 10.1, 10.7; the adapter refuses fields on a corrupt entry)`,
      );
    },
    `${listContext} — a read leaves the workspace unchanged (SPEC 10.4, 13.5)`,
  );

  const checkContext = `T10.1-4 [${state}] \`check --json\``;
  await assertLeavesUnchanged(
    workspace.root,
    async () => {
      const result = await runCli(product, workspace, ["check", "--json"]);
      assertExitCode(
        result,
        1,
        `${checkContext} — a corrupt review session is a check finding (SPEC 12.2, 14.21)`,
      );
      const findings = decodeFindingsReport(
        parseJsonStdout(result, checkContext),
        checkContext,
      ).findings;
      if (!findings.some((finding) => finding.condition === "14.21")) {
        fail(
          `${checkContext}: \`check\` must report the corrupt session with ` +
            `condition 14.21 (SPEC 12.2, 14.21); reported conditions: ` +
            JSON.stringify(findings.map((finding) => finding.condition)),
        );
      }
    },
    `${checkContext} — \`check\` never writes (SPEC 12.2, 13.3)`,
  );
}

// The shape-dependent corrupt states, each staged through the H-3 adapter
// layer over a session file the product itself wrote (session-staging.ts).
const ADAPTER_STATES: readonly (readonly [
  string,
  (sessionAbsPath: string) => Promise<void>,
])[] = [
  [
    "missing 10.2 field",
    // The stored item field deleted here is the status; "status" mirrors the
    // adapter's SESSION_SHAPE key and the deletion fails loudly if the
    // product's stored shape differs (H-3).
    (abs) => stageDeleteItemField(abs, "status"),
  ],
  ["unknown status", (abs) => stageUnknownItemStatus(abs)],
  ["duplicate item ids", (abs) => stageDuplicateItemEntry(abs)],
  [
    "two items with same kind and scope node",
    (abs) => stageDuplicateItemEntry(abs, { distinctId: true }),
  ],
  ["blockedBy naming an absent item", (abs) => stageBlockedByAbsentItem(abs)],
  ["blockedBy cycle", (abs) => stageBlockedByCycle(abs)],
];

const T10_1_4 = defineProductTest({
  id: "T10.1-4",
  title:
    "each corrupt session state — unparseable bytes (garbage and truncation), missing 10.2 field, unknown status, duplicate item ids, blockedBy at an absent item, a blockedBy cycle, duplicate kind+scope, malformed recorded creation parameters, and a directory or symlink at the session path — makes every review subcommand naming the session report corruption, exit 1, and modify nothing; `list` reports it corrupt in place of its fields (exit 1); `check` reports 14.21; shape-dependent states are staged via the H-3 adapter over product-written files (SPEC 10.1, 10.7, 13.4, 14.21)",
  timeoutMs: 360_000,
  run: async (product) => {
    // --- Shape-dependent states via the adapter, over an audit session ---
    for (const [state, corrupt] of ADAPTER_STATES) {
      await withWorkspace(CORE_FILES, async (workspace) => {
        const itemId = await stageProductSession(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", CORRUPT_NAME],
          `T10.1-4 [${state}]`,
        );
        await corrupt(workspace.path(sessionRel(CORRUPT_NAME)));
        await assertCorruptSessionContract(product, workspace, state, itemId, [
          { name: CORRUPT_NAME, corrupt: true },
        ]);
      });
    }

    // --- Malformed recorded creation parameters ---
    // A coverage session records the profile's resolved definition (an audit
    // session records none, SPEC 10.7), so there is a recorded value for the
    // value-blind adapter transformation to garble.
    await withWorkspace(COVERAGE_FILES, async (workspace) => {
      const state = "malformed recorded creation parameters";
      const itemId = await stageProductSession(
        product,
        workspace,
        ["review", "create", "--coverage", "p", "--name", CORRUPT_NAME],
        `T10.1-4 [${state}]`,
      );
      await stageGarbleCreationParameters(
        workspace.path(sessionRel(CORRUPT_NAME)),
      );
      await assertCorruptSessionContract(product, workspace, state, itemId, [
        { name: CORRUPT_NAME, corrupt: true },
      ]);
    });

    // --- Unparseable JSON: garbage bytes (shape-independent, staged
    // directly — no assumed session layout is involved) ---
    await withWorkspace(CORE_FILES, async (workspace) => {
      const state = "unparseable JSON (garbage bytes)";
      await buildOk(product, workspace, `T10.1-4 [${state}] \`build\``);
      await workspace.file(
        sessionRel(CORRUPT_NAME),
        "this is deliberately not a JSON document ][}{\n",
      );
      await assertCorruptSessionContract(
        product,
        workspace,
        state,
        PLACEHOLDER_ITEM_ID,
        [{ name: CORRUPT_NAME, corrupt: true }],
      );
    });

    // --- Unparseable JSON: truncation of the product-written file ---
    await withWorkspace(CORE_FILES, async (workspace) => {
      const state = "unparseable JSON (truncated product-written file)";
      const itemId = await stageProductSession(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", CORRUPT_NAME],
        `T10.1-4 [${state}]`,
      );
      const bytes = await readSessionBytes(
        workspace,
        CORRUPT_NAME,
        `T10.1-4 [${state}] the product-written session file`,
      );
      const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
      // Staging premise: the front half of the product's single JSON
      // document must itself not parse as one (a JSON object loses its
      // closing brace); verify rather than assume.
      let stillParses = false;
      try {
        JSON.parse(new TextDecoder("utf-8").decode(truncated));
        stillParses = true;
      } catch {
        // Expected: the truncation is unparseable.
      }
      if (truncated.length === 0 || stillParses) {
        fail(
          `T10.1-4 [${state}]: staging premise — truncating the ` +
            `product-written session file (${String(bytes.length)} bytes) to ` +
            `its front half must yield a non-empty, unparseable document; ` +
            `adjust the staging if the product's stored form legitimately ` +
            `defeats this (H-3)`,
        );
      }
      await workspace.file(sessionRel(CORRUPT_NAME), truncated);
      await assertCorruptSessionContract(product, workspace, state, itemId, [
        { name: CORRUPT_NAME, corrupt: true },
      ]);
    });

    // --- Session path occupied by a directory (SPEC 13.4: a durable file's
    // path occupied by anything other than a plain file is corrupt) ---
    await withWorkspace(CORE_FILES, async (workspace) => {
      const state = "session path occupied by a directory";
      await buildOk(product, workspace, `T10.1-4 [${state}] \`build\``);
      await workspace.dir(sessionRel(CORRUPT_NAME));
      await assertCorruptSessionContract(
        product,
        workspace,
        state,
        PLACEHOLDER_ITEM_ID,
        [{ name: CORRUPT_NAME, corrupt: true }],
      );
    });

    // --- Session path occupied by a symbolic link ---
    // The link's target is a *valid* session file (the real session beside
    // it), so a product that follows the link instead of treating the
    // occupied path as corrupt (13.4: never read through it) sees a
    // perfectly healthy session and fails every arm.
    await withWorkspace(CORE_FILES, async (workspace) => {
      const state = "session path occupied by a symbolic link";
      await buildOk(product, workspace, `T10.1-4 [${state}] \`build\``);
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "real"],
        0,
        `T10.1-4 [${state}] \`review create --strategy audit --name real\` (the link's valid target)`,
      );
      await workspace.symlink(sessionRel(CORRUPT_NAME), "real.json");
      await assertCorruptSessionContract(
        product,
        workspace,
        state,
        PLACEHOLDER_ITEM_ID,
        [
          { name: CORRUPT_NAME, corrupt: true },
          { name: "real", corrupt: false },
        ],
      );
    });
  },
});

/** TEST-SPEC §10.1, in canonical ID order (SUITE-33). */
export const section101Tests: readonly ProductTestEntry[] = [
  T10_1_1,
  T10_1_2,
  T10_1_3,
  T10_1_4,
];
