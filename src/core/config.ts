// Project configuration: static parse and schema validation (SPEC 7).
//
// SPEC 7: `xspec.config.ts` is declarative — data, not executed code. The
// file MUST consist of exactly an import of `defineConfig` from the module
// specifier "xspec" (optionally aliased) and a default export of one call
// to that binding, whose sole argument is statically literal: object
// literals with non-computed identifier or string-literal keys, array
// literals, static string literals (2.4), and the boolean literals `true`
// and `false` — no other statement or expression form, no spread, no
// computed value. IMPLEMENTATION (Key libraries): the file is parsed with
// the TypeScript compiler API as an AST reduced to data, never executed or
// imported. A file that is not well-formed TypeScript or does not conform,
// and every schema violation of SPEC 7.1–7.5, is a configuration error
// (14.14) — reported by every command at configuration load as a usage
// error (12.0, exit 2), preceding all source analysis.
//
// This module is pure: it maps configuration text to a validated
// `Configuration` or to condition-14 findings. Locating and reading the
// file is the workspace layer's (src/workspace/config.ts).

import ts from "typescript";
import type { Finding } from "./findings.js";
import type { CompiledGlob } from "./glob.js";
import { compileGlob, unboundToCaptures } from "./glob.js";

// ---------------------------------------------------------------------------
// The validated configuration model
// ---------------------------------------------------------------------------

/** SPEC 5.2: the dependency edge kinds (`depends`, `embeds`, `references`). */
export type DependencyEdgeKind = "depends" | "embeds" | "references";

/** All three dependency edge kinds — the SPEC 7.4/7.5 defaults. */
export const DEPENDENCY_EDGE_KINDS: readonly DependencyEdgeKind[] = [
  "depends",
  "embeds",
  "references",
];

/** One configured spec or code group (SPEC 7.1, 7.2): a named glob list. */
export interface ConfiguredGroup {
  readonly name: string;
  /** The glob patterns as written (diagnostics; recorded parameters, 10.7). */
  readonly patterns: readonly string[];
  /** The same patterns compiled in plain mode (SPEC 7). */
  readonly globs: readonly CompiledGlob[];
}

/** SPEC 7.3: the `markdown` key. Absent key = no Markdown emission. */
export interface MarkdownSettings {
  readonly emit: boolean;
  /**
   * Emit directory relative to the workspace root, validated to resolve
   * within it (SPEC 7.3); absent = emit next to each source file.
   */
  readonly outDir?: string;
}

/** SPEC 7.4: one coverage profile, with defaults and kinds resolved. */
export interface CoverageProfile {
  readonly name: string;
  /** Spec group whose requirements must be covered (SPEC 7.4). */
  readonly target: string;
  /** When present, restricts the target set by tags (SPEC 7.4); never empty. */
  readonly targetTags?: readonly string[];
  /** SPEC 7.4: default `"leaves"`. */
  readonly targets: "leaves" | "all";
  readonly boundary: string;
  /** Resolved kind: inferred when unambiguous, else as given (SPEC 7.4). */
  readonly boundaryKind: "spec" | "code";
  readonly mode: "direct" | "transitive";
  /** SPEC 7.4: defaults to all three dependency edge kinds; never empty. */
  readonly edgeKinds: readonly DependencyEdgeKind[];
}

/** SPEC 7.5: a selector, matching by exactly one of group, files, or tags. */
export type PolicySelector =
  | {
      readonly selector: "group";
      readonly group: string;
      /** Resolved kind: inferred when unambiguous, else as given (SPEC 7.5). */
      readonly groupKind: "spec" | "code";
    }
  | {
      readonly selector: "files";
      /** The pattern as written (diagnostics, violation reports). */
      readonly pattern: string;
      /**
       * Compiled in capture-from mode for a rule's `from`, capture-to mode
       * for its `to` (SPEC 7.5).
       */
      readonly glob: CompiledGlob;
    }
  | {
      readonly selector: "tags";
      /** Matching means carrying at least one listed tag (SPEC 7.5); never empty. */
      readonly tags: readonly string[];
    };

/** SPEC 7.5: one policy rule, with defaults resolved. */
export interface PolicyRule {
  readonly name: string;
  readonly type: "forbidden" | "allowedOnly";
  readonly from: PolicySelector;
  readonly to: PolicySelector;
  /** SPEC 7.5: defaults to all three dependency edge kinds; never empty. */
  readonly kinds: readonly DependencyEdgeKind[];
}

/**
 * The validated project configuration (SPEC 7). An omitted `code`,
 * `coverage`, or `policy` key and an empty `coverage`/`policy` list both
 * yield empty lists here — the SPEC 7 equivalence; an omitted `markdown`
 * key yields an absent `markdown` (no emission, SPEC 7.3). Group order is
 * the configuration file's written order.
 */
export interface Configuration {
  readonly specGroups: readonly ConfiguredGroup[];
  readonly codeGroups: readonly ConfiguredGroup[];
  readonly markdown?: MarkdownSettings;
  readonly coverage: readonly CoverageProfile[];
  readonly policy: readonly PolicyRule[];
}

export type ConfigurationResult =
  | { readonly ok: true; readonly configuration: Configuration }
  | { readonly ok: false; readonly findings: readonly Finding[] };

