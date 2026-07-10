// S-3 Subprocess driver self-test (TEST-SPEC 17). The blackbox driver is the
// only channel through which any test reaches a product (H-2, C-2), so its
// mechanics are pinned against a known-behavior stand-in command before any
// product-facing test or certification trusts them: exact exit codes,
// byte-verbatim stdout/stderr separation (H-5), enforced per-test working
// directories, controlled environment, argv fidelity without shell
// interpretation, timeout-as-failure for hangs (reported as failures, never
// skips — H-8), diagnosed failures for missing executables, and the 13.5
// machinery: background start, hold-file choreography, kill, concurrency.
//
// The stand-in is a tiny argv-driven Node script written into a fresh
// TestWorkspace per test (the builder itself is certified by S-2) and driven
// through the same ProductBinding shape product-facing tests use. Platform
// gates mirror TEST-SPEC's staging notes, not CI skips: the `self` project
// runs on Linux in CI (harness-self job), where every test here executes;
// the kill-signal shape is asserted on POSIX, where the 13.5 suite tests
// that rely on it run (the E-6 Windows subset contains no 13.5 test).

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  builtProductBinding,
  createHoldFile,
  pathExists,
  releaseHoldFile,
  runProduct,
  startProduct,
} from "../helpers/subprocess.js";
import type { ProductBinding } from "../helpers/subprocess.js";
import { TestWorkspace } from "../helpers/workspace.js";

const onPosix = process.platform !== "win32";

const hex = (data: Uint8Array): string => Buffer.from(data).toString("hex");

// Known-behavior stand-in: every mode's observable behavior is fixed by this
// source, so assertions about the driver have an unambiguous ground truth.
const STANDIN_SOURCE = `import fs from "node:fs";

const [mode, ...args] = process.argv.slice(2);
switch (mode) {
  case "exit": {
    process.exit(Number(args[0]));
    break;
  }
  case "interleave": {
    for (let i = 0; i < 40; i += 1) {
      process.stdout.write("out" + i + ";");
      process.stderr.write("err" + i + ";");
    }
    process.exit(9);
    break;
  }
  case "bytes": {
    process.stdout.write(Buffer.from([0x6f, 0x75, 0x74, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x0d]));
    process.stderr.write(Buffer.from([0x65, 0x72, 0x72, 0x80, 0xc3, 0x28, 0x0a]));
    process.exit(0);
    break;
  }
  case "cwd": {
    process.stdout.write(process.cwd());
    process.exit(0);
    break;
  }
  case "argv": {
    process.stdout.write(JSON.stringify(args));
    process.exit(0);
    break;
  }
  case "env": {
    for (const name of args) {
      const value = name in process.env ? process.env[name] : "<absent>";
      process.stdout.write(name + "=" + value + "\\n");
    }
    process.exit(0);
    break;
  }
  case "hang": {
    setInterval(() => {}, 60000);
    break;
  }
  case "hold": {
    fs.writeFileSync(args[0], "");
    const poll = setInterval(() => {
      if (!fs.existsSync(args[0])) {
        clearInterval(poll);
        process.stdout.write("released");
        process.exit(0);
      }
    }, 10);
    break;
  }
  case "spam": {
    const chunk = "x".repeat(1024);
    for (let i = 0; i < 1024; i += 1) process.stdout.write(chunk);
    setInterval(() => {}, 60000);
    break;
  }
  default: {
    process.stderr.write("unknown mode: " + String(mode));
    process.exit(99);
  }
}
`;

interface Standin {
  readonly workspace: TestWorkspace;
  readonly binding: ProductBinding;
}

async function standin(): Promise<Standin> {
  const workspace = await TestWorkspace.create({
    files: { "standin.mjs": STANDIN_SOURCE },
  });
  onTestFinished(() => workspace.dispose());
  return {
    workspace,
    binding: {
      label: "S-3 stand-in",
      command: process.execPath,
      prefixArgs: [workspace.path("standin.mjs")],
    },
  };
}

test("captures exact exit codes (0, 3, 86), concurrently invoked", async () => {
  const { workspace, binding } = await standin();
  const results = await Promise.all(
    [0, 3, 86].map((code) =>
      runProduct(binding, {
        cwd: workspace.root,
        argv: ["exit", String(code)],
      }),
    ),
  );
  expect(results.map((result) => result.exitCode)).toEqual([0, 3, 86]);
  for (const result of results) {
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }
});

