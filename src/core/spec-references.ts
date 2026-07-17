// MDX-side import validation and reference extraction (SPEC 2.1–2.4).
//
// Over the parsed document model (./mdx.ts), this module validates the
// file's spec-module imports (SPEC 2.1 → 14.15) and extracts its
// references — `d` dependency references (SPEC 2.2) and `{text(...)}`
// embedding arguments (SPEC 2.3) — through the shared static-reference
// analyzer (./references.ts, SPEC 2.4; IMPLEMENTATION: one analyzer for
// MDX expression spans and TypeScript sources). Each reference is
// recorded as data: its target descriptor for graph resolution (SPEC 5.2
// — unknown targets report 14.5/14.6 there), its exact spelling and
// spans for the minimal in-place rewrites of rename and move (SPEC 6.4,
// 6.5), and its byte range for findings. Import-cycle detection over the
// recorded import targets is the graph's (SPEC 2.1, 5.3 → 14.9).
//
// Masking (SPEC 14): a reference whose chain is rooted at a binding
// introduced by an *invalid* import (or by colliding imports) is masked —
// the import's own 14.15 already accounts for it, and its target is
// undetectable — while a chain rooted at an identifier no import binds is
// a dynamic reference (14.8): it is not "rooted at an imported spec
// module" (SPEC 2.4). References through a valid import of an
// unparseable file are recorded normally and report as unresolved during
// resolution (SPEC 14.20, 14.5–14.7).

import ts from "typescript";
import type { ByteRange } from "./bytes.js";
import { Utf8Offsets } from "./bytes.js";
import type { Finding } from "./findings.js";
import type {
  SpecDocument,
  SpecEmbedding,
  SpecImportStatement,
  SpecSection,
} from "./mdx.js";
import type {
  ClassifiedChain,
  ClassifiedReference,
  ClassifiedString,
  TextSpan,
} from "./references.js";
import { classifyReference, parseExpressionText } from "./references.js";

// ---------------------------------------------------------------------------
// The import model (SPEC 2.1)
// ---------------------------------------------------------------------------

/** One import declaration of an xspec source file, analyzed (SPEC 2.1). */
export interface SpecImport {
  /** The declaration's statement span and exact text (SPEC 6.5 removals). */
  readonly statement: SpecImportStatement;
  /** The single default binding, when the form permits one (SPEC 2.1). */
  readonly bindingName: string | null;
  /** The module specifier's cooked value. */
  readonly specifier: string;
  /** The quote character of the specifier literal (SPEC 6.5 rewrites). */
  readonly specifierQuote: '"' | "'";
  /** The specifier literal's characters, quotes included (SPEC 6.5). */
  readonly specifierRange: ByteRange;
  /**
   * The designated source file's workspace-relative path (SPEC 2.1:
   * `DIR/NAME.xspec` designates `DIR/NAME.mdx`) when the import is valid
   * — the target of the file-level import edge (cycles, SPEC 5.3). Null
   * for an invalid import.
   */
  readonly targetPath: string | null;
  /** Whether the import itself is valid (duplicate bindings are pairwise). */
  readonly valid: boolean;
}

/** What one import-bound identifier means as a reference root (SPEC 2.2). */
export type SpecImportBinding =
  | {
      /** A valid spec-module binding: chains rooted here are external. */
      readonly kind: "module";
      readonly targetPath: string;
    }
  | {
      /**
       * A binding of an invalid import, or an identifier bound by more
       * than one import: the 14.15 accounts for it, and references rooted
       * here are masked (SPEC 14).
       */
      readonly kind: "poisoned";
    };

/** The analyzed imports of one xspec source file (SPEC 2.1). */
export interface SpecImportModel {
  /** Every import declaration, in document order. */
  readonly imports: readonly SpecImport[];
  /** Every import-bound identifier and what it means as a chain root. */
  readonly bindings: ReadonlyMap<string, SpecImportBinding>;
  /** The 14.15 findings (SPEC 2.1), ordered by location. */
  readonly findings: readonly Finding[];
}

/**
 * SPEC 2.1: resolve a relative import specifier against the importing
 * file's directory, over workspace-relative `/`-separated paths
 * (SPEC 1.5). Returns the resolved workspace-relative path, or null when
 * the specifier climbs out of the workspace root. Shared with the
 * TypeScript-side analysis (SPEC 4: same form and resolution as 2.1).
 */
