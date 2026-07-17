// The shared static-reference analyzer (SPEC 2.4).
//
// IMPLEMENTATION (Key libraries): one shared static-reference analyzer
// serves MDX expression spans and TypeScript sources alike, built on the
// TypeScript compiler API. This module is that analyzer's core: it
// classifies one expression AST node as a static string literal, a static
// property chain, or dynamic, per the exact grammar of SPEC 2.4. The
// MDX-side drivers (./spec-references.ts) parse expression spans into
// standalone ASTs and feed them here; the TypeScript-side analysis feeds
// expressions of full parsed sources to the same function. What a
// classification *means* — which roots are import bindings, whether the
// string form is permitted (it is not in TypeScript `text` calls, SPEC
// 4.3), which condition a defect reports — is the caller's, not this
// module's: the analyzer is purely syntactic.
//
// All spans are UTF-16 code-unit offsets into the analyzed source text
// (the text of the `sourceFile` handed in); callers translate them into
// document byte ranges (SPEC 1.7).

import ts from "typescript";

/**
 * A half-open span of UTF-16 code-unit offsets into the analyzed source
 * text — deliberately not a `ByteRange` (SPEC 1.7): callers translate.
 */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * SPEC 2.4: a static string literal — a plain single- or double-quoted
 * string (template literals are not static). In `d` and `text(...)` this
 * is the local reference form naming an ID path in the same file
 * (SPEC 2.2); in a TypeScript `text` call it is invalid (SPEC 4.3).
 */
export interface ClassifiedString {
  readonly kind: "string";
  /** The literal's cooked value (the named ID path, SPEC 2.2). */
  readonly value: string;
  /** The quote character the author used (SPEC 6.4: preserved on rewrite). */
  readonly quote: '"' | "'";
  /** The literal token, quotes included. */
  readonly span: TextSpan;
}

/** One segment of a static property chain (SPEC 2.4). */
export interface ClassifiedSegment {
  /**
   * The segment name. Exactly one chain segment (SPEC 2.4); never split —
   * a name containing `.` can equal no ID segment (SPEC 1.4), so a dotted
   * computed index resolves to nothing (TEST-SPEC T2.4-4).
   */
  readonly name: string;
  /**
   * The access form (SPEC 2.4): non-computed property access whose name
   * is an identifier (`.login`), or computed access whose index is a
   * static string literal (`["login-v2"]`).
   */
  readonly access: "dot" | "computed";
  /** The index literal's quote character — null for dot access. */
  readonly quote: '"' | "'" | null;
  /**
   * The name token: the identifier, or the index string literal with its
   * quotes (SPEC 6.4: the minimal in-place edit of a renamed segment).
   */
  readonly nameSpan: TextSpan;
  /**
   * The whole access — from just past the base expression through the
   * access's last character (`.login`, or `["login-v2"]` through the
   * `]`), for rewrites that must replace the access form (SPEC 6.4).
   */
  readonly accessSpan: TextSpan;
}

/**
 * SPEC 2.4: a static property chain — a root identifier followed by zero
 * or more segments. Whether the root is an imported spec module's binding
 * (required for the chain to be a reference) is the caller's judgment.
 */
export interface ClassifiedChain {
  readonly kind: "chain";
  /** The root identifier's text (an import binding, when valid). */
  readonly rootName: string;
  /** The root identifier token. */
  readonly rootSpan: TextSpan;
  /** The segments, outermost last (document order along the chain). */
  readonly segments: readonly ClassifiedSegment[];
  /** The whole chain expression. */
  readonly span: TextSpan;
}

/**
 * SPEC 2.4: no other syntax participates in a chain — optional chaining,
 * non-null assertions, parentheses, and any other index or expression
 * form make the reference dynamic (14.8).
 */
export interface ClassifiedDynamic {
  readonly kind: "dynamic";
  /** Why the expression is dynamic, phrased for a finding message. */
  readonly reason: string;
  /** The whole analyzed expression. */
  readonly span: TextSpan;
}

/** The analyzer's classification of one expression (SPEC 2.4). */
export type ClassifiedReference =
  ClassifiedString | ClassifiedChain | ClassifiedDynamic;

/** The span of a node's own characters (leading trivia excluded). */
function spanOf(node: ts.Node, sourceFile: ts.SourceFile): TextSpan {
  return { start: node.getStart(sourceFile), end: node.getEnd() };
}

