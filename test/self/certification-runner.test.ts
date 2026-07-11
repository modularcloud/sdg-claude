// Certification-runner and registry self-test (TEST-SPEC 17 preamble, C-1,
// C-2, H-8). C-1 certification and the S-7 red-green sweep stand entirely on
// this machinery, so its mechanics are pinned before any certification result
// is trusted: the registry's ID grammar, duplicate rejection, loud named-
// subset resolution (a CERTIFICATIONS.md in-scope test that is not
// implemented must be a hard error, never a vacuous pass), and canonical
// ordering; and the runner's per-test-ID attribution, its H-8 outcome
// taxonomy (diagnosed assertion failure vs harness error vs hang), its
// completion guarantees, and its per-fixture report rendering.
//
// Ground truth comes from known-behavior stand-in products written into a
// fresh TestWorkspace (the builder is certified by S-2; the subprocess driver
// by S-3) and from synthetic registry entries in the reserved section-99 ID
// space. Deliberately no dependence on the built product or on src/'s
// placeholder: self-tests stay green in every phase (H-8) — the sweep against
// the harness-owned empty stub is S-7's, and real CERTIFICATIONS.md fixtures
// arrive with the CERT tasks. The stub stand-in here has exactly the
// placeholder's shape (every command exits 86 with no output), so the
// mission-level check — a named subset run against a stub product reports
// diagnosed failures — is exercised end to end.

import { expect, onTestFinished, test } from "vitest";
import {
  assertBytesEqual,
  assertExitCode,
  assertStderrEmpty,
} from "../helpers/assertions.js";
import {
  DEFAULT_PRODUCT_TEST_TIMEOUT_MS,
  ProductTestSuite,
  compareProductTestIds,
  defineProductTest,
} from "../helpers/registry.js";
import type { ProductTestEntry } from "../helpers/registry.js";
import { runProduct } from "../helpers/subprocess.js";
import type { ProductBinding } from "../helpers/subprocess.js";
import { TestWorkspace } from "../helpers/workspace.js";
import { declareProductTests } from "../suite/declare.js";
import { productTestSuite } from "../suite/registry/index.js";
import {
  idsWithOutcome,
  renderFixtureReport,
  runProductTests,
} from "./certification-runner.js";

// Conformer stand-in: fixed observable behavior for the `report` command.
const CONFORMER_SOURCE = `const [mode] = process.argv.slice(2);
if (mode === "report") {
  process.stdout.write("ok\\n");
  process.exit(0);
}
process.stderr.write("unknown mode\\n");
process.exit(99);
`;

// Stub stand-in with the pre-product placeholder's shape (FIX_PLAN baseline,
// H-8): every invocation exits 86 with no output.
const STUB_SOURCE = `process.exit(86);
`;

interface Standins {
  readonly conformer: ProductBinding;
  readonly stub: ProductBinding;
}

async function standins(): Promise<Standins> {
  const workspace = await TestWorkspace.create({
    files: {
      "conformer.mjs": CONFORMER_SOURCE,
      "stub.mjs": STUB_SOURCE,
    },
  });
  onTestFinished(() => workspace.dispose());
  return {
    conformer: {
      label: "conformer stand-in",
      command: process.execPath,
      prefixArgs: [workspace.path("conformer.mjs")],
    },
    stub: {
      label: "stub stand-in (exit 86, no output)",
      command: process.execPath,
      prefixArgs: [workspace.path("stub.mjs")],
    },
  };
}

// Synthetic entries: bodies follow the registry conventions exactly (own
// workspace lifecycle, rejection only via the diagnosed-assertion helpers),
// so what the runner sees here is what real suite bodies produce.

const PASSES_ON_CONFORMER = defineProductTest({
  id: "T99-1",
  title: "stand-in reports ok (exit 0, exact stdout, empty stderr)",
  run: async (product) => {
    const workspace = await TestWorkspace.create();
    try {
      const result = await runProduct(product, {
        cwd: workspace.root,
        argv: ["report"],
      });
      assertExitCode(result, 0, "T99-1 report");
      assertBytesEqual(result.stdoutBytes, "ok\n", "T99-1 stdout");
      assertStderrEmpty(result, "T99-1");
    } finally {
      await workspace.dispose();
    }
  },
});

