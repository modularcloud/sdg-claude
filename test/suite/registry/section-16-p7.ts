// TEST-SPEC §16 P-7 (glob and capture matching) — PROP-05.
//
// One registered product-facing property test (C-2 "one code path"): seeded,
// reproducible generators (helpers/property.ts, H-10; fixed seed set in CI,
// E-5) produce random patterns and paths over SPEC 7's glob grammar and SPEC
// 7.5's capture grammar — with the glob metacharacters of common dialects
// (`[` `]` `{` `}` `!` `+` `(` `)`) in both the pattern and the path
// alphabets, and `$` as a discovery-glob literal — and assert that the
// product's match decisions and capture values equal the harness's
// independent spec oracle (helpers/oracles/glob.ts, HARNESS-09), which S-6
// certifies against fixed vectors before any property trusts it
// (test/self/s6-glob-oracle.test.ts).
//
// Two properties under the one P-7 entry, one per black-box channel:
//
//   * P-7 glob matching (discovery). Each trial stages a fresh workspace
//     (H-1) whose one spec group carries 1–2 generated patterns and whose
//     files are candidate paths derived from those patterns (expansions,
//     mutated expansions, and independent random paths — the derivations are
//     heuristics that make matches and near-misses likely; the oracle alone
//     decides the expected outcome of every final staged string). `ids
//     --json` (SPEC 12.3) is the discovery observation, as in T7-4: the
//     listed file set must equal the oracle-matched subset of the staged
//     paths, so a wrong match decision surfaces as an extra or missing
//     listing entry. Every staged path ends in `.mdx` and holds a valid
//     single-section source, so 14.19 never fires and a wrongly discovered
//     path lists cleanly instead of crashing (H-8).
//   * P-7 captures (policy). Capture VALUES are observed through
//     `to`-expansion agreement — the only black-box channel SPEC 7.5 defines
//     (the T7.5-5 protocol): each trial stages code-group source files at
//     paths derived from a generated `from` pattern (capture fillers include
//     the boundary arms: an empty filler and a `/`-containing filler stage
//     paths whose match would need an empty or slash-spanning capture — the
//     oracle refuses both, and the product must agree), spec-group target
//     files under `tgt/` at expansions of a generated `to` pattern under the
//     oracle's captured values and under deliberately mutated values, and
//     one `forbidden` policy rule per generated from/to pair. Every source
//     references every target, so the exact finding set of `check --json`
//     (rule name + offending edge, SPEC 7.5, 14.12) decides, per (rule,
//     source, target) triple, whether the product's from-match, captured
//     tuple, and to-agreement all equal the oracle's.
//
// Uniqueness ("every match is unique under the left-to-right shortest-match
// rule"): the oracle computes exactly the unique shortest-match assignment
// (its S-6 vectors pin SPEC 7.5's worked examples), and the staged target set
// separates that assignment from plausible-but-wrong ones (greedy captures,
// shifted boundaries) whenever the derivations produce a discriminating
// expansion — a product whose captured values differ flags a different
// target set and fails the exact-set comparison. Determinism of the
// disambiguation across repeat runs is T7.5-5's run-twice subject (H-6), not
// re-asserted per trial here.
//
// Staging guards (deliberate input-space constraints, not oracle behavior):
//   * Discovery patterns never match `xspec.config.ts` (the workspace's only
//     non-`.mdx` file — a match would stage 14.19, not a §7 decision) and no
//     pattern segment matches `.xspec` (the graph-data directory a read
//     command may create, SPEC 13.3/13.4); both are repaired deterministically
//     via the oracle, so replay and shrinking reproduce the repaired value.
//     Pattern segments `.` and `..` are repaired away: a pattern resolving
//     outside the workspace root is a configuration error (14.14), not a
//     match decision.
//   * Staged paths never collide with `xspec.config.ts` or root `.xspec/`
//     (first-segment repairs), never contain `.`/`..`/empty segments (not
//     stageable), and never contain `"`, `\`, or whitespace (the alphabets
//     omit them: patterns and paths are embedded as static string literals in
//     the configuration, SPEC 2.4/7, and the staging delimiter must not be
//     the subject).
//   * Capture-side sources and targets are discovered through literal
//     path-globs (a pattern with no active metacharacter always matches
//     exactly its own bytes — the dot rule reads the pattern as written), so
//     the generated policy patterns are the trial's only wildcard matching.
//     For that staging to be sound under SPEC 7 itself, capture-side PATH
//     bytes exclude `*`, `?`, and `$` (a source path `t*t/x.ts` would, as its
//     own literal glob, legitimately match under `tgt/` and could collide
//     with the spec group, 14.14) — the foreign-dialect metacharacters stay,
//     probing literal-ness through the config→discovery channel too. Source
//     paths never start with `tgt` (the target namespace: keeps spec and
//     code groups file-disjoint, 7.2) and never contain `.xspec.` (never a
//     product-written derived path, 13.4). Targets end in `.mdx` (7.1).
//   * The é byte-semantics arms (a two-byte code point that `?` — one byte —
//     must refuse, SPEC 7) stage non-ASCII file names and are gated to the
//     Linux leg exactly as T7-4's: Linux file names are byte strings, so the
//     staged bytes reach the matcher verbatim; other platforms' filesystems
//     may normalize or re-case names. The gate is constant per machine, so
//     the suite stays deterministic across consecutive runs (E-5).
//   * A rejected capture-side `to` never references an index absent from its
//     `from` and a `from` never repeats an index (both 14.14 configuration
//     errors, not match decisions): capture tokens are injected from a
//     managed distinct-index set and `$` is absent from the capture-side
//     literal alphabets, so no accidental `$<digit>` can form.
//
// The capture-side protocol follows T7.5-4/T7.5-5: `build` first (exit 0 —
// sources are valid by construction and build does not evaluate policy, SPEC
// 12.1), then `check --json`, whose findings are exactly the staged policy
// violations (no 14.10 staleness contamination), asserted as an exact 14.12
// condition count plus the exact (rule, offending edge) pair set.
//
// P-7 is outside every CERTIFICATIONS.md fixture scope (its Exclusions: the
// capture half requires policy machinery out of any lean scope; the glob
// half's staging hazard is certified through CONF-DISC on T7-4), so this body
// binds only to the real product surface: `ids`, `build`, `check` (SPEC 12),
// decoded through the H-3 adapters.

