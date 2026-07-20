// TypeScript code-source analysis (SPEC 4, 4.3–4.6).
//
// Analyzes one discovered code-group source file: parses it under the
// grammar its file name selects (`.tsx` as TSX, anything else as plain
// TypeScript — SPEC 14.20), validates its module-linking constructs
// (spec module imports and the forbidden forms, SPEC 4 → 14.15), extracts
// its spec references — dependency markers (SPEC 4.5) recording
// `references` edges and `text(...)` calls (SPEC 4.3) recording `embeds`
// edges — and attributes each to its code location (SPEC 4.6). Reference
// targets are resolved against the graph later (unknown targets report
// 14.7 there, SPEC 5.2); spellings and spans are recorded for the minimal
// in-place rewrites of rename and move (SPEC 6.4, 6.5).
//
// Rooting is scope-aware and value-level (SPEC 4.5): "an identifier that
// TypeScript scoping resolves to a local declaration shadowing an import
// binding is not a spec module reference". Scoping is delegated to the
// TypeScript compiler API's own resolver (IMPLEMENTATION Key libraries):
// each file is bound in a single-file, in-memory, no-lib, no-resolve
// program — pure and deterministic, no I/O — and every candidate
// identifier is resolved through the type checker's symbol table, so
// shadowing, hoisting, and scope structure behave exactly as TypeScript
// defines them. Only symbol resolution is consulted; no semantic
// diagnostics are ever requested.
//
// Masking (SPEC 14): an unparseable file (14.20) masks the conditions
// inside itself — decode or parse failure yields only the 14.20. A chain
// rooted at a binding of an invalid import, or at an identifier bound by
// colliding imports, is masked by that import's 14.15. A chain rooted at
// a shadowing local declaration or a type-only binding records no edge
// and falls under no condition (SPEC 4.5); its value-level misuse is the
// consumer's TypeScript error, outside xspec's validations.

import ts from "typescript";
import type { ByteRange } from "./bytes.js";
import { Utf8Offsets } from "./bytes.js";
import type { DerivedPathKind } from "./discovery.js";
import { derivedFilePathKind } from "./discovery.js";
import type { Finding } from "./findings.js";
import type { ClassifiedChain } from "./references.js";
import { classifyReference } from "./references.js";
import { decodeSourceBytes } from "./source-text.js";
import type { ReferenceSpelling } from "./spec-references.js";
import { resolveImportSpecifier } from "./spec-references.js";

// ---------------------------------------------------------------------------
// The analysis model
// ---------------------------------------------------------------------------

/** What the workspace provides the analysis of one code source. */
export interface CodeAnalysisContext {
  /**
   * The discovered spec-source paths (SPEC 7.1): a spec module import must
   * designate one of them (SPEC 4 → 14.15). Whether the designated file
   * parses does not matter here — references through it report as
   * unresolved during resolution (SPEC 14.20, 14.7).
   */
  readonly specPaths: ReadonlySet<string>;
  /**
   * The configured Markdown emit destinations (SPEC 7.3,
   * `markdownEmitDestinations`) — empty while emission is disabled — for
   * the derived-path import rule (SPEC 4, 13.4 → 14.15).
   */
  readonly markdownDestinations: ReadonlySet<string>;
}

/** One named code unit of the file (SPEC 4.6). */
export interface CodeUnit {
  /** The dot-joined chain of enclosing named-unit names, outermost first. */
  readonly chain: string;
  /**
   * The code-location identity: `path#chain`, with the 1-based
   * document-order `@N` suffix on occurrences after the first when the
   * same chain occurs more than once in the file (SPEC 4.6).
   */
  readonly identity: string;
}

/** One identifier a spec module import binds (SPEC 4). */
export interface CodeImportBinding {
  /** The bound identifier as written (possibly an alias). */
  readonly name: string;
  /**
   * SPEC 4: a binding introduced type-only — a `type` modifier on the
   * declaration or on the named binding — is a type-level name (4.5).
   */
  readonly typeOnly: boolean;
}

/** One spec module import declaration of a code file, analyzed (SPEC 4). */
export interface CodeImport {
  /** The declaration's own characters (finding locations, SPEC 6.5). */
  readonly range: ByteRange;
  /** The declaration's exact text (SPEC 6.5 rewrites). */
  readonly text: string;
  /** The module specifier's cooked value. */
  readonly specifier: string;
  /** The quote character of the specifier literal (SPEC 6.5 rewrites). */
  readonly specifierQuote: '"' | "'";
  /** The specifier literal's characters, quotes included (SPEC 6.5). */
  readonly specifierRange: ByteRange;
  /**
   * The designated source file's workspace-relative path (SPEC 2.1:
   * `DIR/NAME.xspec` designates `DIR/NAME.mdx`) when the import is valid;
   * null for an invalid import.
   */
  readonly targetPath: string | null;
  /** The default-export binding, when present (SPEC 4). */
  readonly defaultBinding: CodeImportBinding | null;
  /** The named `text` bindings, in written order (SPEC 4). */
  readonly textBindings: readonly CodeImportBinding[];
  /** Whether the import is valid (collisions are reported pairwise). */
  readonly valid: boolean;
}

/** One extracted spec reference of a code file (SPEC 4.3, 4.5). */
export interface CodeReference {
  /** `references` for a marker (4.5), `embeds` for a `text` call (4.3). */
  readonly kind: "references" | "embeds";
  /**
   * The attributed code location (SPEC 4.6): the file's workspace-relative
   * path, or `path#unit` (`@N`-disambiguated) for the innermost enclosing
   * named code unit.
   */
  readonly location: string;
  /** The referenced module's designated source path (SPEC 2.1, 4). */
  readonly modulePath: string;
  /**
   * The chain's segment names in order; empty for the module itself —
   * the file's root node (SPEC 4.5: a bare reference to the root node).
   */
  readonly segments: readonly string[];
  /** The chain's exact spelling, for in-place rewrites (SPEC 6.4). */
  readonly spelling: ReferenceSpelling;
  /** The reference expression's bytes (finding locations, SPEC 14.7). */
  readonly range: ByteRange;
}