const FAILS_EVERYWHERE = defineProductTest({
  id: "T99-2",
  title:
    "stand-in reports an answer no stand-in gives (always a diagnosed failure)",
  run: async (product) => {
    const workspace = await TestWorkspace.create();
    try {
      const result = await runProduct(product, {
        cwd: workspace.root,
        argv: ["report"],
      });
      assertExitCode(result, 0, "T99-2 report");
      assertBytesEqual(result.stdoutBytes, "unreachable\n", "T99-2 stdout");
    } finally {
      await workspace.dispose();
    }
  },
});

const THROWS_TYPE_ERROR = defineProductTest({
  id: "T99-3",
  title: "body throws a non-assertion Error (harness-error taxonomy probe)",
  run: async () => {
    throw new TypeError("boom from the harness body");
  },
});

const THROWS_NON_ERROR = defineProductTest({
  id: "T99-4",
  title: "body throws a non-Error value (harness-error taxonomy probe)",
  run: async () => {
    // Deliberate taxonomy probe: a thrown non-Error value.
    throw "a bare string, not an Error";
  },
});

function hangingEntry(id: string, timeoutMs?: number): ProductTestEntry {
  return defineProductTest({
    id,
    title: "body never settles (hang-watchdog probe)",
    timeoutMs,
    run: () => new Promise<never>(() => {}),
  });
}

test("defineProductTest enforces the TEST-SPEC ID grammar", () => {
  for (const id of [
    "T1-1",
    "T3-6",
    "T12.0-12",
    "T13.5-2",
    "T99.9-1",
    "P-1",
    "P-10",
  ]) {
    expect(defineProductTest({ id, title: "t", run: async () => {} }).id).toBe(
      id,
    );
  }
  for (const id of [
    "",
    "T-1",
    "T1",
    "T1-",
    "T1-0",
    "T1-01",
    "T01-1",
    "T1.01-1",
    "T1.1.1-1",
    "t1-1",
    "T1_1-1",
    "T1-1x",
    " T1-1",
    "T1-1 ",
    "P-0",
    "P-01",
    "p-1",
    "P1-1",
    "X1-1",
  ]) {
    expect(() =>
      defineProductTest({ id, title: "t", run: async () => {} }),
    ).toThrow(/malformed product test ID/);
  }
});

test("defineProductTest applies the shared default budget, freezes entries, and rejects empty titles and bad budgets", () => {
  const entry = defineProductTest({
    id: "T99-8",
    title: "budget default probe",
    run: async () => {},
  });
  expect(entry.timeoutMs).toBe(DEFAULT_PRODUCT_TEST_TIMEOUT_MS);
  expect(Object.isFrozen(entry)).toBe(true);
  expect(
    defineProductTest({
      id: "T99-8",
      title: "budget override probe",
      timeoutMs: 300_000,
      run: async () => {},
    }).timeoutMs,
  ).toBe(300_000);
  expect(() =>
    defineProductTest({ id: "T99-8", title: "   ", run: async () => {} }),
  ).toThrow(/title/);
  for (const timeoutMs of [0, -5, 1.5, Number.NaN]) {
    expect(() =>
      defineProductTest({
        id: "T99-8",
        title: "t",
        timeoutMs,
        run: async () => {},
      }),
    ).toThrow(/timeoutMs/);
  }
});

test("ProductTestSuite rejects duplicate IDs (stable, never-reused keys)", () => {
  expect(
    () => new ProductTestSuite([PASSES_ON_CONFORMER, PASSES_ON_CONFORMER]),
  ).toThrow(/duplicate product test ID T99-1/);
});

test("canonical ID order is numeric — sections then cases, T before P — independent of registration order", () => {
  const ids = ["P-10", "T12.0-1", "T99.9-1", "P-2", "T9.3-1", "T99-2", "T99-1"];
  const suite = new ProductTestSuite(
    ids.map((id) => defineProductTest({ id, title: "t", run: async () => {} })),
  );
  expect(suite.ids()).toEqual([
    "T9.3-1",
    "T12.0-1",
    "T99-1",
    "T99-2",
    "T99.9-1",
    "P-2",
    "P-10",
  ]);
  expect(compareProductTestIds("T9.3-1", "T12.0-1")).toBeLessThan(0);
  expect(compareProductTestIds("T99-1", "T99.9-1")).toBeLessThan(0);
  expect(compareProductTestIds("P-2", "P-10")).toBeLessThan(0);
  expect(compareProductTestIds("T13.5-2", "T13.5-2")).toBe(0);
});

