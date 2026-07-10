// Certification runner (TEST-SPEC 17 preamble, C-1, C-2). Executes the full
// product-facing suite or a named subset — `ProductTestEntry` values resolved
// from the registry (test/suite/registry/index.ts) — against an arbitrary
// fixture product supplied as an executable binding and nothing else (C-2),
// and attributes an outcome to every test ID so certification results are
// legible per fixture, per test, in CI output (C-1; the harness-self job).
// One code path: the runner invokes exactly the registered bodies the Vitest
// suite runs against the built product (test/suite/declare.ts).
//
// Outcome taxonomy (H-8, pinned by helpers/assertions.ts):
//   pass   the body resolved — the product satisfied the test;
//   fail   the body threw `HarnessAssertionError` — a diagnosed assertion
//          failure, the only legitimate way a test rejects a product; this is
//          what C-1's "fails against a violator" and the S-7 sweep's
//          "diagnosed assertion failure" mean;
//   error  the body threw anything else — a harness defect (or an unbuilt
//          fixture), never a certified failure;
//   hang   the body did not settle within its budget — the runner records the
//          hang, leaves the abandoned body observed (a late rejection cannot
//          crash the run), and completes: a hanging test never hangs the
//          runner (H-8).
//
// Determinism (E-5, H-10): results are assembled in selection order — the
// caller's order for named subsets, canonical ID order for the full suite —
// independent of completion order under bounded concurrency (safe by H-1
// workspace isolation), and neither results nor the rendered report carry
// wall-clock data.

import { HarnessAssertionError } from "../helpers/assertions.js";
import type { ProductTestEntry } from "../helpers/registry.js";
import type { ProductBinding } from "../helpers/subprocess.js";

/** See the outcome taxonomy in the module header. */
export type ProductTestOutcome = "pass" | "fail" | "error" | "hang";

/** One test's attributed outcome against one fixture product (C-1). */
export interface ProductTestResult {
  readonly id: string;
  readonly title: string;
  readonly outcome: ProductTestOutcome;
  /** Failure/error/hang diagnosis; null exactly on pass. */
  readonly diagnosis: string | null;
}

/** A full run of a test selection against one fixture product. */
export interface FixtureRunReport {
  /** The fixture product's binding label. */
  readonly fixture: string;
  /** One result per selected test, in selection order. */
  readonly results: readonly ProductTestResult[];
  readonly counts: Readonly<Record<ProductTestOutcome, number>>;
}

export interface CertificationRunOptions {
  /**
   * Bounded parallelism over test bodies (isolated by H-1). Default 4 —
   * conservative: each body may spawn several product subprocesses.
   */
  readonly concurrency?: number;
  /**
   * Hang-watchdog override applied to every test in this run, replacing each
   * entry's own budget (`entry.timeoutMs`). A run knob, never an assertion
   * input (H-10).
   */
  readonly testTimeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Run the given registered tests against the fixture product behind
 * `binding` (C-2: the binding is all the runner knows about the product).
 * Resolves with per-test attributed outcomes; never rejects on account of a
 * test body — only on a malformed call (empty or duplicated selection, bad
 * options), because certifying zero tests, or one test twice, is always a
 * caller bug and must not pass vacuously (C-1).
 */
export async function runProductTests(
  binding: ProductBinding,
  tests: readonly ProductTestEntry[],
  options: CertificationRunOptions = {},
): Promise<FixtureRunReport> {
  if (tests.length === 0) {
    throw new Error(
      `certification runner invoked with an empty test selection against ${binding.label} — ` +
        `running zero tests would pass vacuously (C-1); select at least one registered test.`,
    );
  }
  const ids = new Set<string>();
  for (const entry of tests) {
    if (ids.has(entry.id)) {
      throw new Error(
        `certification runner invoked with duplicate test ${entry.id} in one selection.`,
      );
    }
    ids.add(entry.id);
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `certification runner: concurrency must be a positive integer, got ${String(options.concurrency)}.`,
    );
  }
  if (
    options.testTimeoutMs !== undefined &&
    (!Number.isInteger(options.testTimeoutMs) || options.testTimeoutMs <= 0)
  ) {
    throw new Error(
      `certification runner: testTimeoutMs must be a positive integer, got ${String(options.testTimeoutMs)}.`,
    );
  }

