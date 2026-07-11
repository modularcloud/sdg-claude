// Self-tests for the property-test infrastructure (test/helpers/property.ts;
// TEST-SPEC 16 preamble, 0 H-10, 18 E-5) — harness machinery certification
// does not exercise (TEST-SPEC 17), so it is checked here before any
// section-16 property test (P-1…P-10) trusts it. No product is involved.
//
// What is pinned, by requirement:
//   * H-10 seeded, reproducible generation — one seed yields one value
//     sequence, run after run; different seeds yield different sequences.
//   * H-10 failure reporting — a falsified property throws a diagnosed
//     assertion failure (H-8) naming its seed and how to replay it.
//   * TEST-SPEC 16 shrinking — a forced failure is shrunk to the minimal
//     counterexample (scalar and structured demos), deterministically (E-5:
//     the identical failure is reported twice in a row).
//   * E-5 seed modes — the fixed default seed set (the CI mode) is used when
//     nothing overrides it; XSPEC_PROPERTY_SEED=<uint32> replays exactly that
//     seed; XSPEC_PROPERTY_SEED=random (the optional local mode) reports its
//     seed and that report reproduces the run.
//   * H-8 classification — generator defects and non-assertion property
//     errors surface as plain harness errors (with the seed for
//     reproduction), never as diagnosed assertion failures.
//
// Every checkProperty call here injects env (and, where relevant, report and
// entropy) — the ambient process environment must not leak into self-test
// results (H-10). Inline generators and property lambdas are deliberately
// unannotated: checkProperty's positional signature must keep inferring T
// for exactly this style (see the checkProperty doc comment).

import { expect, test } from "vitest";
import { fail, HarnessAssertionError } from "../helpers/assertions.js";
import {
  checkProperty,
  DEFAULT_PROPERTY_SEEDS,
  listOf,
  PROPERTY_SEED_ENV,
  PropertyFalsifiedError,
  resolveSeedPlan,
  type Choices,
} from "../helpers/property.js";

/** A moderately rich generator exercising every primitive draw. */
function demoValue(choices: Choices): unknown {
  return {
    flag: choices.boolean(0.3),
    kind: choices.weightedPick([
      [5, "prose"],
      [2, "section"],
      [1, "import"],
    ] as const),
    label: choices.pick(["a", "b", "c"] as const),
    points: listOf((inner) => inner.intInclusive(0, 0x10ffff), { max: 8 })(
      choices,
    ),
  };
}

/**
 * Run the always-passing recorder property and return the JSON of every
 * generated value, in trial order.
 */
