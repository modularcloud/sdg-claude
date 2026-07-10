// Property-test infrastructure for the xspec test harness (TEST-SPEC 16
// preamble; 0 H-10; 18 E-5). Harness machinery only: no product imports, no
// I/O, no test-framework dependence — the section-16 property tests built on
// this module run identically as Vitest suite tests and under the
// certification runner (C-2), because a falsified property rejects the
// product the only legitimate way: by throwing a `HarnessAssertionError`
// (H-8), here the `PropertyFalsifiedError` subclass carrying the seed and the
// shrunk counterexample.
//
// Model — recorded choice tapes:
//
// A generator is a plain function drawing primitive choices from a `Choices`
// source (`intInclusive`, `boolean`, `pick`, `weightedPick`; `listOf`
// composes them). Every draw is recorded as one non-negative integer on a
// tape. Generation is seeded and reproducible (H-10): the same seed replays
// the same tape and therefore the same values, on every platform (the PRNG
// uses exact 32-bit integer arithmetic). Shrinking (TEST-SPEC 16: "shrink
// failures") operates on the tape, not on values: candidate tapes — blocks
// deleted, blocks zeroed, entries binary-searched toward zero — are replayed
// through the *same* generator, so arbitrarily composed generators shrink
// with no per-generator shrinker, and every draw's constraints hold on
// replay by construction (a candidate violating them is discarded). Each
// accepted candidate is strictly smaller in shortlex order, so shrinking
// terminates. Value simplicity therefore follows draw order: generators
// should put their simplest outcome at the low end (`intInclusive` shrinks
// toward `min`, `boolean` toward `false`, `pick`/`weightedPick` toward the
// first item, `listOf` toward `min` elements).
//
// Seed discipline (E-5, H-10):
//
// * Default — the fixed seed set. With no environment override,
//   `checkProperty` runs `runs` trials per seed of `seeds` (default
//   `DEFAULT_PROPERTY_SEEDS`, literal constants). This is the CI mode and the
//   local default: two consecutive runs produce identical trials, so the
//   suite's pass/fail results are deterministic.
// * `XSPEC_PROPERTY_SEED=<uint32>` — fixed-seed replay: exactly that seed,
//   overriding the property's own seed set; how a reported failure is
//   reproduced.
// * `XSPEC_PROPERTY_SEED=random` — the optional randomized local mode: a
//   fresh seed per property, reported through the property's reporter
//   (default `console.info`) so any observed behavior can be replayed. Never
//   set in CI (.github/workflows/ci.yml sets no XSPEC_PROPERTY_SEED).
//
// Every falsification message names the failing seed and the replay
// environment variable (H-10: the seed is reported on failure). A property
// body that throws anything other than `HarnessAssertionError`, and a
// generator that throws at all, is a harness defect: `checkProperty`
// rethrows it as a plain `Error` (never a diagnosed assertion failure) with
// the seed attached for reproduction, matching the certification runner's
// and the S-7 sweep's outcome taxonomy (H-8).

import { HarnessAssertionError } from "./assertions.js";

/** Environment variable selecting the seed mode (E-5); see the module header. */
export const PROPERTY_SEED_ENV = "XSPEC_PROPERTY_SEED";

/**
 * The fixed default seed set (E-5: "a fixed seed set in CI") — arbitrary
 * literal constants, never derived from the clock (H-10). Properties may
 * override with their own fixed `seeds`; the environment variable overrides
 * both.
 */
export const DEFAULT_PROPERTY_SEEDS: readonly number[] = Object.freeze([
  271828183, 314159265, 161803399,
]);

/** Default trials per seed. Product-driving properties usually lower this. */
export const DEFAULT_RUNS_PER_SEED = 25;

/**
 * Default cap on property executions spent shrinking one falsification.
 * Shrinking stops at the budget and reports the best counterexample so far —
 * a bound on work, never on correctness.
 */
export const DEFAULT_MAX_SHRINK_EXECUTIONS = 300;