// ---------------------------------------------------------------------------
// Finding accumulation
// ---------------------------------------------------------------------------

/** Collects condition-14 findings against the configuration file. */
class ConfigFindings {
  readonly findings: Finding[] = [];
  private readonly fileName: string;

  constructor(fileName: string) {
    this.fileName = fileName;
  }

  /** SPEC 14.14: every entry is a configuration error (usage error, 12.0). */
  add(message: string, line?: number): void {
    this.findings.push({ condition: 14, message, file: this.fileName, line });
  }

  get count(): number {
    return this.findings.length;
  }
}

// ---------------------------------------------------------------------------
// Static parse: TypeScript text → declarative form → literal data
// ---------------------------------------------------------------------------

/** 1-based line of a node's start, for actionable findings (SPEC 14). */
function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

/**
 * SPEC 7/14.14: "a configuration file that is not well-formed TypeScript".
 * `ts.transpileModule` with `reportDiagnostics` surfaces the file's
 * syntactic diagnostics through the public compiler API without building a
 * program (and without executing anything). Returns false when any error
 * was reported.
 */
function checkSyntax(
  text: string,
  fileName: string,
  findings: ConfigFindings,
): boolean {
  const output = ts.transpileModule(text, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });
  let wellFormed = true;
  for (const diagnostic of output.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    wellFormed = false;
    const line =
      diagnostic.file !== undefined && diagnostic.start !== undefined
        ? ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start)
            .line + 1
        : undefined;
    findings.add(
      `not well-formed TypeScript — ` +
        `${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")} ` +
        `(SPEC 7, 14.14)`,
      line,
    );
  }
  return wellFormed;
}

const FORM_EXPECTATION =
  `the configuration must consist of exactly an import of defineConfig ` +
  `from "xspec" (optionally aliased) and a default export of one call to ` +
  `that binding (SPEC 7)`;

/**
 * SPEC 7: the file MUST consist of exactly the `defineConfig` import and
 * the default export of one call to that binding. Returns the call's sole
 * argument expression, or null after reporting the deviations.
 */
function checkForm(
  sourceFile: ts.SourceFile,
  findings: ConfigFindings,
): ts.Expression | null {
  let importDecl: ts.ImportDeclaration | undefined;
  let exportAssign: ts.ExportAssignment | undefined;
  let ok = true;
  for (const statement of sourceFile.statements) {
    if (importDecl === undefined && ts.isImportDeclaration(statement)) {
      importDecl = statement;
      continue;
    }
    if (exportAssign === undefined && ts.isExportAssignment(statement)) {
      exportAssign = statement;
      continue;
    }
    // SPEC 7: no other statement form.
    findings.add(
      `unexpected statement — ${FORM_EXPECTATION}`,
      lineOf(statement, sourceFile),
    );
    ok = false;
  }
  if (importDecl === undefined) {
    findings.add(`missing the defineConfig import — ${FORM_EXPECTATION}`, 1);
    ok = false;
  }
  if (exportAssign === undefined) {
    findings.add(`missing the default export — ${FORM_EXPECTATION}`, 1);
    ok = false;
  }
  if (importDecl === undefined || exportAssign === undefined || !ok) {
    return null;
  }
  const binding = checkImport(importDecl, sourceFile, findings);
  return checkExport(exportAssign, binding, sourceFile, findings);
}

/**
 * SPEC 7: exactly an import of `defineConfig` from the module specifier
 * "xspec", optionally aliased. Returns the local binding name, or null.
 */
function checkImport(
  decl: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  findings: ConfigFindings,
): string | null {
  let ok = true;
  const specifier = decl.moduleSpecifier;
  if (!ts.isStringLiteral(specifier) || specifier.text !== "xspec") {
    findings.add(
      `the import must be from the module specifier "xspec" (SPEC 7)`,
      lineOf(specifier, sourceFile),
    );
    ok = false;
  }
  if (decl.attributes !== undefined) {
    findings.add(
      `import attributes are not part of the declarative configuration ` +
        `form (SPEC 7)`,
      lineOf(decl.attributes, sourceFile),
    );
    ok = false;
  }
  const clause = decl.importClause;
  if (clause === undefined) {
    findings.add(
      `the import must bind defineConfig — a side-effect-only import binds ` +
        `nothing (SPEC 7)`,
      lineOf(decl, sourceFile),
    );
    return null;
  }
  if (clause.isTypeOnly) {
    // The default export calls the binding, so a type-only import cannot
    // be the SPEC 7 form.
    findings.add(
      `the defineConfig import must not be type-only — the default export ` +
        `calls the binding (SPEC 7)`,
      lineOf(decl, sourceFile),
    );
    ok = false;
  }
  if (clause.name !== undefined) {
    findings.add(
      `the import must be a named import of defineConfig, not a default ` +
        `import (SPEC 7)`,
      lineOf(clause.name, sourceFile),
    );
    ok = false;
  }
  const named = clause.namedBindings;
  if (named === undefined || !ts.isNamedImports(named)) {
    findings.add(
      `the import must be a named import of defineConfig ` +
        `(\`import { defineConfig } from "xspec"\`, optionally aliased) ` +
        `(SPEC 7)`,
      lineOf(decl, sourceFile),
    );
    return null;
  }
  if (named.elements.length !== 1) {
    findings.add(
      `the import must bind exactly defineConfig and nothing else (SPEC 7)`,
      lineOf(named, sourceFile),
    );
    return null;
  }
  const element = named.elements[0]!;
  if (element.isTypeOnly) {
    findings.add(
      `the defineConfig binding must not be type-only — the default export ` +
        `calls it (SPEC 7)`,
      lineOf(element, sourceFile),
    );
    ok = false;
  }
  const importedName = (element.propertyName ?? element.name).text;
  if (importedName !== "defineConfig") {
    findings.add(
      `the import must bind defineConfig (found "${importedName}") (SPEC 7)`,
      lineOf(element, sourceFile),
    );
    ok = false;
  }
  return ok ? element.name.text : null;
}

