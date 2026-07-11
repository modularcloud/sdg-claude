// Product-test registry for the xspec test harness (TEST-SPEC 17, C-2 "one
// code path"). Harness machinery only: no product imports, no test-framework
// dependence.
//
// Every product-facing test (TEST-SPEC sections 1–16) is registered as a
// `ProductTestEntry`: its stable TEST-SPEC ID, a human title, and a body that
// receives a `ProductBinding` — the executable binding is the only
// product-specific datum a body ever sees (C-2). The identical body therefore
// runs against the built product (the thin Vitest wrappers in test/suite/,
// see test/suite/declare.ts) and against an arbitrary CERTIFICATIONS.md
// fixture product (the certification runner in
// test/self/certification-runner.ts): certifying and testing use one code
// path, and no test hard-codes the product path.
//
// Body conventions (binding on every registered test):
// - The body builds its own fresh workspace(s) via TestWorkspace and owns
//   their lifecycle — create and dispose inside the body (try/finally). H-1:
//   tests share no mutable state, so bodies are safely runnable concurrently.
// - The body must not depend on test-framework context (no Vitest hooks or
//   state): it runs both as a Vitest test and under the certification runner.
// - A body rejects a product only by throwing `HarnessAssertionError`
//   (helpers/assertions.ts) — the diagnosed assertion failure of H-8. Any
//   other exception is a harness error: the certification runner and the S-7
//   sweep classify it as a defect, never as a legitimate test failure.
//
// A `ProductTestSuite` is the registry: entries keyed by test ID, duplicates
// rejected, named subsets resolved loudly (an in-scope test named by
// CERTIFICATIONS.md but not implemented must be a hard error — a silently
// missing test would pass certification vacuously, C-1), and enumeration in a
// canonical ID order so full-suite runs and reports are deterministic (E-5)
// regardless of registration order. The complete suite is assembled in one
// manifest: test/suite/registry/index.ts.

import type { ProductBinding } from "./subprocess.js";

/**
 * A product-facing test body. Everything it knows about the product under
 * test is the binding (C-2); see the body conventions in the module header.
 */
export type ProductTestBody = (product: ProductBinding) => Promise<void>;

/**
 * Default wall-clock budget for one run of one test body — used as the Vitest
 * per-test timeout and as the certification runner's hang watchdog alike (one
 * code path). Purely a hang guard (H-8); never part of an assertion (H-10).
 * Bodies normally terminate far earlier: every product invocation carries its
 * own subprocess timeout (helpers/subprocess.ts).
 */
export const DEFAULT_PRODUCT_TEST_TIMEOUT_MS = 120_000;

/** Declaration accepted by {@link defineProductTest}. */
export interface ProductTestSpec {
  /** Stable TEST-SPEC ID: `T<section>-<n>` (e.g. `T13.5-2`) or `P-<n>`. */
  readonly id: string;
  /** Human summary shown in Vitest titles and certification output. */
  readonly title: string;
  /**
   * Wall-clock budget for one run of the body, overriding the default (e.g.
   * property tests running many product invocations per body).
   */
  readonly timeoutMs?: number;
  readonly run: ProductTestBody;
}

/** A registered product-facing test. Obtain via {@link defineProductTest}. */
export interface ProductTestEntry {
  readonly id: string;
  readonly title: string;
  /** Effective wall-clock budget for one run of the body. */
  readonly timeoutMs: number;
  readonly run: ProductTestBody;
}

// TEST-SPEC test-case notation: `T<section>-<n>` with a section number like
// `3`, `1.1`, `12.0`, or `13.5` and a 1-based case number, plus the
// property/fuzz IDs `P-<n>` of section 16. Deliberately strict (no leading
// zeros, no other letters): IDs are stable keys shared with CERTIFICATIONS.md
// and the H-7 traceability map, so a typo must fail at registration, not
// surface as a mysteriously unknown ID later.
const PRODUCT_TEST_ID =
  /^(?:T[1-9]\d*(?:\.(?:0|[1-9]\d*))?-[1-9]\d*|P-[1-9]\d*)$/;

/**
 * Validate and freeze a product-test declaration. Malformed IDs, empty
 * titles, and non-positive budgets are registration-time errors.
 */
