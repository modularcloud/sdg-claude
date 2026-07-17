// Markdown compilation and the per-node text model (SPEC 3, 1.6).
//
// Over parsed document models (./mdx.ts), this module implements the removal
// and replacement rules of Markdown compilation (SPEC 3) and derives from
// them, per requirement node, the three values of SPEC 1.6:
//
// - subtree text — the section construct's contribution to its file's
//   compiled Markdown output (for the root, the entire output), children
//   interleaved at the positions they occupy in the source;
// - own text — the subtree text with every child's contribution excised:
//   the N + 1 runs its N child constructs divide it into, joined exactly at
//   the excision points;
// - own content — the runs computed with `text(...)` replacement suspended,
//   alternating with node references (the excised child at each child
//   excision point, the embedding occurrence at each embedding excision
//   point, the two kinds distinguished), for hashing (SPEC 5.5).
//
// The rules apply whether or not Markdown emission is enabled (SPEC 1.6),
// so this model is pure and I/O-free (IMPLEMENTATION Architecture): parsed
// documents and an embedding resolver in, exact character values out. All
// values are the exact decoded content (SPEC 1.6: exact bytes once encoded
// as UTF-8); computation runs over UTF-16 indices and converts from the
// byte-offset ranges of the document model (SPEC 1.7).

import type { ByteRange } from "./bytes.js";
import type { Line } from "./text.js";
import { isWhitespaceOnly, splitLines } from "./text.js";
import type { SpecDocument, SpecEmbedding, SpecSection } from "./mdx.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** A requirement node: a section (the root included) of a parsed document. */
export interface SpecNodeRef {
  readonly document: SpecDocument;
  readonly section: SpecSection;
}

/**
 * Resolves one `{text(...)}` embedding to its target node (SPEC 2.3): the
 * local or external target the reference designates. Null when the embedding
 * yields no resolvable target — a dynamic argument (14.8) or an unresolved
 * reference (14.5, 14.6): those make the workspace invalid, and no compiled
 * output or text value of an invalid workspace is ever surfaced (SPEC 12.1,
 * 13.3), so a null target expands to nothing purely to keep the model total
 * and deterministic.
 */
export type EmbeddingResolver = (
  document: SpecDocument,
  embedding: SpecEmbedding,
) => SpecNodeRef | null;

/**
 * One element of a node's own content sequence (SPEC 1.6): byte runs (empty
 * runs included) alternating with node references — the excised child at
 * each child excision point, the embedding occurrence (whose target the
 * graph resolves, SPEC 5.2) at each embedding excision point, the two kinds
 * distinguished. The sequence always begins and ends with a run: N excision
 * points yield exactly N + 1 runs.
 */
export type OwnContentPart =
  | { readonly kind: "run"; readonly text: string }
  | { readonly kind: "child"; readonly section: SpecSection }
  | { readonly kind: "embedding"; readonly embedding: SpecEmbedding };

// ---------------------------------------------------------------------------
// Static per-file structure
// ---------------------------------------------------------------------------

/**
 * One construct SPEC 3 deletes or replaces, as a UTF-16 index span: a spec
 * module import, a section opening or closing tag (with its props), an MDX
 * comment (each deleted), or a `{text(...)}` embedding (replaced by the
 * target's compiled subtree text — or excised, in own-content mode).
 */
interface RemovalConstruct {
  readonly start: number;
  readonly end: number;
  /** The embedding when this construct is one; null for pure removals. */
  readonly embedding: SpecEmbedding | null;
}

/**
 * One surviving fragment of a line group, ordered by source position:
 * source characters no construct covers, an embedding's expansion point, or
 * the group's final line terminator. Deletion is exact and in place
 * (SPEC 3), so concatenating a span's pieces in position order — expansions
 * at the embedding's position — is the compiled value of that span.
 */
type Piece =
  | { readonly kind: "kept"; readonly pos: number; readonly end: number }
  | {
      readonly kind: "embedding";
      readonly pos: number;
      readonly embedding: SpecEmbedding;
    }
  | {
      readonly kind: "terminator";
      readonly pos: number;
      readonly text: string;
    };