export function resolveImportSpecifier(
  importerPath: string,
  specifier: string,
): string | null {
  const segments = importerPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (segments.length === 0) {
        return null; // resolves outside the workspace root
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

/** SPEC 2.1: the compiler-provided names an import may never bind. */
const COMPILER_PROVIDED_NAMES: ReadonlySet<string> = new Set([
  "S",
  "Spec",
  "text",
]);

const XSPEC_SUFFIX = ".xspec";

/** Translates analyzer spans of one re-parsed slice into byte ranges. */
class SpanTranslator {
  private readonly baseIndex: number;

  constructor(
    private readonly offsets: Utf8Offsets,
    sliceStartByte: number,
  ) {
    this.baseIndex = offsets.indexOfByteOffset(sliceStartByte);
  }

  range(span: TextSpan): ByteRange {
    return {
      start: this.offsets.byteOffset(this.baseIndex + span.start),
      end: this.offsets.byteOffset(this.baseIndex + span.end),
    };
  }
}

/** Every identifier an import clause binds, in written order. */
function boundIdentifiers(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) {
    return [];
  }
  const names: string[] = [];
  if (clause.name !== undefined) {
    names.push(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        names.push(element.name.text);
      }
    }
  }
  return names;
}

/**
 * Analyze and validate one file's spec-module imports (SPEC 2.1 →
 * 14.15). `specPaths` is the set of discovered spec-source paths (SPEC
 * 7.1): an import must designate one of them — whether the designated
 * file parses does not matter here (references through it report as
 * unresolved, SPEC 14.20, 14.5–14.7). Each invalid import yields exactly
 * one 14.15 finding listing its defects; identifiers bound by two
 * imports yield one 14.15 per re-binding import (SPEC 2.1: no two
 * imports in a file may bind the same identifier).
 */
