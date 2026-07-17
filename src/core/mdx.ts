// MDX parse and per-file document model (SPEC 1.1–1.4, 1.6, 1.7, 2.5–2.7).
//
// IMPLEMENTATION (Key libraries): spec sources are parsed with remark-mdx on
// the unified/remark toolchain — its grammar defines well-formed MDX
// (SPEC 14.20) and it yields exact source offsets for every construct, which
// the byte-exact text and removal rules (SPEC 1.6, 3) require. This module
// turns one discovered spec source's bytes into the per-file document model:
// the implicit root (1.2), the section tree with structural-path IDs
// (1.1, 1.3, 1.4), byte-offset source ranges (1.7), validated props
// (2.5–2.7), and the recorded spans later stages consume — `d` expressions
// and `{text(...)}` embeddings for the reference analyzer, ESM blocks and
// MDX comments for Markdown compilation. It is pure and deterministic
// (IMPLEMENTATION Architecture): bytes in, model plus findings out.
//
// Masking (SPEC 14): a file that fails to parse — not well-formed MDX under
// remark-mdx's grammar, not valid UTF-8, or BOM-carrying (1.6) — reports
// exactly one condition, 14.20 with the failure's location, and the
// conditions inside it go unreported. Within a parsed file, every detectable
// condition is reported, with 14.2's own masking rule (14.2) applied.
//
// Grammar widenings (SPEC 14.20): "well-formed MDX" is remark-mdx's grammar
// *as extended here* — the toolchain stays remark-mdx (IMPLEMENTATION Key
// libraries); each widening is a surgical, documented extension preserving
// exact source offsets, admitting source shapes that are valid xspec sources
// (SPEC 1–3) but that the stock grammar rejects:
//   1. Expression grammar (acorn): `xspecAcornExtension` below.
//   2. ESM block boundary: the stock ESM construct ends only at a blank line
//      or EOF, so an import directly followed by a non-blank line feeds both
//      lines to acorn and fails; `widenedEsmConstruct` below ends the block
//      at the first line boundary where the accumulated text is a complete
//      valid program.
//   3. Section-tag pairing: stock MDX pairs JSX tags inside one construct,
//      so an opening tag with trailing same-line content whose closing tag
//      sits on a later line ("Expected a closing tag … before the end of
//      `paragraph`"), and content directly preceding a closing tag on its
//      line, are rejected; `flatJsxTagExtension` below turns each tag token
//      into a leaf node and the document builder pairs tags itself across
//      construct boundaries. Genuinely malformed sources — unclosed or
//      mismatched elements, bad expressions — still fail the parse (14.20).

import type { Comment, Program } from "acorn";
import { Parser, tokTypes } from "acorn";
import acornJsx from "acorn-jsx";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ByteRange } from "./bytes.js";
import { Utf8Offsets } from "./bytes.js";
import type { ConditionNumber, Finding } from "./findings.js";
import { decodeSourceBytes } from "./source-text.js";
import {
  containsControl,
  containsWhitespace,
  FORBIDDEN_SEGMENT_NAMES,
  isWhitespaceCodePoint,
} from "./text.js";

// ---------------------------------------------------------------------------
// The document model
// ---------------------------------------------------------------------------

/**
 * One string-valued prop occurrence in quoted attribute form (SPEC 2.7),
 * recorded with the spans a later in-place rewrite needs (SPEC 6.4: minimal
 * edits preserving quote style).
 */
export interface SpecAttributeValue {
  /**
   * The attribute's value — the decoded characters of the quoted form
   * (MDX decodes character references in attribute values; the declared ID
   * and tag values are these decoded characters).
   */
  readonly value: string;
  /** Byte range of the value's characters, between (excluding) the quotes. */
  readonly valueRange: ByteRange;
  /** The quote character the author used (SPEC 2.7: single or double alike). */
  readonly quote: '"' | "'";
  /** Byte range of the whole attribute, name through closing quote. */
  readonly attributeRange: ByteRange;
}

/**
 * A `d` prop in the braced-expression form of SPEC 2.7, recorded as spans:
 * the expression's content is analyzed by the shared static-reference
 * analyzer (SPEC 2.2, 2.4; IMPLEMENTATION: one analyzer for MDX expression
 * spans and TypeScript sources), not here.
 */
export interface SpecDependencyAttribute {
  /** Exact source characters between (excluding) the braces. */
  readonly expressionText: string;
  /** Byte range of `expressionText` within the file. */
  readonly expressionRange: ByteRange;
  /** Byte range of the whole attribute, name through closing brace. */
  readonly attributeRange: ByteRange;
}

/**
 * One requirement section (SPEC 1.1) or the file's implicit root (SPEC 1.2,
 * distinguished by `parent === null`). Sections form the containment tree;
 * all ranges are byte offsets into the file's bytes (SPEC 1.7).
 */
export interface SpecSection {
  /**
   * The declared ID (SPEC 1.3), decoded — or null for the implicit root and
   * for a section whose ID is unusable: missing (14.1) or declared in an
   * invalid form (14.17, repeated or not a quoted string). A null ID on a
   * non-root section always has a finding accounting for it.
   */
  readonly id: string | null;
  /**
   * SPEC 1.7: for a non-root section, the construct's own characters — the
   * first character of its opening tag through the last character of its
   * closing tag, or the self-closing tag's own characters; for the root,
   * the entire file.
   */
  readonly range: ByteRange;
  /**
   * The opening tag's characters, `<` through `>` (for a self-closing
   * section, the whole tag). Zero-width at offset 0 for the root, which has
   * no tag (SPEC 1.2).
   */
  readonly openingTagRange: ByteRange;
  /**
   * The closing tag's characters, `</` through `>` (for a self-closing
   * section, the whole tag — identical to `openingTagRange`). Zero-width at
   * the file's end for the root.
   */
  readonly closingTagRange: ByteRange;
  /** SPEC 1.1: a self-closing section element is an empty leaf. */
  readonly selfClosing: boolean;
  /** The innermost enclosing section — null exactly for the root. */
  readonly parent: SpecSection | null;
  /** Child sections in document order. */
  readonly children: readonly SpecSection[];
  /**
   * The effective coverage attribute (SPEC 2.5): `"required"` (the default;
   * an explicit `coverage="required"` is the same value) or `"none"` — null
   * for the root, which carries no coverage attribute (SPEC 1.2, 8.1).
   */
  readonly coverage: "required" | "none" | null;
  /**
   * The node's tags (SPEC 2.6): the whitespace-split tokens of the `tags`
   * value with duplicates collapsed, in first-occurrence order; empty when
   * the prop is absent or yields no tags.
   */
  readonly tags: readonly string[];
  /** The `id` attribute's recorded value/spans, when usably declared. */
  readonly idAttribute: SpecAttributeValue | null;
  /** The `d` attribute's recorded expression span, when validly braced. */
  readonly dependency: SpecDependencyAttribute | null;
}

/** One `{text(...)}` embedding occurrence (SPEC 2.3). */
export interface SpecEmbedding {
  /** The innermost section containing the embedding (the root included). */
  readonly section: SpecSection;
  /** The whole expression container, braces included. */
  readonly range: ByteRange;
  /** Exact source characters between (excluding) the braces. */
  readonly expressionText: string;
  /** Byte range of `expressionText` within the file. */
  readonly expressionRange: ByteRange;
}

/** One MDX comment — an expression container holding only block comments (SPEC 2.7). */
export interface SpecComment {
  /** The innermost section containing the comment (the root included). */
  readonly section: SpecSection;
  /** The whole expression container, braces included. */
  readonly range: ByteRange;
}

/** One import declaration inside an ESM block, recorded for SPEC 2.1/2.2. */
export interface SpecImportStatement {
  /** The declaration's own characters. */
  readonly range: ByteRange;
  /** Exact source characters of the declaration. */
  readonly text: string;
}

