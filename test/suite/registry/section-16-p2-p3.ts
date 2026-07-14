// TEST-SPEC §16 P-2 + P-3 (Markdown compilation / text algebra) — PROP-02.
//
// Two registered product-facing property tests (C-2 "one code path") sharing
// one seeded random-document generator (helpers/property.ts, H-10; fixed seed
// set in CI, E-5). Each trial generates a workspace of 1–3 `.mdx` spec
// sources composed of prose blocks, nested sections, imports, single- and
// multi-line MDX comments, and same-file and cross-file `{text(...)}`
// embeddings, over mixed line terminators (LF, CRLF, lone CR), with content
// weighted toward the whitespace/non-whitespace boundary code points of
// SPEC 1.4 (U+00A0, U+0085, U+2028 included) — exactly the P-2 input space.
//
//   * P-2 — for every file, `build` under `markdown: { emit: true }` emits
//     Markdown byte-equal to the independent harness oracle
//     (helpers/oracles/markdown.ts, S-6-vetted; H-4 byte assertions);
//     compilation is deterministic (H-6: the identical workspace built in a
//     second directory yields byte-identical emissions); and content bytes
//     outside removed constructs are preserved — asserted directly, without
//     the oracle: every logical line no construct touches must appear
//     verbatim, in order, in the emitted output (such a line can never drop:
//     the SPEC 3 drop rule fires only for lines left empty or
//     whitespace-only *purely by removals*).
//   * P-3 — the text algebra of SPEC 1.6, asserted purely as internal
//     consistency of the product's own reported values (no oracle): the root
//     node's subtree text equals the file's compiled Markdown output
//     byte-for-byte, and every node's subtree text equals its own-text runs
//     interleaved with its children's subtree texts in document order — N
//     children yielding N + 1 runs, so |subtree| = |own| + Σ|child subtree|
//     and a run decomposition exists that splits the reported own text into
//     exactly N + 1 runs (empty runs counting) around the children's
//     reported subtree texts.
//
// CONF-MD in-scope (CERTIFICATIONS.md): both properties run against the
// CONF-MD conformer, and P-2 is certified by §VIOL-MD-CLASS (the line-drop
// rule classifying U+00A0/U+0085/U+2028 as whitespace) and §VIOL-MD-CR (a
// lone U+000D not recognized as a line terminator). The generator reaches
// both flip classes deterministically under the fixed seed set: comment
// lines left holding only boundary code points after removal (kept by SPEC
// 1.4/3, dropped under the CLASS deviation), and lone-CR terminators on and
// around removal-affected lines (line extents, and therefore drops and kept
// bytes, diverge under the CR deviation) — verified by a per-seed dry-run
// against deviation-simulating oracles at implementation time. P-3 asserts
// only product-internal consistency, which both violators preserve
// ("consistently in Markdown output and, through 1.6, in own and subtree
// text"), so P-3 passes against every CONF-MD fixture while P-2 fails
// against exactly the violators. The bodies stay within the CONF-MD command
// surface: `build` plus `query node` decoded through the scoped own/subtree
// text adapter (decodeNodeTextSummary) — nothing beyond own and subtree
// text is demanded of a scoped fixture product.
//
// Staging discipline (byte-exact per HARNESS-01; the generator, not the
// oracle, owns these choices):
//   * Generated prose draws from an alphabet that excludes MDX-structural
//     characters — `<`, `{`, `}`, backtick, `~`, `>`, `&`, `\` — so a prose
//     byte can never open a fence, JSX tag, expression container, blockquote
//     lazy-continuation, or character reference that would make the
//     product's construct parse diverge from the generator's structure.
//     Everything else (Markdown punctuation included) is plain content to
//     SPEC 3, which never interprets Markdown semantics.
//   * Section tags, imports, and embeddings are single-line and ASCII; the
//     exotic bytes live in content, where P-2 aims them. Multi-line comments
//     carry 1–2 internal terminators and no internal blank line (MDX
//     expressions admit none); the comment alphabet contains no `/`, so a
//     premature `*/` cannot form.
//   * Line terminators are drawn per line; a deterministic guard keeps a
//     lone-CR terminator from being followed by an empty line's LF (the two
//     bytes would merge into one CRLF terminator and desynchronize the
//     generator's line model from the bytes on disk).
//   * Every file begins (after imports) with one construct-free plain-prose
//     line, so no file compiles to empty output — whether an all-dropped
//     source emits a zero-byte file is not a SPEC 3 question and not staged.
//   * Embedding and `d` references target only sections already closed
//     (earlier in the same file, or any section of an imported earlier
//     file): references resolve, no target is an ancestor, and the embeds
//     graph is acyclic by construction (SPEC 5.3), so expansions are
//     computable bottom-up in definition order.
//   * Embedding targets are restricted to shapes whose subtree text SPEC
//     1.6/3 pins exactly: self-closing sections (empty), single-line inline
//     sections hosted on lines guaranteed to keep (their interior bytes),
//     and block sections whose opening and closing tags stand alone on
//     their lines (the compiled interior — the drop rule is line-local, so
//     the interior compiles compositionally; validated against T3-2's
//     hand-derived chain).