/** The analysis of one parseable code source. */
export interface CodeAnalysis {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** Every named code unit in document order (SPEC 4.6). */
  readonly units: readonly CodeUnit[];
  /** Every spec module import declaration, in document order (SPEC 4). */
  readonly imports: readonly CodeImport[];
  /** Every extracted reference, in document order (SPEC 4.3, 4.5). */
  readonly references: readonly CodeReference[];
  /** The 14.8/14.11/14.15/14.18 findings, ordered by location. */
  readonly findings: readonly Finding[];
}

/** The outcome of analyzing one discovered code source (SPEC 14.20). */
export type CodeSourceResult =
  | { readonly kind: "analysis"; readonly analysis: CodeAnalysis }
  | { readonly kind: "unparseable"; readonly finding: Finding };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const XSPEC_SUFFIX = ".xspec";

/**
 * Analyze one discovered code-group source (SPEC 4, 4.3–4.6). Decode
 * failure (non-UTF-8 or BOM, SPEC 1.6) and parse failure under the
 * grammar the file name selects are 14.20 — the file's conditions inside
 * are masked (SPEC 14).
 */
export function analyzeCodeSource(
  path: string,
  bytes: Uint8Array,
  context: CodeAnalysisContext,
): CodeSourceResult {
  const decoded = decodeSourceBytes(path, bytes);
  if (!decoded.ok) {
    return { kind: "unparseable", finding: decoded.finding };
  }
  const offsets = new Utf8Offsets(decoded.text);
  // SPEC 14.20: `.tsx` parses as TSX, any other name as plain TypeScript.
  const tsx = path.endsWith(".tsx");
  try {
    const sourceFile = ts.createSourceFile(
      path,
      decoded.text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const program = createSingleFileProgram(sourceFile, tsx);
    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    if (syntactic.length > 0) {
      return {
        kind: "unparseable",
        finding: parseFailureFinding(
          path,
          sourceFile,
          offsets,
          tsx,
          syntactic[0],
        ),
      };
    }
    const analyzer = new CodeAnalyzer(
      path,
      sourceFile,
      offsets,
      program.getTypeChecker(),
      context,
    );
    return { kind: "analysis", analysis: analyzer.analyze() };
  } catch (error) {
    // SPEC 14.20: a file whose nesting exceeds what the recursive parser
    // and analysis can process (a call-stack overflow surfaces as a
    // RangeError) is not well-formed TypeScript this product can analyze —
    // an unparseable source, never a crash (SPEC 12.0: exit codes
    // partition all outcomes). Anything else is an internal defect and
    // propagates.
    if (!(error instanceof RangeError)) throw error;
    return {
      kind: "unparseable",
      finding: stackOverflowFinding(path, tsx ? "TSX" : "plain TypeScript"),
    };
  }
}

/** The 14.20 finding for a source the parser cannot process (overflow). */
function stackOverflowFinding(path: string, grammar: string): Finding {
  return {
    condition: 20,
    file: path,
    range: { start: 0, end: 0 },
    message:
      `unparseable source: not well-formed ${grammar} — the file's ` +
      `nesting exceeds what the parser can process, so no location inside ` +
      `it can be analyzed; simplify or split the file (SPEC 14.20)`,
  };
}

/**
 * A single-file, in-memory program over the pre-parsed source: no lib, no
 * module resolution, no file system — pure by construction. Its checker
 * serves only identifier-to-declaration resolution (SPEC 4.5 scoping).
 */
function createSingleFileProgram(
  sourceFile: ts.SourceFile,
  tsx: boolean,
): ts.Program {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    ...(tsx ? { jsx: ts.JsxEmit.Preserve } : {}),
  };
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      name === sourceFile.fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === sourceFile.fileName,
    readFile: () => undefined,
  };
  return ts.createProgram([sourceFile.fileName], options, host);
}

/** The 14.20 finding for a parse failure, locating it (SPEC 14.20). */
function parseFailureFinding(
  path: string,
  sourceFile: ts.SourceFile,
  offsets: Utf8Offsets,
  tsx: boolean,
  diagnostic: ts.DiagnosticWithLocation,
): Finding {
  const reason = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  const grammar = tsx ? "TSX" : "plain TypeScript";
  const start = Math.min(diagnostic.start, sourceFile.text.length);
  const end = Math.min(
    start + Math.max(diagnostic.length, 0),
    sourceFile.text.length,
  );
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStart = sourceFile.getPositionOfLineAndCharacter(position.line, 0);
  // 1-based column in the line's Unicode code points (Finding contract).
  const column = [...sourceFile.text.slice(lineStart, start)].length + 1;
  return {
    condition: 20,
    file: path,
    range: { start: offsets.byteOffset(start), end: offsets.byteOffset(end) },
    line: position.line + 1,
    column,
    message:
      `unparseable source: not well-formed TypeScript under the ` +
      `${grammar} grammar the file name selects — ${reason}. Correct the ` +
      `syntax at the reported location (SPEC 14.20)`,
  };
}

// ---------------------------------------------------------------------------
// The per-file analyzer
// ---------------------------------------------------------------------------