/**
 * One top-level ESM block (imports; export statements are invalid and
 * reported, SPEC 2.7 → 14.16). The block's range is what Markdown
 * compilation removes (SPEC 3: imports are removed).
 */
export interface SpecEsmBlock {
  readonly range: ByteRange;
  readonly imports: readonly SpecImportStatement[];
}

/** The parsed per-file document model. */
export interface SpecDocument {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** The decoded UTF-8 content (SPEC 1.6). */
  readonly text: string;
  /** UTF-16 index ↔ UTF-8 byte offset conversion for `text` (SPEC 1.7). */
  readonly offsets: Utf8Offsets;
  /** The implicit root (SPEC 1.2), preceding every section of the file. */
  readonly root: SpecSection;
  /** Every non-root section in document order. */
  readonly sections: readonly SpecSection[];
  /** Top-level ESM blocks in document order. */
  readonly esmBlocks: readonly SpecEsmBlock[];
  /** Every `{text(...)}` embedding in document order. */
  readonly embeddings: readonly SpecEmbedding[];
  /** Every MDX comment in document order. */
  readonly comments: readonly SpecComment[];
  /**
   * The file's structural and prop findings (SPEC 1.3, 1.4, 2.5–2.7 →
   * conditions 14.1–14.4, 14.16, 14.17), ordered by location. Reference
   * resolution and import validation report elsewhere (SPEC 14.5–14.8,
   * 14.15).
   */
  readonly findings: readonly Finding[];
}

/** The outcome of parsing one discovered spec source (SPEC 14.20 masking). */
export type SpecSourceResult =
  | { readonly kind: "document"; readonly document: SpecDocument }
  | { readonly kind: "unparseable"; readonly finding: Finding };

// ---------------------------------------------------------------------------
// remark-mdx boundary (structural types; shapes verified against remark-mdx)
// ---------------------------------------------------------------------------

interface MdxPoint {
  readonly line?: number;
  readonly column?: number;
  readonly offset?: number;
}

interface MdxPosition {
  readonly start: MdxPoint;
  readonly end: MdxPoint;
}

interface EstreeNode {
  readonly type: string;
  /** Document-absolute UTF-16 offsets (acorn, position-patched by MDX). */
  readonly start?: number;
  readonly end?: number;
  readonly expression?: EstreeNode;
  readonly callee?: EstreeNode;
  readonly name?: string;
}

interface EstreeProgram {
  readonly body?: readonly EstreeNode[];
  readonly comments?: readonly unknown[];
}

interface MdxAttributeNode {
  /** "mdxJsxAttribute" | "mdxJsxExpressionAttribute" (a spread). */
  readonly type: string;
  readonly name?: string;
  /** A string for quoted form, an object for braced form, null valueless. */
  readonly value?: string | object | null;
  readonly position?: MdxPosition;
}

interface MdxTreeNode {
  readonly type: string;
  readonly position?: MdxPosition;
  readonly children?: readonly MdxTreeNode[];
  /** JSX element name; null for a fragment. */
  readonly name?: string | null;
  readonly attributes?: readonly MdxAttributeNode[];
  readonly data?: { readonly estree?: EstreeProgram };
  /** `xspecJsxTag` only: this leaf is a closing tag (`</…>`). */
  readonly close?: boolean;
  /** `xspecJsxTag` only: this leaf is a self-closing tag (`<…/>`). */
  readonly selfClosing?: boolean;
}

/** The thrown parse failure's observed shape (a unified VFileMessage). */
interface ParseFailureLike {
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly line?: unknown;
  readonly column?: unknown;
  readonly place?: unknown;
}

/**
 * Structural view of acorn's internal parser surface (not in its public
 * types), verified against acorn 8: the two overridden methods below and
 * the state they touch. `parseSubscript` is acorn's per-access step in a
 * member/call chain; `declareName` records one declared binding and
 * raises on redeclaration after recording it.
 */
interface AcornInternalParser {
  /** The current token's type and value. */
  type: unknown;
  value: unknown;
  /** True when a newline precedes the current token. */
  canInsertSemicolon(): boolean;
  startNodeAt(pos: number, loc: unknown): { expression?: unknown };
  finishNode(node: object, type: string): unknown;
  next(): void;
  scopeStack: readonly unknown[];
  parseSubscript(...args: unknown[]): unknown;
  declareName(name: string, bindingType: unknown, pos: number): void;
}

/**
 * SPEC 2.1/2.4 require certain files to parse so their defects report as
 * import or reference findings rather than as parse failures: a postfix
 * non-null assertion (`BASE!.auth`) is a *dynamic reference* (SPEC 2.4 →
 * 14.8), and two imports binding one identifier are an *invalid import*
 * (SPEC 2.1 → 14.15) — both conditions of a parsed file. Stock acorn
 * rejects both outright, so the expression grammar is widened by exactly
 * these two rules and nothing else; remark-mdx's grammar, so extended,
 * defines well-formed MDX (IMPLEMENTATION; SPEC 14.20):
 *
 * - a postfix `!` with no preceding newline parses as a
 *   `TSNonNullExpression` chain node (the shared static-reference
 *   analyzer then classifies the reference dynamic, SPEC 2.4);
 * - a module-scope redeclaration — duplicate import bindings — does not
 *   abort the parse (import validation reports 14.15, SPEC 2.1); acorn
 *   records the binding before raising, so swallowing the raise leaves
 *   consistent parser state. Redeclarations in inner scopes still fail.
 */
function xspecAcornExtension(BaseParser: typeof Parser): typeof Parser {
  // One more derivation level, so the class handed in stays untouched.
  const Extended = class extends (BaseParser as unknown as new () => object) {};
  const prototype = Extended.prototype as AcornInternalParser;
  const superParseSubscript = prototype.parseSubscript;
  const superDeclareName = prototype.declareName;

  prototype.parseSubscript = function (
    this: AcornInternalParser,
    ...args: unknown[]
  ): unknown {
    if (
      this.type === tokTypes.prefix &&
      this.value === "!" &&
      !this.canInsertSemicolon()
    ) {
      const node = this.startNodeAt(args[1] as number, args[2]);
      node.expression = args[0];
      this.next();
      return this.finishNode(node, "TSNonNullExpression");
    }
    return superParseSubscript.apply(this, args);
  };

  prototype.declareName = function (
    this: AcornInternalParser,
    name: string,
    bindingType: unknown,
    pos: number,
  ): void {
    try {
      superDeclareName.call(this, name, bindingType, pos);
    } catch (error) {
      if (
        this.scopeStack.length === 1 &&
        error instanceof SyntaxError &&
        error.message.includes("has already been declared")
      ) {
        return;
      }
      throw error;
    }
  };

  return Extended as unknown as typeof Parser;
}

/** The extended acorn: JSX plus the two SPEC-required widenings above. */
const specAcorn = Parser.extend(acornJsx(), xspecAcornExtension);

// ---------------------------------------------------------------------------
// Grammar widening 2: the ESM block boundary (SPEC 2.1, 3 → 14.20)
// ---------------------------------------------------------------------------

/**
 * A parse failure raised by the widened grammar layers below, shaped like
 * the unified `VFileMessage`s the stock toolchain throws so
 * `parseFailureFinding` locates it the same way: `reason` plus a `place`
 * that is either a point (`{line, column, offset}`) or a position
 * (`{start, end}`), offsets in UTF-16 indices.
 */
class MdxGrammarError extends Error {
  readonly reason: string;
  readonly place: object;
  readonly line?: number;
  readonly column?: number;

  constructor(
    reason: string,
    place: { line: number; column: number; offset: number } | MdxPosition,
  ) {
    super(reason);
    this.reason = reason;
    this.place = place;
    if ("line" in place) {
      this.line = place.line;
      this.column = place.column;
    }
  }
}