/**
 * SPEC 7: a default export of one call to the imported binding, with
 * exactly one (sole) argument. Returns the argument expression, or null.
 */
function checkExport(
  decl: ts.ExportAssignment,
  binding: string | null,
  sourceFile: ts.SourceFile,
  findings: ConfigFindings,
): ts.Expression | null {
  if (decl.isExportEquals === true) {
    findings.add(
      `\`export =\` is not the declarative form — use ` +
        `\`export default defineConfig(...)\` (SPEC 7)`,
      lineOf(decl, sourceFile),
    );
    return null;
  }
  const expression = decl.expression;
  if (!ts.isCallExpression(expression)) {
    findings.add(
      `the default export must be one call to the imported defineConfig ` +
        `binding (SPEC 7)`,
      lineOf(expression, sourceFile),
    );
    return null;
  }
  let ok = true;
  const callee = expression.expression;
  if (
    !ts.isIdentifier(callee) ||
    (binding !== null && callee.text !== binding)
  ) {
    findings.add(
      `the default export must call the imported defineConfig binding` +
        `${binding === null ? "" : ` ("${binding}")`} directly (SPEC 7)`,
      lineOf(callee, sourceFile),
    );
    ok = false;
  }
  if (expression.questionDotToken !== undefined) {
    findings.add(
      `an optional-chaining call is not the declarative form (SPEC 7)`,
      lineOf(expression, sourceFile),
    );
    ok = false;
  }
  if (expression.typeArguments !== undefined) {
    findings.add(
      `type arguments are not part of the declarative configuration form ` +
        `(SPEC 7)`,
      lineOf(expression, sourceFile),
    );
    ok = false;
  }
  if (expression.arguments.length !== 1) {
    findings.add(
      `defineConfig takes exactly one argument — the statically literal ` +
        `configuration (SPEC 7)`,
      lineOf(expression, sourceFile),
    );
    return null;
  }
  const argument = expression.arguments[0]!;
  if (ts.isSpreadElement(argument)) {
    findings.add(
      `a spread argument is not statically literal (SPEC 7)`,
      lineOf(argument, sourceFile),
    );
    return null;
  }
  return ok && binding !== null ? argument : null;
}

/** A statically literal value with source lines, for actionable findings. */
type ConfigNode =
  | { readonly kind: "string"; readonly value: string; readonly line: number }
  | { readonly kind: "boolean"; readonly value: boolean; readonly line: number }
  | {
      readonly kind: "array";
      readonly elements: readonly ConfigNode[];
      readonly line: number;
    }
  | ObjectNode;

interface ObjectNode {
  readonly kind: "object";
  /** Entries in written order (deterministic walk, SPEC 12.0). */
  readonly entries: ReadonlyMap<string, ConfigNode>;
  readonly keyLines: ReadonlyMap<string, number>;
  readonly line: number;
}

/** Names the rejected expression form in "not statically literal" findings. */
function describeExpression(expr: ts.Expression): string {
  if (ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr)) {
    return "a number literal";
  }
  if (
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isTemplateExpression(expr)
  ) {
    return "a template literal (not a static string literal, SPEC 2.4)";
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "`null`";
  if (ts.isIdentifier(expr)) return `the identifier \`${expr.text}\``;
  if (ts.isCallExpression(expr)) return "a call expression";
  return "an unsupported expression form";
}

const LITERAL_EXPECTATION =
  `the defineConfig argument must be statically literal — object literals ` +
  `with non-computed identifier or string-literal keys, array literals, ` +
  `static string literals, \`true\`, and \`false\` (SPEC 7, 2.4)`;

/**
 * SPEC 7: reduce the sole argument to data — object literals with
 * non-computed identifier or string-literal keys, array literals, static
 * string literals (2.4: plain single- or double-quoted; template literals
 * are not static), and the boolean literals; nothing else, no spread, no
 * computed value. Reports every violation it finds; returns null when any
 * part failed.
 */
