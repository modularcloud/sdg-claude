// TEST-SPEC §16 P-8 (parser robustness) — PROP-06.
//
// One registered product-facing fuzz test (C-2 "one code path"): a seeded,
// reproducible generator (helpers/property.ts, H-10; fixed seed set in CI,
// E-5) mutates the byte content of a small valid workspace — MDX spec
// sources, a code-group TypeScript file, and `xspec.config.ts` — and drives
// the SPEC 12 command surface over the result, asserting only the robustness
// contract P-8 states, never any parse verdict:
//
//   * every command terminates — operationalized by the subprocess driver's
//     hang guard (helpers/subprocess.ts): a run killed by the per-invocation
//     timeout or by the runaway-output cap is converted into a *diagnosed
//     assertion failure* (H-8), because termination is this property's
//     assertion, not merely its harness hygiene;
//   * a command never dies by signal and always exits 0, 1, or 2 — the
//     SPEC 12.0 exit-code partition ("exit codes partition all outcomes");
//   * under `--json`, stdout is never a partial JSON document: exit 0/1
//     emits exactly one JSON document as the entire stdout, and exit 2 emits
//     byte-empty stdout (SPEC 12.0; the shared `assertJsonOutputConvention`,
//     H-5);
//   * a failing `build` — exit 1 or exit 2 — modifies nothing: the whole
//     workspace tree, prior derived files and graph data included, is
//     byte-identical around the invocation (SPEC 12.1, H-4; snapshot
//     machinery from helpers/snapshot.ts, as T12.1-4 asserts
//     deterministically).
//
// Staging: each trial creates the fixed base workspace, runs one staging
// `build` (expected exit 0 — the base is SPEC-valid by construction), so the
// workspace holds prior derived state (generated modules, emitted Markdown,
// graph data) for the modifies-nothing arm; then the trial's mutations are
// written over the sources/config, and the command sweep runs: the fixed
// `build --json` arm first, then the trial's drawn commands. Mutations never
// touch derived or durable files — P-8's input space is "mutated
// MDX/TS/config" (corrupt stored state is 13.4/P-9 territory).
//
// The mutation menu covers every input class P-8 names, each applied at a
// drawn offset of a drawn file (mutations stack, 1–3 per trial, applied
// against the evolving bytes at generation time so replay and shrinking
// re-derive identical staged bytes, H-10):
//
//   * splice     — insert/delete short runs of boundary bytes (MDX/TS
//                  structural ASCII, control bytes, UTF-8 lead/continuation
//                  bytes) — "mutated MDX/TS/config";
//   * invalidUtf8 — canned ill-formed sequences (lone continuation, overlong
//                  encoding, truncated multi-byte, surrogate encoding, 0xFF,
//                  lead byte at EOF);
//   * bom        — UTF-8 BOM at offset 0 or mid-file; UTF-16LE/BE BOMs at
//                  offset 0 (making the tail ill-formed UTF-8 in context);
//   * terminators — pathological line terminators: every LF rewritten to a
//                  drawn sequence (CR, CRLF, CRCRLF, LFCR, doubled LF, NEL
//                  U+0085, LS U+2028 — the two encoded as UTF-8), a run of
//                  1–64 terminator sequences inserted at an offset, or a
//                  lone CR appended at EOF;
//   * nesting    — giant nesting (depth 512 / 2048 / 4096): balanced or
//                  unbalanced `<S id="g">` towers for `.mdx` targets,
//                  balanced parenthesis or unbalanced bracket towers for TS
//                  targets, appended to or replacing the file;
//   * truncate   — the file cut at a drawn byte offset (mid-construct,
//                  mid-code-point);
//   * shuffle    — a drawn byte range removed and reinserted at a drawn
//                  position (closers before openers, headers displaced);
//   * garbage    — the whole file replaced by 0–64 uniformly drawn bytes.
//
// The command sweep spans the SPEC 12 surface: `build` (both output forms —
// the human form via the drawn menu), `check`, `ids`, `show`, all five
// `query` subcommands, `coverage`, `impact --base` (no repository is staged:
// an unreadable baseline is itself an exit-2 outcome, 6.3/12.0), `review`
// reads and `review create`, `rename`, and file-form `move`. Mutating
// commands may legitimately succeed and modify the workspace when the
// mutations happen to be benign — P-8 constrains their termination, exit
// class, and JSON form only; the modifies-nothing arm is `build`'s
// (SPEC 12.1). An implementation-time dry-run over the committed default
// seeds at the registered 12 runs per seed verified that every menu entry,
// every mutation kind, and every mutation target occurs — giant MDX section
// towers (depths 512 and 2048), all three BOM flavors, and a mid-file BOM
// included — so the CI-pinned trial set (E-5) exercises the full surface
// deterministically, with staged files bounded (~32 KiB max).
//
// P-8 is outside every CERTIFICATIONS.md fixture scope (its preamble: "P-8
// sweeps every command, exceeding any narrow conformer scope"), so this body
// binds only to the real product surface.

