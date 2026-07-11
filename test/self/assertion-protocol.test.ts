// Self-checks for the shared assertion protocol (TEST-SPEC 17 preamble:
// internal self-tests cover harness machinery certification does not
// exercise; HARNESS conventions H-4/H-5/H-6/H-8). Every helper is exercised
// positively (conforming input passes) and negatively (violating input fails
// as a diagnosed HarnessAssertionError — the failure shape product-facing
// tests must produce against a stub product):
//
// - byte-equality assertions over outputs and files (H-4, normalizing
//   nothing);
// - exit-code and stream-convention assertions of SPEC.md 12.0 (H-5,
//   `--json` stdout is exactly one JSON document, or empty on exit 2);
// - whole-directory byte snapshots and compares (modifies-nothing and
//   compare-around-command protocols);
// - the H-6 determinism protocol, run against known-behavior stand-in
//   commands (deterministic and deliberately nondeterministic) through the
//   same ProductBinding shape product-facing tests use.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import { expect, onTestFinished, test } from "vitest";
import {
  asBytes,
  assertBytesEqual,
  assertExitCode,
  assertFileBytes,
  assertFilesEqual,
  assertJsonOutputConvention,
  assertStderrEmpty,
  assertStdoutEmpty,
  fail,
  HarnessAssertionError,
  parseJsonStdout,
} from "../helpers/assertions.js";
import {
  assertAcrossDirectoriesDeterministic,
  assertRunTwiceDeterministic,
} from "../helpers/determinism.js";
import {
  assertDirectoriesEqual,
  assertLeavesUnchanged,
  assertSnapshotsEqual,
  diffSnapshots,
  displaySnapshotPath,
  snapshotDirectory,
} from "../helpers/snapshot.js";
import type { ProductBinding, RunResult } from "../helpers/subprocess.js";
import { TestWorkspace } from "../helpers/workspace.js";

const onPosix = process.platform !== "win32";
const onLinux = process.platform === "linux";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const hex = (data: Uint8Array): string => Buffer.from(data).toString("hex");

/** A fabricated run result — unit-level input for the H-5 assertions. */
function syntheticResult(init: {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}): RunResult {
  const stdoutBytes = asBytes(init.stdout ?? "");
  const stderrBytes = asBytes(init.stderr ?? "");
  return {
    exitCode: init.exitCode === undefined ? 0 : init.exitCode,
    signal: init.signal ?? null,
    stdout: Buffer.from(stdoutBytes).toString("utf8"),
    stderr: Buffer.from(stderrBytes).toString("utf8"),
    stdoutBytes,
    stderrBytes,
    commandLine: "`stand-in --json` [synthetic result]",
  };
}

/**
 * Assert a helper call fails as a diagnosed assertion failure — a
 * HarnessAssertionError whose message matches every pattern — and return the
 * failure for further checks. Passing (not throwing) is itself a failure.
 */
function expectDiagnosed(
  run: () => unknown,
  ...patterns: (string | RegExp)[]
): HarnessAssertionError {
  try {
    run();
  } catch (error) {
    return checkDiagnosed(error, patterns);
  }
  throw new Error(
    "expected a diagnosed assertion failure, but the helper passed",
  );
}

async function expectDiagnosedAsync(
  run: () => Promise<unknown>,
  ...patterns: (string | RegExp)[]
): Promise<HarnessAssertionError> {
  try {
    await run();
  } catch (error) {
    return checkDiagnosed(error, patterns);
  }
  throw new Error(
    "expected a diagnosed assertion failure, but the helper passed",
  );
}

function checkDiagnosed(
  error: unknown,
  patterns: readonly (string | RegExp)[],
): HarnessAssertionError {
  expect(error).toBeInstanceOf(HarnessAssertionError);
  const message = (error as Error).message;
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      expect(message).toContain(pattern);
    } else {
      expect(message).toMatch(pattern);
    }
  }
  return error as HarnessAssertionError;
}