import { decodeNodeTextSummary } from "../../helpers/adapters/index.js";
import type { NodeTextSummary } from "../../helpers/adapters/index.js";
import {
  assertFileBytes,
  assertFilesEqual,
  fail,
} from "../../helpers/assertions.js";
import type { MarkdownPiece } from "../../helpers/oracles/markdown.js";
import { compileMarkdown } from "../../helpers/oracles/markdown.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty, listOf } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { buildOk, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): one spec group, emission
// enabled with the default destination next to each source (SPEC 7.3, 13.2).
// The spec-group glob matches only `.mdx` files, so no glob matches a
// Markdown emit destination.
const EMIT_TRUE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  markdown: { emit: true }
})
`;

/** The character with the given code point (hex-spelled, tool-safe). */
function cp(codePoint: number): string {
  return String.fromCodePoint(codePoint);
}

const TAB = cp(0x0009);
const LF = cp(0x000a);
const VT = cp(0x000b);
const FF = cp(0x000c);
const CR = cp(0x000d);
const SPACE = cp(0x0020);
const CRLF = CR + LF;
// The SPEC 1.4 boundary code points: neither whitespace nor terminators.
const NBSP = cp(0x00a0);
const NEL = cp(0x0085);
const LS = cp(0x2028);

// ---------------------------------------------------------------------------
// Document IR
//
// The generator emits an intermediate representation the trial bodies (and
// the implementation-time dry-run) consume: per file, the source as an
// ordered entry list — plain content, removed constructs, and embeddings by
// target key — plus the requirement-node tree; per document, the registry of
// embeddable targets with the structural shape their subtree text is
// computed from. The source text is the concatenation of entry texts;
// expansion values are *not* baked in, so expected outputs can be
// materialized under SPEC rules (here) or under a simulated deviation (the
// dry-run) from one IR.

/** One segment of a generated source file, in document order. */
export type DocEntry =
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "removal"; readonly text: string }
  | {
      /** A `{text(...)}` expression embedding the target's subtree text. */
      readonly kind: "embed";
      readonly text: string;
      readonly targetKey: string;
    };

/** How an embeddable target's subtree text is computed (module header). */
export type TargetShape =
  | { readonly kind: "empty" }
  | { readonly kind: "inline"; readonly interior: string }
  | { readonly kind: "block"; readonly interior: readonly DocEntry[] };

/** One requirement node: its identity reference and children in order. */
export interface DocNode {
  /** `path` for a root, `path#dotted.id` for a section (SPEC 1.5). */
  readonly ref: string;
  /** Direct child sections' refs, in document order (SPEC 1.6). */
  readonly childRefs: readonly string[];
}

export interface GeneratedFileDoc {
  /** Workspace-relative source path, e.g. `specs/A.mdx`. */
  readonly path: string;
  readonly entries: readonly DocEntry[];
  /** Every requirement node of the file (root included). */
  readonly nodes: readonly DocNode[];
}

export interface GeneratedDoc {
  readonly files: readonly GeneratedFileDoc[];
  /**
   * Embeddable targets by key (`path#dotted.id`), in definition order —
   * every embedding references a key defined earlier, so subtree texts are
   * computable in one forward pass.
   */
  readonly targets: ReadonlyMap<string, TargetShape>;
}

/** The generated source text of one file. */
export function sourceOf(file: GeneratedFileDoc): string {
  return file.entries.map((entry) => entry.text).join("");
}

/**
 * Materialize entries into oracle pieces, resolving each embedding to its
 * target's subtree text under the given target-subtree map.
 */
function materializePieces(
  entries: readonly DocEntry[],
  subtreeOf: ReadonlyMap<string, string>,
): MarkdownPiece[] {
  return entries.map((entry): MarkdownPiece => {
    if (entry.kind === "embed") {
      const expansion = subtreeOf.get(entry.targetKey);
      if (expansion === undefined) {
        throw new Error(
          `P-2/P-3 generator defect: embedding references unknown target ${entry.targetKey}`,
        );
      }
      return { kind: "embedding", text: entry.text, expansion };
    }
    return { kind: entry.kind, text: entry.text };
  });
}

/**
 * Subtree text of every embeddable target under SPEC 1.6/3, bottom-up in
 * definition order (targets only reference earlier targets): a self-closing
 * section is an empty leaf (SPEC 1.1); an inline section on a kept line
 * contributes its interior bytes exactly; a block section with own-line tags
 * contributes its compiled interior — the drop rule is line-local, so whole
 * interior lines compile identically in isolation (validated against T3-2's
 * hand-derived expansions).
 */
export function specSubtreeTexts(doc: GeneratedDoc): Map<string, string> {
  const subtreeOf = new Map<string, string>();
  for (const [key, shape] of doc.targets) {
    switch (shape.kind) {
      case "empty":
        subtreeOf.set(key, "");
        break;
      case "inline":
        subtreeOf.set(key, shape.interior);
        break;
      case "block":
        subtreeOf.set(
          key,
          compileMarkdown(materializePieces(shape.interior, subtreeOf)),
        );
        break;
    }
  }
  return subtreeOf;
}