test("keeps stdout and stderr separated across interleaved writes (H-5)", async () => {
  const { workspace, binding } = await standin();
  const result = await runProduct(binding, {
    cwd: workspace.root,
    argv: ["interleave"],
  });
  expect(result.exitCode).toBe(9);
  const indexes = Array.from({ length: 40 }, (_, i) => i);
  expect(result.stdout).toBe(indexes.map((i) => `out${i};`).join(""));
  expect(result.stderr).toBe(indexes.map((i) => `err${i};`).join(""));
});

test("captures output streams byte-verbatim (NUL, invalid UTF-8, CR/CRLF included)", async () => {
  const { workspace, binding } = await standin();
  const result = await runProduct(binding, {
    cwd: workspace.root,
    argv: ["bytes"],
  });
  expect(result.exitCode).toBe(0);
  expect(hex(result.stdoutBytes)).toBe(
    hex(
      Uint8Array.from([0x6f, 0x75, 0x74, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x0d]),
    ),
  );
  expect(hex(result.stderrBytes)).toBe(
    hex(Uint8Array.from([0x65, 0x72, 0x72, 0x80, 0xc3, 0x28, 0x0a])),
  );
});

test("runs the child in exactly the given per-test working directory", async () => {
  const { workspace, binding } = await standin();
  await workspace.dir("cwd-a");
  await workspace.dir("cwd-b");
  const observed: string[] = [];
  for (const rel of ["cwd-a", "cwd-b"]) {
    const dir = workspace.path(rel);
    const result = await runProduct(binding, { cwd: dir, argv: ["cwd"] });
    expect(result.exitCode).toBe(0);
    // realpath both sides: the comparison must not depend on symlinks in the
    // OS temp directory location.
    observed.push(await fsp.realpath(result.stdout));
    expect(observed.at(-1)).toBe(await fsp.realpath(dir));
  }
  expect(observed[0]).not.toBe(observed[1]);
});

test("refuses relative, missing, and non-directory working directories, diagnosed", async () => {
  const { workspace, binding } = await standin();
  await workspace.file("plain.txt", "not a directory\n");
  await expect(
    runProduct(binding, { cwd: "relative/dir", argv: ["exit", "0"] }),
  ).rejects.toThrow(/absolute/);
  await expect(
    runProduct(binding, {
      cwd: path.join(workspace.tempRoot, "missing-dir"),
      argv: ["exit", "0"],
    }),
  ).rejects.toThrow(/working directory does not exist/);
  await expect(
    runProduct(binding, {
      cwd: workspace.path("plain.txt"),
      argv: ["exit", "0"],
    }),
  ).rejects.toThrow(/not a directory/);
});