const MAX_UINT32 = 0xffffffff;
const TWO_POW_32 = 0x100000000;
// A generator drawing more choices than this in one trial is treated as
// runaway (a harness defect): trials must be bounded for shrinking and
// replay to be tractable.
const TAPE_LIMIT = 65536;
// Cap on generator replays (including discarded invalid candidates) per
// shrink, bounding shrink CPU independently of the property-execution budget.
const REPLAY_LIMIT = 20000;
const RENDER_LIMIT = 2000;
const SHRINK_DELETE_BLOCKS = [8, 4, 2, 1] as const;
const SHRINK_ZERO_BLOCKS = [8, 4, 2] as const; // one-entry zeroing is subsumed by minimization

/**
 * The primitive draws available to a generator. Each draw records onto the
 * trial's tape; simplicity follows draw order (see the module header), so put
 * the simplest outcome at the low end / first position.
 */
export interface Choices {
  /**
   * Uniform integer in [min, max] (safe integers, span at most 2^32 - 1).
   * Shrinks toward `min`.
   */
  intInclusive(min: number, max: number): number;
  /**
   * Boolean, true with the given probability (default 0.5) in random mode.
   * Shrinks toward `false`.
   */
  boolean(probabilityTrue?: number): boolean;
  /** Uniform choice from a non-empty list. Shrinks toward the first item. */
  pick<T>(items: readonly T[]): T;
  /**
   * Weighted choice from non-empty [weight, value] entries (weights finite
   * and positive; they shape only random-mode generation, not replay).
   * Shrinks toward the first entry — order entries simplest-first even when
   * the interesting weight lives elsewhere.
   */
  weightedPick<T>(entries: ReadonlyArray<readonly [number, T]>): T;
}

/**
 * A value generator: a pure synchronous function of its draws. Generators
 * compose by ordinary function calls; all drawing must happen before the
 * generator returns (a stored `Choices` used later throws).
 */
export type Gen<T> = (choices: Choices) => T;

export interface ListOfOptions {
  /** Minimum length (default 0). */
  readonly min?: number;
  /** Maximum length (required: trials must be bounded, H-10/TAPE_LIMIT). */
  readonly max: number;
  /**
   * Probability of appending each element beyond `min` in random mode
   * (default 0.8); shapes length distribution only, never replay.
   */
  readonly continueProbability?: number;
}

/**
 * Generator of lists of `min`..`max` elements. One continuation bit is drawn
 * before each optional element, so shrinking truncates lists (bit toward
 * false) and deletes middle elements (block deletion of bit+element pairs).
 */
export function listOf<T>(
  element: Gen<T>,
  options: ListOfOptions,
): Gen<readonly T[]> {
  const min = options.min ?? 0;
  const { max } = options;
  const continueProbability = options.continueProbability ?? 0.8;
  if (!Number.isInteger(min) || min < 0) {
    throw new Error(
      `listOf: min must be a non-negative integer, got ${String(min)}`,
    );
  }
  if (!Number.isInteger(max) || max < min) {
    throw new Error(
      `listOf: max must be an integer >= min (${String(min)}), got ${String(max)}`,
    );
  }
  if (
    typeof continueProbability !== "number" ||
    !Number.isFinite(continueProbability) ||
    continueProbability < 0 ||
    continueProbability > 1
  ) {
    throw new Error(
      `listOf: continueProbability must be a number in [0, 1], got ${String(continueProbability)}`,
    );
  }
  return (choices) => {
    const items: T[] = [];
    while (items.length < min) items.push(element(choices));
    while (items.length < max && choices.boolean(continueProbability)) {
      items.push(element(choices));
    }
    return items;
  };
}

/** Optional knobs accepted by {@link checkProperty}. */
export interface PropertyOptions<T> {
  /** Trials per seed (default {@link DEFAULT_RUNS_PER_SEED}). */
  readonly runs?: number;
  /**
   * This property's fixed seed set (default
   * {@link DEFAULT_PROPERTY_SEEDS}); `XSPEC_PROPERTY_SEED` overrides it.
   */
  readonly seeds?: readonly number[];
  /**
   * Cap on property executions spent shrinking (default
   * {@link DEFAULT_MAX_SHRINK_EXECUTIONS}). Product-driving properties
   * should size this against their test's time budget.
   */
  readonly maxShrinkExecutions?: number;
  /** Counterexample renderer (default JSON; output truncated for messages). */
  readonly render?: (value: T) => string;
  /** Environment to consult for {@link PROPERTY_SEED_ENV} (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Seed reporter for the randomized mode (default console.info). */
  readonly report?: (line: string) => void;
  /**
   * Entropy in [0, 1) for the randomized mode's seed (default Math.random) —
   * an injection point for the harness's own self-tests; never used in any
   * other mode (H-10).
   */
  readonly entropy?: () => number;
}

