// Read-only git invocation (SPEC 6.3; IMPLEMENTATION Key libraries: git
// baseline reads use the system `git` executable via read-only plumbing
// subcommands — no git library, no git write operations).
//
// The product's only git consumer is baseline reconstruction
// (./baseline.ts), and the only subcommands ever run are the plumbing
// readers `rev-parse`, `ls-tree`, and `cat-file`: nothing here writes to
// the repository, takes locks, or touches the index — the product treats
// git as a read-only content store.
//
// Diagnostics never render git's own stderr: its wording varies by git
// version and can carry absolute paths, both of which SPEC 12.0's
// byte-determinism rules exclude from output. Callers compose their own
// actionable messages from the failure kind.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import * as os from "node:os";

/**
 * The environment for a spawned git, normalized for the platform: on
 * Windows, a `GIT_CONFIG_GLOBAL` naming the null device by Node's spelling
 * (`os.devNull` = `\\.\nul`) is translated to `nul` — git accepts the
 * classic device name (and `/dev/null`) where a configuration file path is
 * expected, but its config access dies on the `\\.\nul` spelling, which
 * would fail every git invocation with an unrelated fatal error. The
 * intent of such a value — read no global configuration — is preserved
 * exactly; nothing else is changed (SPEC 6.3: git is a read-only content
 * store, and the caller's environment otherwise applies as is).
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  if (
    process.platform === "win32" &&
    process.env["GIT_CONFIG_GLOBAL"] === os.devNull
  ) {
    return { ...process.env, GIT_CONFIG_GLOBAL: "nul" };
  }
  return process.env;
}

/** The outcome of one git invocation. */
export type GitResult =
  | { readonly ok: true; readonly stdout: Buffer }
  | {
      readonly ok: false;
      /**
       * `unavailable`: the `git` executable could not be started at all
       * (not installed, not on PATH). `failed`: git ran and exited
       * nonzero — for the plumbing readers used here, the queried object
       * or repository state does not exist or cannot be read.
       */
      readonly kind: "unavailable" | "failed";
    };

/**
 * Run one read-only git plumbing command with the given working directory,
 * feeding `stdin` when given (the `cat-file --batch` protocol) and
 * capturing standard output as exact bytes. Standard error is discarded
 * (see the module header). Never throws for git-level failures — only for
 * harness-level stream errors Node itself raises.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  stdin?: Buffer,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (result: GitResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    child.on("error", () => {
      // Spawn failure (ENOENT and kin): git never ran.
      settle({ ok: false, kind: "unavailable" });
    });
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      settle(
        code === 0
          ? { ok: true, stdout: Buffer.concat(chunks) }
          : { ok: false, kind: "failed" },
      );
    });
    // A process that exits before consuming its input surfaces EPIPE on
    // the stdin stream; swallow it — the exit code alone decides.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