function reduceLiteral(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  findings: ConfigFindings,
): ConfigNode | null {
  const line = lineOf(expr, sourceFile);
  if (ts.isObjectLiteralExpression(expr)) {
    const entries = new Map<string, ConfigNode>();
    const keyLines = new Map<string, number>();
    let failed = false;
    for (const property of expr.properties) {
      if (!ts.isPropertyAssignment(property)) {
        // Spread assignments, shorthand properties, methods, accessors.
        findings.add(
          `${LITERAL_EXPECTATION}; object literals may contain only ` +
            `\`key: value\` assignments — no spread, shorthand, method, ` +
            `or accessor`,
          lineOf(property, sourceFile),
        );
        failed = true;
        continue;
      }
      const name = property.name;
      let key: string;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        key = name.text;
      } else {
        findings.add(
          `${LITERAL_EXPECTATION}; object keys must be non-computed ` +
            `identifier or string-literal keys`,
          lineOf(name, sourceFile),
        );
        failed = true;
        continue;
      }
      if (entries.has(key)) {
        findings.add(
          `duplicate key "${key}" in one object literal (SPEC 7, 14.14)`,
          lineOf(name, sourceFile),
        );
        failed = true;
        continue;
      }
      const value = reduceLiteral(property.initializer, sourceFile, findings);
      if (value === null) {
        failed = true;
        continue;
      }
      entries.set(key, value);
      keyLines.set(key, lineOf(name, sourceFile));
    }
    return failed ? null : { kind: "object", entries, keyLines, line };
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const elements: ConfigNode[] = [];
    let failed = false;
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        findings.add(
          `${LITERAL_EXPECTATION}; array literals may not contain spreads ` +
            `or holes`,
          lineOf(element, sourceFile),
        );
        failed = true;
        continue;
      }
      const value = reduceLiteral(element, sourceFile, findings);
      if (value === null) {
        failed = true;
        continue;
      }
      elements.push(value);
    }
    return failed ? null : { kind: "array", elements, line };
  }
  if (ts.isStringLiteral(expr)) {
    // SPEC 2.4: a static string literal is a plain single- or double-quoted
    // string; both parse as StringLiteral. Template literals do not.
    return { kind: "string", value: expr.text, line };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "boolean", value: true, line };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: false, line };
  }
  findings.add(
    `${LITERAL_EXPECTATION}; found ${describeExpression(expr)}`,
    line,
  );
  return null;
}

// ---------------------------------------------------------------------------
// Schema validation (SPEC 7, 7.1–7.5)
// ---------------------------------------------------------------------------

/** The configured group names by kind, for reference validation. */
interface GroupNames {
  readonly spec: ReadonlySet<string>;
  readonly code: ReadonlySet<string>;
}

function isDependencyKind(value: string): value is DependencyEdgeKind {
  return (DEPENDENCY_EDGE_KINDS as readonly string[]).includes(value);
}

/** Required string field; reports and returns undefined when missing/wrong. */
function requireString(
  object: ObjectNode,
  key: string,
  where: string,
  expectation: string,
  findings: ConfigFindings,
): { value: string; line: number } | undefined {
  const node = object.entries.get(key);
  if (node === undefined) {
    findings.add(
      `${where}: missing required key "${key}" — ${expectation}`,
      object.line,
    );
    return undefined;
  }
  if (node.kind !== "string") {
    findings.add(
      `${where}.${key} must be a string — ${expectation}`,
      node.line,
    );
    return undefined;
  }
  return { value: node.value, line: node.line };
}

/**
 * Optional enumerated string field; reports invalid values. Returns
 * undefined when absent or invalid.
 */
function optionalEnum<T extends string>(
  object: ObjectNode,
  key: string,
  allowed: readonly T[],
  where: string,
  findings: ConfigFindings,
): T | undefined {
  const node = object.entries.get(key);
  if (node === undefined) return undefined;
  if (
    node.kind !== "string" ||
    !(allowed as readonly string[]).includes(node.value)
  ) {
    findings.add(
      `${where}.${key} must be one of ${allowed.map((v) => `"${v}"`).join(", ")}`,
      node.line,
    );
    return undefined;
  }
  return node.value as T;
}

/**
 * Optional tag-list field (SPEC 7.4 `targetTags`, 7.5 selector `tags`): a
 * list of strings; an empty list is a configuration error (14.14).
 */
function optionalTagList(
  object: ObjectNode,
  key: string,
  where: string,
  findings: ConfigFindings,
): readonly string[] | undefined {
  const node = object.entries.get(key);
  if (node === undefined) return undefined;
  if (node.kind !== "array") {
    findings.add(`${where}.${key} must be a list of tags`, node.line);
    return undefined;
  }
  if (node.elements.length === 0) {
    // SPEC 7.4/7.5 → 14.14: an empty list is a configuration error.
    findings.add(
      `${where}.${key} is empty — an empty tag list is a configuration ` +
        `error (SPEC 7.4, 7.5, 14.14)`,
      node.line,
    );
    return undefined;
  }
  const tags: string[] = [];
  for (const element of node.elements) {
    if (element.kind !== "string") {
      findings.add(`${where}.${key}: each tag must be a string`, element.line);
      continue;
    }
    tags.push(element.value);
  }
  return tags;
}

/**
 * Optional dependency-edge-kind list (SPEC 7.4 `edgeKinds`, 7.5 rule
 * `kinds`): a subset of depends/embeds/references; empty is a configuration
 * error (14.14). Returns undefined when absent (caller applies the
 * all-three default) or invalid.
 */