/** Expected compiled Markdown output of every file, per the SPEC 3 oracle. */
export function specCompiledOutputs(doc: GeneratedDoc): Map<string, string> {
  const subtreeOf = specSubtreeTexts(doc);
  const outputs = new Map<string, string>();
  for (const file of doc.files) {
    outputs.set(
      file.path,
      compileMarkdown(materializePieces(file.entries, subtreeOf)),
    );
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Generators

// Weighted content alphabet (module header: MDX-structural characters
// excluded by design). Order is simplest-first: weightedPick shrinks toward
// the first entry, so counterexamples minimize toward plain `a`s.
const PROSE_ALPHABET: ReadonlyArray<readonly [number, string]> = [
  [24, "a"],
  [8, "b"],
  [4, "z"],
  [4, "K"],
  [4, "0"],
  [3, "9"],
  // 1.4 whitespace that is not a line terminator — ordinary content bytes,
  // and the drop rule's "whitespace-only" fillers.
  [6, SPACE],
  [4, TAB],
  [2, VT],
  [2, FF],
  // The boundary code points SPEC 1.4 excludes from both classes — the
  // §VIOL-MD-CLASS flip class and P-2's named weighting.
  [6, NBSP],
  [5, NEL],
  [5, LS],
  // Breadth beyond the named set: further code points a Unicode-whitespace
  // (JS regex `\s`-style) classifier would misclassify, plus multi-byte and
  // astral content so byte counting is exercised.
  [1, cp(0x2000)],
  [1, cp(0x2029)],
  [1, cp(0x3000)],
  [2, cp(0x00e9)],
  [1, cp(0x4e2d)],
  [1, cp(0x1f600)],
  // Markdown punctuation — plain content to SPEC 3 (compilation never
  // interprets Markdown semantics).
  [2, "."],
  [2, "-"],
  [1, "_"],
  [1, "#"],
  [1, "*"],
  [1, "|"],
  [1, ":"],
  [1, "["],
  [1, "]"],
  [1, "("],
  [1, ")"],
  [1, "!"],
];

const proseChar: Gen<string> = (choices) =>
  choices.weightedPick(PROSE_ALPHABET);

/** Plain keepable characters: never 1.4 whitespace, never boundary-class. */
const PLAIN_CHARS = ["a", "b", "z", "K", "0", "9", "."] as const;

const plainChar: Gen<string> = (choices) => choices.pick(PLAIN_CHARS);

/** 1.4 whitespace that is not a line terminator, simplest (space) first. */
const INLINE_WHITESPACE = [SPACE, TAB, VT, FF] as const;

const whitespaceChar: Gen<string> = (choices) =>
  choices.pick(INLINE_WHITESPACE);

/** The three boundary code points, for boundary-only residues (T3-3 arms). */
const BOUNDARY_CHARS = [NBSP, NEL, LS] as const;

const boundaryChar: Gen<string> = (choices) => choices.pick(BOUNDARY_CHARS);

function run(element: Gen<string>, min: number, max: number): Gen<string> {
  return (choices) => listOf(element, { min, max })(choices).join("");
}

/** Free prose (may be empty or whitespace-only). */
const prose: Gen<string> = run(proseChar, 0, 10);

/** Prose guaranteed to contain a plain non-whitespace character. */
const keptProse: Gen<string> = (choices) => {
  const before = run(proseChar, 0, 4)(choices);
  const anchor = plainChar(choices);
  const after = run(proseChar, 0, 4)(choices);
  return before + anchor + after;
};

/** Plain-only prose (letters/digits/space) with a guaranteed anchor. */
const plainProse: Gen<string> = (choices) => {
  const anchor = plainChar(choices);
  const rest = run(
    (c: Choices) =>
      c.weightedPick<string>([
        [6, "a"],
        [3, "b"],
        [2, "0"],
        [3, SPACE],
      ]),
    0,
    8,
  )(choices);
  return anchor + rest;
};

// Comment interior prose: the prose alphabet contains no `/`, so a premature
// comment terminator can never form; the surrounding spaces keep the interior
// away from the comment's opening and closing brackets.
const commentProse: Gen<string> = (choices) =>
  ` ${run(proseChar, 0, 6)(choices)} `;

/** A line terminator, simplest (LF) first (mixed per line, P-2). */
const terminator: Gen<string> = (choices) =>
  choices.weightedPick<string>([
    [6, LF],
    [3, CRLF],
    [3, CR],
  ]);

// ---------------------------------------------------------------------------
// Per-file generation

/** A reference a `text(...)` argument or `d` value can spell. */
interface EmbedRef {
  /** The argument text: `"dotted.id"` (local) or `M1.dotted.id` (external). */
  readonly argText: string;
  readonly targetKey: string;
}

interface FileContext {
  readonly path: string;
  /** Section-per-file cap and unique-segment counter (SPEC 1.3). */
  idCounter: number;
  /** Terminator of the previously emitted line ("" before the first). */
  prevTerminator: string;
  /** Dotted id of the enclosing section ("" at root level; SPEC 1.3). */
  parentDotted: string;
  /** Local targets closed so far, as local-form references. */
  readonly localRefs: EmbedRef[];
  /** Targets of imported earlier files, as external-form references. */
  readonly externalRefs: readonly EmbedRef[];
  readonly nodes: DocNode[];
  readonly registerTarget: (dotted: string, shape: TargetShape) => void;
}

const MAX_SECTIONS_PER_FILE = 6;

/**
 * End the current line: draw a terminator and append it as a content entry.
 * Deterministic guard (module header): after a lone-CR terminator, an empty
 * line never takes a lone-LF terminator — the CR and LF bytes would merge
 * into one CRLF terminator on disk.
 */
function endLine(
  choices: Choices,
  ctx: FileContext,
  out: DocEntry[],
  lineIsEmpty: boolean,
): void {
  let t = terminator(choices);
  if (lineIsEmpty && ctx.prevTerminator === CR && t === LF) t = CR;
  out.push({ kind: "content", text: t });
  ctx.prevTerminator = t;
}

/** Pick an embedding/`d` reference, or null when none exists yet. */
function pickRef(choices: Choices, ctx: FileContext): EmbedRef | null {
  const pool = [...ctx.localRefs, ...ctx.externalRefs];
  if (pool.length === 0) return null;
  return choices.pick(pool);
}

/** Optional `coverage`/`tags`/`d` props (SPEC 2.7; T3-1's all-props shape). */
function extraProps(choices: Choices, ctx: FileContext): string {
  let props = "";
  if (choices.boolean(0.15)) {
    const ref = pickRef(choices, ctx);
    if (ref !== null) {
      const second = choices.boolean(0.4) ? pickRef(choices, ctx) : null;
      props +=
        second !== null && second.targetKey !== ref.targetKey
          ? ` d={[${ref.argText}, ${second.argText}]}`
          : ` d={${ref.argText}}`;
    }
  }
  if (choices.boolean(0.15)) {
    props += ` coverage="${choices.pick(["required", "none"] as const)}"`;
  }
  if (choices.boolean(0.15)) {
    props += ` tags="${choices.pick(["t1", "t1 t2", "alpha"] as const)}"`;
  }
  return props;
}

/** A fresh section id under `parentDotted`; null when the file is full. */
function nextSectionId(
  ctx: FileContext,
  parentDotted: string,
): { readonly seg: string; readonly dotted: string } | null {
  if (ctx.idCounter >= MAX_SECTIONS_PER_FILE) return null;
  const seg = `s${String(ctx.idCounter)}`;
  ctx.idCounter += 1;
  return { seg, dotted: parentDotted === "" ? seg : `${parentDotted}.${seg}` };
}

const TAG_NAMES = ["S", "Spec"] as const;

interface BlockList {
  readonly entries: readonly DocEntry[];
  /** Refs of the sections generated at this level, in document order. */
  readonly sectionRefs: readonly string[];
}

/**
 * A sequence of blocks at one nesting level. Every block leaves the entry
 * list at a line boundary. `depth` limits section nesting (SPEC 1.3 levels).
 */
function genBlocks(
  choices: Choices,
  ctx: FileContext,
  depth: number,
): BlockList {
  const entries: DocEntry[] = [];
  const sectionRefs: string[] = [];
  const max = depth === 0 ? 7 : 4;
  let count = 0;
  while (count < max && choices.boolean(0.85)) {
    genBlock(choices, ctx, depth, entries, sectionRefs);
    count += 1;
  }
  return { entries, sectionRefs };
}

function genBlock(
  choices: Choices,
  ctx: FileContext,
  depth: number,
  out: DocEntry[],
  sectionRefs: string[],
): void {
  const shape = choices.weightedPick<
    | "prose"
    | "blank"
    | "whitespace"
    | "comment"
    | "multiComment"
    | "embedLine"
    | "section"
    | "selfClosing"
  >([
    [5, "prose"],
    [2, "blank"],
    [1, "whitespace"],
    [3, "comment"],
    [2, "multiComment"],
    [3, "embedLine"],
    [5, "section"],
    [2, "selfClosing"],
  ]);
  switch (shape) {
    case "prose":
      genProseLine(choices, ctx, out, sectionRefs);
      return;
    case "blank":
      endLine(choices, ctx, out, true);
      return;
    case "whitespace":
      out.push({ kind: "content", text: run(whitespaceChar, 1, 4)(choices) });
      endLine(choices, ctx, out, false);
      return;
    case "comment":
      genCommentLine(choices, ctx, out);
      return;
    case "multiComment":
      genMultiLineComment(choices, ctx, out);
      return;
    case "embedLine": {
      const ref = pickRef(choices, ctx);
      if (ref === null) {
        genProseLine(choices, ctx, out, sectionRefs);
        return;
      }
      out.push({
        kind: "embed",
        text: `{text(${ref.argText})}`,
        targetKey: ref.targetKey,
      });
      endLine(choices, ctx, out, false);
      return;
    }
    case "section":
      genBlockSection(choices, ctx, depth, out, sectionRefs);
      return;
    case "selfClosing": {
      const id = nextSectionId(ctx, ctx.parentDotted);
      if (id === null) {
        genProseLine(choices, ctx, out, sectionRefs);
        return;
      }
      const tag = choices.pick(TAG_NAMES);
      out.push({ kind: "removal", text: `<${tag} id="${id.dotted}" />` });
      endLine(choices, ctx, out, false);
      registerSection(ctx, sectionRefs, id.dotted, []);
      ctx.registerTarget(id.dotted, { kind: "empty" });
      return;
    }
  }
}

function registerSection(
  ctx: FileContext,
  sectionRefs: string[],
  dotted: string,
  childRefs: readonly string[],
): void {
  const ref = `${ctx.path}#${dotted}`;
  ctx.nodes.push({ ref, childRefs });
  sectionRefs.push(ref);
}

/**
 * A prose line: free content, optionally hosting one inline construct — an
 * inline comment, an inline embedding, a one-line section, or a self-closing
 * section — with content around it. A line hosting an inline section always
 * carries a guaranteed-kept plain prose anchor, so the line is kept under
 * SPEC 3 and the section's contribution is exactly its interior bytes
 * (module header).
 */
function genProseLine(
  choices: Choices,
  ctx: FileContext,
  out: DocEntry[],
  sectionRefs: string[],
): void {
  const lead = keptProse(choices);
  if (!choices.boolean(0.45)) {
    out.push({ kind: "content", text: lead });
    endLine(choices, ctx, out, false);
    return;
  }
  const inline = choices.weightedPick<
    "comment" | "embed" | "inlineSection" | "inlineSelfClosing"
  >([
    [3, "comment"],
    [3, "embed"],
    [3, "inlineSection"],
    [1, "inlineSelfClosing"],
  ]);
  const pieces: DocEntry[] = [{ kind: "content", text: lead }];
  switch (inline) {
    case "comment":
      pieces.push({ kind: "removal", text: `{/*${commentProse(choices)}*/}` });
      break;
    case "embed": {
      const ref = pickRef(choices, ctx);
      if (ref !== null) {
        pieces.push({
          kind: "embed",
          text: `{text(${ref.argText})}`,
          targetKey: ref.targetKey,
        });
      }
      break;
    }
    case "inlineSection":
    case "inlineSelfClosing": {
      const id = nextSectionId(ctx, ctx.parentDotted);
      if (id === null) break;
      const tag = choices.pick(TAG_NAMES);
      if (inline === "inlineSelfClosing") {
        pieces.push({ kind: "removal", text: `<${tag} id="${id.dotted}" />` });
        registerSection(ctx, sectionRefs, id.dotted, []);
        ctx.registerTarget(id.dotted, { kind: "empty" });
        break;
      }
      const interior = choices.weightedPick<Gen<string>>([
        [4, prose],
        [2, run(whitespaceChar, 1, 2)],
        [1, () => ""],
      ])(choices);
      pieces.push({ kind: "removal", text: `<${tag} id="${id.dotted}">` });
      if (interior !== "") pieces.push({ kind: "content", text: interior });
      pieces.push({ kind: "removal", text: `</${tag}>` });
      registerSection(ctx, sectionRefs, id.dotted, []);
      ctx.registerTarget(id.dotted, { kind: "inline", interior });
      break;
    }
  }
  if (choices.boolean(0.6)) {
    pieces.push({ kind: "content", text: prose(choices) });
  }
  out.push(...pieces);
  endLine(choices, ctx, out, false);
}

/**
 * A single-line own-line comment, optionally with a residue on the line —
 * weighted toward the T3-3 arms: a boundary-code-point-only residue (kept
 * under SPEC 1.4, the §VIOL-MD-CLASS flip), a 1.4-whitespace residue (the
 * line still drops), mixes, and plain kept residues.
 */
function genCommentLine(
  choices: Choices,
  ctx: FileContext,
  out: DocEntry[],
): void {
  const comment: DocEntry = {
    kind: "removal",
    text: `{/*${commentProse(choices)}*/}`,
  };
  const residue = choices.weightedPick<Gen<string>>([
    [4, () => ""],
    [4, run(boundaryChar, 1, 3)],
    [3, run(whitespaceChar, 1, 3)],
    [
      3,
      (c: Choices) =>
        run(
          (cc: Choices) =>
            cc.weightedPick<string>([
              [2, SPACE],
              [2, NBSP],
              [1, NEL],
              [1, LS],
              [1, TAB],
            ]),
          1,
          4,
        )(c),
    ],
    [2, run(plainChar, 1, 3)],
  ])(choices);
  const residueFirst = choices.boolean(0.3);
  if (residue !== "" && residueFirst) {
    out.push({ kind: "content", text: residue });
  }
  out.push(comment);
  if (residue !== "" && !residueFirst) {
    out.push({ kind: "content", text: residue });
  }
  endLine(choices, ctx, out, false);
}

/**
 * A multi-line comment (1–2 internal terminators, no internal blank line),
 * optionally with prose residues before and after on its first and last
 * lines — the residue-merge and merged-line-drop arms of SPEC 3.
 */
function genMultiLineComment(
  choices: Choices,
  ctx: FileContext,
  out: DocEntry[],
): void {
  const before = choices.boolean(0.4) ? keptProse(choices) : "";
  const after = choices.boolean(0.4) ? prose(choices) : "";
  const internalLines = listOf(plainProse, { min: 2, max: 3 })(choices);
  let text = "{/* ";
  internalLines.forEach((line, index) => {
    if (index > 0) text += terminator(choices);
    text += line;
  });
  text += " */}";
  if (before !== "") out.push({ kind: "content", text: before });
  out.push({ kind: "removal", text });
  if (after !== "") out.push({ kind: "content", text: after });
  endLine(choices, ctx, out, false);
}

/**
 * A block section: opening tag alone on its line, interior blocks one level
 * deeper, closing tag alone on its line; registered as an embeddable target
 * (module header). Opening tags never carry trailing same-line content: MDX
 * parses such a tag as a paragraph-inline element that must close within
 * its paragraph, so the own-line-close form would be unparseable — in-place
 * tag deletion on content-retaining lines is exercised by the inline
 * sections of genProseLine instead.
 */
function genBlockSection(
  choices: Choices,
  ctx: FileContext,
  depth: number,
  out: DocEntry[],
  sectionRefs: string[],
): void {
  const id = nextSectionId(ctx, ctx.parentDotted);
  if (id === null) {
    genProseLine(choices, ctx, out, sectionRefs);
    return;
  }
  const tag = choices.pick(TAG_NAMES);
  const open = `<${tag} id="${id.dotted}"${extraProps(choices, ctx)}>`;
  out.push({ kind: "removal", text: open });
  endLine(choices, ctx, out, false);

  const savedParent = ctx.parentDotted;
  ctx.parentDotted = id.dotted;
  const interior =
    depth < 2
      ? genBlocks(choices, ctx, depth + 1)
      : ({ entries: [], sectionRefs: [] } satisfies BlockList);
  ctx.parentDotted = savedParent;

  out.push(...interior.entries);
  out.push({ kind: "removal", text: `</${tag}>` });
  endLine(choices, ctx, out, false);

  registerSection(ctx, sectionRefs, id.dotted, interior.sectionRefs);
  ctx.registerTarget(id.dotted, {
    kind: "block",
    interior: interior.entries,
  });
}

// ---------------------------------------------------------------------------
// Whole-document generation

const FILE_NAMES = ["A", "B", "C"] as const;

/** The shared P-2/P-3 document generator (module header). */
export const generatedDoc: Gen<GeneratedDoc> = (choices) => {
  const targets = new Map<string, TargetShape>();
  const fileTargets = new Map<string, string[]>();
  const files: GeneratedFileDoc[] = [];
  const fileCount = choices.intInclusive(1, FILE_NAMES.length);
  for (let index = 0; index < fileCount; index += 1) {
    const path = `specs/${FILE_NAMES[index]}.mdx`;
    const entries: DocEntry[] = [];
    const nodes: DocNode[] = [];

    // Imports of earlier files (SPEC 2.1), each a removed own-line construct.
    const imports: { readonly binding: string; readonly path: string }[] = [];
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (!choices.boolean(0.65)) continue;
      const binding = `M${String(imports.length + 1)}`;
      imports.push({ binding, path: files[earlier].path });
    }
    const externalRefs: EmbedRef[] = imports.flatMap(({ binding, path: p }) =>
      (fileTargets.get(p) ?? []).map((dotted) => ({
        argText: `${binding}.${dotted}`,
        targetKey: `${p}#${dotted}`,
      })),
    );

    const ctx: FileContext = {
      path,
      idCounter: 0,
      prevTerminator: "",
      parentDotted: "",
      localRefs: [],
      externalRefs,
      nodes,
      registerTarget: (dotted, shape) => {
        const key = `${path}#${dotted}`;
        targets.set(key, shape);
        ctx.localRefs.push({ argText: `"${dotted}"`, targetKey: key });
        const list = fileTargets.get(path) ?? [];
        list.push(dotted);
        fileTargets.set(path, list);
      },
    };

    for (const { binding, path: p } of imports) {
      const name = p.slice("specs/".length, -".mdx".length);
      entries.push({
        kind: "removal",
        text: `import ${binding} from "./${name}.xspec"`,
      });
      endLine(choices, ctx, entries, false);
    }
    // A mandatory blank line after the import block: MDX ESM blocks extend
    // to the next blank line, so a non-blank line directly after an import
    // would be swallowed into the ESM block and fail to parse. Deliberate
    // conservative staging, not oracle behavior — SPEC 2.1 itself stages
    // imports this way.
    if (imports.length > 0) {
      endLine(choices, ctx, entries, true);
    }

    // Guaranteed construct-free plain prose first line (module header).
    entries.push({ kind: "content", text: plainProse(choices) });
    endLine(choices, ctx, entries, false);

    const body = genBlocks(choices, ctx, 0);
    entries.push(...body.entries);

    // Optionally strip the final terminator (SPEC 3: the final line may
    // have none). Every top-level block ends with a terminator entry.
    if (choices.boolean(0.3)) {
      const last = entries[entries.length - 1];
      if (
        last !== undefined &&
        last.kind === "content" &&
        (last.text === LF || last.text === CRLF || last.text === CR)
      ) {
        entries.pop();
      }
    }

    nodes.unshift({ ref: path, childRefs: body.sectionRefs });
    files.push({ path, entries, nodes });
  }
  return { files, targets };
};

// ---------------------------------------------------------------------------
// Rendering

/** Counterexample rendering: per-file sources with escapes readable. */
function renderDoc(doc: GeneratedDoc): string {
  const rendered: Record<string, string> = {};
  for (const file of doc.files) rendered[file.path] = sourceOf(file);
  return JSON.stringify(rendered);
}

// ---------------------------------------------------------------------------
// P-2: compiled output equals the oracle; determinism; byte preservation

function mdPathOf(sourcePath: string): string {
  return `${sourcePath.slice(0, -".mdx".length)}.md`;
}

function workspaceFiles(doc: GeneratedDoc): Record<string, string> {
  const files: Record<string, string> = { "xspec.config.ts": EMIT_TRUE_CONFIG };
  for (const file of doc.files) files[file.path] = sourceOf(file);
  return files;
}

/**
 * The logical lines of a generated file that no construct touches, each with
 * its terminator (the final line possibly without one). Construct-internal
 * terminators never split lines (SPEC 3); lines overlapping any construct
 * are excluded here, so the survivors are exactly the lines SPEC 3 preserves
 * verbatim — the drop rule fires only for lines left empty or
 * whitespace-only purely by removals.
 */
function untouchedLines(file: GeneratedFileDoc): string[] {
  const lines: string[] = [];
  let buffer = "";
  let touched = false;
  const close = (terminatorText: string): void => {
    if (!touched && buffer + terminatorText !== "") {
      lines.push(buffer + terminatorText);
    }
    buffer = "";
    touched = false;
  };
  for (const entry of file.entries) {
    if (entry.kind !== "content") {
      touched = true;
      continue;
    }
    const text = entry.text;
    let start = 0;
    let i = 0;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code !== 0x0a && code !== 0x0d) {
        i += 1;
        continue;
      }
      const t =
        code === 0x0d && text.charCodeAt(i + 1) === 0x0a ? CRLF : text[i];
      buffer += text.slice(start, i);
      close(t);
      i += t.length;
      start = i;
    }
    buffer += text.slice(start);
  }
  close("");
  return lines;
}