/**
 * A maximal run of source lines merged by construct deletion: a construct
 * spanning line terminators deletes them with its own characters (SPEC 3:
 * removal is exact textual deletion, in place), so the surrounding residues
 * form one line of the output — the unit the line-drop rule judges.
 */
interface LineGroup {
  /** UTF-16 start of the first merged line. */
  readonly start: number;
  /** UTF-16 end (exclusive) of the final line's content. */
  readonly contentEnd: number;
  /** UTF-16 end (exclusive) of the final line, terminator included. */
  readonly end: number;
  /** The group's surviving fragments in position order. */
  readonly pieces: readonly Piece[];
  /** The group's embeddings in document order. */
  readonly embeddings: readonly SpecEmbedding[];
  /** SPEC 3: whether the group contained non-whitespace in the source. */
  readonly hadNonWhitespace: boolean;
  /** Whether every kept fragment is empty or whitespace (SPEC 1.4). */
  readonly keptWhitespaceOnly: boolean;
  /**
   * The line-drop decision with `text(...)` replacement suspended
   * (SPEC 1.6): an excised embedding counts as remaining line content, so
   * only groups emptied purely by removals drop. Static — own content is
   * per-file, so it needs no expansion values.
   */
  readonly droppedInContentMode: boolean;
}

/** The compilation structure of one parsed document, built once. */
interface FileStructure {
  readonly document: SpecDocument;
  /** The document's line groups in order, covering the whole text. */
  readonly groups: readonly LineGroup[];
}

/** A byte range of `document` as a UTF-16 index span. */
function indexSpan(
  document: SpecDocument,
  range: ByteRange,
): { readonly start: number; readonly end: number } {
  return {
    start: document.offsets.indexOfByteOffset(range.start),
    end: document.offsets.indexOfByteOffset(range.end),
  };
}

/**
 * The UTF-16 span of a section's content — what lies between its tags: the
 * entire file for the root (SPEC 1.2), nothing for a self-closing section
 * (SPEC 1.1: an empty leaf), the opening tag's end through the closing
 * tag's start otherwise.
 */
function contentIndexSpan(
  document: SpecDocument,
  section: SpecSection,
): { readonly start: number; readonly end: number } {
  if (section.parent === null) {
    return { start: 0, end: document.text.length };
  }
  if (section.selfClosing) {
    const end = document.offsets.indexOfByteOffset(section.range.end);
    return { start: end, end };
  }
  return {
    start: document.offsets.indexOfByteOffset(section.openingTagRange.end),
    end: document.offsets.indexOfByteOffset(section.closingTagRange.start),
  };
}

/**
 * The document-order gaps a section's child constructs divide its content
 * span into — the regions of the node's own contribution. N children yield
 * exactly N + 1 gaps, empty gaps included (SPEC 1.6).
 */
function gapSpans(
  document: SpecDocument,
  section: SpecSection,
): { readonly start: number; readonly end: number }[] {
  const content = contentIndexSpan(document, section);
  const gaps: { start: number; end: number }[] = [];
  let cursor = content.start;
  for (const child of section.children) {
    const range = indexSpan(document, child.range);
    gaps.push({ start: cursor, end: range.start });
    cursor = range.end;
  }
  gaps.push({ start: cursor, end: content.end });
  return gaps;
}

/** Collect the document's removal and replacement constructs, sorted. */
function collectConstructs(document: SpecDocument): RemovalConstruct[] {
  const constructs: RemovalConstruct[] = [];
  const removal = (range: ByteRange): void => {
    const span = indexSpan(document, range);
    if (span.start !== span.end) {
      constructs.push({ start: span.start, end: span.end, embedding: null });
    }
  };
  // SPEC 3: spec module imports are removed — each import declaration's own
  // characters (the block's inter-statement whitespace stays and the
  // line-drop rule takes the emptied lines).
  for (const block of document.esmBlocks) {
    for (const statement of block.imports) {
      removal(statement.range);
    }
  }
  // SPEC 3: `<S>`/`<Spec>` tags are removed together with their props; a
  // self-closing section is one tag (SPEC 1.1). The root has zero-width tag
  // ranges (SPEC 1.2), filtered by the zero-width guard above.
  for (const section of document.sections) {
    removal(section.openingTagRange);
    if (!section.selfClosing) {
      removal(section.closingTagRange);
    }
  }
  // SPEC 3: MDX comments are removed — pure annotations (SPEC 2.7).
  for (const comment of document.comments) {
    removal(comment.range);
  }
  // SPEC 3: each `text(...)` expression is replaced (or excised, SPEC 1.6).
  for (const embedding of document.embeddings) {
    const span = indexSpan(document, embedding.range);
    constructs.push({ start: span.start, end: span.end, embedding });
  }
  constructs.sort((a, b) => a.start - b.start);
  for (let index = 1; index < constructs.length; index += 1) {
    if (constructs[index].start < constructs[index - 1].end) {
      throw new Error(
        "xspec internal error: overlapping compilation constructs",
      );
    }
  }
  return constructs;
}

