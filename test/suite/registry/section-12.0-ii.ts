// TEST-SPEC §12.0 II (global command conventions, second half) — SUITE-42:
// T12.0-7, T12.0-8, T12.0-9, T12.0-11, T12.0-12.
//
// T12.0-10 (check ordering) is a pure cross-reference in TEST-SPEC — "Covered
// by T6.4-4/T6.5-5 (rename/move existence checks precede source validation;
// unparseable-file masking flips to exit 1) and T6.3-4's precedence arm
// (baseline resolution precedes source validation)" — so no separate body is
// registered here: its content runs as the ordering/masking arms of
// section-6.4.ts, section-6.5.ts, and section-6.3.ts, and the H-7 map ties
// SPEC 12.0's ordering bullet to those tests. A registered T12.0-10 body
// would either re-run those bodies (duplicated execution) or pass vacuously
// against the stub, violating H-8.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), and rejects a product only via diagnosed
// assertion failures (H-8).
//
// SPEC 12.0: all output, generated files, and stored data are
// byte-deterministic for identical input — no wall-clock values, no
// randomness, no absolute paths, no environment-dependent content; where one
// shortest path is called for and several qualify, the reported one is the
// least by element-wise byte comparison of the paths' node-identity
// sequences; exit codes partition all outcomes into 0 (success and
// informational reports), 1 (findings), and 2 (usage and configuration
// errors); and — SPEC.md's preamble — git data is read only where explicitly
// stated and never written, with only baseline-taking invocations requiring
// git at all.
//
// Conservative operationalizations (noted per H-3/H-4):
// - T12.0-7 compares the product to itself (the one case H-4 admits for
//   opaque bytes): a representative story — build, reads in human and
//   `--json` forms, review-session creation under both git-less strategies,
//   journaled rename and file-form move — runs in two content-identical
//   workspaces at different absolute paths, asserting per-step byte-identical
//   outputs and finally byte-identical whole trees. `.git/` is excluded from
//   the cross-directory compare: git internals (index stat cache, reflog
//   timestamps) legitimately embed machine state even for identically
//   scripted repositories, and the product never writes them (T12.0-11). The
//   irrelevant-environment arm varies TZ/LANG/LC_ALL/TERM/COLUMNS/LINES/
//   NO_COLOR/FORCE_COLOR plus a nonsense variable — none is given meaning by
//   SPEC.md, so output depending on any of them is environment-dependent
//   content (SPEC 12.0).
// - T12.0-8 stages, per command, a fixture whose shortest-path candidates are
//   exactly two equal-length sequences diverging in one element, so the
//   asserted path is attributable to the byte-least tie-break alone.
// - T12.0-9 asserts exact exit codes (the partition is the contract under
//   test); stream separation is T12.0-2's. Rows whose class is only
//   meaningful under a premise (impact *with differences*, coverage with an
//   uncovered node, fully-resolved `next`, a *blocked* resolve) carry a
//   light adapter-decoded premise probe so the asserted exit code is
//   attributable to its class.
// - T12.0-11 partitions a whole-workspace byte diff around each git-reading
//   invocation: any change under `.git/` fails (same file set, same bytes),
//   and every change outside it must be a write the command's own
//   specification calls for (the session file; nothing for `impact`).
// - T12.0-12 guards its own staging: the sweep workspace must have no
//   enclosing git repository (walked to the filesystem root), thrown as a
//   harness staging error — an ambient repository would mask a product that
//   wrongly requires git.

import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
  decodeCoverageReport,
  decodeExportReport,
  decodeNextReport,
  decodeReachableReport,
} from "../../helpers/adapters/index.js";
import type { ExportReport } from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import {
  assertRunOutcomesEqual,
  assertRunTwiceDeterministic,
} from "../../helpers/determinism.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import {
  assertDirectoriesEqual,
  diffSnapshots,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import type { SnapshotChange } from "../../helpers/snapshot.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import {
  pathExists,
  releaseHoldFile,
  runProduct,
  startProduct,
} from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import type { WorkspaceDecl } from "../../helpers/workspace.js";
import { impactAgainst, SPECS_ONLY_CONFIG } from "./section-5.6.js";
import { assertImpactedCode, SPEC_AND_CODE_CONFIG } from "./section-9.js";
import {
  assertSameJson,
  buildOk,
  expectConfigurationError,
  expectExit,
  runCli,
  runJson,
} from "./support.js";

/** Stage a fresh workspace, run `body`, dispose (H-1). */
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

/** Whether a snapshot key lies under the fixture's `.git/` directory. */
function isGitKey(key: string): boolean {
  return key === ".git" || key.startsWith(".git/");
}

/** Snapshot exclusion pruning the `.git` subtree (fixture machinery). */
function excludeGitDir(relPathBytes: Uint8Array): boolean {
  return Buffer.from(relPathBytes).toString("latin1") === ".git";
}

function renderChanges(changes: readonly SnapshotChange[]): string {
  const lines = changes
    .slice(0, 10)
    .map(
      (change) =>
        `  - ${change.change} ${change.path}: ${change.detail.split("\n").join("\n    ")}`,
    );
  if (changes.length > 10) {
    lines.push(`  … and ${String(changes.length - 10)} more`);
  }
  return lines.join("\n");
}

/**
 * Find the id of a session item by kind and scope node in a decoded export
 * report, failing diagnosed when absent (the fixtures below stage sessions
 * whose derivations must contain these items; SPEC 10.5/10.6/10.7).
 */
function findItemId(
  report: ExportReport,
  kind: string,
  scopeNode: string,
  context: string,
): string {
  const item = report.items.find(
    (candidate) =>
      candidate.kind === kind && candidate.scope.node === scopeNode,
  );
  if (item === undefined) {
    fail(
      `${context}: the session must contain a ${kind} item scoped to ` +
        `${scopeNode} (SPEC 10.5, 10.6, 10.7) — got items ` +
        `${JSON.stringify(
          report.items.map((candidate) => ({
            kind: candidate.kind,
            scope: candidate.scope.node,
          })),
        )}`,
    );
  }
  return item.id;
}

// ---------------------------------------------------------------------------
// Shared story fixture (T12.0-7, T12.0-9): one spec group with Markdown
// emission and a coverage profile; `alpha` (with a child) depends on `omega`,
// so `omega` is covered while `alpha.kid` and `beta` stay uncovered; sources
// are committed as the git baseline and `omega` is edited afterwards, so
// `impact --base` reports differences.
// ---------------------------------------------------------------------------