/** How the effective seed set was chosen; see the module header. */
export type SeedMode = "fixed" | "env" | "randomized";

export interface SeedPlan {
  readonly mode: SeedMode;
  readonly seeds: readonly number[];
}

/**
 * A falsified property, reported as a diagnosed assertion failure (H-8) that
 * names the failing seed (H-10) and carries the shrunk counterexample.
 */
export class PropertyFalsifiedError extends HarnessAssertionError {
  /** The property's name. */
  readonly propertyName: string;
  /** The seed whose trial stream falsified the property (H-10). */
  readonly seed: number;
  /** 1-based falsifying trial index within this seed's stream. */
  readonly trial: number;
  /** Trials per seed the run was configured for. */
  readonly runs: number;
  /** The shrunk counterexample. */
  readonly value: unknown;
  /** The originally generated counterexample, before shrinking. */
  readonly initialValue: unknown;
  /** The assertion message the shrunk counterexample fails with. */
  readonly assertionMessage: string;
  /** Accepted shrink steps (0 = the original counterexample was minimal). */
  readonly shrinkSteps: number;
  /** Property executions spent shrinking. */
  readonly shrinkExecutions: number;

  constructor(details: {
    readonly propertyName: string;
    readonly seed: number;
    readonly trial: number;
    readonly runs: number;
    readonly value: unknown;
    readonly initialValue: unknown;
    readonly renderedValue: string;
    readonly renderedInitialValue: string;
    readonly assertionMessage: string;
    readonly shrinkSteps: number;
    readonly shrinkExecutions: number;
  }) {
    const shrinkNote =
      details.shrinkSteps > 0
        ? `\n  shrunk from: ${details.renderedInitialValue}\n  (${String(details.shrinkSteps)} accepted shrink steps, ${String(details.shrinkExecutions)} property executions)`
        : "\n  (already minimal: no shrink candidate was accepted)";
    super(
      `property ${JSON.stringify(details.propertyName)}: falsified with seed ${String(details.seed)} ` +
        `(trial ${String(details.trial)} of ${String(details.runs)})\n` +
        `  counterexample: ${details.renderedValue}${shrinkNote}\n` +
        `  assertion: ${indentContinuationLines(details.assertionMessage)}\n` +
        `  reproduce with ${PROPERTY_SEED_ENV}=${String(details.seed)}`,
    );
    this.propertyName = details.propertyName;
    this.seed = details.seed;
    this.trial = details.trial;
    this.runs = details.runs;
    this.value = details.value;
    this.initialValue = details.initialValue;
    this.assertionMessage = details.assertionMessage;
    this.shrinkSteps = details.shrinkSteps;
    this.shrinkExecutions = details.shrinkExecutions;
  }
}

/**
 * Resolve the effective seed set from the environment and the property's
 * configuration (E-5); exported for the harness's own self-tests.
 */
export function resolveSeedPlan(input: {
  readonly name: string;
  readonly configSeeds?: readonly number[] | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly entropy: () => number;
}): SeedPlan {
  const raw = input.env[PROPERTY_SEED_ENV];
  if (raw !== undefined && raw !== "") {
    if (raw === "random") {
      const fraction = input.entropy();
      if (typeof fraction !== "number" || !(fraction >= 0) || !(fraction < 1)) {
        throw new Error(
          `property ${JSON.stringify(input.name)}: entropy() must return a number in [0, 1), got ${String(fraction)}`,
        );
      }
      const seed = Math.floor(fraction * TWO_POW_32);
      return { mode: "randomized", seeds: Object.freeze([seed]) };
    }
    if (/^(?:0|[1-9][0-9]*)$/.test(raw)) {
      const seed = Number(raw);
      if (seed <= MAX_UINT32) {
        return { mode: "env", seeds: Object.freeze([seed]) };
      }
    }
    throw new Error(
      `property ${JSON.stringify(input.name)}: ${PROPERTY_SEED_ENV}=${JSON.stringify(raw)} is not a valid seed — ` +
        `expected "random" (randomized local mode, E-5) or an unsigned 32-bit decimal integer (fixed-seed replay)`,
    );
  }
  const seeds = input.configSeeds ?? DEFAULT_PROPERTY_SEEDS;
  validateSeeds(input.name, seeds);
  return { mode: "fixed", seeds };
}

