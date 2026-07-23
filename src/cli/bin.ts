#!/usr/bin/env node
// The `xspec` executable: a trivial wrapper binding the CLI entry
// `(argv, cwd, stdout, stderr) → exit code` to the process (IMPLEMENTATION
// Architecture). It sets `process.exitCode` rather than calling
// `process.exit()`, so pending stream writes flush before the process exits.
//
// The on-disk V8 compile cache (node:module `enableCompileCache`) is
// enabled before any product module loads — `main.js` is imported
// dynamically so the whole module graph compiles through the cache. The
// cache changes no observable behavior (SPEC 12.0: every output is a
// function of the workspace bytes, never of timing) and lives outside the
// workspace (Node's default cache directory); it only removes repeated
// parse/compile cost from every CLI invocation. Best-effort by design:
// where the cache directory is unusable, Node silently runs without it.

import { enableCompileCache } from "node:module";

enableCompileCache();

const { main } = await import("./main.js");

try {
  process.exitCode = await main(
    process.argv.slice(2),
    process.cwd(),
    process.stdout,
    process.stderr,
  );
} catch (error) {
  // An internal defect, not a defined SPEC 12.0 outcome. Exit outside the
  // 0/1/2 partition so a crash can never be mistaken for a defined failure
  // class; the stack goes to stderr for diagnosis.
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`xspec: internal error: ${detail}\n`);
  process.exitCode = 70;
}