export function defineProductTest(spec: ProductTestSpec): ProductTestEntry {
  if (!PRODUCT_TEST_ID.test(spec.id)) {
    throw new Error(
      `malformed product test ID ${JSON.stringify(spec.id)} — expected TEST-SPEC notation ` +
        `\`T<section>-<n>\` (e.g. "T13.5-2") or \`P-<n>\` (e.g. "P-7"), with no leading zeros.`,
    );
  }
  if (spec.title.trim() === "") {
    throw new Error(
      `product test ${spec.id}: title must be a non-empty human summary.`,
    );
  }
  const timeoutMs = spec.timeoutMs ?? DEFAULT_PRODUCT_TEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `product test ${spec.id}: timeoutMs must be a positive integer, got ${String(spec.timeoutMs)}.`,
    );
  }
  return Object.freeze({
    id: spec.id,
    title: spec.title,
    timeoutMs,
    run: spec.run,
  });
}

/**
 * Canonical order over product test IDs: `T` tests in numeric section order
 * (major, then minor — absent minor first — then case number), then `P` tests
 * by number. Numeric, not lexicographic: T9.3-1 precedes T12.0-1 and P-2
 * precedes P-10.
 */
export function compareProductTestIds(a: string, b: string): number {
  const keyA = idSortKey(a);
  const keyB = idSortKey(b);
  const length = Math.max(keyA.length, keyB.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (keyA[i] ?? -1) - (keyB[i] ?? -1);
    if (delta !== 0) return delta;
  }
  return 0;
}

function idSortKey(id: string): readonly number[] {
  const property = /^P-(\d+)$/.exec(id);
  if (property) return [1, Number(property[1])];
  const t = /^T(\d+)(?:\.(\d+))?-(\d+)$/.exec(id);
  if (!t) {
    throw new Error(`malformed product test ID ${JSON.stringify(id)}`);
  }
  return [
    0,
    Number(t[1]),
    t[2] === undefined ? -1 : Number(t[2]),
    Number(t[3]),
  ];
}

/**
 * The registry: product-facing tests keyed by TEST-SPEC ID, addressable
 * individually and as named subsets, enumerable in canonical order (C-1,
 * C-2). The one instance every runner consumes is assembled in
 * test/suite/registry/index.ts.
 */
export class ProductTestSuite {
  readonly #byId: Map<string, ProductTestEntry>;
  readonly #ordered: readonly ProductTestEntry[];

  constructor(entries: Iterable<ProductTestEntry>) {
    const byId = new Map<string, ProductTestEntry>();
    for (const entry of entries) {
      if (byId.has(entry.id)) {
        throw new Error(
          `duplicate product test ID ${entry.id} — TEST-SPEC IDs are stable and never reused; ` +
            `two registrations of one ID would make the registry (and certification against it, C-1) ambiguous.`,
        );
      }
      byId.set(entry.id, entry);
    }
    this.#byId = byId;
    this.#ordered = Object.freeze(
      [...byId.values()].sort((a, b) => compareProductTestIds(a.id, b.id)),
    );
  }

  get size(): number {
    return this.#byId.size;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Resolve one test ID; unknown IDs are hard errors (C-1 vacuity guard). */
  get(id: string): ProductTestEntry {
    const entry = this.#byId.get(id);
    if (entry === undefined) {
      throw new Error(
        `unknown product test ID ${JSON.stringify(id)} — not registered in the product-test ` +
          `manifest (test/suite/registry/index.ts). A named subset (e.g. a CERTIFICATIONS.md ` +
          `in-scope set) must resolve loudly: a silently missing test would let certification ` +
          `pass vacuously (C-1).`,
      );
    }
    return entry;
  }

  /**
   * Resolve a named subset in caller order. Unknown IDs and duplicated
   * requests are hard errors.
   */
  select(ids: readonly string[]): readonly ProductTestEntry[] {
    const seen = new Set<string>();
    return ids.map((id) => {
      if (seen.has(id)) {
        throw new Error(`duplicate product test ID in named subset: ${id}`);
      }
      seen.add(id);
      return this.get(id);
    });
  }

  /** Every registered test, in canonical ID order (deterministic, E-5). */
  all(): readonly ProductTestEntry[] {
    return this.#ordered;
  }

  /** Every registered ID, in canonical order. */
  ids(): readonly string[] {
    return this.#ordered.map((entry) => entry.id);
  }
}