// ---------------------------------------------------------------------------
// HarnessAssertionError and byte-equality assertions (H-4)
// ---------------------------------------------------------------------------

test("fail() throws a HarnessAssertionError — the diagnosed-assertion-failure shape of H-8", () => {
  const failure = expectDiagnosed(
    () => fail("diagnosed: expected X, observed Y"),
    "diagnosed: expected X, observed Y",
  );
  expect(failure.name).toBe("HarnessAssertionError");
  expect(failure).toBeInstanceOf(Error);
});

test("assertBytesEqual passes on identical bytes across string, byte, and mixed forms (CRLF and invalid UTF-8 included)", () => {
  assertBytesEqual("héllo\r\n", "héllo\r\n", "strings");
  assertBytesEqual(
    bytes(0xc3, 0x28, 0x00, 0xff),
    bytes(0xc3, 0x28, 0x00, 0xff),
    "raw non-UTF-8 bytes",
  );
  assertBytesEqual(bytes(0x68, 0x69), "hi", "mixed forms");
  assertBytesEqual("", bytes(), "empty");
});

test("assertBytesEqual fails diagnosed with context, offset, and lengths — and never normalizes line terminators", () => {
  const failure = expectDiagnosed(
    () =>
      assertBytesEqual("line one\r\nline two", "line one\nline two", "T-demo"),
    "T-demo",
    /first difference at byte offset 8/,
    "normalizing nothing",
  );
  // The printable window shows the terminator bytes escaped.
  expect(failure.message).toContain("\\r");
  expectDiagnosed(
    () => assertBytesEqual("abc", "abcd", "strict-prefix case"),
    /offset 3/,
    /actual: 3 bytes, expected: 4 bytes/,
  );
});

test("assertFileBytes round-trips exact file bytes; mismatching and missing files fail diagnosed, never as crashes (H-8)", async () => {
  const workspace = await TestWorkspace.create({
    files: {
      "raw.bin": bytes(0x00, 0xff, 0x0d, 0x0a),
      "text.md": "# t\r\n",
    },
  });
  onTestFinished(() => workspace.dispose());
  await assertFileBytes(
    workspace.path("raw.bin"),
    bytes(0x00, 0xff, 0x0d, 0x0a),
  );
  await assertFileBytes(workspace.path("text.md"), "# t\r\n", "markdown out");
  await expectDiagnosedAsync(
    () => assertFileBytes(workspace.path("text.md"), "# t\n", "markdown out"),
    "markdown out",
    /offset 3/,
  );
  await expectDiagnosedAsync(
    () => assertFileBytes(workspace.path("never-written.json"), "{}", "graph"),
    "graph",
    "never-written.json",
    /reading it failed/,
  );
});

test("assertFilesEqual compares two files byte-wise; a missing side is diagnosed", async () => {
  const workspace = await TestWorkspace.create({
    files: {
      "a.out": "payload\n",
      "b.out": "payload\n",
      "c.out": "payloae\n",
    },
  });
  onTestFinished(() => workspace.dispose());
  await assertFilesEqual(workspace.path("a.out"), workspace.path("b.out"));
  await expectDiagnosedAsync(
    () =>
      assertFilesEqual(workspace.path("a.out"), workspace.path("c.out"), "a/c"),
    "a/c",
    /offset 6/,
  );
  await expectDiagnosedAsync(
    () => assertFilesEqual(workspace.path("a.out"), workspace.path("gone")),
    "gone",
    /reading it failed/,
  );
});

// ---------------------------------------------------------------------------
// Exit-code and stream-convention assertions (H-5; SPEC.md 12.0)
// ---------------------------------------------------------------------------

