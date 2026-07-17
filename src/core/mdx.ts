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
 * The MDX parser (IMPLEMENTATION: remark-mdx defines well-formed MDX,
 * SPEC 14.20). Frozen once; `parse` is pure.
 */
const mdxParser = unified().use(remarkParse).use(remarkMdx).freeze();

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
  builder.walk(tree, builder.root);
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

/** SPEC 1.4: the five forbidden segment (and tag) names. */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  "$",
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

/**
 * Why `value` violates SPEC 1.4 as an ID segment or a tag (`"."` allowed in
 * tags only), or null when valid. Segments arrive from splitting an ID on
 * `"."`, so the segment path never sees a `"."`.
 */
function valueViolation(value: string, kind: "segment" | "tag"): string | null {
  if (value.length === 0) {
    return "it is empty (SPEC 1.4: segments are non-empty)";
  }
  if (FORBIDDEN_NAMES.has(value)) {
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

class DocumentBuilder {
  readonly root: MutableSection;
  private readonly sections: MutableSection[] = [];
  private readonly esmBlocks: SpecEsmBlock[] = [];
  private readonly embeddings: SpecEmbedding[] = [];
  private readonly comments: SpecComment[] = [];
  private readonly findings: Finding[] = [];

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
   * Walk the mdast tree under `section`, the innermost enclosing section:
   * requirement sections nest by document containment, whatever Markdown
   * structure lies between (SPEC 1.1–1.3).
   */
  walk(node: MdxTreeNode, section: MutableSection): void {
    switch (node.type) {
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        const name = node.name ?? null;
        if (name === "S" || name === "Spec") {
          // SPEC 1.1: `<S>` and `<Spec>` are equivalent requirement
          // sections (compared byte-wise, SPEC 12.0 — no other casing).
          const child = this.buildSection(node, section);
          for (const grandchild of node.children ?? []) {
            this.walk(grandchild, child);
          }
        } else {
          // SPEC 2.7 → 14.16: any other JSX element is invalid.
          const span = this.spanOf(node);
          const label =
            name === null ? "a JSX fragment" : `JSX element <${name}>`;
          this.addFinding(
            16,
            this.byteRange(span.start, span.end),
            `invalid construct: ${label} — beyond Markdown content, only ` +
              `spec-module imports, <S>/<Spec> sections, {text(...)} ` +
              `embeddings, and MDX comments are permitted; remove it ` +
              `(SPEC 2.7, 14.16)`,
          );
          for (const grandchild of node.children ?? []) {
            this.walk(grandchild, section);
          }
        }
        return;
      }
      case "mdxFlowExpression":
      case "mdxTextExpression": {
        this.classifyExpression(node, section);
        return;
      }
      case "mdxjsEsm": {
        this.processEsm(node);
        return;
      }
      default: {
        for (const child of node.children ?? []) {
          this.walk(child, section);
        }
        return;
      }
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

  /** Build one `<S>`/`<Spec>` section node with validated props. */
  private buildSection(
    node: MdxTreeNode,
    parent: MutableSection,
  ): MutableSection {
    const span = this.spanOf(node);
    const openingTagEnd = this.openingTagEnd(node, span);
    // SPEC 1.1: a self-closing section element is an empty leaf. The
    // element is self-closing exactly when its opening tag is the whole
    // construct — a paired element continues past its opening tag's `>`.
    const selfClosing = openingTagEnd === span.end;
    const closingTagStart = selfClosing
      ? span.start
      : this.text.lastIndexOf("</", span.end - 2);
    if (closingTagStart < span.start) {
      throw new Error("xspec internal error: section closing tag not found");
    }

    const section: MutableSection = {
      id: null,
      // SPEC 1.7: opening tag through closing tag, or the self-closing
      // tag's own characters.
      range: this.byteRange(span.start, span.end),
      openingTagRange: this.byteRange(span.start, openingTagEnd),
      closingTagRange: selfClosing
        ? this.byteRange(span.start, span.end)
        : this.byteRange(closingTagStart, span.end),
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

  /**
   * The UTF-16 end (exclusive) of the opening tag: the first `>` after the
   * last attribute (or after the tag name), which only whitespace or the
   * self-closing `/` may precede.
   */
  private openingTagEnd(
    node: MdxTreeNode,
    span: { start: number; end: number },
  ): number {
    const attributes = node.attributes ?? [];
    let scanFrom: number;
    if (attributes.length > 0) {
      scanFrom = this.spanOf(attributes[attributes.length - 1]).end;
    } else {
      scanFrom = span.start + 1 + (node.name ?? "").length;
    }
    const gt = this.text.indexOf(">", scanFrom);
    if (gt === -1 || gt >= span.end) {
      throw new Error("xspec internal error: section opening tag not found");
    }
    return gt + 1;
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
