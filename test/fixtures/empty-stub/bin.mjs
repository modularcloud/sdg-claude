#!/usr/bin/env node
// Harness-owned empty-stub product (TEST-SPEC H-8, S-7). Whatever the
// command — argv is ignored entirely — it exits with an unexpected code and
// writes nothing: no stdout, no stderr, no files, no hold file. The S-7
// red-green sweep (test/self/s7-red-green-sweep.test.ts) runs every
// registered product-facing test against this executable and requires each
// one to fail as a diagnosed assertion failure.
//
// Deliberately harness-owned, not src/'s pre-product placeholder: the sweep
// must stay meaningful — and green — after the real product replaces that
// placeholder in Phase 10 (H-8 sanctions exactly "a deliberately empty
// stub"). Exit code choice: 87 lies outside the SPEC.md 12.0 exit partition
// (0 | 1 | 2), so no test expecting a specified exit code can pass against
// it; it also differs from the src/ placeholder's 86, so a failure diagnosis
// quoting the exit code identifies which executable actually ran.
process.exit(87);
