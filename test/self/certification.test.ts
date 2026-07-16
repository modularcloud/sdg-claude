// Certification of CERTIFICATIONS.md fixtures (TEST-SPEC 17 C-1, C-2).
//
// Each conformer's in-scope tests run against its fixture executable through
// the certification runner (certification-runner.ts) — the identical
// registered bodies the Vitest suite runs against the built product (C-2
// "one code path"). A conformer is verified when every in-scope test passes
// against it; violator expected-failure checks arrive with their CERT tasks,
// and the full C-1 gate over every fixture (conformers and all 13 violators,
// with per-fixture results in the harness-self CI output) is CERT-18's.
//
// The per-fixture report is printed on every run so certification results
// are legible per fixture, per test, in the harness-self CI job output
// (C-1), and the full report accompanies any failure diagnosis.

import { expect, test } from "vitest";
import { productTestSuite } from "../suite/registry/index.js";
import {
  CONF_CORE_IN_SCOPE,
  confCoreBinding,
} from "./certification-fixtures.js";
import {
  renderFixtureReport,
  runProductTests,
} from "./certification-runner.js";

// Generous end-to-end budget: the CONF-CORE set includes concurrency and
// polling choreography (T13.5-1…5) and the T10.4-5 read sweep, each spawning
// many fixture subprocesses. A hang guard only, never an assertion input
// (H-10); the runner's per-test watchdogs bound each body individually.
const RUN_TIMEOUT_MS = 600_000;

test(
  "CONF-CORE conformer: every CERTIFICATIONS.md in-scope test passes against the fixture (C-1)",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    const report = await runProductTests(
      confCoreBinding(),
      productTestSuite.select(CONF_CORE_IN_SCOPE),
    );
    // Direct stdout keeps the per-fixture, per-test report visible in the
    // harness-self CI job output (C-1) — Vitest's console interception
    // hides console.* lines from passing tests under the default reporter.
    const rendered = renderFixtureReport(report);
    process.stdout.write(`${rendered}\n`);
    expect(
      report.results.filter((result) => result.outcome !== "pass"),
      `every §CONF-CORE in-scope test must pass against the conformer (C-1)\n${rendered}`,
    ).toEqual([]);
  },
);
