// E-6 representative fixture and Linux↔Windows exchange (TEST-SPEC §18 E-6).
// Harness machinery only: no product imports; the product is driven strictly
// as a subprocess through a ProductBinding (H-2, C-2).
//
// One fixture story exercises the E-6 command set — `build`, `check`,
// `query`, `coverage`, `impact`, a journaled `rename`, a journaled file-form
// `move`, and an `audit` review session (`review create --strategy audit`,
// `next --json`, a `resolve`, an `export`) — and captures two kinds of
// output:
//
//   - the transcript: every invocation's argv, exit code, and exact
//     stdout/stderr bytes (reports, 12.0);
//   - the final workspace tree, `.git/` excluded: move-rewritten sources,
//     generated files, emitted Markdown, graph data, the journal, and the
//     session file (stored data, 1.5/13.4).
//
// The Linux leg (test/suite/e6-exchange-writer.test.ts) runs the fixture
// against the built product and, when XSPEC_E6_EXCHANGE_DIR is set, writes
// both captures into that directory (uploaded as the `e6-linux-outputs` CI
// artifact, .github/workflows/ci.yml). The Windows leg
// (test/windows/e6-byte-identity.test.ts) runs the identical fixture and
// asserts its captures byte-identical to the exchanged ones — a
// product-to-itself comparison, permitted by H-4; byte identity across legs
// is promised because both runs consume byte-identical input (12.0): the
// workspace builder writes declared bytes verbatim (S-2) and the git fixture
// is scripted with pinned, platform-independent commit metadata
// (helpers/workspace.ts), so `impact --base` reads identical baselines on
// both legs.
//
// The `move` is the subset's specifier-computation probe (E-6): it crosses
// directories in both rewrite directions — the moved file's own import
// specifier and two other files' imports of its generated module are
// recomputed (SPEC 6.5), which a native-path-API product writes `\`-separated
// only on Windows — and `check` runs clean after it (T6.4-7). The fixture
// depends on no case-sensitive filesystem, no symlink creation, and no POSIX
// signal semantics, so it stages identically on both legs.
//
// Red-green (H-8): every step asserts its exact exit code through the
// diagnosed-assertion helpers, so against a stub product the fixture fails at
// its first step as a diagnosed assertion failure on either leg — never a
// crash or hang — and the writer writes nothing (the CI artifact upload
// tolerates the empty directory). The Windows-side comparison consults the
// exchange only after its own fixture run succeeded, and a missing or
// malformed exchange is then a loud failure (never a skip or a vacuous pass,
// H-9): with a working product, absent Linux outputs mean broken artifact
// plumbing.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { decodeNextReport } from "./adapters/index.js";
import {
  assertBytesEqual,
  assertExitCode,
  fail,
  parseJsonStdout,
} from "./assertions.js";
import type { DirectorySnapshot } from "./snapshot.js";
import { assertSnapshotsEqual, snapshotDirectory } from "./snapshot.js";
import type { ProductBinding, RunResult } from "./subprocess.js";
import { runProduct } from "./subprocess.js";
import { TestWorkspace } from "./workspace.js";

/**
 * Environment variable naming the exchange directory (written on the Linux
 * leg, read on the Windows leg; see .github/workflows/ci.yml).
 */
export const E6_EXCHANGE_ENV = "XSPEC_E6_EXCHANGE_DIR";

/** Exchange serialization format marker (readers refuse anything else). */
const EXCHANGE_FORMAT = "xspec-e6-exchange";
const EXCHANGE_FORMAT_VERSION = 1;
const MANIFEST_NAME = "manifest.json";
const STEPS_DIR = "steps";
const WORKSPACE_DIR = "workspace";

/** One recorded product invocation of the representative fixture. */
export interface E6StepRecord {
  /** Stable step name (doubles as the exchange stream-file slug). */
  readonly step: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
}

/** The representative fixture's complete captured outputs. */
export interface E6FixtureRun {
  /** Every invocation in fixture order. */
  readonly steps: readonly E6StepRecord[];
  /** Byte snapshot of the final workspace tree, `.git/` excluded. */
  readonly workspace: DirectorySnapshot;
}

// ---------------------------------------------------------------------------
// The representative fixture
// ---------------------------------------------------------------------------

// Spec and code groups, Markdown emission, and one coverage profile, so the
// run produces every E-6 output kind: generated modules, emitted Markdown,
// graph data, journal, session file, and coverage/impact reports (SPEC 7,
// 7.3, 7.4).
const E6_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  markdown: { emit: true },
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