/** What one import-bound identifier means as a reference root (SPEC 4.5). */
type TrackedBinding =
  | { readonly kind: "node"; readonly modulePath: string }
  | { readonly kind: "text"; readonly modulePath: string }
  | {
      /** SPEC 4: a binding introduced type-only is a type-level name. */
      readonly kind: "type-level";
    }
  | {
      /**
       * A binding of an invalid import, or an identifier bound by more
       * than one import: the 14.15 accounts for it, and references rooted
       * here are masked (SPEC 14).
       */
      readonly kind: "poisoned";
    };

/** One import-bound identifier, for the collision rule (SPEC 4, 2.1). */
interface BoundName {
  readonly name: string;
  /** The binding's declaration node (the checker resolves uses to it). */
  readonly declaration: ts.Node;
  /** Whether the binding's import is a spec module import. */
  readonly spec: boolean;
  readonly statement: ts.Statement;
}

class CodeAnalyzer {
  private readonly findings: Finding[] = [];
  private readonly references: CodeReference[] = [];
  private readonly imports: CodeImport[] = [];
  private readonly units: CodeUnit[] = [];
  /** Declaration node → what a use resolving to it means (SPEC 4.5). */
  private readonly declarations = new Map<ts.Node, TrackedBinding>();
  /** Named-unit construct → its unit (attribution, SPEC 4.6). */
  private readonly unitByNode = new Map<ts.Node, CodeUnit>();

  constructor(
    private readonly path: string,
    private readonly sourceFile: ts.SourceFile,
    private readonly offsets: Utf8Offsets,
    private readonly checker: ts.TypeChecker,
    private readonly context: CodeAnalysisContext,
  ) {}

