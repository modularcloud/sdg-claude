// The H-6 determinism protocol for the xspec test harness (TEST-SPEC H-6,
// H-4; SPEC.md 12.0). Harness machinery only: no product imports; products
// are driven strictly through the subprocess driver's ProductBinding (H-2),
// so the same protocol runs against the built product or any certification
// fixture (C-2).
//
// Tests marked *determinism* either run the same command twice or rebuild
// the identical workspace in two separate directories, then assert
// byte-identical outputs and written files, normalizing nothing:
//
// - `assertRunTwiceDeterministic`: run → snapshot → run again → snapshot;
//   the two runs' exit outcomes, stdout, and stderr must be byte-identical,
//   and the workspace byte state after run 2 must equal the state after
//   run 1 (a deterministic command rewrites exactly what it wrote).
// - `assertAcrossDirectoriesDeterministic`: build the same workspace twice
//   (SPEC.md 1.5's workspace-relative paths make the comparison well-defined
//   across directories), run the same command in each, and assert the runs'
//   outputs are byte-identical and the *written files* — each directory's
//   before/after delta — are the same set of paths with byte-identical
//   resulting states. Comparing write deltas rather than whole final trees
//   keeps fixture machinery out of the verdict: `.git/` internals (the
//   index) legitimately embed machine state even for identically scripted
//   repositories, and the product never writes them (T12.0-11). A fixture
//   factory that fails to rebuild identical non-`.git` content is a harness
//   bug and is reported as a plain `Error`, not an assertion failure.

import { assertBytesEqual, fail, HarnessAssertionError } from "./assertions.js";
import type {
  DirectorySnapshot,
  SnapshotChange,
  SnapshotEntry,
} from "./snapshot.js";
import {
  assertSnapshotsEqual,
  describeEntryDifference,
  diffSnapshots,
  snapshotDirectory,
} from "./snapshot.js";
import type { ProductBinding, RunOptions, RunResult } from "./subprocess.js";
import { runProduct, summarizeResult } from "./subprocess.js";
import type { TestWorkspace } from "./workspace.js";

export interface RunTwiceDeterminismOptions {
  readonly binding: ProductBinding;
  /** The command to run twice, unchanged. */
  readonly run: RunOptions;
  /** Directory whose byte state is compared; defaults to `run.cwd`. */
  readonly workspaceDir?: string;
  /** Names the assertion in failure diagnoses. */
  readonly context?: string;
}

export interface DeterminismRunPair {
  readonly first: RunResult;
  readonly second: RunResult;
}

/**
 * H-6, same-command-twice form. Returns both run results so callers can go
 * on asserting exit codes and adapter-decoded content.
 */
export async function assertRunTwiceDeterministic(
  options: RunTwiceDeterminismOptions,
): Promise<DeterminismRunPair> {
  const workspaceDir = options.workspaceDir ?? options.run.cwd;
  const context =
    options.context ?? `H-6 run-twice determinism of ${options.binding.label}`;
  const first = await runProduct(options.binding, options.run);
  const afterFirst = await snapshotDirectory(workspaceDir);
  const second = await runProduct(options.binding, options.run);
  const afterSecond = await snapshotDirectory(workspaceDir);
  assertRunOutcomesEqual(second, first, context, "run 2", "run 1");
  assertSnapshotsEqual(
    afterFirst,
    afterSecond,
    `${context}: workspace byte state after run 2 vs after run 1`,
  );
  return { first, second };
}

export interface TwoDirectoryDeterminismOptions {
  /**
   * Build one instance of the identical workspace; called twice. Register
   * disposal in the factory (e.g. Vitest `onTestFinished`) — this protocol
   * never disposes, so callers can keep asserting on the workspaces.
   */
  readonly makeWorkspace: () => Promise<TestWorkspace>;
  readonly binding: ProductBinding;
  /** The command to run in a given workspace (typically `cwd: ws.root`). */
  readonly makeRun: (workspace: TestWorkspace) => RunOptions;
  /** Names the assertion in failure diagnoses. */
  readonly context?: string;
}

export interface TwoDirectoryDeterminismResult extends DeterminismRunPair {
  readonly firstWorkspace: TestWorkspace;
  readonly secondWorkspace: TestWorkspace;
}

/**
 * H-6, identical-workspace-in-two-directories form. Asserts byte-identical
 * outputs and byte-identical written files (see the module header); returns
 * both runs and both workspaces for further assertions.
 */
