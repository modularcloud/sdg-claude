// Blackbox subprocess driver for the xspec test harness (TEST-SPEC H-2, H-5,
// H-8, S-3; IMPLEMENTATION.md: CLI invocation is always as an executable run
// in a subprocess). Harness machinery only: this module never imports product
// code — a product is driven strictly as an executable.
//
// - A `ProductBinding` names the executable to drive. Product-facing tests
//   default to the built product (`builtProductBinding()`); the certification
//   runner substitutes a CERTIFICATIONS.md fixture executable through the
//   same binding shape, so certifying and testing use one code path (C-2) and
//   no test hard-codes the product path.
// - Every invocation controls the working directory (required and absolute:
//   each test runs the product inside its own workspace, H-1/H-2), argv
//   (passed verbatim to the process, no shell interpretation; raw-byte
//   elements for non-UTF-8 arguments ride a POSIX trampoline — see
//   `ArgvValue` and `resolveInvocation`), and the environment; it observes
//   the exact exit code and stdout/stderr as separated byte streams (H-5).
//   stdin is closed — SPEC.md commands are argv-driven.
// - Robustness (H-8): a hanging child is killed and converted into a
//   diagnosed timeout failure (never a skip, never a harness hang); a missing
//   executable or working directory is a diagnosed per-test failure, not a
//   harness crash; runaway output is capped, killed, and diagnosed.
// - 13.5 support: background start (`startProduct`), hold-file choreography
//   (`createHoldFile` / `RunningProduct.waitForFile` / `releaseHoldFile`),
//   process kill, and concurrent invocations (every run is independent).
// - Environment policy (conservative choice): the child inherits the ambient
//   environment minus variables that would let the machine leak into
//   fixture-observable behavior — `GIT_*` and `EMAIL` (the product shells out
//   to the system git for baseline reads; ambient git control variables would
//   redirect or reconfigure those reads) and `NODE_OPTIONS` / `NODE_DEBUG` /
//   `NODE_V8_COVERAGE` / `FORCE_COLOR` / `CLICOLOR_FORCE` (they inject flags,
//   stderr noise, coverage writes, or colored bytes into the child). Git
//   config isolation is pinned (`GIT_CONFIG_NOSYSTEM=1`,
//   `GIT_CONFIG_GLOBAL=<devnull>`, `GIT_TERMINAL_PROMPT=0`) so machine-local
//   git configuration never alters product behavior and git can never prompt
//   (a prompt would be a hang). All of it is overridable: the binding's env
//   merges over the sanitized base, the invocation's env merges last
//   (`undefined` removes a variable) — tests that vary the environment
//   deliberately (T12.0-7) set it explicitly.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** Hang guard applied to every invocation unless overridden (H-8). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Runaway-output guard: combined stdout+stderr cap per invocation. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Default bound on hold-file waits (H-8: waits always terminate). */
export const DEFAULT_WAIT_FOR_FILE_TIMEOUT_MS = 10_000;

/**
 * How to invoke a product — the built `xspec` or a CERTIFICATIONS.md fixture
 * product. The binding is the only product-specific datum a test body sees
 * (C-2: an executable binding and nothing else).
 */
export interface ProductBinding {
  /** Human label used in failure diagnoses. */
  readonly label: string;
  /** Executable to spawn: an absolute path, or a name resolved via PATH. */
  readonly command: string;
  /**
   * Arguments prepended before each invocation's argv — e.g. the script path
   * when `command` is the Node binary.
   */
  readonly prefixArgs?: readonly string[];
  /** Environment pinned for every invocation of this binding. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Files that must exist for the binding to be invocable, checked before
   * each run: a missing build artifact fails the test with a diagnosis
   * instead of a confusing spawn error (H-8).
   */
  readonly requiredFiles?: readonly string[];
}

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * The default binding: the built product executable (`dist/cli/bin.js`, see
 * AGENTS.md), resolved relative to this module — never to the process cwd.
 */
export function builtProductBinding(): ProductBinding {
  const binJs = path.join(repoRoot, "dist", "cli", "bin.js");
  return {
    label: "built xspec product",
    command: process.execPath,
    prefixArgs: [binJs],
    requiredFiles: [binJs],
  };
}