/**
 * Direct byte-preservation assertion (P-2, independent of the oracle): every
 * untouched line must occur verbatim in the compiled output, in order, at
 * non-overlapping positions (greedy leftmost matching is complete for
 * ordered non-overlapping substring sequences).
 */
function assertUntouchedLinesPreserved(
  file: GeneratedFileDoc,
  output: string,
  context: string,
): void {
  let cursor = 0;
  for (const line of untouchedLines(file)) {
    const index = output.indexOf(line, cursor);
    if (index < 0) {
      fail(
        `${context}: the source line ${JSON.stringify(line)} of ${file.path} is touched by ` +
          `no removed construct, so SPEC 3 preserves it verbatim (a line with no removal ` +
          `is never dropped), but it does not occur in the compiled output after ` +
          `offset ${String(cursor)} (content bytes outside removed constructs must be preserved)`,
      );
    }
    cursor = index + line.length;
  }
}

/** Decode product-written bytes as UTF-8, failing diagnosed (H-8). */
function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${context}: the emitted Markdown is not valid UTF-8`);
  }
}

async function runP2Trial(
  product: ProductBinding,
  doc: GeneratedDoc,
): Promise<void> {
  const expected = specCompiledOutputs(doc);
  const files = workspaceFiles(doc);
  const first = await TestWorkspace.create({ files });
  try {
    const second = await TestWorkspace.create({ files });
    try {
      await buildOk(
        product,
        first,
        "P-2: `build` of the generated workspace with `markdown: { emit: true }`",
      );
      await buildOk(
        product,
        second,
        "P-2: `build` of the identical workspace in a second directory (H-6 determinism protocol)",
      );
      for (const file of doc.files) {
        const mdRel = mdPathOf(file.path);
        const expectedOutput = expected.get(file.path);
        if (expectedOutput === undefined) {
          throw new Error(
            `P-2 harness defect: no oracle output for ${file.path}`,
          );
        }
        await assertFileBytes(
          first.path(mdRel),
          expectedOutput,
          `P-2: emitted ${mdRel} equals the SPEC 3 oracle's compilation of ${file.path} ` +
            `(removal / replacement / line-drop / terminator rules; H-4 byte equality)`,
        );
        await assertFilesEqual(
          first.path(mdRel),
          second.path(mdRel),
          `P-2: compilation is deterministic — ${mdRel} built from the identical workspace ` +
            `in two separate directories must be byte-identical (H-6)`,
        );
        const output = decodeUtf8(
          await first.readBytes(mdRel),
          `P-2: emitted ${mdRel}`,
        );
        assertUntouchedLinesPreserved(file, output, `P-2: emitted ${mdRel}`);
      }
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
}