import { Buffer } from "node:buffer";
import { assertJsonOutputConvention, fail } from "../../helpers/assertions.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty, listOf } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding, RunResult } from "../../helpers/subprocess.js";
import {
  ProductRunOutputOverflowError,
  ProductRunTimeoutError,
  runProduct,
} from "../../helpers/subprocess.js";
import {
  assertSnapshotsEqual,
  snapshotDirectory,
} from "../../helpers/snapshot.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk } from "./support.js";

// ---------------------------------------------------------------------------
// The base workspace: small, SPEC-valid, covering the three parse surfaces
// P-8 mutates — MDX spec sources (imports, nesting, tags, `d` references,
// embeddings, an own-line comment), a code-group TypeScript consumer, and
// the declarative configuration (spec group + code group + Markdown
// emission, SPEC 7), so a successful staging `build` leaves generated
// modules, emitted Markdown, and graph data as prior derived state.

const BASE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  markdown: { emit: true }
})
`;

const BASE_SPEC_A = [
  '<S id="a" tags="t1 t2">',
  "Alpha behavior line one.",
  "",
  '<S id="a.b">',
  "Beta behavior detail.",
  "</S>",
  "</S>",
  "",
  "{/* an own-line comment */}",
  "",
  '<S id="c" d={["a"]} coverage="none">',
  'Gamma consumes {text("a.b")} inline.',
  "</S>",
  "",
].join("\n");

const BASE_SPEC_B = [
  'import A from "./A.xspec"',
  "",
  '<S id="b" d={[A.a]}>',
  "Bravo builds on {text(A.c)} downstream.",
  "</S>",
  "",
].join("\n");

const BASE_CODE = [
  'import SPEC, { text } from "../specs/A.xspec";',
  "",
  "export const alpha: string = text(SPEC.a);",
  "",
].join("\n");

/** The mutable surface: exactly the files whose bytes trials fuzz. */
const BASE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["xspec.config.ts", BASE_CONFIG],
  ["specs/A.mdx", BASE_SPEC_A],
  ["specs/B.mdx", BASE_SPEC_B],
  ["src/app.ts", BASE_CODE],
];

const MUTATION_TARGETS: readonly string[] = BASE_FILES.map(([path]) => path);

// ---------------------------------------------------------------------------
// The command menu (SPEC 12 surface). Every entry is drawn by trials; the
// fixed `build --json` arm runs on every trial in addition. Argument values
// name base-workspace nodes/files — after mutation they may no longer exist,
// which is itself a legitimate exit-2 outcome (12.0: unknown node identities
// or files named in arguments are usage errors). Entries are data, never
// interpreted by a shell (H-2).

const COMMAND_MENU: ReadonlyArray<readonly string[]> = [
  ["build"],
  ["check", "--json"],
  ["check"],
  ["ids", "--json"],
  ["ids", "--tree"],
  ["show", "specs/A.mdx#a"],
  ["show", "specs/A.mdx"],
  ["query", "node", "specs/A.mdx#a.b", "--json"],
  ["query", "nodes", "--json"],
  ["query", "edges", "--json"],
  ["query", "subtree", "specs/A.mdx#a", "--json"],
  ["query", "ancestors", "specs/A.mdx#a.b", "--json"],
  ["coverage", "--json"],
  ["coverage"],
  ["impact", "--base", "HEAD", "--json"],
  ["review", "list", "--json"],
  ["review", "create", "--strategy", "audit", "--name", "r1", "--json"],
  ["review", "next", "r1", "--json"],
  ["rename", "specs/A.mdx", "c", "c2", "--json"],
  ["move", "specs/B.mdx", "specs/moved.mdx", "--json"],
];

// ---------------------------------------------------------------------------
// Mutations. Each apply function is pure (bytes in, bytes out) and draws all
// of its parameters through `Choices`, so identical tapes re-derive identical
// staged bytes on replay and during shrinking (H-10).

/**
 * Splice-insert alphabet: MDX/TS structural ASCII, whitespace/control bytes,
 * and UTF-8 lead/continuation boundary bytes. Plain letter first (the shrink
 * target).
 */
const SPLICE_BYTES: readonly number[] = [
  0x61, // "a"
  0x3c, // "<"
  0x3e, // ">"
  0x7b, // "{"
  0x7d, // "}"
  0x2f, // "/"
  0x5c, // "\"
  0x22, // '"'
  0x27, // "'"
  0x60, // "`"
  0x3d, // "="
  0x23, // "#"
  0x28, // "("
  0x29, // ")"
  0x5b, // "["
  0x5d, // "]"
  0x0a, // LF
  0x0d, // CR
  0x09, // TAB
  0x00, // NUL
  0x01, // SOH
  0x1b, // ESC
  0x7f, // DEL
  0x80, // continuation byte
  0xbf, // continuation byte
  0xc0, // overlong lead
  0xc2, // 2-byte lead
  0xe2, // 3-byte lead
  0xef, // 3-byte lead (BOM lead)
  0xf0, // 4-byte lead
  0xfe, // never valid in UTF-8
  0xff, // never valid in UTF-8
];

