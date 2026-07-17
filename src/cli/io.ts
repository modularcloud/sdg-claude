// CLI I/O surface types.
//
// IMPLEMENTATION (Architecture): the CLI entry point is a function
// `(argv, cwd, stdout, stderr) → exit code`; the bin is a trivial wrapper
// around it. Handlers receive the streams and working directory through
// `CommandContext`, never `process` globals, so every invocation path — the
// executable and any in-process caller — shares one code path.

/**
 * Minimal writable surface of `process.stdout`/`process.stderr`. Strings are
 * encoded as UTF-8 by Node's streams, so identical report text yields
 * identical bytes (SPEC 12.0 byte-determinism).
 */
export interface CliWriter {
  write(chunk: string): unknown;
}

/** Per-invocation context handed to command handlers. */
export interface CommandContext {
  /**
   * The invocation's working directory. `--config <path>` and
   * `--test-hold <path>` are filesystem paths resolved against it, while
   * node/graph-node/file/glob arguments are workspace-relative and
   * independent of it (SPEC 12.0).
   */
  readonly cwd: string;
  /** SPEC 12.0: the report — findings included — is standard-output content. */
  readonly stdout: CliWriter;
  /**
   * SPEC 12.0: usage and configuration error messages (exit 2) and all other
   * diagnostic text are standard-error content.
   */
  readonly stderr: CliWriter;
}