// ---------------------------------------------------------------------------
// P-3: text algebra as product-internal consistency

/**
 * Whether `subtree` can be decomposed as r0 c1 r1 … cN rN where c1…cN are
 * the children's subtree texts in document order and r0…rN concatenate to
 * `own` (SPEC 1.6: N children divide the contribution into exactly N + 1
 * runs, empty runs counting). Iterative memoized search over (children
 * consumed, position in subtree); the position in `own` is determined by
 * the two. Caller guarantees |subtree| = |own| + Σ|children|.
 */
export function interleavingExists(
  subtree: string,
  own: string,
  children: readonly string[],
): boolean {
  const n = children.length;
  const prefix: number[] = [0];
  for (const child of children) {
    prefix.push(prefix[prefix.length - 1] + child.length);
  }
  const width = subtree.length + 1;
  const seen = new Set<number>();
  const stack: number[] = [0];
  while (stack.length > 0) {
    const state = stack.pop() as number;
    if (seen.has(state)) continue;
    seen.add(state);
    const consumed = Math.floor(state / width);
    const position = state % width;
    const ownPosition = position - prefix[consumed];
    if (consumed === n) {
      if (subtree.slice(position) === own.slice(ownPosition)) return true;
      continue;
    }
    const child = children[consumed];
    if (subtree.startsWith(child, position)) {
      stack.push((consumed + 1) * width + position + child.length);
    }
    if (
      ownPosition < own.length &&
      position < subtree.length &&
      subtree.charCodeAt(position) === own.charCodeAt(ownPosition)
    ) {
      stack.push(consumed * width + position + 1);
    }
  }
  return false;
}