export function analyzeSpecImports(
  document: SpecDocument,
  specPaths: ReadonlySet<string>,
): SpecImportModel {
  const imports: SpecImport[] = [];
  const bindings = new Map<string, SpecImportBinding>();
  const findings: Finding[] = [];
  /** name → whether any import already bound it (duplicate rule). */
  const seenNames = new Set<string>();

  for (const block of document.esmBlocks) {
    for (const statement of block.imports) {
      const parsed = parseImportStatement(statement.text);
      const translate = new SpanTranslator(
        document.offsets,
        statement.range.start,
      );
      const defects: string[] = [];

      // Binding form (SPEC 2.1: the only permitted form is a single
      // default binding; named, namespace, and side-effect-only imports
      // are invalid).
      const clause = parsed.importClause;
      const names = boundIdentifiers(clause);
      if (clause === undefined) {
        defects.push(
          "it is a side-effect-only import binding nothing — the only " +
            "permitted form is a single default binding",
        );
      } else {
        if (clause.isTypeOnly) {
          defects.push("it is a type-only import");
        }
        const named = clause.namedBindings;
        if (named !== undefined) {
          defects.push(
            ts.isNamespaceImport(named)
              ? "it uses a namespace-import binding — the only permitted " +
                  "form is a single default binding"
              : "it uses named-import bindings — the only permitted form " +
                  "is a single default binding",
          );
        }
      }
      if (parsed.attributes !== undefined) {
        defects.push("it carries import attributes");
      }

      // The specifier (SPEC 2.1: relative, `./` or `../`, ending
      // `.xspec`, designating a discovered spec-group source).
      const specifierLiteral = parsed.moduleSpecifier;
      if (!ts.isStringLiteral(specifierLiteral)) {
        throw new Error(
          "xspec internal error: import with a non-literal specifier",
        );
      }
      const specifier = specifierLiteral.text;
      const relative =
        specifier.startsWith("./") || specifier.startsWith("../");
      if (!relative) {
        defects.push(
          `the specifier ${JSON.stringify(specifier)} is not a relative ` +
            `path beginning with "./" or "../"`,
        );
      }
      if (!specifier.endsWith(XSPEC_SUFFIX)) {
        defects.push(
          `the specifier ${JSON.stringify(specifier)} does not end in ` +
            `".xspec"`,
        );
      }
      let targetPath: string | null = null;
      if (relative && specifier.endsWith(XSPEC_SUFFIX)) {
        const resolved = resolveImportSpecifier(document.path, specifier);
        if (resolved === null) {
          defects.push(
            `the specifier ${JSON.stringify(specifier)} resolves outside ` +
              `the workspace root`,
          );
        } else {
          // SPEC 2.1: `DIR/NAME.xspec` designates `DIR/NAME.mdx`.
          const designated = resolved.slice(0, -XSPEC_SUFFIX.length) + ".mdx";
          if (specPaths.has(designated)) {
            targetPath = designated;
          } else {
            defects.push(
              `the designated file ${JSON.stringify(designated)} is not a ` +
                `discovered source file of a configured spec group`,
            );
          }
        }
      }

      // SPEC 2.1: no import may bind `S`, `Spec`, or `text` — the
      // compiler-provided names are never shadowed.
      for (const name of names) {
        if (COMPILER_PROVIDED_NAMES.has(name)) {
          defects.push(
            `it binds the compiler-provided identifier ` +
              `${JSON.stringify(name)} — "S", "Spec", and "text" are ` +
              `never shadowed`,
          );
        }
      }

      const valid = defects.length === 0;
      if (!valid) {
        // SPEC 14.15: one finding per invalid import, listing its defects.
        findings.push({
          condition: 15,
          file: document.path,
          range: statement.range,
          message:
            `invalid import: ${defects.join("; ")} — the only permitted ` +
            `import is a single default binding of a relative "./"/"../" ` +
            `specifier ending in ".xspec" that designates a discovered ` +
            `spec-group file, e.g. import BASE from "./BASE.xspec" ` +
            `(SPEC 2.1, 14.15)`,
        });
        targetPath = null;
      }

      // SPEC 2.1: no two imports in a file may bind the same identifier.
      for (const name of names) {
        if (seenNames.has(name)) {
          findings.push({
            condition: 15,
            file: document.path,
            range: statement.range,
            message:
              `invalid import: the identifier ${JSON.stringify(name)} is ` +
              `already bound by another import in this file — no two ` +
              `imports in an xspec source file may bind the same ` +
              `identifier; rename one binding (SPEC 2.1, 14.15)`,
          });
          bindings.set(name, { kind: "poisoned" });
        } else {
          seenNames.add(name);
          bindings.set(
            name,
            valid && targetPath !== null && name === clause?.name?.text
              ? { kind: "module", targetPath }
              : { kind: "poisoned" },
          );
        }
      }

      const quoteCharacter =
        statement.text[specifierLiteral.getStart(parsed.sourceFile)];
      imports.push({
        statement,
        bindingName: clause?.name !== undefined ? clause.name.text : null,
        specifier,
        specifierQuote: quoteCharacter === "'" ? "'" : '"',
        specifierRange: translate.range({
          start: specifierLiteral.getStart(parsed.sourceFile),
          end: specifierLiteral.getEnd(),
        }),
        targetPath,
        valid,
      });
    }
  }

  return {
    imports,
    bindings,
    findings: sortFindings(findings),
  };
}

/** The parsed shape of one recorded import statement's exact text. */
interface ParsedImport {
  readonly sourceFile: ts.SourceFile;
  readonly importClause: ts.ImportClause | undefined;
  readonly moduleSpecifier: ts.Expression;
  readonly attributes: ts.ImportAttributes | undefined;
}