/** Build the compilation structure of one parsed document. */
function buildFileStructure(document: SpecDocument): FileStructure {
  const text = document.text;
  const constructs = collectConstructs(document);
  const lines = splitLines(text);

  // A line whose terminator lies inside a construct merges with the next
  // line: the construct's deletion removes the terminator with the
  // construct's own characters (SPEC 3).
  let scan = 0;
  const terminatorInsideConstruct = (line: Line): boolean => {
    if (line.terminator === "") {
      return false;
    }
    while (
      scan < constructs.length &&
      constructs[scan].end <= line.contentEnd
    ) {
      scan += 1;
    }
    const construct = constructs[scan];
    return (
      construct !== undefined &&
      construct.start <= line.contentEnd &&
      line.end <= construct.end
    );
  };

  const groups: LineGroup[] = [];
  let lineIndex = 0;
  let constructIndex = 0;
  while (lineIndex < lines.length) {
    let last = lineIndex;
    while (last < lines.length - 1 && terminatorInsideConstruct(lines[last])) {
      last += 1;
    }
    const start = lines[lineIndex].start;
    const finalLine = lines[last];

    // The group's surviving fragments: source characters outside every
    // construct, embedding expansion points, and the final terminator.
    // Interior terminators lie inside constructs (that is what merged the
    // lines), so walking the constructs covers them.
    const pieces: Piece[] = [];
    const embeddings: SpecEmbedding[] = [];
    let keptWhitespaceOnly = true;
    let cursor = start;
    while (
      constructIndex < constructs.length &&
      constructs[constructIndex].start < finalLine.contentEnd
    ) {
      const construct = constructs[constructIndex];
      if (construct.start > cursor) {
        pieces.push({ kind: "kept", pos: cursor, end: construct.start });
        if (!isWhitespaceOnly(text.slice(cursor, construct.start))) {
          keptWhitespaceOnly = false;
        }
      }
      if (construct.embedding !== null) {
        pieces.push({
          kind: "embedding",
          pos: construct.start,
          embedding: construct.embedding,
        });
        embeddings.push(construct.embedding);
      }
      cursor = construct.end;
      constructIndex += 1;
    }
    if (cursor < finalLine.contentEnd) {
      pieces.push({ kind: "kept", pos: cursor, end: finalLine.contentEnd });
      if (!isWhitespaceOnly(text.slice(cursor, finalLine.contentEnd))) {
        keptWhitespaceOnly = false;
      }
    }
    if (finalLine.terminator !== "") {
      pieces.push({
        kind: "terminator",
        pos: finalLine.contentEnd,
        text: finalLine.terminator,
      });
    }

    // SPEC 3: "contained non-whitespace in the source" — over the group's
    // source characters, construct characters included (interior
    // terminators are whitespace either way).
    const hadNonWhitespace = !isWhitespaceOnly(
      text.slice(start, finalLine.contentEnd),
    );

    groups.push({
      start,
      contentEnd: finalLine.contentEnd,
      end: finalLine.end,
      pieces,
      embeddings,
      hadNonWhitespace,
      keptWhitespaceOnly,
      // SPEC 1.6: with replacement suspended, an excised embedding counts
      // as remaining line content — the empty-expansion drop never applies
      // — while all other removal rules apply unchanged.
      droppedInContentMode:
        hadNonWhitespace && keptWhitespaceOnly && embeddings.length === 0,
    });
    lineIndex = last + 1;
  }

  return { document, groups };
}

// ---------------------------------------------------------------------------
// The workspace text model
// ---------------------------------------------------------------------------