/**
 * Structural view of micromark's tokenizer surface (not a declared
 * dependency's public API), verified against micromark 4: the code
 * classes, effects, and context members the widened ESM construct uses.
 * Micromark represents line endings as the virtual codes CR −5, LF −4,
 * CRLF −3, a tab as −2 followed by virtual spaces −1, and EOF as null.
 */
type MicromarkCode = number | null;
type MicromarkState = (code: MicromarkCode) => MicromarkState | undefined;

interface MicromarkPoint {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

interface MicromarkEffects {
  enter(type: string): unknown;
  exit(type: string): object;
  consume(code: MicromarkCode): void;
  check(
    construct: object,
    ok: MicromarkState,
    nok: MicromarkState,
  ): MicromarkState;
}

interface MicromarkTokenizeContext {
  readonly interrupt?: boolean;
  readonly parser: { definedModuleSpecifiers?: string[] };
  now(): MicromarkPoint;
  sliceSerialize(
    range: { start: MicromarkPoint; end: MicromarkPoint },
    expandTabs?: boolean,
  ): string;
}

const isLineEnding = (code: MicromarkCode): boolean =>
  code !== null && code >= -5 && code <= -3;
const isAsciiAlpha = (code: MicromarkCode): boolean =>
  code !== null && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
const isMarkdownSpace = (code: MicromarkCode): boolean =>
  code === -2 || code === -1 || code === 32;

/**
 * Partial construct mirroring the stock extension's next-line-blank check
 * (micromark-core-commonmark `blankLine` behind one consumed line ending):
 * used only under `effects.check`, so everything it consumes is unwound.
 */
const blankLineBefore = { tokenize: tokenizeNextBlank, partial: true };

function tokenizeNextBlank(
  effects: MicromarkEffects,
  ok: MicromarkState,
  nok: MicromarkState,
): MicromarkState {
  return start;

  function start(code: MicromarkCode): MicromarkState | undefined {
    effects.enter("lineEndingBlank");
    effects.consume(code);
    effects.exit("lineEndingBlank");
    return inside;
  }
  function inside(code: MicromarkCode): MicromarkState | undefined {
    if (isMarkdownSpace(code)) {
      effects.enter("linePrefix");
      effects.consume(code);
      return prefix;
    }
    return after(code);
  }
  function prefix(code: MicromarkCode): MicromarkState | undefined {
    if (isMarkdownSpace(code)) {
      effects.consume(code);
      return prefix;
    }
    effects.exit("linePrefix");
    return after(code);
  }
  function after(code: MicromarkCode): MicromarkState | undefined {
    return code === null || isLineEnding(code) ? ok(code) : nok(code);
  }
}

/** The acorn options the stock ESM construct uses (micromark-extension-mdxjs). */
const ESM_ACORN_OPTIONS = {
  ecmaVersion: 2024,
  sourceType: "module",
  locations: true,
} as const;

/** The statement kinds the stock ESM construct admits in a block. */
const ALLOWED_ESM_TYPES: ReadonlySet<string> = new Set([
  "ExportAllDeclaration",
  "ExportDefaultDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
]);

/** The structural shape of an acorn parse failure (verified against acorn 8). */
interface AcornFailureLike {
  readonly message?: unknown;
  readonly pos?: unknown;
  readonly raisedAt?: unknown;
  readonly loc?: { readonly line?: unknown; readonly column?: unknown };
}

type EsmParseAttempt =
  | {
      readonly ok: true;
      readonly program: Program;
      readonly comments: Comment[];
      readonly prefix: string;
      readonly source: string;
    }
  | {
      readonly ok: false;
      readonly failure: AcornFailureLike;
      readonly swallow: boolean;
      readonly prefix: string;
    };

/**
 * Rebase an estree fragment parsed from a document slice onto document
 * positions: every numeric `start`/`end` shifts by `offsetDelta`, every
 * `loc` line by `lineDelta` (the slice is contiguous document text, so a
 * plain shift is exact; the construct starts at column 1, so columns
 * never shift).
 */
function rebaseEstree(
  value: unknown,
  offsetDelta: number,
  lineDelta: number,
): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      rebaseEstree(item, offsetDelta, lineDelta);
    }
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node["start"] === "number") {
    node["start"] = node["start"] + offsetDelta;
  }
  if (typeof node["end"] === "number") {
    node["end"] = node["end"] + offsetDelta;
  }
  const loc = node["loc"];
  if (typeof loc === "object" && loc !== null) {
    for (const key of ["start", "end"]) {
      const point = (loc as Record<string, unknown>)[key];
      if (typeof point === "object" && point !== null) {
        const record = point as Record<string, unknown>;
        if (typeof record["line"] === "number") {
          record["line"] = record["line"] + lineDelta;
        }
      }
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc") {
      rebaseEstree(child, offsetDelta, lineDelta);
    }
  }
}

/**
 * Grammar widening 2 (SPEC 14.20; SPEC 2.1/3 fix the accepted shape): a
 * clone of the stock `mdxjsEsm` tokenizer (micromark-extension-mdxjs-esm,
 * verified against its source) whose one behavioral change is in
 * `lineStart` — at each line boundary the accumulated text is tried as a
 * program, and a complete valid one ends the block there, so an import
 * line directly followed by a non-blank line parses. The stock construct
 * ends a block only before a blank line or EOF, feeding the follow-on
 * lines to acorn; every other behavior — swallowing incomplete
 * statements across lines, the blank-line check, the import/export-only
 * rule, `definedModuleSpecifiers`, the `addResult` estree (rebased to
 * document positions) — is mirrored. Registered before the stock
 * construct, which therefore never runs. Adjacent import lines become
 * one block per line rather than one shared block; every consumer of
 * `SpecEsmBlock` is per-statement, so the observable model is unchanged.
 */
const widenedEsmConstruct = {
  tokenize: tokenizeWidenedEsm,
  concrete: true,
};