export async function assertAcrossDirectoriesDeterministic(
  options: TwoDirectoryDeterminismOptions,
): Promise<TwoDirectoryDeterminismResult> {
  const context =
    options.context ??
    `H-6 two-directory determinism of ${options.binding.label}`;
  const firstWorkspace = await options.makeWorkspace();
  const secondWorkspace = await options.makeWorkspace();
  if (firstWorkspace.root === secondWorkspace.root) {
    throw new Error(
      `${context}: makeWorkspace() returned the same root twice (${firstWorkspace.root}) — the protocol needs two separate directories`,
    );
  }
  const preFirst = await snapshotDirectory(firstWorkspace.root);
  const preSecond = await snapshotDirectory(secondWorkspace.root);
  const fixtureDrift = diffSnapshots(preFirst, preSecond).filter(
    (change) => !isGitInternal(change.key),
  );
  if (fixtureDrift.length > 0) {
    throw new Error(
      `${context}: the workspace factory did not rebuild an identical workspace — H-6's two-directory conclusion is only meaningful over identical inputs, so this is a harness bug, not a product observation. Non-.git differences:\n${fixtureDrift
        .map((change) => `  - ${change.path}: ${change.detail}`)
        .join("\n")}`,
    );
  }
  const first = await runProduct(
    options.binding,
    options.makeRun(firstWorkspace),
  );
  const second = await runProduct(
    options.binding,
    options.makeRun(secondWorkspace),
  );
  const postFirst = await snapshotDirectory(firstWorkspace.root);
  const postSecond = await snapshotDirectory(secondWorkspace.root);
  assertRunOutcomesEqual(
    second,
    first,
    context,
    "the run in directory 2",
    "the run in directory 1",
  );
  assertWriteDeltasEqual(
    diffSnapshots(preFirst, postFirst),
    postFirst,
    diffSnapshots(preSecond, postSecond),
    postSecond,
    context,
  );
  return { first, second, firstWorkspace, secondWorkspace };
}

/**
 * Assert two runs ended identically: same exit code and signal, and
 * byte-identical stdout and stderr (H-6 "byte-identical outputs").
 */
export function assertRunOutcomesEqual(
  actual: RunResult,
  expected: RunResult,
  context: string,
  actualLabel = "actual run",
  expectedLabel = "expected run",
): void {
  if (
    actual.exitCode !== expected.exitCode ||
    actual.signal !== expected.signal
  ) {
    fail(
      `${context}: exit outcome differs — ${actualLabel}: ${summarizeResult(actual)}; ${expectedLabel}: ${summarizeResult(expected)} (${actual.commandLine})`,
    );
  }
  assertBytesEqual(
    actual.stdoutBytes,
    expected.stdoutBytes,
    `${context}: stdout of ${actualLabel} vs ${expectedLabel} (byte-identical outputs, H-6)`,
  );
  assertBytesEqual(
    actual.stderrBytes,
    expected.stderrBytes,
    `${context}: stderr of ${actualLabel} vs ${expectedLabel} (byte-identical outputs, H-6)`,
  );
}

function isGitInternal(key: string): boolean {
  return key === ".git" || key.startsWith(".git/");
}

function assertWriteDeltasEqual(
  deltaFirst: readonly SnapshotChange[],
  postFirst: DirectorySnapshot,
  deltaSecond: readonly SnapshotChange[],
  postSecond: DirectorySnapshot,
  context: string,
): void {
  const firstByKey = new Map(deltaFirst.map((change) => [change.key, change]));
  const secondByKey = new Map(
    deltaSecond.map((change) => [change.key, change]),
  );
  const keys = [
    ...new Set([...firstByKey.keys(), ...secondByKey.keys()]),
  ].sort();
  const problems: string[] = [];
  for (const key of keys) {
    const changeFirst = firstByKey.get(key);
    const changeSecond = secondByKey.get(key);
    if (changeFirst !== undefined && changeSecond === undefined) {
      problems.push(
        `  - ${changeFirst.path}: ${changeFirst.change} by the run in directory 1 (${firstLine(changeFirst.detail)}) but untouched in directory 2`,
      );
      continue;
    }
    if (changeFirst === undefined && changeSecond !== undefined) {
      problems.push(
        `  - ${changeSecond.path}: ${changeSecond.change} by the run in directory 2 (${firstLine(changeSecond.detail)}) but untouched in directory 1`,
      );
      continue;
    }
    if (changeFirst === undefined || changeSecond === undefined) continue;
    if (changeFirst.change !== changeSecond.change) {
      problems.push(
        `  - ${changeFirst.path}: ${changeFirst.change} in directory 1 but ${changeSecond.change} in directory 2`,
      );
      continue;
    }
    if (changeFirst.change === "removed") continue;
    const difference = writtenStateDifference(
      postFirst.entries.get(key),
      postSecond.entries.get(key),
    );
    if (difference !== undefined) {
      problems.push(
        `  - ${changeFirst.path}: written state differs between the two directories: ${difference.split("\n").join("\n    ")}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new HarnessAssertionError(
      `${context}: written files are not byte-identical across the two directories (H-6, normalizing nothing):\n${problems.join("\n")}`,
    );
  }
}

function writtenStateDifference(
  first: SnapshotEntry | undefined,
  second: SnapshotEntry | undefined,
): string | undefined {
  // Both entries exist for "added"/"changed" deltas by construction; guard
  // against internal inconsistency all the same.
  if (first === undefined || second === undefined) {
    throw new Error(
      "determinism protocol internal error: a non-removed delta entry is missing from its post-run snapshot",
    );
  }
  return describeEntryDifference(first, second);
}

function firstLine(text: string): string {
  return text.split("\n")[0];
}