/**
 * Run a property: for each seed of the resolved plan, generate and test
 * `runs` values. On the first falsification (the body throwing
 * `HarnessAssertionError`), shrink it and throw a
 * {@link PropertyFalsifiedError} naming the seed. Resolves when every trial
 * passes.
 *
 * `generator` and `property` are separate parameters (not options members)
 * deliberately: TypeScript then fixes `T` from the generator before it
 * contextually types the property, so an inline generic combinator call
 * (e.g. `listOf(...)`) composes with an inferred property parameter — the
 * same two members in one object literal infer `T` as `unknown`.
 *
 * @param name Property name, shown in seed reports and falsification
 *   messages (e.g. `"P-1 segment validity"`).
 * @param generator The value generator.
 * @param property The property body: resolves to accept the value, throws
 *   `HarnessAssertionError` (helpers/assertions.ts `fail`) to reject it.
 *   Anything else thrown is a harness defect (H-8), never a test failure.
 */
export async function checkProperty<T>(
  name: string,
  generator: Gen<T>,
  property: (value: T) => void | Promise<void>,
  options: PropertyOptions<T> = {},
): Promise<void> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("checkProperty: name must be a non-empty string");
  }
  const runs = options.runs ?? DEFAULT_RUNS_PER_SEED;
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(
      `property ${JSON.stringify(name)}: runs must be a positive integer, got ${String(options.runs)}`,
    );
  }
  const maxShrinkExecutions =
    options.maxShrinkExecutions ?? DEFAULT_MAX_SHRINK_EXECUTIONS;
  if (!Number.isInteger(maxShrinkExecutions) || maxShrinkExecutions < 0) {
    throw new Error(
      `property ${JSON.stringify(name)}: maxShrinkExecutions must be a non-negative integer, got ${String(options.maxShrinkExecutions)}`,
    );
  }
  if (options.seeds !== undefined) validateSeeds(name, options.seeds);
  const env = options.env ?? process.env;
  const report =
    options.report ??
    ((line: string) => {
      console.info(line);
    });
  const entropy = options.entropy ?? Math.random;

  const plan = resolveSeedPlan({
    name,
    configSeeds: options.seeds,
    env,
    entropy,
  });
  if (plan.mode === "randomized") {
    // E-5: the randomized local mode reports its seeds, so any observed
    // behavior — failing or passing — can be replayed.
    for (const seed of plan.seeds) {
      report(
        `property ${JSON.stringify(name)}: randomized mode, seed ${String(seed)} — ` +
          `reproduce with ${PROPERTY_SEED_ENV}=${String(seed)}`,
      );
    }
  }

  for (const seed of plan.seeds) {
    const rng = new Mulberry32(seed);
    for (let trial = 1; trial <= runs; trial += 1) {
      let generated: Trial<T>;
      try {
        generated = generateTrial(generator, rng);
      } catch (error) {
        throw harnessError({
          name,
          seed,
          phase: `generating trial ${String(trial)} of ${String(runs)}`,
          cause: error,
        });
      }
      try {
        await property(generated.value);
        continue;
      } catch (error) {
        if (!(error instanceof HarnessAssertionError)) {
          throw harnessError({
            name,
            seed,
            phase: `running trial ${String(trial)} of ${String(runs)}`,
            cause: error,
            renderedInput: renderValue(generated.value, options.render),
          });
        }
        const shrunk = await shrinkFalsification(
          generator,
          property,
          { trial: generated, error },
          maxShrinkExecutions,
          { name, seed, render: options.render },
        );
        throw new PropertyFalsifiedError({
          propertyName: name,
          seed,
          trial,
          runs,
          value: shrunk.final.trial.value,
          initialValue: generated.value,
          renderedValue: renderValue(shrunk.final.trial.value, options.render),
          renderedInitialValue: renderValue(generated.value, options.render),
          assertionMessage: shrunk.final.error.message,
          shrinkSteps: shrunk.steps,
          shrinkExecutions: shrunk.executions,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Seeded generation: PRNG, choice source, trials.

/**
 * mulberry32 — 32-bit PRNG over exact integer operations (Math.imul, shifts),
 * so streams are identical on every platform and run (H-10).
 */
class Mulberry32 {
  #state: number;

  constructor(seed: number) {
    // validateSeeds guards public entry points; this is a final backstop.
    if (!Number.isInteger(seed) || seed < 0 || seed > MAX_UINT32) {
      throw new Error(
        `seed must be an unsigned 32-bit integer, got ${String(seed)}`,
      );
    }
    this.#state = seed >>> 0;
  }

  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [0, maxInclusive] (maxInclusive <= 2^32 - 1). */
  uintInclusive(maxInclusive: number): number {
    if (maxInclusive === 0) return 0;
    if (maxInclusive === MAX_UINT32) return this.nextUint32();
    return this.nextUint32() % (maxInclusive + 1);
  }

  /** Uniform in [0, 1). */
  fraction(): number {
    return this.nextUint32() / TWO_POW_32;
  }
}

/**
 * Internal control flow only: a shrink candidate tape that cannot replay
 * through the generator (exhausted, or an entry exceeding its draw's bound).
 * The shrinker discards such candidates; this never escapes the module.
 */
class ReplayUnsatisfiable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReplayUnsatisfiable";
  }
}

/** One generated trial: the recorded tape and the value it produces. */
interface Trial<T> {
  readonly tape: readonly number[];
  readonly value: T;
}

class ChoiceSource implements Choices {
  readonly #rng: Mulberry32 | null;
  readonly #forced: readonly number[] | null;
  readonly #tape: number[] = [];
  #cursor = 0;
  #finished = false;

  private constructor(
    rng: Mulberry32 | null,
    forced: readonly number[] | null,
  ) {
    this.#rng = rng;
    this.#forced = forced;
  }

  static recording(rng: Mulberry32): ChoiceSource {
    return new ChoiceSource(rng, null);
  }

  static replaying(tape: readonly number[]): ChoiceSource {
    return new ChoiceSource(null, tape);
  }

  /** Freeze the source and return the consumed tape. */
  finish(): readonly number[] {
    this.#finished = true;
    return Object.freeze([...this.#tape]);
  }

  intInclusive(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new Error(
        `intInclusive: bounds must be safe integers with min <= max, got [${String(min)}, ${String(max)}]`,
      );
    }
    const span = max - min;
    if (span > MAX_UINT32) {
      throw new Error(
        `intInclusive: span must be at most 2^32 - 1, got [${String(min)}, ${String(max)}]`,
      );
    }
    return min + this.#draw(span, (rng) => rng.uintInclusive(span));
  }

  boolean(probabilityTrue = 0.5): boolean {
    if (
      typeof probabilityTrue !== "number" ||
      !Number.isFinite(probabilityTrue) ||
      probabilityTrue < 0 ||
      probabilityTrue > 1
    ) {
      throw new Error(
        `boolean: probabilityTrue must be a number in [0, 1], got ${String(probabilityTrue)}`,
      );
    }
    return (
      this.#draw(1, (rng) => (rng.fraction() < probabilityTrue ? 1 : 0)) === 1
    );
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("pick: items must be non-empty");
    }
    const index = this.#draw(items.length - 1, (rng) =>
      rng.uintInclusive(items.length - 1),
    );
    return items[index];
  }

  weightedPick<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    if (entries.length === 0) {
      throw new Error("weightedPick: entries must be non-empty");
    }
    for (const [weight] of entries) {
      if (
        typeof weight !== "number" ||
        !Number.isFinite(weight) ||
        weight <= 0
      ) {
        throw new Error(
          `weightedPick: weights must be finite and positive, got ${String(weight)}`,
        );
      }
    }
    const index = this.#draw(entries.length - 1, (rng) => {
      const total = entries.reduce((sum, [weight]) => sum + weight, 0);
      let remaining = rng.fraction() * total;
      for (let i = 0; i < entries.length; i += 1) {
        remaining -= entries[i][0];
        if (remaining < 0) return i;
      }
      return entries.length - 1;
    });
    return entries[index][1];
  }

  /**
   * Record one choice in [0, maxInclusive]. Replay forces the tape's next
   * entry (out of range or exhausted: the candidate is unsatisfiable);
   * recording samples — non-uniform draws sample however they like but store
   * a plain value, so replay and shrinking treat every draw identically.
   */
  #draw(maxInclusive: number, sample: (rng: Mulberry32) => number): number {
    if (this.#finished) {
      throw new Error(
        "choice drawn after the generator returned — generators must do all drawing synchronously before returning (Gen<T>)",
      );
    }
    if (this.#forced !== null) {
      if (this.#cursor >= this.#forced.length) {
        throw new ReplayUnsatisfiable("tape exhausted");
      }
      const forced = this.#forced[this.#cursor];
      if (forced > maxInclusive) {
        throw new ReplayUnsatisfiable("tape entry exceeds the draw's bound");
      }
      this.#cursor += 1;
      this.#tape.push(forced);
      return forced;
    }
    if (this.#tape.length >= TAPE_LIMIT) {
      throw new Error(
        `generator drew more than ${String(TAPE_LIMIT)} choices in one trial — bound the generator (listOf requires max; recursion must be depth-limited)`,
      );
    }
    const rng = this.#rng;
    if (rng === null) {
      throw new Error("unreachable: a choice source has a PRNG or a tape");
    }
    const value = sample(rng);
    if (!Number.isInteger(value) || value < 0 || value > maxInclusive) {
      throw new Error(
        `unreachable: sampled choice ${String(value)} outside [0, ${String(maxInclusive)}]`,
      );
    }
    this.#tape.push(value);
    return value;
  }
}