function optionalKindList(
  object: ObjectNode,
  key: string,
  where: string,
  findings: ConfigFindings,
): readonly DependencyEdgeKind[] | undefined {
  const node = object.entries.get(key);
  if (node === undefined) return undefined;
  if (node.kind !== "array") {
    findings.add(
      `${where}.${key} must be a list drawn from "depends", "embeds", ` +
        `"references" (SPEC 7.4, 7.5)`,
      node.line,
    );
    return undefined;
  }
  if (node.elements.length === 0) {
    findings.add(
      `${where}.${key} is empty — an empty ${key} list is a configuration ` +
        `error (SPEC 7.4, 7.5, 14.14)`,
      node.line,
    );
    return undefined;
  }
  const kinds: DependencyEdgeKind[] = [];
  for (const element of node.elements) {
    if (element.kind !== "string" || !isDependencyKind(element.value)) {
      findings.add(
        `${where}.${key}: each element must be one of "depends", "embeds", ` +
          `"references" (SPEC 7.4, 7.5)`,
        element.line,
      );
      continue;
    }
    if (!kinds.includes(element.value)) kinds.push(element.value);
  }
  return kinds;
}

/**
 * SPEC 7.4/7.5, 14.14: resolve a group reference's kind. The kind MUST be
 * inferred when the name is unambiguous and MUST be given when the name
 * exists as both a spec and a code group; an unknown name, a name not of
 * the required kind, and an ambiguous name without a kind are configuration
 * errors.
 */
function resolveGroupKind(
  name: string,
  given: "spec" | "code" | undefined,
  groups: GroupNames,
  where: string,
  line: number,
  findings: ConfigFindings,
): "spec" | "code" | undefined {
  const inSpec = groups.spec.has(name);
  const inCode = groups.code.has(name);
  if (!inSpec && !inCode) {
    findings.add(
      `${where}: unknown group "${name}" — not a configured spec or code ` +
        `group (SPEC 7.4, 7.5, 14.14)`,
      line,
    );
    return undefined;
  }
  if (given === undefined) {
    if (inSpec && inCode) {
      findings.add(
        `${where}: "${name}" exists as both a spec and a code group — the ` +
          `kind is ambiguous and must be given (SPEC 7.4, 7.5, 14.14)`,
        line,
      );
      return undefined;
    }
    return inSpec ? "spec" : "code";
  }
  if (given === "spec" ? !inSpec : !inCode) {
    findings.add(
      `${where}: "${name}" is not a configured ${given} group — the ` +
        `reference requires that kind (SPEC 7.4, 7.5, 14.14)`,
      line,
    );
    return undefined;
  }
  return given;
}

/**
 * SPEC 7.1/7.2: a `specs`/`code` value is an object of named groups, each a
 * list of globs resolving relative to the workspace root; a pattern that
 * resolves outside it is a configuration error (SPEC 7, 14.14). An empty
 * map and groups matching no files are valid.
 */
function validateGroups(
  node: ConfigNode,
  label: "specs" | "code",
  findings: ConfigFindings,
): ConfiguredGroup[] {
  if (node.kind !== "object") {
    findings.add(
      `"${label}" must be an object of named groups, each a list of globs ` +
        `(SPEC 7.1, 7.2)`,
      node.line,
    );
    return [];
  }
  const groups: ConfiguredGroup[] = [];
  for (const [name, value] of node.entries) {
    const patterns: string[] = [];
    const globs: CompiledGlob[] = [];
    if (value.kind !== "array") {
      findings.add(
        `${label}.${name} must be a list of glob strings (SPEC 7.1, 7.2)`,
        value.line,
      );
    } else {
      value.elements.forEach((element, index) => {
        if (element.kind !== "string") {
          findings.add(
            `${label}.${name}[${index}] must be a glob string (SPEC 7)`,
            element.line,
          );
          return;
        }
        const compiled = compileGlob(element.value, "plain");
        if (!compiled.ok) {
          // Plain mode's only compile error is outside-root (SPEC 7).
          findings.add(
            `${label}.${name}[${index}]: the glob "${element.value}" ` +
              `resolves outside the workspace root (SPEC 7, 14.14)`,
            element.line,
          );
          return;
        }
        patterns.push(element.value);
        globs.push(compiled.glob);
      });
    }
    // The group's name is configured even when a pattern is bad: reference
    // validation below stays accurate, and the findings fail the load anyway.
    groups.push({ name, patterns, globs });
  }
  return groups;
}

/**
 * SPEC 7.3: `markdown.emit` is a required boolean; `markdown.outDir` is an
 * optional path resolving relative to the workspace root that MUST resolve
 * within it; unknown keys are configuration errors (14.14).
 */