/**
 * One argv element. Strings are passed to the child as their UTF-8 bytes; a
 * `Uint8Array` declares the element as raw bytes — Linux-leg staging for
 * arguments that are not valid UTF-8 (SPEC.md 6.5 destination paths, 12.0
 * non-UTF-8 argv; TEST-SPEC T6.5-4, T12.0-5). Byte elements are POSIX-only
 * and must not contain NUL (argv strings cannot); see `resolveInvocation`.
 */
export type ArgvValue = string | Uint8Array;

export interface RunOptions {
  /** Per-test working directory — required and absolute (H-1, H-2). */
  readonly cwd: string;
  /** Arguments after the binding's prefix, passed verbatim (no shell). */
  readonly argv?: readonly ArgvValue[];
  /**
   * Merged last, over the sanitized base and the binding's env; a value of
   * `undefined` removes the variable from the child's environment.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Hang guard: the child is killed and the run fails diagnosed (H-8). */
  readonly timeoutMs?: number;
  /** Runaway-output guard (combined stdout+stderr bytes). */
  readonly maxOutputBytes?: number;
}

export interface RunResult {
  /** Exit code, or null when the process died by signal. */
  readonly exitCode: number | null;
  /** Terminating signal, or null on normal exit. */
  readonly signal: NodeJS.Signals | null;
  /** stdout decoded as UTF-8 (assert bytes via `stdoutBytes` where exactness matters). */
  readonly stdout: string;
  /** stderr decoded as UTF-8. */
  readonly stderr: string;
  /** stdout exactly as emitted (H-4/H-5 byte assertions, determinism compares). */
  readonly stdoutBytes: Uint8Array;
  /** stderr exactly as emitted. */
  readonly stderrBytes: Uint8Array;
  /** Diagnostic description of the invocation (command, argv, cwd). */
  readonly commandLine: string;
}

/**
 * Start an invocation in the background (13.5 choreography: the caller
 * coordinates via hold files, kills, or concurrent invocations, then awaits
 * `waitForExit`). Pre-flight problems — relative/missing working directory,
 * missing required files — throw diagnosed errors before anything is spawned.
 */
export async function startProduct(
  binding: ProductBinding,
  options: RunOptions,
): Promise<RunningProduct> {
  const fullArgs: readonly ArgvValue[] = [
    ...(binding.prefixArgs ?? []),
    ...(options.argv ?? []),
  ];
  const commandLine = describeCommand(binding, fullArgs, options.cwd);

  if (!path.isAbsolute(options.cwd)) {
    throw new Error(
      `per-test working directory must be an absolute path (H-1/H-2), got ${JSON.stringify(options.cwd)} for ${commandLine}`,
    );
  }
  const cwdStats = await fsp.stat(options.cwd).catch(() => undefined);
  if (!cwdStats) {
    throw new Error(
      `working directory does not exist: ${options.cwd} — every invocation runs inside a test-owned workspace (H-1); command: ${commandLine}`,
    );
  }
  if (!cwdStats.isDirectory()) {
    throw new Error(
      `working directory is not a directory: ${options.cwd}; command: ${commandLine}`,
    );
  }
  for (const required of binding.requiredFiles ?? []) {
    if (!(await pathExists(required))) {
      throw new Error(
        `${binding.label}: required file missing: ${required}. The harness drives the product strictly as a subprocess (TEST-SPEC H-2); if this is the built product, run \`npm run build\` first (AGENTS.md). H-8: a missing executable is a diagnosed per-test failure — the harness itself keeps running.`,
      );
    }
  }

  const invocation = resolveInvocation(binding.command, fullArgs, commandLine);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: childEnvironment(binding, options),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return new RunningProduct(
    child,
    commandLine,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  );
}

/** Run an invocation to completion — the common foreground path. */
export async function runProduct(
  binding: ProductBinding,
  options: RunOptions,
): Promise<RunResult> {
  const running = await startProduct(binding, options);
  return await running.waitForExit();
}

/**
 * A started invocation. `waitForExit` resolves with the run result (normal
 * exits and requested kills alike) and rejects, diagnosed, on timeout, output
 * overflow, or spawn failure.
 */
export class RunningProduct {
  readonly commandLine: string;

  readonly #child: ChildProcess;
  readonly #exit: Promise<RunResult>;
  #settled = false;

