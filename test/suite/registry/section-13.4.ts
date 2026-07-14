// TEST-SPEC §13.4 (derived and durable files) — SUITE-47: T13.4-1 (plain
// committable files + sorted keys), T13.4-2 (derived reproducibility),
// T13.4-3 (orphan knowledge boundary), T13.4-4 (derived paths belong to
// xspec), T13.4-5 (durable protection), T13.4-6 (symlink write rules).
// T13.4-7 registers no test body: its TEST-SPEC entry is a cross-reference —
// T7-6 (section-7-discovery.ts) carries the `.xspec.` / `.xspec/` /
// emit-destination source exclusion. (A registered no-op body would pass
// against the stub product and violate the S-7 red-green sweep, H-8; the H-7
// traceability map routes §13.4's source-exclusion passage to T7-6.)
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// Conservative operationalizations (noted per H-3/H-4):
// - "Every file xspec writes is a plain file" (T13.4-1): the harness stages
//   only regular files, so the scan asserts that no entry outside `.git/`
//   anywhere in the workspace is a symlink or other non-plain kind — any
//   such entry is product-written.
// - The T13.4-1 git round trip compares regular-file entries byte-exactly
//   (git does not represent empty directories; 13.4 constrains files) and
//   asserts the round-tripped behavior directly: after commit, worktree
//   wipe, and clean checkout, `check` stays clean, reads answer
//   byte-identically (12.0: byte-deterministic output for byte-identical
//   input), and a rebuild reproduces the same fixed point.
// - Byte-exact restoration compares (T13.4-2, T13.4-3, T13.4-4) are the H-4
//   self-comparison carve-out: product output compared against the product's
//   own output for identical build input. In T13.4-4 the reference is a
//   second workspace whose staged difference is confined to derived-file
//   paths — occupants of derived paths are never sources (13.4) and derived
//   output is a function of sources, configuration, and the journal alone
//   (13.4), so conforming builds of both workspaces yield byte-identical
//   trees.
// - T13.4-5 stays inside CERTIFICATIONS.md §CONF-CORE's scope (the test is
//   in-scope there): one spec group of importless, tagless `.mdx` sources;
//   no `code`, `markdown`, `coverage`, or `policy` keys; no git; mutating
//   commands drawn from `rename` and `review` under `--strategy audit`. In
//   this git-less scope `impact --base HEAD` is the exit-2
//   unreadable-baseline case (SPEC 6.3, 12.0) — asserted as such, durables
//   still untouched. Staging constraint (§VIOL-CORE-PERSISTREADS): the
//   fixture session holds no stale resolution while the `build`-and-read
//   byte-compares run — the one resolve is the last staging step and no
//   source changes afterward, so read-time invalidation computes nothing.
// - T13.4-6 refusal arm: the symlinked write-path component is staged as
//   `markdown.outDir` naming a symlink to a real directory inside the
//   workspace root (no outside-root confound, 14.14). With one source file,
//   exactly one write path (`out/specs/A.md`) traverses the link, so `build
//   --json` must report exactly one 14.22 and nothing else (the sources are
//   valid, and build cannot observe 14.10, 12.1). `check` must report the
//   same 14.22 without writing; 14.10 staleness findings are tolerated
//   beside it (no build has ever succeeded, so every derived file is
//   missing); any other condition fails.
// - T13.4-6 durable arms: the journal occupant's link target is an empty
//   plain file — a valid empty journal — and the session occupant's link
//   target is the product's own healthy session file beside it, so a product
//   that reads or writes through the link sees a valid durable file and
//   proceeds; the exit-code and whole-workspace byte-compares then fail it
//   ("never read, appended, or replaced"). The mutating attempt's refusal
//   report content is unasserted (the section-6.4 precedent: TEST-SPEC pins
//   no report content for refusals), while the 14.13/14.21 condition
//   identities are asserted through `build --json` / `check --json` /
//   /corrupt/i vocabulary, leniently per the T6.1-3 and T10.1-4 precedents
//   (the staged condition present; cascades unpinned).
// - T13.4-6 positive arm: the product is driven with its working directory
//   given as a symbolic link (created beside the workspace root) resolving
//   to the real root, with `PWD` naming the link path — path components
//   above the workspace root are unrestricted (13.4), so `build`, a
//   journaled `rename`, and `check` must behave normally and land their
//   effects in the real root.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  Finding,
  SessionStatusReport,
  SessionStatusRow,
} from "../../helpers/adapters/index.js";
import {
  assertJsonKeysByteSorted,
  assertReportMentions,
  decodeFindingsReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type {
  DirectorySnapshot,
  SnapshotEntry,
} from "../../helpers/snapshot.js";
import {
  assertLeavesUnchanged,
  assertSnapshotsEqual,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { runProduct } from "../../helpers/subprocess.js";
import type { WorkspaceDecl } from "../../helpers/workspace.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  buildOk,
  expectExit,
  runCli,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group, no
// other keys — the CONF-CORE workspace shape (CERTIFICATIONS.md).
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus Markdown emission next to each source (SPEC 7.3), so
// all four derived-file classes exist: module, companions, emitted Markdown,
// graph data (SPEC 13.1–13.3).
const MARKDOWN_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

// Importless, tagless `.mdx` sources (the CONF-CORE shape; fine everywhere
// else too): `a` carries a child so `rename` exercises descendant rewriting;
// `g` is a second top-level leaf whose audit item is unblocked (SPEC 10.6).
const A_MDX = [
  '<S id="a">',
  "Alpha text.",
  '<S id="a.k">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="g">',
  "Gamma text.",
  "</S>",
  "",
].join("\n");

const A_ROOT = "specs/A.mdx";
const JOURNAL_REL = ".xspec/journal";
const REVIEWS_REL = ".xspec/reviews";

/** A session file's workspace-relative path (SPEC 10.1). */
function sessionRel(name: string): string {
  return `${REVIEWS_REL}/${name}.json`;
}

/** Stage a fresh workspace with the given declaration, run `body`, dispose. */
async function withWorkspace<T>(
  decl: WorkspaceDecl,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create(decl);
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** Snapshot exclusion pruning the top-level `.git` subtree. */
function excludeGitDir(relPathBytes: Uint8Array): boolean {
  return Buffer.from(relPathBytes).toString("latin1") === ".git";
}

/**
 * Whether a snapshot key (a `/`-separated workspace-relative path) is graph
 * data: under `.xspec/`, excluding the durable `.xspec/journal` and
 * `.xspec/reviews/` (SPEC 13.3, 13.4; TEST-SPEC T13.3-2's operational
 * definition, binding for T13.4-3 too).
 */
function isGraphDataKey(key: string): boolean {
  if (!key.startsWith(".xspec/")) return false;
  if (key === JOURNAL_REL) return false;
  if (key === REVIEWS_REL || key.startsWith(`${REVIEWS_REL}/`)) return false;
  return true;
}

/** Whether a snapshot key is a durable path: the journal or a session. */
function isDurableKey(key: string): boolean {
  return (
    key === JOURNAL_REL ||
    key === REVIEWS_REL ||
    key.startsWith(`${REVIEWS_REL}/`)
  );
}

/** The entries of a snapshot satisfying `keep`, as a fresh map. */
function filteredEntries(
  entries: ReadonlyMap<string, SnapshotEntry>,
  keep: (key: string, entry: SnapshotEntry) => boolean,
): Map<string, SnapshotEntry> {
  const kept = new Map<string, SnapshotEntry>();
  for (const [key, entry] of entries) {
    if (keep(key, entry)) kept.set(key, entry);
  }
  return kept;
}

/** View a filtered entry map as a snapshot for `assertSnapshotsEqual`. */
function asSnapshot(
  root: string,
  entries: ReadonlyMap<string, SnapshotEntry>,
): DirectorySnapshot {
  return { root, entries };
}

/** A snapshot's regular-file entries (the T13.4-1 round-trip compare set). */
function fileEntries(snapshot: DirectorySnapshot): Map<string, SnapshotEntry> {
  return filteredEntries(snapshot.entries, (_key, entry) => {
    return entry.kind === "file";
  });
}

/**
 * Assert every entry of a snapshot is a regular file or a directory — the
 * harness staged only regular files, so a symlink or other non-plain entry is
 * product-written and violates "every file xspec writes is a plain file"
 * (SPEC 13.4).
 */
function assertAllEntriesPlain(
  snapshot: DirectorySnapshot,
  context: string,
): void {
  for (const [key, entry] of snapshot.entries) {
    if (entry.kind !== "file" && entry.kind !== "dir") {
      fail(
        `${context}: the entry at ${key} is a ${entry.kind} — every file ` +
          `xspec writes is a plain file suitable for committing (SPEC ` +
          `13.4), and the harness staged only regular files, so this ` +
          `entry is product-written`,
      );
    }
  }
}

/** Read a file's bytes, failing diagnosed when the path is not a file. */
async function readFileDiagnosed(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<Uint8Array> {
  const kind = await workspace.kind(rel);
  if (kind !== "file") {
    fail(
      `${context}: expected a plain file at ${rel} (SPEC 13.4); found ${kind}`,
    );
  }
  return await workspace.readBytes(rel);
}

/** `review status <name> --json`, decoded (SPEC 10.7). */
async function sessionStatus(
  product: ProductBinding,
  workspace: TestWorkspace,
  name: string,
  context: string,
): Promise<SessionStatusReport> {
  const label = `${context} \`review status ${name} --json\``;
  return decodeSessionStatusReport(
    await runJson(
      product,
      workspace,
      ["review", "status", name, "--json"],
      label,
    ),
    label,
  );
}

/**
 * The unique status row scoped at `scope`, diagnosed loudly when missing or
 * duplicated (SPEC 10.1: at most one item per kind and scope node — audit
 * items are all `subtree-coherence`, so scope alone is unique here).
 */
function requireRowByScope(
  report: SessionStatusReport,
  scope: string,
  context: string,
): SessionStatusRow {
  const rows = report.items.filter((row) => row.scope === scope);
  if (rows.length !== 1) {
    fail(
      `${context}: expected exactly one item scoped at ${scope} (SPEC 10.1, ` +
        `10.6); found ${String(rows.length)} among ` +
        JSON.stringify(
          report.items.map((row) => ({ scope: row.scope, kind: row.kind })),
        ),
    );
  }
  return rows[0] as SessionStatusRow;
}

// ---------------------------------------------------------------------------
// T13.4-1 — plain committable files, git round trip, sorted keys
// ---------------------------------------------------------------------------

const T13_4_1 = defineProductTest({
  id: "T13.4-1",
  title:
    "every file xspec writes is a plain file; committing the workspace into git and checking it back out round-trips builds and reads; every JSON object in the product-written session file — after `create` and again after a `resolve` rewrites it — has byte-sorted keys, shape- and value-blind (SPEC 13.4, 12.0, 10.4)",
  run: async (product) => {
    await withWorkspace(
      { files: { "xspec.config.ts": MARKDOWN_CONFIG, "specs/A.mdx": A_MDX } },
      async (workspace) => {
        const options = { exclude: excludeGitDir };
        await workspace.gitInit();

        // Staging: every written-file class comes into existence — derived
        // files via `build`, the journal via a journaled `rename` (SPEC
        // 6.1; the rename finishes by regenerating derived files, 6.4), a
        // session via `review create`.
        await buildOk(product, workspace, "T13.4-1 `build` (SPEC 12.1)");
        await expectExit(
          product,
          workspace,
          ["rename", A_ROOT, "a", "a2"],
          0,
          "T13.4-1 `rename specs/A.mdx a a2` — creates the journal (SPEC " +
            "6.1, 6.4)",
        );
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          "T13.4-1 `review create --strategy audit --name s` (SPEC 10.7)",
        );

        // Sorted keys, read #1: the session file as `create` wrote it. The
        // assertion is shape- and value-blind — every JSON object in the
        // document, whatever its keys (H-3).
        const afterCreate = await readFileDiagnosed(
          workspace,
          sessionRel("s"),
          "T13.4-1 the session file after `create` (SPEC 10.1)",
        );
        assertJsonKeysByteSorted(
          afterCreate,
          "T13.4-1 the session file after `create` — written with sorted " +
            "keys (SPEC 13.4, 12.0)",
        );

        // Resolve an unblocked leaf item so the session file is rewritten
        // (SPEC 10.4: `current` is rewritten at each resolve).
        const staged = await sessionStatus(product, workspace, "s", "T13.4-1");
        const gItem = requireRowByScope(
          staged,
          "specs/A.mdx#g",
          "T13.4-1 staging item lookup",
        );
        await expectExit(
          product,
          workspace,
          ["review", "resolve", "s", gItem.id, "--status", "no-change"],
          0,
          "T13.4-1 `review resolve s <leaf item> --status no-change` (SPEC " +
            "10.7)",
        );

        // Sorted keys, read #2: the session file as the resolve rewrote it.
        const afterResolve = await readFileDiagnosed(
          workspace,
          sessionRel("s"),
          "T13.4-1 the session file after `resolve` (SPEC 10.1, 10.4)",
        );
        assertJsonKeysByteSorted(
          afterResolve,
          "T13.4-1 the session file after a `resolve` rewrote it — still " +
            "sorted keys (SPEC 13.4, 10.4)",
        );

        // Plain-file scan over the fully staged workspace: modules,
        // companions, Markdown, graph data, journal, and session are all
        // present; none may be a symlink or other non-plain entry.
        const w1 = await snapshotDirectory(workspace.root, options);
        assertAllEntriesPlain(w1, "T13.4-1 after staging every file class");

        // Reads before the round trip, for the byte-identical comparison
        // after it (SPEC 12.0: byte-deterministic output for byte-identical
        // input).
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T13.4-1 `check` before the round trip — the staged workspace is " +
            "clean (SPEC 12.2)",
        );
        const idsBefore = await runCli(product, workspace, ["ids", "--json"]);
        assertExitCode(
          idsBefore,
          0,
          "T13.4-1 `ids --json` before the round trip",
        );
        const statusBefore = await runCli(product, workspace, [
          "review",
          "status",
          "s",
          "--json",
        ]);
        assertExitCode(
          statusBefore,
          0,
          "T13.4-1 `review status s --json` before the round trip",
        );

        // The round trip: commit everything, wipe the worktree, and check it
        // back out clean.
        await workspace.gitCommitAll("the workspace as built");
        for (const name of await workspace.readdirNames(".")) {
          if (name === ".git") continue;
          await fsp.rm(workspace.path(name), { recursive: true, force: true });
        }
        await workspace.git(["checkout", "--", "."]);

        // Every product-written plain file round-trips byte-exactly (git
        // preserves plain-file bytes; empty directories are not files and
        // are outside the compare — SPEC 13.4 constrains files).
        const w2 = await snapshotDirectory(workspace.root, options);
        assertSnapshotsEqual(
          asSnapshot(workspace.root, fileEntries(w1)),
          asSnapshot(workspace.root, fileEntries(w2)),
          "T13.4-1: the workspace's regular files after commit + clean " +
            "checkout vs before — every file xspec writes survives a git " +
            "round trip byte-exactly (SPEC 13.4)",
        );

        // Reads round-trip: byte-identical input, byte-identical answers.
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T13.4-1 `check` after the round trip — the checked-out " +
            "workspace is as clean as the committed one (SPEC 13.4, 12.2)",
        );
        const idsAfter = await runCli(product, workspace, ["ids", "--json"]);
        assertExitCode(
          idsAfter,
          0,
          "T13.4-1 `ids --json` after the round trip",
        );
        assertBytesEqual(
          idsAfter.stdoutBytes,
          idsBefore.stdoutBytes,
          "T13.4-1 `ids --json` output after vs before the git round trip " +
            "— reads round-trip (SPEC 13.4, 12.0)",
        );
        const statusAfter = await runCli(product, workspace, [
          "review",
          "status",
          "s",
          "--json",
        ]);
        assertExitCode(
          statusAfter,
          0,
          "T13.4-1 `review status s --json` after the round trip",
        );
        assertBytesEqual(
          statusAfter.stdoutBytes,
          statusBefore.stdoutBytes,
          "T13.4-1 `review status s --json` output after vs before the git " +
            "round trip — reads round-trip (SPEC 13.4, 12.0)",
        );

        // Builds round-trip: rebuilding the checked-out workspace lands on
        // the same fixed point, and everything stays plain.
        await buildOk(
          product,
          workspace,
          "T13.4-1 `build` after the round trip (SPEC 12.1)",
        );
        const w3 = await snapshotDirectory(workspace.root, options);
        assertSnapshotsEqual(
          asSnapshot(workspace.root, fileEntries(w1)),
          asSnapshot(workspace.root, fileEntries(w3)),
          "T13.4-1: the workspace's regular files after the post-checkout " +
            "rebuild vs before the round trip — builds round-trip (SPEC " +
            "13.4, 12.0, 12.1)",
        );
        assertAllEntriesPlain(w3, "T13.4-1 after the post-checkout rebuild");
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.4-2 — derived reproducibility
// ---------------------------------------------------------------------------

// Deliberately non-derived bytes, invalid UTF-8 included, for the
// garbage-overwrite round (derived-file content is product-defined, so the
// garbage need only differ from any plausible generated content).
const GARBAGE_BYTES = Buffer.concat([
  Buffer.from("?? harness garbage overwriting a derived file ??\n", "utf8"),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d]),
]);

const T13_4_2 = defineProductTest({
  id: "T13.4-2",
  title:
    "deleting, truncating, and garbage-overwriting each class of derived file (module, companions, Markdown, graph data) is repaired by `build`, which restores all of them byte-exactly (SPEC 13.4, 12.1)",
  run: async (product) => {
    await withWorkspace(
      { files: { "xspec.config.ts": MARKDOWN_CONFIG, "specs/A.mdx": A_MDX } },
      async (workspace) => {
        await buildOk(product, workspace, "T13.4-2 initial `build`");
        const s0 = await snapshotDirectory(workspace.root);

        // The mutation targets: every derived file of every class. Module
        // and companions all carry the `A.xspec.` stem (SPEC 13.1), the
        // emitted Markdown is specs/A.md (SPEC 13.2, 7.3), graph data is
        // everything under .xspec/ (SPEC 13.3; no journal or session exists
        // here).
        const targets = [
          ...filteredEntries(s0.entries, (key, entry) => {
            if (entry.kind !== "file") return false;
            return (
              key.startsWith("specs/A.xspec.") ||
              key === "specs/A.md" ||
              isGraphDataKey(key)
            );
          }).keys(),
        ].sort();
        const classPresent = (predicate: (key: string) => boolean): boolean =>
          targets.some(predicate);
        if (
          !classPresent((key) => key === "specs/A.xspec.ts") ||
          !classPresent((key) => key === "specs/A.md") ||
          !classPresent(isGraphDataKey)
        ) {
          fail(
            "T13.4-2: staging premise — after `build`, the generated module " +
              "specs/A.xspec.ts, the emitted Markdown specs/A.md, and graph " +
              "data under .xspec/ must all exist (SPEC 13.1, 13.2, 13.3); " +
              `found targets: ${JSON.stringify(targets)}`,
          );
        }

        const bytesOf = (key: string): Uint8Array => {
          const entry = s0.entries.get(key);
          // Targets were selected from s0's file entries, so this cannot miss.
          if (entry === undefined || entry.kind !== "file") {
            throw new Error(`T13.4-2 internal error: no file entry for ${key}`);
          }
          return entry.bytes;
        };

        const rounds: readonly (readonly [
          string,
          (key: string) => Promise<void>,
        ])[] = [
          [
            "delete",
            async (key) => {
              await fsp.rm(workspace.path(key), { force: true });
            },
          ],
          [
            "truncate",
            async (key) => {
              const bytes = bytesOf(key);
              await workspace.file(
                key,
                bytes.subarray(0, Math.floor(bytes.length / 2)),
              );
            },
          ],
          [
            "garbage-overwrite",
            async (key) => {
              await workspace.file(key, GARBAGE_BYTES);
            },
          ],
        ];

        for (const [name, mutate] of rounds) {
          for (const key of targets) {
            await mutate(key);
          }
          await buildOk(
            product,
            workspace,
            `T13.4-2 (${name}) \`build\` over the damaged derived files — a ` +
              `conflicted, corrupted, deleted, or orphaned derived file is ` +
              `correctly resolved by rebuilding (SPEC 13.4, 12.1)`,
          );
          const after = await snapshotDirectory(workspace.root);
          assertSnapshotsEqual(
            s0,
            after,
            `T13.4-2 (${name}): the workspace after the repairing \`build\` ` +
              `vs the clean fixed point — every derived-file class is ` +
              `restored byte-exactly (SPEC 13.4, 12.0; H-4 self-comparison)`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.4-3 — orphan knowledge boundary
// ---------------------------------------------------------------------------

// The narrowed configuration: B.mdx no longer belongs to any group, so B's
// derived files are no longer generated (a literal path is a valid glob,
// SPEC 7).
const A_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/A.mdx"]
  }
})
`;

const T13_4_3 = defineProductTest({
  id: "T13.4-3",
  title:
    "a derived file orphaned while the recorded derived-file paths were missing is outside xspec's knowledge: builds under the narrowed configuration leave it alone byte-exactly, and after manual deletion it stays gone (SPEC 13.4, 13.3, 12.1)",
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": A_MDX,
          "specs/B.mdx": ['<S id="b">', "Beta text.", "</S>", ""].join("\n"),
        },
      },
      async (workspace) => {
        // Build so B's derived files exist and are recorded (SPEC 13.3).
        await buildOk(product, workspace, "T13.4-3 initial `build`");
        const s1 = await snapshotDirectory(workspace.root);
        const bDerived = [
          ...filteredEntries(s1.entries, (key, entry) => {
            return entry.kind === "file" && key.startsWith("specs/B.xspec.");
          }).keys(),
        ].sort();
        if (!bDerived.includes("specs/B.xspec.ts")) {
          fail(
            "T13.4-3: staging premise — after `build`, B.mdx's generated " +
              "module specs/B.xspec.ts exists as a plain file (SPEC 13.1); " +
              `found B-derived files: ${JSON.stringify(bDerived)}`,
          );
        }

        // Destroy the graph data — and with it the recorded derived-file
        // paths (T13.3-2's operational definition: everything under .xspec/
        // except the durable journal and reviews/; neither exists here).
        const xspecKind = await workspace.kind(".xspec");
        if (xspecKind !== "dir") {
          fail(
            "T13.4-3: staging premise — after `build`, the .xspec/ " +
              `directory exists (SPEC 13.3); found ${xspecKind}`,
          );
        }
        for (const name of await workspace.readdirNames(".xspec")) {
          if (name === "journal" || name === "reviews") continue;
          await fsp.rm(workspace.path(`.xspec/${name}`), {
            recursive: true,
            force: true,
          });
        }

        // Narrow the configuration so B's files are no longer generated,
        // then build: B's former derived files are orphaned, but the record
        // that would identify them is gone — they are outside xspec's
        // knowledge and must not be removed.
        await workspace.file("xspec.config.ts", A_ONLY_CONFIG);
        await buildOk(
          product,
          workspace,
          "T13.4-3 `build` under the narrowed configuration (SPEC 12.1)",
        );
        const s2 = await snapshotDirectory(workspace.root);
        for (const key of bDerived) {
          const before = s1.entries.get(key);
          const after = s2.entries.get(key);
          if (before === undefined || before.kind !== "file") {
            throw new Error(`T13.4-3 internal error: no file entry for ${key}`);
          }
          if (after === undefined || after.kind !== "file") {
            fail(
              `T13.4-3: the orphaned derived file ${key} must survive the ` +
                `build — it was orphaned while the recorded derived-file ` +
                `paths were missing, so it is outside xspec's knowledge and ` +
                `is not removed (SPEC 13.4, 13.3); found ` +
                `${after === undefined ? "absent" : after.kind}`,
            );
          }
          assertBytesEqual(
            after.bytes,
            before.bytes,
            `T13.4-3: the orphaned derived file ${key} after the build — ` +
              `left alone byte-exactly (SPEC 13.4)`,
          );
        }
        if (s2.entries.get("specs/A.xspec.ts")?.kind !== "file") {
          fail(
            "T13.4-3: specs/A.xspec.ts must exist after the build — A.mdx " +
              "is still a configured source (SPEC 13.1, 12.1)",
          );
        }

        // A subsequent build leaves the stray files (and everything else at
        // the fixed point) alone.
        await buildOk(product, workspace, "T13.4-3 subsequent `build`");
        const s3 = await snapshotDirectory(workspace.root);
        assertSnapshotsEqual(
          s2,
          s3,
          "T13.4-3: the workspace after a subsequent build vs before it — " +
            "subsequent builds leave the stray files alone (SPEC 13.4, 12.0)",
        );

        // The orphans may be deleted manually; builds do not resurrect them
        // (they are not generated by the current configuration and not
        // recorded).
        for (const key of bDerived) {
          await fsp.rm(workspace.path(key), { force: true });
        }
        await buildOk(
          product,
          workspace,
          "T13.4-3 `build` after the manual deletion (SPEC 12.1)",
        );
        const s4 = await snapshotDirectory(workspace.root);
        const expected = filteredEntries(s3.entries, (key) => {
          return !bDerived.includes(key);
        });
        assertSnapshotsEqual(
          asSnapshot(workspace.root, expected),
          s4,
          "T13.4-3: the workspace after deleting the strays and rebuilding " +
            "— the manually deleted orphans stay gone and nothing else " +
            "changes (SPEC 13.4, 12.0)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.4-4 — derived paths belong to xspec
// ---------------------------------------------------------------------------

const TARGET_REL = "target.txt";
const TARGET_BYTES =
  "harness-owned link target: nothing may ever be written through the link\n";

// The common staging of the dirty workspace and its pristine reference
// (module-header rationale: derived output is a function of sources,
// configuration, and the journal alone, SPEC 13.4).
const T13_4_4_COMMON: Readonly<Record<string, string>> = {
  "xspec.config.ts": MARKDOWN_CONFIG,
  "specs/A.mdx": A_MDX,
  [TARGET_REL]: TARGET_BYTES,
};

/** `"../" × depth` up from a `/`-separated key's directory to the root. */
function relativeTargetFrom(key: string, targetName: string): string {
  const depth = key.split("/").length - 1;
  return "../".repeat(depth) + targetName;
}

const T13_4_4 = defineProductTest({
  id: "T13.4-4",
  title:
    "a user-created file at a derived path is replaced by `build`, and a symbolic link at a derived file's own path is replaced as the occupant — nothing is written through it: link target byte-identical after the build, link gone, plain file present, no error (SPEC 13.4, 12.1)",
  run: async (product) => {
    const reference = await TestWorkspace.create({ files: T13_4_4_COMMON });
    const dirty = await TestWorkspace.create({
      files: {
        ...T13_4_4_COMMON,
        // User-created files at derived paths, present before any build.
        "specs/A.xspec.ts": "user content at the generated module's path\n",
        "specs/A.md": "user content at the emitted Markdown's path\n",
      },
    });
    try {
      // The pristine reference build fixes the expected byte tree.
      await buildOk(product, reference, "T13.4-4 reference `build`");
      const sr = await snapshotDirectory(reference.root);
      const module = sr.entries.get("specs/A.xspec.ts");
      if (module === undefined || module.kind !== "file") {
        fail(
          "T13.4-4: staging premise — the reference build generates " +
            "specs/A.xspec.ts as a plain file (SPEC 13.1)",
        );
      }
      if (sr.entries.get("specs/A.md")?.kind !== "file") {
        fail(
          "T13.4-4: staging premise — the reference build emits specs/A.md " +
            "(SPEC 13.2, 7.3)",
        );
      }
      const graphFiles = [
        ...filteredEntries(sr.entries, (key, entry) => {
          return entry.kind === "file" && isGraphDataKey(key);
        }).keys(),
      ].sort();
      const graphKey = graphFiles[0];
      if (graphKey === undefined) {
        fail(
          "T13.4-4: staging premise — the reference build writes graph " +
            "data under .xspec/ (SPEC 13.3)",
        );
      }
      // Discrimination premise: the generated module must differ from the
      // staged user content, or replacement would be unobservable.
      if (
        Buffer.compare(
          module.bytes,
          Buffer.from("user content at the generated module's path\n", "utf8"),
        ) === 0
      ) {
        fail(
          "T13.4-4: staging premise — the generated module's content must " +
            "differ from the staged user content (SPEC 4: generated modules " +
            "begin with the generated-file header)",
        );
      }

      // Arm 1 — user-created files at derived paths: the first build of the
      // dirty workspace replaces them; the result equals the pristine
      // reference byte-for-byte (occupants of derived paths are not sources,
      // SPEC 13.4).
      await buildOk(
        product,
        dirty,
        "T13.4-4 `build` over user-created files at the derived paths — " +
          "replaced, not an error (SPEC 13.4, 12.1)",
      );
      const sw = await snapshotDirectory(dirty.root);
      assertSnapshotsEqual(
        sr,
        sw,
        "T13.4-4 (user files): the dirty workspace after `build` vs the " +
          "pristine reference — a user-created file at a derived path is " +
          "replaced, and it never enters the build's input (SPEC 13.4, 12.0)",
      );

      // Arm 2 — symbolic links at derived files' own paths: one per derived
      // class. Each link resolves to the harness's target file; a product
      // writing through a link modifies the target, a product refusing
      // errors out, and a conforming product replaces the link itself.
      const linkKeys = ["specs/A.xspec.ts", "specs/A.md", graphKey] as const;
      for (const key of linkKeys) {
        await fsp.rm(dirty.path(key), { force: true });
        await dirty.symlink(key, relativeTargetFrom(key, TARGET_REL));
        if ((await dirty.kind(key)) !== "symlink") {
          throw new Error(
            `T13.4-4 internal error: failed to stage a symlink at ${key}`,
          );
        }
      }
      await buildOk(
        product,
        dirty,
        "T13.4-4 `build` over symbolic links at derived files' own paths — " +
          "the link is an occupant like any other, not an error (SPEC 13.4)",
      );
      for (const key of linkKeys) {
        const kind = await dirty.kind(key);
        if (kind !== "file") {
          fail(
            `T13.4-4 (symlink occupants): after \`build\`, ${key} must be ` +
              `a plain file — the write replaces the link itself (link ` +
              `gone, plain file present; SPEC 13.4); found ${kind}`,
          );
        }
      }
      assertBytesEqual(
        await dirty.readBytes(TARGET_REL),
        TARGET_BYTES,
        "T13.4-4 (symlink occupants): the link target after `build` — " +
          "nothing is ever written through the link (SPEC 13.4)",
      );
      const sw2 = await snapshotDirectory(dirty.root);
      assertSnapshotsEqual(
        sr,
        sw2,
        "T13.4-4 (symlink occupants): the workspace after `build` vs the " +
          "pristine reference — every derived path holds its generated " +
          "plain file and the target is untouched (SPEC 13.4, 12.0)",
      );
    } finally {
      await reference.dispose();
      await dirty.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T13.4-5 — durable protection (CONF-CORE in-scope)
// ---------------------------------------------------------------------------

const T13_4_5 = defineProductTest({
  id: "T13.4-5",
  title:
    "`build` and the read commands never modify or delete the journal or session files (byte-compare around each command), and durable files are never regenerated: a deleted session file stays absent — `review` naming it exits 2 unknown session — and a deleted journal stays absent (SPEC 13.4, 6.1, 10.1, 12.0)",
  run: async (product) => {
    await withWorkspace(
      { files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/A.mdx": A_MDX } },
      async (workspace) => {
        // Staging (inside CONF-CORE's scope; see the module header): build,
        // one journaled rename, an audit session, one resolve of an
        // unblocked leaf — the last staging step, so no resolution is stale
        // when the byte-compares below run (§VIOL-CORE-PERSISTREADS).
        await buildOk(product, workspace, "T13.4-5 `build` (SPEC 12.1)");
        await expectExit(
          product,
          workspace,
          ["rename", A_ROOT, "a", "a2"],
          0,
          "T13.4-5 `rename specs/A.mdx a a2` — the journal comes into " +
            "existence with the first journaled operation (SPEC 6.1)",
        );
        await readFileDiagnosed(
          workspace,
          JOURNAL_REL,
          "T13.4-5 the journal after the rename (SPEC 6.1)",
        );
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "s"],
          0,
          "T13.4-5 `review create --strategy audit --name s` (SPEC 10.7)",
        );
        const staged = await sessionStatus(product, workspace, "s", "T13.4-5");
        const gItem = requireRowByScope(
          staged,
          "specs/A.mdx#g",
          "T13.4-5 staging item lookup",
        );
        await expectExit(
          product,
          workspace,
          ["review", "resolve", "s", gItem.id, "--status", "no-change"],
          0,
          "T13.4-5 `review resolve s <leaf item> --status no-change` (SPEC " +
            "10.7)",
        );

        // The durable byte state under protection: the journal plus
        // everything under .xspec/reviews/.
        const durablesBefore = filteredEntries(
          (await snapshotDirectory(workspace.root)).entries,
          (key) => isDurableKey(key),
        );
        const journalEntry = durablesBefore.get(JOURNAL_REL);
        const sessionEntry = durablesBefore.get(sessionRel("s"));
        if (journalEntry?.kind !== "file" || sessionEntry?.kind !== "file") {
          fail(
            "T13.4-5: staging premise — the journal and the session file " +
              "both exist as plain files before the byte-compares (SPEC " +
              "6.1, 10.1)",
          );
        }

        // `build` and every read command: exact exit codes (H-5), and the
        // durable files byte-identical after each command. In this git-less
        // scope `impact --base HEAD` is the exit-2 unreadable-baseline case
        // (SPEC 6.3, 12.0) — even a refused command touches no durable.
        const probes: readonly {
          readonly argv: readonly string[];
          readonly exit: number;
          readonly what: string;
        }[] = [
          { argv: ["build"], exit: 0, what: "`build` (SPEC 12.1)" },
          { argv: ["check"], exit: 0, what: "`check` (SPEC 12.2)" },
          { argv: ["ids", "--json"], exit: 0, what: "`ids --json`" },
          {
            argv: ["show", "specs/A.mdx#a2", "--json"],
            exit: 0,
            what: "`show specs/A.mdx#a2 --json`",
          },
          {
            argv: ["coverage", "--json"],
            exit: 0,
            what: "`coverage --json` (zero configured profiles, SPEC 8.2)",
          },
          { argv: ["query", "nodes"], exit: 0, what: "`query nodes`" },
          {
            argv: ["impact", "--base", "HEAD"],
            exit: 2,
            what:
              "`impact --base HEAD` — no git repository, so the baseline " +
              "cannot be read: a usage error (SPEC 6.3, 12.0)",
          },
          {
            argv: ["review", "list", "--json"],
            exit: 0,
            what: "`review list --json`",
          },
          {
            argv: ["review", "status", "s", "--json"],
            exit: 0,
            what: "`review status s --json`",
          },
          {
            argv: ["review", "next", "s", "--json"],
            exit: 0,
            what: "`review next s --json`",
          },
          {
            argv: ["review", "show", "s", gItem.id],
            exit: 0,
            what: "`review show s <item>`",
          },
          {
            argv: ["review", "export", "s", "--json"],
            exit: 0,
            what: "`review export s --json`",
          },
        ];
        for (const probe of probes) {
          const context = `T13.4-5 ${probe.what}`;
          const result = await runCli(product, workspace, probe.argv);
          assertExitCode(result, probe.exit, context);
          const durablesNow = filteredEntries(
            (await snapshotDirectory(workspace.root)).entries,
            (key) => isDurableKey(key),
          );
          assertSnapshotsEqual(
            asSnapshot(workspace.root, durablesBefore),
            asSnapshot(workspace.root, durablesNow),
            `${context}: the journal and session files after the command — ` +
              `never modified, deleted, or added to by \`build\` or a read ` +
              `command (SPEC 13.4, 6.1, 10.4)`,
          );
        }

        // Durable files are never regenerated. Deleting the session file:
        // xspec does not recreate it, and `review` naming it is exit 2
        // (unknown session, SPEC 10.1/12.0).
        await fsp.rm(workspace.path(sessionRel("s")));
        await expectExit(
          product,
          workspace,
          ["review", "status", "s"],
          2,
          "T13.4-5 `review status s` after deleting the session file — an " +
            "unknown session name in a review command's arguments is a " +
            "usage error (SPEC 10.1, 12.0)",
        );
        await buildOk(
          product,
          workspace,
          "T13.4-5 `build` after deleting the session file (SPEC 12.1)",
        );
        const sessionKind = await workspace.kind(sessionRel("s"));
        if (sessionKind !== "absent") {
          fail(
            "T13.4-5: the deleted session file must stay absent — durable " +
              "files are not reproducible and are never regenerated (SPEC " +
              `13.4); found ${sessionKind} at ${sessionRel("s")}`,
          );
        }
        assertBytesEqual(
          await readFileDiagnosed(
            workspace,
            JOURNAL_REL,
            "T13.4-5 the journal after the session-deletion arm",
          ),
          journalEntry.bytes,
          "T13.4-5: the journal across the session-deletion arm — still " +
            "byte-identical (SPEC 13.4, 6.1)",
        );

        // Deleting the journal: also never regenerated (an absent journal
        // is a valid empty journal, SPEC 6.1).
        await fsp.rm(workspace.path(JOURNAL_REL));
        await buildOk(
          product,
          workspace,
          "T13.4-5 `build` after deleting the journal (SPEC 12.1, 6.1)",
        );
        const journalKind = await workspace.kind(JOURNAL_REL);
        if (journalKind !== "absent") {
          fail(
            "T13.4-5: the deleted journal must stay absent — the journal " +
              "cannot be regenerated from source and comes into existence " +
              "only with a journaled operation (SPEC 13.4, 6.1); found " +
              journalKind,
          );
        }
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          "T13.4-5 `check` after the deletion arms — the rebuilt, " +
            "sessionless workspace with an empty journal is clean (SPEC " +
            "12.2, 6.1)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.4-6 — symlink write rules
// ---------------------------------------------------------------------------

// Markdown redirected into `out`, which the fixture stages as a symbolic
// link to a real directory inside the workspace (SPEC 7.3; module header).
const OUT_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true, outDir: "out" }
})
`;

/**
 * Decode a findings report from an exit-1 `--json` run and assert at least
 * one finding carries the given condition; every finding is returned.
 */
function requireCondition(
  findings: readonly Finding[],
  condition: string,
  context: string,
): void {
  if (!findings.some((finding) => finding.condition === condition)) {
    fail(
      `${context}: a condition-${condition} finding must be reported (SPEC ` +
        `14); reported conditions: ` +
        JSON.stringify(findings.map((finding) => finding.condition)),
    );
  }
}

const T13_4_6 = defineProductTest({
  id: "T13.4-6",
  title:
    "a write path with a symbolic link at a workspace-relative directory component is refused before anything is modified (14.22, exit 1, workspace byte-identical; `check` reports it without writing); a durable path occupied by a symlink or non-plain file is a journal error (14.13) / corrupt session (14.21), never read, appended, or replaced; path components above the workspace root are unrestricted — a root reached through a symlink builds, mutates, and `check`s normally (SPEC 13.4, 14.13, 14.21, 14.22)",
  run: async (product) => {
    // --- Refusal arm: the Markdown emit destination's directory component
    // is a symbolic link (module header: exactly one write path traverses
    // it) ---
    await withWorkspace(
      {
        files: { "xspec.config.ts": OUT_CONFIG, "specs/A.mdx": A_MDX },
        dirs: ["real-out"],
        symlinks: { out: "real-out" },
      },
      async (workspace) => {
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const context =
              "T13.4-6 (write-path symlink) `build --json` — the write to " +
              "out/specs/A.md traverses the symlink at `out`";
            const result = await runCli(product, workspace, [
              "build",
              "--json",
            ]);
            assertExitCode(
              result,
              1,
              `${context}: the write is refused with the report (SPEC ` +
                `14.22, 12.0)`,
            );
            const findings = decodeFindingsReport(
              parseJsonStdout(result, context),
              context,
            ).findings;
            assertConditionCounts(
              findings,
              { "14.22": 1 },
              `${context}: exactly the one staged condition — one write ` +
                `path traverses the link, the sources are valid, and ` +
                `\`build\` cannot observe 14.10 (SPEC 14.22, 12.1)`,
            );
          },
          "T13.4-6 (write-path symlink) `build` refuses before anything is " +
            "modified — no module, Markdown, or graph data appears and the " +
            "link and its target are untouched (SPEC 14.22, 13.4, 12.1)",
        );

        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const context = "T13.4-6 (write-path symlink) `check --json`";
            const result = await runCli(product, workspace, [
              "check",
              "--json",
            ]);
            assertExitCode(
              result,
              1,
              `${context}: \`check\` reports the same finding (SPEC 14.22, ` +
                `12.2)`,
            );
            const findings = decodeFindingsReport(
              parseJsonStdout(result, context),
              context,
            ).findings;
            const symlinkFindings = findings.filter(
              (finding) => finding.condition === "14.22",
            );
            if (symlinkFindings.length !== 1) {
              fail(
                `${context}: exactly one 14.22 finding — one write path ` +
                  `traverses the link (SPEC 14.22); reported conditions: ` +
                  JSON.stringify(findings.map((finding) => finding.condition)),
              );
            }
            for (const finding of findings) {
              if (
                finding.condition !== "14.22" &&
                finding.condition !== "14.10"
              ) {
                fail(
                  `${context}: beside the 14.22, only 14.10 staleness is ` +
                    `stageable here (no build has ever succeeded, so ` +
                    `derived files are missing; SPEC 14.10, 12.2); got ` +
                    `${JSON.stringify(finding.condition)} (message: ` +
                    `${JSON.stringify(finding.message)})`,
                );
              }
            }
          },
          "T13.4-6 (write-path symlink) `check` reports without writing " +
            "(SPEC 14.22, 12.2)",
        );
      },
    );

    // --- Durable arm, journal: the journal path occupied by a symbolic
    // link (target: a valid empty journal), then by a directory ---
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": A_MDX,
          // An empty plain file is a valid empty journal (SPEC 6.1): a
          // product that follows the link sees nothing wrong and proceeds —
          // failing the exit-code or byte-compare below.
          "journal-target": "",
        },
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T13.4-6 (journal occupant) `build` before occupying the journal " +
            "path",
        );
        await workspace.symlink(JOURNAL_REL, "../journal-target");

        const occupantProbe = async (occupant: string): Promise<void> => {
          const renameContext = `T13.4-6 (journal ${occupant}) \`rename specs/A.mdx a a2\``;
          await assertLeavesUnchanged(
            workspace.root,
            async () => {
              await expectExit(
                product,
                workspace,
                ["rename", A_ROOT, "a", "a2"],
                1,
                `${renameContext}: a journal path occupied by anything ` +
                  `other than a plain file is a journal error — the ` +
                  `journaled operation is refused (SPEC 13.4, 14.13, 6.4)`,
              );
            },
            `${renameContext}: the occupied journal is never read, ` +
              `appended to, or replaced, and nothing else is modified — ` +
              `occupant and target byte-identical (SPEC 13.4)`,
          );
          for (const argv of [
            ["build", "--json"],
            ["check", "--json"],
          ] as const) {
            const context = `T13.4-6 (journal ${occupant}) \`${argv.join(" ")}\``;
            await assertLeavesUnchanged(
              workspace.root,
              async () => {
                const result = await runCli(product, workspace, argv);
                assertExitCode(
                  result,
                  1,
                  `${context}: the journal error is a finding (SPEC 14.13, ` +
                    `12.0)`,
                );
                requireCondition(
                  decodeFindingsReport(
                    parseJsonStdout(result, context),
                    context,
                  ).findings,
                  "14.13",
                  context,
                );
              },
              `${context}: reports without modifying anything (SPEC 13.4, ` +
                `12.1, 12.2)`,
            );
          }
        };

        await occupantProbe("symlink");
        await fsp.rm(workspace.path(JOURNAL_REL));
        await workspace.dir(JOURNAL_REL);
        await occupantProbe("directory");
      },
    );

    // --- Durable arm, session: a session path occupied by a symbolic link
    // whose target is the product's own healthy session file beside it ---
    await withWorkspace(
      { files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/A.mdx": A_MDX } },
      async (workspace) => {
        await buildOk(product, workspace, "T13.4-6 (session occupant) `build`");
        await expectExit(
          product,
          workspace,
          ["review", "create", "--strategy", "audit", "--name", "real"],
          0,
          "T13.4-6 (session occupant) `review create --strategy audit " +
            "--name real`",
        );
        const staged = await sessionStatus(
          product,
          workspace,
          "real",
          "T13.4-6 (session occupant)",
        );
        const itemId = requireRowByScope(
          staged,
          "specs/A.mdx#g",
          "T13.4-6 (session occupant) item lookup",
        ).id;
        await workspace.symlink(sessionRel("fake"), "real.json");

        const statusContext = "T13.4-6 (session occupant) `review status fake`";
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const result = await runCli(product, workspace, [
              "review",
              "status",
              "fake",
            ]);
            assertExitCode(
              result,
              1,
              `${statusContext}: a session path occupied by a symbolic ` +
                `link is a corrupt session — never read through (a ` +
                `link-follower sees the healthy target session and ` +
                `answers exit 0) (SPEC 13.4, 10.1, 14.21)`,
            );
            assertReportMentions(
              result,
              [/corrupt/i],
              `${statusContext}: the report identifies the session as ` +
                `corrupt (SPEC 10.1/14.21 vocabulary; information ` +
                `presence, never exact wording, H-3)`,
            );
          },
          `${statusContext}: modifies nothing — link and target ` +
            `byte-identical (SPEC 13.4, 10.1)`,
        );

        const resolveContext =
          "T13.4-6 (session occupant) `review resolve fake <item> --status " +
          "no-change`";
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            await expectExit(
              product,
              workspace,
              ["review", "resolve", "fake", itemId, "--status", "no-change"],
              1,
              `${resolveContext}: the mutating subcommand naming the ` +
                `corrupt session reports and exits 1 (SPEC 10.1, 14.21)`,
            );
          },
          `${resolveContext}: the occupied session path is never appended ` +
            `to or replaced, and nothing is written through the link — the ` +
            `healthy target session included (SPEC 13.4, 10.1)`,
        );

        const checkContext = "T13.4-6 (session occupant) `check --json`";
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const result = await runCli(product, workspace, [
              "check",
              "--json",
            ]);
            assertExitCode(
              result,
              1,
              `${checkContext}: the corrupt session is a finding (SPEC ` +
                `12.2, 14.21)`,
            );
            requireCondition(
              decodeFindingsReport(
                parseJsonStdout(result, checkContext),
                checkContext,
              ).findings,
              "14.21",
              checkContext,
            );
          },
          `${checkContext}: \`check\` never writes (SPEC 12.2)`,
        );
      },
    );

    // --- Positive arm: path components above the workspace root are
    // unrestricted — the root reached through a symbolic link builds,
    // mutates, and checks normally ---
    await withWorkspace(
      { files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/A.mdx": A_MDX } },
      async (workspace) => {
        // The link lives beside the real root (outside the workspace) and
        // resolves to it; the product is invoked with the link path as its
        // working directory and as PWD (module header).
        const linkCwd = path.join(workspace.tempRoot, "link-work");
        await fsp.symlink("work", linkCwd, "dir");

        const runViaLink = async (
          argv: readonly string[],
          what: string,
        ): Promise<void> => {
          const result = await runProduct(product, {
            cwd: linkCwd,
            argv,
            env: { PWD: linkCwd },
          });
          assertExitCode(
            result,
            0,
            `T13.4-6 (above-root symlink) ${what}: path components above ` +
              `the workspace root are unrestricted — the command behaves ` +
              `normally (SPEC 13.4)`,
          );
        };

        await runViaLink(["build"], "`build`");
        if ((await workspace.kind("specs/A.xspec.ts")) !== "file") {
          fail(
            "T13.4-6 (above-root symlink): `build` through the linked " +
              "working directory must land the generated module in the " +
              "real workspace root (SPEC 13.4, 13.1)",
          );
        }
        await runViaLink(
          ["rename", A_ROOT, "a", "a2"],
          "`rename specs/A.mdx a a2`",
        );
        if ((await workspace.kind(JOURNAL_REL)) !== "file") {
          fail(
            "T13.4-6 (above-root symlink): the journaled rename through " +
              "the linked working directory must append the journal in the " +
              "real workspace root (SPEC 13.4, 6.1)",
          );
        }
        await runViaLink(["check"], "`check`");
      },
    );
  },
});

/** TEST-SPEC §13.4, in canonical ID order (SUITE-47). */
export const section134Tests: readonly ProductTestEntry[] = [
  T13_4_1,
  T13_4_2,
  T13_4_3,
  T13_4_4,
  T13_4_5,
  T13_4_6,
];