import { Buffer } from "node:buffer";
import type { Finding } from "../../helpers/adapters/index.js";
import {
  decodeFindingsReport,
  decodeIdsReport,
} from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import {
  globMatches,
  matchFromPattern,
  matchToPattern,
} from "../../helpers/oracles/glob.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertSameJson,
  buildOk,
  expectExit,
  runCli,
} from "./support.js";

// ---------------------------------------------------------------------------
// Alphabets and the platform gate
// ---------------------------------------------------------------------------

// Module-header gate: non-ASCII path bytes are staged on Linux only (T7-4's
// precedent). Constant per machine, so trials are deterministic per machine
// (E-5); the byte-vs-character discrimination needs a multi-byte file name.
const LINUX_BYTE_PROBES = process.platform === "linux";

// U+00E9 é — two UTF-8 bytes (0xC3 0xA9), one character: `?` (one byte) must
// not match it; `*` and `??` must (SPEC 7 byte-wise matching).
const E_ACUTE = "é";

type Weighted = ReadonlyArray<readonly [number, string]>;

/** Append the Linux-only é entry to a weighted alphabet. */
function withByteProbe(entries: Weighted, weight: number): Weighted {
  return LINUX_BYTE_PROBES ? [...entries, [weight, E_ACUTE]] : entries;
}

// Literal characters for PATTERN segments (discovery and policy patterns
// alike). No `*`/`?` (those are explicit tokens), no `$` (a capture wildcard
// in policy patterns — added back for discovery globs only, where SPEC 7.5
// confines captures to policy `files` selectors and `$` is an ordinary
// literal), no `/` (the separator), no `"`/`\` (staging delimiters, module
// header). Order simplest-first: weightedPick shrinks toward the first entry.
const PATTERN_LITERAL_ALPHABET: Weighted = withByteProbe(
  [
    [16, "a"],
    [5, "b"],
    [3, "z"],
    [4, "A"],
    [3, "0"],
    [2, "9"],
    [3, "-"],
    [2, "_"],
    [5, "."],
    // Foreign-dialect glob metacharacters — SPEC 7 literals (P-7 names them).
    [2, "["],
    [2, "]"],
    [2, "{"],
    [2, "}"],
    [2, "!"],
    [2, "+"],
    [2, "("],
    [2, ")"],
  ],
  2,
);

/** Discovery globs additionally use `$` as an ordinary literal (SPEC 7.5). */
const DISCOVERY_PATTERN_LITERAL_ALPHABET: Weighted = [
  ...PATTERN_LITERAL_ALPHABET,
  [2, "$"],
];

// Path-segment characters for the discovery property: everything above plus
// the active metacharacters as PATH bytes (`*`, `?`, `$` are legal file-name
// bytes; a product reading path bytes as pattern bytes trips here).
const DISCOVERY_PATH_ALPHABET: Weighted = [
  ...DISCOVERY_PATTERN_LITERAL_ALPHABET,
  [2, "*"],
  [2, "?"],
];

// Path-segment characters for the capture property: no `*`/`?`/`$`, so the
// literal path-globs that stage discovery are metacharacter-free and match
// exactly their own path under SPEC 7 (module header).
const CAPTURE_PATH_ALPHABET: Weighted = PATTERN_LITERAL_ALPHABET;

const pathChar =
  (alphabet: Weighted): Gen<string> =>
  (choices) =>
    choices.weightedPick(alphabet);

/** A path-segment filler of `min`..`max` characters. */
function fillerGen(alphabet: Weighted, min: number, max: number): Gen<string> {
  return (choices) => {
    const length = choices.intInclusive(min, max);
    let out = "";
    for (let i = 0; i < length; i += 1) out += pathChar(alphabet)(choices);
    return out;
  };
}

// ---------------------------------------------------------------------------
// Pattern model: tokens, segments, rendering
// ---------------------------------------------------------------------------