  /** @internal — obtain instances via `startProduct`. */
  constructor(
    child: ChildProcess,
    commandLine: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ) {
    this.#child = child;
    this.commandLine = commandLine;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let overflowed = false;
    let timedOut = false;

    const capture = (sink: Buffer[]) => (chunk: Buffer) => {
      sink.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxOutputBytes && !overflowed) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", capture(stdoutChunks));
    child.stderr?.on("data", capture(stderrChunks));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    this.#exit = new Promise<RunResult>((resolve, reject) => {
      let done = false;
      const settle = (complete: () => void): void => {
        if (done) return;
        done = true;
        this.#settled = true;
        clearTimeout(timer);
        complete();
      };
      child.once("error", (error) => {
        settle(() =>
          reject(
            new Error(
              `failed to start ${commandLine}: ${error.message} — is the executable present and invocable? H-8: a missing executable is a diagnosed per-test failure, not a harness crash.`,
            ),
          ),
        );
      });
      child.once("close", (exitCode, signal) => {
        settle(() => {
          if (timedOut) {
            reject(
              new Error(
                `${commandLine} timed out after ${timeoutMs} ms and was killed (H-8: hangs are failures, never skips). Partial stdout: ${excerpt(Buffer.concat(stdoutChunks))}; partial stderr: ${excerpt(Buffer.concat(stderrChunks))}`,
              ),
            );
            return;
          }
          if (overflowed) {
            reject(
              new Error(
                `${commandLine} exceeded the output limit of ${maxOutputBytes} bytes and was killed (H-8: runaway output is a failure, not a harness hang).`,
              ),
            );
            return;
          }
          const stdoutBytes = Buffer.concat(stdoutChunks);
          const stderrBytes = Buffer.concat(stderrChunks);
          resolve({
            exitCode,
            signal,
            stdout: stdoutBytes.toString("utf8"),
            stderr: stderrBytes.toString("utf8"),
            stdoutBytes,
            stderrBytes,
            commandLine,
          });
        });
      });
    });
    // Mark rejections as observed even when a test aborts before awaiting;
    // awaiters of waitForExit() still receive the original rejection.
    this.#exit.catch(() => {});
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** True once the process has exited (or failed to spawn). */
  hasExited(): boolean {
    return this.#settled;
  }

  /** Terminate the process (T13.5-3/7 kill choreography). Idempotent. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.#child.kill(signal);
  }

  /**
   * The run's outcome. Resolves for normal exits and requested kills; rejects
   * with a diagnosed error on timeout, output overflow, or spawn failure.
   * Callable any number of times.
   */
  async waitForExit(): Promise<RunResult> {
    return await this.#exit;
  }

  /**
   * Poll until a file appears at `absPath` — the hold-file handshake of
   * SPEC.md 13.5 (`--test-hold`). Fails diagnosed, never hangs (H-8): rejects
   * when the process exits first without creating it (the red-green path for
   * stub products, carrying the run outcome), and on timeout while the
   * process is still running.
   */
  async waitForFile(
    absPath: string,
    options: {
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
    } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_FILE_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? 10;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await pathExists(absPath)) return;
      if (this.hasExited()) {
        const outcome = await this.#exit.then(
          summarizeResult,
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        );
        throw new Error(
          `${this.commandLine} exited before creating ${absPath} — ${outcome}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs} ms waiting for ${absPath} to appear; child still running: ${this.commandLine}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
}

/**
 * Stage an empty hold file (e.g. T13.5-1's occupied-path arm). Refuses an
 * occupied path loudly — staging over an existing entry is a test bug.
 */
export async function createHoldFile(absPath: string): Promise<void> {
  await fsp.writeFile(absPath, "", { flag: "wx" });
}

/** Release a hold: delete the file at the path. Idempotent. */
export async function releaseHoldFile(absPath: string): Promise<void> {
  await fsp.rm(absPath, { force: true });
}

/** Whether anything (file, directory, or symlink) occupies the path. */
export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fsp.lstat(absPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One-line outcome description for failure diagnoses. */
export function summarizeResult(result: RunResult): string {
  const death =
    result.signal !== null
      ? `killed by signal ${result.signal}`
      : `exit code ${String(result.exitCode)}`;
  return `${death}; stdout: ${excerpt(Buffer.from(result.stdoutBytes))}; stderr: ${excerpt(Buffer.from(result.stderrBytes))}`;
}

const EXCERPT_LIMIT = 2048;

function excerpt(bytes: Buffer): string {
  if (bytes.length === 0) return "<empty>";
  const text = bytes.toString("utf8", 0, Math.min(bytes.length, EXCERPT_LIMIT));
  return bytes.length > EXCERPT_LIMIT
    ? `${text}… (${bytes.length} bytes total)`
    : text;
}

function describeCommand(
  binding: ProductBinding,
  fullArgs: readonly ArgvValue[],
  cwd: string,
): string {
  const rendered = [binding.command, ...fullArgs].map(formatArg).join(" ");
  return `\`${rendered}\` [${binding.label}] (cwd: ${cwd})`;
}