test("named subsets resolve loudly: unknown IDs and duplicated requests are hard errors, caller order is preserved (C-1)", () => {
  const suite = new ProductTestSuite([PASSES_ON_CONFORMER, FAILS_EVERYWHERE]);
  expect(suite.has("T99-1")).toBe(true);
  expect(suite.has("T99-7")).toBe(false);
  expect(() => suite.get("T99-7")).toThrow(
    /unknown product test ID "T99-7".*vacuously.*C-1/s,
  );
  expect(() => suite.select(["T99-1", "T99-7"])).toThrow(
    /unknown product test ID/,
  );
  expect(() => suite.select(["T99-1", "T99-1"])).toThrow(
    /duplicate product test ID in named subset/,
  );
  expect(suite.select(["T99-2", "T99-1"]).map((entry) => entry.id)).toEqual([
    "T99-2",
    "T99-1",
  ]);
});

test("the runner attributes outcomes per test ID per fixture (C-1): mixed pass/fail against the conformer stand-in", async () => {
  const { conformer } = await standins();
  const report = await runProductTests(conformer, [
    PASSES_ON_CONFORMER,
    FAILS_EVERYWHERE,
  ]);
  expect(report.fixture).toBe("conformer stand-in");
  expect(report.results.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
    { id: "T99-1", outcome: "pass" },
    { id: "T99-2", outcome: "fail" },
  ]);
  expect(report.results[0]!.diagnosis).toBeNull();
  // The fail diagnosis is the body's own diagnosed assertion message.
  expect(report.results[1]!.diagnosis).toContain("T99-2 stdout");
  expect(report.results[1]!.diagnosis).toContain("bytes are not equal");
  expect(report.counts).toEqual({ pass: 1, fail: 1, error: 0, hang: 0 });
  expect(idsWithOutcome(report, "fail")).toEqual(["T99-2"]);
});

test("the runner executes a named subset against a stub product and reports every test as a diagnosed failure (H-8 red-green)", async () => {
  const { stub } = await standins();
  const suite = new ProductTestSuite([PASSES_ON_CONFORMER, FAILS_EVERYWHERE]);
  // Caller order, not canonical order: the subset is addressed by ID.
  const report = await runProductTests(stub, suite.select(["T99-2", "T99-1"]));
  expect(report.results.map((result) => result.id)).toEqual(["T99-2", "T99-1"]);
  expect(report.results.map((result) => result.outcome)).toEqual([
    "fail",
    "fail",
  ]);
  // Diagnosed, not crashed: each diagnosis names the observed stub behavior.
  for (const result of report.results) {
    expect(result.diagnosis).toContain("expected exit code 0");
    expect(result.diagnosis).toContain("exit code 86");
  }
  expect(report.counts).toEqual({ pass: 0, fail: 2, error: 0, hang: 0 });
});

test("the runner distinguishes harness errors from diagnosed assertion failures (H-8 taxonomy)", async () => {
  const { stub } = await standins();
  const report = await runProductTests(stub, [
    THROWS_TYPE_ERROR,
    THROWS_NON_ERROR,
  ]);
  expect(report.results.map((result) => result.outcome)).toEqual([
    "error",
    "error",
  ]);
  expect(report.results[0]!.diagnosis).toContain("harness error");
  expect(report.results[0]!.diagnosis).toContain(
    "TypeError: boom from the harness body",
  );
  expect(report.results[1]!.diagnosis).toContain("non-Error value thrown");
  expect(report.results[1]!.diagnosis).toContain("a bare string, not an Error");
  expect(report.counts).toEqual({ pass: 0, fail: 0, error: 2, hang: 0 });
});