function validateMarkdown(
  node: ConfigNode,
  findings: ConfigFindings,
): MarkdownSettings | undefined {
  if (node.kind !== "object") {
    findings.add(
      `"markdown" must be an object with "emit" and optional "outDir" ` +
        `(SPEC 7.3)`,
      node.line,
    );
    return undefined;
  }
  for (const [key] of node.entries) {
    if (key !== "emit" && key !== "outDir") {
      findings.add(
        `unknown key "${key}" in "markdown" — the defined keys are "emit" ` +
          `and "outDir" (SPEC 7.3, 14.14)`,
        node.keyLines.get(key),
      );
    }
  }
  const emitNode = node.entries.get("emit");
  let emit = false;
  if (emitNode === undefined) {
    findings.add(
      `"markdown.emit" is required — a boolean controlling whether pure ` +
        `Markdown files are emitted (SPEC 7.3)`,
      node.line,
    );
  } else if (emitNode.kind !== "boolean") {
    findings.add(
      `"markdown.emit" must be the boolean literal true or false (SPEC 7.3)`,
      emitNode.line,
    );
  } else {
    emit = emitNode.value;
  }
  const outDirNode = node.entries.get("outDir");
  let outDir: string | undefined;
  if (outDirNode !== undefined) {
    if (outDirNode.kind !== "string") {
      findings.add(
        `"markdown.outDir" must be a path string (SPEC 7.3)`,
        outDirNode.line,
      );
    } else if (!resolvesInsideRoot(outDirNode.value)) {
      findings.add(
        `"markdown.outDir" ("${outDirNode.value}") resolves outside the ` +
          `workspace root — it must resolve within it (SPEC 7.3, 14.14)`,
        outDirNode.line,
      );
    } else {
      outDir = outDirNode.value;
    }
  }
  return { emit, outDir };
}

/**
 * SPEC 7.3 (and SPEC 7 for globs): lexical containment in the workspace
 * root — an absolute path, or a `..` stepping above the root, resolves
 * outside it.
 */
function resolvesInsideRoot(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.length > 1 && segments[0] === "") return false; // absolute
  let depth = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return false;
      depth -= 1;
      continue;
    }
    depth += 1;
  }
  return true;
}

const PROFILE_KEYS: readonly string[] = [
  "name",
  "target",
  "targetTags",
  "targets",
  "boundary",
  "boundaryKind",
  "mode",
  "edgeKinds",
];

/** SPEC 7.4: validate the `coverage` profile list. */
function validateCoverage(
  node: ConfigNode,
  groups: GroupNames,
  findings: ConfigFindings,
): CoverageProfile[] {
  if (node.kind !== "array") {
    findings.add(
      `"coverage" must be a list of coverage profiles (SPEC 7.4)`,
      node.line,
    );
    return [];
  }
  const profiles: CoverageProfile[] = [];
  const names = new Set<string>();
  node.elements.forEach((element, index) => {
    const where = `coverage[${index}]`;
    if (element.kind !== "object") {
      findings.add(
        `${where} must be a profile object (SPEC 7.4)`,
        element.line,
      );
      return;
    }
    for (const [key] of element.entries) {
      if (!PROFILE_KEYS.includes(key)) {
        findings.add(
          `unknown key "${key}" in ${where} — the defined profile keys are ` +
            `${PROFILE_KEYS.join(", ")} (SPEC 7.4, 14.14)`,
          element.keyLines.get(key),
        );
      }
    }
    const name = requireString(
      element,
      "name",
      where,
      `a unique profile name (SPEC 7.4)`,
      findings,
    );
    if (name !== undefined) {
      if (names.has(name.value)) {
        findings.add(
          `${where}: duplicate profile name "${name.value}" — profile ` +
            `names are unique (SPEC 7.4, 14.14)`,
          name.line,
        );
      }
      names.add(name.value);
    }
    const target = requireString(
      element,
      "target",
      where,
      `the spec group whose requirements must be covered (SPEC 7.4)`,
      findings,
    );
    if (target !== undefined && !groups.spec.has(target.value)) {
      // SPEC 7.4: a name that is not a configured spec group's is a
      // configuration error (14.14) — a code group's name included.
      findings.add(
        groups.code.has(target.value)
          ? `${where}.target: "${target.value}" names a code group — target ` +
              `must be a configured spec group (SPEC 7.4, 14.14)`
          : `${where}.target: "${target.value}" is not a configured spec ` +
              `group (SPEC 7.4, 14.14)`,
        target.line,
      );
    }
    const targetTags = optionalTagList(element, "targetTags", where, findings);
    const targets =
      optionalEnum(element, "targets", ["leaves", "all"], where, findings) ??
      "leaves";
    const boundary = requireString(
      element,
      "boundary",
      where,
      `the spec or code group counting as the coverage boundary (SPEC 7.4)`,
      findings,
    );
    const boundaryKindGiven = optionalEnum(
      element,
      "boundaryKind",
      ["spec", "code"],
      where,
      findings,
    );
    let boundaryKind: "spec" | "code" = "spec";
    if (boundary !== undefined) {
      boundaryKind =
        resolveGroupKind(
          boundary.value,
          boundaryKindGiven,
          groups,
          `${where}.boundary`,
          boundary.line,
          findings,
        ) ?? "spec";
    }
    const mode =
      (() => {
        const value = requireString(
          element,
          "mode",
          where,
          `"direct" or "transitive" (SPEC 7.4)`,
          findings,
        );
        if (value === undefined) return undefined;
        if (value.value !== "direct" && value.value !== "transitive") {
          findings.add(
            `${where}.mode must be "direct" or "transitive" (SPEC 7.4)`,
            value.line,
          );
          return undefined;
        }
        return value.value;
      })() ?? "direct";
    const edgeKinds =
      optionalKindList(element, "edgeKinds", where, findings) ??
      DEPENDENCY_EDGE_KINDS;
    profiles.push({
      name: name?.value ?? "",
      target: target?.value ?? "",
      targetTags,
      targets,
      boundary: boundary?.value ?? "",
      boundaryKind,
      mode,
      edgeKinds,
    });
  });
  return profiles;
}