function formatArg(arg: ArgvValue): string {
  if (typeof arg !== "string") {
    return `<argv bytes 0x${Buffer.from(arg).toString("hex")}>`;
  }
  return arg === "" || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

/**
 * Resolve the actual spawn target for an invocation. An all-string argv
 * spawns the command directly, exactly as before. An argv containing raw
 * bytes (`ArgvValue` as `Uint8Array`) cannot pass through Node's string-only
 * spawn API — any JS string encodes to *valid* UTF-8 — so it is routed
 * through a POSIX `sh` trampoline: every string element travels untouched as
 * a positional parameter (never interpreted), each byte element is
 * reconstructed inside the shell with `printf` octal escapes (an appended
 * sentinel protects trailing newlines from command-substitution stripping),
 * and the target command is `exec`ed with the elements in their original
 * order. The child therefore receives exactly the declared argv bytes, with
 * no shell interpretation of any value (H-2). POSIX-only staging (TEST-SPEC
 * T6.5-4, T12.0-5 gate themselves to the Linux leg); requesting byte argv on
 * Windows, or with a NUL byte (argv strings cannot contain NUL), is a
 * harness-usage error thrown as a plain `Error`.
 */
function resolveInvocation(
  command: string,
  fullArgs: readonly ArgvValue[],
  commandLine: string,
): { command: string; args: string[] } {
  if (fullArgs.every((arg): arg is string => typeof arg === "string")) {
    return { command, args: [...fullArgs] };
  }
  if (process.platform === "win32") {
    throw new Error(
      `byte (Uint8Array) argv elements are POSIX-only staging — Windows has no byte-argv channel; gate the arm to the Linux leg (TEST-SPEC T6.5-4, T12.0-5); command: ${commandLine}`,
    );
  }
  const assignments: string[] = [];
  const positionals: string[] = [command];
  const execRefs: string[] = ['"${1}"'];
  let byteIndex = 0;
  for (const arg of fullArgs) {
    if (typeof arg === "string") {
      positionals.push(arg);
      execRefs.push(`"\${${String(positionals.length)}}"`);
    } else {
      if (arg.includes(0)) {
        throw new Error(
          `byte argv element contains a NUL byte, which no argv string can carry (execve); command: ${commandLine}`,
        );
      }
      const name = `xspec_arg_${String(byteIndex)}`;
      byteIndex += 1;
      assignments.push(
        `${name}=$(printf '${octalEscape(arg)}x')`,
        `${name}=\${${name}%x}`,
      );
      execRefs.push(`"\${${name}}"`);
    }
  }
  const script = [...assignments, `exec ${execRefs.join(" ")}`].join("\n");
  return { command: "/bin/sh", args: ["-c", script, "sh", ...positionals] };
}

/** Every byte as a 3-digit octal `printf` escape (all-ASCII, quote-safe). */
function octalEscape(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return out;
}

/** Ambient variables never passed through implicitly (see module header). */
function isDroppedAmbient(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith("GIT_")) return true;
  return (
    upper === "EMAIL" ||
    upper === "NODE_OPTIONS" ||
    upper === "NODE_DEBUG" ||
    upper === "NODE_V8_COVERAGE" ||
    upper === "FORCE_COLOR" ||
    upper === "CLICOLOR_FORCE"
  );
}

function childEnvironment(
  binding: ProductBinding,
  options: RunOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isDroppedAmbient(name)) continue;
    env[name] = value;
  }
  // Pinned git isolation for the product's own git reads (IMPLEMENTATION.md:
  // system git via read-only plumbing): machine-local configuration must not
  // alter fixture-observable behavior, and git must never prompt.
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = os.devNull;
  env["GIT_TERMINAL_PROMPT"] = "0";
  Object.assign(env, binding.env ?? {});
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}