  analyze(): CodeAnalysis {
    this.scanModuleLinks();
    this.collectUnits();
    this.walk(this.sourceFile);
    return {
      path: this.path,
      units: this.units,
      imports: this.imports,
      references: [...this.references].sort(
        (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
      ),
      findings: sortFindings(this.findings),
    };
  }

  // -- shared helpers -------------------------------------------------------

  /** The node's own characters as a byte range (SPEC 1.7 offsets). */
  private rangeOf(node: ts.Node): ByteRange {
    return {
      start: this.offsets.byteOffset(node.getStart(this.sourceFile)),
      end: this.offsets.byteOffset(node.getEnd()),
    };
  }

  private addFinding(
    condition: 8 | 11 | 15 | 18,
    node: ts.Node,
    message: string,
  ): void {
    this.findings.push({
      condition,
      file: this.path,
      range: this.rangeOf(node),
      message,
    });
  }

  /** The tracked binding a resolved symbol belongs to, if any. */
  private bindingOfSymbol(
    symbol: ts.Symbol | undefined,
  ): TrackedBinding | undefined {
    for (const declaration of symbol?.declarations ?? []) {
      const binding = this.declarations.get(declaration);
      if (binding !== undefined) return binding;
    }
    return undefined;
  }

  /** Resolve one use-site identifier through TypeScript scoping (SPEC 4.5). */
  private bindingOfIdentifier(
    identifier: ts.Identifier,
  ): TrackedBinding | undefined {
    const parent = identifier.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
        ? this.checker.getShorthandAssignmentValueSymbol(parent)
        : this.checker.getSymbolAtLocation(identifier);
    return this.bindingOfSymbol(symbol);
  }

  /**
   * SPEC 4.6: the innermost enclosing named code unit's identity, or the
   * file when none encloses the node.
   */
  private attributionOf(node: ts.Node): string {
    for (
      let current: ts.Node | undefined = node.parent;
      current !== undefined;
      current = current.parent
    ) {
      const unit = this.unitByNode.get(current);
      if (unit !== undefined) return unit.identity;
    }
    return this.path;
  }

  /** Build one recorded reference from a classified static chain. */
  private chainReference(
    kind: "references" | "embeds",
    classified: ClassifiedChain,
    modulePath: string,
    location: string,
  ): CodeReference {
    const spanRange = (span: {
      readonly start: number;
      readonly end: number;
    }): ByteRange => ({
      start: this.offsets.byteOffset(span.start),
      end: this.offsets.byteOffset(span.end),
    });
    return {
      kind,
      location,
      modulePath,
      segments: classified.segments.map((segment) => segment.name),
      spelling: {
        form: "chain",
        rootName: classified.rootName,
        rootRange: spanRange(classified.rootSpan),
        segments: classified.segments.map((segment) => ({
          name: segment.name,
          access: segment.access,
          quote: segment.quote,
          nameRange: spanRange(segment.nameSpan),
          accessRange: spanRange(segment.accessSpan),
        })),
      },
      range: spanRange(classified.span),
    };
  }

  // -- module linking (SPEC 4 → 14.15) --------------------------------------

  /**
   * Validate the file's module-linking constructs (SPEC 4 → 14.15):
   * import declarations (spec module imports and derived-path
   * specifiers), export declarations with module specifiers, and
   * `import X = require(…)` declarations. Dynamic `import()` is a call
   * expression and is checked during the use walk. Fills the declaration
   * map the use analysis resolves against.
   */
  private scanModuleLinks(): void {
    const bound: BoundName[] = [];
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        this.scanImportDeclaration(statement, bound);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined
      ) {
        this.scanExportDeclaration(statement);
      } else if (ts.isImportEqualsDeclaration(statement)) {
        this.scanImportEquals(statement, bound);
      }
    }
    // SPEC 4/2.1 → 14.15: no import may bind an identifier already bound
    // by another import, when either import is a spec module import; one
    // finding per re-binding import, every colliding binding masked.
    const byName = new Map<string, BoundName[]>();
    for (const entry of bound) {
      const entries = byName.get(entry.name);
      if (entries === undefined) byName.set(entry.name, [entry]);
      else entries.push(entry);
    }
    for (const [name, entries] of byName) {
      if (entries.length < 2 || !entries.some((entry) => entry.spec)) continue;
      for (const entry of entries.slice(1)) {
        this.addFinding(
          15,
          entry.statement,
          `invalid import: the identifier ${JSON.stringify(name)} is ` +
            `already bound by another import in this file — no two imports ` +
            `may bind the same identifier when either is a spec module ` +
            `import; rename one binding (SPEC 4, 2.1, 14.15)`,
        );
      }
      for (const entry of entries) {
        this.declarations.set(entry.declaration, { kind: "poisoned" });
      }
    }
  }

  /**
   * SPEC 4: an import declaration is a spec module import exactly when
   * its specifier ends in `.xspec` — then the 2.1 specifier form and
   * resolution apply, the target must be a discovered spec source, and
   * the permitted bindings are the default export and the named `text`
   * export, each optionally aliased, optionally type-only (14.15). Any
   * other import declaration is checked against the derived-path rule.
   */
  private scanImportDeclaration(
    statement: ts.ImportDeclaration,
    bound: BoundName[],
  ): void {
    const literal = statement.moduleSpecifier;
    if (!ts.isStringLiteral(literal)) return; // grammar guarantees a literal
    const specifier = literal.text;
    const spec = specifier.endsWith(XSPEC_SUFFIX);
    const clause = statement.importClause;

    // Track every bound identifier for the collision rule (SPEC 4, 2.1).
    if (clause !== undefined) {
      if (clause.name !== undefined) {
        bound.push({
          name: clause.name.text,
          declaration: clause,
          spec,
          statement,
        });
      }
      const named = clause.namedBindings;
      if (named !== undefined) {
        if (ts.isNamespaceImport(named)) {
          bound.push({
            name: named.name.text,
            declaration: named,
            spec,
            statement,
          });
        } else {
          for (const element of named.elements) {
            bound.push({
              name: element.name.text,
              declaration: element,
              spec,
              statement,
            });
          }
        }
      }
    }

    if (!spec) {
      this.checkDerivedSpecifier(specifier, statement, "an import declaration");
      return;
    }

    // --- a spec module import (SPEC 4 → 14.15) ---
    const defects: string[] = [];
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!relative) {
      defects.push(
        `the specifier ${JSON.stringify(specifier)} is not a relative ` +
          `path beginning with "./" or "../"`,
      );
    }
    let targetPath: string | null = null;
    if (relative) {
      const resolved = resolveImportSpecifier(this.path, specifier);
      if (resolved === null) {
        defects.push(
          `the specifier ${JSON.stringify(specifier)} resolves outside ` +
            `the workspace root`,
        );
      } else {
        // SPEC 2.1/4: `DIR/NAME.xspec` designates `DIR/NAME.mdx`.
        const designated = resolved.slice(0, -XSPEC_SUFFIX.length) + ".mdx";
        if (this.context.specPaths.has(designated)) {
          targetPath = designated;
        } else {
          defects.push(
            `the designated file ${JSON.stringify(designated)} is not a ` +
              `discovered source file of a configured spec group`,
          );
        }
      }
    }
    if (statement.attributes !== undefined) {
      defects.push("it carries import attributes");
    }

    // Bindings (SPEC 4): the default export and the named `text` export,
    // each optionally aliased, optionally type-only. A side-effect-only
    // import binds nothing — no forbidden binding — and records nothing.
    const clauseTypeOnly = clause?.isTypeOnly === true;
    let defaultBinding: CodeImportBinding | null = null;
    const textBindings: CodeImportBinding[] = [];
    /** Registered once validity is known: declaration → role. */
    const roles: {
      declaration: ts.Node;
      binding: CodeImportBinding;
      role: "node" | "text";
    }[] = [];
    if (clause !== undefined) {
      if (clause.name !== undefined) {
        defaultBinding = { name: clause.name.text, typeOnly: clauseTypeOnly };
        roles.push({
          declaration: clause,
          binding: defaultBinding,
          role: "node",
        });
      }
      const named = clause.namedBindings;
      if (named !== undefined) {
        if (ts.isNamespaceImport(named)) {
          defects.push(
            `it uses a namespace-import binding — the permitted bindings ` +
              `are the default export and the named "text" export`,
          );
        } else {
          for (const element of named.elements) {
            const imported = (element.propertyName ?? element.name).text;
            const binding: CodeImportBinding = {
              name: element.name.text,
              typeOnly: clauseTypeOnly || element.isTypeOnly,
            };
            if (imported === "text") {
              textBindings.push(binding);
              roles.push({ declaration: element, binding, role: "text" });
            } else if (imported === "default") {
              // SPEC 4: the default export, aliased through the named form.
              roles.push({ declaration: element, binding, role: "node" });
            } else {
              defects.push(
                `it binds the named export ${JSON.stringify(imported)} — ` +
                  `the permitted bindings are the default export and the ` +
                  `named "text" export`,
              );
            }
          }
        }
      }
    }

    const valid = defects.length === 0;
    if (!valid) {
      // SPEC 14.15: one finding per invalid import, listing its defects.
      this.addFinding(
        15,
        statement,
        `invalid import: ${defects.join("; ")} — a spec module import ` +
          `binds the default export and/or the named "text" export (each ` +
          `optionally aliased, optionally type-only) with a relative ` +
          `"./"/"../" specifier ending in ".xspec" that designates a ` +
          `discovered spec-group file, e.g. import SPEC, { text } from ` +
          `"./NAME.xspec" (SPEC 4, 2.1, 14.15)`,
      );
    }
    for (const { declaration, binding, role } of roles) {
      this.declarations.set(
        declaration,
        !valid || targetPath === null
          ? { kind: "poisoned" }
          : binding.typeOnly
            ? { kind: "type-level" }
            : { kind: role, modulePath: targetPath },
      );
    }

    const quote = this.sourceFile.text[literal.getStart(this.sourceFile)];
    this.imports.push({
      range: this.rangeOf(statement),
      text: this.sourceFile.text.slice(
        statement.getStart(this.sourceFile),
        statement.getEnd(),
      ),
      specifier,
      specifierQuote: quote === "'" ? "'" : '"',
      specifierRange: this.rangeOf(literal),
      targetPath: valid ? targetPath : null,
      defaultBinding,
      textBindings,
      valid,
    });
  }

  /**
   * SPEC 4 → 14.15: an export declaration with a `.xspec` specifier —
   * `export * from`, `export * as NS from`, `export { … } from`,
   * type-only forms included — is invalid: no re-export carries a spec
   * module's nodes or `text` past 4.5. Other module specifiers are
   * checked against the derived-path rule.
   */
  private scanExportDeclaration(statement: ts.ExportDeclaration): void {
    const literal = statement.moduleSpecifier;
    if (literal === undefined || !ts.isStringLiteral(literal)) return;
    if (literal.text.endsWith(XSPEC_SUFFIX)) {
      this.addFinding(
        15,
        statement,
        `invalid import: an export declaration with a ".xspec" specifier — ` +
          `no re-export carries a spec module's nodes or "text"; a spec ` +
          `module is consumed only through an import declaration ` +
          `(SPEC 4, 14.15)`,
      );
      return;
    }
    this.checkDerivedSpecifier(
      literal.text,
      statement,
      "an export declaration",
    );
  }

  /**
   * SPEC 4 → 14.15: an `import X = require(…)` declaration with a
   * `.xspec` specifier is invalid. Other require specifiers are checked
   * against the derived-path rule. The entity-name form
   * (`import X = A.B`) is a use of `A`, handled in the use walk.
   */
  private scanImportEquals(
    statement: ts.ImportEqualsDeclaration,
    bound: BoundName[],
  ): void {
    const reference = statement.moduleReference;
    if (!ts.isExternalModuleReference(reference)) return;
    const expression = reference.expression;
    if (expression === undefined || !ts.isStringLiteral(expression)) return;
    const spec = expression.text.endsWith(XSPEC_SUFFIX);
    bound.push({
      name: statement.name.text,
      declaration: statement,
      spec,
      statement,
    });
    if (spec) {
      this.addFinding(
        15,
        statement,
        `invalid import: an import ${statement.name.text} = require(...) ` +
          `declaration with a ".xspec" specifier — a spec module is ` +
          `consumed only through an import declaration (SPEC 4, 14.15)`,
      );
      // Uses of the binding are masked by this 14.15 (SPEC 14).
      this.declarations.set(statement, { kind: "poisoned" });
      return;
    }
    this.checkDerivedSpecifier(
      expression.text,
      statement,
      "an import ... = require(...) declaration",
    );
  }

  /**
   * SPEC 4, 13.4 → 14.15: a module-linking form whose relative specifier
   * designates a derived-file path — a file name containing `.xspec.`, a
   * path under `.xspec/`, or a configured Markdown emit destination —
   * without being a spec module import is invalid: derived files are
   * consumed only through their `.xspec` specifier.
   */
  private checkDerivedSpecifier(
    specifier: string,
    at: ts.Node,
    formLabel: string,
  ): void {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
    const resolved = resolveImportSpecifier(this.path, specifier);
    if (resolved === null) return;
    const kind = derivedFilePathKind(
      resolved,
      this.context.markdownDestinations,
    );
    if (kind === null) return;
    const why: Record<DerivedPathKind, string> = {
      "xspec-name": `its file name contains ".xspec."`,
      "xspec-dir": `it lies under ".xspec/"`,
      "markdown-destination": `it is a configured Markdown emit destination (SPEC 7.3)`,
    };
    this.addFinding(
      15,
      at,
      `invalid import: ${formLabel} whose relative specifier ` +
        `${JSON.stringify(specifier)} designates the derived-file path ` +
        `${JSON.stringify(resolved)} — ${why[kind]}; derived files are ` +
        `consumed only through a spec module import's ".xspec" specifier ` +
        `(SPEC 4, 13.4, 14.15)`,
    );
  }

  // -- named code units (SPEC 4.6) ------------------------------------------

  /**
   * Enumerate every named code unit in document order and assign
   * identities: `path#chain`, with the 1-based document-order `@N` suffix
   * on repeated chains (SPEC 4.6).
   */
  private collectUnits(): void {
    const records: { node: ts.Node; chain: string; start: number }[] = [];
    const visit = (
      node: ts.Node,
      enclosing: readonly string[],
      ambient: boolean,
    ): void => {
      // SPEC 4.6: a named unit binds a name to *executable code*; ambient
      // (`declare`) declarations bind none and enclose no statements.
      const nowAmbient =
        ambient || hasModifier(node, ts.SyntaxKind.DeclareKeyword);
      let chain = enclosing;
      if (!nowAmbient) {
        const name = unitName(node);
        if (name !== null) {
          chain = [...enclosing, name];
          records.push({
            node,
            chain: chain.join("."),
            start: node.getStart(this.sourceFile),
          });
        }
      }
      ts.forEachChild(node, (child) => {
        visit(child, chain, nowAmbient);
      });
    };
    ts.forEachChild(this.sourceFile, (child) => {
      visit(child, [], false);
    });
    records.sort((a, b) => a.start - b.start);
    const occurrences = new Map<string, number>();
    for (const record of records) {
      const count = (occurrences.get(record.chain) ?? 0) + 1;
      occurrences.set(record.chain, count);
      const unit: CodeUnit = {
        chain: record.chain,
        identity:
          `${this.path}#${record.chain}` +
          (count > 1 ? `@${String(count)}` : ""),
      };
      this.units.push(unit);
      this.unitByNode.set(record.node, unit);
    }
  }

  // -- value-level use analysis (SPEC 4.3, 4.5 → 14.8, 14.11, 14.18) --------

  private walk(node: ts.Node): void {
    // Module-linking constructs were validated in scanModuleLinks; their
    // identifiers are bindings or foreign-module names, never local uses.
    if (ts.isImportDeclaration(node)) return;
    if (ts.isImportEqualsDeclaration(node)) {
      this.visitImportEqualsUse(node);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier === undefined) this.visitExportSpecifiers(node);
      return;
    }
    // SPEC 4.5: type-level references are unrestricted and record no
    // edges — type declarations and type positions are not analyzed.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      return;
    }
    if (ts.isHeritageClause(node)) {
      // A class `extends` expression is a value use; `implements` and an
      // interface's `extends` are type-level (SPEC 4.5).
      if (
        node.token === ts.SyntaxKind.ExtendsKeyword &&
        ts.isClassLike(node.parent)
      ) {
        for (const type of node.types) this.walk(type.expression);
      }
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      this.visitIdentifier(node);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      this.visitImportCall(node);
      // Arguments remain ordinary value context — fall through.
    }
    ts.forEachChild(node, (child) => {
      this.walk(child);
    });
  }

  /**
   * SPEC 4 → 14.15: a dynamic `import()` with a static `.xspec` specifier
   * is invalid, as is one whose static relative specifier designates a
   * derived-file path (13.4); a dynamic `import()` whose specifier is not
   * static is not analyzed and records nothing.
   */
  private visitImportCall(call: ts.CallExpression): void {
    const argument = call.arguments[0];
    if (argument === undefined || !ts.isStringLiteral(argument)) return;
    if (argument.text.endsWith(XSPEC_SUFFIX)) {
      this.addFinding(
        15,
        call,
        `invalid import: a dynamic import() with a static ".xspec" ` +
          `specifier — a spec module is consumed only through an import ` +
          `declaration (SPEC 4, 14.15)`,
      );
      return;
    }
    this.checkDerivedSpecifier(argument.text, call, "a dynamic import()");
  }

  /**
   * `export { … };` without a module specifier references local bindings:
   * re-exporting a spec module binding is an unsanctioned value-level use
   * (SPEC 4.5 → 14.18); type-only forms are type-level and unrestricted.
   */
  private visitExportSpecifiers(declaration: ts.ExportDeclaration): void {
    if (declaration.isTypeOnly) return;
    const clause = declaration.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return;
    for (const element of clause.elements) {
      if (element.isTypeOnly) continue;
      const binding = this.bindingOfSymbol(
        this.checker.getExportSpecifierLocalTargetSymbol(element),
      );
      if (
        binding === undefined ||
        binding.kind === "type-level" ||
        binding.kind === "poisoned"
      ) {
        continue;
      }
      const local = (element.propertyName ?? element.name).text;
      this.addFinding(
        18,
        element,
        `unsupported node usage: ${JSON.stringify(local)} re-exports a ` +
          `spec module binding — re-export is not a sanctioned value-level ` +
          `use; consume nodes as dependency markers or "text" arguments in ` +
          `this file instead (SPEC 4.5, 14.18)`,
      );
    }
  }

  /**
   * `import X = A.B;` aliases the entity `A` — an unsanctioned
   * value-level use of a spec module binding (SPEC 4.5 → 14.18). The
   * require form was handled by scanModuleLinks.
   */
  private visitImportEqualsUse(declaration: ts.ImportEqualsDeclaration): void {
    if (ts.isExternalModuleReference(declaration.moduleReference)) return;
    let name: ts.EntityName = declaration.moduleReference;
    while (ts.isQualifiedName(name)) name = name.left;
    const binding = this.bindingOfSymbol(
      this.checker.getSymbolAtLocation(name),
    );
    if (
      binding === undefined ||
      binding.kind === "type-level" ||
      binding.kind === "poisoned"
    ) {
      return;
    }
    this.addFinding(
      18,
      declaration,
      `unsupported node usage: an import alias of a spec module binding — ` +
        `aliasing is not a sanctioned value-level use (SPEC 4.5, 14.18)`,
    );
  }

  /** One identifier: a spec binding use, or nothing (SPEC 4.5). */
  private visitIdentifier(identifier: ts.Identifier): void {
    if (!isValueUseSite(identifier)) return;
    const binding = this.bindingOfIdentifier(identifier);
    if (binding === undefined) return; // not a spec module reference
    if (binding.kind === "type-level" || binding.kind === "poisoned") {
      // SPEC 4.5: a chain rooted at a type-only binding records nothing
      // and is no condition; a poisoned root is masked by its 14.15.
      return;
    }
    if (binding.kind === "text") {
      this.visitTextBindingUse(identifier, binding);
      return;
    }
    this.visitNodeBindingUse(identifier, binding);
  }

  /**
   * SPEC 4.5: a node binding appears only as a dependency marker — a bare
   * static chain in expression-statement position — or as the sole
   * argument of a call whose callee is a spec module's `text` export.
   * Everything else is 14.18 (or 14.8 for a non-static chain in marker
   * position).
   */
  private visitNodeBindingUse(
    identifier: ts.Identifier,
    binding: { readonly kind: "node"; readonly modulePath: string },
  ): void {
    const use = climbUseExpression(identifier);
    const parent = use.parent;

    if (ts.isExpressionStatement(parent) && parent.expression === use) {
      // SPEC 4.5: a bare requirement reference as an expression statement
      // is a dependency marker recording a `references` edge.
      const classified = classifyReference(use, this.sourceFile);
      if (classified.kind === "chain") {
        this.references.push(
          this.chainReference(
            "references",
            classified,
            binding.modulePath,
            this.attributionOf(use),
          ),
        );
      } else {
        // The expression is rooted at `identifier`, so the string
        // classification is impossible; dynamic is 14.8 (SPEC 4.5, 2.4).
        const reason =
          classified.kind === "dynamic"
            ? classified.reason
            : "it is not a bare property chain";
        this.addFinding(
          8,
          use,
          `invalid argument: ${reason} — a bare reference in ` +
            `expression-statement position must be a static property chain ` +
            `rooted at a spec module import binding (SPEC 4.5, 2.4, 14.8)`,
        );
      }
      return;
    }

    // The sole-argument position of a `text` call is analyzed from the
    // callee (visitTextBindingUse) — one report per call, never two.
    if (this.isTextCallArgument(use)) return;

    this.addFinding(
      18,
      use,
      `unsupported node usage: a spec module node or binding is used as a ` +
        `value outside the sanctioned forms — the only value-level uses ` +
        `are a bare static chain as an expression statement (a dependency ` +
        `marker) and passing a node as the sole argument of its own ` +
        `module's "text" export (SPEC 4.5, 14.18)`,
    );
  }

  /** Whether `use` sits in argument position of a `text`-callee call. */
  private isTextCallArgument(use: ts.Expression): boolean {
    let argument: ts.Node = use;
    if (ts.isSpreadElement(argument.parent)) argument = argument.parent;
    const call = argument.parent;
    if (
      !ts.isCallExpression(call) ||
      (call.expression as ts.Node) === argument
    ) {
      return false;
    }
    if (!call.arguments.some((candidate) => candidate === argument)) {
      return false;
    }
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) return false;
    const binding = this.bindingOfSymbol(
      this.checker.getSymbolAtLocation(callee),
    );
    // A poisoned callee masks its arguments too: the import's 14.15
    // already accounts for the whole call (SPEC 14).
    return binding?.kind === "text" || binding?.kind === "poisoned";
  }

  /**
   * SPEC 4.5: a `text` binding appears only as the callee of a call;
   * that call is an ordinary expression, valid in expression-statement
   * position too, recording its `embeds` edge (4.3) — never a marker.
   */
  private visitTextBindingUse(
    identifier: ts.Identifier,
    binding: { readonly kind: "text"; readonly modulePath: string },
  ): void {
    const parent = identifier.parent;
    if (ts.isCallExpression(parent) && parent.expression === identifier) {
      this.analyzeTextCall(parent, binding);
      return;
    }
    this.addFinding(
      18,
      identifier,
      `unsupported node usage: the spec module "text" binding ` +
        `${JSON.stringify(identifier.text)} is used as a value — it ` +
        `appears only as the callee of a text(...) call (SPEC 4.5, 14.18)`,
    );
  }

  /**
   * One `text(...)` call (SPEC 4.3, 4.5): exactly one argument, a static
   * property chain rooted at a spec module import binding; the string
   * form is MDX-only (4.3 → 14.8); a cross-module node is 14.11 (4.4).
   */
  private analyzeTextCall(
    call: ts.CallExpression,
    calleeBinding: { readonly kind: "text"; readonly modulePath: string },
  ): void {
    if (call.questionDotToken !== undefined) {
      this.addFinding(
        8,
        call,
        `invalid argument: an optional call is not a plain text(...) call ` +
          `(SPEC 4.3, 2.4, 14.8)`,
      );
      return;
    }
    if (call.typeArguments !== undefined) {
      this.addFinding(
        8,
        call,
        `invalid argument: a text(...) call does not take type arguments ` +
          `(SPEC 4.3, 2.4, 14.8)`,
      );
      return;
    }
    if (call.arguments.length !== 1) {
      // SPEC 2.4: a text(...) call MUST have exactly one argument.
      this.addFinding(
        8,
        call,
        `invalid argument: text(...) must be called with exactly one ` +
          `argument — this call has ${String(call.arguments.length)} ` +
          `(SPEC 2.4, 14.8)`,
      );
      return;
    }
    const argument = call.arguments[0];
    if (ts.isSpreadElement(argument)) {
      this.addFinding(
        8,
        argument,
        `invalid argument: a spread element is not a static reference ` +
          `(SPEC 2.4, 14.8)`,
      );
      return;
    }
    if (ts.isStringLiteral(argument)) {
      // SPEC 4.3: the string form of text(...) is MDX-only.
      this.addFinding(
        8,
        argument,
        `invalid argument: a string argument to text(...) in a TypeScript ` +
          `file — the string form is MDX-only; pass the node itself ` +
          `(SPEC 4.3, 14.8)`,
      );
      return;
    }
    if (
      ts.isNoSubstitutionTemplateLiteral(argument) ||
      ts.isTemplateExpression(argument)
    ) {
      this.addFinding(
        8,
        argument,
        `invalid argument: a template literal is not a static string ` +
          `literal, and the string form of text(...) is MDX-only anyway ` +
          `(SPEC 2.4, 4.3, 14.8)`,
      );
      return;
    }
    const root = leftmostIdentifier(argument);
    const rootBinding =
      root === null
        ? undefined
        : this.bindingOfSymbol(this.checker.getSymbolAtLocation(root));
    if (
      rootBinding === undefined ||
      rootBinding.kind === "type-level" ||
      rootBinding.kind === "poisoned"
    ) {
      // SPEC 4.5: rooting is scope-aware and value-level — a chain rooted
      // at a shadowing local or a type-only binding records no edge and
      // falls under no condition; a poisoned root is masked by its
      // import's 14.15. Any other non-node argument is the consumer's
      // TypeScript error against the branded signature (SPEC 4.4).
      return;
    }
    if (rootBinding.kind === "text") {
      this.addFinding(
        18,
        argument,
        `unsupported node usage: a spec module "text" binding is passed ` +
          `as a value — it appears only as the callee of a text(...) call ` +
          `(SPEC 4.5, 14.18)`,
      );
      return;
    }
    const classified = classifyReference(argument, this.sourceFile);
    if (classified.kind !== "chain") {
      const reason =
        classified.kind === "dynamic"
          ? classified.reason
          : "it is not a bare property chain";
      this.addFinding(
        8,
        argument,
        `invalid argument: ${reason} — the text(...) argument must be a ` +
          `static property chain rooted at a spec module import binding ` +
          `(SPEC 4.5, 2.4, 14.8)`,
      );
      return;
    }
    if (rootBinding.modulePath !== calleeBinding.modulePath) {
      // SPEC 4.4 → 14.11: a node passed to another module's text export.
      this.addFinding(
        11,
        call,
        `cross-module text call: the argument is a node of module ` +
          `${JSON.stringify(rootBinding.modulePath)} but the "text" export ` +
          `called belongs to module ` +
          `${JSON.stringify(calleeBinding.modulePath)} — pass a node only ` +
          `to its own module's "text" export (SPEC 4.4, 14.11)`,
      );
      return;
    }
    // SPEC 4.3: text(node) records an `embeds` edge from the calling
    // code location.
    this.references.push(
      this.chainReference(
        "embeds",
        classified,
        rootBinding.modulePath,
        this.attributionOf(call),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Syntactic helpers
// ---------------------------------------------------------------------------

/** Whether the node carries the given modifier keyword. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

/** Whether the expression is a function, arrow, or class expression. */
function isFunctionOrClassExpression(expression: ts.Expression): boolean {
  return (
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  );
}

function stripParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * SPEC 4.6: the name a construct statically binds to executable code, or
 * null when the construct is not a named code unit. The construct list is
 * exact: a function declaration; a class declaration; a class member with
 * a non-computed identifier name (a method, getter, setter, or a property
 * whose initializer is a function, arrow, or class expression); a
 * variable declaration with a plain identifier name and such an
 * initializer; a namespace declaration (`namespace A.B` nests one
 * declaration per name in the AST already); or a default export, named
 * `default` when the exported construct is anonymous. Signature-only
 * declarations (overloads, abstract members) bind no executable code.
 */
function unitName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) {
    if (node.body === undefined) return null;
    if (node.name !== undefined) return node.name.text;
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : null;
  }
  if (ts.isClassDeclaration(node)) {
    if (node.name !== undefined) return node.name.text;
    return hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : null;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    if (!ts.isClassLike(node.parent)) return null; // class members only
    if (node.body === undefined) return null;
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isPropertyDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) return null;
    const initializer = node.initializer;
    return initializer !== undefined && isFunctionOrClassExpression(initializer)
      ? node.name.text
      : null;
  }
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isIdentifier(node.name)) return null;
    const initializer = node.initializer;
    return initializer !== undefined && isFunctionOrClassExpression(initializer)
      ? node.name.text
      : null;
  }
  if (ts.isModuleDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
    const expression = stripParentheses(node.expression);
    if (
      ts.isFunctionExpression(expression) ||
      ts.isClassExpression(expression)
    ) {
      return expression.name !== undefined ? expression.name.text : "default";
    }
    return ts.isArrowFunction(expression) ? "default" : null;
  }
  return null;
}

