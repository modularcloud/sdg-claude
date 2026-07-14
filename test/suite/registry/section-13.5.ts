// TEST-SPEC §13.5 (concurrency and isolation) — SUITE-48: T13.5-1 (hold-seam
// basics: five held mutating-command arms, the occupied-hold-path exit-2
// arms, and the non-mutating unknown-flag arm), T13.5-2 (mutual exclusion),
// T13.5-3 (exclusivity ends with the process), T13.5-4 (readers during
// mutation + build/query storm), T13.5-5 (atomic visibility via a polling
// reader), T13.5-6 (workspace isolation), T13.5-7 (interrupted mutation:
// held-point kill and a post-release kill-timing spread with the disjunctive
// `check` assertion).
//
// All mutual-exclusion choreography goes through the `--test-hold <path>`
// seam (SPEC 13.5) via the subprocess driver's background-start, hold-file,
// and kill support (helpers/subprocess.ts, HARNESS-02). Hold paths live in
// the workspace's tempRoot — outside the workspace root — so whole-root byte
// snapshots never see them; `--test-hold` resolves against the working
// directory (SPEC 12.0; T12.0-5), so the absolute path is exact.
//
// CERTIFICATIONS.md staging constraints (binding; T13.5-1…T13.5-5 are
// §CONF-CORE in-scope):
// - Every mutating command these tests drive is `rename`, file-form `move`
//   (never the section form), or a mutating `review` subcommand with
//   `create` under `--strategy audit` (§CONF-CORE), and the in-scope
//   fixtures stay in CONF-CORE's workspace shape: one spec group of
//   importless, tagless `.mdx` sources; no `code`, `markdown`, `coverage`,
//   or `policy` keys; no git.
// - T13.5-2's excluded commands carry no `--test-hold` (§VIOL-CORE-NOLOCK),
//   and its modifies-nothing compare brackets each excluded command alone,
//   with the baseline snapshot taken while command 1 is already held
//   (§VIOL-CORE-EARLYWRITE).
// - T13.5-3's subsequent mutating command succeeds whether or not the killed
//   operation's writes landed — `rename specs/A.mdx g g2`, independent of
//   the killed `a`→`a2` and never a retry of it (§VIOL-CORE-EARLYWRITE).
// - T13.5-4's storm arm asserts termination only — the storm commands' exit
//   codes are deliberately unasserted — plus the final `build`'s
//   byte-equality to a clean build; its held-phase reads run while the
//   mutator is held (§VIOL-CORE-PARTIALWRITE's expected-failure analysis
//   depends on exactly this shape).
//
// Conservative operationalizations (noted per H-3/H-4):
// - "Proceeds only once the file is deleted" (T13.5-1): the deterministic
//   check is the whole-root byte snapshot while held (nothing modified) —
//   certified via VIOL-CORE-EARLYWRITE — plus: the process is still running
//   after that snapshot's full-tree read completes, and exits 0 only after
//   the harness deletes the hold file.
// - "Fails promptly" (T13.5-1 occupied path, T13.5-2): a bounded foreground
//   run — a product that blocks instead of failing is killed at the bound
//   and fails diagnosed (H-8; the bound is a hang guard, never an assertion
//   input, H-10) — and for T13.5-2 the excluded command's exit is observed
//   while command 1 is still held (asserted: command 1 has not exited).
// - "Observe the prior state" (T13.5-4): each read command's exit code and
//   stdout bytes while the rename is held equal the same invocation's from
//   before the rename started (SPEC 12.0 byte-determinism: identical
//   workspace bytes, identical answers).
// - "Never a partial file" (T13.5-5): every distinct content the polling
//   reader observes must byte-equal one of the completed builds' contents
//   for the polled path (the set of post-build reads), and no absence may
//   be observed after content has been observed or after the first build
//   completed. A build's "new content" is thus its completed content — the
//   only enumerable reading of "prior content, complete new content, or
//   absence-before-first-write" from the observer side.
// - T13.5-6 stages two *differing* workspaces (different file names, IDs,
//   and texts), so cross-workspace interference cannot cancel out: a
//   held-overlap probe (workspace 2's mutating command succeeds while
//   workspace 1's is held — exclusion is per workspace) plus a
//   concurrent-vs-serial compare of a six-command script (per-step exit
//   codes and stdout bytes, and the final workspace trees, H-6
//   two-directory style).
// - T13.5-7's kill-timing spread is a fixed delay list — kill scheduling is
//   choreography, never an assertion input (H-10); the operative assertion
//   is delay-independent and disjunctive exactly as specified: after a
//   post-release kill, `check` exits 0 or 1 (never a signal death, never
//   another code — the configuration is intact, so the exit-2 class is not
//   stageable), and after a held-point kill it exits 0 (the hold precedes
//   all modification).

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  SessionStatusReport,
  SessionStatusRow,
} from "../../helpers/adapters/index.js";
import { decodeSessionStatusReport } from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  describeByteDifference,
  fail,
  HarnessAssertionError,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  assertDirectoriesEqual,
  assertLeavesUnchanged,
  assertSnapshotsEqual,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import type {
  ProductBinding,
  RunningProduct,
  RunResult,
} from "../../helpers/subprocess.js";
import {
  pathExists,
  releaseHoldFile,
  runProduct,
  startProduct,
  summarizeResult,
} from "../../helpers/subprocess.js";
import type { WorkspaceDecl } from "../../helpers/workspace.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk, expectExit, runCli, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group, no
// other keys — the CONF-CORE workspace shape (CERTIFICATIONS.md).
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// Importless, tagless `.mdx` source (the CONF-CORE shape): `a` carries a
// child so `rename` rewrites a descendant and `review split` has a child
// subtree; `g` is a second top-level leaf whose audit item is unblocked
// (SPEC 10.6).
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

const CORE_DECL: WorkspaceDecl = {
  files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/A.mdx": A_MDX },
};

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

/**
 * An absolute hold-file path in the workspace's temporary directory — beside
 * the workspace root, never inside it, so whole-root byte snapshots are
 * unaffected and disposal cleans it up.
 */