const E6_OTHER = "specs/Other.mdx";
const E6_CORE = "specs/Core.mdx";
const E6_MOVED = "specs/sub/Moved.mdx";
const E6_REFS = "specs/Refs.mdx";
const E6_APP = "src/app.ts";

function otherSource(version: string): string {
  return ['<S id="oth">', `Other target text, ${version}.`, "</S>", ""].join(
    "\n",
  );
}

// The moved file imports another spec file (its own specifier is recomputed
// across the directory change) and its generated module is imported by a spec
// file and a code file (their specifiers are recomputed) — both rewrite
// directions of the E-6 specifier-computation probe (SPEC 6.5, 2.1).
const E6_CORE_SOURCE = [
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

const E6_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs" d={Core.core.mid}>',
  "Refs embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "",
].join("\n");

const E6_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

const GIT_DIR_BYTES = Buffer.from(".git", "utf8");

/** Exclude exactly the top-level `.git` tree from workspace snapshots. */
function excludeGitTree(relPathBytes: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(relPathBytes), GIT_DIR_BYTES) === 0;
}

/**
 * Run the representative E-6 fixture against `product` and capture its
 * outputs. Every step asserts its exact exit code (H-5), so a nonconforming
 * or stub product fails here as a diagnosed assertion failure (H-8) — the
 * caller never sees partial captures.
 */