type PatternToken =
  | { readonly kind: "lit"; readonly text: string }
  | { readonly kind: "star" }
  | { readonly kind: "question" }
  | { readonly kind: "capture"; readonly index: number } // `from` patterns
  | { readonly kind: "ref"; readonly index: number }; // `to` patterns

type PatternSeg =
  | { readonly kind: "globstar" }
  | { readonly kind: "tokens"; readonly tokens: readonly PatternToken[] };

function renderToken(token: PatternToken): string {
  switch (token.kind) {
    case "lit":
      return token.text;
    case "star":
      return "*";
    case "question":
      return "?";
    case "capture":
    case "ref":
      return `$${String(token.index)}`;
  }
}

function renderSegment(seg: PatternSeg): string {
  return seg.kind === "globstar" ? "**" : seg.tokens.map(renderToken).join("");
}

function renderPattern(segs: readonly PatternSeg[]): string {
  return segs.map(renderSegment).join("/");
}

/** A token segment of 1..3 tokens over the given literal alphabet. */
function tokenSegmentGen(literalAlphabet: Weighted): Gen<PatternSeg> {
  return (choices) => {
    const count = choices.intInclusive(1, 3);
    const tokens: PatternToken[] = [];
    for (let i = 0; i < count; i += 1) {
      tokens.push(
        choices.weightedPick<PatternToken>([
          [6, { kind: "lit", text: fillerGen(literalAlphabet, 1, 3)(choices) }],
          [3, { kind: "star" }],
          [2, { kind: "question" }],
        ]),
      );
    }
    return { kind: "tokens", tokens };
  };
}

/**
 * Deterministic pattern-segment repairs (module header): `.` and `..`
 * segments get a leading `q` literal (14.14 outside-root hazard), and — when
 * `guardDotXspec` — any segment matching the literal `.xspec` is replaced by
 * the safe dot-initial literal `.q` (SPEC 13.3/13.4 graph-data directory).
 */
function repairPatternSegment(
  seg: PatternSeg,
  guardDotXspec: boolean,
): PatternSeg {
  if (seg.kind === "globstar") return seg;
  const rendered = renderSegment(seg);
  if (rendered === "." || rendered === "..") {
    return {
      kind: "tokens",
      tokens: [{ kind: "lit", text: "q" }, ...seg.tokens],
    };
  }
  if (guardDotXspec && globMatches(rendered, ".xspec")) {
    return { kind: "tokens", tokens: [{ kind: "lit", text: ".q" }] };
  }
  return seg;
}

// ---------------------------------------------------------------------------
// Heuristic path derivation (the oracle alone decides expected outcomes)
// ---------------------------------------------------------------------------

interface FillerArms {
  readonly alphabet: Weighted;
  /** Allow the boundary arms (`/`-containing, dot-initial) in `*` fillers. */
  readonly boundaryArms: boolean;
}

/** A `*` filler: usually 0..2 characters; rare `/` and dot-initial arms. */
function starFiller(choices: Choices, arms: FillerArms): string {
  if (!arms.boundaryArms) return fillerGen(arms.alphabet, 0, 2)(choices);
  return choices.weightedPick<Gen<string>>([
    [7, fillerGen(arms.alphabet, 0, 2)],
    [1, (c) => `${pathChar(arms.alphabet)(c)}/${pathChar(arms.alphabet)(c)}`],
    [1, (c) => `.${pathChar(arms.alphabet)(c)}`],
  ])(choices);
}

/** A `?` filler: one character — on Linux occasionally the two-byte é. */
function questionFiller(choices: Choices, arms: FillerArms): string {
  if (LINUX_BYTE_PROBES && choices.boolean(0.15)) return E_ACUTE;
  return pathChar(arms.alphabet)(choices);
}

/**
 * A capture filler: usually 1..3 characters; boundary arms stage the paths
 * whose match would need an empty capture, a `/`-spanning capture, or a
 * dot-initial captured value (P-7: captures never span `/` or match empty).
 */
function captureFiller(choices: Choices, arms: FillerArms): string {
  return choices.weightedPick<Gen<string>>([
    [6, fillerGen(arms.alphabet, 1, 3)],
    [1, () => ""],
    [1, (c) => `${pathChar(arms.alphabet)(c)}/${pathChar(arms.alphabet)(c)}`],
    [1, (c) => `.${pathChar(arms.alphabet)(c)}`],
  ])(choices);
}

/** A random path segment, occasionally dot-initial (the SPEC 7 dot rule). */
function randomSegment(choices: Choices, alphabet: Weighted): string {
  const body = fillerGen(alphabet, 1, 4)(choices);
  return choices.boolean(0.15) ? `.${body}` : body;
}

/** A random path of 1..3 segments. */
function randomPath(choices: Choices, alphabet: Weighted): string {
  const count = choices.intInclusive(1, 3);
  const segments: string[] = [];
  for (let i = 0; i < count; i += 1) {
    segments.push(randomSegment(choices, alphabet));
  }
  return segments.join("/");
}

/**
 * Expand pattern segments into a candidate path: literals kept, `*`/`?`/
 * captures filled, `**` replaced by 0..2 random whole segments, references
 * expanded from `captures`. Purely heuristic (module header): fillers may
 * inject `/` or dots that flip the oracle's verdict — deliberately.
 */