const STORY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true },
  coverage: [
    {
      name: "prof",
      target: "main",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

const STORY_FILE_A = "specs/A.mdx";
const STORY_FILE_B = "specs/B.mdx";
const STORY_ALPHA = "specs/A.mdx#alpha";
const STORY_OMEGA = "specs/A.mdx#omega";

const storyASource = (omegaText: string): string =>
  [
    '<S id="alpha" d={"omega"}>',
    "Alpha intro.",
    "",
    '<S id="alpha.kid">',
    "Kid text.",
    "</S>",
    "</S>",
    "",
    '<S id="omega" tags="keep">',
    omegaText,
    "</S>",
    "",
  ].join("\n");

const STORY_B_SOURCE = ['<S id="beta">', "Beta text.", "</S>", ""].join("\n");

/**
 * Stage the story workspace: v1 sources committed as the baseline, then
 * `omega` edited to v2 — a deterministic factory (pinned git identities and
 * timestamps make the commit hash platform- and directory-independent).
 */
async function makeStoryWorkspace(): Promise<{
  workspace: TestWorkspace;
  baseRef: string;
}> {
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": STORY_CONFIG,
      [STORY_FILE_A]: storyASource("Omega text v1."),
      [STORY_FILE_B]: STORY_B_SOURCE,
    },
  });
  try {
    await workspace.gitInit();
    const baseRef = await workspace.gitCommitAll("story baseline");
    await workspace.file(STORY_FILE_A, storyASource("Omega text v2."));
    return { workspace, baseRef };
  } catch (error) {
    await workspace.dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// T12.0-7 — determinism
// ---------------------------------------------------------------------------

interface DeterminismStep {
  /** Step summary for diagnoses. */
  readonly what: string;
  readonly argv: (baseRef: string) => readonly string[];
  /** Whether the step's entire stdout must parse as one JSON document. */
  readonly json: boolean;
}

// The representative story: build products, every report in human and/or
// `--json` form, session creation under both git-less strategies, then the
// journaled mutations (last, so every step runs at a state its arguments are
// valid in) and a post-mutation report.
const DETERMINISM_STEPS: readonly DeterminismStep[] = [
  { what: "build", json: true, argv: () => ["build", "--json"] },
  { what: "check (human)", json: false, argv: () => ["check"] },
  { what: "check --json", json: true, argv: () => ["check", "--json"] },
  { what: "ids (human)", json: false, argv: () => ["ids"] },
  { what: "ids --json", json: true, argv: () => ["ids", "--json"] },
  { what: "show (human)", json: false, argv: () => ["show", STORY_ALPHA] },
  { what: "coverage (human)", json: false, argv: () => ["coverage"] },
  { what: "coverage --json", json: true, argv: () => ["coverage", "--json"] },
  {
    what: "impact (human)",
    json: false,
    argv: (baseRef) => ["impact", "--base", baseRef],
  },
  {
    what: "impact --json",
    json: true,
    argv: (baseRef) => ["impact", "--base", baseRef, "--json"],
  },
  {
    what: "query node",
    json: true,
    argv: () => ["query", "node", STORY_ALPHA],
  },
  {
    what: "query edges --json",
    json: true,
    argv: () => ["query", "edges", "--json"],
  },
  {
    what: "review create (audit)",
    json: true,
    argv: () => [
      "review",
      "create",
      "--strategy",
      "audit",
      "--name",
      "aud",
      "--json",
    ],
  },
  {
    what: "review create (coverage)",
    json: true,
    argv: () => [
      "review",
      "create",
      "--coverage",
      "prof",
      "--name",
      "cov",
      "--json",
    ],
  },
  {
    what: "review status aud (human)",
    json: false,
    argv: () => ["review", "status", "aud"],
  },
  {
    what: "review export aud",
    json: true,
    argv: () => ["review", "export", "aud", "--json"],
  },
  {
    what: "review next cov",
    json: true,
    argv: () => ["review", "next", "cov", "--json"],
  },
  {
    what: "rename",
    json: true,
    argv: () => ["rename", STORY_FILE_A, "alpha", "alpha2", "--json"],
  },
  {
    what: "move",
    json: true,
    argv: () => ["move", STORY_FILE_B, "specs/moved/B2.mdx", "--json"],
  },
  { what: "post-mutation check (human)", json: false, argv: () => ["check"] },
];

// Post-story identities (`alpha` renamed to `alpha2` by the story).
const STORY_ALPHA2 = "specs/A.mdx#alpha2";

// Two environments differing only in variables SPEC.md gives no meaning to
// (module header): identical behavior and bytes are required (SPEC 12.0).
const IRRELEVANT_ENV_A: Readonly<Record<string, string | undefined>> = {
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
  TERM: "dumb",
  COLUMNS: "80",
  LINES: "24",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  XSPEC_HARNESS_IRRELEVANT: "one",
};
const IRRELEVANT_ENV_B: Readonly<Record<string, string | undefined>> = {
  TZ: "America/New_York",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  COLUMNS: "213",
  LINES: "62",
  NO_COLOR: undefined,
  FORCE_COLOR: "3",
  XSPEC_HARNESS_IRRELEVANT: "two",
};

/**
 * Run one command twice with the two irrelevant environments: exit outcome,
 * stdout, and stderr byte-identical, and the workspace byte state after the
 * environment-B run identical to the state after the environment-A run
 * (SPEC 12.0: no environment leakage; H-6).
 */
async function assertEnvironmentInsensitive(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  context: string,
): Promise<void> {
  const first = await runProduct(product, {
    cwd: workspace.root,
    argv,
    env: IRRELEVANT_ENV_A,
  });
  assertExitCode(
    first,
    0,
    `${context} under irrelevant environment A — the command runs at a ` +
      `state its arguments are valid in, so it succeeds (SPEC 12.0)`,
  );
  const afterA = await snapshotDirectory(workspace.root);
  const second = await runProduct(product, {
    cwd: workspace.root,
    argv,
    env: IRRELEVANT_ENV_B,
  });
  assertRunOutcomesEqual(
    second,
    first,
    `${context}: differing irrelevant environment variables (TZ, LANG, ` +
      `LC_ALL, TERM, COLUMNS, LINES, NO_COLOR, FORCE_COLOR, a nonsense ` +
      `variable) must not change any output byte — no environment-dependent ` +
      `content (SPEC 12.0)`,
    "the environment-B run",
    "the environment-A run",
  );
  const afterB = await snapshotDirectory(workspace.root);
  const changes = diffSnapshots(afterA, afterB);
  if (changes.length > 0) {
    fail(
      `${context}: workspace byte state after the environment-B run differs ` +
        `from the state after the environment-A run — generated files and ` +
        `stored data carry environment-dependent content (SPEC 12.0):\n` +
        renderChanges(changes),
    );
  }
}

const T12_0_7 = defineProductTest({
  id: "T12.0-7",
  title:
    "determinism: a representative story — build products (generated modules, Markdown, graph data), every report in human and `--json` forms, audit and coverage review sessions, journaled rename and file-form move — produces byte-identical outputs per step across content-identical workspaces at different absolute paths, and byte-identical resulting trees (sources, generated files, Markdown, graph data, journal, session files; `.git/` internals excluded as fixture machinery); reports and rebuilds are byte-identical across repeated runs, and runs with differing irrelevant environment variables are byte-identical in output and workspace state — no wall-clock, randomness, absolute paths, or environment leakage (SPEC 12.0, H-6)",
  timeoutMs: 360_000,
  run: async (product) => {
    const first = await makeStoryWorkspace();
    try {
      const second = await makeStoryWorkspace();
      try {
        if (first.workspace.root === second.workspace.root) {
          throw new Error(
            "T12.0-7: the workspace factory returned the same root twice — " +
              "the two-directory protocol needs two separate directories",
          );
        }
        if (first.baseRef !== second.baseRef) {
          throw new Error(
            `T12.0-7: the two identically scripted git fixtures realized ` +
              `different commit hashes (${first.baseRef} vs ${second.baseRef}) — ` +
              `pinned identities and timestamps must make them equal; this ` +
              `is a harness bug, not a product observation`,
          );
        }
        const preFirst = await snapshotDirectory(first.workspace.root, {
          exclude: excludeGitDir,
        });
        const preSecond = await snapshotDirectory(second.workspace.root, {
          exclude: excludeGitDir,
        });
        const drift = diffSnapshots(preFirst, preSecond);
        if (drift.length > 0) {
          throw new Error(
            `T12.0-7: the workspace factory did not rebuild an identical ` +
              `workspace — the two-directory conclusion is only meaningful ` +
              `over identical inputs (harness bug):\n${renderChanges(drift)}`,
          );
        }

        // Part A — the story, step by step, in both directories: exit 0 in
        // each, outputs byte-identical across directories (an absolute path
        // leaking into any report differs between the two roots and fails).
        for (const step of DETERMINISM_STEPS) {
          const argv = step.argv(first.baseRef);
          const context = `T12.0-7 \`${argv.join(" ")}\``;
          const resultFirst = await runCli(product, first.workspace, argv);
          assertExitCode(
            resultFirst,
            0,
            `${context} in directory 1 — the ${step.what} step of the ` +
              `determinism story runs at a state its arguments are valid ` +
              `in, so it succeeds (SPEC 12.0)`,
          );
          const resultSecond = await runCli(product, second.workspace, argv);
          assertExitCode(resultSecond, 0, `${context} in directory 2`);
          assertRunOutcomesEqual(
            resultSecond,
            resultFirst,
            `${context}: content-identical workspaces at different absolute ` +
              `paths produce byte-identical reports — no absolute paths, ` +
              `wall-clock values, or randomness in any output (SPEC 12.0, H-6)`,
            "the run in directory 2",
            "the run in directory 1",
          );
          if (step.json) {
            parseJsonStdout(
              resultFirst,
              `${context} — under --json the single JSON document is the ` +
                `entire standard output (SPEC 12.0, H-5)`,
            );
          }
        }

        // The trees the story left behind: generated modules and companions,
        // emitted Markdown, graph data, the two-line journal, both session
        // files, and the rewritten sources — byte-identical across the two
        // directories (SPEC 12.0; H-4's product-to-itself compare).
        await assertDirectoriesEqual(
          first.workspace.root,
          second.workspace.root,
          "T12.0-7: after the full story, the two directories' workspace " +
            "trees (sources, generated files, Markdown, graph data, " +
            "journal, session files) must be byte-identical — stored data " +
            "contains no absolute paths, wall-clock values, randomness, or " +
            "environment-dependent content (SPEC 12.0, H-6)",
          { exclude: excludeGitDir },
        );

        // Part B — repeated runs in directory 1: outputs byte-identical and
        // the workspace byte state stable across the second run (H-6).
        const runTwice: readonly {
          readonly argv: readonly string[];
          readonly json: boolean;
        }[] = [
          { argv: ["build", "--json"], json: true },
          { argv: ["check"], json: false },
          { argv: ["ids"], json: false },
          { argv: ["show", STORY_ALPHA2], json: false },
          { argv: ["coverage", "--json"], json: true },
          {
            argv: ["impact", "--base", first.baseRef, "--json"],
            json: true,
          },
          { argv: ["query", "node", STORY_ALPHA2], json: true },
          { argv: ["review", "export", "aud", "--json"], json: true },
          { argv: ["review", "status", "cov"], json: false },
        ];
        for (const command of runTwice) {
          const context = `T12.0-7 run-twice \`${command.argv.join(" ")}\``;
          const pair = await assertRunTwiceDeterministic({
            binding: product,
            run: { cwd: first.workspace.root, argv: command.argv },
            context,
          });
          assertExitCode(
            pair.first,
            0,
            `${context} — the command succeeds over the post-story ` +
              `workspace (SPEC 12.0)`,
          );
          if (command.json) parseJsonStdout(pair.first, context);
        }

        // Part C — differing irrelevant environment variables, directory 2.
        const envCommands: readonly (readonly string[])[] = [
          ["build", "--json"],
          ["check"],
          ["ids", "--json"],
          ["coverage"],
          ["query", "node", STORY_ALPHA2],
          ["review", "export", "aud", "--json"],
        ];
        for (const argv of envCommands) {
          await assertEnvironmentInsensitive(
            product,
            second.workspace,
            argv,
            `T12.0-7 irrelevant-environment \`${argv.join(" ")}\``,
          );
        }
      } finally {
        await second.workspace.dispose();
      }
    } finally {
      await first.workspace.dispose();
    }
  },
});

// ---------------------------------------------------------------------------
// T12.0-8 — shortest-path tie-break
// ---------------------------------------------------------------------------

// `query reachable` fixture: exactly two shortest src → zz paths, diverging
// only in the middle element (`ma` < `mb` byte-wise).
const TIE_REACHABLE_SOURCE = [
  '<S id="src" d={["ma", "mb"]}>',
  "Source text.",
  "</S>",
  "",
  '<S id="ma" d={"zz"}>',
  "Middle a text.",
  "</S>",
  "",
  '<S id="mb" d={"zz"}>',
  "Middle b text.",
  "</S>",
  "",
  '<S id="zz">',
  "End target text.",
  "</S>",
  "",
].join("\n");

// Coverage fixture: boundary group `bnd` (only `b`), target group `tgt`;
// transitive mode; two equal-length covering paths to `zz` via `ma`/`mb`.
const TIE_COVERAGE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    bnd: ["specs/bnd/**/*.mdx"],
    tgt: ["specs/tgt/**/*.mdx"]
  },
  coverage: [
    {
      name: "prof",
      target: "tgt",
      boundary: "bnd",
      mode: "transitive"
    }
  ]
})
`;
const TIE_BOUNDARY_SOURCE = [
  'import T from "../tgt/T.xspec"',
  "",
  '<S id="b" d={[T.ma, T.mb]}>',
  "Boundary text.",
  "</S>",
  "",
].join("\n");
const TIE_TARGET_SOURCE = [
  '<S id="ma" d={"zz"}>',
  "Middle a text.",
  "</S>",
  "",
  '<S id="mb" d={"zz"}>',
  "Middle b text.",
  "</S>",
  "",
  '<S id="zz">',
  "End target text.",
  "</S>",
  "",
].join("\n");

// Impact fixture: `src/app.ts` references `n`; `n` depends on `ca` and `cb`,
// both edited since the baseline — two equal-length witness paths from `n`.
const TIE_IMPACT_SPEC = "specs/M.mdx";
const tieImpactSpecSource = (caText: string, cbText: string): string =>
  [
    '<S id="n" d={["ca", "cb"]}>',
    "Anchor text.",
    "</S>",
    "",
    '<S id="ca">',
    caText,
    "</S>",
    "",
    '<S id="cb">',
    cbText,
    "</S>",
    "",
  ].join("\n");
const TIE_IMPACT_APP = "src/app.ts";
const TIE_IMPACT_APP_SOURCE = [
  'import M from "../specs/M.xspec";',
  "",
  "M.n;",
  "",
].join("\n");

const T12_0_8 = defineProductTest({
  id: "T12.0-8",
  title:
    "shortest-path tie-break: where one shortest path is reported — a covered node's covering path (coverage, 8.2), an impacted code location's witness path (impact, 9.3), and `query reachable`'s witness path (11) — a dedicated two-equal-candidates fixture per command shows the element-wise byte-least node-identity sequence reported (SPEC 12.0)",
  run: async (product) => {
    // `query reachable` (SPEC 11, 12.0).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/R.mdx": TIE_REACHABLE_SOURCE,
        },
      },
      async (workspace) => {
        await buildOk(product, workspace, "T12.0-8 reachable-arm `build`");
        const context =
          "T12.0-8 `query reachable --from specs/R.mdx#src --to specs/R.mdx#zz`";
        const report = decodeReachableReport(
          await runJson(
            product,
            workspace,
            [
              "query",
              "reachable",
              "--from",
              "specs/R.mdx#src",
              "--to",
              "specs/R.mdx#zz",
            ],
            context,
          ),
          context,
        );
        if (!report.reachable) {
          fail(
            `${context}: two staged dependency paths lead from src to zz, ` +
              `so a path exists (SPEC 11)`,
          );
        }
        assertSameJson(
          report.path,
          ["specs/R.mdx#src", "specs/R.mdx#ma", "specs/R.mdx#zz"],
          `${context}: exactly two shortest witness paths exist, via ma and ` +
            `via mb; the element-wise byte-least node-identity sequence — ` +
            `through ma ("…#ma" < "…#mb") — is the reported one (SPEC 12.0, 11)`,
        );
      },
    );

    // `coverage` (SPEC 8.2, 12.0).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": TIE_COVERAGE_CONFIG,
          "specs/bnd/B.mdx": TIE_BOUNDARY_SOURCE,
          "specs/tgt/T.mdx": TIE_TARGET_SOURCE,
        },
      },
      async (workspace) => {
        await buildOk(product, workspace, "T12.0-8 coverage-arm `build`");
        const context = "T12.0-8 `coverage --json`";
        const report = decodeCoverageReport(
          await runJson(product, workspace, ["coverage", "--json"], context),
          context,
        );
        const profile = report.profiles.find((entry) => entry.name === "prof");
        if (profile === undefined) {
          fail(
            `${context}: the configured profile "prof" must be reported ` +
              `(SPEC 8.2); got ${JSON.stringify(
                report.profiles.map((entry) => entry.name),
              )}`,
          );
        }
        const covered = profile.covered.find(
          (entry) => entry.identity === "specs/tgt/T.mdx#zz",
        );
        if (covered === undefined) {
          fail(
            `${context}: zz is covered — transitive paths b → ma → zz and ` +
              `b → mb → zz exist (SPEC 8) — so it must appear among the ` +
              `covered nodes; got ${JSON.stringify(
                profile.covered.map((entry) => entry.identity),
              )}`,
          );
        }
        assertSameJson(
          covered.path,
          ["specs/bnd/B.mdx#b", "specs/tgt/T.mdx#ma", "specs/tgt/T.mdx#zz"],
          `${context}: zz's two shortest covering paths run through ma and ` +
            `mb; the element-wise byte-least sequence — through ma — is the ` +
            `reported one (SPEC 8.2, 12.0)`,
        );
      },
    );

    // `impact` (SPEC 9.3, 12.0).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPEC_AND_CODE_CONFIG,
          [TIE_IMPACT_SPEC]: tieImpactSpecSource(
            "Changed a v1.",
            "Changed b v1.",
          ),
          [TIE_IMPACT_APP]: TIE_IMPACT_APP_SOURCE,
        },
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("tie-break baseline");
        await workspace.file(
          TIE_IMPACT_SPEC,
          tieImpactSpecSource("Changed a v2.", "Changed b v2."),
        );
        await buildOk(
          product,
          workspace,
          "T12.0-8 impact-arm `build` over the doubly-edited workspace",
        );
        const context = "T12.0-8 `impact --base <baseline> --json`";
        assertImpactedCode(
          await impactAgainst(product, workspace, base, context),
          {
            // n's own subtree is untouched, so the location is transitively
            // impacted only; the two equal-length witness candidates from n
            // end at the edited ca and cb, and the byte-least sequence —
            // [n, ca] — is reported (SPEC 9.2, 9.3, 12.0).
            direct: [],
            transitive: [
              {
                location: TIE_IMPACT_APP,
                edge: {
                  from: TIE_IMPACT_APP,
                  to: "specs/M.mdx#n",
                  kind: "references",
                },
                path: ["specs/M.mdx#n", "specs/M.mdx#ca"],
              },
            ],
          },
          context,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.0-9 — exit-code partition
// ---------------------------------------------------------------------------

/** One partition row: an invocation and the exact class exit code. */
interface PartitionRow {
  /** The SPEC 12.0 class instance the row represents. */
  readonly what: string;
  readonly argv: readonly string[];
  readonly expect: 0 | 1 | 2;
}

async function runPartitionRows(
  product: ProductBinding,
  workspace: TestWorkspace,
  rows: readonly PartitionRow[],
): Promise<void> {
  for (const row of rows) {
    await expectExit(
      product,
      workspace,
      row.argv,
      row.expect,
      `T12.0-9 \`${row.argv.join(" ")}\` — ${row.what}: exit codes ` +
        `partition all outcomes, and this outcome is in the ` +
        `${String(row.expect)} class (SPEC 12.0)`,
    );
  }
}

const T12_0_9 = defineProductTest({
  id: "T12.0-9",
  title:
    "exit-code partition: a table-driven sweep asserting one representative per class per command family — 0 for success and informational reports (`ids`, `show`, `impact` with differences, `query`, review reads including fully-resolved `next`, `coverage` without `--check`); 1 for findings (failing `build`, `check` findings, `coverage --check` uncovered, refused `rename`/`move`, refused review operations, corrupt-session reports); 2 for usage and configuration errors (unknown command/flag, missing required flag and argument, invalid flag value, unknown profile/session/group/item/node/file, invalid session name, configuration errors, unreadable baseline, mutual-exclusion refusal) (SPEC 12.0)",
  timeoutMs: 360_000,
  run: async (product) => {
    // --- The valid story workspace: informational, refusal, and usage rows.
    const { workspace, baseRef } = await makeStoryWorkspace();
    try {
      await buildOk(product, workspace, "T12.0-9 `build` (story workspace)");
      await runJson(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "aud", "--json"],
        "T12.0-9 staging `review create --strategy audit --name aud`",
      );

      // Premise: the audit session's alpha item is blocked by its child's
      // item (SPEC 10.6), so resolving it exercises the refused-review class.
      const audExportContext = "T12.0-9 staging `review export aud --json`";
      const audReport = decodeExportReport(
        await runJson(
          product,
          workspace,
          ["review", "export", "aud", "--json"],
          audExportContext,
        ),
        audExportContext,
      );
      const alphaItemId = findItemId(
        audReport,
        "subtree-coherence",
        STORY_ALPHA,
        audExportContext,
      );
      const alphaItem = audReport.items.find((item) => item.id === alphaItemId);
      if (alphaItem === undefined || !alphaItem.blocked) {
        fail(
          `${audExportContext}: alpha's audit item is blocked by its child ` +
            `section's unresolved item (SPEC 10.6), so the refused-resolve ` +
            `row below is attributable to blocking; got ` +
            `${JSON.stringify(alphaItem)}`,
        );
      }

      // Premise: a drained session, so `next` reports fully resolved. The
      // acyclic `blockedBy` of 10.1 guarantees the next/resolve loop below
      // reaches every item (a minimal needing-review item is always
      // unblocked); the iteration bound is the item count plus one.
      await runJson(
        product,
        workspace,
        ["review", "create", "--strategy", "audit", "--name", "done", "--json"],
        "T12.0-9 staging `review create --strategy audit --name done`",
      );
      const doneExportContext = "T12.0-9 staging `review export done --json`";
      const doneReport = decodeExportReport(
        await runJson(
          product,
          workspace,
          ["review", "export", "done", "--json"],
          doneExportContext,
        ),
        doneExportContext,
      );
      let drained = false;
      for (let i = 0; i <= doneReport.items.length; i += 1) {
        const nextContext = `T12.0-9 staging \`review next done --json\` (round ${String(i + 1)})`;
        const next = decodeNextReport(
          await runJson(
            product,
            workspace,
            ["review", "next", "done", "--json"],
            nextContext,
          ),
          nextContext,
        );
        if (next.fullyResolved) {
          drained = true;
          break;
        }
        if (next.item === undefined) {
          fail(
            `${nextContext}: a not-fully-resolved \`next\` report carries ` +
              `the first actionable item (SPEC 10.7)`,
          );
        }
        await expectExit(
          product,
          workspace,
          [
            "review",
            "resolve",
            "done",
            next.item.id,
            "--status",
            "no-change",
            "--json",
          ],
          0,
          `T12.0-9 staging: resolving the unblocked item ${next.item.id} of ` +
            `session done succeeds (SPEC 10.7)`,
        );
      }
      if (!drained) {
        fail(
          `T12.0-9 staging: resolving ${String(doneReport.items.length)} ` +
            `items one \`next\` at a time must drain the session — with ` +
            `acyclic blockedBy a minimal needing-review item is always ` +
            `unblocked (SPEC 10.1, 10.7)`,
        );
      }

      // Premise probes for the informational rows: impact reports an actual
      // difference (the staged omega edit) and the profile has an uncovered
      // node, so their exit-0/exit-1 rows carry their classes.
      const impactContext = "T12.0-9 `impact --base <ref> --json` (premise)";
      const impact = await impactAgainst(
        product,
        workspace,
        baseRef,
        impactContext,
      );
      if (impact.requirements.length === 0) {
        fail(
          `${impactContext}: omega was edited after the baseline commit, so ` +
            `the report contains requirement impact — the exit-0 row below ` +
            `is \`impact\` *with differences* (SPEC 9.3, 12.0)`,
        );
      }
      const coverageContext = "T12.0-9 `coverage --json` (premise)";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageContext,
        ),
        coverageContext,
      );
      if (!coverage.profiles.some((profile) => profile.uncovered.length > 0)) {
        fail(
          `${coverageContext}: alpha.kid and beta have no incoming ` +
            `dependency edges, so the profile reports uncovered required ` +
            `nodes — the \`coverage\`/\`coverage --check\` rows below carry ` +
            `their classes (SPEC 8, 12.0)`,
        );
      }

      // Fully-resolved `next` (exit 0) with its premise asserted.
      const doneNextContext =
        "T12.0-9 `review next done --json` (fully resolved)";
      const doneNext = decodeNextReport(
        await runJson(
          product,
          workspace,
          ["review", "next", "done", "--json"],
          doneNextContext,
        ),
        doneNextContext,
      );
      if (!doneNext.fullyResolved) {
        fail(
          `${doneNextContext}: every item of the session was resolved, so ` +
            `\`next\` reports the session fully resolved and exits 0 ` +
            `(SPEC 10.7, 12.0)`,
        );
      }
      // Not-fully-resolved `next` is informational success too.
      const audNextContext = "T12.0-9 `review next aud --json`";
      const audNext = decodeNextReport(
        await runJson(
          product,
          workspace,
          ["review", "next", "aud", "--json"],
          audNextContext,
        ),
        audNextContext,
      );
      if (audNext.fullyResolved) {
        fail(
          `${audNextContext}: session aud has unresolved items, so \`next\` ` +
            `returns the first actionable one (SPEC 10.7) — the exit-0 ` +
            `class covers review reads with and without work remaining`,
        );
      }

      await runPartitionRows(product, workspace, [
        // 0 — success and informational reports.
        { what: "informational `ids`", argv: ["ids"], expect: 0 },
        {
          what: "informational `show`",
          argv: ["show", STORY_ALPHA],
          expect: 0,
        },
        {
          what: "`impact` with differences is informational",
          argv: ["impact", "--base", baseRef],
          expect: 0,
        },
        {
          what: "informational `query`",
          argv: ["query", "node", STORY_ALPHA],
          expect: 0,
        },
        {
          what: "review read `status`",
          argv: ["review", "status", "aud"],
          expect: 0,
        },
        { what: "review read `list`", argv: ["review", "list"], expect: 0 },
        {
          what: "review read `export`",
          argv: ["review", "export", "aud"],
          expect: 0,
        },
        {
          what: "`coverage` without `--check` reports uncovered nodes informationally",
          argv: ["coverage"],
          expect: 0,
        },
        // 1 — findings.
        {
          what: "`coverage --check` with uncovered requirements",
          argv: ["coverage", "--check"],
          expect: 1,
        },
        {
          what: "refused `rename` (the new ID collides with an existing ID, SPEC 6.4)",
          argv: ["rename", STORY_FILE_A, "alpha", "omega"],
          expect: 1,
        },
        {
          what: "refused `move` (the destination file already exists, SPEC 6.5)",
          argv: ["move", STORY_FILE_A, STORY_FILE_B],
          expect: 1,
        },
        {
          what: "refused review operation (resolving a blocked item, SPEC 10.7)",
          argv: [
            "review",
            "resolve",
            "aud",
            alphaItemId,
            "--status",
            "no-change",
          ],
          expect: 1,
        },
        // 2 — usage errors.
        {
          what: "unknown command",
          argv: ["definitely-not-a-command"],
          expect: 2,
        },
        {
          what: "unknown flag",
          argv: ["ids", "--definitely-not-a-flag"],
          expect: 2,
        },
        {
          what: "missing required flag (`impact` without `--base`)",
          argv: ["impact"],
          expect: 2,
        },
        {
          what: "missing required argument (`show` without `<node>`)",
          argv: ["show"],
          expect: 2,
        },
        {
          what: "invalid flag value (`reachable` accepts only dependency kinds, SPEC 11)",
          argv: [
            "query",
            "reachable",
            "--from",
            STORY_ALPHA,
            "--to",
            STORY_OMEGA,
            "--kinds",
            "contains",
          ],
          expect: 2,
        },
        {
          what: "unknown profile named in arguments",
          argv: ["coverage", "no-such-profile"],
          expect: 2,
        },
        {
          what: "unknown session named in arguments",
          argv: ["review", "status", "no-such-session"],
          expect: 2,
        },
        {
          what: "unknown group named in arguments",
          argv: ["query", "nodes", "--group", "no-such-group"],
          expect: 2,
        },
        {
          what: "unknown review item named in arguments",
          argv: ["review", "show", "aud", "xspec-harness-no-such-item"],
          expect: 2,
        },
        {
          what: "unknown node identity named in arguments",
          argv: ["show", "specs/A.mdx#no-such-id"],
          expect: 2,
        },
        {
          what: "unknown file named in arguments",
          argv: ["show", "specs/NoSuch.mdx"],
          expect: 2,
        },
        {
          what: "invalid session name (a leading `.`, SPEC 10.1)",
          argv: ["review", "create", "--strategy", "audit", "--name", ".bad"],
          expect: 2,
        },
        {
          what: "a baseline that cannot be resolved (SPEC 6.3)",
          argv: ["impact", "--base", "no-such-ref-xspec"],
          expect: 2,
        },
      ]);
    } finally {
      await workspace.dispose();
    }

    // --- Corrupt-session reports (exit 1, SPEC 14.21): a session the
    // product wrote, overwritten with unparseable bytes (shape-independent).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": ['<S id="a">', "Alpha text.", "</S>", ""].join("\n"),
        },
      },
      async (corruptWorkspace) => {
        await buildOk(product, corruptWorkspace, "T12.0-9 corrupt-arm `build`");
        await runJson(
          product,
          corruptWorkspace,
          [
            "review",
            "create",
            "--strategy",
            "audit",
            "--name",
            "corrupt",
            "--json",
          ],
          "T12.0-9 staging `review create --strategy audit --name corrupt`",
        );
        const sessionRel = ".xspec/reviews/corrupt.json";
        if ((await corruptWorkspace.kind(sessionRel)) !== "file") {
          fail(
            `T12.0-9 staging: \`review create\` must store the session at ` +
              `${sessionRel} (SPEC 10.1) — the corruption arm overwrites the ` +
              `file the product wrote`,
          );
        }
        await corruptWorkspace.file(
          sessionRel,
          "this is not a JSON document {{{\n",
        );
        await runPartitionRows(product, corruptWorkspace, [
          {
            what: "a `review` subcommand naming a corrupt session reports the corruption (SPEC 14.21)",
            argv: ["review", "status", "corrupt"],
            expect: 1,
          },
          {
            what: "`review list` reporting a corrupt session (SPEC 10.7, 14.21)",
            argv: ["review", "list"],
            expect: 1,
          },
        ]);
      },
    );

    // --- Findings (exit 1): failing build and check over invalid sources.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": [
            '<S id="a" d={"missing"}>',
            "Alpha text.",
            "</S>",
            "",
          ].join("\n"),
        },
      },
      async (invalidWorkspace) => {
        await runPartitionRows(product, invalidWorkspace, [
          {
            what: "failing `build` (an unresolved reference, SPEC 14.5)",
            argv: ["build"],
            expect: 1,
          },
          {
            what: "`check` findings over the same invalid sources",
            argv: ["check"],
            expect: 1,
          },
        ]);
      },
    );

    // --- Configuration errors (exit 2, SPEC 14.14).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  bogus: true
})
`,
          "specs/A.mdx": ['<S id="a">', "Alpha text.", "</S>", ""].join("\n"),
        },
      },
      async (configWorkspace) => {
        await expectConfigurationError(
          product,
          configWorkspace,
          ["build"],
          "T12.0-9 `build` under an unknown-key configuration — " +
            "configuration errors are the 2 class (SPEC 14.14, 12.0)",
        );
      },
    );

    // --- Mutual-exclusion refusal (exit 2, SPEC 13.5): while one mutating
    // command holds workspace exclusivity at its `--test-hold` point, a
    // second mutating command is refused as a usage error.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": ['<S id="alpha">', "Alpha text.", "</S>", ""].join(
            "\n",
          ),
        },
      },
      async (holdWorkspace) => {
        await buildOk(product, holdWorkspace, "T12.0-9 exclusion-arm `build`");
        const holdPath = path.join(holdWorkspace.tempRoot, "hold.tmp");
        const holdContext =
          "T12.0-9 `rename specs/A.mdx alpha alpha2 --test-hold <path>`";
        const running = await startProduct(product, {
          cwd: holdWorkspace.root,
          argv: [
            "rename",
            "specs/A.mdx",
            "alpha",
            "alpha2",
            "--test-hold",
            holdPath,
          ],
        });
        try {
          try {
            await running.waitForFile(holdPath);
          } catch (error) {
            fail(
              `${holdContext}: the mutating command creates the hold file ` +
                `immediately after acquiring workspace exclusivity ` +
                `(SPEC 13.5) — ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await expectExit(
            product,
            holdWorkspace,
            ["review", "create", "--strategy", "audit", "--name", "z"],
            2,
            "T12.0-9 `review create --strategy audit --name z` while the " +
              "rename holds exclusivity — a mutating command refused " +
              "because another is running is a usage error, the 2 class " +
              "(SPEC 13.5, 12.0)",
          );
          await releaseHoldFile(holdPath);
          const renameResult = await running.waitForExit();
          assertExitCode(
            renameResult,
            0,
            `${holdContext} — once the hold file is deleted the rename ` +
              `proceeds normally (SPEC 13.5), so the excluded command's ` +
              `exit 2 above is attributable to the exclusion alone`,
          );
        } finally {
          running.kill();
          await releaseHoldFile(holdPath);
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.0-11 — git is read-only
// ---------------------------------------------------------------------------

const GITRO_FILE = "specs/G.mdx";
const gitroSource = (omegaText: string): string =>
  [
    '<S id="alpha">',
    "Alpha text.",
    "</S>",
    "",
    '<S id="omega">',
    omegaText,
    "</S>",
    "",
  ].join("\n");

/** What a git-reading invocation may write outside `.git/` (T12.0-11). */
interface GitReadOnlyExpectation {
  /** Non-`.git/` keys allowed to change, with the expected change kind. */
  readonly allowed: Readonly<Record<string, "added" | "changed">>;
  /** Keys that MUST appear in the delta (the command's specified writes). */
  readonly required: readonly string[];
}

/**
 * Run one git-reading invocation (exit 0, `--json` parsed) bracketed by
 * whole-workspace byte snapshots: everything under `.git/` byte-identical
 * before and after — same file set, same bytes: refs, HEAD, index, and
 * objects untouched — and no workspace file changed except those the
 * command's own specification writes (SPEC.md preamble; T12.0-11).
 */
async function runGitReadingCommand(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  expectation: GitReadOnlyExpectation,
  context: string,
): Promise<unknown> {
  const before = await snapshotDirectory(workspace.root);
  const result = await runCli(product, workspace, argv);
  assertExitCode(result, 0, context);
  const doc = parseJsonStdout(result, context);
  const after = await snapshotDirectory(workspace.root);
  const changes = diffSnapshots(before, after);
  const gitChanges = changes.filter((change) => isGitKey(change.key));
  if (gitChanges.length > 0) {
    fail(
      `${context}: git data is read only where explicitly stated and never ` +
        `written (SPEC.md preamble) — everything under .git/ must be ` +
        `byte-identical around the invocation (same file set, same bytes: ` +
        `refs, HEAD, index, and objects untouched), but it changed:\n` +
        renderChanges(gitChanges),
    );
  }
  const others = changes.filter((change) => !isGitKey(change.key));
  for (const change of others) {
    const want = expectation.allowed[change.key];
    if (want === undefined || change.change !== want) {
      fail(
        `${context}: no workspace file changes except those the command's ` +
          `own specification writes (T12.0-11; the session file for ` +
          `session-writing commands, nothing for \`impact\` or review ` +
          `reads) — unexpected change:\n${renderChanges([change])}`,
      );
    }
  }
  for (const key of expectation.required) {
    if (!others.some((change) => change.key === key)) {
      fail(
        `${context}: the command's specified write did not land — expected ` +
          `${key} to be ${expectation.allowed[key] ?? "written"} ` +
          `(SPEC 10.1, 10.7)`,
      );
    }
  }
  return doc;
}

const T12_0_11 = defineProductTest({
  id: "T12.0-11",
  title:
    "git is read-only: on a freshly built git fixture, around each git-reading invocation — `impact --base`, `review create --base`, and `review status`/`next`/`resolve` on the resulting baseline session, whose generator runs reconstruct the recorded baseline (6.3, 10.4) — everything under `.git/` is byte-identical before and after (same file set, same bytes: refs, HEAD, index, and objects untouched), and no workspace file changes except those the command's own specification writes: the session file for `create` and `resolve`, nothing for `impact` and the reads (SPEC.md preamble, 12.0)",
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          [GITRO_FILE]: gitroSource("Omega text v1."),
        },
      },
      async (workspace) => {
        await workspace.gitInit();
        const baseRef = await workspace.gitCommitAll("read-only baseline");
        // Edit omega after the commit, so the baseline session derives one
        // unblocked path-blocks item (omega's subtree-coherence item; omega
        // has no non-root ancestor, SPEC 10.5) for `next` and `resolve`.
        await workspace.file(GITRO_FILE, gitroSource("Omega text v2."));
        await buildOk(product, workspace, "T12.0-11 `build` (fresh fixture)");

        await runGitReadingCommand(
          product,
          workspace,
          ["impact", "--base", baseRef, "--json"],
          { allowed: {}, required: [] },
          "T12.0-11 `impact --base <ref> --json`",
        );

        const sessionKey = ".xspec/reviews/pb.json";
        await runGitReadingCommand(
          product,
          workspace,
          ["review", "create", "--base", baseRef, "--name", "pb", "--json"],
          {
            allowed: {
              ".xspec/reviews": "added",
              [sessionKey]: "added",
            },
            required: [sessionKey],
          },
          "T12.0-11 `review create --base <ref> --name pb --json`",
        );

        await runGitReadingCommand(
          product,
          workspace,
          ["review", "status", "pb", "--json"],
          { allowed: {}, required: [] },
          "T12.0-11 `review status pb --json`",
        );

        const nextContext = "T12.0-11 `review next pb --json`";
        const next = decodeNextReport(
          await runGitReadingCommand(
            product,
            workspace,
            ["review", "next", "pb", "--json"],
            { allowed: {}, required: [] },
            nextContext,
          ),
          nextContext,
        );
        if (next.fullyResolved || next.item === undefined) {
          fail(
            `${nextContext}: the staged omega edit derives one unblocked ` +
              `path-blocks item (SPEC 10.5), so \`next\` returns it — ` +
              `needed for the \`resolve\` leg of this test`,
          );
        }

        await runGitReadingCommand(
          product,
          workspace,
          [
            "review",
            "resolve",
            "pb",
            next.item.id,
            "--status",
            "no-change",
            "--json",
          ],
          {
            allowed: { [sessionKey]: "changed" },
            required: [sessionKey],
          },
          "T12.0-11 `review resolve pb <item> --status no-change --json`",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T12.0-12 — git-less operation
// ---------------------------------------------------------------------------

/**
 * Staging guard: the sweep workspace must sit under no git repository at all
 * (an enclosing repository would mask a product that wrongly requires git).
 * A violation is a harness staging error, not a product observation.
 */
async function assertNoEnclosingGitRepository(startAbs: string): Promise<void> {
  let dir = startAbs;
  for (;;) {
    if (await pathExists(path.join(dir, ".git"))) {
      throw new Error(
        `T12.0-12 staging: ${dir} contains a .git entry — the git-less ` +
          `sweep needs a workspace that is not a git repository and has no ` +
          `enclosing repository (harness staging error)`,
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

const GITLESS_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  coverage: [
    {
      name: "prof",
      target: "main",
      boundary: "main",
      mode: "direct"
    }
  ]
})
`;

// alpha (with a child, so its audit item is splittable) depends on omega;
// alpha.kid stays uncovered, so the coverage-strategy session has one item.
const GITLESS_FILE = "specs/A.mdx";
const GITLESS_SOURCE = [
  '<S id="alpha" d={"omega"}>',
  "Alpha intro.",
  "",
  '<S id="alpha.kid">',
  "Kid text.",
  "</S>",
  "</S>",
  "",
  '<S id="omega">',
  "Omega text.",
  "</S>",
  "",
].join("\n");
const GITLESS_ALPHA = "specs/A.mdx#alpha";
const GITLESS_KID = "specs/A.mdx#alpha.kid";

interface GitlessState {
  audKidItemId?: string;
  audAlphaItemId?: string;
  covKidItemId?: string;
}

interface GitlessStep {
  readonly what: string;
  readonly argv: (state: GitlessState) => readonly string[];
  readonly harvest?: (
    doc: unknown,
    state: GitlessState,
    context: string,
  ) => void;
}

/** A harvested id the sweep guarantees is set by the time it is consumed. */
function requireHarvested(value: string | undefined, what: string): string {
  if (value === undefined) {
    throw new Error(
      `T12.0-12 sweep bug: ${what} consumed before it was harvested`,
    );
  }
  return value;
}

// The non-baseline surface (SPEC 12.0): every command below runs to its
// specified outcome — exit 0 at a state its arguments are valid in — with no
// git repository anywhere. Only baseline-taking invocations require git.
const GITLESS_STEPS: readonly GitlessStep[] = [
  { what: "build", argv: () => ["build"] },
  { what: "check", argv: () => ["check"] },
  { what: "ids", argv: () => ["ids"] },
  { what: "show", argv: () => ["show", GITLESS_ALPHA] },
  { what: "coverage", argv: () => ["coverage"] },
  { what: "query node", argv: () => ["query", "node", GITLESS_ALPHA] },
  { what: "query edges", argv: () => ["query", "edges"] },
  {
    what: "review create (audit)",
    argv: () => ["review", "create", "--strategy", "audit", "--name", "aud"],
  },
  { what: "review list", argv: () => ["review", "list"] },
  { what: "review status aud", argv: () => ["review", "status", "aud"] },
  { what: "review next aud", argv: () => ["review", "next", "aud"] },
  {
    what: "review export aud",
    argv: () => ["review", "export", "aud"],
    harvest: (doc, state, context) => {
      const report = decodeExportReport(doc, context);
      state.audKidItemId = findItemId(
        report,
        "subtree-coherence",
        GITLESS_KID,
        context,
      );
      state.audAlphaItemId = findItemId(
        report,
        "subtree-coherence",
        GITLESS_ALPHA,
        context,
      );
    },
  },
  {
    what: "review show aud",
    argv: (state) => [
      "review",
      "show",
      "aud",
      requireHarvested(state.audKidItemId, "the aud kid item id"),
    ],
  },
  {
    what: "review resolve aud",
    argv: (state) => [
      "review",
      "resolve",
      "aud",
      requireHarvested(state.audKidItemId, "the aud kid item id"),
      "--status",
      "no-change",
    ],
  },
  {
    what: "review split aud",
    argv: (state) => [
      "review",
      "split",
      "aud",
      requireHarvested(state.audAlphaItemId, "the aud alpha item id"),
    ],
  },
  {
    what: "review create (coverage)",
    argv: () => ["review", "create", "--coverage", "prof", "--name", "cov"],
  },
  { what: "review status cov", argv: () => ["review", "status", "cov"] },
  { what: "review next cov", argv: () => ["review", "next", "cov"] },
  {
    what: "review export cov",
    argv: () => ["review", "export", "cov"],
    harvest: (doc, state, context) => {
      state.covKidItemId = findItemId(
        decodeExportReport(doc, context),
        "uncovered-requirement",
        GITLESS_KID,
        context,
      );
    },
  },
  {
    what: "review show cov",
    argv: (state) => [
      "review",
      "show",
      "cov",
      requireHarvested(state.covKidItemId, "the cov kid item id"),
    ],
  },
  {
    // `--status updated` re-runs the coverage generator with the recorded
    // profile (SPEC 10.5) — a git-less re-derivation.
    what: "review resolve cov (updated)",
    argv: (state) => [
      "review",
      "resolve",
      "cov",
      requireHarvested(state.covKidItemId, "the cov kid item id"),
      "--status",
      "updated",
    ],
  },
  { what: "review list (both sessions)", argv: () => ["review", "list"] },
  {
    what: "rename",
    argv: () => ["rename", GITLESS_FILE, "omega", "omega2"],
  },
  { what: "move", argv: () => ["move", GITLESS_FILE, "specs/B.mdx"] },
];

const T12_0_12 = defineProductTest({
  id: "T12.0-12",
  title:
    "git-less operation: the non-baseline surface — `build`, `check`, `ids`, `show`, `coverage`, `query`, `rename`, file-form `move`, and `review` with the audit and coverage strategies through create/list/status/next/show/split/resolve/export (an `updated` resolve re-running the recorded-profile generator included) — runs to its specified outcomes in a workspace that is not a git repository and has no enclosing repository; only baseline-taking invocations require git (SPEC 12.0, SPEC.md preamble; T10.6-1's git-less audit is one instance)",
  timeoutMs: 240_000,
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": GITLESS_CONFIG,
          [GITLESS_FILE]: GITLESS_SOURCE,
        },
      },
      async (workspace) => {
        await assertNoEnclosingGitRepository(workspace.root);
        const state: GitlessState = {};
        for (const step of GITLESS_STEPS) {
          const argv = [...step.argv(state), "--json"];
          const context = `T12.0-12 \`${argv.join(" ")}\``;
          const result = await expectExit(
            product,
            workspace,
            argv,
            0,
            `${context} — the ${step.what} step of the git-less sweep runs ` +
              `at a state its arguments are valid in, and no command of the ` +
              `non-baseline surface requires a git repository (SPEC 12.0)`,
          );
          const doc = parseJsonStdout(
            result,
            `${context} — under --json the single JSON document is the ` +
              `entire standard output (SPEC 12.0, H-5)`,
          );
          step.harvest?.(doc, state, context);
        }
      },
    );
  },
});

export const section120iiTests: readonly ProductTestEntry[] = [
  T12_0_7,
  T12_0_8,
  T12_0_9,
  T12_0_11,
  T12_0_12,
];
