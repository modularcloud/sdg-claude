// The file-form move rewrite plan (SPEC 6.5) — the pure derivation.
//
// Pure core (IMPLEMENTATION Architecture: deterministic and I/O-free): over
// a validated workspace's analyses this module computes everything
// `xspec move <old-file> <new-file>` changes in the sources —
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
// specifiers behind those bindings move. Rewrites are minimal in-place
// edits (SPEC 6.4, 6.5): an import specifier that still resolves to its
// target from the moved file's new directory is kept verbatim; a rewritten
// one preserves the literal's quote style, and rewritten file content is a
// deterministic function of the operation and workspace state (SPEC 6.1).
//
// Callers validate first (SPEC 6.5): the workspace passes `build`
// validation (so every import is valid and every section has a valid ID),
// the origin is a discovered spec source, and the destination is a distinct
// path that would be a valid discovered spec source after the move. This
// module asserts those preconditions and throws on violation: they are
// caller defects, never user-facing paths.

import type { CodeAnalysis } from "./code-analysis.js";
import type { SourceRewrite } from "./edits.js";
import { applyEdits, EditCollector, jsStringLiteral } from "./edits.js";
import type { SpecFileAnalysis } from "./graph.js";
import type { IdentityMapping, JournalEntry } from "./journal.js";
import { createJournalEntry } from "./journal.js";
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
