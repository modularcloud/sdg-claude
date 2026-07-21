// The rename rewrite plan (SPEC 6.4) — the pure derivation.
//
// Pure core (IMPLEMENTATION Architecture: deterministic and I/O-free): over
// a validated workspace's analyses this module computes everything `xspec
// rename <file> <old-id> <new-id>` changes in the sources —
//
// - the renamed section's `id` attribute and every descendant's, rewritten
//   by prefix replacement (SPEC 6.4);
// - every reference to the affected identities across all configured spec
//   and code sources: local string references and `text(...)` arguments in
//   the origin file, external chain references (`d` and `text(...)`) in
//   other spec files, and TypeScript markers and `text(...)` calls in code
//   files (SPEC 6.4). Type-level TypeScript references record no edges
//   (SPEC 4.5) and never appear among the analyzed references, so they are
//   not rewritten;
// - the identity mapping the operation produces, as the journal entry the
//   workspace layer appends (SPEC 6.1, 6.4).
//
// Rewrites are minimal in-place edits (SPEC 6.4): each affected part is
// replaced within its recorded byte range, preserving the reference's quote
// style and access form (2.4); where a form cannot be kept — a dot-access
// chain segment whose new name is not a valid TypeScript identifier — the
// rewritten part uses double-quoted computed access, and rewritten string
// content is escaped so the literal re-parses to exactly the new value.
// Every byte outside the affected parts is preserved verbatim, and the
// rewritten content is a deterministic function of the operation and the
// analyzed workspace state (SPEC 6.1, 12.0).
//
// Callers validate first (SPEC 6.4): the workspace passes `build`
// validation, the old ID exists, and the new ID is valid, differs,
// collides with nothing, and keeps the structural parent rules — a rename
// keeps the section's place in the tree, so old and new ID share every
// segment but the last. This module asserts those preconditions and
// throws on violation: they are caller defects, never user-facing paths.

import type { CodeAnalysis } from "./code-analysis.js";
import type { ByteRange } from "./bytes.js";
import type { SpecFileAnalysis } from "./graph.js";
import type { IdentityMapping, JournalEntry } from "./journal.js";
import { createJournalEntry } from "./journal.js";
import type { SpecAttributeValue, SpecDocument } from "./mdx.js";
import { classifyReference, parseExpressionText } from "./references.js";
import type {
  ReferenceSpelling,
  SegmentSpelling,
  SpecReference,
} from "./spec-references.js";

/** One rewritten source file: its path and complete new content bytes. */
export interface SourceRewrite {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** The file's complete rewritten bytes (SPEC 6.4: minimal edits applied). */
  readonly content: Uint8Array;
}

/** Everything a validated rename changes in the sources (SPEC 6.4, 6.1). */
export interface RenamePlan {
  /** The full identity mapping the operation produces (SPEC 6.4, 6.1). */
  readonly mapping: readonly IdentityMapping[];
  /** The journal entry recording the operation and its mapping (SPEC 6.1). */
  readonly entry: JournalEntry;
  /** Every source file with edits, byte-ordered rewrites applied. */
  readonly rewrites: readonly SourceRewrite[];
}

// ---------------------------------------------------------------------------
// Spelling helpers (SPEC 6.4 minimal edits)
// ---------------------------------------------------------------------------

/**
 * Whether `name` can be written as a dot-access segment (`.name`) that the
 * static-reference grammar (SPEC 2.4) reads back as exactly this segment.
 * Decided by the analyzer itself — parse `a.<name>` and require a one-
 * segment dot chain naming `name` — so a kept dot form always round-trips:
 * keywords are valid property names (TypeScript's IdentifierName), while
 * any name needing quoting fails and falls back to computed access
 * (SPEC 6.4: dot access for segments that are valid TypeScript
 * identifiers, double-quoted computed access otherwise).
 */