function tokenizeWidenedEsm(
  this: MicromarkTokenizeContext,
  effects: MicromarkEffects,
  ok: MicromarkState,
  nok: MicromarkState,
): MicromarkState {
  const self = this;
  const defined =
    self.parser.definedModuleSpecifiers ??
    (self.parser.definedModuleSpecifiers = []);
  // Re-captured in `start`; initialized here only for definite assignment.
  let startPoint: MicromarkPoint = self.now();
  let keyword = "";
  return self.interrupt === true ? nok : start;

  function start(code: MicromarkCode): MicromarkState | undefined {
    // Only at the start of a line, not in a container (as stock).
    if (self.now().column > 1) {
      return nok(code);
    }
    startPoint = self.now();
    effects.enter("mdxjsEsm");
    effects.enter("mdxjsEsmData");
    effects.consume(code);
    keyword += String.fromCharCode(code as number);
    return word;
  }

  function word(code: MicromarkCode): MicromarkState | undefined {
    if (isAsciiAlpha(code)) {
      effects.consume(code);
      keyword += String.fromCharCode(code as number);
      return word;
    }
    if ((keyword === "import" || keyword === "export") && code === 32) {
      effects.consume(code);
      return inside;
    }
    return nok(code);
  }

  function inside(code: MicromarkCode): MicromarkState | undefined {
    if (code === null || isLineEnding(code)) {
      effects.exit("mdxjsEsmData");
      return lineStart(code);
    }
    effects.consume(code);
    return inside;
  }

  function lineStart(code: MicromarkCode): MicromarkState | undefined {
    if (code === null) {
      return atEnd(code);
    }
    // The widening: a complete valid program ends the block at this line
    // boundary (before the pending line ending). Otherwise exactly the
    // stock path: end before a blank line, else continue accumulating.
    if (parseAccumulated().ok) {
      return atEnd(code);
    }
    return effects.check(blankLineBefore, atEnd, continuationStart)(code);
  }

  function continuationStart(code: MicromarkCode): MicromarkState | undefined {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return lineStart;
  }

  /**
   * Parse the accumulated block text — the contiguous document slice from
   * the construct's start to the current point, prefixed (as stock) with
   * `var` declarations of previously imported bindings so later blocks
   * referencing them parse. `swallow` mirrors
   * micromark-util-events-to-acorn: the failure is at the accumulated
   * text's end, so more content may complete it.
   */
  function parseAccumulated(): EsmParseAttempt {
    const source = self.sliceSerialize(
      { start: startPoint, end: self.now() },
      false,
    );
    const prefix = defined.length > 0 ? "var " + defined.join(",") + "\n" : "";
    const comments: Comment[] = [];
    try {
      const program = specAcorn.parse(prefix + source, {
        ...ESM_ACORN_OPTIONS,
        onComment: comments,
      });
      return { ok: true, program, comments, prefix, source };
    } catch (error) {
      const failure = (
        typeof error === "object" && error !== null ? error : {}
      ) as AcornFailureLike;
      if (typeof failure.pos !== "number" || failure.loc === undefined) {
        throw error; // not an acorn parse failure — a genuine crash
      }
      const swallow =
        (typeof failure.raisedAt === "number" &&
          failure.raisedAt >= prefix.length + source.length) ||
        (typeof failure.message === "string" &&
          failure.message.startsWith("Unterminated comment"));
      return { ok: false, failure, swallow, prefix };
    }
  }

  function atEnd(code: MicromarkCode): MicromarkState | undefined {
    const attempt = parseAccumulated();
    const prefixLines = attempt.prefix.length > 0 ? 1 : 0;
    if (!attempt.ok) {
      if (code !== null && attempt.swallow) {
        return continuationStart(code);
      }
      // Mirror the stock failure message and its document-rebased place.
      const failure = attempt.failure;
      const pos = failure.pos as number;
      const relLine = (failure.loc?.line as number) - prefixLines;
      const relColumn = failure.loc?.column as number;
      throw new MdxGrammarError("Could not parse import/exports with acorn", {
        line: startPoint.line + relLine - 1,
        column: (relLine === 1 ? startPoint.column - 1 : 0) + relColumn + 1,
        offset: startPoint.offset + (pos - attempt.prefix.length),
      });
    }
    const program = attempt.program;
    const delta = startPoint.offset - attempt.prefix.length;
    const lineDelta = startPoint.line - 1 - prefixLines;
    rebaseEstree(program, delta, lineDelta);
    rebaseEstree(attempt.comments, delta, lineDelta);
    if (attempt.prefix.length > 0) {
      program.body.shift(); // drop the `var` prefix declaration (as stock)
    }
    program.start = startPoint.offset;
    program.end = startPoint.offset + attempt.source.length;
    (program as Program & { comments: Comment[] }).comments = attempt.comments;
    for (const statement of program.body) {
      if (!ALLOWED_ESM_TYPES.has(statement.type)) {
        throw new MdxGrammarError(
          "Unexpected `" +
            statement.type +
            "` in code: only import/exports are supported",
          {
            start: {
              line: statement.loc?.start.line,
              column:
                statement.loc === undefined || statement.loc === null
                  ? undefined
                  : statement.loc.start.column + 1,
              offset: statement.start,
            },
            end: {
              line: statement.loc?.end.line,
              column:
                statement.loc === undefined || statement.loc === null
                  ? undefined
                  : statement.loc.end.column + 1,
              offset: statement.end,
            },
          },
        );
      }
      if (statement.type === "ImportDeclaration" && self.interrupt !== true) {
        for (const specifier of statement.specifiers) {
          defined.push(specifier.local.name);
        }
      }
    }
    Object.assign(effects.exit("mdxjsEsm"), { estree: program });
    return ok(code);
  }
}

// ---------------------------------------------------------------------------
// Grammar widening 3: flat section-tag pairing (SPEC 1.1, 3, 6.5 → 14.20)
// ---------------------------------------------------------------------------

/**
 * Structural view of mdast-util-from-markdown's compile context (verified
 * against mdast-util-from-markdown 2): the members the flat-tag handlers
 * use. `data.mdxJsxTag` is the tag snapshot the stock mdast-util-mdx-jsx
 * handlers (which stay registered) accumulate per tag token.
 */
interface FromMarkdownContextLike {
  readonly data: {
    mdxJsxTag?: {
      readonly name?: string | null;
      readonly close?: boolean;
      readonly selfClosing?: boolean;
      readonly attributes?: readonly MdxAttributeNode[];
    };
  };
  resume(): unknown;
  enter(node: object, token: object): unknown;
  exit(token: object): unknown;
}

/**
 * Replacement for the stock `exitMdxJsxTag`: instead of pairing tags into
 * `mdxJsxFlowElement`/`mdxJsxTextElement` nodes within one construct —
 * which rejects a section opened with trailing same-line content and
 * closed on a later line, and content directly preceding a closing tag —
 * every tag token becomes one `xspecJsxTag` leaf node carrying the tag's
 * name, kind, and attributes at the token's exact source positions. The
 * document builder pairs the leaves across construct boundaries
 * (SPEC 14.20 widening 3) and reports unclosed or mismatched tags as
 * parse failures.
 */
function exitFlatJsxTag(this: FromMarkdownContextLike, token: object): void {
  const tag = this.data.mdxJsxTag;
  if (tag === undefined) {
    throw new Error("xspec internal error: JSX tag exit without tag state");
  }
  this.resume(); // drop the tag's text buffer, as the stock handler does
  this.enter(
    {
      type: "xspecJsxTag",
      name: tag.name ?? null,
      close: tag.close === true,
      selfClosing: tag.selfClosing === true,
      attributes: tag.attributes ?? [],
      children: [],
    },
    token,
  );
  this.exit(token);
}

/**
 * Replacement for the stock `enterMdxJsxTagClosingMarker`, which throws on
 * a closing tag with no same-construct open element; pairing (and the
 * corresponding failure) is the document builder's.
 */
function ignoreClosingMarker(): void {
  // Intentionally empty.
}

/**
 * The fromMarkdown override. Registered after mdast-util-mdx-jsx's
 * extension, so these handlers replace the stock ones per token type
 * (mdast-util-from-markdown merges `enter`/`exit` maps by assignment,
 * later extensions winning) while every other stock handler — tag names,
 * attributes and their decoded values, expression attributes — stays.
 * Handlers that reject genuinely malformed tags (attributes or a
 * self-closing slash in a closing tag) also stay, so those remain parse
 * failures (SPEC 14.20).
 */
const flatJsxTagExtension = {
  enter: {
    mdxJsxFlowTagClosingMarker: ignoreClosingMarker,
    mdxJsxTextTagClosingMarker: ignoreClosingMarker,
  },
  exit: {
    mdxJsxFlowTag: exitFlatJsxTag,
    mdxJsxTextTag: exitFlatJsxTag,
  },
};

/**
 * Register the grammar widenings. Placed after `remarkMdx` deliberately:
 * micromark's `combineExtensions` splices a later extension's constructs
 * *before* earlier ones at the same character (verified against
 * micromark 4), so `widenedEsmConstruct` is attempted before — and fully
 * shadows — the stock ESM construct at `e`/`i`, and the fromMarkdown
 * merge above replaces the stock tag handlers.
 */