/** Canned ill-formed UTF-8 sequences (see the module header). */
const INVALID_UTF8_SEQUENCES: ReadonlyArray<readonly number[]> = [
  [0x80], // lone continuation byte
  [0xbf], // lone continuation byte
  [0xc0, 0xaf], // overlong "/"
  [0xe2, 0x82], // truncated 3-byte sequence
  [0xed, 0xa0, 0x80], // encoded UTF-16 surrogate U+D800
  [0xf5, 0x80, 0x80, 0x80], // lead byte above U+10FFFF
  [0xff], // never valid
  [0xc2], // lead byte with no continuation
];

const UTF8_BOM: readonly number[] = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM: readonly number[] = [0xff, 0xfe];
const UTF16BE_BOM: readonly number[] = [0xfe, 0xff];

/** Line-terminator sequences LF is rewritten to / runs are built from. */
const TERMINATOR_SEQUENCES: ReadonlyArray<
  readonly [string, readonly number[]]
> = [
  ["CR", [0x0d]],
  ["CRLF", [0x0d, 0x0a]],
  ["CRCRLF", [0x0d, 0x0d, 0x0a]],
  ["LFCR", [0x0a, 0x0d]],
  ["LFLF", [0x0a, 0x0a]],
  ["NEL", [0xc2, 0x85]], // U+0085 as UTF-8
  ["LS", [0xe2, 0x80, 0xa8]], // U+2028 as UTF-8
];

// Every nesting draw is genuinely giant (P-8 "giant nesting"); the smallest
// entry first so counterexamples shrink toward the shallowest tower.
const NESTING_DEPTHS: readonly number[] = [512, 2048, 4096];

function spliceBytes(
  bytes: Uint8Array,
  offset: number,
  deleteCount: number,
  insert: readonly number[],
): Uint8Array {
  const out = new Uint8Array(bytes.length - deleteCount + insert.length);
  out.set(bytes.subarray(0, offset), 0);
  out.set(insert, offset);
  out.set(bytes.subarray(offset + deleteCount), offset + insert.length);
  return out;
}

function renderBytes(sequence: readonly number[]): string {
  return sequence
    .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
    .join(" ");
}

/** One mutation: new bytes plus a human-readable description for the log. */
interface MutationResult {
  readonly bytes: Uint8Array;
  readonly description: string;
}

function mutateSplice(choices: Choices, bytes: Uint8Array): MutationResult {
  const offset = choices.intInclusive(0, bytes.length);
  const deleteCount = choices.intInclusive(
    0,
    Math.min(8, bytes.length - offset),
  );
  const insert = listOf((c: Choices) => c.pick(SPLICE_BYTES), { max: 8 })(
    choices,
  );
  return {
    bytes: spliceBytes(bytes, offset, deleteCount, insert),
    description:
      `splice at ${String(offset)}: delete ${String(deleteCount)}, ` +
      `insert [${renderBytes(insert)}]`,
  };
}