export function isDotAccessSegmentName(name: string): boolean {
  const text = `a.${name}`;
  const { sourceFile, expression } = parseExpressionText(text);
  if (expression === null) {
    return false;
  }
  const classified = classifyReference(expression, sourceFile);
  return (
    classified.kind === "chain" &&
    classified.rootName === "a" &&
    classified.segments.length === 1 &&
    classified.segments[0].access === "dot" &&
    classified.segments[0].name === name &&
    classified.span.start === 0 &&
    classified.span.end === text.length
  );
}

/**
 * A JavaScript string literal holding exactly `value`, written with `quote`
 * (SPEC 6.4: quote style preserved; the fallback form is double-quoted).
 * Only the quote character and the backslash need escaping: ID segments
 * contain no control characters and no whitespace (SPEC 1.4), so no other
 * escape sequence ever arises, and the literal re-parses to `value`.
 */
function jsStringLiteral(value: string, quote: '"' | "'"): string {
  let escaped = "";
  for (const character of value) {
    escaped +=
      character === "\\" || character === quote ? `\\${character}` : character;
  }
  return `${quote}${escaped}${quote}`;
}

/**
 * The characters of a quoted MDX attribute value holding exactly `value`
 * under `quote` (SPEC 2.7: quoted attribute form; SPEC 6.4: the quote style
 * is preserved). MDX decodes character references in attribute values, so
 * `&` and the quote character are written as character references — every
 * other character is written verbatim — and the attribute re-parses to
 * exactly `value`.
 */