function excerpt(text: string): string {
  const rendered = JSON.stringify(text);
  return rendered.length <= 160 ? rendered : `${rendered.slice(0, 160)}…`;
}

/** The SPEC 1.6 algebra for one node, over product-reported values only. */
function assertTextAlgebra(
  node: DocNode,
  texts: ReadonlyMap<string, NodeTextSummary>,
  context: string,
): void {
  const self = texts.get(node.ref);
  if (self === undefined) {
    throw new Error(`P-3 harness defect: no queried texts for ${node.ref}`);
  }
  const children = node.childRefs.map((ref) => {
    const child = texts.get(ref);
    if (child === undefined) {
      throw new Error(`P-3 harness defect: no queried texts for ${ref}`);
    }
    return child.subtreeText;
  });
  const childrenLength = children.reduce((sum, text) => sum + text.length, 0);
  if (self.subtreeText.length !== self.ownText.length + childrenLength) {
    fail(
      `${context}: for ${node.ref}, |subtree text| must equal |own text| plus the sum of ` +
        `the ${String(children.length)} children's |subtree text| — the children interleave ` +
        `with exactly N + 1 own-text runs and nothing else (SPEC 1.6); got ` +
        `${String(self.subtreeText.length)} vs ${String(self.ownText.length)} + ${String(childrenLength)}\n` +
        `  subtree: ${excerpt(self.subtreeText)}\n  own:     ${excerpt(self.ownText)}`,
    );
  }
  if (!interleavingExists(self.subtreeText, self.ownText, children)) {
    fail(
      `${context}: for ${node.ref}, the reported subtree text does not decompose as the ` +
        `reported own text's N + 1 runs interleaved with the ${String(children.length)} ` +
        `children's reported subtree texts in document order (SPEC 1.6)\n` +
        `  subtree:  ${excerpt(self.subtreeText)}\n` +
        `  own:      ${excerpt(self.ownText)}\n` +
        `  children: ${children.map(excerpt).join(", ")}`,
    );
  }
}