function mutateInvalidUtf8(
  choices: Choices,
  bytes: Uint8Array,
): MutationResult {
  const sequence = choices.pick(INVALID_UTF8_SEQUENCES);
  const offset = choices.intInclusive(0, bytes.length);
  return {
    bytes: spliceBytes(bytes, offset, 0, sequence),
    description: `insert ill-formed UTF-8 [${renderBytes(sequence)}] at ${String(offset)}`,
  };
}

function mutateBom(choices: Choices, bytes: Uint8Array): MutationResult {
  const [name, bom, atStartOnly] = choices.pick([
    ["UTF-8 BOM", UTF8_BOM, false] as const,
    ["UTF-16LE BOM", UTF16LE_BOM, true] as const,
    ["UTF-16BE BOM", UTF16BE_BOM, true] as const,
  ]);
  const offset =
    atStartOnly || !choices.boolean(0.4)
      ? 0
      : choices.intInclusive(0, bytes.length);
  return {
    bytes: spliceBytes(bytes, offset, 0, bom),
    description: `insert ${name} at ${String(offset)}`,
  };
}

function mutateTerminators(
  choices: Choices,
  bytes: Uint8Array,
): MutationResult {
  const mode = choices.pick(["replaceAll", "insertRun", "appendCr"] as const);
  if (mode === "appendCr") {
    return {
      bytes: spliceBytes(bytes, bytes.length, 0, [0x0d]),
      description: "append a lone CR at EOF",
    };
  }
  const [name, sequence] = choices.pick(TERMINATOR_SEQUENCES);
  if (mode === "insertRun") {
    const offset = choices.intInclusive(0, bytes.length);
    const count = 1 + choices.intInclusive(0, 63);
    const run: number[] = [];
    for (let i = 0; i < count; i += 1) run.push(...sequence);
    return {
      bytes: spliceBytes(bytes, offset, 0, run),
      description: `insert a run of ${String(count)} ${name} terminator(s) at ${String(offset)}`,
    };
  }
  const out: number[] = [];
  for (const byte of bytes) {
    if (byte === 0x0a) out.push(...sequence);
    else out.push(byte);
  }
  return {
    bytes: Uint8Array.from(out),
    description: `rewrite every LF to ${name}`,
  };
}

function mutateNesting(
  choices: Choices,
  bytes: Uint8Array,
  path: string,
): MutationResult {
  const depth = choices.pick(NESTING_DEPTHS);
  const balanced = choices.boolean(0.6);
  const replace = choices.boolean(0.3);
  let tower: string;
  let shape: string;
  if (path.endsWith(".mdx")) {
    shape = balanced ? "balanced section tower" : "unclosed section tower";
    tower = balanced
      ? `${'<S id="g">\n'.repeat(depth)}deep.\n${"</S>\n".repeat(depth)}`
      : '<S id="g">\n'.repeat(depth);
  } else {
    shape = balanced
      ? "balanced parenthesis tower"
      : "unbalanced bracket tower";
    tower = balanced
      ? `const zz = ${"(".repeat(depth)}1${")".repeat(depth)}\n`
      : `const zz = ${"[".repeat(depth)}\n`;
  }
  const towerBytes = Buffer.from(tower, "utf8");
  const out = replace
    ? Uint8Array.from(towerBytes)
    : spliceBytes(bytes, bytes.length, 0, [...towerBytes]);
  return {
    bytes: out,
    description:
      `${replace ? "replace with" : "append"} a depth-${String(depth)} ` +
      `${shape}`,
  };
}

function mutateTruncate(choices: Choices, bytes: Uint8Array): MutationResult {
  const keep = choices.intInclusive(0, bytes.length);
  return {
    bytes: bytes.slice(0, keep),
    description: `truncate to the first ${String(keep)} byte(s)`,
  };
}

function mutateShuffle(choices: Choices, bytes: Uint8Array): MutationResult {
  if (bytes.length < 2) {
    // Degenerate file: nothing to displace — fall back to a splice.
    return mutateSplice(choices, bytes);
  }
  const start = choices.intInclusive(0, bytes.length - 1);
  const end = choices.intInclusive(start + 1, bytes.length);
  const slice = bytes.slice(start, end);
  const removed = spliceBytes(bytes, start, end - start, []);
  const at = choices.intInclusive(0, removed.length);
  return {
    bytes: spliceBytes(removed, at, 0, [...slice]),
    description: `move bytes [${String(start)}, ${String(end)}) to ${String(at)}`,
  };
}