/** The quote character a string literal was written with. */
function quoteOf(
  literal: ts.StringLiteral,
  sourceFile: ts.SourceFile,
): '"' | "'" {
  const quote = sourceFile.text[literal.getStart(sourceFile)];
  if (quote !== '"' && quote !== "'") {
    throw new Error("xspec internal error: string literal without a quote");
  }
  return quote;
}

/**
 * Classify one expression per the static argument rule (SPEC 2.4): a
 * static string literal (plain single- or double-quoted; template
 * literals are not static), a static property chain (a root identifier
 * followed by zero or more segments, each a non-computed access whose
 * name is an identifier or a computed access whose index is a static
 * string literal), or dynamic — optional chaining, non-null assertions,
 * parentheses, and any other index or expression form.
 */
export function classifyReference(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): ClassifiedReference {
  const whole = spanOf(expression, sourceFile);
  const dynamic = (reason: string): ClassifiedDynamic => ({
    kind: "dynamic",
    reason,
    span: whole,
  });

  if (ts.isStringLiteral(expression)) {
    // SPEC 2.4: a plain single- or double-quoted string is static.
    return {
      kind: "string",
      value: expression.text,
      quote: quoteOf(expression, sourceFile),
      span: whole,
    };
  }
  if (
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isTemplateExpression(expression)
  ) {
    // SPEC 2.4: template literals are not static.
    return dynamic(
      "a template literal is not a static string literal — only plain " +
        "single- or double-quoted strings are static",
    );
  }

  // Walk a candidate property chain from the outermost access inward
  // (SPEC 2.4); segments are collected outermost-first and reversed.
  const collected: ClassifiedSegment[] = [];
  let node: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(node)) {
      return {
        kind: "chain",
        rootName: node.text,
        rootSpan: spanOf(node, sourceFile),
        segments: collected.reverse(),
        span: whole,
      };
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.questionDotToken !== undefined) {
        // SPEC 2.4: optional chaining makes the reference dynamic.
        return dynamic(
          "optional chaining does not participate in a static property chain",
        );
      }
      if (!ts.isIdentifier(node.name)) {
        return dynamic(
          "a private-name access does not participate in a static " +
            "property chain",
        );
      }
      collected.push({
        name: node.name.text,
        access: "dot",
        quote: null,
        nameSpan: spanOf(node.name, sourceFile),
        accessSpan: { start: node.expression.getEnd(), end: node.getEnd() },
      });
      node = node.expression;
      continue;
    }
    if (ts.isElementAccessExpression(node)) {
      if (node.questionDotToken !== undefined) {
        // SPEC 2.4: optional chaining makes the reference dynamic.
        return dynamic(
          "optional chaining does not participate in a static property chain",
        );
      }
      const index = node.argumentExpression;
      if (!ts.isStringLiteral(index)) {
        // SPEC 2.4: any other index form makes the reference dynamic.
        return dynamic(
          "a computed access is static only when its index is a plain " +
            "single- or double-quoted string literal",
        );
      }
      collected.push({
        name: index.text,
        access: "computed",
        quote: quoteOf(index, sourceFile),
        nameSpan: spanOf(index, sourceFile),
        accessSpan: { start: node.expression.getEnd(), end: node.getEnd() },
      });
      node = node.expression;
      continue;
    }
    if (ts.isNonNullExpression(node)) {
      // SPEC 2.4: non-null assertions make the reference dynamic.
      return dynamic(
        "a non-null assertion does not participate in a static property chain",
      );
    }
    if (ts.isParenthesizedExpression(node)) {
      // SPEC 2.4: parentheses make the reference dynamic.
      return dynamic(
        "parentheses do not participate in a static property chain",
      );
    }
    return dynamic(
      "it is neither a static string literal nor a static property chain " +
        "rooted at an import binding",
    );
  }
}

/**
 * Parse one expression span's exact source text (an MDX `d` value or
 * `{...}` container content, SPEC 2.2, 2.3) into a standalone AST for the
 * analyzer. `expression` is null when the text is not a single expression
 * statement — an object literal (parsed as a block), several statements,
 * or nothing — every such value is dynamic for the caller's purposes
 * (SPEC 2.7 → 14.8). Positions in the returned AST are UTF-16 offsets
 * into `text`.
 */
export function parseExpressionText(text: string): {
  readonly sourceFile: ts.SourceFile;
  readonly expression: ts.Expression | null;
} {
  const sourceFile = ts.createSourceFile(
    "xspec-expression.ts",
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const statement =
    sourceFile.statements.length === 1 ? sourceFile.statements[0] : undefined;
  const expression =
    statement !== undefined && ts.isExpressionStatement(statement)
      ? statement.expression
      : null;
  return { sourceFile, expression };
}