/** Re-parse one import declaration's exact text (positions are local). */
function parseImportStatement(text: string): ParsedImport {
  const sourceFile = ts.createSourceFile(
    "xspec-import.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const statement =
    sourceFile.statements.length === 1 ? sourceFile.statements[0] : undefined;
  if (statement === undefined || !ts.isImportDeclaration(statement)) {
    throw new Error(
      "xspec internal error: recorded import statement did not re-parse " +
        "as an import declaration",
    );
  }
  return {
    sourceFile,
    importClause: statement.importClause,
    moduleSpecifier: statement.moduleSpecifier,
    attributes: statement.attributes,
  };
}

// ---------------------------------------------------------------------------
// The reference model (SPEC 2.2–2.4)
// ---------------------------------------------------------------------------

/** Where a reference points, for graph resolution (SPEC 2.2, 5.2). */
export type ReferenceTarget =
  | {
      /** Local form: a string literal naming an ID path in this file. */
      readonly kind: "local";
      /** The named ID path — the whole dotted path (SPEC 2.2, T2.4-4). */
      readonly idPath: string;
    }
  | {
      /** External form: a chain rooted at an imported spec module. */
      readonly kind: "external";
      /** The imported module's designated source path (SPEC 2.1). */
      readonly modulePath: string;
      /**
       * The chain's segment names, in order; empty for the module
       * itself, targeting that file's root node (SPEC 2.2). Matched as a
       * segment sequence — never joined and re-split — so a segment
       * containing `.` resolves to nothing (SPEC 2.4, 1.4).
       */
      readonly segments: readonly string[];
    };

/** One chain segment's spelling, for in-place rewrites (SPEC 6.4). */
export interface SegmentSpelling {
  readonly name: string;
  /** Dot access (`.login`) or computed access (`["login-v2"]`). */
  readonly access: "dot" | "computed";
  /** The index literal's quote — null for dot access (SPEC 6.4). */
  readonly quote: '"' | "'" | null;
  /** The name token: the identifier, or the index literal with quotes. */
  readonly nameRange: ByteRange;
  /** The whole access, from just past the base through its last byte. */
  readonly accessRange: ByteRange;
}

/**
 * A reference's exact spelling (SPEC 6.4: rewrites are minimal in-place
 * edits preserving quote style and access form).
 */
export type ReferenceSpelling =
  | {
      readonly form: "string";
      readonly quote: '"' | "'";
      /** The string literal's characters, quotes included. */
      readonly range: ByteRange;
    }
  | {
      readonly form: "chain";
      /** The root import binding as written. */
      readonly rootName: string;
      /** The root identifier token. */
      readonly rootRange: ByteRange;
      readonly segments: readonly SegmentSpelling[];
    };

/** One extracted static reference (SPEC 2.2, 2.3). */
export interface SpecReference {
  readonly target: ReferenceTarget;
  readonly spelling: ReferenceSpelling;
  /** The whole reference expression's bytes (finding locations). */
  readonly range: ByteRange;
}

/** One `d` reference with its declaring section (SPEC 2.2). */
export interface DependencyReference {
  readonly section: SpecSection;
  readonly reference: SpecReference;
}

/**
 * One `{text(...)}` embedding's analysis (SPEC 2.3). `reference` is null
 * when the embedding yields none: a 14.8 finding accounts for it, or its
 * chain root is a poisoned import binding (masked, SPEC 14).
 */
export interface EmbeddingReference {
  readonly embedding: SpecEmbedding;
  readonly reference: SpecReference | null;
}

/** The extracted references of one xspec source file (SPEC 2.2–2.4). */
export interface SpecReferenceModel {
  /** Every extracted `d` reference, in document order (SPEC 2.2). */
  readonly dependencies: readonly DependencyReference[];
  /** Every embedding with its analysis, in document order (SPEC 2.3). */
  readonly embeddings: readonly EmbeddingReference[];
  /** The 14.8 findings (SPEC 2.4), ordered by location. */
  readonly findings: readonly Finding[];
}

/** How one classified expression resolved as a reference. */
type ResolvedReference =
  | { readonly outcome: "reference"; readonly reference: SpecReference }
  | { readonly outcome: "finding"; readonly finding: Finding }
  | { readonly outcome: "masked" };

/**
 * Extract the file's references (SPEC 2.2, 2.3) through the shared
 * static-reference analyzer (SPEC 2.4). Every `d` reference and
 * embedding argument is classified; dynamic ones report 14.8, chains
 * rooted at poisoned bindings are masked (SPEC 14), and the rest are
 * recorded with target, spelling, and spans. Resolution against declared
 * IDs — and duplicate-target collapse (SPEC 2.2, 5.2) — happens in the
 * graph, which reports 14.5/14.6 for unknown targets.
 */
export function analyzeSpecReferences(
  document: SpecDocument,
  importModel: SpecImportModel,
): SpecReferenceModel {
  const analyzer = new ReferenceAnalyzer(document, importModel.bindings);
  const dependencies: DependencyReference[] = [];
  for (const section of document.sections) {
    const dependency = section.dependency;
    if (dependency === null) {
      continue;
    }
    for (const reference of analyzer.analyzeDependencyValue(dependency)) {
      dependencies.push({ section, reference });
    }
  }
  const embeddings: EmbeddingReference[] = [];
  for (const embedding of document.embeddings) {
    embeddings.push({
      embedding,
      reference: analyzer.analyzeEmbedding(embedding),
    });
  }
  return {
    dependencies,
    embeddings,
    findings: sortFindings(analyzer.findings),
  };
}

/** The per-file analysis worker behind `analyzeSpecReferences`. */
class ReferenceAnalyzer {
  readonly findings: Finding[] = [];

  constructor(
    private readonly document: SpecDocument,
    private readonly bindings: ReadonlyMap<string, SpecImportBinding>,
  ) {}

  private addFinding(range: ByteRange, message: string): void {
    this.findings.push({
      condition: 8,
      file: this.document.path,
      range,
      message,
    });
  }

  /**
   * SPEC 2.2: a `d` value is a single reference or an array literal of
   * references, external and local forms mixed freely; `d={[]}` declares
   * no dependencies. Any other value is a dynamic argument (SPEC 2.7 →
   * 14.8), as is any dynamic element (SPEC 2.4).
   */
  analyzeDependencyValue(dependency: {
    readonly expressionText: string;
    readonly expressionRange: ByteRange;
    readonly attributeRange: ByteRange;
  }): SpecReference[] {
    const { sourceFile, expression } = parseExpressionText(
      dependency.expressionText,
    );
    if (expression === null) {
      // Not a single expression at all (an object literal parses as a
      // block, for instance): a dynamic argument (SPEC 2.7 → 14.8).
      this.addFinding(
        dependency.attributeRange,
        `invalid argument: the d value is not a static reference or an ` +
          `array literal of static references — it is a dynamic argument ` +
          `(SPEC 2.2, 2.7, 2.4, 14.8)`,
      );
      return [];
    }
    const translate = new SpanTranslator(
      this.document.offsets,
      dependency.expressionRange.start,
    );
    const references: SpecReference[] = [];
    const elements = ts.isArrayLiteralExpression(expression)
      ? expression.elements
      : [expression];
    for (const element of elements) {
      if (ts.isOmittedExpression(element)) {
        // An array hole is no reference (SPEC 2.2 → 14.8).
        this.addFinding(
          translate.range({
            start: expression.getStart(sourceFile),
            end: expression.getEnd(),
          }),
          `invalid argument: the d array contains an elided element — ` +
            `each element must be a static reference (SPEC 2.2, 2.4, 14.8)`,
        );
        continue;
      }
      if (ts.isSpreadElement(element)) {
        this.addFinding(
          translate.range({
            start: element.getStart(sourceFile),
            end: element.getEnd(),
          }),
          `invalid argument: a spread element is not a static reference ` +
            `(SPEC 2.2, 2.4, 14.8)`,
        );
        continue;
      }
      const resolved = this.resolveClassified(
        classifyReference(element, sourceFile),
        translate,
        `each d reference must be a static string literal naming a ` +
          `same-file ID or a static property chain rooted at an imported ` +
          `spec module (SPEC 2.2, 2.4, 14.8)`,
      );
      if (resolved.outcome === "reference") {
        references.push(resolved.reference);
      } else if (resolved.outcome === "finding") {
        this.findings.push(resolved.finding);
      }
    }
    return references;
  }

  /**
   * SPEC 2.3, 2.4: an embedding is a `text(...)` call with exactly one
   * argument, following the same external/local duality as `d`.
   */
  analyzeEmbedding(embedding: SpecEmbedding): SpecReference | null {
    const { sourceFile, expression } = parseExpressionText(
      embedding.expressionText,
    );
    const call =
      expression !== null &&
      ts.isCallExpression(expression) &&
      expression.questionDotToken === undefined &&
      expression.typeArguments === undefined &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "text"
        ? expression
        : null;
    if (call === null) {
      // The document model only records `text(...)` calls as embeddings;
      // a shape the analyzer cannot accept (an optional call, say) is a
      // dynamic form (SPEC 2.4 → 14.8).
      this.addFinding(
        embedding.range,
        `invalid argument: the embedding is not a plain text(...) call ` +
          `(SPEC 2.3, 2.4, 14.8)`,
      );
      return null;
    }
    if (call.arguments.length !== 1) {
      // SPEC 2.4: a text(...) call MUST have exactly one argument.
      this.addFinding(
        embedding.range,
        `invalid argument: text(...) must be called with exactly one ` +
          `argument — this call has ${String(call.arguments.length)} ` +
          `(SPEC 2.4, 14.8)`,
      );
      return null;
    }
    const argument = call.arguments[0];
    const translate = new SpanTranslator(
      this.document.offsets,
      embedding.expressionRange.start,
    );
    if (ts.isSpreadElement(argument)) {
      this.addFinding(
        translate.range({
          start: argument.getStart(sourceFile),
          end: argument.getEnd(),
        }),
        `invalid argument: a spread element is not a static reference ` +
          `(SPEC 2.3, 2.4, 14.8)`,
      );
      return null;
    }
    const resolved = this.resolveClassified(
      classifyReference(argument, sourceFile),
      translate,
      `the text(...) argument must be a static string literal naming a ` +
        `same-file ID or a static property chain rooted at an imported ` +
        `spec module (SPEC 2.3, 2.4, 14.8)`,
    );
    if (resolved.outcome === "reference") {
      return resolved.reference;
    }
    if (resolved.outcome === "finding") {
      this.findings.push(resolved.finding);
    }
    return null;
  }

  /** Turn one classification into a reference, a 14.8, or a mask. */
  private resolveClassified(
    classified: ClassifiedReference,
    translate: SpanTranslator,
    expectation: string,
  ): ResolvedReference {
    if (classified.kind === "dynamic") {
      return {
        outcome: "finding",
        finding: {
          condition: 8,
          file: this.document.path,
          range: translate.range(classified.span),
          message: `invalid argument: ${classified.reason} — ${expectation}`,
        },
      };
    }
    if (classified.kind === "string") {
      return {
        outcome: "reference",
        reference: this.stringReference(classified, translate),
      };
    }
    const binding = this.bindings.get(classified.rootName);
    if (binding === undefined) {
      // SPEC 2.4: a chain is static only when rooted at an imported spec
      // module; a root no import binds makes the reference dynamic.
      return {
        outcome: "finding",
        finding: {
          condition: 8,
          file: this.document.path,
          range: translate.range(classified.span),
          message:
            `invalid argument: the property chain is rooted at ` +
            `${JSON.stringify(classified.rootName)}, which no spec-module ` +
            `import in this file binds — ${expectation}`,
        },
      };
    }
    if (binding.kind === "poisoned") {
      // Masked (SPEC 14): the import's 14.15 makes the target
      // undetectable; no separate condition, no edge.
      return { outcome: "masked" };
    }
    return {
      outcome: "reference",
      reference: this.chainReference(classified, binding.targetPath, translate),
    };
  }

  private stringReference(
    classified: ClassifiedString,
    translate: SpanTranslator,
  ): SpecReference {
    const range = translate.range(classified.span);
    return {
      // SPEC 2.2: the local form names an ID path in the same file — the
      // whole dotted path (T2.4-4).
      target: { kind: "local", idPath: classified.value },
      spelling: { form: "string", quote: classified.quote, range },
      range,
    };
  }

  private chainReference(
    classified: ClassifiedChain,
    modulePath: string,
    translate: SpanTranslator,
  ): SpecReference {
    return {
      // SPEC 2.2: external form — zero segments target the module
      // itself, that is the file's root node.
      target: {
        kind: "external",
        modulePath,
        segments: classified.segments.map((segment) => segment.name),
      },
      spelling: {
        form: "chain",
        rootName: classified.rootName,
        rootRange: translate.range(classified.rootSpan),
        segments: classified.segments.map((segment) => ({
          name: segment.name,
          access: segment.access,
          quote: segment.quote,
          nameRange: translate.range(segment.nameSpan),
          accessRange: translate.range(segment.accessSpan),
        })),
      },
      range: translate.range(classified.span),
    };
  }
}

/** Deterministic finding order (SPEC 12.0): by location, then condition. */
function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (a.range?.start ?? 0) - (b.range?.start ?? 0) ||
      (a.range?.end ?? 0) - (b.range?.end ?? 0) ||
      a.condition - b.condition,
  );
}
