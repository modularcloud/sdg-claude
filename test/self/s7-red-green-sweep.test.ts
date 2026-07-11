// S-7 red-green sweep (TEST-SPEC 17 S-7, §0 H-8). Against an empty stub
// product — every command exits with an unexpected code and no output — every
// product-facing test in the registry must fail with a diagnosed assertion
// failure (a `HarnessAssertionError`, helpers/assertions.ts), and the sweep
// must complete with no harness error, no hang, and no false pass.
//
// The sweep target is the harness-owned stub fixture
// (test/fixtures/empty-stub/bin.mjs), deliberately not src/'s pre-product
// placeholder: H-8 sanctions "a deliberately empty stub", and a sweep bound
// to the placeholder would lose its subject the moment Phase 10 implements
// the product. This file keeps S-7 green in every phase.
//
// Three layers, so the sweep's premise is pinned even while the registry is
// still being populated:
//   1. the stub fixture's own contract (unexpected exit code, silence,
//      no filesystem effects) is asserted directly;
//   2. a registry-convention probe body is run against the stub through the
//      certification runner, proving end to end that the committed fixture
//      produces exactly the diagnosed-failure taxonomy the sweep relies on;
//   3. the sweep proper runs every entry of the product-test manifest
//      (test/suite/registry/index.ts) against the stub via the certification
//      runner — the identical bodies and machinery C-1 certification uses
//      (C-2 one code path). While the manifest is empty (no SUITE-*/PROP-*
//      task has landed yet) the sweep is vacuously satisfied and layer 2
//      carries the check; suite completeness itself is gated elsewhere (S-1
//      traceability and the phase gate), not here.

import { expect, onTestFinished, test } from "vitest";
import { fileURLToPath } from "node:url";
import { assertExitCode } from "../helpers/assertions.js";
import { defineProductTest } from "../helpers/registry.js";
import { runProduct } from "../helpers/subprocess.js";
import type { ProductBinding } from "../helpers/subprocess.js";
import { TestWorkspace } from "../helpers/workspace.js";
import { productTestSuite } from "../suite/registry/index.js";
import {
  renderFixtureReport,
  runProductTests,
} from "./certification-runner.js";

// The committed stub executable, resolved relative to this module — never to
// the process cwd. Exit code 87: outside the SPEC.md 12.0 partition (0|1|2)
// and distinct from src/'s placeholder 86 (see the fixture's own comments).
const STUB_BIN = fileURLToPath(
  new URL("../fixtures/empty-stub/bin.mjs", import.meta.url),
);
const STUB_EXIT_CODE = 87;

function emptyStubBinding(): ProductBinding {
  return {
    label: `empty-stub fixture product (exit ${STUB_EXIT_CODE}, no output)`,
    command: process.execPath,
    prefixArgs: [STUB_BIN],
    requiredFiles: [STUB_BIN],
  };
}

// Wall-clock ceiling for the full sweep. Against the stub every product
// invocation exits immediately, so bodies fail fast; this budget is purely a
// hang guard for the whole run (H-8), never an assertion input (H-10).
const SWEEP_TIMEOUT_MS = 600_000;

test("the empty-stub fixture exits with an unexpected code and writes nothing, whatever the command (the S-7 stub contract)", async () => {
  const workspace = await TestWorkspace.create();
  onTestFinished(() => workspace.dispose());
  // Representative invocation shapes across the SPEC.md 12 surface — the stub
  // ignores argv, so these pin that no command form gets a different answer.
  const invocations: readonly (readonly string[])[] = [
    [],
    ["build"],
    ["check", "--json"],
    ["ids"],
    ["query", "node", "specs/a.mdx#alpha"],
    ["impact", "--base", "HEAD"],
    ["review", "create", "--strategy", "audit"],
    // 13.5 choreography shape: the stub must exit without creating the hold
    // file (the waitForFile red-green path in helpers/subprocess.ts).
    [
      "rename",
      "specs/a.mdx#alpha",
      "beta",
      "--test-hold",
      workspace.path("hold"),
    ],
    ["not-a-command", "--nor", "a-flag"],
  ];
  for (const argv of invocations) {
    const result = await runProduct(emptyStubBinding(), {
      cwd: workspace.root,
      argv,
    });
    expect(result.exitCode, result.commandLine).toBe(STUB_EXIT_CODE);
    expect(result.signal, result.commandLine).toBeNull();
    expect(result.stdoutBytes.length, result.commandLine).toBe(0);
    expect(result.stderrBytes.length, result.commandLine).toBe(0);
  }
  // "No output" extends to the filesystem: the stub created nothing in the
  // workspace — no derived files, no journal, no hold file.
  expect(await workspace.readdirNames()).toEqual([]);
});

// A body following the registry conventions exactly (own workspace lifecycle,
// rejection only via the diagnosed-assertion helpers): what the runner sees
// here is what real suite bodies produce against the stub. Section-99 ID
// space is reserved for synthetic self-test entries; this entry is never part
// of the manifest.
const SWEEP_PREMISE_PROBE = defineProductTest({
  id: "T99.7-1",
  title:
    "sweep-premise probe: expects a specified exit code the stub never produces",
  run: async (product) => {
    const workspace = await TestWorkspace.create();
    try {
      const result = await runProduct(product, {
        cwd: workspace.root,
        argv: ["build"],
      });
      assertExitCode(result, 0, "sweep-premise probe `build`");
    } finally {
      await workspace.dispose();
    }
  },
});

test("a registry-convention body fails diagnosed against the committed stub via the certification runner (the sweep premise, H-8)", async () => {
  const report = await runProductTests(emptyStubBinding(), [
    SWEEP_PREMISE_PROBE,
  ]);
  expect(report.counts).toEqual({ pass: 0, fail: 1, error: 0, hang: 0 });
  const result = report.results[0]!;
  expect(result.outcome).toBe("fail");
  // Diagnosed, not crashed: the diagnosis names expectation and observation.
  expect(result.diagnosis).toContain("expected exit code 0");
  expect(result.diagnosis).toContain(`exit code ${STUB_EXIT_CODE}`);
});

test(
  "S-7: every product-facing test in the registry fails as a diagnosed assertion failure against the empty stub — the sweep completes with no false pass, harness error, or hang (H-8)",
  { timeout: SWEEP_TIMEOUT_MS },
  async () => {
    const entries = productTestSuite.all();
    if (entries.length === 0) {
      // Vacuously satisfied: no SUITE-*/PROP-* task has populated the
      // manifest yet. This is not a false pass — "every product-facing test
      // fails" holds over the empty set, the stub premise is pinned by the
      // two tests above, and suite completeness is enforced by the S-1
      // traceability self-check and the phase gate, not by S-7.
      return;
    }
    // Bodies are H-1-isolated and exit fast against the stub (every product
    // invocation terminates immediately), so a higher lane count than the
    // runner's conservative default is safe and keeps the sweep short.
    const report = await runProductTests(emptyStubBinding(), entries, {
      concurrency: 8,
    });
    const offenders = report.results.filter(
      (result) => result.outcome !== "fail",
    );
    if (offenders.length > 0) {
      throw new Error(
        `S-7 red-green sweep violated: ${offenders.length} of ${report.results.length} ` +
          `product-facing test(s) did not fail as a diagnosed assertion failure against the ` +
          `empty stub (H-8: a pass here is a false pass; an error or hang is a harness ` +
          `defect).\n${renderFixtureReport(report)}`,
      );
    }
    expect(report.counts).toEqual({
      pass: 0,
      fail: entries.length,
      error: 0,
      hang: 0,
    });
  },
);