function mutateGarbage(choices: Choices, bytes: Uint8Array): MutationResult {
  void bytes;
  const garbage = listOf((c: Choices) => c.intInclusive(0, 255), { max: 64 })(
    choices,
  );
  return {
    bytes: Uint8Array.from(garbage),
    description: `replace the whole file with ${String(garbage.length)} drawn byte(s)`,
  };
}

type Mutator = (
  choices: Choices,
  bytes: Uint8Array,
  path: string,
) => MutationResult;

/** Simplest-first (weightedPick shrinks toward the first entry). */
const MUTATION_KINDS: ReadonlyArray<readonly [number, Mutator]> = [
  [5, (c, b) => mutateSplice(c, b)],
  [3, (c, b) => mutateInvalidUtf8(c, b)],
  [2, (c, b) => mutateBom(c, b)],
  [3, (c, b) => mutateTerminators(c, b)],
  [2, mutateNesting],
  [2, (c, b) => mutateTruncate(c, b)],
  [2, (c, b) => mutateShuffle(c, b)],
  [2, (c, b) => mutateGarbage(c, b)],
];

// ---------------------------------------------------------------------------
// Trial generation

/** One generated trial: final staged bytes, a log, and drawn commands. */
export interface FuzzTrial {
  /** Staged bytes per workspace-relative path (base files + mutations). */
  readonly files: ReadonlyArray<readonly [string, Uint8Array]>;
  /** Human-readable description of each applied mutation. */
  readonly mutations: readonly string[];
  /** Drawn command invocations, run after the fixed `build --json` arm. */
  readonly commands: ReadonlyArray<readonly string[]>;
}

/** The P-8 trial generator (see the module header). */
export const genFuzzTrial: Gen<FuzzTrial> = (choices) => {
  const files = new Map<string, Uint8Array>(
    BASE_FILES.map(([path, text]) => [
      path,
      Uint8Array.from(Buffer.from(text, "utf8")),
    ]),
  );
  const mutations: string[] = [];
  const mutationCount = 1 + choices.intInclusive(0, 2);
  for (let i = 0; i < mutationCount; i += 1) {
    const path = choices.pick(MUTATION_TARGETS);
    const mutate = choices.weightedPick(MUTATION_KINDS);
    const current = files.get(path);
    if (current === undefined) {
      throw new Error(`P-8 harness defect: no staged bytes for ${path}`);
    }
    const result = mutate(choices, current, path);
    files.set(path, result.bytes);
    mutations.push(`${path}: ${result.description}`);
  }
  const commands = listOf((c: Choices) => c.pick(COMMAND_MENU), {
    min: 2,
    max: 4,
  })(choices);
  return { files: [...files.entries()], mutations, commands };
};

/** Counterexample rendering: the mutation log and the drawn commands. */
export function renderFuzzTrial(trial: FuzzTrial): string {
  return JSON.stringify({
    mutations: trial.mutations,
    commands: trial.commands.map((argv) => argv.join(" ")),
  });
}

// ---------------------------------------------------------------------------
// Assertions

/**
 * Per-invocation hang guard for fuzz runs. Purely the H-8 guard bounding the
 * observation "the command terminates" — never an assertion input beyond
 * that (H-10); generously above any plausible parse time for these staged
 * inputs (≤ ~100 KiB per file), and small enough that a falsified
 * termination clause shrinks within the test budget.
 */
const FUZZ_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Run one command over the fuzzed workspace, converting the hang-guard and
 * runaway-output kills — exactly those — into diagnosed assertion failures:
 * P-8's first clause is that every command terminates. Anything else thrown
 * by the driver stays a harness error (H-8).
 */
