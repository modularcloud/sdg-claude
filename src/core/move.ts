// The move rewrite plans (SPEC 6.5) — the pure derivations.
//
// Pure core (IMPLEMENTATION Architecture: deterministic and I/O-free): over
// a validated workspace's analyses this module computes everything a move
// changes in the sources.
//
// The file form (`xspec move <old-file> <new-file>`, `planMoveFile`):
//
// - the moved file's complete content at its destination path: its own
//   import specifiers rewritten so each still designates the file it
//   designated before, resolved from the new directory (SPEC 6.5);
// - every other file's imports of the moved file's generated module — spec
//   files' `.xspec` imports (SPEC 2.1) and code files' spec module imports
//   (SPEC 4) — rewritten so all references continue to resolve (SPEC 6.5);
// - the identity mapping the operation produces — IDs unchanged, every
//   identity changed only in its file part — as the journal entry the
//   workspace layer appends (SPEC 6.1, 6.5).
//
// No reference spelling changes (SPEC 6.5 file form): local references name
// IDs of their own file, which are unchanged, and chain references are
// rooted at import bindings whose names are unchanged — only the import
// specifiers behind those bindings move.
//
// The section form (`xspec move <file>#<id> <target-file>#<new-id>`,
// `planMoveSection`): the section subtree is extracted with the exact text
// rules of SPEC 6.5 — the moved text is the construct's own characters,
// deleted in place at the origin with the line-drop rule of SPEC 3 (lines
// left empty or whitespace-only purely by the deletion are dropped with
// their terminators, judged over the merged output line exactly as Markdown
// compilation judges it), and inserted immediately before the target
// parent's closing tag (end of file for a top-level `new-id`), followed by
// U+000A and preceded by one when the insertion point is not at the start
// of a line; a self-closing target parent is first rewritten to paired
// form; the subtree is re-identified by prefix replacement; references
// convert between local and imported forms as the rewrite requires, spec
// module imports are added (binding fresh, non-colliding, deterministic
// identifiers) and removed exactly when a binding had references and the
// rewrite leaves it with none (SPEC 6.5, 2.1); the full mapping is the
// journal entry.
//
// Rewrites are minimal in-place edits (SPEC 6.4, 6.5), preserving quote
// style and access form where a form can be kept; converted references use
// dot access for valid-identifier segments, double-quoted computed access
// otherwise, and double-quoted string literals (SPEC 6.4). Rewritten file
// content is a deterministic function of the operation and workspace state
// (SPEC 6.1).
//
// Callers validate first (SPEC 6.5): the workspace passes `build`
// validation (so every import is valid, every section has a valid ID, and
// every reference resolves), the origin exists, and the move-specific
// refusals (self-move, `<new-id>` validity and collision, target parent,
// destination path validity) have all been checked. This module asserts
// those preconditions and throws on violation: they are caller defects,
// never user-facing paths.

import type { ByteRange } from "./bytes.js";
import { compareBytes } from "./bytes.js";
import type { CodeAnalysis } from "./code-analysis.js";
import type { SourceEdit, SourceRewrite } from "./edits.js";
import {
  applyEdits,
  attributeValueText,
  EditCollector,
  jsStringLiteral,
} from "./edits.js";
import type { SpecFileAnalysis } from "./graph.js";
import type { IdentityMapping, JournalEntry } from "./journal.js";
import { createJournalEntry } from "./journal.js";
import type { SpecSection } from "./mdx.js";
import {
  isDotAccessSegmentName,
  replaceIdPrefix,
  segmentEdit,
} from "./rename.js";
import type {
  SpecImport,
  SpecReference,
  ReferenceSpelling,
} from "./spec-references.js";
import { resolveImportSpecifier } from "./spec-references.js";

/** SPEC 2.1: `DIR/NAME.xspec` designates `DIR/NAME.mdx`. */
const XSPEC_SUFFIX = ".xspec";
const MDX_SUFFIX = ".mdx";

/** Everything a validated file-form move changes in the sources (SPEC 6.5). */
export interface MoveFilePlan {
  /** The full identity mapping the operation produces (SPEC 6.5, 6.1). */
  readonly mapping: readonly IdentityMapping[];
  /** The journal entry recording the operation and its mapping (SPEC 6.1). */
  readonly entry: JournalEntry;
  /**
   * Every rewritten source file at its post-move path: the moved file's
   * complete content at the destination (edits applied), and every other
   * file with import-specifier edits at its own path. The origin path
   * itself ceases to exist (the workspace layer removes it).
   */
  readonly rewrites: readonly SourceRewrite[];
}

/**
 * The generated-module specifier target of a spec source path (SPEC 2.1,
 * 13.1): `DIR/NAME.mdx` is imported as `DIR/NAME.xspec`.
 */
export function moduleSpecifierTargetOf(specPath: string): string {
  if (!specPath.endsWith(MDX_SUFFIX)) {
    throw new Error(
      `xspec internal error: ${JSON.stringify(specPath)} is not a spec ` +
        `source path (SPEC 7.1: every spec source ends ".mdx")`,
    );
  }
  return specPath.slice(0, -MDX_SUFFIX.length) + XSPEC_SUFFIX;
}

/**
 * The canonical relative specifier from the importing file to a target
 * module path, over workspace-relative `/`-separated paths (SPEC 1.5, 2.1):
 * the shortest `./`/`../` path — up from the importer's directory to the
 * deepest common ancestor, then down to the target. Deterministic for a
 * given (importer, target) pair (SPEC 6.1: rewritten content is
 * byte-deterministic), and `resolveImportSpecifier` maps it back to exactly
 * `targetModulePath`.
 */
export function relativeModuleSpecifier(
  importerPath: string,
  targetModulePath: string,
): string {
  const fromDir = importerPath.split("/").slice(0, -1);
  const target = targetModulePath.split("/");
  const targetDir = target.slice(0, -1);
  let common = 0;
  while (
    common < fromDir.length &&
    common < targetDir.length &&
    fromDir[common] === targetDir[common]
  ) {
    common += 1;
  }
  const ups = fromDir.length - common;
  const parts: string[] = [];
  for (let index = 0; index < ups; index += 1) {
    parts.push("..");
  }
  parts.push(...target.slice(common));
  // SPEC 2.1: a specifier begins "./" or "../".
  return ups === 0 ? `./${parts.join("/")}` : parts.join("/");
}