function attributeValueText(value: string, quote: '"' | "'"): string {
  let encoded = "";
  for (const character of value) {
    if (character === "&") {
      encoded += "&amp;";
    } else if (character === quote) {
      encoded += quote === '"' ? "&quot;" : "&#x27;";
    } else {
      encoded += character;
    }
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** One in-place edit: replace the bytes of `range` with `replacement`. */
interface SourceEdit {
  readonly range: ByteRange;
  readonly replacement: string;
}

const encoder = new TextEncoder();

/**
 * Apply non-overlapping edits to a file's bytes (SPEC 6.4: minimal in-place
 * edits — every byte outside the edited ranges is preserved verbatim).
 */
function applyEdits(
  bytes: Uint8Array,
  edits: readonly SourceEdit[],
): Uint8Array {
  const ordered = [...edits].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.range.start < cursor || edit.range.end > bytes.length) {
      throw new Error(
        "xspec internal error: overlapping or out-of-range rename edits",
      );
    }
    parts.push(bytes.subarray(cursor, edit.range.start));
    parts.push(encoder.encode(edit.replacement));
    cursor = edit.range.end;
  }
  parts.push(bytes.subarray(cursor));
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The edit rewriting one affected chain segment to `newName` (SPEC 6.4):
 * a dot access keeps its form when the new name is a valid segment of dot
 * access, and otherwise becomes double-quoted computed access (the whole
 * access — `.old` — is replaced); a computed access keeps its form and
 * quote style, its index literal rewritten in place.
 */
function segmentEdit(segment: SegmentSpelling, newName: string): SourceEdit {
  if (segment.access === "dot") {
    if (isDotAccessSegmentName(newName)) {
      return { range: segment.nameRange, replacement: newName };
    }
    // SPEC 6.4: the dot form cannot hold the new name — double-quoted
    // computed access for segments that are not valid TypeScript
    // identifiers.
    return {
      range: segment.accessRange,
      replacement: `[${jsStringLiteral(newName, '"')}]`,
    };
  }
  // SPEC 6.4: computed access keeps its form and quote style; escaping
  // keeps the literal exact whatever the new segment contains.
  return {
    range: segment.nameRange,
    replacement: jsStringLiteral(newName, segment.quote ?? '"'),
  };
}

// ---------------------------------------------------------------------------
// Affectedness
// ---------------------------------------------------------------------------

/**
 * SPEC 6.4 prefix replacement over ID paths: the mapped ID when `id` is the
 * renamed ID or a descendant of it, null when unaffected. Matched on
 * segment boundaries — `a.b2` is no descendant of `a.b`.
 */
function replaceIdPrefix(
  id: string,
  oldId: string,
  newId: string,
): string | null {
  if (id === oldId) {
    return newId;
  }
  if (id.startsWith(`${oldId}.`)) {
    return newId + id.slice(oldId.length);
  }
  return null;
}

/**
 * Whether a chain's segment sequence targets the renamed node or a
 * descendant: its first segments equal the old ID's segments, matched
 * segment-wise — never joined and re-split (SPEC 2.4, 1.4).
 */
function chainAffected(
  segments: readonly string[],
  oldSegments: readonly string[],
): boolean {
  if (segments.length < oldSegments.length) {
    return false;
  }
  for (let index = 0; index < oldSegments.length; index += 1) {
    if (segments[index] !== oldSegments[index]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Collects per-file edits, keyed by workspace-relative path. */
class EditCollector {
  private readonly editsByPath = new Map<string, SourceEdit[]>();

  add(path: string, edit: SourceEdit): void {
    let edits = this.editsByPath.get(path);
    if (edits === undefined) {
      edits = [];
      this.editsByPath.set(path, edits);
    }
    edits.push(edit);
  }

  editsFor(path: string): readonly SourceEdit[] | undefined {
    return this.editsByPath.get(path);
  }
}

/** The affected chain-reference edit, if the reference is affected. */
function chainReferenceEdit(
  spelling: ReferenceSpelling,
  segments: readonly string[],
  oldSegments: readonly string[],
  newLastSegment: string,
): SourceEdit | null {
  if (!chainAffected(segments, oldSegments)) {
    return null;
  }
  if (spelling.form !== "chain") {
    throw new Error(
      "xspec internal error: an external reference without a chain spelling",
    );
  }
  const affected: SegmentSpelling | undefined =
    spelling.segments[oldSegments.length - 1];
  if (affected === undefined) {
    throw new Error(
      "xspec internal error: affected chain shorter than its target path",
    );
  }
  return segmentEdit(affected, newLastSegment);
}

/** One spec file's references, `d` and `text(...)` alike (SPEC 2.2, 2.3). */
function specReferencesOf(spec: SpecFileAnalysis): SpecReference[] {
  const references: SpecReference[] = [];
  for (const dependency of spec.references.dependencies) {
    references.push(dependency.reference);
  }
  for (const embedding of spec.references.embeddings) {
    if (embedding.reference !== null) {
      references.push(embedding.reference);
    }
  }
  return references;
}

/** The origin document's affected `id` attribute (asserted present). */
function idAttributeOf(
  document: SpecDocument,
  id: string,
  attribute: SpecAttributeValue | null,
): SpecAttributeValue {
  if (attribute === null) {
    throw new Error(
      `xspec internal error: section ${document.path}#${id} of a validated ` +
        `workspace has no recorded id attribute`,
    );
  }
  return attribute;
}

/**
 * Derive the SPEC 6.4 rename plan over a validated workspace's analyses:
 * the identity mapping (renamed node plus descendants, by prefix
 * replacement), the journal entry recording it (SPEC 6.1), and the minimal
 * in-place rewrites of every affected source file. See the module header
 * for the preconditions the caller has established.
 */
export function planRename(
  specs: readonly SpecFileAnalysis[],
  code: readonly CodeAnalysis[],
  originPath: string,
  oldId: string,
  newId: string,
): RenamePlan {
  const origin = specs.find((spec) => spec.document.path === originPath);
  if (origin === undefined) {
    throw new Error(
      `xspec internal error: rename origin ${originPath} is not among the ` +
        `analyzed spec sources`,
    );
  }
  const oldSegments = oldId.split(".");
  const newSegments = newId.split(".");
  if (
    oldId === newId ||
    oldSegments.length !== newSegments.length ||
    oldSegments.slice(0, -1).join(".") !== newSegments.slice(0, -1).join(".")
  ) {
    // SPEC 6.4: a rename keeps the section's place in the tree — the caller
    // validated that old and new ID share every segment but the last.
    throw new Error(
      `xspec internal error: rename of ${JSON.stringify(oldId)} to ` +
        `${JSON.stringify(newId)} does not replace exactly the last segment`,
    );
  }
  const newLastSegment = newSegments[newSegments.length - 1];

  // The identity mapping (SPEC 6.4, 6.1): the renamed node and every
  // descendant, re-identified by prefix replacement.
  const mapping: IdentityMapping[] = [];
  const edits = new EditCollector();
  for (const section of origin.document.sections) {
    if (section.id === null) {
      continue;
    }
    const mapped = replaceIdPrefix(section.id, oldId, newId);
    if (mapped === null) {
      continue;
    }
    mapping.push({
      from: `${originPath}#${section.id}`,
      to: `${originPath}#${mapped}`,
    });
    // SPEC 6.4: the `id` attribute rewrite — the value characters between
    // the quotes are replaced, the quote style preserved.
    const attribute = idAttributeOf(
      origin.document,
      section.id,
      section.idAttribute,
    );
    edits.add(originPath, {
      range: attribute.valueRange,
      replacement: attributeValueText(mapped, attribute.quote),
    });
  }
  if (mapping.length === 0) {
    throw new Error(
      `xspec internal error: rename of ${originPath}#${oldId} maps no node — ` +
        `the caller validated that the old ID exists`,
    );
  }

  // SPEC 6.4: rewrite every reference to the affected identities across all
  // configured spec sources — local string references in the origin file,
  // external chain references everywhere.
  for (const spec of specs) {
    const path = spec.document.path;
    for (const reference of specReferencesOf(spec)) {
      if (reference.target.kind === "local") {
        if (path !== originPath) {
          continue; // the local form names an ID in its own file (SPEC 2.2)
        }
        const mapped = replaceIdPrefix(reference.target.idPath, oldId, newId);
        if (mapped === null) {
          continue;
        }
        if (reference.spelling.form !== "string") {
          throw new Error(
            "xspec internal error: a local reference without a string " +
              "spelling",
          );
        }
        edits.add(path, {
          range: reference.spelling.range,
          replacement: jsStringLiteral(mapped, reference.spelling.quote),
        });
        continue;
      }
      if (reference.target.modulePath !== originPath) {
        continue;
      }
      const edit = chainReferenceEdit(
        reference.spelling,
        reference.target.segments,
        oldSegments,
        newLastSegment,
      );
      if (edit !== null) {
        edits.add(path, edit);
      }
    }
  }

  // SPEC 6.4: rewrite TypeScript markers and `text(...)` references in all
  // configured code sources. Type-level references record no edges
  // (SPEC 4.5) and are absent from the analyzed references — not rewritten.
  for (const analysis of code) {
    for (const reference of analysis.references) {
      if (reference.modulePath !== originPath) {
        continue;
      }
      const edit = chainReferenceEdit(
        reference.spelling,
        reference.segments,
        oldSegments,
        newLastSegment,
      );
      if (edit !== null) {
        edits.add(analysis.path, edit);
      }
    }
  }

  // Assemble the rewritten files: sources with edits, every byte outside
  // the edited ranges preserved verbatim (SPEC 6.4). Source text decoded
  // from valid, BOM-free UTF-8 (SPEC 1.6) re-encodes to the exact original
  // bytes, so the unedited runs are the file's own bytes.
  const rewrites: SourceRewrite[] = [];
  for (const spec of specs) {
    const fileEdits = edits.editsFor(spec.document.path);
    if (fileEdits !== undefined) {
      rewrites.push({
        path: spec.document.path,
        content: applyEdits(encoder.encode(spec.document.text), fileEdits),
      });
    }
  }
  for (const analysis of code) {
    const fileEdits = edits.editsFor(analysis.path);
    if (fileEdits !== undefined) {
      rewrites.push({
        path: analysis.path,
        content: applyEdits(encoder.encode(analysis.text), fileEdits),
      });
    }
  }

  return {
    mapping,
    // SPEC 6.1/6.4: the appended entry records the operation and the full
    // mapping it produced.
    entry: createJournalEntry(
      "rename",
      `${originPath}#${oldId}`,
      `${originPath}#${newId}`,
      mapping,
    ),
    rewrites,
  };
}