test("controls the child environment: ambient GIT_*/EMAIL/NODE_OPTIONS/FORCE_COLOR never leak; git isolation pinned; binding and invocation env merge in order", async () => {
  const ambient: Record<string, string> = {
    XSPEC_S3_AMBIENT: "yes",
    GIT_AUTHOR_NAME: "Ambient Leak",
    EMAIL: "ambient@example.invalid",
    NODE_OPTIONS: "--max-http-header-size=32768",
    FORCE_COLOR: "3",
  };
  const saved = new Map<string, string | undefined>(
    Object.keys(ambient).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, ambient);
    const { workspace, binding } = await standin();

    const base = await runProduct(binding, {
      cwd: workspace.root,
      argv: [
        "env",
        "XSPEC_S3_AMBIENT",
        "GIT_AUTHOR_NAME",
        "EMAIL",
        "NODE_OPTIONS",
        "FORCE_COLOR",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "GIT_CONFIG_GLOBAL",
      ],
    });
    expect(base.exitCode).toBe(0);
    expect(base.stdout).toBe(
      [
        "XSPEC_S3_AMBIENT=yes",
        "GIT_AUTHOR_NAME=<absent>",
        "EMAIL=<absent>",
        "NODE_OPTIONS=<absent>",
        "FORCE_COLOR=<absent>",
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_TERMINAL_PROMPT=0",
        `GIT_CONFIG_GLOBAL=${os.devNull}`,
        "",
      ].join("\n"),
    );

    const withBindingEnv: ProductBinding = {
      ...binding,
      env: {
        XSPEC_S3_BINDING: "from-binding",
        XSPEC_S3_OVERRIDE: "binding-level",
      },
    };
    const merged = await runProduct(withBindingEnv, {
      cwd: workspace.root,
      argv: [
        "env",
        "XSPEC_S3_BINDING",
        "XSPEC_S3_OVERRIDE",
        "XSPEC_S3_AMBIENT",
      ],
      env: {
        XSPEC_S3_OVERRIDE: "invocation-level",
        XSPEC_S3_AMBIENT: undefined,
      },
    });
    expect(merged.exitCode).toBe(0);
    expect(merged.stdout).toBe(
      [
        "XSPEC_S3_BINDING=from-binding",
        "XSPEC_S3_OVERRIDE=invocation-level",
        "XSPEC_S3_AMBIENT=<absent>",
        "",
      ].join("\n"),
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("argv reaches the child verbatim — no shell interpretation, empty and metacharacter arguments intact", async () => {
  const { workspace, binding } = await standin();
  const payload = [
    "--test-hold",
    "a b",
    "",
    "*.mdx",
    "$HOME",
    "--",
    "-x",
    "héé",
    '"quoted"',
  ];
  const result = await runProduct(binding, {
    cwd: workspace.root,
    argv: ["argv", ...payload],
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(payload);
});

test("converts a hanging child into a diagnosed timeout failure and kills it (H-8: never a skip, never a harness hang)", async () => {
  const { workspace, binding } = await standin();
  const running = await startProduct(binding, {
    cwd: workspace.root,
    argv: ["hang"],
    timeoutMs: 250,
  });
  await expect(running.waitForExit()).rejects.toThrow(/timed out after 250 ms/);
  // The rejection settles only after the child is dead and its streams are
  // closed — nothing lingers past the failure.
  expect(running.hasExited()).toBe(true);
  await expect(
    runProduct(binding, {
      cwd: workspace.root,
      argv: ["hang"],
      timeoutMs: 250,
    }),
  ).rejects.toThrow(/timed out/);
});

test("a missing executable or required build artifact fails diagnosed, not as a harness crash (H-8)", async () => {
  const { workspace } = await standin();
  const missingCommand = path.join(workspace.tempRoot, "no-such-binary");
  const spawnError = await runProduct(
    { label: "missing executable", command: missingCommand },
    { cwd: workspace.root },
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );
  expect(spawnError).not.toBeNull();
  expect(spawnError!.message).toContain("failed to start");
  expect(spawnError!.message).toContain(missingCommand);

  const missingArtifact = path.join(workspace.tempRoot, "not-built.js");
  const artifactError = await runProduct(
    {
      label: "unbuilt product",
      command: process.execPath,
      prefixArgs: [missingArtifact],
      requiredFiles: [missingArtifact],
    },
    { cwd: workspace.root },
  ).then(
    () => null,
    (error: unknown) => error as Error,
  );
  expect(artifactError).not.toBeNull();
  expect(artifactError!.message).toContain("required file missing");
  expect(artifactError!.message).toContain(missingArtifact);
  expect(artifactError!.message).toContain("npm run build");
});

test("builtProductBinding names the built executable absolutely, independent of the process cwd (C-2 default binding)", () => {
  const binding = builtProductBinding();
  expect(binding.command).toBe(process.execPath);
  expect(binding.prefixArgs).toHaveLength(1);
  const binJs = binding.prefixArgs![0]!;
  expect(path.isAbsolute(binJs)).toBe(true);
  expect(binJs.endsWith(path.join("dist", "cli", "bin.js"))).toBe(true);
  // The pre-flight check targets exactly the executable artifact, so an
  // unbuilt product fails diagnosed (H-8) rather than as a confusing spawn.
  expect(binding.requiredFiles).toEqual([binJs]);
});

test("background start with hold-file choreography: await creation, hold, release, completion (13.5 seam support)", async () => {
  const { workspace, binding } = await standin();
  const holdPath = path.join(workspace.tempRoot, "hold");
  const running = await startProduct(binding, {
    cwd: workspace.root,
    argv: ["hold", holdPath],
  });
  await running.waitForFile(holdPath);
  expect(await pathExists(holdPath)).toBe(true);
  // Held: the child is alive and has not proceeded past the hold.
  expect(running.hasExited()).toBe(false);
  await releaseHoldFile(holdPath);
  const result = await running.waitForExit();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("released");
  expect(await pathExists(holdPath)).toBe(false);
});

test("createHoldFile stages an empty file, refuses an occupied path; releaseHoldFile is idempotent", async () => {
  const { workspace } = await standin();
  const holdPath = path.join(workspace.tempRoot, "staged-hold");
  await createHoldFile(holdPath);
  expect(await pathExists(holdPath)).toBe(true);
  expect((await fsp.readFile(holdPath)).length).toBe(0);
  await expect(createHoldFile(holdPath)).rejects.toThrow(/EEXIST/);
  await releaseHoldFile(holdPath);
  expect(await pathExists(holdPath)).toBe(false);
  await releaseHoldFile(holdPath);
});

test.runIf(onPosix)(
  "kill() terminates a held child; waitForExit reports the signal death (T13.5-3 support)",
  async () => {
    const { workspace, binding } = await standin();
    const holdPath = path.join(workspace.tempRoot, "hold-to-kill");
    const running = await startProduct(binding, {
      cwd: workspace.root,
      argv: ["hold", holdPath],
    });
    await running.waitForFile(holdPath);
    running.kill();
    const result = await running.waitForExit();
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    // The child never proceeded past the hold, and the abandoned hold file
    // stays on disk: a terminated holder leaves only inert state behind.
    expect(result.stdout).toBe("");
    expect(await pathExists(holdPath)).toBe(true);
  },
);

test("waitForFile fails diagnosed when the child exits without creating the file (red-green path for stub products, H-8)", async () => {
  const { workspace, binding } = await standin();
  const running = await startProduct(binding, {
    cwd: workspace.root,
    argv: ["exit", "86"],
  });
  const neverCreated = path.join(workspace.tempRoot, "never-created");
  const error = await running.waitForFile(neverCreated).then(
    () => null,
    (thrown: unknown) => thrown as Error,
  );
  expect(error).not.toBeNull();
  expect(error!.message).toContain("exited before creating");
  expect(error!.message).toContain(neverCreated);
  expect(error!.message).toContain("exit code 86");
  // The run outcome itself stays available for further diagnosis.
  expect((await running.waitForExit()).exitCode).toBe(86);
});

test("waitForFile times out diagnosed against a live child that never creates the file", async () => {
  const { workspace, binding } = await standin();
  const running = await startProduct(binding, {
    cwd: workspace.root,
    argv: ["hang"],
  });
  await expect(
    running.waitForFile(path.join(workspace.tempRoot, "never"), {
      timeoutMs: 200,
    }),
  ).rejects.toThrow(/timed out after 200 ms waiting for/);
  running.kill();
  await running.waitForExit();
});

test("concurrent invocations stay isolated: each returns its own argv, output, and exit code (13.5 support)", async () => {
  const { workspace, binding } = await standin();
  const argvRuns = Promise.all(
    [0, 1, 2].map((i) =>
      runProduct(binding, {
        cwd: workspace.root,
        argv: ["argv", `payload-${i}`],
      }),
    ),
  );
  const exitRuns = Promise.all(
    [11, 12, 13].map((code) =>
      runProduct(binding, {
        cwd: workspace.root,
        argv: ["exit", String(code)],
      }),
    ),
  );
  const [argvResults, exitResults] = await Promise.all([argvRuns, exitRuns]);
  argvResults.forEach((result, i) => {
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([`payload-${i}`]);
    expect(result.stderr).toBe("");
  });
  expect(exitResults.map((result) => result.exitCode)).toEqual([11, 12, 13]);
});

test("a child exceeding the output cap is killed with a diagnosed failure (H-8: runaway output never hangs the harness)", async () => {
  const { workspace, binding } = await standin();
  await expect(
    runProduct(binding, {
      cwd: workspace.root,
      argv: ["spam"],
      maxOutputBytes: 2048,
    }),
  ).rejects.toThrow(/exceeded the output limit of 2048 bytes/);
});