  const results = await inPool(tests, concurrency, (entry) =>
    runOne(binding, entry, options.testTimeoutMs ?? entry.timeoutMs),
  );
  const counts = { pass: 0, fail: 0, error: 0, hang: 0 };
  for (const result of results) {
    counts[result.outcome] += 1;
  }
  return { fixture: binding.label, results, counts };
}

/** IDs of results with the given outcome, in report (selection) order. */
export function idsWithOutcome(
  report: FixtureRunReport,
  outcome: ProductTestOutcome,
): readonly string[] {
  return report.results
    .filter((result) => result.outcome === outcome)
    .map((result) => result.id);
}

/**
 * Render a report as fixture-attributed, per-test-ID lines for CI output
 * (C-1 legibility). One line per test; a non-pass line carries the first line
 * of its diagnosis (the full diagnosis stays in the structured results). No
 * wall-clock content: identical runs render identical bytes (E-5).
 */
export function renderFixtureReport(report: FixtureRunReport): string {
  const { counts } = report;
  const lines = [
    `certification run against ${report.fixture}: ${report.results.length} test(s) — ` +
      `${counts.pass} pass, ${counts.fail} fail, ${counts.error} error, ${counts.hang} hang`,
  ];
  for (const result of report.results) {
    const head = `  ${result.outcome.toUpperCase().padEnd(5)} ${result.id} — ${result.title}`;
    lines.push(
      result.diagnosis === null
        ? head
        : `${head} :: ${firstLine(result.diagnosis)}`,
    );
  }
  return lines.join("\n");
}

const RENDERED_DIAGNOSIS_LIMIT = 240;

function firstLine(diagnosis: string): string {
  const line = diagnosis.split("\n", 1)[0] ?? "";
  return line.length > RENDERED_DIAGNOSIS_LIMIT
    ? `${line.slice(0, RENDERED_DIAGNOSIS_LIMIT)}…`
    : line;
}

type Verdict = Pick<ProductTestResult, "outcome" | "diagnosis">;

async function runOne(
  binding: ProductBinding,
  entry: ProductTestEntry,
  budgetMs: number,
): Promise<ProductTestResult> {
  const body = (async () => {
    await entry.run(binding);
  })();
  // Keep an abandoned body's eventual rejection observed (hang path): the
  // verdict is already recorded, and an unhandled rejection would crash the
  // whole run (H-8).
  body.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<Verdict>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        outcome: "hang",
        diagnosis:
          `test body did not settle within its ${budgetMs} ms budget — recorded as a hang ` +
          `and abandoned; a hanging test is a harness defect and never hangs the run (H-8).`,
      });
    }, budgetMs);
  });
  const settled: Promise<Verdict> = body.then(
    () => ({ outcome: "pass", diagnosis: null }),
    (thrown: unknown) => classifyThrown(thrown),
  );
  const verdict = await Promise.race([settled, watchdog]);
  clearTimeout(timer);
  return { id: entry.id, title: entry.title, ...verdict };
}

function classifyThrown(thrown: unknown): Verdict {
  if (isDiagnosedAssertionFailure(thrown)) {
    return { outcome: "fail", diagnosis: thrown.message };
  }
  if (thrown instanceof Error) {
    return {
      outcome: "error",
      diagnosis:
        `harness error — not a diagnosed assertion failure (H-8): ` +
        `${thrown.stack ?? `${thrown.name}: ${thrown.message}`}`,
    };
  }
  return {
    outcome: "error",
    diagnosis: `harness error (H-8): non-Error value thrown: ${String(thrown)}`,
  };
}

// `instanceof` plus a name fallback: module duplication (e.g. mixed loaders)
// must never silently reclassify a diagnosed failure as a harness error.
function isDiagnosedAssertionFailure(
  thrown: unknown,
): thrown is HarnessAssertionError {
  return (
    thrown instanceof HarnessAssertionError ||
    (thrown instanceof Error && thrown.name === "HarnessAssertionError")
  );
}

/**
 * Map `items` through `worker` with at most `limit` in flight, preserving
 * input order in the results. `worker` never rejects here (`runOne` captures
 * every outcome), but a rejection would still propagate loudly.
 */
async function inPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}