function generateTrial<T>(generator: Gen<T>, rng: Mulberry32): Trial<T> {
  const source = ChoiceSource.recording(rng);
  const value = generator(source);
  return { tape: source.finish(), value };
}

/**
 * Replay the generator on a candidate tape; null when the candidate is
 * unsatisfiable. The returned tape is the consumed prefix (unread tail
 * dropped), so accepted candidates stay canonical.
 */
function replayTrial<T>(
  generator: Gen<T>,
  tape: readonly number[],
): Trial<T> | null {
  const source = ChoiceSource.replaying(tape);
  let value: T;
  try {
    value = generator(source);
  } catch (error) {
    if (error instanceof ReplayUnsatisfiable) return null;
    throw error;
  }
  return { tape: source.finish(), value };
}

// ---------------------------------------------------------------------------
// Shrinking.

interface Falsification<T> {
  readonly trial: Trial<T>;
  readonly error: HarnessAssertionError;
}

interface ShrinkResult<T> {
  readonly final: Falsification<T>;
  readonly steps: number;
  readonly executions: number;
}

/**
 * Shrink a falsification: sweep block deletion, block zeroing, and per-entry
 * binary-search minimization over the tape until a full sweep accepts
 * nothing or the budget runs out. A candidate is accepted iff it replays to
 * a strictly shortlex-smaller tape (termination) and the property rejects
 * its value with a `HarnessAssertionError` again. Fully deterministic for a
 * deterministic property (E-5).
 */