/**
 * The text model over a workspace's parsed documents: compiled Markdown
 * output (SPEC 3), per-node subtree and own text (SPEC 1.6, fully
 * expanded), and per-node own content sequences (SPEC 1.6, replacement
 * suspended). One instance per consistent set of documents; every value is
 * memoized, so repeated queries are cheap and deterministic (SPEC 12.0).
 *
 * Expansion recurses through the resolver: `text(...)` is replaced by the
 * target's compiled subtree text, fully expanded (SPEC 3), which may
 * require other nodes' subtree texts across files. In a valid workspace
 * the recursion terminates: an expansion chain is a path over `contains`
 * and `embeds` edges, and cycles over those edges are invalid (SPEC 5.3).
 * Invalid workspaces never surface these values (SPEC 12.1, 13.3); should
 * one be evaluated anyway, re-entering a node's computation yields the
 * empty string, keeping the model total and terminating.
 */
export class WorkspaceTextModel {
  private readonly structures = new Map<SpecDocument, FileStructure>();
  private readonly subtreeMemo = new Map<SpecSection, string>();
  private readonly expansionMemo = new Map<SpecEmbedding, string>();
  private readonly expandedDropMemo = new Map<LineGroup, boolean>();
  private readonly inProgress = new Set<SpecSection>();

  constructor(private readonly resolveEmbedding: EmbeddingResolver) {}

  /** The document's compilation structure, built once. */
  private structure(document: SpecDocument): FileStructure {
    let structure = this.structures.get(document);
    if (structure === undefined) {
      structure = buildFileStructure(document);
      this.structures.set(document, structure);
    }
    return structure;
  }

  /**
   * The file's entire compiled Markdown output (SPEC 3) — the root's
   * subtree text (SPEC 1.2, 1.6).
   */
  compiledMarkdown(document: SpecDocument): string {
    return this.subtreeText(document, document.root);
  }

  /**
   * SPEC 1.6: the section construct's contribution to its file's compiled
   * Markdown output, children interleaved in document order, `text(...)`
   * fully expanded.
   */
  subtreeText(document: SpecDocument, section: SpecSection): string {
    const memoized = this.subtreeMemo.get(section);
    if (memoized !== undefined) {
      return memoized;
    }
    if (this.inProgress.has(section)) {
      // Re-entry: an expansion chain reached the node being computed. In a
      // valid workspace this cannot happen (SPEC 5.3 forbids the cycles
      // that would cause it); the empty string keeps the model total.
      return "";
    }
    this.inProgress.add(section);
    try {
      const span =
        section.parent === null
          ? { start: 0, end: document.text.length }
          : indexSpan(document, section.range);
      const value = this.renderExpanded(
        this.structure(document),
        span.start,
        span.end,
      );
      this.subtreeMemo.set(section, value);
      return value;
    } finally {
      this.inProgress.delete(section);
    }
  }

  /**
   * SPEC 1.6: the node's subtree text with every child's contribution
   * excised — its own-text runs (empty runs included) joined exactly at
   * the excision points.
   */
  ownText(document: SpecDocument, section: SpecSection): string {
    const structure = this.structure(document);
    let out = "";
    for (const gap of gapSpans(document, section)) {
      out += this.renderExpanded(structure, gap.start, gap.end);
    }
    return out;
  }

  /**
   * SPEC 1.6: the node's own content sequence — computed like its own-text
   * runs but with `text(...)` replacement suspended: each embedding is
   * excised like a child construct, contributing no bytes and marking an
   * excision point, and counts as remaining line content for the line-drop
   * rule. Runs (empty runs included) alternate with child and embedding
   * references in document order; the sequence begins and ends with a run.
   */
  ownContent(document: SpecDocument, section: SpecSection): OwnContentPart[] {
    const structure = this.structure(document);
    const content = contentIndexSpan(document, section);

    // Excision points: the section's child constructs and its own
    // embeddings (those whose innermost section it is), in document order.
    // Construct spans never overlap, so sorting by start is total.
    const events: {
      readonly pos: number;
      readonly end: number;
      readonly part: OwnContentPart;
    }[] = [];
    for (const child of section.children) {
      const span = indexSpan(document, child.range);
      events.push({
        pos: span.start,
        end: span.end,
        part: { kind: "child", section: child },
      });
    }
    for (const embedding of document.embeddings) {
      if (embedding.section === section) {
        const span = indexSpan(document, embedding.range);
        events.push({
          pos: span.start,
          end: span.end,
          part: { kind: "embedding", embedding },
        });
      }
    }
    events.sort((a, b) => a.pos - b.pos);

    const parts: OwnContentPart[] = [];
    let cursor = content.start;
    for (const event of events) {
      parts.push({
        kind: "run",
        text: this.renderContent(structure, cursor, event.pos),
      });
      parts.push(event.part);
      cursor = event.end;
    }
    parts.push({
      kind: "run",
      text: this.renderContent(structure, cursor, content.end),
    });
    return parts;
  }