async function runFuzzCommand(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
): Promise<RunResult> {
  try {
    return await runProduct(product, {
      cwd: workspace.root,
      argv,
      timeoutMs: FUZZ_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ProductRunTimeoutError) {
      fail(
        `P-8: every command must terminate on fuzzed input (TEST-SPEC §16 P-8; ` +
          `SPEC 12.0), but the invocation was still running when the harness's ` +
          `hang guard killed it — ${error.message}`,
      );
    }
    if (error instanceof ProductRunOutputOverflowError) {
      fail(
        `P-8: every command must terminate on fuzzed input with bounded output ` +
          `(TEST-SPEC §16 P-8; SPEC 12.0), but the invocation emitted unbounded ` +
          `output until the harness's runaway-output guard killed it — ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * The 12.0 exit-code partition for a run without `--json`: no signal death,
 * exit code exactly 0, 1, or 2. (`assertJsonOutputConvention` asserts the
 * same partition plus the stdout contract for `--json` runs.)
 */
function assertExitPartition(result: RunResult, context: string): void {
  if (result.signal !== null) {
    fail(
      `${context}: ${result.commandLine} died by signal ${String(result.signal)} ` +
        `instead of exiting — SPEC 12.0 partitions all outcomes into exit ` +
        `codes 0, 1, and 2 (P-8)`,
    );
  }
  if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== 2) {
    fail(
      `${context}: exit code ${String(result.exitCode)} from ${result.commandLine} ` +
        `is outside the SPEC 12.0 partition (0 success, 1 findings, 2 ` +
        `usage/configuration) — P-8: fuzzed input never yields another exit class`,
    );
  }
}

function describeCommand(argv: readonly string[]): string {
  return `\`xspec ${argv.join(" ")}\``;
}

/**
 * Run one command with the P-8 assertions: termination (via
 * `runFuzzCommand`), the 12.0 exit partition, and — when the invocation
 * carries `--json` — the never-a-partial-JSON-document contract. For `build`
 * invocations the modifies-nothing arm rides along: on a non-zero exit the
 * whole workspace tree must be byte-identical around the run (SPEC 12.1).
 */
async function runFuzzArm(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  trial: FuzzTrial,
): Promise<void> {
  const context =
    `P-8 ${describeCommand(argv)} over the fuzzed workspace ` +
    `(mutations: ${JSON.stringify(trial.mutations)})`;
  const isBuild = argv[0] === "build";
  const before = isBuild ? await snapshotDirectory(workspace.root) : undefined;
  const result = await runFuzzCommand(product, workspace, argv);
  if (argv.includes("--json")) {
    assertJsonOutputConvention(result, context);
  } else {
    assertExitPartition(result, context);
  }
  if (before !== undefined && result.exitCode !== 0) {
    const after = await snapshotDirectory(workspace.root);
    assertSnapshotsEqual(
      before,
      after,
      `${context}: a \`build\` failing with exit ${String(result.exitCode)} ` +
        `modifies nothing — every derived file and all graph data remain ` +
        `byte-for-byte as they were (SPEC 12.1; P-8)`,
    );
  }
}

/** The P-8 property body for one trial (see the module header). */
async function runFuzzTrial(
  product: ProductBinding,
  trial: FuzzTrial,
): Promise<void> {
  const workspace = await TestWorkspace.create({
    files: Object.fromEntries(BASE_FILES),
  });
  try {
    // Staging: the base workspace is SPEC-valid; a successful build leaves
    // prior derived state for the modifies-nothing arm.
    await buildOk(
      product,
      workspace,
      "P-8 staging `build` over the valid base workspace (prior derived " +
        "state for the modifies-nothing arm, SPEC 12.1)",
    );
    for (const [path, bytes] of trial.files) {
      await workspace.file(path, bytes);
    }
    await runFuzzArm(product, workspace, ["build", "--json"], trial);
    for (const argv of trial.commands) {
      await runFuzzArm(product, workspace, argv, trial);
    }
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// The registered fuzz test

const P_8 = defineProductTest({
  id: "P-8",
  title:
    "fuzz: over byte-mutated MDX/TS/config (invalid UTF-8, BOMs, giant nesting, " +
    "pathological line terminators), every command terminates, never emits a " +
    "partial JSON document under --json, always exits 0, 1, or 2, and failing " +
    "`build`s modify nothing (SPEC 12.0, 12.1; TEST-SPEC §16 P-8)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), one staging
  // build plus a 3–5 command sweep with per-arm snapshots per trial, plus
  // the shrink budget on falsification.
  timeoutMs: 420_000,
  run: async (product) => {
    await checkProperty(
      "P-8 parser robustness",
      genFuzzTrial,
      async (trial) => {
        await runFuzzTrial(product, trial);
      },
      { runs: 12, maxShrinkExecutions: 100, render: renderFuzzTrial },
    );
  },
});

/** TEST-SPEC §16 P-8 (PROP-06). */
export const section16P8Tests: readonly ProductTestEntry[] = [P_8];