async function shrinkFalsification<T>(
  generator: Gen<T>,
  property: (value: T) => void | Promise<void>,
  initial: Falsification<T>,
  maxExecutions: number,
  context: {
    readonly name: string;
    readonly seed: number;
    readonly render: ((value: T) => string) | undefined;
  },
): Promise<ShrinkResult<T>> {
  let current = initial;
  let steps = 0;
  let executions = 0;
  let replays = 0;

  const exhausted = (): boolean =>
    executions >= maxExecutions || replays >= REPLAY_LIMIT;

  /** Try one candidate tape; true iff accepted (current updated). */
  const attempt = async (candidate: readonly number[]): Promise<boolean> => {
    if (exhausted()) return false;
    replays += 1;
    const replayed = replayTrial(generator, candidate);
    if (replayed === null) return false;
    if (!shortlexLess(replayed.tape, current.trial.tape)) return false;
    executions += 1;
    try {
      await property(replayed.value);
      return false;
    } catch (error) {
      if (!(error instanceof HarnessAssertionError)) {
        // The body crashed on a shrunk input: a harness defect (H-8) — always
        // surfaced, never swallowed into "candidate rejected".
        throw harnessError({
          name: context.name,
          seed: context.seed,
          phase:
            "shrinking (the property threw a non-assertion error on a shrunk input)",
          cause: error,
          renderedInput: renderValue(replayed.value, context.render),
        });
      }
      current = { trial: replayed, error };
      steps += 1;
      return true;
    }
  };

  let improved = true;
  while (improved && !exhausted()) {
    improved = false;

    // Pass 1: delete blocks (largest first), scanning from the tail.
    for (const block of SHRINK_DELETE_BLOCKS) {
      for (
        let i = current.trial.tape.length - block;
        i >= 0;
        i = Math.min(i - 1, current.trial.tape.length - block)
      ) {
        const tape = current.trial.tape;
        const candidate = [...tape.slice(0, i), ...tape.slice(i + block)];
        if (await attempt(candidate)) improved = true;
        if (exhausted()) break;
      }
    }

    // Pass 2: zero blocks.
    for (const block of SHRINK_ZERO_BLOCKS) {
      for (
        let i = current.trial.tape.length - block;
        i >= 0;
        i = Math.min(i - 1, current.trial.tape.length - block)
      ) {
        const tape = current.trial.tape;
        if (tape.slice(i, i + block).every((entry) => entry === 0)) continue;
        const candidate = [...tape];
        candidate.fill(0, i, i + block);
        if (await attempt(candidate)) improved = true;
        if (exhausted()) break;
      }
    }

    // Pass 3: binary-search each entry toward 0. Acceptance rewrites the
    // current tape (possibly shorter via replay trimming), so bounds re-read
    // it every step.
    for (let i = 0; i < current.trial.tape.length && !exhausted(); i += 1) {
      const tryEntry = async (value: number): Promise<boolean> => {
        const tape = current.trial.tape;
        if (i >= tape.length || value >= tape[i]) return false;
        const candidate = [...tape];
        candidate[i] = value;
        return attempt(candidate);
      };
      if (current.trial.tape[i] === 0) continue;
      if (await tryEntry(0)) {
        improved = true;
        continue;
      }
      let low = 0; // Largest value known rejected as a replacement.
      while (
        i < current.trial.tape.length &&
        current.trial.tape[i] - low > 1 &&
        !exhausted()
      ) {
        const mid = low + Math.floor((current.trial.tape[i] - low) / 2);
        if (await tryEntry(mid)) {
          improved = true; // Accepted: entry i is now mid.
        } else {
          low = mid;
        }
      }
    }
  }

  return { final: current, steps, executions };
}