async function runP3Trial(
  product: ProductBinding,
  doc: GeneratedDoc,
): Promise<void> {
  const workspace = await TestWorkspace.create({ files: workspaceFiles(doc) });
  try {
    await buildOk(
      product,
      workspace,
      "P-3: `build` of the generated workspace with `markdown: { emit: true }`",
    );
    for (const file of doc.files) {
      const texts = new Map<string, NodeTextSummary>();
      for (const node of file.nodes) {
        const label = `P-3 \`query node ${node.ref}\``;
        texts.set(
          node.ref,
          decodeNodeTextSummary(
            await runJson(
              product,
              workspace,
              ["query", "node", node.ref],
              label,
            ),
            label,
          ),
        );
      }
      const root = texts.get(file.path);
      if (root === undefined) {
        throw new Error(`P-3 harness defect: no root texts for ${file.path}`);
      }
      const mdRel = mdPathOf(file.path);
      await assertFileBytes(
        workspace.path(mdRel),
        root.subtreeText,
        `P-3: the root node's reported subtree text equals the compiled Markdown ` +
          `output emitted at ${mdRel}, byte for byte (SPEC 1.6, 1.2, 3)`,
      );
      for (const node of file.nodes) {
        assertTextAlgebra(node, texts, "P-3");
      }
    }
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// The registered property tests

const P_2 = defineProductTest({
  id: "P-2",
  title:
    "property: random documents (prose, nested sections, imports, single- and multi-line " +
    "comments, embeddings, mixed line terminators, boundary-code-point-weighted content) " +
    "compile to Markdown byte-equal to the harness's SPEC 3 oracle, deterministically " +
    "across directories, preserving content bytes outside removed constructs " +
    "(SPEC 3, 1.4, 1.6, 7.3; TEST-SPEC §16 P-2)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), two
  // workspaces and two builds per trial, plus the shrink budget.
  timeoutMs: 300_000,
  run: async (product) => {
    await checkProperty(
      "P-2 Markdown compilation",
      generatedDoc,
      async (doc) => {
        await runP2Trial(product, doc);
      },
      { runs: 12, maxShrinkExecutions: 150, render: renderDoc },
    );
  },
});

const P_3 = defineProductTest({
  id: "P-3",
  title:
    "property: for random documents, the root's subtree text equals the compiled Markdown " +
    "output, and every node's subtree text equals its own-text runs interleaved with its " +
    "children's subtree texts in document order, N children yielding N + 1 runs — asserted " +
    "as internal consistency of the product's reported values (SPEC 1.6, 3; TEST-SPEC §16 P-3)",
  // Wall-clock hang guard only (H-10): one build plus one `query node` per
  // requirement node per trial, three fixed seeds (E-5), plus shrinking.
  timeoutMs: 300_000,
  run: async (product) => {
    await checkProperty(
      "P-3 text algebra",
      generatedDoc,
      async (doc) => {
        await runP3Trial(product, doc);
      },
      { runs: 6, maxShrinkExecutions: 100, render: renderDoc },
    );
  },
});

/** TEST-SPEC §16 P-2 and P-3 (PROP-02). */
export const section16P2P3Tests: readonly ProductTestEntry[] = [P_2, P_3];