function holdPathFor(workspace: TestWorkspace, name: string): string {
  return path.join(workspace.tempRoot, name);
}

/**
 * Await the hold file's appearance, converting the driver's diagnosed
 * rejection (the process exited first, or the wait timed out) into a
 * diagnosed assertion failure (H-8).
 */
async function awaitHoldFile(
  running: RunningProduct,
  absPath: string,
  context: string,
): Promise<void> {
  try {
    await running.waitForFile(absPath);
  } catch (error) {
    fail(
      `${context}: the mutating command must create the hold file at ` +
        `${absPath} immediately after acquiring workspace exclusivity and ` +
        `before modifying anything (SPEC 13.5) — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The hold file must be an empty plain file ("creates an empty file"). */
async function assertEmptyHoldFile(
  absPath: string,
  context: string,
): Promise<void> {
  let stats;
  try {
    stats = await fsp.lstat(absPath);
  } catch (error) {
    return fail(
      `${context}: the hold file at ${absPath} must exist while held (SPEC ` +
        `13.5) — ${(error as Error).message}`,
    );
  }
  if (!stats.isFile()) {
    fail(
      `${context}: the hold file at ${absPath} must be a plain file (SPEC ` +
        `13.5: the command creates an empty file at the path)`,
    );
  }
  if (stats.size !== 0) {
    fail(
      `${context}: the hold file at ${absPath} must be empty (SPEC 13.5); ` +
        `found ${String(stats.size)} bytes`,
    );
  }
}

/** One-line outcome of a settled run, for premature-exit diagnoses. */
async function describeExit(running: RunningProduct): Promise<string> {
  try {
    return summarizeResult(await running.waitForExit());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Run a command to completion under a bound, converting a rejection (a
 * product that blocks or hangs instead of exiting, killed at the bound) into
 * a diagnosed assertion failure (H-8). The bound is a hang guard, never an
 * assertion input (H-10).
 */
async function runBounded(
  product: ProductBinding,
  cwd: string,
  argv: readonly string[],
  context: string,
  timeoutMs = 15_000,
): Promise<RunResult> {
  try {
    return await runProduct(product, { cwd, argv, timeoutMs });
  } catch (error) {
    return fail(
      `${context}: the command must terminate on its own rather than block ` +
        `or hang (SPEC 13.5, 12.0; H-8: hangs become diagnosed failures) — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
// T13.5-1 — hold seam basics
// ---------------------------------------------------------------------------

const T13_5_1 = defineProductTest({
  id: "T13.5-1",
  title:
    "each mutating command (`rename`, file-form `move`, `review create/resolve/split`) with `--test-hold` creates an empty file at the path after acquiring exclusivity and before modifying anything (workspace byte-identical while held), proceeds only once the file is deleted, and completes normally; anything at the hold path — file, directory, or symlink — fails the command exit 2 without modifying anything; `build` and `query` given `--test-hold` fail exit 2 as an unknown flag (SPEC 13.5, 12.0)",
  run: async (product) => {
    await withWorkspace(CORE_DECL, async (workspace) => {
      await buildOk(product, workspace, "T13.5-1 staging `build`");

      let armIndex = 0;
      const heldArm = async (
        argv: readonly string[],
        what: string,
        onCompleted: () => Promise<void>,
      ): Promise<void> => {
        armIndex += 1;
        const hold = holdPathFor(workspace, `hold-${String(armIndex)}.tmp`);
        const context = `T13.5-1 (held ${what})`;
        const before = await snapshotDirectory(workspace.root);
        const running = await startProduct(product, {
          cwd: workspace.root,
          argv: [...argv, "--test-hold", hold],
        });
        try {
          await awaitHoldFile(running, hold, context);
          await assertEmptyHoldFile(hold, context);
          const whileHeld = await snapshotDirectory(workspace.root);
          assertSnapshotsEqual(
            before,
            whileHeld,
            `${context}: the workspace while held vs before the command ` +
              `started — the hold file is created after acquiring ` +
              `exclusivity and before modifying anything, so the workspace ` +
              `is byte-identical while held (SPEC 13.5)`,
          );
          if (running.hasExited()) {
            fail(
              `${context}: the command must proceed only once the hold file ` +
                `is deleted, but it exited while the hold file still ` +
                `existed (SPEC 13.5) — ${await describeExit(running)}`,
            );
          }
          await releaseHoldFile(hold);
          let result: RunResult;
          try {
            result = await running.waitForExit();
          } catch (error) {
            return fail(
              `${context}: once the hold file is deleted the command must ` +
                `proceed and complete normally (SPEC 13.5) — ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          assertExitCode(
            result,
            0,
            `${context}: completes normally once the hold file is deleted ` +
              `(SPEC 13.5)`,
          );
          await onCompleted();
        } finally {
          running.kill();
          await releaseHoldFile(hold);
        }
      };

      // Arm 1 — `review create` (audit strategy per §CONF-CORE).
      await heldArm(
        ["review", "create", "--strategy", "audit", "--name", "s"],
        "`review create --strategy audit --name s`",
        async () => {
          const kind = await workspace.kind(sessionRel("s"));
          if (kind !== "file") {
            fail(
              "T13.5-1 (held `review create`): after completing normally, " +
                `the session file exists as a plain file at ` +
                `${sessionRel("s")} (SPEC 10.1); found ${kind}`,
            );
          }
        },
      );

      // Arm 2 — `rename`.
      await heldArm(
        ["rename", "specs/A.mdx", "a", "a2"],
        "`rename specs/A.mdx a a2`",
        async () => {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(
            await workspace.readBytes("specs/A.mdx"),
          );
          if (!text.includes('id="a2"')) {
            fail(
              "T13.5-1 (held `rename`): after completing normally, " +
                'specs/A.mdx carries the renamed id="a2" (SPEC 6.4)',
            );
          }
        },
      );

      // Arm 3 — file-form `move` (never the section form, §CONF-CORE).
      await heldArm(
        ["move", "specs/A.mdx", "specs/Moved.mdx"],
        "`move specs/A.mdx specs/Moved.mdx`",
        async () => {
          const moved = await workspace.kind("specs/Moved.mdx");
          const original = await workspace.kind("specs/A.mdx");
          if (moved !== "file" || original !== "absent") {
            fail(
              "T13.5-1 (held `move`): after completing normally, the file " +
                `moved — specs/Moved.mdx is a plain file (found ${moved}) ` +
                `and specs/A.mdx is absent (found ${original}) (SPEC 6.5)`,
            );
          }
        },
      );

      // Arms 4 and 5 need item IDs: read them once — identities are
      // presented under the current (post-rename, post-move) identity
      // (SPEC 10.4).
      const status = await sessionStatus(
        product,
        workspace,
        "s",
        "T13.5-1 item lookup",
      );
      const gItem = requireRowByScope(
        status,
        "specs/Moved.mdx#g",
        "T13.5-1 item lookup (leaf item)",
      );
      const aItem = requireRowByScope(
        status,
        "specs/Moved.mdx#a2",
        "T13.5-1 item lookup (parent item)",
      );

      // Arm 4 — `review resolve` (the unblocked leaf item, SPEC 10.6).
      await heldArm(
        ["review", "resolve", "s", gItem.id, "--status", "no-change"],
        "`review resolve s <leaf item> --status no-change`",
        async () => Promise.resolve(),
      );

      // Arm 5 — `review split` (the parent item's scope root has a child,
      // SPEC 10.7).
      await heldArm(
        ["review", "split", "s", aItem.id],
        "`review split s <parent item>`",
        async () => Promise.resolve(),
      );

      // Occupied hold path: anything at the path — a file, directory, or
      // symbolic link (staged dangling: a create that follows the link
      // instead of failing would succeed) — fails the command exit 2
      // without modifying anything. `rename` is the representative mutating
      // command; the workspace state is untouched by every refusal, so the
      // arms chain.
      const occupants: readonly {
        readonly kind: string;
        readonly stage: (abs: string) => Promise<void>;
        readonly verifyUntouched: (abs: string) => Promise<void>;
      }[] = [
        {
          kind: "file",
          stage: async (abs) => {
            await fsp.writeFile(abs, "occupant bytes\n");
          },
          verifyUntouched: async (abs) => {
            assertBytesEqual(
              await fsp.readFile(abs),
              "occupant bytes\n",
              "T13.5-1 (occupied by a file): the occupant's bytes after " +
                "the refusal — untouched (SPEC 13.5: creation fails; " +
                "nothing is modified)",
            );
          },
        },
        {
          kind: "directory",
          stage: async (abs) => {
            await fsp.mkdir(abs);
          },
          verifyUntouched: async (abs) => {
            const stats = await fsp.lstat(abs);
            if (!stats.isDirectory()) {
              fail(
                "T13.5-1 (occupied by a directory): the occupant after the " +
                  "refusal must still be a directory (SPEC 13.5)",
              );
            }
          },
        },
        {
          kind: "symlink",
          stage: async (abs) => {
            await fsp.symlink("dangling-hold-target", abs);
          },
          verifyUntouched: async (abs) => {
            const stats = await fsp.lstat(abs);
            if (!stats.isSymbolicLink()) {
              fail(
                "T13.5-1 (occupied by a symlink): the occupant after the " +
                  "refusal must still be a symbolic link — creation fails " +
                  "if anything, a symbolic link included, exists at the " +
                  "path (SPEC 13.5)",
              );
            }
            const target = await fsp.readlink(abs);
            if (target !== "dangling-hold-target") {
              fail(
                "T13.5-1 (occupied by a symlink): the link's target after " +
                  `the refusal — untouched (SPEC 13.5); got ` +
                  `${JSON.stringify(target)}`,
              );
            }
            if (
              await pathExists(
                path.join(workspace.tempRoot, "dangling-hold-target"),
              )
            ) {
              fail(
                "T13.5-1 (occupied by a symlink): nothing may be created " +
                  "through the dangling link — creation must fail on the " +
                  "occupied path itself (SPEC 13.5)",
              );
            }
          },
        },
      ];
      for (const occupant of occupants) {
        const abs = holdPathFor(workspace, `occupied-${occupant.kind}`);
        await occupant.stage(abs);
        const context = `T13.5-1 (hold path occupied by a ${occupant.kind}) \`rename specs/Moved.mdx a2 a3 --test-hold <occupied>\``;
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const result = await runBounded(
              product,
              workspace.root,
              ["rename", "specs/Moved.mdx", "a2", "a3", "--test-hold", abs],
              context,
            );
            assertExitCode(
              result,
              2,
              `${context}: the hold file cannot be created, so the command ` +
                `fails with a usage error (SPEC 13.5, 12.0)`,
            );
          },
          `${context}: fails without modifying anything (SPEC 13.5)`,
        );
        await occupant.verifyUntouched(abs);
      }

      // Non-mutating commands: `--test-hold` is an unknown flag — 13.5
      // grants the seam to mutating commands alone, and unknown flags are
      // usage errors (12.0). The workspace sits at a built fixed point, so
      // the exit code and hold-file absence carry the arm (a flag-accepting
      // `build` would rewrite identical bytes — but it would also create the
      // hold file and wait, failing the bounded run or the absence check).
      const nonMutating: readonly (readonly [readonly string[], string])[] = [
        [["build"], "`build`"],
        [["query", "nodes"], "`query nodes`"],
      ];
      for (const [argv, what] of nonMutating) {
        const abs = holdPathFor(
          workspace,
          `nonmutating-${argv.join("-").replace(/[^a-z]/g, "")}`,
        );
        const context = `T13.5-1 (non-mutating ${what} given --test-hold)`;
        await assertLeavesUnchanged(
          workspace.root,
          async () => {
            const result = await runBounded(
              product,
              workspace.root,
              [...argv, "--test-hold", abs],
              context,
            );
            assertExitCode(
              result,
              2,
              `${context}: 13.5 grants the seam to mutating commands ` +
                `alone, so --test-hold on ${what} is an unknown flag — a ` +
                `usage error (SPEC 13.5, 12.0)`,
            );
            if (await pathExists(abs)) {
              fail(
                `${context}: no hold file may be created at the path — the ` +
                  `flag is refused, not honored (SPEC 13.5, 12.0)`,
              );
            }
          },
          `${context}: the usage error modifies nothing (SPEC 12.0)`,
        );
      }
    });
  },
});

// ---------------------------------------------------------------------------
// T13.5-2 — mutual exclusion
// ---------------------------------------------------------------------------

const T13_5_2 = defineProductTest({
  id: "T13.5-2",
  title:
    "while a mutating command is held, each other mutating command (`rename`, file-form `move`, `review create/resolve/split`) fails promptly with exit 2 and modifies nothing — journal, sessions, and sources byte-identical, the compare bracketing each excluded command alone with its baseline taken while command 1 is already held; after command 1 completes, the second command succeeds (SPEC 13.5, 12.0)",
  run: async (product) => {
    await withWorkspace(CORE_DECL, async (workspace) => {
      await buildOk(product, workspace, "T13.5-2 staging `build`");
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "s"],
        0,
        "T13.5-2 staging `review create --strategy audit --name s`",
      );
      const status = await sessionStatus(
        product,
        workspace,
        "s",
        "T13.5-2 staging",
      );
      const gItem = requireRowByScope(
        status,
        "specs/A.mdx#g",
        "T13.5-2 staging (leaf item)",
      );
      const aItem = requireRowByScope(
        status,
        "specs/A.mdx#a",
        "T13.5-2 staging (parent item)",
      );

      const hold = holdPathFor(workspace, "hold-primary.tmp");
      const context1 =
        "T13.5-2 command 1 `rename specs/A.mdx a a2 --test-hold <path>`";
      const running = await startProduct(product, {
        cwd: workspace.root,
        argv: ["rename", "specs/A.mdx", "a", "a2", "--test-hold", hold],
      });
      try {
        await awaitHoldFile(running, hold, context1);
        // Staging constraint (§VIOL-CORE-EARLYWRITE): the baseline snapshot
        // is taken while command 1 is already held, so each excluded
        // command's compare brackets that command alone.
        const heldBaseline = await snapshotDirectory(workspace.root);

        // Each other mutating command, valid in its own right (so exit 2 is
        // attributable to the exclusion alone) and carrying no --test-hold
        // (§VIOL-CORE-NOLOCK staging constraint).
        const excluded: readonly (readonly [readonly string[], string])[] = [
          [["rename", "specs/A.mdx", "g", "g2"], "`rename specs/A.mdx g g2`"],
          [
            ["move", "specs/A.mdx", "specs/B.mdx"],
            "`move specs/A.mdx specs/B.mdx`",
          ],
          [
            ["review", "create", "--strategy", "audit", "--name", "t"],
            "`review create --strategy audit --name t`",
          ],
          [
            ["review", "resolve", "s", gItem.id, "--status", "no-change"],
            "`review resolve s <leaf item> --status no-change`",
          ],
          [
            ["review", "split", "s", aItem.id],
            "`review split s <parent item>`",
          ],
        ];
        for (const [argv, what] of excluded) {
          const context = `T13.5-2 excluded ${what} while command 1 is held`;
          const result = await runBounded(
            product,
            workspace.root,
            argv,
            context,
          );
          assertExitCode(
            result,
            2,
            `${context}: a mutating command refused because another is ` +
              `running is a usage error (SPEC 13.5, 12.0)`,
          );
          if (running.hasExited()) {
            fail(
              `${context}: command 1 must still be held when the excluded ` +
                `command exits — the refusal is prompt, not a wait for ` +
                `command 1 (SPEC 13.5) — ${await describeExit(running)}`,
            );
          }
          const now = await snapshotDirectory(workspace.root);
          assertSnapshotsEqual(
            heldBaseline,
            now,
            `${context}: modifies nothing — journal, sessions, and sources ` +
              `byte-identical (SPEC 13.5)`,
          );
        }

        await releaseHoldFile(hold);
        let result1: RunResult;
        try {
          result1 = await running.waitForExit();
        } catch (error) {
          return fail(
            `${context1}: command 1 must complete normally once the hold ` +
              `file is deleted (SPEC 13.5) — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        assertExitCode(
          result1,
          0,
          `${context1}: completes normally after release, so the exclusions ` +
            `above are attributable to the held command alone (SPEC 13.5)`,
        );
      } finally {
        running.kill();
        await releaseHoldFile(hold);
      }

      // After command 1 completes, the second command succeeds.
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "t"],
        0,
        "T13.5-2 `review create --strategy audit --name t` after command 1 " +
          "completed — exclusivity ended with normal completion (SPEC 13.5)",
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T13.5-3 — exclusivity ends with the process
// ---------------------------------------------------------------------------

const T13_5_3 = defineProductTest({
  id: "T13.5-3",
  title:
    "killing a held mutating command never blocks later commands: a subsequent mutating command — one that succeeds whether or not the killed operation's writes landed, not a retry of it — exits 0 (SPEC 13.5)",
  run: async (product) => {
    await withWorkspace(CORE_DECL, async (workspace) => {
      await buildOk(product, workspace, "T13.5-3 staging `build`");

      const hold = holdPathFor(workspace, "hold-killed.tmp");
      const context1 =
        "T13.5-3 held `rename specs/A.mdx a a2 --test-hold <path>`";
      const running = await startProduct(product, {
        cwd: workspace.root,
        argv: ["rename", "specs/A.mdx", "a", "a2", "--test-hold", hold],
      });
      try {
        await awaitHoldFile(running, hold, context1);
        running.kill("SIGKILL");
        // The kill settles the run; the death's shape is not asserted.
        await running.waitForExit();
      } finally {
        running.kill();
        // Deliberately no hold-file cleanup before the subsequent command:
        // everything the terminated holder left behind stays exactly as the
        // kill left it — a terminated holder never blocks (SPEC 13.5).
      }

      const context2 =
        "T13.5-3 subsequent `rename specs/A.mdx g g2` after the holder was " +
        "killed";
      const result = await runBounded(
        product,
        workspace.root,
        ["rename", "specs/A.mdx", "g", "g2"],
        context2,
      );
      assertExitCode(
        result,
        0,
        `${context2}: a terminated holder never blocks — the subsequent ` +
          `mutating command succeeds whether or not the killed operation's ` +
          `writes landed (SPEC 13.5; it renames \`g\`, independent of the ` +
          `killed \`a\`→\`a2\`, never a retry of it)`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T13.5-4 — readers during mutation; build/query storm
// ---------------------------------------------------------------------------

/** How many of each command the storm launches concurrently. */
const STORM_BUILDS = 4;
const STORM_QUERIES = 4;

const T13_5_4 = defineProductTest({
  id: "T13.5-4",
  title:
    "while a mutating command is held, read commands still run and observe the prior state (exit codes and stdout bytes equal the pre-hold runs); non-mutating commands run concurrently with each other — a parallel build/query storm on one workspace terminates, and one final `build` resolves any derived-file inconsistency, byte-equal to a clean build (SPEC 13.5, 12.0)",
  run: async (product) => {
    // --- Held-phase reads: prior state ---
    await withWorkspace(CORE_DECL, async (workspace) => {
      await buildOk(product, workspace, "T13.5-4 staging `build`");
      await expectExit(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "s"],
        0,
        "T13.5-4 staging `review create --strategy audit --name s`",
      );

      // Representative read commands over the 13.3 read surface (§CONF-CORE).
      const reads: readonly (readonly [readonly string[], string])[] = [
        [["check"], "`check`"],
        [["ids", "--json"], "`ids --json`"],
        [["show", "specs/A.mdx#a", "--json"], "`show specs/A.mdx#a --json`"],
        [["query", "nodes"], "`query nodes`"],
        [["coverage", "--json"], "`coverage --json`"],
        [["review", "list", "--json"], "`review list --json`"],
      ];
      const before = new Map<string, RunResult>();
      for (const [argv, what] of reads) {
        const result = await runCli(product, workspace, argv);
        assertExitCode(result, 0, `T13.5-4 pre-hold ${what}`);
        before.set(what, result);
      }

      const hold = holdPathFor(workspace, "hold-reads.tmp");
      const contextHeld =
        "T13.5-4 held `rename specs/A.mdx a a2 --test-hold <path>`";
      const running = await startProduct(product, {
        cwd: workspace.root,
        argv: ["rename", "specs/A.mdx", "a", "a2", "--test-hold", hold],
      });
      try {
        await awaitHoldFile(running, hold, contextHeld);
        for (const [argv, what] of reads) {
          const context = `T13.5-4 ${what} while the rename is held`;
          const result = await runBounded(
            product,
            workspace.root,
            argv,
            context,
          );
          assertExitCode(
            result,
            0,
            `${context}: read commands still run while a mutating command ` +
              `is held (SPEC 13.5)`,
          );
          const reference = before.get(what);
          if (reference === undefined) {
            throw new Error(`T13.5-4 internal error: no pre-hold ${what}`);
          }
          assertBytesEqual(
            result.stdoutBytes,
            reference.stdoutBytes,
            `${context}: observes the prior state — stdout byte-identical ` +
              `to the same read before the mutation started (SPEC 13.5; ` +
              `12.0 byte-determinism: identical workspace bytes, identical ` +
              `answers)`,
          );
        }
        await releaseHoldFile(hold);
        let result: RunResult;
        try {
          result = await running.waitForExit();
        } catch (error) {
          return fail(
            `${contextHeld}: the held rename must complete normally once ` +
              `the hold file is deleted (SPEC 13.5) — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        assertExitCode(
          result,
          0,
          `${contextHeld}: completes normally after release, so the ` +
            `held-phase observations are attributable to the hold (SPEC 13.5)`,
        );
      } finally {
        running.kill();
        await releaseHoldFile(hold);
      }
    });

    // --- Storm: non-mutating commands run concurrently with each other ---
    const storm = await TestWorkspace.create(CORE_DECL);
    const reference = await TestWorkspace.create(CORE_DECL);
    try {
      await buildOk(product, storm, "T13.5-4 storm workspace initial `build`");

      const stormCommands: readonly string[][] = [
        ...Array.from({ length: STORM_BUILDS }, () => ["build"]),
        ...Array.from({ length: STORM_QUERIES }, () => ["query", "nodes"]),
      ];
      const started: RunningProduct[] = [];
      try {
        for (const argv of stormCommands) {
          started.push(await startProduct(product, { cwd: storm.root, argv }));
        }
        const settled = await Promise.allSettled(
          started.map((running) => running.waitForExit()),
        );
        settled.forEach((outcome, index) => {
          if (outcome.status === "rejected") {
            const reason = outcome.reason as unknown;
            fail(
              `T13.5-4 storm: every concurrent non-mutating command must ` +
                `terminate (SPEC 13.5; the storm asserts termination — ` +
                `exit codes deliberately unasserted); ` +
                `\`${(stormCommands[index] ?? []).join(" ")}\` did not — ` +
                `${reason instanceof Error ? reason.message : String(reason)}`,
            );
          }
        });
      } finally {
        for (const running of started) {
          running.kill();
        }
      }

      // Any derived-file inconsistency is resolved by one final `build`,
      // byte-equal to a clean build of the identical fixture (H-6
      // two-directory style).
      await buildOk(
        product,
        storm,
        "T13.5-4 final `build` after the storm (SPEC 13.5, 12.1)",
      );
      await buildOk(product, reference, "T13.5-4 clean reference `build`");
      await assertDirectoriesEqual(
        storm.root,
        reference.root,
        "T13.5-4: the storm workspace after one final `build` vs a clean " +
          "build of the identical fixture — any derived-file inconsistency " +
          "is resolved, byte-equal to a clean build (SPEC 13.5, 12.0)",
      );
    } finally {
      await storm.dispose();
      await reference.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T13.5-5 — atomic visibility
// ---------------------------------------------------------------------------

const POLL_FILE = "specs/P.mdx";
const POLL_MODULE = "specs/P.xspec.ts";
const POLL_TEXT_ONE = "Poll text state one.";
const POLL_TEXT_TWO =
  "A considerably longer poll text for state two, differing from the very " +
  "first byte on.";
/** Alternating builds after the first (property-style loop, TEST-SPEC 16). */
const POLL_ALTERNATIONS = 10;

function pollSource(text: string): string {
  return ['<S id="p">', text, "</S>", ""].join("\n");
}

const T13_5_5 = defineProductTest({
  id: "T13.5-5",
  title:
    "a concurrent reader polling a derived file during repeated builds only ever observes prior content, complete new content, or absence-before-first-write — never a partial file (SPEC 13.5; property-style loop, TEST-SPEC 16)",
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          [POLL_FILE]: pollSource(POLL_TEXT_ONE),
        },
      },
      async (workspace) => {
        const moduleAbs = workspace.path(POLL_MODULE);

        // The polling reader: a tight read loop recording every distinct
        // observed content (deduplicated byte-exactly) and the absence
        // bookkeeping the validation rules need. It never throws — errors
        // are recorded and diagnosed after the loop (H-8).
        let stop = false;
        let observationCount = 0;
        let firstContentIndex = -1;
        let lastAbsentIndex = -1;
        let pollError: string | undefined;
        const distinctContents = new Map<
          string,
          { readonly bytes: Uint8Array; readonly firstIndex: number }
        >();
        const poller = (async () => {
          while (!stop) {
            const index = observationCount;
            observationCount += 1;
            try {
              const bytes: Uint8Array = await fsp.readFile(moduleAbs);
              if (firstContentIndex === -1) firstContentIndex = index;
              const key = Buffer.from(bytes).toString("latin1");
              if (!distinctContents.has(key)) {
                distinctContents.set(key, { bytes, firstIndex: index });
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                lastAbsentIndex = index;
              } else {
                pollError ??= `observation #${String(index)}: ${(error as Error).message}`;
              }
            }
            await sleep(1);
          }
        })();

        // The legitimate complete contents: the polled path's bytes after
        // each completed build (SPEC 12.0 byte-determinism makes each state's
        // content a fixed point, so the set has one entry per distinct
        // source state).
        const legit = new Map<string, Uint8Array>();
        let buildOneDoneCount = 0;
        try {
          const buildAndRecord = async (label: string): Promise<void> => {
            await buildOk(product, workspace, label);
            const kind = await workspace.kind(POLL_MODULE);
            if (kind !== "file") {
              fail(
                `${label}: staging premise — \`build\` generates ` +
                  `${POLL_MODULE} as a plain file (SPEC 13.1); found ${kind}`,
              );
            }
            const bytes = await workspace.readBytes(POLL_MODULE);
            legit.set(Buffer.from(bytes).toString("latin1"), bytes);
          };

          await buildAndRecord("T13.5-5 `build` #1 (state one)");
          buildOneDoneCount = observationCount;
          for (let i = 0; i < POLL_ALTERNATIONS; i += 1) {
            const stateTwo = i % 2 === 0;
            await workspace.file(
              POLL_FILE,
              pollSource(stateTwo ? POLL_TEXT_TWO : POLL_TEXT_ONE),
            );
            await buildAndRecord(
              `T13.5-5 \`build\` #${String(i + 2)} (state ${stateTwo ? "two" : "one"})`,
            );
          }
        } finally {
          stop = true;
          await poller;
        }

        if (pollError !== undefined) {
          fail(
            `T13.5-5: the polling reader hit an unexpected filesystem ` +
              `error — ${pollError}`,
          );
        }
        if (observationCount === 0 || firstContentIndex === -1) {
          fail(
            "T13.5-5 staging premise: the polling reader must observe the " +
              "derived file during the builds (it recorded " +
              `${String(observationCount)} observations, first content at ` +
              `#${String(firstContentIndex)}) — the polling cadence or the ` +
              "build staging is broken",
          );
        }

        // Rule 1: every distinct observed content is a completed build's
        // content — never a partial file.
        for (const [key, observed] of distinctContents) {
          if (legit.has(key)) continue;
          const completeSizes = [...legit.values()]
            .map((bytes) => String(bytes.length))
            .join(", ");
          let nearest: Uint8Array | undefined;
          for (const candidate of legit.values()) {
            if (
              nearest === undefined ||
              Math.abs(candidate.length - observed.bytes.length) <
                Math.abs(nearest.length - observed.bytes.length)
            ) {
              nearest = candidate;
            }
          }
          fail(
            `T13.5-5: observation #${String(observed.firstIndex)} of ` +
              `${POLL_MODULE} matches no completed build's content — a ` +
              `concurrent reader only ever observes prior content or ` +
              `complete new content, never a partial file (SPEC 13.5). ` +
              `Observed ${String(observed.bytes.length)} bytes; completed ` +
              `contents have ${completeSizes} bytes.` +
              (nearest === undefined
                ? ""
                : `\n${describeByteDifference(observed.bytes, nearest, "observed", "complete")}`),
          );
        }
        // Rule 2: no absence after content has been observed.
        if (lastAbsentIndex > firstContentIndex) {
          fail(
            `T13.5-5: the polling reader observed absence at observation ` +
              `#${String(lastAbsentIndex)}, after first observing content ` +
              `at #${String(firstContentIndex)} — once the first write ` +
              `lands, the path holds prior or new content at every moment, ` +
              `never absence (SPEC 13.5)`,
          );
        }
        // Rule 3: no absence after the first build completed.
        if (lastAbsentIndex >= buildOneDoneCount) {
          fail(
            `T13.5-5: the polling reader observed absence at observation ` +
              `#${String(lastAbsentIndex)}, after the first \`build\` had ` +
              `already completed (observation count ` +
              `${String(buildOneDoneCount)} at completion) — absence is ` +
              `legal only before the first write (SPEC 13.5)`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T13.5-6 — workspace isolation
// ---------------------------------------------------------------------------

// The second workspace differs from the first in file name, IDs, and texts,
// so cross-workspace interference cannot cancel out.
const ISO_TWO_MDX = [
  '<S id="b">',
  "Bravo isolated text.",
  '<S id="b.k">',
  "Bravo kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="h">',
  "Hotel isolated text.",
  "</S>",
  "",
].join("\n");

const ISO_TWO_DECL: WorkspaceDecl = {
  files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/B.mdx": ISO_TWO_MDX },
};

interface ScriptStep {
  readonly argv: readonly string[];
  readonly what: string;
}

/** The six-command scenario each "harness instance" drives. */
function scriptSteps(file: string, top: string): readonly ScriptStep[] {
  return [
    { argv: ["build"], what: "`build`" },
    {
      argv: ["review", "create", "--strategy", "audit", "--name", "s"],
      what: "`review create --strategy audit --name s`",
    },
    {
      argv: ["rename", file, top, `${top}2`],
      what: `\`rename ${file} ${top} ${top}2\``,
    },
    {
      argv: ["review", "status", "s", "--json"],
      what: "`review status s --json`",
    },
    { argv: ["ids", "--json"], what: "`ids --json`" },
    { argv: ["check"], what: "`check`" },
  ];
}

async function runScript(
  product: ProductBinding,
  workspace: TestWorkspace,
  steps: readonly ScriptStep[],
  contextPrefix: string,
): Promise<readonly RunResult[]> {
  const results: RunResult[] = [];
  for (const step of steps) {
    const result = await runCli(product, workspace, step.argv);
    assertExitCode(result, 0, `${contextPrefix} ${step.what}`);
    results.push(result);
  }
  return results;
}

const T13_5_6 = defineProductTest({
  id: "T13.5-6",
  title:
    "two workspaces driven concurrently by parallel harness instances never interfere: a mutating command in workspace 2 succeeds while workspace 1's is held (exclusion is per workspace), and a concurrently driven command script's outputs and final workspace trees equal serial runs (SPEC 13.5, H-1)",
  run: async (product) => {
    const stepsOne = scriptSteps("specs/A.mdx", "a");
    const stepsTwo = scriptSteps("specs/B.mdx", "b");
    const disposables: TestWorkspace[] = [];
    const create = async (decl: WorkspaceDecl): Promise<TestWorkspace> => {
      const workspace = await TestWorkspace.create(decl);
      disposables.push(workspace);
      return workspace;
    };
    try {
      // --- Held-overlap probe: exclusion is per workspace ---
      const heldOne = await create(CORE_DECL);
      const heldTwo = await create(ISO_TWO_DECL);
      await buildOk(product, heldOne, "T13.5-6 workspace 1 staging `build`");
      await buildOk(product, heldTwo, "T13.5-6 workspace 2 staging `build`");
      const hold = holdPathFor(heldOne, "hold-iso.tmp");
      const contextHeld =
        "T13.5-6 workspace 1 held `rename specs/A.mdx a a2 --test-hold <path>`";
      const running = await startProduct(product, {
        cwd: heldOne.root,
        argv: ["rename", "specs/A.mdx", "a", "a2", "--test-hold", hold],
      });
      try {
        await awaitHoldFile(running, hold, contextHeld);
        const context =
          "T13.5-6 `rename specs/B.mdx b b2` in workspace 2 while " +
          "workspace 1's rename is held";
        const result = await runBounded(
          product,
          heldTwo.root,
          ["rename", "specs/B.mdx", "b", "b2"],
          context,
        );
        assertExitCode(
          result,
          0,
          `${context}: instances operating on different workspaces never ` +
            `interfere — mutual exclusion is per workspace (SPEC 13.5, H-1)`,
        );
        if (running.hasExited()) {
          fail(
            `${context}: workspace 1's held command must still be running ` +
              `when workspace 2's completes — otherwise the success is not ` +
              `attributable to per-workspace exclusion (SPEC 13.5) — ` +
              `${await describeExit(running)}`,
          );
        }
        await releaseHoldFile(hold);
        let result1: RunResult;
        try {
          result1 = await running.waitForExit();
        } catch (error) {
          return fail(
            `${contextHeld}: workspace 1's rename must complete normally ` +
              `once the hold file is deleted (SPEC 13.5) — ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        assertExitCode(
          result1,
          0,
          `${contextHeld}: completes normally after release (SPEC 13.5)`,
        );
      } finally {
        running.kill();
        await releaseHoldFile(hold);
      }

      // --- Concurrent runs equal serial runs ---
      const serialOne = await create(CORE_DECL);
      const serialTwo = await create(ISO_TWO_DECL);
      const serialResultsOne = await runScript(
        product,
        serialOne,
        stepsOne,
        "T13.5-6 serial workspace 1",
      );
      const serialResultsTwo = await runScript(
        product,
        serialTwo,
        stepsTwo,
        "T13.5-6 serial workspace 2",
      );

      const concurrentOne = await create(CORE_DECL);
      const concurrentTwo = await create(ISO_TWO_DECL);
      const settled = await Promise.allSettled([
        runScript(
          product,
          concurrentOne,
          stepsOne,
          "T13.5-6 concurrent workspace 1",
        ),
        runScript(
          product,
          concurrentTwo,
          stepsTwo,
          "T13.5-6 concurrent workspace 2",
        ),
      ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          const reason = outcome.reason as unknown;
          if (reason instanceof HarnessAssertionError) throw reason;
          fail(
            `T13.5-6 concurrent phase: ` +
              `${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      }
      const [concurrentResultsOne, concurrentResultsTwo] = settled.map(
        (outcome) =>
          (outcome as PromiseFulfilledResult<readonly RunResult[]>).value,
      );

      const compareRuns = (
        concurrent: readonly RunResult[] | undefined,
        serial: readonly RunResult[],
        steps: readonly ScriptStep[],
        which: string,
      ): void => {
        if (concurrent === undefined) {
          throw new Error("T13.5-6 internal error: missing concurrent runs");
        }
        for (let i = 0; i < steps.length; i += 1) {
          const step = steps[i] as ScriptStep;
          assertBytesEqual(
            (concurrent[i] as RunResult).stdoutBytes,
            (serial[i] as RunResult).stdoutBytes,
            `T13.5-6 ${which} ${step.what}: the concurrently driven run's ` +
              `stdout equals the serial run's byte-for-byte — concurrent ` +
              `results equal serial runs (SPEC 13.5, 12.0)`,
          );
        }
      };
      compareRuns(
        concurrentResultsOne,
        serialResultsOne,
        stepsOne,
        "workspace 1",
      );
      compareRuns(
        concurrentResultsTwo,
        serialResultsTwo,
        stepsTwo,
        "workspace 2",
      );

      await assertDirectoriesEqual(
        concurrentOne.root,
        serialOne.root,
        "T13.5-6 workspace 1: the concurrently driven workspace's final " +
          "byte tree vs the serial run's — never interferes (SPEC 13.5, H-1)",
      );
      await assertDirectoriesEqual(
        concurrentTwo.root,
        serialTwo.root,
        "T13.5-6 workspace 2: the concurrently driven workspace's final " +
          "byte tree vs the serial run's — never interferes (SPEC 13.5, H-1)",
      );
    } finally {
      for (const workspace of disposables) {
        await workspace.dispose();
      }
    }
  },
});

// ---------------------------------------------------------------------------
// T13.5-7 — interrupted mutation
// ---------------------------------------------------------------------------

// A multi-file rename fixture (outside CONF-CORE's in-scope set, so imports
// and references are fine here): renaming `a` rewrites A.mdx (its own and
// descendant IDs), B.mdx (a `d` chain reference and a `text(...)` target),
// and C.mdx (a `d` chain reference), then regenerates modules, emitted
// Markdown, and graph data and appends the journal — a wide write set for
// the kill spread (SPEC 6.4, 13.5).
const MULTI_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

const MULTI_A = [
  '<S id="a">',
  "Alpha root text.",
  '<S id="a.k1">',
  "Kid one text.",
  "</S>",
  '<S id="a.k2">',
  "Kid two text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const MULTI_B = [
  'import A from "./A.xspec"',
  "",
  '<S id="b" d={A.a.k1}>',
  "Beta text embeds: {text(A.a.k2)}",
  "</S>",
  "",
].join("\n");

const MULTI_C = [
  'import A from "./A.xspec"',
  "",
  '<S id="c" d={A.a}>',
  "Ceta text.",
  "</S>",
  "",
].join("\n");

const MULTI_DECL: WorkspaceDecl = {
  files: {
    "xspec.config.ts": MULTI_CONFIG,
    "specs/A.mdx": MULTI_A,
    "specs/B.mdx": MULTI_B,
    "specs/C.mdx": MULTI_C,
  },
};

// Post-release kill delays in milliseconds — scheduling choreography only,
// never an assertion input (H-10): the operative assertion is
// delay-independent.
const KILL_DELAYS_MS: readonly number[] = [0, 2, 5, 10, 20, 40, 80, 160];

const T13_5_7 = defineProductTest({
  id: "T13.5-7",
  title:
    "a mutating command killed mid-operation can leave the workspace inconsistent and `check` reports such states rather than passing silently: a kill at the held point demonstrably leaves the workspace consistent (`check` passes), and across a spread of post-release kill timings on a multi-file `rename`, `check` never crashes and either passes on a consistent state or reports findings (SPEC 13.5, 14)",
  run: async (product) => {
    const probeKill = async (delayMs: number | null): Promise<void> => {
      const label =
        delayMs === null ? "held point" : `${String(delayMs)} ms after release`;
      await withWorkspace(MULTI_DECL, async (workspace) => {
        await buildOk(
          product,
          workspace,
          `T13.5-7 (${label}) staging \`build\``,
        );
        await expectExit(
          product,
          workspace,
          ["check"],
          0,
          `T13.5-7 (${label}) staging \`check\` — the staged workspace is ` +
            `consistent before the kill (SPEC 12.2)`,
        );

        const hold = holdPathFor(workspace, "hold-kill.tmp");
        const context = `T13.5-7 (${label}) \`rename specs/A.mdx a a2 --test-hold <path>\``;
        const running = await startProduct(product, {
          cwd: workspace.root,
          argv: ["rename", "specs/A.mdx", "a", "a2", "--test-hold", hold],
        });
        try {
          await awaitHoldFile(running, hold, context);
          if (delayMs === null) {
            // Held-point kill: the hold file is never deleted.
            running.kill("SIGKILL");
          } else {
            await releaseHoldFile(hold);
            if (delayMs > 0) await sleep(delayMs);
            running.kill("SIGKILL");
          }
          // The run settles for kills and for completions that beat the
          // kill alike; the death's shape is not asserted (kills after the
          // hold's release land nondeterministically).
          await running.waitForExit();
        } finally {
          running.kill();
          await releaseHoldFile(hold);
        }

        const checkContext = `T13.5-7 (${label}) \`check\` after the kill`;
        const result = await runBounded(
          product,
          workspace.root,
          ["check"],
          checkContext,
        );
        if (delayMs === null) {
          assertExitCode(
            result,
            0,
            `${checkContext}: a kill at the held point demonstrably leaves ` +
              `the workspace consistent — the hold precedes all ` +
              `modification (SPEC 13.5), so \`check\` passes`,
          );
        } else if (
          result.signal !== null ||
          (result.exitCode !== 0 && result.exitCode !== 1)
        ) {
          fail(
            `${checkContext}: \`check\` never crashes and either passes on ` +
              `a consistent state (exit 0) or reports findings (exit 1) — ` +
              `the workspace's configuration is intact, so no other ` +
              `outcome is stageable (SPEC 13.5, 14, 12.0); got ` +
              summarizeResult(result),
          );
        }
      });
    };

    await probeKill(null);
    for (const delayMs of KILL_DELAYS_MS) {
      await probeKill(delayMs);
    }
  },
});

/** TEST-SPEC §13.5, in canonical ID order (SUITE-48). */
export const section135Tests: readonly ProductTestEntry[] = [
  T13_5_1,
  T13_5_2,
  T13_5_3,
  T13_5_4,
  T13_5_5,
  T13_5_6,
  T13_5_7,
];