function expandPattern(
  segs: readonly PatternSeg[],
  choices: Choices,
  arms: FillerArms,
  captures?: ReadonlyMap<number, string>,
): string {
  const parts: string[] = [];
  for (const seg of segs) {
    if (seg.kind === "globstar") {
      const extra = choices.intInclusive(0, 2);
      for (let i = 0; i < extra; i += 1) {
        parts.push(randomSegment(choices, arms.alphabet));
      }
      continue;
    }
    let rendered = "";
    for (const token of seg.tokens) {
      switch (token.kind) {
        case "lit":
          rendered += token.text;
          break;
        case "star":
          rendered += starFiller(choices, arms);
          break;
        case "question":
          rendered += questionFiller(choices, arms);
          break;
        case "capture":
          rendered += captureFiller(choices, arms);
          break;
        case "ref":
          rendered += captures?.get(token.index) ?? "";
          break;
      }
    }
    parts.push(rendered);
  }
  return parts.join("/");
}

/**
 * Mutate a path (one deterministic edit drawn from the choices): case flip,
 * character replacement/insertion/deletion, segment drop/duplication —
 * near-misses for the byte-wise, case-sensitive comparison of SPEC 7.
 */
function mutatePath(
  path: string,
  choices: Choices,
  alphabet: Weighted,
): string {
  const points = [...path];
  const segments = path.split("/");
  type Mutation = () => string;
  const flipCase: Mutation = () => {
    const index = points.findIndex(
      (ch) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"),
    );
    if (index < 0) return path;
    const ch = points[index];
    const flipped = ch >= "a" ? ch.toUpperCase() : ch.toLowerCase();
    return [
      ...points.slice(0, index),
      flipped,
      ...points.slice(index + 1),
    ].join("");
  };
  const replaceChar: Mutation = () => {
    if (points.length === 0) return path;
    const index = choices.intInclusive(0, points.length - 1);
    const ch = pathChar(alphabet)(choices);
    return [...points.slice(0, index), ch, ...points.slice(index + 1)].join("");
  };
  const insertChar: Mutation = () => {
    const index = choices.intInclusive(0, points.length);
    const ch = pathChar(alphabet)(choices);
    return [...points.slice(0, index), ch, ...points.slice(index)].join("");
  };
  const deleteChar: Mutation = () => {
    if (points.length < 2) return path;
    const index = choices.intInclusive(0, points.length - 1);
    return [...points.slice(0, index), ...points.slice(index + 1)].join("");
  };
  const dropSegment: Mutation = () => {
    if (segments.length < 2) return path;
    const index = choices.intInclusive(0, segments.length - 1);
    return segments.filter((_, i) => i !== index).join("/");
  };
  const duplicateSegment: Mutation = () => {
    const index = choices.intInclusive(0, segments.length - 1);
    return [...segments.slice(0, index + 1), ...segments.slice(index)].join(
      "/",
    );
  };
  return choices.weightedPick<Mutation>([
    [2, replaceChar],
    [2, flipCase],
    [2, insertChar],
    [2, deleteChar],
    [1, dropSegment],
    [1, duplicateSegment],
  ])();
}

// ---------------------------------------------------------------------------
// Staged-path repairs (soundness by construction; the oracle re-judges)
// ---------------------------------------------------------------------------

interface PathRepairOptions {
  /** Append `.mdx` when the final segment lacks it (SPEC 7.1). */
  readonly forceMdx: boolean;
  /** First segments that must not be staged (namespace/config collisions). */
  readonly bannedFirstSegments: readonly string[];
  /** Replace `.xspec.` substrings (capture side, SPEC 13.4; module header). */
  readonly banXspecDot: boolean;
  /** Force the first segment to this literal (capture-side targets). */
  readonly forceFirstSegment?: string;
}

/**
 * Deterministically repair a derived path into a stageable one: no empty,
 * `.`, or `..` segments; no banned first segment; optional `.mdx` suffix and
 * `.xspec.` bans. Pure function of its input, so tape replay and shrinking
 * reproduce the repaired value exactly; the oracle judges the final string.
 */
function repairStagedPath(raw: string, options: PathRepairOptions): string {
  let segments = raw.split("/").map((segment) => {
    if (segment === "") return "q";
    if (segment === ".") return "q.";
    if (segment === "..") return "q..";
    if (options.banXspecDot) {
      while (segment.includes(".xspec.")) {
        segment = segment.replace(".xspec.", ".xspeq.");
      }
    }
    return segment;
  });
  if (raw === "") segments = ["q"];
  if (options.forceFirstSegment !== undefined) {
    segments[0] = options.forceFirstSegment;
    if (segments.length === 1) segments.push("q");
  } else if (options.bannedFirstSegments.includes(segments[0])) {
    segments[0] = `w${segments[0]}`;
  }
  if (options.forceMdx) {
    let last = segments[segments.length - 1];
    if (!last.endsWith(".mdx")) last += ".mdx";
    // A file named exactly `.mdx` sits on an unpinned reading of SPEC 7.1
    // ("the `.mdx` extension" for an extensionless dot-file): keep it out of
    // the input space rather than test an undecided point.
    if (last === ".mdx") last = "q.mdx";
    segments[segments.length - 1] = last;
  }
  return segments.join("/");
}

