// Certification of CERTIFICATIONS.md fixtures (TEST-SPEC 17 C-1, C-2).
//
// One per-fixture verification is generated below for every entry of the
// CERTIFICATION_FIXTURES manifest (certification-fixtures.ts) — all four
// conformers and all thirteen violators — and the whole-document gate
// (certification-document.test.ts) proves that manifest equal to
// specs/CERTIFICATIONS.md, so certification demonstrably runs against each
// fixture in the document (C-1).
//
// Each conformer's in-scope tests run against its fixture executable through
// the certification runner (certification-runner.ts) — the identical
// registered bodies the Vitest suite runs against the built product (C-2
// "one code path"). A conformer is verified when every in-scope test passes
// against it; a violator when exactly its certified tests fail against it —
// as diagnosed assertion failures, never harness errors or hangs — and every
// other in-scope test passes (the expected-failure contract of the
// CERTIFICATIONS.md preamble).
//
// The per-fixture report is printed on every run so certification results
// are legible per fixture, per test, in the harness-self CI job output
// (C-1), and the full report accompanies any failure diagnosis.

import { expect, test } from "vitest";
import type { ProductBinding } from "../helpers/subprocess.js";
import { productTestSuite } from "../suite/registry/index.js";
import { CERTIFICATION_FIXTURES } from "./certification-fixtures.js";
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
 * Verify one conformer (CERTIFICATIONS.md preamble): run its in-scope tests
 * against its binding and require that every one passes (C-1).
 */
async function verifyConformerAllPass(
  binding: ProductBinding,
  inScope: readonly string[],
): Promise<void> {
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
    report.results.filter((result) => result.outcome !== "pass"),
    `every in-scope test must pass against ${binding.label} (C-1)\n${rendered}`,
  ).toEqual([]);
}

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

/** Prose ID list for test titles: "A", "A and B", "A, B, and C". */
function prettyIdList(ids: readonly string[]): string {
  const last = ids[ids.length - 1];
  if (last === undefined) {
    throw new Error("prettyIdList: empty ID list");
  }
  if (ids.length === 1) return last;
  if (ids.length === 2) return `${ids[0]} and ${last}`;
  return `${ids.slice(0, -1).join(", ")}, and ${last}`;
}

for (const conformerEntry of CERTIFICATION_FIXTURES) {
  test(
    `${conformerEntry.name} conformer: every CERTIFICATIONS.md in-scope test passes against the fixture (C-1)`,
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      await verifyConformerAllPass(
        conformerEntry.binding(),
        conformerEntry.inScope,
      );
    },
  );
  for (const violatorEntry of conformerEntry.violators) {
    const fails = violatorEntry.certifies.length === 1 ? "fails" : "fail";
    test(
      `${violatorEntry.name} violator: exactly ${prettyIdList(violatorEntry.certifies)} ${fails}, ` +
        `every other §${conformerEntry.name} in-scope test passes (C-1)`,
      { timeout: RUN_TIMEOUT_MS },
      async () => {
        await verifyViolatorExpectedFailures(
          violatorEntry.binding(),
          conformerEntry.inScope,
          violatorEntry.certifies,
        );
      },
    );
  }
}