test("assertExitCode passes on the exact code and fails diagnosed on mismatch or signal death (H-5)", () => {
  assertExitCode(syntheticResult({ exitCode: 0 }), 0);
  assertExitCode(syntheticResult({ exitCode: 2, stderr: "usage: xspec" }), 2);
  expectDiagnosed(
    () =>
      assertExitCode(
        syntheticResult({ exitCode: 86, stderr: "stub stderr" }),
        0,
        "stub build",
      ),
    "stub build",
    "expected exit code 0",
    "exit code 86",
    "stub stderr",
  );
  expectDiagnosed(
    () =>
      assertExitCode(syntheticResult({ exitCode: null, signal: "SIGKILL" }), 0),
    /died by signal/,
    "SIGKILL",
  );
});

test("assertStdoutEmpty / assertStderrEmpty enforce byte-empty streams, diagnosed with an excerpt", () => {
  const clean = syntheticResult({});
  assertStdoutEmpty(clean);
  assertStderrEmpty(clean);
  expectDiagnosed(
    () =>
      assertStdoutEmpty(
        syntheticResult({ stdout: "spurious report\n" }),
        "quiet command",
      ),
    "quiet command",
    /expected empty stdout/,
    "spurious report",
  );
  expectDiagnosed(
    () => assertStderrEmpty(syntheticResult({ stderr: "diagnostic\n" })),
    /expected empty stderr/,
    "diagnostic",
  );
});

test("parseJsonStdout accepts exactly one JSON document as the entire stdout (trailing newline included) and returns it parsed", () => {
  expect(
    parseJsonStdout(syntheticResult({ stdout: '{"nodes":[1,2]}\n' })),
  ).toEqual({ nodes: [1, 2] });
  expect(parseJsonStdout(syntheticResult({ stdout: "42" }))).toBe(42);
});

test("parseJsonStdout fails diagnosed on empty stdout, concatenated documents, trailing garbage, diagnostic contamination, and invalid UTF-8", () => {
  expectDiagnosed(
    () => parseJsonStdout(syntheticResult({ stdout: "" }), "empty case"),
    "empty case",
    /stdout is empty/,
  );
  expectDiagnosed(
    () => parseJsonStdout(syntheticResult({ stdout: '{"a":1}\n{"b":2}\n' })),
    /not exactly one JSON document/,
  );
  expectDiagnosed(
    () => parseJsonStdout(syntheticResult({ stdout: '{"a":1} trailing' })),
    /not exactly one JSON document/,
  );
  expectDiagnosed(
    () => parseJsonStdout(syntheticResult({ stdout: 'warning: x\n{"a":1}\n' })),
    /not exactly one JSON document/,
  );
  expectDiagnosed(
    () => parseJsonStdout(syntheticResult({ stdout: bytes(0x22, 0xff, 0x22) })),
    /not valid UTF-8/,
  );
});

test("assertJsonOutputConvention: one document on exit 0/1, empty stdout on exit 2, everything else diagnosed (12.0/H-5)", () => {
  expect(
    assertJsonOutputConvention(
      syntheticResult({ exitCode: 0, stdout: '{"ok":true}\n' }),
    ),
  ).toEqual({ ok: true });
  expect(
    assertJsonOutputConvention(
      syntheticResult({ exitCode: 1, stdout: '{"findings":[]}\n' }),
    ),
  ).toEqual({ findings: [] });
  expect(
    assertJsonOutputConvention(
      syntheticResult({ exitCode: 2, stderr: "usage: xspec\n" }),
    ),
  ).toBeUndefined();
  expectDiagnosed(
    () =>
      assertJsonOutputConvention(
        syntheticResult({ exitCode: 2, stdout: "contaminated\n" }),
      ),
    /stdout must be empty on exit 2/,
    "contaminated",
  );
  expectDiagnosed(
    () => assertJsonOutputConvention(syntheticResult({ exitCode: 0 })),
    /stdout is empty/,
  );
  expectDiagnosed(
    () =>
      assertJsonOutputConvention(
        syntheticResult({ exitCode: 86 }),
        "stub product",
      ),
    "stub product",
    /outside the SPEC\.md 12\.0 partition/,
    "86",
  );
  expectDiagnosed(
    () =>
      assertJsonOutputConvention(
        syntheticResult({ exitCode: null, signal: "SIGSEGV" }),
      ),
    /died by signal/,
  );
});