function xspecGrammarWidenings(this: { data(): unknown }): void {
  const data = this.data() as {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
  (data.micromarkExtensions ??= []).push({
    flow: {
      101: widenedEsmConstruct, // `e`
      105: widenedEsmConstruct, // `i`
    },
  });
  (data.fromMarkdownExtensions ??= []).push(flatJsxTagExtension);
}

/**
 * The MDX parser (IMPLEMENTATION: remark-mdx defines well-formed MDX,
 * SPEC 14.20 — with the grammar widened per `xspecAcornExtension`,
 * `widenedEsmConstruct`, and `flatJsxTagExtension` above). Frozen once;
 * `parse` is pure.
 */
const mdxParser = unified()
  .use(remarkParse)
  .use(remarkMdx, { acorn: specAcorn })
  .use(xspecGrammarWidenings)
  .freeze();

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse one discovered spec source into its document model (SPEC 1, 2).
 * `path` is the workspace-relative `/`-separated path (SPEC 1.5); `bytes`
 * the file's exact content. An unparseable file — BOM, invalid UTF-8
 * (SPEC 1.6), or not well-formed MDX — yields the single 14.20 finding that
 * masks the conditions inside it (SPEC 14).
 */
export function parseSpecSource(
  path: string,
  bytes: Uint8Array,
): SpecSourceResult {
  const decoded = decodeSourceBytes(path, bytes);
  if (!decoded.ok) {
    return { kind: "unparseable", finding: decoded.finding };
  }
  const text = decoded.text;
  const offsets = new Utf8Offsets(text);

  let tree: MdxTreeNode;
  try {
    // SPEC 14.20: remark-mdx's grammar defines well-formed MDX.
    tree = mdxParser.parse(text) as unknown as MdxTreeNode;
  } catch (error) {
    return {
      kind: "unparseable",
      finding: parseFailureFinding(path, error, text, offsets),
    };
  }

  const builder = new DocumentBuilder(path, text, offsets);
  try {
    builder.walk(tree);
    builder.finishTags();
  } catch (error) {
    if (error instanceof MdxGrammarError) {
      // A tag-pairing failure (SPEC 14.20 widening 3): unclosed or
      // mismatched tags make the file unparseable, masking its contents.
      return {
        kind: "unparseable",
        finding: parseFailureFinding(path, error, text, offsets),
      };
    }
    throw error;
  }
  builder.validateStructure();
  return { kind: "document", document: builder.finish() };
}

/** The 14.20 finding for a thrown MDX parse failure, with its location. */
function parseFailureFinding(
  path: string,
  error: unknown,
  text: string,
  offsets: Utf8Offsets,
): Finding {
  const failure = (
    typeof error === "object" && error !== null ? error : {}
  ) as ParseFailureLike;
  const reason =
    typeof failure.reason === "string"
      ? failure.reason
      : typeof failure.message === "string"
        ? failure.message
        : String(error);

  // A VFileMessage's `place` is a point ({line, column, offset}) or a
  // position ({start, end}); either way the offsets are UTF-16 indices.
  let range: ByteRange | undefined;
  let line: number | undefined;
  let column: number | undefined;
  const place = failure.place as
    (MdxPoint & Partial<MdxPosition>) | null | undefined;
  const startPoint: MdxPoint | undefined =
    place == null ? undefined : (place.start ?? place);
  const endPoint: MdxPoint | undefined =
    place == null ? undefined : (place.end ?? place);
  if (startPoint !== undefined && typeof startPoint.offset === "number") {
    range = pointRange(startPoint.offset, endPoint?.offset, text, offsets);
  }
  if (typeof failure.line === "number") {
    line = failure.line;
  } else if (startPoint !== undefined && typeof startPoint.line === "number") {
    line = startPoint.line;
  }
  if (typeof failure.column === "number") {
    column = failure.column;
  } else if (
    startPoint !== undefined &&
    typeof startPoint.column === "number"
  ) {
    column = startPoint.column;
  }

  const where =
    line !== undefined
      ? ` at line ${String(line)}${column !== undefined ? `, column ${String(column)}` : ""}`
      : "";
  const finding: Finding = {
    condition: 20,
    file: path,
    message:
      `unparseable source: not well-formed MDX${where} — ${reason}. ` +
      `Correct the syntax at the reported location (SPEC 14.20)`,
    ...(range !== undefined ? { range } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
  return finding;
}

/** A byte range from a parse failure's UTF-16 point (and optional end). */
function pointRange(
  startIndex: number,
  endIndex: number | undefined,
  text: string,
  offsets: Utf8Offsets,
): ByteRange {
  const clamp = (index: number): number =>
    Math.max(0, Math.min(text.length, index));
  const start = clamp(startIndex);
  let end: number;
  if (endIndex !== undefined && clamp(endIndex) > start) {
    end = clamp(endIndex);
  } else if (start < text.length) {
    const codePoint = text.codePointAt(start)!;
    end = start + (codePoint > 0xffff ? 2 : 1);
  } else {
    end = start;
  }
  return { start: offsets.byteOffset(start), end: offsets.byteOffset(end) };
}

// ---------------------------------------------------------------------------
// Segment and tag validity (SPEC 1.4)
// ---------------------------------------------------------------------------

/**
 * Why `value` violates SPEC 1.4 as an ID segment or a tag (`"."` allowed in
 * tags only), or null when valid. Segments arrive from splitting an ID on
 * `"."`, so the segment path never sees a `"."`.
 */
function valueViolation(value: string, kind: "segment" | "tag"): string | null {
  if (value.length === 0) {
    return "it is empty (SPEC 1.4: segments are non-empty)";
  }
  if (FORBIDDEN_SEGMENT_NAMES.has(value)) {
    return `${JSON.stringify(value)} is a forbidden name (SPEC 1.4)`;
  }
  if (kind === "segment" && value.includes(".")) {
    return 'it contains "." (SPEC 1.4)';
  }
  if (value.includes("#")) {
    return 'it contains "#" (SPEC 1.4)';
  }
  if (containsWhitespace(value)) {
    return "it contains whitespace (SPEC 1.4)";
  }
  if (containsControl(value)) {
    return "it contains a control character (SPEC 1.4)";
  }
  return null;
}

/**
 * SPEC 2.6: split a `tags` value on runs of SPEC 1.4 whitespace, ignoring
 * leading and trailing whitespace, and collapse duplicates keeping
 * first-occurrence order. A value yielding no tags is equivalent to an
 * omitted prop.
 */
export function splitTags(value: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  let start = -1;
  for (let index = 0; index <= value.length; index += 1) {
    const isSeparator =
      index === value.length || isWhitespaceCodePoint(value.charCodeAt(index));
    if (isSeparator) {
      if (start !== -1) {
        const token = value.slice(start, index);
        if (!seen.has(token)) {
          seen.add(token);
          tokens.push(token);
        }
        start = -1;
      }
    } else if (start === -1) {
      start = index;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// The document builder
// ---------------------------------------------------------------------------

/** The mutable section shape used during construction. */
interface MutableSection {
  id: string | null;
  range: ByteRange;
  openingTagRange: ByteRange;
  closingTagRange: ByteRange;
  selfClosing: boolean;
  parent: MutableSection | null;
  children: MutableSection[];
  coverage: "required" | "none" | null;
  tags: readonly string[];
  idAttribute: SpecAttributeValue | null;
  dependency: SpecDependencyAttribute | null;
  /** Whether an `id` prop occurred at all (14.1 is only for absence). */
  idPresent: boolean;
}

/** One open tag awaiting its closing tag during the walk. */
interface OpenTagFrame {
  /** The tag's name — null for a fragment. */
  readonly name: string | null;
  /** UTF-16 span of the opening tag. */
  readonly span: { readonly start: number; readonly end: number };
  /** The opening tag's position (failure reporting). */
  readonly position: MdxPosition;
  /** The section the tag opened, or null for a non-section element. */
  readonly section: MutableSection | null;
}

class DocumentBuilder {
  readonly root: MutableSection;
  private readonly sections: MutableSection[] = [];
  private readonly esmBlocks: SpecEsmBlock[] = [];
  private readonly embeddings: SpecEmbedding[] = [];
  private readonly comments: SpecComment[] = [];
  private readonly findings: Finding[] = [];
  private readonly tagStack: OpenTagFrame[] = [];

  constructor(
    private readonly path: string,
    private readonly text: string,
    private readonly offsets: Utf8Offsets,
  ) {
    // SPEC 1.2: the implicit root represents the entire document and
    // precedes every section; SPEC 1.7: its range is the entire file. Its
    // zero-width tag ranges make tag-removal rules no-ops for it.
    this.root = {
      id: null,
      range: { start: 0, end: offsets.byteLength },
      openingTagRange: { start: 0, end: 0 },
      closingTagRange: { start: offsets.byteLength, end: offsets.byteLength },
      selfClosing: false,
      parent: null,
      children: [],
      coverage: null,
      tags: [],
      idAttribute: null,
      dependency: null,
      idPresent: false,
    };
  }

  /** Byte range of a UTF-16 index span. */
  private byteRange(start: number, end: number): ByteRange {
    return {
      start: this.offsets.byteOffset(start),
      end: this.offsets.byteOffset(end),
    };
  }

  private addFinding(
    condition: ConditionNumber,
    range: ByteRange,
    message: string,
  ): void {
    this.findings.push({ condition, message, file: this.path, range });
  }

  /** The node's UTF-16 span; every parsed mdast node carries one. */
  private spanOf(node: { readonly position?: MdxPosition }): {
    start: number;
    end: number;
  } {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error("xspec internal error: MDX node without a position");
    }
    return { start, end };
  }

  /**
   * Walk the mdast tree in document order: requirement sections nest by
   * document containment, whatever Markdown structure lies between (SPEC
   * 1.1–1.3). Under grammar widening 3 every `<S>`/`<Spec>` (and other
   * JSX) tag arrives as a flat `xspecJsxTag` leaf; this walk pairs them
   * on a stack, so a section opened with trailing same-line content may
   * close on a later line, and content may directly precede a closing
   * tag on its line (SPEC 14.20).
   */
  walk(node: MdxTreeNode): void {
    switch (node.type) {
      case "xspecJsxTag": {
        this.handleTag(node);
        return;
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        // flatJsxTagExtension replaces element construction wholesale.
        throw new Error(
          "xspec internal error: unflattened JSX element in the MDX tree",
        );
      }
      case "mdxFlowExpression":
      case "mdxTextExpression": {
        this.classifyExpression(node, this.currentSection());
        return;
      }
      case "mdxjsEsm": {
        this.processEsm(node);
        return;
      }
      default: {
        for (const child of node.children ?? []) {
          this.walk(child);
        }
        return;
      }
    }
  }

  /** The innermost section whose opening tag is still open (SPEC 1.1). */
  private currentSection(): MutableSection {
    for (let index = this.tagStack.length - 1; index >= 0; index -= 1) {
      const section = this.tagStack[index].section;
      if (section !== null) {
        return section;
      }
    }
    return this.root;
  }

  /** The node's position; every parsed mdast node carries one. */
  private positionOf(node: MdxTreeNode): MdxPosition {
    const position = node.position;
    if (position === undefined) {
      throw new Error("xspec internal error: MDX node without a position");
    }
    return position;
  }

  /**
   * One flat tag leaf (SPEC 14.20 widening 3): `<S>`/`<Spec>` tags build
   * the section tree (SPEC 1.1); any other element is invalid (SPEC 2.7
   * → 14.16) but participates in pairing all the same. An unmatched or
   * mismatched tag is a parse failure, keeping genuinely malformed
   * sources 14.20-unparseable exactly as under the stock grammar.
   */
  private handleTag(node: MdxTreeNode): void {
    const span = this.spanOf(node);
    const name = node.name ?? null;
    if (node.close === true) {
      const frame = this.tagStack.pop();
      if (frame === undefined) {
        throw new MdxGrammarError(
          `Unexpected closing tag \`</${name ?? ""}>\`, expected an open ` +
            `tag first`,
          this.positionOf(node),
        );
      }
      if (frame.name !== name) {
        throw new MdxGrammarError(
          `Unexpected closing tag \`</${name ?? ""}>\`, expected ` +
            `corresponding closing tag for \`<${frame.name ?? ""}>\``,
          this.positionOf(node),
        );
      }
      if (frame.section !== null) {
        // SPEC 1.7: the construct's own characters end with the last
        // character of its closing tag.
        frame.section.closingTagRange = this.byteRange(span.start, span.end);
        frame.section.range = this.byteRange(frame.span.start, span.end);
      } else {
        this.reportForeignElement(frame.name, frame.span.start, span.end);
      }
      return;
    }
    if (name === "S" || name === "Spec") {
      // SPEC 1.1: `<S>` and `<Spec>` are equivalent requirement sections
      // (compared byte-wise, SPEC 12.0 — no other casing).
      const section = this.buildSection(node, span);
      if (node.selfClosing !== true) {
        this.tagStack.push({
          name,
          span,
          position: this.positionOf(node),
          section,
        });
      }
      return;
    }
    // SPEC 2.7 → 14.16: any other JSX element is invalid — reported once
    // per element when it pairs (or immediately when self-closing).
    if (node.selfClosing === true) {
      this.reportForeignElement(name, span.start, span.end);
      return;
    }
    this.tagStack.push({
      name,
      span,
      position: this.positionOf(node),
      section: null,
    });
  }

  /** SPEC 2.7 → 14.16: a JSX element other than `<S>`/`<Spec>`. */
  private reportForeignElement(
    name: string | null,
    startIndex: number,
    endIndex: number,
  ): void {
    const label = name === null ? "a JSX fragment" : `JSX element <${name}>`;
    this.addFinding(
      16,
      this.byteRange(startIndex, endIndex),
      `invalid construct: ${label} — beyond Markdown content, only ` +
        `spec-module imports, <S>/<Spec> sections, {text(...)} ` +
        `embeddings, and MDX comments are permitted; remove it ` +
        `(SPEC 2.7, 14.16)`,
    );
  }

  /**
   * After the walk: every opened tag must have closed — an unclosed
   * element is a parse failure (SPEC 14.20), as under the stock grammar.
   */
  finishTags(): void {
    const frame = this.tagStack[this.tagStack.length - 1];
    if (frame !== undefined) {
      throw new MdxGrammarError(
        `Expected a closing tag for \`<${frame.name ?? ""}>\` before the ` +
          `end of the file`,
        frame.position,
      );
    }
  }

  /**
   * SPEC 2.7: an expression container is a `{text(...)}` embedding (2.3),
   * an MDX comment, or invalid (14.16).
   */
  private classifyExpression(node: MdxTreeNode, section: MutableSection): void {
    const span = this.spanOf(node);
    const range = this.byteRange(span.start, span.end);
    const program = node.data?.estree;
    const body = program?.body ?? [];
    if (program !== undefined && body.length === 0) {
      if ((program.comments ?? []).length > 0) {
        // An MDX comment (`{/* … */}`): a pure annotation (SPEC 2.7).
        this.comments.push({ section, range });
        return;
      }
      this.addFinding(
        16,
        range,
        `invalid construct: an empty expression container — beyond ` +
          `Markdown content, only spec-module imports, <S>/<Spec> ` +
          `sections, {text(...)} embeddings, and MDX comments are ` +
          `permitted; remove it (SPEC 2.7, 14.16)`,
      );
      return;
    }
    const statement = body.length === 1 ? body[0] : undefined;
    const expression =
      statement !== undefined && statement.type === "ExpressionStatement"
        ? statement.expression
        : undefined;
    if (
      expression !== undefined &&
      expression.type === "CallExpression" &&
      expression.callee !== undefined &&
      expression.callee.type === "Identifier" &&
      expression.callee.name === "text"
    ) {
      // A `{text(...)}` embedding (SPEC 2.3). Its argument is analyzed by
      // the static-reference analyzer (SPEC 2.4 → 14.8), not here; `text`
      // is always the compiler-provided name — imports never bind it
      // (SPEC 2.1).
      this.embeddings.push({
        section,
        range,
        expressionText: this.text.slice(span.start + 1, span.end - 1),
        expressionRange: this.byteRange(span.start + 1, span.end - 1),
      });
      return;
    }
    this.addFinding(
      16,
      range,
      `invalid construct: an expression container that is neither a ` +
        `{text(...)} embedding nor an MDX comment — remove it or replace ` +
        `it with a permitted construct (SPEC 2.7, 14.16)`,
    );
  }

  /**
   * One top-level ESM block: record import declarations for import
   * validation and reference analysis (SPEC 2.1); any export statement is
   * invalid (SPEC 2.7 → 14.16). MDX admits no other statement kind here.
   */
  private processEsm(node: MdxTreeNode): void {
    const span = this.spanOf(node);
    const imports: SpecImportStatement[] = [];
    for (const statement of node.data?.estree?.body ?? []) {
      const start = statement.start;
      const end = statement.end;
      if (typeof start !== "number" || typeof end !== "number") {
        throw new Error(
          "xspec internal error: ESM statement without a position",
        );
      }
      if (statement.type === "ImportDeclaration") {
        imports.push({
          range: this.byteRange(start, end),
          text: this.text.slice(start, end),
        });
      } else {
        this.addFinding(
          16,
          this.byteRange(start, end),
          `invalid construct: an export statement — xspec source files ` +
            `export nothing; remove it (SPEC 2.7, 14.16)`,
        );
      }
    }
    this.esmBlocks.push({
      range: this.byteRange(span.start, span.end),
      imports,
    });
  }

  // -------------------------------------------------------------------------
  // Sections and props
  // -------------------------------------------------------------------------

  /**
   * Build one `<S>`/`<Spec>` section from its opening (or self-closing)
   * tag leaf, with validated props (SPEC 1.1, 2.5–2.7). The tag token
   * covers the tag's exact characters, so the opening-tag range is the
   * leaf's span; for a paired section, the closing-tag range and the
   * construct range (SPEC 1.7) are completed when its closing tag pairs.
   */
  private buildSection(
    node: MdxTreeNode,
    span: { start: number; end: number },
  ): MutableSection {
    // SPEC 1.1: a self-closing section element is an empty leaf; its tag
    // is the whole construct (SPEC 1.7).
    const selfClosing = node.selfClosing === true;
    const parent = this.currentSection();
    const section: MutableSection = {
      id: null,
      // SPEC 1.7: opening tag through closing tag, or the self-closing
      // tag's own characters (paired sections are completed above).
      range: this.byteRange(span.start, span.end),
      openingTagRange: this.byteRange(span.start, span.end),
      closingTagRange: this.byteRange(span.start, span.end),
      selfClosing,
      parent,
      children: [],
      coverage: "required", // SPEC 2.5: the default
      tags: [],
      idAttribute: null,
      dependency: null,
      idPresent: false,
    };
    this.processAttributes(node, section);
    parent.children.push(section);
    this.sections.push(section);
    return section;
  }

  /** Validate and record one section element's props (SPEC 2.5–2.7). */
  private processAttributes(node: MdxTreeNode, section: MutableSection): void {
    const seen = new Set<string>();
    let idUnusable = false;
    for (const attribute of node.attributes ?? []) {
      const attrSpan = this.spanOf(attribute);
      const attrRange = this.byteRange(attrSpan.start, attrSpan.end);
      if (attribute.type !== "mdxJsxAttribute") {
        // SPEC 2.7 → 14.17: every prop is a named attribute; a spread
        // attribute is invalid.
        this.addFinding(
          17,
          attrRange,
          `invalid prop: a spread attribute on <S>/<Spec> — every prop is ` +
            `a named attribute; spell out id, d, coverage, or tags ` +
            `(SPEC 2.7, 14.17)`,
        );
        continue;
      }
      const name = attribute.name ?? "";
      if (seen.has(name)) {
        // SPEC 2.7 → 14.17: no prop name may occur more than once on one
        // element — defined or unknown.
        this.addFinding(
          17,
          attrRange,
          `invalid prop: the prop ${JSON.stringify(name)} is repeated on ` +
            `one element — no prop name may occur more than once; remove ` +
            `the repetition (SPEC 2.7, 14.17)`,
        );
        if (name === "id") {
          idUnusable = true; // ambiguous declaration — no usable ID
        }
        continue;
      }
      seen.add(name);
      if (name === "d") {
        this.processDependencyProp(attribute, attrSpan, section);
      } else if (name === "id" || name === "coverage" || name === "tags") {
        this.processStringProp(name, attribute, attrSpan, section, () => {
          idUnusable = true;
        });
      } else {
        // SPEC 2.7 → 14.17: the props defined on <S>/<Spec> are id, d,
        // coverage, and tags.
        this.addFinding(
          17,
          attrRange,
          `invalid prop: unknown prop ${JSON.stringify(name)} on ` +
            `<S>/<Spec> — the defined props are id, d, coverage, and ` +
            `tags; remove it (SPEC 2.7, 14.17)`,
        );
      }
    }
    if (idUnusable) {
      section.id = null;
      section.idAttribute = null;
    }
  }

  /** SPEC 2.7: `d` MUST be a braced expression; record its span for 2.2/2.4. */
  private processDependencyProp(
    attribute: MdxAttributeNode,
    attrSpan: { start: number; end: number },
    section: MutableSection,
  ): void {
    const attrRange = this.byteRange(attrSpan.start, attrSpan.end);
    const value = attribute.value ?? null;
    if (value === null || typeof value === "string") {
      // SPEC 2.7 → 14.17: a quoted or valueless `d` is invalid.
      this.addFinding(
        17,
        attrRange,
        `invalid prop: the d prop must be a braced expression holding a ` +
          `static reference or an array literal of static references — ` +
          `e.g. d={BASE.auth.login} or d={["local.id"]} — not ` +
          `${value === null ? "a valueless prop" : "a quoted string"} ` +
          `(SPEC 2.7, 2.2, 14.17)`,
      );
      return;
    }
    const open = this.valueOpenIndex(attribute, attrSpan);
    if (open === null || this.text[open] !== "{") {
      throw new Error(
        "xspec internal error: braced d value without a brace in source",
      );
    }
    section.dependency = {
      expressionText: this.text.slice(open + 1, attrSpan.end - 1),
      expressionRange: this.byteRange(open + 1, attrSpan.end - 1),
      attributeRange: attrRange,
    };
  }

  /**
   * SPEC 2.7: the value of `id`, `coverage`, and `tags` MUST be a static
   * string literal in quoted attribute form. Validates the value and
   * records it on the section (SPEC 1.3, 2.5, 2.6 → 14.4, 14.17).
   */
  private processStringProp(
    name: "id" | "coverage" | "tags",
    attribute: MdxAttributeNode,
    attrSpan: { start: number; end: number },
    section: MutableSection,
    onIdUnusable: () => void,
  ): void {
    const attrRange = this.byteRange(attrSpan.start, attrSpan.end);
    if (name === "id") {
      section.idPresent = true;
    }
    const value = attribute.value ?? null;
    if (typeof value !== "string") {
      // SPEC 2.7 → 14.17: braced (e.g. id={"login"}) and valueless forms
      // are invalid for id, coverage, and tags.
      this.addFinding(
        17,
        attrRange,
        `invalid prop: the ${name} value must be a static string literal ` +
          `in quoted attribute form, single- or double-quoted — e.g. ` +
          `${name}="…" — not ` +
          `${value === null ? "a valueless prop" : "a braced expression"} ` +
          `(SPEC 2.7, 14.17)`,
      );
      if (name === "id") {
        onIdUnusable();
      }
      return;
    }
    const open = this.valueOpenIndex(attribute, attrSpan);
    const quoteCharacter = open === null ? null : this.text[open];
    if (
      open === null ||
      (quoteCharacter !== '"' && quoteCharacter !== "'") ||
      this.text[attrSpan.end - 1] !== quoteCharacter
    ) {
      throw new Error(
        "xspec internal error: quoted attribute value without quotes",
      );
    }
    // The raw characters between the quotes. MDX replaces U+0000 with
    // U+FFFD while decoding, so the control-character rule of SPEC 1.4 is
    // checked against the raw characters as authored.
    const rawValue = this.text.slice(open + 1, attrSpan.end - 1);
    const rawHasNul = rawValue.includes("\u0000");

    if (name === "coverage") {
      // SPEC 2.5/2.7 → 14.17: the only defined values are "required"
      // (the default) and "none".
      if (value !== "required" && value !== "none") {
        this.addFinding(
          17,
          attrRange,
          `invalid prop: coverage value ${JSON.stringify(value)} — the ` +
            `only defined values are "required" (the default) and "none" ` +
            `(SPEC 2.5, 2.7, 14.17)`,
        );
        return;
      }
      section.coverage = value;
      return;
    }

    if (name === "tags") {
      // SPEC 2.6: whitespace splitting, duplicate collapse; a value
      // yielding no tags is equivalent to omitting the prop.
      const tags = splitTags(value);
      section.tags = tags;
      if (rawHasNul) {
        // SPEC 1.4 → 14.4: U+0000 is a control character.
        this.addFinding(
          4,
          attrRange,
          `invalid tag: the tags value contains the control character ` +
            `U+0000 — tags contain no control characters; remove it ` +
            `(SPEC 1.4, 2.6, 14.4)`,
        );
      }
      for (const tag of tags) {
        const violation = valueViolation(tag, "tag");
        if (violation !== null) {
          this.addFinding(
            4,
            attrRange,
            `invalid tag ${JSON.stringify(tag)}: ${violation} — tags ` +
              `follow the ID-segment rules with "." allowed; correct or ` +
              `remove the tag (SPEC 1.4, 2.6, 14.4)`,
          );
        }
      }
      return;
    }

    // name === "id" (SPEC 1.3): record the declared ID and validate its
    // segments (SPEC 1.4 → 14.4); the structural checks (14.1–14.3) run in
    // validateStructure once the tree is complete.
    section.id = value;
    section.idAttribute = {
      value,
      valueRange: this.byteRange(open + 1, attrSpan.end - 1),
      quote: quoteCharacter,
      attributeRange: attrRange,
    };
    if (rawHasNul) {
      // SPEC 1.4 → 14.4: U+0000 is a control character.
      this.addFinding(
        4,
        attrRange,
        `invalid segment: the id value contains the control character ` +
          `U+0000 — segments contain no control characters; remove it ` +
          `(SPEC 1.4, 14.4)`,
      );
    }
    for (const segment of value.split(".")) {
      const violation = valueViolation(segment, "segment");
      if (violation !== null) {
        this.addFinding(
          4,
          attrRange,
          `invalid segment ${JSON.stringify(segment)} in id ` +
            `${JSON.stringify(value)}: ${violation} — correct the segment ` +
            `(SPEC 1.4, 14.4)`,
        );
      }
    }
  }

  /**
   * The UTF-16 index of the character opening an attribute's value (its
   * quote or brace): the first non-whitespace character after the `=`
   * following the attribute name. Null for a valueless attribute.
   */
  private valueOpenIndex(
    attribute: MdxAttributeNode,
    attrSpan: { start: number; end: number },
  ): number | null {
    let index = attrSpan.start + (attribute.name ?? "").length;
    while (
      index < attrSpan.end &&
      isWhitespaceCodePoint(this.text.charCodeAt(index))
    ) {
      index += 1;
    }
    if (index >= attrSpan.end || this.text[index] !== "=") {
      return null;
    }
    index += 1;
    while (
      index < attrSpan.end &&
      isWhitespaceCodePoint(this.text.charCodeAt(index))
    ) {
      index += 1;
    }
    return index < attrSpan.end ? index : null;
  }

  // -------------------------------------------------------------------------
  // Structural validation (SPEC 1.3 → 14.1–14.3)
  // -------------------------------------------------------------------------

  /**
   * SPEC 1.3: every non-root section has an `id` (14.1); IDs are structural
   * paths — a child ID equals the parent ID plus `"."` plus exactly one
   * segment, compared as segment sequences, a top-level section checked
   * against the empty prefix (14.2); IDs are unique within a file (14.3).
   *
   * Masking (SPEC 14.2): the structural check needs the parent's ID — for
   * the immediate children of a section without a usable ID it is masked,
   * while their other conditions, and the check for their own children
   * (against their declared IDs), report normally.
   */
  validateStructure(): void {
    const seen = new Set<string>();
    for (const section of this.sections) {
      if (!section.idPresent) {
        // SPEC 1.3 → 14.1: a non-root section without `id`.
        this.addFinding(
          1,
          section.openingTagRange,
          `missing ID: every non-root section must have an id prop — add ` +
            `one, e.g. <S id="…"> (SPEC 1.3, 14.1)`,
        );
      }
      if (section.id === null) {
        // No usable ID (missing, repeated, or invalid form — each already
        // reported): the structural and duplicate checks cannot run.
        continue;
      }
      const location = section.idAttribute?.attributeRange ?? section.range;
      const parent = section.parent;
      if (parent !== null && (parent.parent === null || parent.id !== null)) {
        const parentSegments =
          parent.parent === null ? [] : parent.id!.split(".");
        const segments = section.id.split(".");
        // SPEC 1.3: segment sequences — the parent's segments plus exactly
        // one more (an empty added segment is a 1.4 matter, not
        // structural); IDs that skip levels are invalid (14.2).
        const structural =
          segments.length === parentSegments.length + 1 &&
          parentSegments.every((segment, index) => segments[index] === segment);
        if (!structural) {
          // SPEC 14.2: the error states the expected form.
          this.addFinding(
            2,
            location,
            parent.parent === null
              ? `invalid structural ID ${JSON.stringify(section.id)}: a ` +
                  `top-level section's ID is checked against the empty ` +
                  `prefix and is exactly one segment (SPEC 1.3, 14.2)`
              : `invalid structural ID ${JSON.stringify(section.id)}: a ` +
                  `child ID equals its parent's ID plus "." plus exactly ` +
                  `one segment — expected the form "${parent.id!}.` +
                  `<segment>" (SPEC 1.3, 14.2)`,
          );
        }
      }
      if (seen.has(section.id)) {
        // SPEC 1.3 → 14.3: IDs unique within a source file; reported at
        // each repeated occurrence.
        this.addFinding(
          3,
          location,
          `duplicate ID ${JSON.stringify(section.id)}: IDs must be unique ` +
            `within a source file — rename one of the sections ` +
            `(SPEC 1.3, 14.3)`,
        );
      } else {
        seen.add(section.id);
      }
    }
  }

  /** The completed, deterministic document model. */
  finish(): SpecDocument {
    // Deterministic report order (SPEC 12.0): by location, then condition.
    const sorted = [...this.findings].sort(
      (a, b) =>
        (a.range?.start ?? 0) - (b.range?.start ?? 0) ||
        (a.range?.end ?? 0) - (b.range?.end ?? 0) ||
        a.condition - b.condition,
    );
    return {
      path: this.path,
      text: this.text,
      offsets: this.offsets,
      root: this.root,
      sections: this.sections,
      esmBlocks: this.esmBlocks,
      embeddings: this.embeddings,
      comments: this.comments,
      findings: sorted,
    };
  }
}