  /**
   * The compiled value of the span [from, to) in expanded mode: kept
   * characters, expansions at embedding positions, kept terminators —
   * dropped groups contributing nothing. Callers pass construct-edge
   * boundaries (section ranges and gap edges), which no kept fragment or
   * construct straddles, so position filtering is exact.
   */
  private renderExpanded(
    structure: FileStructure,
    from: number,
    to: number,
  ): string {
    if (from >= to) {
      return "";
    }
    let out = "";
    for (const group of structure.groups) {
      if (group.end <= from) {
        continue;
      }
      if (group.start >= to) {
        break;
      }
      if (this.droppedExpanded(structure, group)) {
        continue;
      }
      for (const piece of group.pieces) {
        if (piece.pos < from || piece.pos >= to) {
          continue;
        }
        if (piece.kind === "kept") {
          out += structure.document.text.slice(piece.pos, piece.end);
        } else if (piece.kind === "embedding") {
          out += this.expansion(structure.document, piece.embedding);
        } else {
          out += piece.text;
        }
      }
    }
    return out;
  }

  /** As `renderExpanded`, in own-content mode: embeddings excised. */
  private renderContent(
    structure: FileStructure,
    from: number,
    to: number,
  ): string {
    if (from >= to) {
      return "";
    }
    let out = "";
    for (const group of structure.groups) {
      if (group.end <= from) {
        continue;
      }
      if (group.start >= to) {
        break;
      }
      if (group.droppedInContentMode) {
        continue;
      }
      for (const piece of group.pieces) {
        if (piece.pos < from || piece.pos >= to) {
          continue;
        }
        if (piece.kind === "kept") {
          out += structure.document.text.slice(piece.pos, piece.end);
        } else if (piece.kind === "terminator") {
          out += piece.text;
        }
        // Embeddings: excised — no bytes; the reference is emitted as an
        // own-content part, never as run text (SPEC 1.6).
      }
    }
    return out;
  }

  /**
   * SPEC 3, expanded mode: a group that contained non-whitespace in the
   * source but is left empty or whitespace-only purely by removals, or by
   * `text(...)` replacements whose expansions are empty, is dropped with
   * its terminator. A non-empty expansion — whitespace-only included —
   * keeps the group: the loss is then not purely the listed causes.
   */
  private droppedExpanded(structure: FileStructure, group: LineGroup): boolean {
    const memoized = this.expandedDropMemo.get(group);
    if (memoized !== undefined) {
      return memoized;
    }
    let dropped = false;
    if (group.hadNonWhitespace && group.keptWhitespaceOnly) {
      dropped = true;
      for (const embedding of group.embeddings) {
        if (this.expansion(structure.document, embedding) !== "") {
          dropped = false;
          break;
        }
      }
    }
    this.expandedDropMemo.set(group, dropped);
    return dropped;
  }

  /**
   * SPEC 3: the replacement value of one `text(...)` expression — the
   * target's compiled subtree text, fully expanded (recursively, across
   * files). An unresolved embedding expands to nothing (see
   * `EmbeddingResolver`: never surfaced, the workspace is invalid).
   */
  private expansion(document: SpecDocument, embedding: SpecEmbedding): string {
    const memoized = this.expansionMemo.get(embedding);
    if (memoized !== undefined) {
      return memoized;
    }
    const target = this.resolveEmbedding(document, embedding);
    const value =
      target === null ? "" : this.subtreeText(target.document, target.section);
    this.expansionMemo.set(embedding, value);
    return value;
  }
}