test("a body exceeding its own budget is recorded as a hang and the run completes (H-8: never a harness hang)", async () => {
  const { conformer } = await standins();
  const report = await runProductTests(
    conformer,
    [hangingEntry("T99-5", 150), PASSES_ON_CONFORMER],
    { concurrency: 1 },
  );
  expect(report.results[0]!.outcome).toBe("hang");
  expect(report.results[0]!.diagnosis).toContain(
    "did not settle within its 150 ms budget",
  );
  // The run continued past the hang: later tests still execute and attribute.
  expect(report.results[1]).toMatchObject({ id: "T99-1", outcome: "pass" });
  expect(report.counts).toEqual({ pass: 1, fail: 0, error: 0, hang: 1 });
});

test("options.testTimeoutMs overrides every entry's own budget for the run", async () => {
  const { conformer } = await standins();
  // The entry's own (default) budget is 120 s; the run-level override makes
  // the watchdog fire in milliseconds — proving the override is in force.
  const report = await runProductTests(conformer, [hangingEntry("T99-6")], {
    testTimeoutMs: 100,
  });
  expect(report.results[0]!.outcome).toBe("hang");
  expect(report.results[0]!.diagnosis).toContain("100 ms budget");
});

test("bounded concurrency preserves selection order in the results (deterministic reports, E-5)", async () => {
  const { conformer } = await standins();
  const slow = defineProductTest({
    id: "T99-7",
    title: "slow pass (completes after the next entry)",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  });
  const report = await runProductTests(conformer, [slow, PASSES_ON_CONFORMER], {
    concurrency: 2,
  });
  expect(report.results.map((result) => result.id)).toEqual(["T99-7", "T99-1"]);
  expect(report.counts).toEqual({ pass: 2, fail: 0, error: 0, hang: 0 });
});

test("the runner refuses empty and duplicated selections (C-1 vacuity guard) and malformed options", async () => {
  const { stub } = await standins();
  await expect(runProductTests(stub, [])).rejects.toThrow(
    /empty test selection.*vacuously/s,
  );
  await expect(
    runProductTests(stub, [PASSES_ON_CONFORMER, PASSES_ON_CONFORMER]),
  ).rejects.toThrow(/duplicate test T99-1/);
  await expect(
    runProductTests(stub, [PASSES_ON_CONFORMER], { concurrency: 0 }),
  ).rejects.toThrow(/concurrency/);
  await expect(
    runProductTests(stub, [PASSES_ON_CONFORMER], { testTimeoutMs: -1 }),
  ).rejects.toThrow(/testTimeoutMs/);
});

test("renderFixtureReport is per-fixture, per-test-ID legible, one line per test, no wall-clock content (C-1)", async () => {
  const { stub } = await standins();
  const report = await runProductTests(stub, [
    PASSES_ON_CONFORMER,
    THROWS_TYPE_ERROR,
  ]);
  const rendered = renderFixtureReport(report);
  const lines = rendered.split("\n");
  expect(lines).toHaveLength(3); // header + one line per test
  expect(lines[0]).toContain("stub stand-in (exit 86, no output)");
  expect(lines[0]).toContain("2 test(s)");
  expect(lines[0]).toContain("0 pass, 1 fail, 1 error, 0 hang");
  expect(lines[1]).toContain("FAIL");
  expect(lines[1]).toContain("T99-1");
  expect(lines[1]).toContain("::"); // carries the first diagnosis line
  expect(lines[2]).toContain("ERROR");
  expect(lines[2]).toContain("T99-3");
  // Multi-line diagnoses (here: the TypeError's stack) stay one rendered
  // line; the full text lives in the structured results.
  expect(report.results[1]!.diagnosis).toContain("\n");
});

test("the product-test manifest loads as a well-formed registry (import-time canary for the assembled suite)", () => {
  expect(productTestSuite).toBeInstanceOf(ProductTestSuite);
  expect(productTestSuite.all()).toHaveLength(productTestSuite.size);
});

test("declareProductTests refuses entries missing from the manifest (a declared test invisible to certification is a wiring bug)", () => {
  expect(() => declareProductTests([FAILS_EVERYWHERE])).toThrow(
    /not in the manifest.*S-7/s,
  );
});