/**
 * Order-preserving dedup plus directory/file conflict pruning: a later path
 * equal to, containing as a directory, or contained by an earlier kept path
 * is dropped (one filesystem entry cannot be both a file and a directory).
 */
function dedupAndPrune(paths: readonly string[], cap: number): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    if (kept.length >= cap) break;
    const conflict = kept.some(
      (existing) =>
        existing === path ||
        existing.startsWith(`${path}/`) ||
        path.startsWith(`${existing}/`),
    );
    if (!conflict) kept.push(path);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Discovery property (SPEC 7 match decisions via `ids --json`, T7-4 channel)
// ---------------------------------------------------------------------------

interface DiscoveryTrial {
  readonly patterns: readonly string[];
  readonly paths: readonly string[];
}

const DISCOVERY_ARMS: FillerArms = {
  alphabet: DISCOVERY_PATH_ALPHABET,
  boundaryArms: true,
};

/** A discovery pattern: 1..3 repaired segments over the SPEC 7 grammar. */
function discoveryPatternSegments(choices: Choices): PatternSeg[] {
  const count = choices.intInclusive(1, 3);
  const segs: PatternSeg[] = [];
  for (let i = 0; i < count; i += 1) {
    const seg = choices.boolean(0.2)
      ? ({ kind: "globstar" } as const)
      : tokenSegmentGen(DISCOVERY_PATTERN_LITERAL_ALPHABET)(choices);
    segs.push(repairPatternSegment(seg, true));
  }
  return segs;
}

const discoveryTrialGen: Gen<DiscoveryTrial> = (choices) => {
  const patternCount = choices.intInclusive(1, 2);
  const patterns: string[] = [];
  const rawPaths: string[] = [];
  for (let p = 0; p < patternCount; p += 1) {
    let segs = discoveryPatternSegments(choices);
    // Module-header guard: the config file is the workspace's only non-.mdx
    // path; a pattern matching it would stage 14.19, not a §7 decision.
    if (globMatches(renderPattern(segs), "xspec.config.ts")) {
      segs = [
        { kind: "tokens", tokens: [{ kind: "lit", text: "w" }] },
        ...segs,
      ];
    }
    patterns.push(renderPattern(segs));
    const derived = choices.intInclusive(1, 3);
    for (let i = 0; i < derived; i += 1) {
      const base = expandPattern(segs, choices, DISCOVERY_ARMS);
      rawPaths.push(
        choices.boolean(0.35)
          ? mutatePath(base, choices, DISCOVERY_PATH_ALPHABET)
          : base,
      );
    }
  }
  const independent = choices.intInclusive(0, 2);
  for (let i = 0; i < independent; i += 1) {
    rawPaths.push(randomPath(choices, DISCOVERY_PATH_ALPHABET));
  }
  const paths = dedupAndPrune(
    rawPaths.map((raw) =>
      repairStagedPath(raw, {
        forceMdx: true,
        bannedFirstSegments: ["xspec.config.ts", ".xspec"],
        banXspecDot: false,
      }),
    ),
    8,
  );
  return { patterns, paths };
};

/** A minimal valid single-section source: one node `<id>` under the root. */
function mdxSection(id: string): string {
  return `<S id="${id}">\nText for ${id}.\n</S>\n`;
}

/** One `{file, ids}` listing entry, and a bytewise-sorted copy for compare. */
interface ListingEntry {
  readonly file: string;
  readonly ids: readonly string[];
}

function sortedListing(entries: readonly ListingEntry[]): ListingEntry[] {
  return entries
    .map((entry) => ({ file: entry.file, ids: entry.ids }))
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.file, "utf8"), Buffer.from(b.file, "utf8")),
    );
}

function renderDiscoveryTrial(trial: DiscoveryTrial): string {
  return JSON.stringify({ patterns: trial.patterns, paths: trial.paths });
}