/** Strict shortlex order: shorter first, then lexicographic. */
function shortlexLess(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reporting.

function validateSeeds(name: string, seeds: readonly number[]): void {
  if (seeds.length === 0) {
    throw new Error(
      `property ${JSON.stringify(name)}: the seed set must be non-empty`,
    );
  }
  for (const seed of seeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed > MAX_UINT32) {
      throw new Error(
        `property ${JSON.stringify(name)}: seeds must be unsigned 32-bit integers, got ${String(seed)}`,
      );
    }
  }
}

function harnessError(details: {
  readonly name: string;
  readonly seed: number;
  readonly phase: string;
  readonly cause: unknown;
  readonly renderedInput?: string;
}): Error {
  const input =
    details.renderedInput === undefined
      ? ""
      : `\n  input: ${details.renderedInput}`;
  return new Error(
    `property ${JSON.stringify(details.name)}: harness error while ${details.phase} with seed ${String(details.seed)} — ` +
      `a defect in the harness, not a diagnosed assertion failure (H-8): ${describeCause(details.cause)}${input}\n` +
      `  reproduce with ${PROPERTY_SEED_ENV}=${String(details.seed)}`,
    { cause: details.cause },
  );
}

function describeCause(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause);
}

function renderValue<T>(
  value: T,
  render: ((value: T) => string) | undefined,
): string {
  let text: string;
  try {
    text =
      render !== undefined
        ? render(value)
        : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  if (text.length > RENDER_LIMIT) {
    return `${text.slice(0, RENDER_LIMIT)}… (${String(text.length)} chars total)`;
  }
  return text;
}

function indentContinuationLines(message: string): string {
  return message.split("\n").join("\n  ");
}