const RULE_KEYS: readonly string[] = ["name", "type", "from", "to", "kinds"];
const SELECTOR_KEYS: readonly string[] = ["group", "files", "tags", "kind"];

/**
 * SPEC 7.5: a selector matches by exactly one of `{ group }`, `{ files }`,
 * or `{ tags }`; a group selector MAY include `kind`. Returns the validated
 * selector, or undefined after reporting.
 */
function validateSelector(
  node: ConfigNode | undefined,
  side: "from" | "to",
  where: string,
  groups: GroupNames,
  findings: ConfigFindings,
  ruleLine: number,
): PolicySelector | undefined {
  const label = `${where}.${side}`;
  if (node === undefined) {
    findings.add(
      `${where}: missing required key "${side}" — a selector matching by ` +
        `exactly one of "group", "files", or "tags" (SPEC 7.5)`,
      ruleLine,
    );
    return undefined;
  }
  if (node.kind !== "object") {
    findings.add(
      `${label} must be a selector object — exactly one of { group }, ` +
        `{ files }, { tags } (SPEC 7.5)`,
      node.line,
    );
    return undefined;
  }
  for (const [key] of node.entries) {
    if (!SELECTOR_KEYS.includes(key)) {
      findings.add(
        `unknown key "${key}" in ${label} — a selector's defined keys are ` +
          `"group" (with optional "kind"), "files", and "tags" (SPEC 7.5, ` +
          `14.14)`,
        node.keyLines.get(key),
      );
    }
  }
  const present = (["group", "files", "tags"] as const).filter((key) =>
    node.entries.has(key),
  );
  if (present.length !== 1) {
    findings.add(
      `${label}: a selector matches by exactly one of "group", "files", or ` +
        `"tags" (SPEC 7.5, 14.14)`,
      node.line,
    );
    return undefined;
  }
  const chosen = present[0]!;
  if (node.entries.has("kind") && chosen !== "group") {
    // SPEC 7.5: only a group selector MAY include `kind`.
    findings.add(
      `${label}: "kind" is permitted only in a group selector (SPEC 7.5, ` +
        `14.14)`,
      node.keyLines.get("kind"),
    );
  }
  if (chosen === "group") {
    const groupNode = node.entries.get("group")!;
    if (groupNode.kind !== "string") {
      findings.add(
        `${label}.group must be a group name string (SPEC 7.5)`,
        groupNode.line,
      );
      return undefined;
    }
    const kindGiven = optionalEnum(
      node,
      "kind",
      ["spec", "code"],
      label,
      findings,
    );
    const groupKind = resolveGroupKind(
      groupNode.value,
      kindGiven,
      groups,
      `${label}.group`,
      groupNode.line,
      findings,
    );
    return {
      selector: "group",
      group: groupNode.value,
      groupKind: groupKind ?? "spec",
    };
  }
  if (chosen === "files") {
    const filesNode = node.entries.get("files")!;
    if (filesNode.kind !== "string") {
      findings.add(
        `${label}.files must be a glob string (SPEC 7.5)`,
        filesNode.line,
      );
      return undefined;
    }
    // SPEC 7.5: capture wildcards bind in a rule's `from` pattern and are
    // referenced by its `to` pattern.
    const compiled = compileGlob(
      filesNode.value,
      side === "from" ? "capture-from" : "capture-to",
    );
    if (!compiled.ok) {
      findings.add(
        compiled.error.kind === "outside-root"
          ? `${label}.files: the glob "${filesNode.value}" resolves outside ` +
              `the workspace root (SPEC 7, 14.14)`
          : `${label}.files: capture $${compiled.error.capture} appears ` +
              `more than once — each capture wildcard may appear at most ` +
              `once in a "from" pattern (SPEC 7.5, 14.14)`,
        filesNode.line,
      );
      return undefined;
    }
    return { selector: "files", pattern: filesNode.value, glob: compiled.glob };
  }
  const tags = optionalTagList(node, "tags", label, findings);
  if (tags === undefined) return undefined;
  return { selector: "tags", tags };
}