/** The P-7 discovery property body: listed files = oracle-matched paths. */
async function assertDiscoveryAgreement(
  product: ProductBinding,
  trial: DiscoveryTrial,
): Promise<void> {
  const files: Record<string, string> = {
    "xspec.config.ts":
      `import { defineConfig } from "xspec"\n\nexport default defineConfig({\n` +
      `  specs: {\n    g: [${trial.patterns
        .map((pattern) => JSON.stringify(pattern))
        .join(", ")}]\n  }\n})\n`,
  };
  const expected: ListingEntry[] = [];
  trial.paths.forEach((path, index) => {
    const id = `s${String(index)}`;
    files[path] = mdxSection(id);
    if (trial.patterns.some((pattern) => globMatches(pattern, path))) {
      expected.push({ file: path, ids: [id] });
    }
  });
  const workspace = await TestWorkspace.create({ files });
  try {
    const context =
      `P-7 discovery: patterns ${JSON.stringify(trial.patterns)} over staged ` +
      `paths ${JSON.stringify(trial.paths)} — \`ids --json\``;
    const result = await runCli(product, workspace, ["ids", "--json"]);
    assertExitCode(
      result,
      0,
      `${context} — every staged path is a valid \`.mdx\` source and a ` +
        `no-match group is valid, so \`ids\` answers cleanly (SPEC 7, 12.3)`,
    );
    const report = decodeIdsReport(parseJsonStdout(result, context), context);
    assertSameJson(
      sortedListing(report.files),
      sortedListing(expected),
      `${context}: the discovered set must equal the oracle-matched subset ` +
        `of the staged paths — byte-wise, case-sensitive matching with ` +
        `exactly \`*\`/\`?\`/\`**\` active, every other character literal, ` +
        `and the dot-segment rule (SPEC 7; TEST-SPEC §16 P-7; compared ` +
        `bytewise-sorted, membership per SPEC 7)`,
    );
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// Capture property (SPEC 7.5 captures via policy findings, T7.5-5 channel)
// ---------------------------------------------------------------------------

interface CaptureRule {
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

interface CaptureTrial {
  readonly rules: readonly CaptureRule[];
  readonly sources: readonly string[];
  readonly targets: readonly string[];
}

const CAPTURE_ARMS: FillerArms = {
  alphabet: CAPTURE_PATH_ALPHABET,
  boundaryArms: true,
};

/** Distinct capture indices from {1, 2, 3}, one or two of them. */
function captureIndicesGen(choices: Choices): number[] {
  const first = choices.intInclusive(1, 3);
  if (!choices.boolean(0.5)) return [first];
  const rest = [1, 2, 3].filter((index) => index !== first);
  return [first, choices.pick(rest)];
}

/**
 * A `from` pattern: 1..3 repaired segments with every capture index injected
 * exactly once into a token segment (SPEC 7.5: each at most once).
 */
function fromPatternSegments(
  choices: Choices,
  captureIndices: readonly number[],
): PatternSeg[] {
  const count = choices.intInclusive(1, 3);
  const segs: PatternSeg[] = [];
  for (let i = 0; i < count; i += 1) {
    const seg = choices.boolean(0.12)
      ? ({ kind: "globstar" } as const)
      : tokenSegmentGen(PATTERN_LITERAL_ALPHABET)(choices);
    segs.push(repairPatternSegment(seg, false));
  }
  const tokenPositions = segs.flatMap((seg, index) =>
    seg.kind === "tokens" ? [index] : [],
  );
  if (tokenPositions.length === 0) {
    segs[0] = { kind: "tokens", tokens: [{ kind: "lit", text: "a" }] };
    tokenPositions.push(0);
  }
  for (const index of captureIndices) {
    const at = choices.pick(tokenPositions);
    const seg = segs[at];
    if (seg.kind !== "tokens") continue; // unreachable: positions are token segs
    const position = choices.intInclusive(0, seg.tokens.length);
    segs[at] = {
      kind: "tokens",
      tokens: [
        ...seg.tokens.slice(0, position),
        { kind: "capture", index },
        ...seg.tokens.slice(position),
      ],
    };
  }
  return segs;
}

/**
 * A `to` pattern: literal first segment `tgt`, an optional middle segment,
 * and a final token segment referencing 0..2 of the `from` captures (repeats
 * allowed) with a forced literal `.mdx` suffix (targets are spec sources,
 * SPEC 7.1).
 */
function toPatternSegments(
  choices: Choices,
  captureIndices: readonly number[],
): PatternSeg[] {
  const segs: PatternSeg[] = [
    { kind: "tokens", tokens: [{ kind: "lit", text: "tgt" }] },
  ];
  if (choices.boolean(0.35)) {
    segs.push(
      choices.boolean(0.25)
        ? { kind: "globstar" }
        : repairPatternSegment(
            tokenSegmentGen(PATTERN_LITERAL_ALPHABET)(choices),
            false,
          ),
    );
  }
  const finalTokens: PatternToken[] = [];
  const pieceCount = choices.intInclusive(0, 2);
  for (let i = 0; i < pieceCount; i += 1) {
    finalTokens.push(
      choices.weightedPick<PatternToken>([
        [
          4,
          {
            kind: "lit",
            text: fillerGen(PATTERN_LITERAL_ALPHABET, 1, 2)(choices),
          },
        ],
        [2, { kind: "star" }],
        [1, { kind: "question" }],
      ]),
    );
  }
  const referenceCount = choices.intInclusive(0, 2);
  for (let i = 0; i < referenceCount; i += 1) {
    const index = choices.pick(captureIndices);
    const position = choices.intInclusive(0, finalTokens.length);
    finalTokens.splice(position, 0, { kind: "ref", index });
  }
  finalTokens.push({ kind: "lit", text: ".mdx" });
  segs.push({ kind: "tokens", tokens: finalTokens });
  return segs;
}

/** Decode captured bytes as UTF-8 strings; null when a capture split a
 * multi-byte character (such a target is simply not derived — the oracle
 * still judges every staged string; module header). */
function capturesAsStrings(
  captures: ReadonlyMap<number, Uint8Array>,
): Map<number, string> | null {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const out = new Map<number, string>();
  for (const [index, bytes] of captures) {
    try {
      out.set(index, decoder.decode(bytes));
    } catch {
      return null;
    }
  }
  return out;
}

/** Mutate one captured value (grow, shrink, or dot-prefix) — a plausible
 * wrong disambiguation for the discriminating-target derivation. */
function mutateCaptures(
  captures: ReadonlyMap<number, string>,
  choices: Choices,
): Map<number, string> {
  const out = new Map(captures);
  const indices = [...out.keys()].sort((a, b) => a - b);
  if (indices.length === 0) return out;
  const index = choices.pick(indices);
  const value = out.get(index) ?? "";
  const mutated = choices.weightedPick<string>([
    [3, value + pathChar(CAPTURE_PATH_ALPHABET)(choices)],
    [2, value.length > 1 ? value.slice(0, -1) : `.${value}`],
    [2, `.${value}`],
  ]);
  out.set(index, mutated);
  return out;
}

const SOURCE_REPAIR: PathRepairOptions = {
  forceMdx: false,
  bannedFirstSegments: ["tgt", ".xspec", "xspec.config.ts"],
  banXspecDot: true,
};

const TARGET_REPAIR: PathRepairOptions = {
  forceMdx: true,
  bannedFirstSegments: [],
  banXspecDot: true,
  forceFirstSegment: "tgt",
};

interface GeneratedRule extends CaptureRule {
  readonly toSegs: readonly PatternSeg[];
}

const captureTrialGen: Gen<CaptureTrial> = (choices) => {
  const ruleCount = choices.intInclusive(1, 2);
  const rules: GeneratedRule[] = [];
  const rawSources: string[] = [];
  for (let k = 0; k < ruleCount; k += 1) {
    const captureIndices = captureIndicesGen(choices);
    const fromSegs = fromPatternSegments(choices, captureIndices);
    const toSegs = toPatternSegments(choices, captureIndices);
    rules.push({
      name: `r${String(k)}`,
      from: renderPattern(fromSegs),
      to: renderPattern(toSegs),
      toSegs,
    });
    const derived = choices.intInclusive(1, 2);
    for (let i = 0; i < derived; i += 1) {
      const base = expandPattern(fromSegs, choices, CAPTURE_ARMS);
      rawSources.push(
        choices.boolean(0.3)
          ? mutatePath(base, choices, CAPTURE_PATH_ALPHABET)
          : base,
      );
    }
  }
  if (choices.boolean(0.3)) {
    rawSources.push(randomPath(choices, CAPTURE_PATH_ALPHABET));
  }
  const sources = dedupAndPrune(
    rawSources.map((raw) => repairStagedPath(raw, SOURCE_REPAIR)),
    3,
  );
  // Targets: for each (rule, matching source), the agreeing expansion of the
  // `to` pattern under the oracle's captures, plus a mutated-capture
  // expansion (a discriminating near-miss); plus 1..2 independent targets.
  const rawTargets: string[] = [];
  for (const rule of rules) {
    for (const source of sources.slice(0, 2)) {
      const captured = matchFromPattern(rule.from, source);
      if (captured === null) continue;
      const values = capturesAsStrings(captured);
      if (values === null) continue;
      rawTargets.push(
        expandPattern(rule.toSegs, choices, CAPTURE_ARMS, values),
      );
      if (choices.boolean(0.6)) {
        rawTargets.push(
          expandPattern(
            rule.toSegs,
            choices,
            CAPTURE_ARMS,
            mutateCaptures(values, choices),
          ),
        );
      }
    }
  }
  const independent = choices.intInclusive(1, 2);
  for (let i = 0; i < independent; i += 1) {
    rawTargets.push(`tgt/${randomPath(choices, CAPTURE_PATH_ALPHABET)}`);
  }
  const targets = dedupAndPrune(
    rawTargets.map((raw) => repairStagedPath(raw, TARGET_REPAIR)),
    5,
  );
  return {
    rules: rules.map(({ name, from, to }) => ({ name, from, to })),
    sources,
    targets,
  };
};

/** The staged code source: one import and one reference per target (the
 * T7.5-4 code-file form — each `T<j>.t<j>` yields one `references` edge). */
function codeSource(sourcePath: string, targets: readonly string[]): string {
  const depth = sourcePath.split("/").length - 1;
  const up = depth === 0 ? "./" : "../".repeat(depth);
  const imports = targets
    .map(
      (target, j) =>
        `import T${String(j)} from ${JSON.stringify(
          `${up}${target.slice(0, -".mdx".length)}.xspec`,
        )}`,
    )
    .join("\n");
  const uses = targets.map((_, j) => `T${String(j)}.t${String(j)}`).join("\n");
  return `${imports}\n\n${uses}\n`;
}

function captureConfig(trial: CaptureTrial): string {
  const literals = (paths: readonly string[]): string =>
    paths.map((path) => JSON.stringify(path)).join(", ");
  const rules = trial.rules
    .map(
      (rule) =>
        `    {\n      name: ${JSON.stringify(rule.name)},\n` +
        `      type: "forbidden",\n` +
        `      from: { files: ${JSON.stringify(rule.from)} },\n` +
        `      to: { files: ${JSON.stringify(rule.to)} }\n    }`,
    )
    .join(",\n");
  return (
    `import { defineConfig } from "xspec"\n\nexport default defineConfig({\n` +
    `  specs: {\n    tgt: [${literals(trial.targets)}]\n  },\n` +
    `  code: {\n    app: [${literals(trial.sources)}]\n  },\n` +
    `  policy: [\n${rules}\n  ]\n})\n`
  );
}

/** One expected policy finding as a "rule :: kind: from -> to" rendering
 * (the T7.5-4 comparison form: SPEC 7.5 fixes the information, no order). */
function expectedFindingRenderings(trial: CaptureTrial): string[] {
  const expected: string[] = [];
  for (const rule of trial.rules) {
    for (const source of trial.sources) {
      const captured = matchFromPattern(rule.from, source);
      if (captured === null) continue;
      trial.targets.forEach((target, j) => {
        if (matchToPattern(rule.to, target, captured)) {
          expected.push(
            `${rule.name} :: references: ${source} -> ${target}#t${String(j)}`,
          );
        }
      });
    }
  }
  return expected.sort();
}

function renderFinding(finding: Finding): string {
  return (
    `${finding.rule ?? "<no rule>"} :: ` +
    (finding.edge === undefined
      ? "<no edge>"
      : `${finding.edge.kind}: ${finding.edge.from} -> ${finding.edge.to}`)
  );
}

function renderCaptureTrial(trial: CaptureTrial): string {
  return JSON.stringify({
    rules: trial.rules,
    sources: trial.sources,
    targets: trial.targets,
  });
}

/** The P-7 capture property body: `check` findings = oracle agreement set. */
async function assertCaptureAgreement(
  product: ProductBinding,
  trial: CaptureTrial,
): Promise<void> {
  const files: Record<string, string> = {
    "xspec.config.ts": captureConfig(trial),
  };
  trial.targets.forEach((target, j) => {
    files[target] = mdxSection(`t${String(j)}`);
  });
  for (const source of trial.sources) {
    files[source] = codeSource(source, trial.targets);
  }
  const expected = expectedFindingRenderings(trial);
  const workspace = await TestWorkspace.create({ files });
  try {
    const base =
      `P-7 captures: rules ${JSON.stringify(trial.rules)} over sources ` +
      `${JSON.stringify(trial.sources)} and targets ${JSON.stringify(trial.targets)}`;
    await buildOk(
      product,
      workspace,
      `${base} — \`build\`: sources are valid by construction and build does ` +
        `not evaluate policy (SPEC 12.1, 7.5), so the check below observes ` +
        `fresh output and only policy findings`,
    );
    if (expected.length === 0) {
      await expectExit(
        product,
        workspace,
        ["check", "--json"],
        0,
        `${base} — \`check --json\`: the oracle matches no (rule, edge) pair ` +
          `(SPEC 7.5 shortest-match; captures never span \`/\` or match ` +
          `empty), so there is no violation and no finding (SPEC 7.5, 12.0)`,
      );
      return;
    }
    const context = `${base} — \`check --json\``;
    const result = await expectExit(
      product,
      workspace,
      ["check", "--json"],
      1,
      `${context} — policy violations are findings of check and cause exit 1 ` +
        `(SPEC 7.5, 14.12, 12.0)`,
    );
    const findings = decodeFindingsReport(
      parseJsonStdout(result, context),
      context,
    ).findings;
    assertConditionCounts(findings, { "14.12": expected.length }, context);
    assertSameJson(
      findings.map(renderFinding).sort(),
      expected,
      `${context}: the (rule, offending edge) pairs must equal the oracle's ` +
        `agreement set — \`from\` match decisions, the unique left-to-right ` +
        `shortest-match capture values, and \`to\`-expansion agreement ` +
        `(SPEC 7.5, 14.12; TEST-SPEC §16 P-7)`,
    );
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// The registered property test
// ---------------------------------------------------------------------------

const P_7 = defineProductTest({
  id: "P-7",
  title:
    "property: over random patterns and paths (foreign-dialect metacharacters " +
    "included), discovery match decisions equal the spec oracle via `ids`, and " +
    "policy capture matching — from-match, unique shortest-match capture " +
    "values, to-expansion agreement, captures never spanning `/` or matching " +
    "empty — equals the oracle via `check` findings (SPEC 7, 7.5; TEST-SPEC " +
    "§16 P-7)",
  // Wall-clock hang guard only (H-10): two properties over three fixed seeds
  // (E-5); one workspace and one to three subprocess runs per trial, plus the
  // shrink budgets on falsification.
  timeoutMs: 420_000,
  run: async (product) => {
    await checkProperty(
      "P-7 glob matching (discovery)",
      discoveryTrialGen,
      async (trial) => {
        await assertDiscoveryAgreement(product, trial);
      },
      { runs: 8, maxShrinkExecutions: 120, render: renderDiscoveryTrial },
    );
    await checkProperty(
      "P-7 captures (policy)",
      captureTrialGen,
      async (trial) => {
        await assertCaptureAgreement(product, trial);
      },
      { runs: 5, maxShrinkExecutions: 120, render: renderCaptureTrial },
    );
  },
});

/** TEST-SPEC §16 P-7 (PROP-05). */
export const section16P7Tests: readonly ProductTestEntry[] = [P_7];
