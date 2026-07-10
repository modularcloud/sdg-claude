import { defineConfig } from "vitest/config";

// Test harness program configuration (TEST-SPEC.md 18; IMPLEMENTATION.md:
// Vitest). The harness is a separate program from the product: it lives
// entirely under test/, never imports product code, and drives the built
// `xspec` executable only as a subprocess (TEST-SPEC H-2).
//
// Projects — selected per suite/CI leg via `--project` (see the package.json
// scripts and .github/workflows/ci.yml):
//
//   suite    test/suite/    product-facing tests and property/fuzz tests
//                           (TEST-SPEC sections 1–16)
//   self     test/self/     harness self-tests and the certification runner
//                           (TEST-SPEC 17; CERTIFICATIONS.md)
//   windows  test/windows/  the E-6 platform-sensitive subset, run on the
//                           Windows CI leg; the Linux leg's representative-
//                           fixture outputs for the E-6 byte-identity
//                           comparison are exchanged through the directory
//                           named by the XSPEC_E6_EXCHANGE_DIR environment
//                           variable (written on Linux, read on Windows)
//   local    test/local/    local-only tests (TEST-SPEC E-2) — a separately
//                           invocable suite, never run in CI and never marked
//                           skipped; this set is currently empty
//
// Shared harness machinery (H-3 output adapters, the workspace builder, the
// subprocess and TypeScript-tooling drivers, the P-2/P-7 oracles) belongs in
// test/helpers/. Certification fixture products (CERTIFICATIONS.md) and
// consumer fixture projects belong in test/fixtures/.
//
// Paths below are relative to the repository root: the npm scripts are the
// canonical entry points and always run from the package root.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "suite", include: ["test/suite/**/*.test.ts"] } },
      { test: { name: "self", include: ["test/self/**/*.test.ts"] } },
      { test: { name: "windows", include: ["test/windows/**/*.test.ts"] } },
      { test: { name: "local", include: ["test/local/**/*.test.ts"] } },
    ],
  },
});