/** SPEC 7.5: validate the `policy` rule list. */
function validatePolicy(
  node: ConfigNode,
  groups: GroupNames,
  findings: ConfigFindings,
): PolicyRule[] {
  if (node.kind !== "array") {
    findings.add(
      `"policy" must be a list of policy rules (SPEC 7.5)`,
      node.line,
    );
    return [];
  }
  const rules: PolicyRule[] = [];
  const names = new Set<string>();
  node.elements.forEach((element, index) => {
    const where = `policy[${index}]`;
    if (element.kind !== "object") {
      findings.add(`${where} must be a rule object (SPEC 7.5)`, element.line);
      return;
    }
    for (const [key] of element.entries) {
      if (!RULE_KEYS.includes(key)) {
        findings.add(
          `unknown key "${key}" in ${where} — the defined rule keys are ` +
            `${RULE_KEYS.join(", ")} (SPEC 7.5, 14.14)`,
          element.keyLines.get(key),
        );
      }
    }
    const name = requireString(
      element,
      "name",
      where,
      `a unique rule name (SPEC 7.5)`,
      findings,
    );
    if (name !== undefined) {
      if (names.has(name.value)) {
        findings.add(
          `${where}: duplicate rule name "${name.value}" — rule names are ` +
            `unique (SPEC 7.5, 14.14)`,
          name.line,
        );
      }
      names.add(name.value);
    }
    const type =
      (() => {
        const value = requireString(
          element,
          "type",
          where,
          `"forbidden" or "allowedOnly" (SPEC 7.5)`,
          findings,
        );
        if (value === undefined) return undefined;
        if (value.value !== "forbidden" && value.value !== "allowedOnly") {
          findings.add(
            `${where}.type must be "forbidden" or "allowedOnly" (SPEC 7.5)`,
            value.line,
          );
          return undefined;
        }
        return value.value;
      })() ?? "forbidden";
    const from = validateSelector(
      element.entries.get("from"),
      "from",
      where,
      groups,
      findings,
      element.line,
    );
    const to = validateSelector(
      element.entries.get("to"),
      "to",
      where,
      groups,
      findings,
      element.line,
    );
    // SPEC 7.5: a `to` referencing a capture absent from `from` is a
    // configuration error (14.14). With no `from` files pattern, every
    // capture the `to` pattern references is absent from `from`.
    if (to !== undefined && to.selector === "files") {
      const unbound =
        from !== undefined && from.selector === "files"
          ? unboundToCaptures(from.glob, to.glob)
          : [...to.glob.captures].sort((a, b) => a - b);
      for (const capture of unbound) {
        findings.add(
          `${where}.to: the files pattern references $${capture}, which ` +
            `"from" does not capture (SPEC 7.5, 14.14)`,
          element.line,
        );
      }
    }
    if (from === undefined || to === undefined) return;
    const kinds =
      optionalKindList(element, "kinds", where, findings) ??
      DEPENDENCY_EDGE_KINDS;
    rules.push({ name: name?.value ?? "", type, from, to, kinds });
  });
  return rules;
}

const TOP_LEVEL_KEYS: readonly string[] = [
  "specs",
  "code",
  "markdown",
  "coverage",
  "policy",
];

/** SPEC 7: validate the reduced argument against the configuration schema. */
function validateSchema(
  root: ConfigNode,
  findings: ConfigFindings,
): Configuration {
  if (root.kind !== "object") {
    findings.add(
      `the defineConfig argument must be an object literal (SPEC 7)`,
      root.line,
    );
    return {
      specGroups: [],
      codeGroups: [],
      coverage: [],
      policy: [],
    };
  }
  // SPEC 7/14.14: unknown keys anywhere in the defineConfig argument.
  for (const [key] of root.entries) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      findings.add(
        `unknown key "${key}" in the defineConfig argument — the defined ` +
          `keys are ${TOP_LEVEL_KEYS.join(", ")} (SPEC 7, 14.14)`,
        root.keyLines.get(key),
      );
    }
  }
  // SPEC 7: `specs` is required; `code`, `markdown`, `coverage`, and
  // `policy` are optional with defined omission semantics.
  const specsNode = root.entries.get("specs");
  let specGroups: ConfiguredGroup[] = [];
  if (specsNode === undefined) {
    findings.add(
      `missing required key "specs" — named groups of xspec source files ` +
        `(SPEC 7, 7.1)`,
      root.line,
    );
  } else {
    specGroups = validateGroups(specsNode, "specs", findings);
  }
  const codeNode = root.entries.get("code");
  const codeGroups =
    codeNode === undefined ? [] : validateGroups(codeNode, "code", findings);
  const groups: GroupNames = {
    spec: new Set(specGroups.map((group) => group.name)),
    code: new Set(codeGroups.map((group) => group.name)),
  };
  const markdownNode = root.entries.get("markdown");
  const markdown =
    markdownNode === undefined
      ? undefined
      : validateMarkdown(markdownNode, findings);
  const coverageNode = root.entries.get("coverage");
  const coverage =
    coverageNode === undefined
      ? []
      : validateCoverage(coverageNode, groups, findings);
  const policyNode = root.entries.get("policy");
  const policy =
    policyNode === undefined
      ? []
      : validatePolicy(policyNode, groups, findings);
  return { specGroups, codeGroups, markdown, coverage, policy };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse and validate configuration text (SPEC 7). `fileName` names the file
 * in findings (its base name — never an absolute path, SPEC 12.0). The text
 * is analyzed statically and never executed or imported (IMPLEMENTATION).
 */
export function parseConfiguration(
  text: string,
  fileName: string,
): ConfigurationResult {
  const findings = new ConfigFindings(fileName);
  // SPEC 14.14: a configuration file that is not well-formed TypeScript.
  if (!checkSyntax(text, fileName, findings)) {
    return { ok: false, findings: findings.findings };
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const argument = checkForm(sourceFile, findings);
  if (argument === null) {
    return { ok: false, findings: findings.findings };
  }
  const reduced = reduceLiteral(argument, sourceFile, findings);
  if (reduced === null) {
    return { ok: false, findings: findings.findings };
  }
  const configuration = validateSchema(reduced, findings);
  if (findings.count > 0) {
    return { ok: false, findings: findings.findings };
  }
  return { ok: true, configuration };
}