// ---------------------------------------------------------------------------
// Whole-directory byte snapshots and compares (H-4/H-6)
// ---------------------------------------------------------------------------

test("snapshotDirectory captures files, empty directories, and nested trees byte-exactly with '/'-separated keys", async () => {
  const workspace = await TestWorkspace.create({
    files: {
      "a.txt": "alpha\r\n",
      "sub/dir/b.bin": bytes(0x00, 0xff, 0xc3, 0x28),
    },
    dirs: ["empty"],
  });
  onTestFinished(() => workspace.dispose());
  const snapshot = await snapshotDirectory(workspace.root);
  expect([...snapshot.entries.keys()]).toEqual([
    "a.txt",
    "empty",
    "sub",
    "sub/dir",
    "sub/dir/b.bin",
  ]);
  const file = snapshot.entries.get("sub/dir/b.bin");
  if (file?.kind !== "file") throw new Error("expected a file entry");
  expect(hex(file.bytes)).toBe("00ffc328");
  expect(snapshot.entries.get("empty")).toEqual({ kind: "dir" });
  // Repeated snapshots of an untouched tree compare equal.
  assertSnapshotsEqual(
    snapshot,
    await snapshotDirectory(workspace.root),
    "untouched tree",
  );
});

test("diffSnapshots and assertSnapshotsEqual detect added, removed, byte-modified, and kind-changed entries, diagnosed per path", async () => {
  const workspace = await TestWorkspace.create({
    files: {
      "keep.txt": "same\n",
      "mutate.txt": "abcdef",
      "remove.txt": "going away\n",
      "becomes-dir": "file for now",
    },
  });
  onTestFinished(() => workspace.dispose());
  const before = await snapshotDirectory(workspace.root);
  await workspace.file("mutate.txt", "abcXef");
  await fsp.rm(workspace.path("remove.txt"));
  await fsp.rm(workspace.path("becomes-dir"));
  await workspace.dir("becomes-dir");
  await workspace.file("added.txt", "new\n");
  const after = await snapshotDirectory(workspace.root);
  const changes = diffSnapshots(before, after);
  expect(changes.map((change) => [change.change, change.path])).toEqual([
    ["added", "added.txt"],
    ["changed", "becomes-dir"],
    ["changed", "mutate.txt"],
    ["removed", "remove.txt"],
  ]);
  const failure = expectDiagnosed(
    () => assertSnapshotsEqual(before, after, "change classes"),
    "change classes",
    "added.txt",
    "becomes-dir",
    /kind changed: file → dir/,
    "mutate.txt",
    /offset 3/,
    "remove.txt",
  );
  expect(failure.message).toContain("4 byte-state difference(s)");
});

test.runIf(onPosix)(
  "snapshots record symlink targets verbatim, never traverse symlinked directories, and detect retargeting",
  async () => {
    const workspace = await TestWorkspace.create({
      files: { "real/inner.txt": "inner\n" },
      symlinks: {
        "link-to-file": "real/inner.txt",
        "link-to-dir": "real",
        dangling: "no/such/target",
      },
    });
    onTestFinished(() => workspace.dispose());
    const before = await snapshotDirectory(workspace.root);
    const linkToFile = before.entries.get("link-to-file");
    if (linkToFile?.kind !== "symlink") {
      throw new Error("expected a symlink entry");
    }
    expect(Buffer.from(linkToFile.target).toString("utf8")).toBe(
      "real/inner.txt",
    );
    // A symlinked directory is a leaf: no traversal through it.
    expect(before.entries.get("link-to-dir")?.kind).toBe("symlink");
    expect(before.entries.has("link-to-dir/inner.txt")).toBe(false);
    expect(before.entries.get("dangling")?.kind).toBe("symlink");
    await fsp.rm(workspace.path("link-to-file"));
    await workspace.symlink("link-to-file", "real");
    const after = await snapshotDirectory(workspace.root);
    expectDiagnosed(
      () => assertSnapshotsEqual(before, after, "retarget"),
      "link-to-file",
      /symlink target changed/,
    );
  },
);

