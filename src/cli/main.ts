// The CLI entry point and command dispatch.
//
// IMPLEMENTATION (Architecture): the entry point is a function
// `(argv, cwd, stdout, stderr) → exit code`; the bin (`bin.ts`) is a trivial
// wrapper around it. SPEC 12.0: exit codes partition all outcomes — 0
// success, 1 findings, 2 usage and configuration errors; reports are
// standard-output content, usage and configuration error messages and all
// other diagnostic text standard-error content.

import type { ExitCode } from "../core/findings.js";
import { loadWorkspace } from "../workspace/config.js";
import type { Invocation } from "./args.js";
import { COMMAND_PATHS, parseArgv } from "./args.js";
import { buildCommand } from "./commands/build.js";
import { coverageCommand } from "./commands/coverage.js";
import { idsCommand } from "./commands/ids.js";
import { queryCommand } from "./commands/query.js";
import { showCommand } from "./commands/show.js";
import type { CliWriter, CommandContext } from "./io.js";
import { emitConfigurationErrors } from "./report.js";

/** One command's implementation, dispatched by `Invocation.command`. */
export type CommandHandler = (
  invocation: Invocation,
  context: CommandContext,
) => Promise<ExitCode>;

/**
 * Temporary Phase-10 scaffolding (FIX_PLAN T3): the command parses per
 * SPEC 12.0 but its behavior is not built yet. It exits 2 with an explicit
 * stderr diagnostic and an empty standard output — inside the SPEC 12.0 exit
 * partition and consistent with the exit-2 stream rule (with `--json`, an
 * exit-2 error prevents emitting the single JSON document, so standard
 * output is empty). Removed as later tasks land each command's behavior.
 */
const notImplemented: CommandHandler = (invocation, context) => {
  context.stderr.write(`xspec: ${invocation.command}: not implemented\n`);
  return Promise.resolve(2);
};

/**
 * The dispatch table: one handler per SPEC 12.5 command path. Later tasks
 * replace the remaining `notImplemented` entries with real implementations.
 */
const HANDLERS: ReadonlyMap<string, CommandHandler> = new Map(
  COMMAND_PATHS.map((path): [string, CommandHandler] => {
    switch (path) {
      case "build":
        // SPEC 12.1.
        return [path, buildCommand];
      case "ids":
        // SPEC 12.3.
        return [path, idsCommand];
      case "show":
        // SPEC 12.4.
        return [path, showCommand];
      case "coverage":
        // SPEC 8.2.
        return [path, coverageCommand];
      case "query node":
      case "query nodes":
      case "query edges":
      case "query subtree":
      case "query ancestors":
      case "query reachable":
        // SPEC 11.
        return [path, queryCommand];
      default:
        return [path, notImplemented];
    }
  }),
);

/**
 * The CLI entry: parse per SPEC 12.0, dispatch per SPEC 12.5, return the
 * exit code. All output goes through the given writers; the working
 * directory arrives as data — the entry reads no `process` globals.
 */
export async function main(
  argv: readonly string[],
  cwd: string,
  stdout: CliWriter,
  stderr: CliWriter,
): Promise<ExitCode> {
  const result = parseArgv(argv);
  if (!result.ok) {
    // SPEC 12.0: usage errors — unknown commands or flags, missing required
    // flags or arguments, invalid flag values, repeated flags, non-UTF-8
    // argument values — exit 2 with the diagnostic on standard error and
    // nothing on standard output.
    stderr.write(`${result.message}\n`);
    return 2;
  }
  const handler = HANDLERS.get(result.invocation.command);
  if (handler === undefined) {
    // Unreachable: the dispatch table is built from the same command table
    // the parser matches against. Guarded so a table regression fails loudly.
    throw new Error(
      `no handler registered for command '${result.invocation.command}'`,
    );
  }
  // SPEC 7/14.14: every command locates and loads the configuration —
  // upward search from the working directory, or the `--config <path>`
  // value resolved against it (12.0). A missing or invalid configuration
  // is a configuration error, reported as a usage error (exit 2) preceding
  // all source analysis; with `--json`, the exit-2 error prevents emitting
  // the single JSON document, so standard output stays empty (12.0).
  const loaded = await loadWorkspace(cwd, result.invocation.config);
  if (!loaded.ok) {
    emitConfigurationErrors(stderr, loaded.findings);
    return 2;
  }
  return handler(result.invocation, {
    cwd,
    workspace: loaded.workspace,
    stdout,
    stderr,
  });
}