export async function runE6RepresentativeFixture(
  product: ProductBinding,
): Promise<E6FixtureRun> {
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": E6_CONFIG,
      [E6_OTHER]: otherSource("version one"),
      [E6_CORE]: E6_CORE_SOURCE,
      [E6_REFS]: E6_REFS_SOURCE,
      [E6_APP]: E6_APP_SOURCE,
    },
  });
  try {
    // Baseline for `impact --base`: sources only, committed with pinned
    // platform-independent metadata so both legs realize identical commit
    // identities (E-6; helpers/workspace.ts).
    await workspace.gitInit();
    await workspace.gitCommitAll("e6 baseline");

    const steps: E6StepRecord[] = [];
    const step = async (
      name: string,
      argv: readonly string[],
      expectedExit: number,
      why: string,
    ): Promise<RunResult> => {
      const result = await runProduct(product, {
        cwd: workspace.root,
        argv,
      });
      assertExitCode(
        result,
        expectedExit,
        `E-6 representative fixture, step "${name}" (\`${argv.join(" ")}\`) — ${why}`,
      );
      steps.push({
        step: name,
        argv,
        exitCode: expectedExit,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
      });
      return result;
    };

    await step(
      "build",
      ["build"],
      0,
      "the staged workspace is valid (SPEC 12.1)",
    );
    await step(
      "check-json",
      ["check", "--json"],
      0,
      "a freshly built workspace is clean (SPEC 12.2)",
    );
    await step(
      "query-nodes",
      ["query", "nodes"],
      0,
      "the graph answers (SPEC 11)",
    );
    await step(
      "query-node",
      ["query", "node", `${E6_OTHER}#oth`],
      0,
      "the addressed node exists (SPEC 11, 1.5)",
    );
    await step(
      "query-edges",
      ["query", "edges", "--kinds", "depends,embeds,references"],
      0,
      "the dependency-kind edge sets answer (SPEC 11)",
    );
    await step(
      "coverage-json",
      ["coverage", "--json"],
      0,
      "the configured profile reports (SPEC 8.2, 12.5)",
    );
    await step(
      "coverage-human",
      ["coverage"],
      0,
      "the configured profile reports (SPEC 8.2, 12.5)",
    );

    // One leaf edit between the baseline and `impact`, so the report carries
    // categories; rebuild so derived files match the sources again before the
    // later clean `check` (SPEC 5.6, 14.13).
    await workspace.file(E6_OTHER, otherSource("version two"));
    await step(
      "build-after-edit",
      ["build"],
      0,
      "the edited workspace is still valid (SPEC 12.1)",
    );
    await step(
      "impact-json",
      ["impact", "--base", "HEAD", "--json"],
      0,
      "the pinned baseline commit resolves and the report answers (SPEC 9, 5.6)",
    );
    await step(
      "impact-human",
      ["impact", "--base", "HEAD"],
      0,
      "the pinned baseline commit resolves and the report answers (SPEC 9, 5.6)",
    );

    // Journaled rename: rewrites the ID and its references in MDX and
    // TypeScript sources, appending the mapping to the journal (SPEC 6.4).
    await step(
      "rename",
      ["rename", E6_CORE, "core.mid.leaf", "core.mid.tip"],
      0,
      "a valid rename succeeds and appends to the journal (SPEC 6.4, 6.1)",
    );

    // Journaled file-form move — the specifier-computation probe (E-6): the
    // moved file's own import and both importers of its generated module are
    // recomputed across the directory change (SPEC 6.5).
    await step(
      "move",
      ["move", E6_CORE, E6_MOVED],
      0,
      "a valid file-form move succeeds and appends to the journal (SPEC 6.5, 6.1)",
    );
    await step(
      "check-post-move",
      ["check"],
      0,
      "the move's finishing regeneration leaves the workspace clean — every " +
        "recomputed specifier resolves (SPEC 6.5, 14.10; T6.4-7)",
    );

    // Audit review session (SPEC 10): create, next --json, one resolve, and
    // an export; the session file is stored data compared across legs (1.5).
    await step(
      "review-create",
      ["review", "create", "--strategy", "audit", "--name", "r"],
      0,
      "an audit session over the built workspace is creatable (SPEC 10.7)",
    );
    const nextLabel = "E-6 representative fixture `review next r --json`";
    const next = decodeNextReport(
      parseJsonStdout(
        await step(
          "review-next",
          ["review", "next", "r", "--json"],
          0,
          "the fresh audit session answers (SPEC 10.7)",
        ),
        nextLabel,
      ),
      nextLabel,
    );
    if (next.fullyResolved || next.item === undefined) {
      fail(
        `${nextLabel}: a fresh audit session over a non-empty workspace has ` +
          `unresolved items, so \`next\` returns one (SPEC 10.6, 10.7); got ` +
          `fully-resolved`,
      );
    }
    // The item id is product-derived and deterministic over byte-identical
    // input (SPEC 12.0), so both legs resolve the same item and the recorded
    // argv still compares byte-identical across legs.
    await step(
      "review-resolve",
      ["review", "resolve", "r", next.item.id, "--status", "no-change"],
      0,
      "resolving the presented item succeeds (SPEC 10.4, 10.7)",
    );
    await step(
      "review-export",
      ["review", "export", "r", "--json"],
      0,
      "the session exports as one JSON payload (SPEC 10.7)",
    );

    const snapshot = await snapshotDirectory(workspace.root, {
      exclude: excludeGitTree,
    });
    return { steps, workspace: snapshot };
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// Exchange serialization (Linux leg)
// ---------------------------------------------------------------------------

function streamFileName(index: number, step: string, stream: string): string {
  return `${String(index + 1).padStart(2, "0")}-${step}.${stream}`;
}

/**
 * Write a fixture run's captures into the exchange directory: the manifest
 * (step names, argv, exit codes), one file per stdout/stderr stream, and the
 * final workspace tree. Replaces any previous exchange content it owns.
 */
export async function writeE6Exchange(
  run: E6FixtureRun,
  exchangeDir: string,
): Promise<void> {
  const absDir = path.resolve(exchangeDir);
  await fsp.mkdir(absDir, { recursive: true });
  for (const owned of [MANIFEST_NAME, STEPS_DIR, WORKSPACE_DIR]) {
    await fsp.rm(path.join(absDir, owned), { recursive: true, force: true });
  }

  const stepsDir = path.join(absDir, STEPS_DIR);
  await fsp.mkdir(stepsDir, { recursive: true });
  for (const [index, record] of run.steps.entries()) {
    await fsp.writeFile(
      path.join(stepsDir, streamFileName(index, record.step, "stdout")),
      record.stdoutBytes,
    );
    await fsp.writeFile(
      path.join(stepsDir, streamFileName(index, record.step, "stderr")),
      record.stderrBytes,
    );
  }

  await materializeSnapshot(run.workspace, path.join(absDir, WORKSPACE_DIR));

  const manifest = {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_FORMAT_VERSION,
    steps: run.steps.map((record) => ({
      step: record.step,
      argv: record.argv,
      exitCode: record.exitCode,
    })),
  };
  await fsp.writeFile(
    path.join(absDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/**
 * Write a snapshot's entries back out as a directory tree. The E-6 fixture
 * produces plain files and directories only (SPEC 13.4); anything else — or a
 * non-UTF-8 entry name — cannot ride the exchange artifact portably and is a
 * loud harness error, never a silent drop.
 */
async function materializeSnapshot(
  snapshot: DirectorySnapshot,
  destRoot: string,
): Promise<void> {
  await fsp.mkdir(destRoot, { recursive: true });
  for (const [key, entry] of snapshot.entries) {
    const bytes = Buffer.from(key, "latin1");
    let rel: string;
    try {
      rel = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        `E-6 exchange writer: workspace entry name is not valid UTF-8 and cannot ` +
          `ride the exchange artifact portably: <bytes 0x${bytes.toString("hex")}>`,
      );
    }
    const abs = path.join(destRoot, ...rel.split("/"));
    if (entry.kind === "dir") {
      await fsp.mkdir(abs, { recursive: true });
    } else if (entry.kind === "file") {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, entry.bytes);
    } else {
      throw new Error(
        `E-6 exchange writer: workspace entry ${rel} is a ${entry.kind}, which the ` +
          `exchange artifact cannot carry portably — the E-6 fixture and a conforming ` +
          `product produce plain files and directories only (SPEC 13.4)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Exchange comparison (Windows leg)
// ---------------------------------------------------------------------------

interface ExchangeStepMeta {
  readonly step: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
}

/**
 * The exchange directory from {@link E6_EXCHANGE_ENV}, or a loud error: the
 * comparison leg cannot run without the Linux outputs, and silently passing
 * (or skipping, H-9) would void the E-6 byte-identity guarantee. The caller
 * consults this only after its own fixture run succeeded, so this failure
 * means exactly "the product works but the exchange plumbing is broken".
 */
export function requireE6ExchangeDir(): string {
  const value = process.env[E6_EXCHANGE_ENV];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `E-6 byte-identity comparison: ${E6_EXCHANGE_ENV} is not set. The Windows CI ` +
        `leg receives the Linux leg's representative-fixture outputs through this ` +
        `directory (the e6-linux-outputs artifact, .github/workflows/ci.yml); without ` +
        `them the cross-leg comparison cannot run, and skipping it would void E-6 ` +
        `(H-9). Locally: run the suite on Linux with ${E6_EXCHANGE_ENV} set, then ` +
        `point the same variable here.`,
    );
  }
  return path.resolve(value);
}

async function readExchangeManifest(
  absDir: string,
): Promise<readonly ExchangeStepMeta[]> {
  const manifestPath = path.join(absDir, MANIFEST_NAME);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `E-6 byte-identity comparison: cannot read the exchange manifest at ` +
        `${manifestPath}: ${(error as Error).message}. This leg's fixture run ` +
        `succeeded, so the product exists — a missing exchange means the Linux leg ` +
        `produced no outputs (its own fixture run failed) or the artifact plumbing ` +
        `is broken (.github/workflows/ci.yml); the comparison fails loudly rather ` +
        `than passing vacuously (E-6, H-9).`,
    );
  }
  const malformed = (detail: string): never => {
    throw new Error(
      `E-6 byte-identity comparison: malformed exchange manifest at ${manifestPath}: ${detail}`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return malformed(`not JSON — ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return malformed("not a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc["format"] !== EXCHANGE_FORMAT) {
    return malformed(
      `format is ${JSON.stringify(doc["format"])}, expected ${JSON.stringify(EXCHANGE_FORMAT)}`,
    );
  }
  if (doc["version"] !== EXCHANGE_FORMAT_VERSION) {
    return malformed(
      `version is ${JSON.stringify(doc["version"])}, expected ${String(EXCHANGE_FORMAT_VERSION)} — ` +
        `both CI legs must run the same harness commit`,
    );
  }
  const steps = doc["steps"];
  if (!Array.isArray(steps)) {
    return malformed("steps is not an array");
  }
  return steps.map((element, index): ExchangeStepMeta => {
    if (typeof element !== "object" || element === null) {
      return malformed(`steps[${String(index)}] is not an object`);
    }
    const entry = element as Record<string, unknown>;
    const step = entry["step"];
    const argv = entry["argv"];
    const exitCode = entry["exitCode"];
    if (typeof step !== "string" || step === "") {
      return malformed(
        `steps[${String(index)}].step is not a non-empty string`,
      );
    }
    if (
      !Array.isArray(argv) ||
      !argv.every((arg): arg is string => typeof arg === "string")
    ) {
      return malformed(`steps[${String(index)}].argv is not a string array`);
    }
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
      return malformed(`steps[${String(index)}].exitCode is not an integer`);
    }
    return { step, argv, exitCode };
  });
}

async function readExchangeStream(
  absDir: string,
  index: number,
  step: string,
  stream: "stdout" | "stderr",
): Promise<Uint8Array> {
  const streamPath = path.join(
    absDir,
    STEPS_DIR,
    streamFileName(index, step, stream),
  );
  try {
    return await fsp.readFile(streamPath);
  } catch (error) {
    throw new Error(
      `E-6 byte-identity comparison: the exchange manifest names step ` +
        `"${step}" but its ${stream} bytes are missing at ${streamPath}: ` +
        `${(error as Error).message} — the exchange is incomplete, so the ` +
        `comparison fails loudly (E-6, H-9)`,
    );
  }
}

/**
 * Assert this leg's fixture run is byte-identical to the exchanged Linux-leg
 * outputs: same steps (names, argv, exit codes), byte-identical stdout and
 * stderr per step, and a byte-identical final workspace tree (E-6; H-4 —
 * a product-to-itself comparison). A missing or malformed exchange is a loud
 * error (see {@link readExchangeManifest}); a divergence is a diagnosed
 * assertion failure naming the differing step or path.
 */
export async function assertE6RunMatchesExchange(
  run: E6FixtureRun,
  exchangeDir: string,
): Promise<void> {
  const absDir = path.resolve(exchangeDir);
  const exchanged = await readExchangeManifest(absDir);

  if (exchanged.length !== run.steps.length) {
    fail(
      `E-6 byte-identity: the Linux leg exchanged ${String(exchanged.length)} step(s) ` +
        `but this leg's fixture ran ${String(run.steps.length)} — both legs must run ` +
        `the identical fixture (same harness commit, E-6)`,
    );
  }
  for (const [index, local] of run.steps.entries()) {
    const linux = exchanged[index]!;
    const context = `E-6 byte-identity, step ${String(index + 1)} "${local.step}"`;
    if (linux.step !== local.step) {
      fail(
        `${context}: step names diverge — Linux leg ran "${linux.step}" — both legs ` +
          `must run the identical fixture (E-6)`,
      );
    }
    if (JSON.stringify(linux.argv) !== JSON.stringify(local.argv)) {
      fail(
        `${context}: argv diverges across legs\n` +
          `  this leg:  ${JSON.stringify(local.argv)}\n` +
          `  Linux leg: ${JSON.stringify(linux.argv)}\n` +
          `(product-derived arguments — the resolved review item id — must be ` +
          `deterministic over byte-identical input, SPEC 12.0)`,
      );
    }
    if (linux.exitCode !== local.exitCode) {
      fail(
        `${context}: exit codes diverge — this leg ${String(local.exitCode)}, Linux ` +
          `leg ${String(linux.exitCode)} (SPEC 12.0)`,
      );
    }
    assertBytesEqual(
      local.stdoutBytes,
      await readExchangeStream(absDir, index, local.step, "stdout"),
      `${context}: stdout (this leg) vs the Linux leg's — reports carry no ` +
        `environment-dependent content and paths are /-separated on every ` +
        `platform (SPEC 12.0, 1.5)`,
    );
    assertBytesEqual(
      local.stderrBytes,
      await readExchangeStream(absDir, index, local.step, "stderr"),
      `${context}: stderr (this leg) vs the Linux leg's (SPEC 12.0)`,
    );
  }

  const linuxWorkspace = await snapshotExchangeWorkspace(absDir);
  assertSnapshotsEqual(
    run.workspace,
    linuxWorkspace,
    `E-6 byte-identity: final workspace tree (first = this leg's run, second = ` +
      `the Linux leg's exchanged tree; .git/ excluded) — move-rewritten sources, ` +
      `generated files, emitted Markdown, graph data, journal, and session file ` +
      `are byte-identical across legs (E-6; SPEC 12.0, 1.5)`,
  );
}

async function snapshotExchangeWorkspace(
  absDir: string,
): Promise<DirectorySnapshot> {
  const workspaceDir = path.join(absDir, WORKSPACE_DIR);
  try {
    return await snapshotDirectory(workspaceDir);
  } catch (error) {
    throw new Error(
      `E-6 byte-identity comparison: cannot read the exchanged workspace tree at ` +
        `${workspaceDir}: ${(error as Error).message} — the exchange is incomplete, ` +
        `so the comparison fails loudly (E-6, H-9)`,
    );
  }
}