async function recordDemoValues(options?: {
  readonly seeds?: readonly number[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly report?: (line: string) => void;
  readonly entropy?: () => number;
}): Promise<readonly string[]> {
  const recorded: string[] = [];
  await checkProperty(
    "self-test recorder",
    demoValue,
    (value) => {
      recorded.push(JSON.stringify(value));
    },
    {
      runs: 10,
      seeds: options?.seeds,
      env: options?.env ?? {},
      report: options?.report,
      entropy: options?.entropy,
    },
  );
  return recorded;
}

/** Await a rejection and return the thrown value (fails if it resolves). */
async function captureRejection(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the checkProperty call to reject, but it resolved");
}

test("a fixed-seed property run is reproducible (H-10)", async () => {
  const first = await recordDemoValues({ seeds: [987654321] });
  const second = await recordDemoValues({ seeds: [987654321] });
  expect(first).toHaveLength(10);
  expect(second).toEqual(first);

  const other = await recordDemoValues({ seeds: [123456789] });
  expect(other).toHaveLength(10);
  expect(other).not.toEqual(first);
});

test("the fixed default seed set drives runs when nothing overrides it (E-5 CI mode)", async () => {
  const byDefault = await recordDemoValues();
  const explicit = await recordDemoValues({
    seeds: DEFAULT_PROPERTY_SEEDS,
  });
  expect(byDefault).toHaveLength(10 * DEFAULT_PROPERTY_SEEDS.length);
  expect(byDefault).toEqual(explicit);

  // E-5: two consecutive runs produce identical trials.
  const again = await recordDemoValues();
  expect(again).toEqual(byDefault);
});

test("a forced failure reports its seed and shrinks to the minimal counterexample (H-10, TEST-SPEC 16)", async () => {
  const thrown = await captureRejection(
    checkProperty(
      "demo: every value stays below 100",
      (choices) => choices.intInclusive(0, 100000),
      (value) => {
        if (value >= 100) fail(`generated value ${String(value)} is >= 100`);
      },
      { runs: 50, seeds: [123456], env: {} },
    ),
  );

  // The falsification is a diagnosed assertion failure (H-8) …
  expect(thrown).toBeInstanceOf(PropertyFalsifiedError);
  expect(thrown).toBeInstanceOf(HarnessAssertionError);
  const error = thrown as PropertyFalsifiedError;

  // … naming its seed and the replay handle (H-10) …
  expect(error.seed).toBe(123456);
  expect(error.message).toContain("seed 123456");
  expect(error.message).toContain(`${PROPERTY_SEED_ENV}=123456`);

  // … and carrying the *minimal* failing value: 100 exactly (the smallest
  // integer the property rejects), reached by actual shrinking.
  expect(error.value).toBe(100);
  expect(error.shrinkSteps).toBeGreaterThan(0);
  expect(error.initialValue).not.toBe(error.value);
  expect(error.message).toContain("counterexample: 100");
  // The reported assertion is the shrunk counterexample's, not the original's.
  expect(error.assertionMessage).toBe("generated value 100 is >= 100");
});

test("structured counterexamples shrink, deterministically across runs (TEST-SPEC 16, E-5)", async () => {
  // Inline generic combinator + inferred property parameter: the composition
  // style every section-16 property will use.
  const run = () =>
    checkProperty(
      "demo: sums stay below 10",
      listOf((choices) => choices.intInclusive(0, 50), { max: 20 }),
      (items) => {
        const sum = items.reduce((total, item) => total + item, 0);
        if (sum >= 10) {
          fail(`sum ${String(sum)} of ${JSON.stringify(items)} is >= 10`);
        }
      },
      { runs: 20, seeds: [42], env: {} },
    );

  const first = await captureRejection(run());
  expect(first).toBeInstanceOf(PropertyFalsifiedError);
  const error = first as PropertyFalsifiedError;

  // Minimization: entry-wise binary search pins the sum to the failure
  // boundary exactly, and deletion makes the list no longer than the
  // original.
  const shrunk = error.value as readonly number[];
  const initial = error.initialValue as readonly number[];
  expect(shrunk.reduce((total, item) => total + item, 0)).toBe(10);
  expect(shrunk.length).toBeLessThanOrEqual(initial.length);
  expect(error.shrinkSteps).toBeGreaterThan(0);

  // E-5: shrinking is deterministic — the identical falsification (message
  // bytes included) is reported on a second run.
  const second = await captureRejection(run());
  expect(second).toBeInstanceOf(PropertyFalsifiedError);
  expect((second as PropertyFalsifiedError).message).toBe(error.message);
});

test("randomized local mode reports its seed, and the report reproduces the run (E-5)", async () => {
  const lines: string[] = [];
  const randomized = await recordDemoValues({
    env: { [PROPERTY_SEED_ENV]: "random" },
    report: (line) => lines.push(line),
    entropy: () => 0.5,
  });

  const expectedSeed = 2147483648; // floor(0.5 × 2^32)
  expect(
    lines.some(
      (line) =>
        line.includes(String(expectedSeed)) && line.includes(PROPERTY_SEED_ENV),
    ),
  ).toBe(true);

  // Replaying the reported seed reproduces the randomized run exactly.
  const replayed = await recordDemoValues({ seeds: [expectedSeed] });
  expect(randomized).toEqual(replayed);
});

test("an explicit environment seed overrides the property's own seed set (E-5 replay mode)", async () => {
  const viaEnv = await recordDemoValues({
    seeds: [111, 222, 333],
    env: { [PROPERTY_SEED_ENV]: "97531" },
  });
  const direct = await recordDemoValues({ seeds: [97531] });
  expect(viaEnv).toEqual(direct);
  expect(viaEnv).toHaveLength(10);
});

test("seed-plan resolution: default, replay, randomized, and malformed values", () => {
  const entropy = () => 0.25;

  const fixed = resolveSeedPlan({ name: "p", env: {}, entropy });
  expect(fixed.mode).toBe("fixed");
  expect([...fixed.seeds]).toEqual([...DEFAULT_PROPERTY_SEEDS]);

  const configured = resolveSeedPlan({
    name: "p",
    configSeeds: [7, 8],
    env: { [PROPERTY_SEED_ENV]: "" },
    entropy,
  });
  expect(configured.mode).toBe("fixed");
  expect([...configured.seeds]).toEqual([7, 8]);

  const replay = resolveSeedPlan({
    name: "p",
    configSeeds: [7, 8],
    env: { [PROPERTY_SEED_ENV]: "4294967295" },
    entropy,
  });
  expect(replay.mode).toBe("env");
  expect([...replay.seeds]).toEqual([4294967295]);

  const randomized = resolveSeedPlan({
    name: "p",
    env: { [PROPERTY_SEED_ENV]: "random" },
    entropy,
  });
  expect(randomized.mode).toBe("randomized");
  expect([...randomized.seeds]).toEqual([1073741824]); // floor(0.25 × 2^32)

  for (const malformed of ["nope", "-1", "1.5", "0x10", "4294967296"]) {
    expect(() =>
      resolveSeedPlan({
        name: "p",
        env: { [PROPERTY_SEED_ENV]: malformed },
        entropy,
      }),
    ).toThrow(/not a valid seed/);
  }
});

test("non-assertion property errors are harness errors carrying the seed (H-8)", async () => {
  const thrown = await captureRejection(
    checkProperty(
      "buggy body",
      (choices) => choices.intInclusive(0, 9),
      () => {
        throw new TypeError("boom");
      },
      { runs: 3, seeds: [7], env: {} },
    ),
  );
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(HarnessAssertionError);
  const error = thrown as Error;
  expect(error.message).toContain("seed 7");
  expect(error.message).toContain("H-8");
  expect(error.message).toContain(`${PROPERTY_SEED_ENV}=7`);
  expect(error.cause).toBeInstanceOf(TypeError);
});

test("generator defects are harness errors, never diagnosed failures (H-8)", async () => {
  const cases: ReadonlyArray<readonly [string, (choices: Choices) => unknown]> =
    [
      ["inverted bounds", (choices) => choices.intInclusive(5, 1)],
      ["empty pick", (choices) => choices.pick([])],
      ["bad probability", (choices) => choices.boolean(2)],
      [
        "bad weight",
        (choices) => choices.weightedPick([[0, "never"]] as const),
      ],
    ];
  for (const [label, generator] of cases) {
    const thrown = await captureRejection(
      checkProperty(
        `defective generator: ${label}`,
        generator,
        () => undefined,
        {
          runs: 1,
          seeds: [1],
          env: {},
        },
      ),
    );
    expect(thrown, label).toBeInstanceOf(Error);
    expect(thrown, label).not.toBeInstanceOf(HarnessAssertionError);
    expect((thrown as Error).message, label).toContain("harness error");
  }
});

test("listOf stays within its bounds across generation", async () => {
  const lengths: number[] = [];
  await checkProperty(
    "listOf bounds",
    listOf((choices) => choices.intInclusive(0, 3), {
      min: 2,
      max: 5,
      continueProbability: 0.5,
    }),
    (items) => {
      lengths.push(items.length);
    },
    { runs: 50, seeds: [11, 22], env: {} },
  );
  expect(lengths).toHaveLength(100);
  expect(Math.min(...lengths)).toBeGreaterThanOrEqual(2);
  expect(Math.max(...lengths)).toBeLessThanOrEqual(5);
  // Both boundary lengths are actually reached under these seeds — the
  // bounds assertion above is not vacuous.
  expect(lengths).toContain(2);
  expect(lengths).toContain(5);
});