test.runIf(onLinux)(
  "non-UTF-8 entry names round-trip in snapshots and are diagnosed as hex",
  async () => {
    const workspace = await TestWorkspace.create();
    onTestFinished(() => workspace.dispose());
    const name = Buffer.concat([
      Buffer.from("bad-"),
      Buffer.from([0xff]),
      Buffer.from(".mdx"),
    ]);
    await workspace.file(name, "payload\n");
    const before = await snapshotDirectory(workspace.root);
    const key = name.toString("latin1");
    expect(before.entries.get(key)?.kind).toBe("file");
    expect(displaySnapshotPath(key)).toBe("<path bytes 6261642dff2e6d6478>");
    await workspace.file(name, "changed\n");
    const after = await snapshotDirectory(workspace.root);
    const changes = diffSnapshots(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("<path bytes 6261642dff2e6d6478>");
    expectDiagnosed(
      () => assertSnapshotsEqual(before, after, "non-UTF-8 name"),
      "6261642dff2e6d6478",
    );
  },
);

test("the exclude option prunes whole subtrees from snapshots", async () => {
  const workspace = await TestWorkspace.create({
    files: { "kept.txt": "k\n", ".git/index": "machine state 1" },
  });
  onTestFinished(() => workspace.dispose());
  const exclude = (rel: Uint8Array): boolean =>
    Buffer.from(rel).toString("latin1") === ".git";
  const before = await snapshotDirectory(workspace.root, { exclude });
  expect(before.entries.has(".git")).toBe(false);
  expect(before.entries.has(".git/index")).toBe(false);
  expect(before.entries.has("kept.txt")).toBe(true);
  await workspace.file(".git/index", "machine state 2");
  assertSnapshotsEqual(
    before,
    await snapshotDirectory(workspace.root, { exclude }),
    "excluded subtree may drift",
  );
});

test("assertDirectoriesEqual passes for identically built trees and fails diagnosed on a one-byte (CRLF vs LF) difference", async () => {
  const decl = {
    files: { "a.txt": "same bytes\r\n", "sub/b.bin": bytes(0x01, 0x02) },
  };
  const one = await TestWorkspace.create(decl);
  const two = await TestWorkspace.create(decl);
  onTestFinished(() => one.dispose());
  onTestFinished(() => two.dispose());
  await assertDirectoriesEqual(one.root, two.root, "identical trees");
  await two.file("a.txt", "same bytes\n");
  await expectDiagnosedAsync(
    () => assertDirectoriesEqual(one.root, two.root, "terminator flip"),
    "terminator flip",
    "a.txt",
    /offset 10/,
  );
});

test("assertLeavesUnchanged returns the action's result when nothing changes and fails diagnosed when the action writes or mutates", async () => {
  const workspace = await TestWorkspace.create({
    files: { "data.txt": "stable\n" },
  });
  onTestFinished(() => workspace.dispose());
  const value = await assertLeavesUnchanged(
    workspace.root,
    async () => {
      await workspace.readBytes("data.txt");
      return 42;
    },
    "read-only action",
  );
  expect(value).toBe(42);
  await expectDiagnosedAsync(
    () =>
      assertLeavesUnchanged(
        workspace.root,
        () => workspace.file("written.txt", "x\n"),
        "writing action",
      ),
    "writing action",
    "modifies-nothing compare",
    "written.txt",
  );
  await expectDiagnosedAsync(
    () =>
      assertLeavesUnchanged(
        workspace.root,
        () => workspace.file("data.txt", "STABLE\n"),
        "mutating action",
      ),
    "mutating action",
    "data.txt",
    /offset 0/,
  );
});

// ---------------------------------------------------------------------------
// The H-6 determinism protocol, against known-behavior stand-in commands
// ---------------------------------------------------------------------------

// Every mode's behavior is fixed by this source, so the protocol's verdicts
// have an unambiguous ground truth: "emit" is fully deterministic and
// path-independent; each "flaky-*"/"leak-*" mode is nondeterministic in
// exactly one observable (stdout, written file bytes, exit outcome, written
// file set, or directory dependence).
const DETERMINISM_STANDIN_SOURCE = `import fs from "node:fs";
import path from "node:path";

const [mode] = process.argv.slice(2);
switch (mode) {
  case "emit": {
    fs.mkdirSync("out", { recursive: true });
    fs.writeFileSync(path.join("out", "derived.txt"), "derived\\r\\nsecond line\\n");
    fs.writeFileSync(path.join("out", "raw.bin"), Buffer.from([0x00, 0xff, 0x0d]));
    fs.rmSync("obsolete.txt", { force: true });
    process.stdout.write("built 2 files\\n");
    process.exit(0);
    break;
  }
  case "flaky-output": {
    process.stdout.write("run token " + process.hrtime.bigint() + "\\n");
    process.exit(0);
    break;
  }
  case "flaky-file": {
    fs.appendFileSync("counter.txt", "tick\\n");
    process.stdout.write("ok\\n");
    process.exit(0);
    break;
  }
  case "flaky-exit": {
    if (fs.existsSync("marker.txt")) process.exit(3);
    fs.writeFileSync("marker.txt", "first run\\n");
    process.exit(0);
    break;
  }
  case "leak-cwd-stdout": {
    process.stdout.write(process.cwd() + "\\n");
    process.exit(0);
    break;
  }
  case "leak-cwd-file": {
    fs.mkdirSync("out", { recursive: true });
    fs.writeFileSync(path.join("out", "where.txt"), process.cwd() + "\\n");
    process.stdout.write("ok\\n");
    process.exit(0);
    break;
  }
  case "leak-name": {
    fs.writeFileSync("mark-" + process.cwd().replace(/[^A-Za-z0-9]+/g, "_"), "x\\n");
    process.stdout.write("ok\\n");
    process.exit(0);
    break;
  }
  default: {
    process.stderr.write("unknown mode: " + String(mode));
    process.exit(99);
  }
}
`;

async function determinismStandin(): Promise<ProductBinding> {
  const host = await TestWorkspace.create({
    files: { "standin.mjs": DETERMINISM_STANDIN_SOURCE },
  });
  onTestFinished(() => host.dispose());
  return {
    label: "determinism stand-in",
    command: process.execPath,
    prefixArgs: [host.path("standin.mjs")],
  };
}

async function makePlainWorkspace(): Promise<TestWorkspace> {
  const workspace = await TestWorkspace.create({
    files: {
      "obsolete.txt": "to be removed\n",
      "specs/keep.mdx": "# kept\r\n",
    },
  });
  onTestFinished(() => workspace.dispose());
  return workspace;
}

async function makeGitWorkspace(): Promise<TestWorkspace> {
  const workspace = await makePlainWorkspace();
  await workspace.gitInit();
  await workspace.gitCommitAll("seed");
  return workspace;
}

test("assertRunTwiceDeterministic passes for a deterministic command and returns both results (H-6)", async () => {
  const binding = await determinismStandin();
  const workspace = await makePlainWorkspace();
  const { first, second } = await assertRunTwiceDeterministic({
    binding,
    run: { cwd: workspace.root, argv: ["emit"] },
  });
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(first.stdout).toBe("built 2 files\n");
  await assertFileBytes(
    workspace.path("out/derived.txt"),
    "derived\r\nsecond line\n",
  );
  await assertFileBytes(workspace.path("out/raw.bin"), bytes(0x00, 0xff, 0x0d));
});

test("assertRunTwiceDeterministic fails diagnosed on run-to-run drift in stdout, written files, or exit outcome", async () => {
  const binding = await determinismStandin();
  const forOutput = await makePlainWorkspace();
  await expectDiagnosedAsync(
    () =>
      assertRunTwiceDeterministic({
        binding,
        run: { cwd: forOutput.root, argv: ["flaky-output"] },
        context: "flaky stdout",
      }),
    "flaky stdout",
    /stdout of run 2 vs run 1/,
  );
  const forFile = await makePlainWorkspace();
  await expectDiagnosedAsync(
    () =>
      assertRunTwiceDeterministic({
        binding,
        run: { cwd: forFile.root, argv: ["flaky-file"] },
        context: "flaky file",
      }),
    "flaky file",
    "counter.txt",
    /after run 2 vs after run 1/,
  );
  const forExit = await makePlainWorkspace();
  await expectDiagnosedAsync(
    () =>
      assertRunTwiceDeterministic({
        binding,
        run: { cwd: forExit.root, argv: ["flaky-exit"] },
        context: "flaky exit",
      }),
    "flaky exit",
    /exit outcome differs/,
  );
});

test("assertAcrossDirectoriesDeterministic passes for a path-independent command over identically scripted git fixtures (H-6)", async () => {
  const binding = await determinismStandin();
  const { first, second, firstWorkspace, secondWorkspace } =
    await assertAcrossDirectoriesDeterministic({
      makeWorkspace: makeGitWorkspace,
      binding,
      makeRun: (workspace) => ({ cwd: workspace.root, argv: ["emit"] }),
    });
  expect(firstWorkspace.root).not.toBe(secondWorkspace.root);
  expect(first.exitCode).toBe(0);
  expect(second.stdout).toBe("built 2 files\n");
  await assertFilesEqual(
    firstWorkspace.path("out/derived.txt"),
    secondWorkspace.path("out/derived.txt"),
  );
});

test("assertAcrossDirectoriesDeterministic fails diagnosed when outputs, written bytes, or the written file set depend on the directory", async () => {
  const binding = await determinismStandin();
  await expectDiagnosedAsync(
    () =>
      assertAcrossDirectoriesDeterministic({
        makeWorkspace: makePlainWorkspace,
        binding,
        makeRun: (workspace) => ({
          cwd: workspace.root,
          argv: ["leak-cwd-stdout"],
        }),
        context: "leaky stdout",
      }),
    "leaky stdout",
    /stdout of the run in directory 2/,
  );
  await expectDiagnosedAsync(
    () =>
      assertAcrossDirectoriesDeterministic({
        makeWorkspace: makePlainWorkspace,
        binding,
        makeRun: (workspace) => ({
          cwd: workspace.root,
          argv: ["leak-cwd-file"],
        }),
        context: "leaky file",
      }),
    "leaky file",
    "out/where.txt",
    /written state differs/,
  );
  const setFailure = await expectDiagnosedAsync(
    () =>
      assertAcrossDirectoriesDeterministic({
        makeWorkspace: makePlainWorkspace,
        binding,
        makeRun: (workspace) => ({ cwd: workspace.root, argv: ["leak-name"] }),
        context: "leaky file set",
      }),
    "leaky file set",
    /untouched in directory 2/,
  );
  expect(setFailure.message).toMatch(/untouched in directory 1/);
});

test("assertAcrossDirectoriesDeterministic rejects a drifting workspace factory as a harness error, not an assertion failure", async () => {
  const binding = await determinismStandin();
  let counter = 0;
  const driftingFactory = async (): Promise<TestWorkspace> => {
    const workspace = await TestWorkspace.create({
      files: { "seed.txt": `seed ${String(counter++)}\n` },
    });
    onTestFinished(() => workspace.dispose());
    return workspace;
  };
  const error = await assertAcrossDirectoriesDeterministic({
    makeWorkspace: driftingFactory,
    binding,
    makeRun: (workspace) => ({ cwd: workspace.root, argv: ["emit"] }),
  }).then(
    () => null,
    (thrown: unknown) => thrown as Error,
  );
  expect(error).not.toBeNull();
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(HarnessAssertionError);
  expect(error?.message).toMatch(/identical workspace/);
  expect(error?.message).toContain("seed.txt");
});