/**
 * Whether the identifier occupies a value-use position — not a property
 * name, declaration name, label, or other non-reference role. Type
 * positions never reach this test: the walk does not descend into them.
 */
function isValueUseSite(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
    return false;
  }
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isShorthandPropertyAssignment(parent)) {
    // `{ SPEC }` is a value use of the binding (the object's member value).
    return parent.name === identifier;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ts.isBindingElement(parent)) return false; // name or propertyName
  if (ts.isLabeledStatement(parent) && parent.label === identifier) {
    return false;
  }
  if (ts.isBreakOrContinueStatement(parent) && parent.label === identifier) {
    return false;
  }
  if (ts.isMetaProperty(parent)) return false;
  if (ts.isJsxAttribute(parent) && parent.name === identifier) return false;
  if (
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false; // import bindings; export specifiers handled separately
  }
  return true;
}

/**
 * The maximal reference expression around a use-site root identifier:
 * climbs through property and element accesses (of which the identifier
 * is the object), non-null assertions, parentheses, and type assertions
 * — the wrappers SPEC 2.4 rules on (each beyond plain accesses makes the
 * reference dynamic). The result is the expression classified as marker
 * (SPEC 4.5), `text` argument, or unsanctioned use.
 */
function climbUseExpression(identifier: ts.Identifier): ts.Expression {
  let use: ts.Expression = identifier;
  for (;;) {
    const parent: ts.Node = use.parent;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === use
    ) {
      use = parent;
      continue;
    }
    if (
      ts.isNonNullExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent)
    ) {
      use = parent;
      continue;
    }
    return use;
  }
}

/** The leftmost root identifier of a chain-shaped expression, if any. */
function leftmostIdentifier(expression: ts.Expression): ts.Identifier | null {
  let node: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(node)) return node;
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    if (
      ts.isNonNullExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      node = node.expression;
      continue;
    }
    return null;
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
