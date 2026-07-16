// Certification of CERTIFICATIONS.md fixtures (TEST-SPEC 17 C-1, C-2).
//
// Each conformer's in-scope tests run against its fixture executable through
// the certification runner (certification-runner.ts) — the identical
// registered bodies the Vitest suite runs against the built product (C-2
// "one code path"). A conformer is verified when every in-scope test passes
// against it; a violator when exactly its certified tests fail against it —
// as diagnosed assertion failures, never harness errors or hangs — and every
// other in-scope test passes (the expected-failure contract of the
// CERTIFICATIONS.md preamble). Remaining violator checks arrive with their
// CERT tasks, and the full C-1 gate over every fixture (conformers and all
// 13 violators, with per-fixture results in the harness-self CI output) is
// CERT-18's.
//
// The per-fixture report is printed on every run so certification results
// are legible per fixture, per test, in the harness-self CI job output
// (C-1), and the full report accompanies any failure diagnosis.

import { expect, test } from "vitest";
import type { ProductBinding } from "../helpers/subprocess.js";
import { productTestSuite } from "../suite/registry/index.js";
import {
  CONF_CORE_IN_SCOPE,
  confCoreBinding,
  VIOL_CORE_EARLYWRITE_CERTIFIES,
  violCoreEarlywriteBinding,
  VIOL_CORE_NOLOCK_CERTIFIES,
  violCoreNolockBinding,
  VIOL_CORE_PARTIALWRITE_CERTIFIES,
  violCorePartialwriteBinding,
  VIOL_CORE_STALELOCK_CERTIFIES,
  violCoreStalelockBinding,
} from "./certification-fixtures.js";
import {
  idsWithOutcome,
  renderFixtureReport,
  runProductTests,
} from "./certification-runner.js";

// Generous end-to-end budget: the CONF-CORE set includes concurrency and
// polling choreography (T13.5-1…5) and the T10.4-5 read sweep, each spawning
// many fixture subprocesses. A hang guard only, never an assertion input
// (H-10); the runner's per-test watchdogs bound each body individually.
const RUN_TIMEOUT_MS = 600_000;

/**
 * Verify one violator's expected-failure contract (CERTIFICATIONS.md
 * preamble): run the conformer's in-scope tests against the violator's
 * binding and require that exactly its certified tests fail — as diagnosed
 * assertion failures, never harness errors or hangs — and every other
 * in-scope test passes.
 */
async function verifyViolatorExpectedFailures(
  binding: ProductBinding,
  inScope: readonly string[],
  certifies: readonly string[],
): Promise<void> {
  if (certifies.length === 0) {
    throw new Error(
      `${binding.label}: a violator certifies at least one test — an empty ` +
        `certified set would verify vacuously (C-1).`,
    );
  }
  for (const id of certifies) {
    if (!inScope.includes(id)) {
      throw new Error(
        `${binding.label}: certified test ${id} is not in the fixture's ` +
          `in-scope set, so its expected failure could never be observed (C-1).`,
      );
    }
  }
  const report = await runProductTests(
    binding,
    productTestSuite.select(inScope),
  );
  // Direct stdout keeps the per-fixture, per-test report visible in the
  // harness-self CI job output (C-1) — Vitest's console interception hides
  // console.* lines from passing tests under the default reporter.
  const rendered = renderFixtureReport(report);
  process.stdout.write(`${rendered}\n`);
  expect(
    {
      fail: idsWithOutcome(report, "fail"),
      pass: idsWithOutcome(report, "pass"),
      error: idsWithOutcome(report, "error"),
      hang: idsWithOutcome(report, "hang"),
    },
    `exactly the certified tests fail against ${binding.label} — as ` +
      `diagnosed assertion failures, never errors or hangs — and every ` +
      `other in-scope test passes (C-1)\n${rendered}`,
  ).toEqual({
    fail: inScope.filter((id) => certifies.includes(id)),
    pass: inScope.filter((id) => !certifies.includes(id)),
    error: [],
    hang: [],
  });
}

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

test(
  "VIOL-CORE-NOLOCK violator: exactly T13.5-2 fails, every other §CONF-CORE in-scope test passes (C-1)",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    await verifyViolatorExpectedFailures(
      violCoreNolockBinding(),
      CONF_CORE_IN_SCOPE,
      VIOL_CORE_NOLOCK_CERTIFIES,
    );
  },
);

test(
  "VIOL-CORE-EARLYWRITE violator: exactly T13.5-1 and T13.5-4 fail, every other §CONF-CORE in-scope test passes (C-1)",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    await verifyViolatorExpectedFailures(
      violCoreEarlywriteBinding(),
      CONF_CORE_IN_SCOPE,
      VIOL_CORE_EARLYWRITE_CERTIFIES,
    );
  },
);

test(
  "VIOL-CORE-STALELOCK violator: exactly T13.5-3 fails, every other §CONF-CORE in-scope test passes (C-1)",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    await verifyViolatorExpectedFailures(
      violCoreStalelockBinding(),
      CONF_CORE_IN_SCOPE,
      VIOL_CORE_STALELOCK_CERTIFIES,
    );
  },
);

test(
  "VIOL-CORE-PARTIALWRITE violator: exactly T13.5-5 fails, every other §CONF-CORE in-scope test passes (C-1)",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    await verifyViolatorExpectedFailures(
      violCorePartialwriteBinding(),
      CONF_CORE_IN_SCOPE,
      VIOL_CORE_PARTIALWRITE_CERTIFIES,
    );
  },
);
