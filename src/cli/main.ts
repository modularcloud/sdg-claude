// The CLI entry point and command dispatch.
//
// IMPLEMENTATION (Architecture): the entry point is a function
// `(argv, cwd, stdout, stderr) → exit code`; the bin (`bin.ts`) is a trivial
// wrapper around it. SPEC 12.0: exit codes partition all outcomes — 0
// success, 1 findings, 2 usage and configuration errors; reports are
// standard-output content, usage and configuration error messages and all
// other diagnostic text standard-error content.
//
// Command modules load on demand (dynamic import per dispatch), and the
// configuration parser (workspace/config.ts, on the TypeScript compiler)
// loads only when a command actually re-parses: `query` first tries the
// store-backed fast path (commands/query-fast.ts), which answers from
// stored graph data whose recorded derivation inputs match the current
// workspace bytes (SPEC 13.3; workspace/fast-read.ts) — identical bytes
// parse and derive identically (SPEC 12.0), so the recorded parse
// substitutes for re-parsing. Every other command — and any `query` whose
// store does not verify — takes the full path: parse the configuration,
// then dispatch, exactly as before.

import type { ExitCode } from "../core/findings.js";
import { locateWorkspace } from "../workspace/locate.js";
import type { Invocation } from "./args.js";
import { COMMAND_PATHS, parseArgv } from "./args.js";
import { tryFastQuery } from "./commands/query-fast.js";
import type { CliWriter, CommandContext } from "./io.js";
import { emitConfigurationErrors } from "./report.js";

/** One command's implementation, dispatched by `Invocation.command`. */
export type CommandHandler = (
  invocation: Invocation,
  context: CommandContext,
) => Promise<ExitCode>;

/**
 * The dispatch table: one lazily imported handler per SPEC 12.5 command
 * path, so an invocation loads only its own command's implementation.
 */
const HANDLERS: ReadonlyMap<string, () => Promise<CommandHandler>> = new Map(
  COMMAND_PATHS.map((path): [string, () => Promise<CommandHandler>] => {
    switch (path) {
      case "build":
        // SPEC 12.1.
        return [
          path,
          async () => (await import("./commands/build.js")).buildCommand,
        ];
      case "check":
        // SPEC 12.2.
        return [
          path,
          async () => (await import("./commands/check.js")).checkCommand,
        ];
      case "ids":
        // SPEC 12.3.
        return [
          path,
          async () => (await import("./commands/ids.js")).idsCommand,
        ];
      case "show":
        // SPEC 12.4.
        return [
          path,
          async () => (await import("./commands/show.js")).showCommand,
        ];
      case "coverage":
        // SPEC 8.2.
        return [
          path,
          async () => (await import("./commands/coverage.js")).coverageCommand,
        ];
      case "impact":
        // SPEC 9.
        return [
          path,
          async () => (await import("./commands/impact.js")).impactCommand,
        ];
      case "query node":
      case "query nodes":
      case "query edges":
      case "query subtree":
      case "query ancestors":
      case "query reachable":
        // SPEC 11.
        return [
          path,
          async () => (await import("./commands/query.js")).queryCommand,
        ];
      case "review create":
        // SPEC 10.7.
        return [
          path,
          async () =>
            (await import("./commands/review.js")).reviewCreateCommand,
        ];
      case "review list":
        // SPEC 10.7.
        return [
          path,
          async () => (await import("./commands/review.js")).reviewListCommand,
        ];
      case "review status":
        // SPEC 10.7.
        return [
          path,
          async () =>
            (await import("./commands/review.js")).reviewStatusCommand,
        ];
      case "review next":
        // SPEC 10.7.
        return [
          path,
          async () => (await import("./commands/review.js")).reviewNextCommand,
        ];
      case "review show":
        // SPEC 10.7.
        return [
          path,
          async () => (await import("./commands/review.js")).reviewShowCommand,
        ];
      case "review split":
        // SPEC 10.7.
        return [
          path,
          async () =>
            (await import("./commands/review-mutate.js")).reviewSplitCommand,
        ];
      case "review resolve":
        // SPEC 10.7.
        return [
          path,
          async () =>
            (await import("./commands/review-mutate.js")).reviewResolveCommand,
        ];
      case "review export":
        // SPEC 10.7.
        return [
          path,
          async () =>
            (await import("./commands/review.js")).reviewExportCommand,
        ];
      case "rename":
        // SPEC 6.4.
        return [
          path,
          async () => (await import("./commands/rename.js")).renameCommand,
        ];
      case "move":
        // SPEC 6.5.
        return [
          path,
          async () => (await import("./commands/move.js")).moveCommand,
        ];
      default:
        // Unreachable: every SPEC 12.5 command path is cased above.
        // Guarded so a command-table addition without a handler fails
        // loudly at module load.
        throw new Error(`no handler implemented for command '${path}'`);
    }
  }),
);

/** Whether the invocation is a `query` subcommand (SPEC 11). */
function isQueryCommand(command: string): boolean {
  return command.startsWith("query ");
}

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
  const loadHandler = HANDLERS.get(result.invocation.command);
  if (loadHandler === undefined) {
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
  const location = await locateWorkspace(cwd, result.invocation.config);
  if (!location.ok) {
    emitConfigurationErrors(stderr, location.findings);
    return 2;
  }

  // SPEC 13.3: `query` answers from the store when it verifies against the
  // current workspace bytes (module header) — the recorded configuration
  // parse stands in for re-parsing, so a fast answer never needs the
  // parser. Anything unverified falls through to the full path below.
  if (isQueryCommand(result.invocation.command)) {
    const fast = await tryFastQuery(
      result.invocation,
      location.located,
      stdout,
      stderr,
    );
    if (fast !== null) {
      return fast;
    }
  }

  // The full path: parse the configuration (a parse failure is the same
  // exit-2 configuration error as before), then dispatch.
  const { parseLocatedWorkspace } = await import("../workspace/config.js");
  const loaded = parseLocatedWorkspace(location.located);
  if (!loaded.ok) {
    emitConfigurationErrors(stderr, loaded.findings);
    return 2;
  }
  const handler = await loadHandler();
  return handler(result.invocation, {
    cwd,
    workspace: loaded.workspace,
    stdout,
    stderr,
  });
}