const encoder = new TextEncoder();

/** The shape shared by spec-file and code-file import records (SPEC 6.5). */
interface RewritableImport {
  readonly specifier: string;
  readonly specifierQuote: '"' | "'";
  readonly specifierRange: { readonly start: number; readonly end: number };
  readonly targetPath: string | null;
}

/**
 * Derive the SPEC 6.5 file-form move plan over a validated workspace's
 * analyses: the identity mapping (the file node plus every section, changed
 * only in the file part), the journal entry recording it (SPEC 6.1), and
 * the minimal in-place import-specifier rewrites of every affected source
 * file. See the module header for the preconditions the caller has
 * established.
 */
export function planMoveFile(
  specs: readonly SpecFileAnalysis[],
  code: readonly CodeAnalysis[],
  originPath: string,
  destinationPath: string,
): MoveFilePlan {
  const origin = specs.find((spec) => spec.document.path === originPath);
  if (origin === undefined) {
    throw new Error(
      `xspec internal error: move origin ${originPath} is not among the ` +
        `analyzed spec sources`,
    );
  }
  if (originPath === destinationPath) {
    throw new Error(
      `xspec internal error: move of ${originPath} onto itself — the caller ` +
        `validated that the destination differs (SPEC 6.5)`,
    );
  }

  // The identity mapping (SPEC 6.5, 6.1): IDs unchanged, identities changed
  // only in the file part — the file node and every section.
  const mapping: IdentityMapping[] = [
    { from: originPath, to: destinationPath },
  ];
  for (const section of origin.document.sections) {
    if (section.id === null) {
      throw new Error(
        `xspec internal error: a section of ${originPath} in a validated ` +
          `workspace has no ID`,
      );
    }
    mapping.push({
      from: `${originPath}#${section.id}`,
      to: `${destinationPath}#${section.id}`,
    });
  }

  const destinationModule = moduleSpecifierTargetOf(destinationPath);
  const edits = new EditCollector();

  /** Rewrite one import's specifier literal to designate `targetModule`. */
  const specifierEdit = (
    path: string,
    imported: RewritableImport,
    importerPath: string,
    targetModule: string,
  ): void => {
    edits.add(path, {
      range: imported.specifierRange,
      replacement: jsStringLiteral(
        relativeModuleSpecifier(importerPath, targetModule),
        // SPEC 6.4/6.5: rewrites preserve the reference's quote style.
        imported.specifierQuote,
      ),
    });
  };

  // SPEC 6.5: relocation rewrites the moved file's own import specifiers —
  // each must designate, from the new directory, the file it designated
  // before (the destination itself for a self-import). A specifier that
  // still resolves is kept verbatim (SPEC 6.4: minimal edits).
  for (const imported of origin.imports.imports) {
    if (imported.targetPath === null) {
      throw new Error(
        `xspec internal error: an invalid import in ${originPath} of a ` +
          `validated workspace`,
      );
    }
    const target =
      imported.targetPath === originPath
        ? destinationPath
        : imported.targetPath;
    const resolved = resolveImportSpecifier(
      destinationPath,
      imported.specifier,
    );
    const designated =
      resolved === null
        ? null
        : resolved.slice(0, -XSPEC_SUFFIX.length) + MDX_SUFFIX;
    if (designated === target) {
      continue;
    }
    specifierEdit(
      originPath,
      imported,
      destinationPath,
      moduleSpecifierTargetOf(target),
    );
  }

  // SPEC 6.5: rewrite the paths by which other files import the moved
  // file's generated module — spec sources (SPEC 2.1) and code sources
  // (SPEC 4) alike — so all references continue to resolve.
  for (const spec of specs) {
    if (spec.document.path === originPath) {
      continue;
    }
    for (const imported of spec.imports.imports) {
      if (imported.targetPath === originPath) {
        specifierEdit(
          spec.document.path,
          imported,
          spec.document.path,
          destinationModule,
        );
      }
    }
  }
  for (const analysis of code) {
    for (const imported of analysis.imports) {
      if (imported.targetPath === originPath) {
        specifierEdit(
          analysis.path,
          imported,
          analysis.path,
          destinationModule,
        );
      }
    }
  }

  // Assemble the rewrites: the moved file's content at the destination path
  // (with its edits, possibly none), every other edited file at its own
  // path. Source text decoded from valid, BOM-free UTF-8 (SPEC 1.6)
  // re-encodes to the exact original bytes, so unedited runs are the file's
  // own bytes (SPEC 6.5: beyond these edits, a move changes no bytes).
  const rewrites: SourceRewrite[] = [];
  for (const spec of specs) {
    const path = spec.document.path;
    const fileEdits = edits.editsFor(path);
    if (path === originPath) {
      rewrites.push({
        path: destinationPath,
        content: applyEdits(
          encoder.encode(spec.document.text),
          fileEdits ?? [],
        ),
      });
      continue;
    }
    if (fileEdits !== undefined) {
      rewrites.push({
        path,
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
    // SPEC 6.1/6.5: the appended entry records the operation and the full
    // mapping it produced.
    entry: createJournalEntry(
      "move-file",
      originPath,
      destinationPath,
      mapping,
    ),
    rewrites,
  };
}

// ---------------------------------------------------------------------------
// The section form (SPEC 6.5 second form)
// ---------------------------------------------------------------------------

const LF = 0x0a;
const CR = 0x0d;

/** SPEC 3: a line terminator byte (CRLF handled where terminators end). */
function isTerminatorByte(byte: number): boolean {
  return byte === LF || byte === CR;
}

/**
 * SPEC 1.4 whitespace, as UTF-8 bytes — all six characters are ASCII, so
 * byte scans over UTF-8 content are exact (multi-byte sequences never
 * contain ASCII bytes).
 */
function isWhitespaceByte(byte: number): boolean {
  return (
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

/** The start of the line containing `pos` (SPEC 3: maximal terminator-free run). */
function lineStartBefore(bytes: Uint8Array, pos: number): number {
  let cursor = pos;
  while (cursor > 0 && !isTerminatorByte(bytes[cursor - 1]!)) {
    cursor -= 1;
  }
  return cursor;
}

/** The end of the line content containing `pos` (the terminator's start, or EOF). */
function lineContentEndAfter(bytes: Uint8Array, pos: number): number {
  let cursor = pos;
  while (cursor < bytes.length && !isTerminatorByte(bytes[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

/**
 * The end of the line whose content ends at `contentEnd`, terminator
 * included (SPEC 3: U+000D U+000A is one terminator; the final line MAY
 * have none).
 */
function terminatorEndAt(bytes: Uint8Array, contentEnd: number): number {
  if (contentEnd >= bytes.length) {
    return contentEnd;
  }
  if (bytes[contentEnd] === CR && bytes[contentEnd + 1] === LF) {
    return contentEnd + 2;
  }
  return contentEnd + 1;
}

/** One merged output line touched by deletions (the SPEC 3 drop unit). */
interface DeletionCluster {
  extStart: number;
  contentEnd: number;
  extEnd: number;
  ranges: ByteRange[];
}

/**
 * Deletion edits for `ranges` with the SPEC 3 line-drop rule, exactly as
 * Markdown compilation applies it (SPEC 6.5: "dropped with their line
 * terminators, exactly as in Markdown compilation"): a deleted range
 * spanning line terminators merges its lines into one output line, and a
 * merged line that contained non-whitespace in the source but whose kept
 * characters are empty or whitespace-only purely by the deletion is dropped
 * together with its final terminator; every other line keeps its remaining
 * content and terminator.
 */
function deletionEditsWithLineDrops(
  bytes: Uint8Array,
  ranges: readonly ByteRange[],
): SourceEdit[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      throw new Error("xspec internal error: overlapping move deletions");
    }
  }
  const clusters: DeletionCluster[] = [];
  for (const range of sorted) {
    const last = clusters[clusters.length - 1];
    const extStart = lineStartBefore(bytes, range.start);
    const contentEnd = lineContentEndAfter(bytes, range.end);
    const extEnd = terminatorEndAt(bytes, contentEnd);
    if (last !== undefined && extStart < last.extEnd) {
      // The ranges share a (merged) line: one drop unit (SPEC 3).
      last.ranges.push(range);
      if (contentEnd > last.contentEnd) {
        last.contentEnd = contentEnd;
        last.extEnd = extEnd;
      }
    } else {
      clusters.push({ extStart, contentEnd, extEnd, ranges: [range] });
    }
  }
  const edits: SourceEdit[] = [];
  for (const cluster of clusters) {
    // SPEC 3: "contained non-whitespace in the source" — over the merged
    // line's source characters, deleted characters included (interior
    // terminators are whitespace either way).
    let hadNonWhitespace = false;
    for (let pos = cluster.extStart; pos < cluster.contentEnd; pos += 1) {
      if (!isWhitespaceByte(bytes[pos]!)) {
        hadNonWhitespace = true;
        break;
      }
    }
    // The kept characters: everything in the merged line the deletion does
    // not cover.
    let keptWhitespaceOnly = true;
    let cursor = cluster.extStart;
    for (const range of cluster.ranges) {
      for (let pos = cursor; pos < range.start; pos += 1) {
        if (!isWhitespaceByte(bytes[pos]!)) {
          keptWhitespaceOnly = false;
        }
      }
      cursor = range.end;
    }
    for (let pos = cursor; pos < cluster.contentEnd; pos += 1) {
      if (!isWhitespaceByte(bytes[pos]!)) {
        keptWhitespaceOnly = false;
      }
    }
    if (hadNonWhitespace && keptWhitespaceOnly) {
      // SPEC 3/6.5: drop the merged line — kept characters and final
      // terminator alike.
      edits.push({
        range: { start: cluster.extStart, end: cluster.extEnd },
        replacement: "",
      });
    } else {
      for (const range of cluster.ranges) {
        edits.push({ range, replacement: "" });
      }
    }
  }
  return edits;
}

/**
 * ECMAScript reserved words, which an import binding can never use — the
 * fresh-identifier chooser (SPEC 6.5) skips them.
 */
const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** SPEC 2.1: names an xspec import may never bind (never shadowed). */
const COMPILER_PROVIDED_NAMES: ReadonlySet<string> = new Set([
  "S",
  "Spec",
  "text",
]);

/**
 * The deterministic identifier base derived from a module path's file stem
 * (SPEC 6.5: identifier choice is deterministic): identifier-friendly
 * characters kept, every other character replaced by `_`, a leading digit
 * (or empty stem) prefixed with `_`.
 */
function stemIdentifierBase(modulePath: string): string {
  const fileName = modulePath.slice(modulePath.lastIndexOf("/") + 1);
  const stem = fileName.endsWith(MDX_SUFFIX)
    ? fileName.slice(0, -MDX_SUFFIX.length)
    : fileName;
  let base = "";
  for (const character of stem) {
    base += /[A-Za-z0-9_$]/.test(character) ? character : "_";
  }
  if (base.length === 0 || /^[0-9]/.test(base)) {
    base = `_${base}`;
  }
  return base;
}

/**
 * A fresh import binding name for `modulePath` colliding with no name in
 * `taken` (SPEC 6.5, 2.1: fresh, non-colliding, deterministic): the stem
 * base, then base2, base3, … — skipping reserved words and the
 * compiler-provided names.
 */
function freshBindingName(
  modulePath: string,
  taken: ReadonlySet<string>,
): string {
  const base = stemIdentifierBase(modulePath);
  const usable = (name: string): boolean =>
    !taken.has(name) &&
    !RESERVED_BINDING_NAMES.has(name) &&
    !COMPILER_PROVIDED_NAMES.has(name);
  if (usable(base)) {
    return base;
  }
  for (let counter = 2; ; counter += 1) {
    const candidate = `${base}${counter}`;
    if (usable(candidate)) {
      return candidate;
    }
  }
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** One reference of a spec file with its declaring section (SPEC 2.2, 2.3). */
interface LocatedReference {
  readonly section: SpecSection;
  readonly reference: SpecReference;
}

/** Every reference of a spec file, `d` and `text(...)` alike, in document order. */
function locatedReferencesOf(spec: SpecFileAnalysis): LocatedReference[] {
  const references: LocatedReference[] = [];
  for (const dependency of spec.references.dependencies) {
    references.push({
      section: dependency.section,
      reference: dependency.reference,
    });
  }
  for (const embedding of spec.references.embeddings) {
    if (embedding.reference === null) {
      throw new Error(
        `xspec internal error: an unanalyzable embedding in ` +
          `${spec.document.path} of a validated workspace`,
      );
    }
    references.push({
      section: embedding.embedding.section,
      reference: embedding.reference,
    });
  }
  return references;
}

/**
 * The per-file spec-import bookkeeping of a section move (SPEC 6.5, 2.1):
 * resolves needed module bindings (an existing binding of the module when
 * the file has one, a fresh deterministic identifier otherwise), counts
 * reference departures and arrivals per binding, and yields the exact
 * import removals — a binding that had references and is left with none —
 * and the added imports.
 */
class SpecImportPlan {
  private readonly beforeRefs = new Map<string, number>();
  private readonly departures = new Map<string, number>();
  private readonly arrivals = new Map<string, number>();
  private readonly taken = new Set<string>();
  private readonly additions = new Map<string, string>();

  /** `spec` is null for a target file the move creates (SPEC 6.5). */
  constructor(private readonly spec: SpecFileAnalysis | null) {
    if (spec !== null) {
      for (const imported of spec.imports.imports) {
        if (imported.bindingName !== null) {
          this.taken.add(imported.bindingName);
        }
      }
      for (const located of locatedReferencesOf(spec)) {
        if (located.reference.spelling.form === "chain") {
          bump(this.beforeRefs, located.reference.spelling.rootName);
        }
      }
    }
  }

  /**
   * The binding name a rewritten reference to `modulePath` roots at in this
   * file (SPEC 6.5: an import is added when a rewritten reference needs a
   * module binding its file lacks). Counts one arrival per call.
   */
  bindingFor(modulePath: string): string {
    if (this.spec !== null) {
      for (const imported of this.spec.imports.imports) {
        if (
          imported.targetPath === modulePath &&
          imported.bindingName !== null
        ) {
          bump(this.arrivals, imported.bindingName);
          return imported.bindingName;
        }
      }
    }
    const added = this.additions.get(modulePath);
    if (added !== undefined) {
      return added;
    }
    const name = freshBindingName(modulePath, this.taken);
    this.taken.add(name);
    this.additions.set(modulePath, name);
    return name;
  }

  /** One reference rooted at `rootName` leaves this file or its root. */
  depart(rootName: string): void {
    bump(this.departures, rootName);
  }

  /**
   * SPEC 6.5/2.1: the imports removed — exactly those whose binding had
   * references and the rewrite leaves with none; a binding that was already
   * unreferenced stays.
   */
  removedImports(): SpecImport[] {
    if (this.spec === null) {
      return [];
    }
    const removed: SpecImport[] = [];
    for (const imported of this.spec.imports.imports) {
      const name = imported.bindingName;
      if (name === null) {
        throw new Error(
          `xspec internal error: an invalid import in ` +
            `${this.spec.document.path} of a validated workspace`,
        );
      }
      const before = this.beforeRefs.get(name) ?? 0;
      const after =
        before -
        (this.departures.get(name) ?? 0) +
        (this.arrivals.get(name) ?? 0);
      if (before > 0 && after === 0) {
        removed.push(imported);
      }
    }
    return removed;
  }

  /** The added imports, ordered by module path bytes (deterministic). */
  addedImports(): { readonly modulePath: string; readonly name: string }[] {
    return [...this.additions.entries()]
      .map(([modulePath, name]) => ({ modulePath, name }))
      .sort((a, b) => compareBytes(a.modulePath, b.modulePath));
  }
}

/**
 * Rendered access text for one chain segment (SPEC 6.4/6.5 conversion
 * spelling: dot access for segments that are valid TypeScript identifiers,
 * double-quoted computed access otherwise).
 */
function renderAccess(segment: string): string {
  return isDotAccessSegmentName(segment)
    ? `.${segment}`
    : `[${jsStringLiteral(segment, '"')}]`;
}

/** A whole chain reference's text: root binding plus rendered accesses. */
function renderChain(rootName: string, segments: readonly string[]): string {
  let out = rootName;
  for (const segment of segments) {
    out += renderAccess(segment);
  }
  return out;
}

/** The full byte span of a chain spelling, root through last access. */
function chainSpan(
  spelling: Extract<ReferenceSpelling, { form: "chain" }>,
): ByteRange {
  const last = spelling.segments[spelling.segments.length - 1];
  return {
    start: spelling.rootRange.start,
    end: last === undefined ? spelling.rootRange.end : last.accessRange.end,
  };
}

/** Whether a chain's segments start with the moved ID's segments (SPEC 6.5). */
function segmentsPrefixed(
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

/**
 * The edits retargeting one chain to the moved subtree's new identity
 * (SPEC 6.5): the root rewritten to `newRootName` when it must change, and
 * the old ID's segment prefix replaced by the new ID's — per-segment
 * minimal edits preserving access form when the segment counts agree
 * (SPEC 6.4), the whole prefix span re-rendered otherwise (a form that
 * cannot be kept).
 */
function chainPrefixEdits(
  spelling: Extract<ReferenceSpelling, { form: "chain" }>,
  oldSegments: readonly string[],
  newSegments: readonly string[],
  newRootName: string | null,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  if (newRootName !== null && newRootName !== spelling.rootName) {
    edits.push({ range: spelling.rootRange, replacement: newRootName });
  }
  const count = oldSegments.length;
  if (spelling.segments.length < count) {
    throw new Error(
      "xspec internal error: affected chain shorter than the moved ID",
    );
  }
  if (newSegments.length === count) {
    for (let index = 0; index < count; index += 1) {
      if (oldSegments[index] !== newSegments[index]) {
        edits.push(segmentEdit(spelling.segments[index]!, newSegments[index]!));
      }
    }
  } else {
    let rendered = "";
    for (const segment of newSegments) {
      rendered += renderAccess(segment);
    }
    edits.push({
      range: {
        start: spelling.segments[0]!.accessRange.start,
        end: spelling.segments[count - 1]!.accessRange.end,
      },
      replacement: rendered,
    });
  }
  return edits;
}

/** The moved-text insertion of one target file (SPEC 6.5). */
interface SectionInsertion {
  /** Insertion offset in the file's original bytes. */
  readonly pos: number;
  /** The re-identified, rewritten moved construct's bytes. */
  readonly body: Uint8Array;
  /**
   * The closing tag appended when the target parent was self-closing
   * (SPEC 6.5: rewritten to paired form) — `</S>`/`</Spec>` — else null.
   */
  readonly pairedClosingTag: string | null;
}

/** Map an original-byte offset through non-straddling edits (SPEC 6.5). */
function mapOffsetThroughEdits(
  offset: number,
  edits: readonly SourceEdit[],
): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.range.end <= offset) {
      delta +=
        encoder.encode(edit.replacement).length -
        (edit.range.end - edit.range.start);
    } else if (edit.range.start < offset) {
      throw new Error(
        "xspec internal error: a move edit straddles the insertion point",
      );
    }
  }
  return offset + delta;
}

/**
 * Apply a file's edits and the moved-text insertion (SPEC 6.5): the
 * insertion lands immediately before the target parent's closing tag (or at
 * the end of the file), followed by U+000A and preceded by one when the
 * insertion point — evaluated over the edited content — is not at the start
 * of a line; a self-closing parent's appended closing tag follows the
 * inserted text, so the insertion point (immediately after the opening
 * tag's `>`) is never at a line start.
 */
function assembleWithInsertion(
  base: Uint8Array,
  edits: readonly SourceEdit[],
  insertion: SectionInsertion,
): Uint8Array {
  const staged = applyEdits(base, edits);
  const pos = mapOffsetThroughEdits(insertion.pos, edits);
  const atLineStart = pos === 0 || isTerminatorByte(staged[pos - 1]!);
  const leading =
    insertion.pairedClosingTag !== null || !atLineStart ? "\n" : "";
  const head = encoder.encode(leading);
  const tail = encoder.encode(`\n${insertion.pairedClosingTag ?? ""}`);
  const out = new Uint8Array(
    staged.length + head.length + insertion.body.length + tail.length,
  );
  out.set(staged.subarray(0, pos), 0);
  let cursor = pos;
  out.set(head, cursor);
  cursor += head.length;
  out.set(insertion.body, cursor);
  cursor += insertion.body.length;
  out.set(tail, cursor);
  cursor += tail.length;
  out.set(staged.subarray(pos), cursor);
  return out;
}

/** Everything a validated section-form move changes in the sources. */
export interface MoveSectionPlan {
  /** The full identity mapping the operation produces (SPEC 6.5, 6.1). */
  readonly mapping: readonly IdentityMapping[];
  /** The journal entry recording the operation and its mapping (SPEC 6.1). */
  readonly entry: JournalEntry;
  /** Every rewritten source file — the target file (possibly new) included. */
  readonly rewrites: readonly SourceRewrite[];
  /** Whether the plan creates the target file (absent before the move). */
  readonly createsTargetFile: boolean;
}

/** An import declaration line for a spec file (SPEC 2.1, 6.5 additions). */
function specImportLine(
  filePath: string,
  modulePath: string,
  name: string,
): string {
  const specifier = relativeModuleSpecifier(
    filePath,
    moduleSpecifierTargetOf(modulePath),
  );
  return `import ${name} from ${jsStringLiteral(specifier, '"')}`;
}

/**
 * Derive the SPEC 6.5 section-form move plan over a validated workspace's
 * analyses. See the module header for the exact text rules and the
 * preconditions the caller has established.
 */
export function planMoveSection(
  specs: readonly SpecFileAnalysis[],
  code: readonly CodeAnalysis[],
  originPath: string,
  oldId: string,
  targetPath: string,
  newId: string,
): MoveSectionPlan {
  const origin = specs.find((spec) => spec.document.path === originPath);
  if (origin === undefined) {
    throw new Error(
      `xspec internal error: move origin ${originPath} is not among the ` +
        `analyzed spec sources`,
    );
  }
  const movedSection = origin.document.sections.find(
    (section) => section.id === oldId,
  );
  if (movedSection === undefined) {
    throw new Error(
      `xspec internal error: move origin ID ${oldId} is not a section of ` +
        `${originPath} — the caller validated its existence`,
    );
  }
  if (originPath === targetPath && oldId === newId) {
    throw new Error(
      "xspec internal error: the exact self-move — the caller refused it " +
        "(SPEC 6.5)",
    );
  }
  const sameFile = originPath === targetPath;
  const target = sameFile
    ? origin
    : specs.find((spec) => spec.document.path === targetPath);
  const createsTargetFile = target === undefined;
  const oldSegments = oldId.split(".");
  const newSegments = newId.split(".");
  const movedRange = movedSection.range;
  const originBytes = encoder.encode(origin.document.text);

  // The identity mapping (SPEC 6.5, 6.1): the moved section and every
  // descendant, re-identified by prefix replacement.
  const mapping: IdentityMapping[] = [];
  for (const section of origin.document.sections) {
    if (section.id === null) {
      throw new Error(
        `xspec internal error: a section of ${originPath} in a validated ` +
          `workspace has no ID`,
      );
    }
    const mapped = replaceIdPrefix(section.id, oldId, newId);
    if (mapped !== null) {
      mapping.push({
        from: `${originPath}#${section.id}`,
        to: `${targetPath}#${mapped}`,
      });
    }
  }

  // The target parent: the target file's section bearing `<new-id>` minus
  // its final segment — the file's root (insertion at end of file) for a
  // top-level `new-id` (SPEC 6.5). The caller validated its existence and
  // that it lies outside the moved subtree.
  let parentSection: SpecSection | null = null;
  if (newSegments.length > 1) {
    const parentId = newSegments.slice(0, -1).join(".");
    const found = target?.document.sections.find(
      (section) => section.id === parentId,
    );
    if (found === undefined) {
      throw new Error(
        `xspec internal error: missing target parent ${parentId} — the ` +
          `caller validated its existence (SPEC 6.5)`,
      );
    }
    if (sameFile && replaceIdPrefix(parentId, oldId, newId) !== null) {
      throw new Error(
        `xspec internal error: target parent ${parentId} lies within the ` +
          `moved subtree — the caller refused this move (SPEC 6.5)`,
      );
    }
    parentSection = found;
  }

  // Edit collections: inner edits fall within the moved construct and are
  // applied to the extracted slice; outer edits apply to each file's
  // remaining content.
  const outerEdits = new EditCollector();
  const innerEdits: SourceEdit[] = [];
  const addInner = (edit: SourceEdit): void => {
    if (
      edit.range.start < movedRange.start ||
      edit.range.end > movedRange.end
    ) {
      throw new Error(
        "xspec internal error: an inner move edit outside the moved construct",
      );
    }
    innerEdits.push(edit);
  };

  // Import bookkeeping (cross-file only): per-file plans, created lazily.
  const importPlans = new Map<string, SpecImportPlan>();
  const planFor = (spec: SpecFileAnalysis | null, path: string) => {
    let plan = importPlans.get(path);
    if (plan === undefined) {
      plan = new SpecImportPlan(spec);
      importPlans.set(path, plan);
    }
    return plan;
  };

  // SPEC 6.5: re-identify the moved section and its descendants by prefix
  // replacement — the `id` attribute values rewritten in place, quote style
  // preserved (SPEC 6.4).
  for (const section of origin.document.sections) {
    if (section.id === null) {
      continue;
    }
    const mapped = replaceIdPrefix(section.id, oldId, newId);
    if (mapped === null) {
      continue;
    }
    const attribute = section.idAttribute;
    if (attribute === null) {
      throw new Error(
        `xspec internal error: section ${originPath}#${section.id} of a ` +
          `validated workspace has no recorded id attribute`,
      );
    }
    addInner({
      range: attribute.valueRange,
      replacement: attributeValueText(mapped, attribute.quote),
    });
  }

  // SPEC 6.5: rewrite every reference across the workspace to resolve to
  // the new identities, converting between local and imported forms as the
  // rewrite requires. Spec files first (byte order), references in document
  // order — the deterministic order fresh identifiers are allocated in.
  for (const spec of specs) {
    const path = spec.document.path;
    for (const located of locatedReferencesOf(spec)) {
      const { section, reference } = located;
      const declaredInMoved =
        spec === origin &&
        section.id !== null &&
        replaceIdPrefix(section.id, oldId, newId) !== null;

      if (reference.target.kind === "local") {
        if (spec !== origin) {
          continue; // the local form names an ID of its own file (SPEC 2.2)
        }
        const mappedLocal = replaceIdPrefix(
          reference.target.idPath,
          oldId,
          newId,
        );
        if (reference.spelling.form !== "string") {
          throw new Error(
            "xspec internal error: a local reference without a string " +
              "spelling",
          );
        }
        if (declaredInMoved) {
          if (mappedLocal !== null) {
            // Within the moved subtree: stays local, re-identified by
            // prefix replacement, quote style preserved (SPEC 6.5, 6.4).
            addInner({
              range: reference.spelling.range,
              replacement: jsStringLiteral(
                mappedLocal,
                reference.spelling.quote,
              ),
            });
          } else if (!sameFile) {
            // A moved reference to a node staying behind: local → imported,
            // rooted at the target file's binding of the origin module
            // (SPEC 6.5).
            const name = planFor(
              createsTargetFile ? null : (target ?? null),
              targetPath,
            ).bindingFor(originPath);
            addInner({
              range: reference.spelling.range,
              replacement: renderChain(
                name,
                reference.target.idPath.split("."),
              ),
            });
          }
          continue;
        }
        if (mappedLocal === null) {
          continue;
        }
        if (sameFile) {
          // Same-file move: the reference stays local under the new ID.
          outerEdits.add(path, {
            range: reference.spelling.range,
            replacement: jsStringLiteral(mappedLocal, reference.spelling.quote),
          });
        } else {
          // A remaining reference to the moved subtree: local → imported,
          // rooted at the origin file's binding of the target module
          // (SPEC 6.5).
          const name = planFor(origin, originPath).bindingFor(targetPath);
          outerEdits.add(path, {
            range: reference.spelling.range,
            replacement: renderChain(name, mappedLocal.split(".")),
          });
        }
        continue;
      }

      // External chain references (SPEC 2.2, 2.4).
      const { modulePath, segments } = reference.target;
      if (reference.spelling.form !== "chain") {
        throw new Error(
          "xspec internal error: an external reference without a chain " +
            "spelling",
        );
      }
      if (declaredInMoved) {
        if (sameFile) {
          continue; // roots and targets are unaffected by a same-file move
        }
        // The reference departs the origin file with the moved text.
        planFor(origin, originPath).depart(reference.spelling.rootName);
        if (modulePath === targetPath) {
          // The moved text references the file it moves into: imported →
          // local (SPEC 6.5); a file never imports itself (SPEC 2.1).
          if (segments.length === 0) {
            throw new Error(
              "xspec internal error: a moved reference targets the target " +
                "file's root node — the caller refused this move (SPEC 6.5)",
            );
          }
          addInner({
            range: chainSpan(reference.spelling),
            replacement: jsStringLiteral(segments.join("."), '"'),
          });
        } else {
          // The chain must root at the target file's binding of the same
          // module — an existing binding, or a fresh added import
          // (SPEC 6.5, 2.1).
          const name = planFor(
            createsTargetFile ? null : (target ?? null),
            targetPath,
          ).bindingFor(modulePath);
          if (name !== reference.spelling.rootName) {
            addInner({
              range: reference.spelling.rootRange,
              replacement: name,
            });
          }
        }
        continue;
      }
      // Declared outside the moved subtree: only chains into the moved
      // subtree are affected (SPEC 6.5).
      if (
        modulePath !== originPath ||
        !segmentsPrefixed(segments, oldSegments)
      ) {
        continue;
      }
      if (!sameFile && spec === target) {
        // The target file's own reference to the moved subtree: imported →
        // local under the new identity (SPEC 6.5; double-quoted string, 6.4).
        const rest = segments.slice(oldSegments.length);
        planFor(target ?? null, targetPath).depart(reference.spelling.rootName);
        outerEdits.add(path, {
          range: chainSpan(reference.spelling),
          replacement: jsStringLiteral(
            [...newSegments, ...rest].join("."),
            '"',
          ),
        });
        continue;
      }
      if (sameFile) {
        // The module is unchanged; only the segment prefix is re-identified.
        for (const edit of chainPrefixEdits(
          reference.spelling,
          oldSegments,
          newSegments,
          null,
        )) {
          outerEdits.add(path, edit);
        }
        continue;
      }
      // Another spec file's chain into the moved subtree: re-rooted at that
      // file's binding of the target module, segments re-identified
      // (SPEC 6.5).
      const filePlan = planFor(spec, path);
      filePlan.depart(reference.spelling.rootName);
      const rootName = filePlan.bindingFor(targetPath);
      for (const edit of chainPrefixEdits(
        reference.spelling,
        oldSegments,
        newSegments,
        rootName,
      )) {
        outerEdits.add(path, edit);
      }
    }
  }

  // SPEC 6.5: TypeScript markers and `text(...)` calls into the moved
  // subtree, re-rooted at a binding of the target module (an existing
  // spec-module import's default binding, or a fresh added import) with the
  // segment prefix re-identified. Type-level references record no edges
  // (SPEC 4.5) and are absent from the analyzed references.
  const codeAdditions = new Map<string, Map<string, string>>();
  for (const analysis of code) {
    let taken: Set<string> | null = null;
    for (const reference of analysis.references) {
      if (
        reference.modulePath !== originPath ||
        !segmentsPrefixed(reference.segments, oldSegments)
      ) {
        continue;
      }
      if (reference.spelling.form !== "chain") {
        throw new Error(
          "xspec internal error: a code reference without a chain spelling",
        );
      }
      let rootName: string | null = null;
      if (!sameFile) {
        const existing = analysis.imports.find(
          (imported) =>
            imported.valid &&
            imported.targetPath === targetPath &&
            imported.defaultBinding !== null &&
            !imported.defaultBinding.typeOnly,
        );
        if (existing !== undefined) {
          rootName = existing.defaultBinding!.name;
        } else {
          let additions = codeAdditions.get(analysis.path);
          if (additions === undefined) {
            additions = new Map();
            codeAdditions.set(analysis.path, additions);
          }
          const added = additions.get(targetPath);
          if (added !== undefined) {
            rootName = added;
          } else {
            if (taken === null) {
              taken = new Set();
              for (const imported of analysis.imports) {
                if (imported.defaultBinding !== null) {
                  taken.add(imported.defaultBinding.name);
                }
                for (const binding of imported.textBindings) {
                  taken.add(binding.name);
                }
              }
            }
            rootName = freshBindingName(targetPath, taken);
            taken.add(rootName);
            additions.set(targetPath, rootName);
          }
        }
      }
      for (const edit of chainPrefixEdits(
        reference.spelling,
        oldSegments,
        newSegments,
        rootName,
      )) {
        outerEdits.add(analysis.path, edit);
      }
    }
  }

  // The rewritten moved text: the extracted slice with the inner edits
  // applied (SPEC 6.5: the moved text is the construct's own characters —
  // it travels verbatim beyond the identity and reference rewrites).
  const movedBody = applyEdits(
    originBytes.subarray(movedRange.start, movedRange.end),
    innerEdits.map((edit) => ({
      range: {
        start: edit.range.start - movedRange.start,
        end: edit.range.end - movedRange.start,
      },
      replacement: edit.replacement,
    })),
  );

  // Per-file import add/remove edits (cross-file only): removals are
  // line-dropped like every 6.5 deletion; additions anchor after the last
  // surviving import, at the removed block's position when none survives,
  // or at the start of the file (blank-line separated) when the file had no
  // imports (deterministic placement, SPEC 6.5).
  interface ImportEditSet {
    readonly deletionRanges: ByteRange[];
    readonly additionEdit: SourceEdit | null;
  }
  const importEditsFor = (
    spec: SpecFileAnalysis,
    plan: SpecImportPlan,
    bytes: Uint8Array,
  ): ImportEditSet => {
    const removed = plan.removedImports();
    const added = plan.addedImports();
    const removedSet = new Set(removed);
    const deletionRanges = removed.map((imported) => imported.statement.range);
    if (added.length === 0) {
      return { deletionRanges, additionEdit: null };
    }
    const path = spec.document.path;
    const lines = added.map((addition) =>
      specImportLine(path, addition.modulePath, addition.name),
    );
    const survivors = spec.imports.imports.filter(
      (imported) => !removedSet.has(imported),
    );
    const lastSurvivor = survivors[survivors.length - 1];
    if (lastSurvivor !== undefined) {
      const anchor = lastSurvivor.statement.range.end;
      return {
        deletionRanges,
        additionEdit: {
          range: { start: anchor, end: anchor },
          replacement: lines.map((line) => `\n${line}`).join(""),
        },
      };
    }
    const firstRemoved = removed[0];
    if (firstRemoved !== undefined) {
      const anchor = lineStartBefore(bytes, firstRemoved.statement.range.start);
      return {
        deletionRanges,
        additionEdit: {
          range: { start: anchor, end: anchor },
          replacement: lines.map((line) => `${line}\n`).join(""),
        },
      };
    }
    return {
      deletionRanges,
      additionEdit: {
        range: { start: 0, end: 0 },
        replacement: `${lines.map((line) => `${line}\n`).join("")}\n`,
      },
    };
  };

  // Assemble every rewritten file.
  const rewrites: SourceRewrite[] = [];

  // The insertion point (SPEC 6.5): immediately before the target parent's
  // closing tag; the end of the file for a top-level `new-id`; immediately
  // after the terminating `>` for a self-closing parent rewritten to paired
  // form.
  const targetBytes = sameFile
    ? originBytes
    : target !== undefined
      ? encoder.encode(target.document.text)
      : new Uint8Array(0);
  let insertion: SectionInsertion;
  let pairedFormEdit: SourceEdit | null = null;
  if (parentSection === null) {
    insertion = {
      pos: targetBytes.length,
      body: movedBody,
      pairedClosingTag: null,
    };
  } else if (parentSection.selfClosing) {
    // SPEC 6.5: the self-closing parent's `/` and any whitespace
    // immediately before or after it are deleted; the matching closing tag
    // is appended immediately after the tag's terminating `>`, and the
    // insertion rule applies before that closing tag.
    const tag = parentSection.openingTagRange;
    let slash = tag.end - 2; // the byte before the terminating `>`
    while (slash > tag.start && isWhitespaceByte(targetBytes[slash]!)) {
      slash -= 1;
    }
    if (targetBytes[slash] !== 0x2f /* `/` */) {
      throw new Error(
        "xspec internal error: a self-closing section tag without its `/`",
      );
    }
    let wsStart = slash;
    while (wsStart > tag.start && isWhitespaceByte(targetBytes[wsStart - 1]!)) {
      wsStart -= 1;
    }
    pairedFormEdit = {
      range: { start: wsStart, end: tag.end - 1 },
      replacement: "",
    };
    // `<Spec` when the name byte run after `<` is exactly "Spec".
    const isSpec =
      targetBytes[tag.start + 1] === 0x53 /* S */ &&
      targetBytes[tag.start + 2] === 0x70 /* p */ &&
      targetBytes[tag.start + 3] === 0x65 /* e */ &&
      targetBytes[tag.start + 4] === 0x63; /* c */
    insertion = {
      pos: tag.end,
      body: movedBody,
      pairedClosingTag: isSpec ? "</Spec>" : "</S>",
    };
  } else {
    insertion = {
      pos: parentSection.closingTagRange.start,
      body: movedBody,
      pairedClosingTag: null,
    };
  }

  if (sameFile) {
    // One file carries the deletion, the outer rewrites, the paired-form
    // rewrite of a self-closing target parent, and the insertion.
    const edits: SourceEdit[] = [
      ...deletionEditsWithLineDrops(originBytes, [movedRange]),
      ...(outerEdits.editsFor(originPath) ?? []),
      ...(pairedFormEdit === null ? [] : [pairedFormEdit]),
    ];
    rewrites.push({
      path: originPath,
      content: assembleWithInsertion(originBytes, edits, insertion),
    });
  } else {
    // The origin file: construct deletion, remaining-reference rewrites,
    // import removals and additions (SPEC 6.5).
    const originImports = importEditsFor(
      origin,
      planFor(origin, originPath),
      originBytes,
    );
    const originEdits: SourceEdit[] = [
      ...deletionEditsWithLineDrops(originBytes, [
        movedRange,
        ...originImports.deletionRanges,
      ]),
      ...(outerEdits.editsFor(originPath) ?? []),
      ...(originImports.additionEdit === null
        ? []
        : [originImports.additionEdit]),
    ];
    rewrites.push({
      path: originPath,
      content: applyEdits(originBytes, originEdits),
    });

    // The target file: created empty before insertion (SPEC 6.5), or the
    // existing file with its conversions, import edits, the paired-form
    // rewrite, and the insertion.
    if (target === undefined) {
      const plan = planFor(null, targetPath);
      const added = plan.addedImports();
      const importBlock =
        added.length === 0
          ? ""
          : `${added
              .map((addition) =>
                specImportLine(targetPath, addition.modulePath, addition.name),
              )
              .map((line) => `${line}\n`)
              .join("")}\n`;
      const head = encoder.encode(importBlock);
      const tail = encoder.encode("\n");
      const content = new Uint8Array(
        head.length + movedBody.length + tail.length,
      );
      content.set(head, 0);
      content.set(movedBody, head.length);
      content.set(tail, head.length + movedBody.length);
      rewrites.push({ path: targetPath, content });
    } else {
      const targetImports = importEditsFor(
        target,
        planFor(target, targetPath),
        targetBytes,
      );
      const targetEdits: SourceEdit[] = [
        ...deletionEditsWithLineDrops(
          targetBytes,
          targetImports.deletionRanges,
        ),
        ...(outerEdits.editsFor(targetPath) ?? []),
        ...(targetImports.additionEdit === null
          ? []
          : [targetImports.additionEdit]),
        ...(pairedFormEdit === null ? [] : [pairedFormEdit]),
      ];
      rewrites.push({
        path: targetPath,
        content: assembleWithInsertion(targetBytes, targetEdits, insertion),
      });
    }

    // Other spec files: chain retargets plus their import edits.
    for (const spec of specs) {
      const path = spec.document.path;
      if (path === originPath || path === targetPath) {
        continue;
      }
      const plan = importPlans.get(path);
      const fileEdits: SourceEdit[] = [...(outerEdits.editsFor(path) ?? [])];
      if (plan !== undefined) {
        const bytes = encoder.encode(spec.document.text);
        const imports = importEditsFor(spec, plan, bytes);
        fileEdits.push(
          ...deletionEditsWithLineDrops(bytes, imports.deletionRanges),
        );
        if (imports.additionEdit !== null) {
          fileEdits.push(imports.additionEdit);
        }
        if (fileEdits.length > 0) {
          rewrites.push({ path, content: applyEdits(bytes, fileEdits) });
        }
        continue;
      }
      if (fileEdits.length > 0) {
        rewrites.push({
          path,
          content: applyEdits(encoder.encode(spec.document.text), fileEdits),
        });
      }
    }
  }

  if (sameFile) {
    // Same-file moves still rewrite other files' chains into the subtree.
    for (const spec of specs) {
      const path = spec.document.path;
      if (path === originPath) {
        continue;
      }
      const fileEdits = outerEdits.editsFor(path);
      if (fileEdits !== undefined) {
        rewrites.push({
          path,
          content: applyEdits(encoder.encode(spec.document.text), fileEdits),
        });
      }
    }
  }

  // Code files: chain retargets plus added imports (SPEC 6.5, 4). Anchored
  // after the file's last spec-module import — a code file referencing the
  // moved subtree always has one (its chains root at import bindings).
  for (const analysis of code) {
    const fileEdits: SourceEdit[] = [
      ...(outerEdits.editsFor(analysis.path) ?? []),
    ];
    const additions = codeAdditions.get(analysis.path);
    if (additions !== undefined && additions.size > 0) {
      const anchor = analysis.imports[analysis.imports.length - 1];
      if (anchor === undefined) {
        throw new Error(
          `xspec internal error: code file ${analysis.path} references the ` +
            `moved subtree but has no spec module import`,
        );
      }
      const lines = [...additions.entries()]
        .sort((a, b) => compareBytes(a[0], b[0]))
        .map(
          ([modulePath, name]) =>
            `\nimport ${name} from ${jsStringLiteral(
              relativeModuleSpecifier(
                analysis.path,
                moduleSpecifierTargetOf(modulePath),
              ),
              '"',
            )};`,
        )
        .join("");
      fileEdits.push({
        range: { start: anchor.range.end, end: anchor.range.end },
        replacement: lines,
      });
    }
    if (fileEdits.length > 0) {
      rewrites.push({
        path: analysis.path,
        content: applyEdits(encoder.encode(analysis.text), fileEdits),
      });
    }
  }

  return {
    mapping,
    // SPEC 6.1/6.5: the appended entry records the operation and the full
    // mapping it produced.
    entry: createJournalEntry(
      "move-section",
      `${originPath}#${oldId}`,
      `${targetPath}#${newId}`,
      mapping,
    ),
    rewrites,
    createsTargetFile,
  };
}
