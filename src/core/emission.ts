// Generated TypeScript module emission (SPEC 4, 4.1, 4.3, 4.4, 13.1).
//
// Pure core (IMPLEMENTATION Architecture: emission is pure text generation —
// deterministic, I/O-free): for one parsed spec source, this module renders
// the generated TypeScript module `NAME.xspec.ts` and its companion files as
// exact text; the workspace layer writes them (SPEC 12.1, 13.4).
//
// File arrangement (SPEC 13.1). Consumers import `./NAME.xspec` from
// TypeScript compiled for Node without a package.json — CommonJS format
// under `node16`/`nodenext` resolution — where the extensionless specifier
// resolves by Node-style extension lookup. Three generated files serve that
// specifier with no xspec runtime dependency:
//
// - `NAME.xspec.ts` — the generated module itself (SPEC 13.1 fixes this
//   path), beginning with the generated-file header (SPEC 4). TypeScript's
//   extension lookup for `./NAME.xspec` finds this file first, so it is the
//   compile-time resolution target; it re-exports the default and `text`
//   bindings from the runtime companion, so every declaration a consumer
//   navigates to lives in the type companion below. The consumer's own
//   compilation emits `NAME.xspec.js` beside it, which is what Node's
//   runtime extension lookup then finds for `require("./NAME.xspec")`.
// - `NAME.xspec.impl.js` — the runtime companion, a plain CommonJS module
//   (the format `.js` has beside these sources): the frozen node tokens, the
//   module-private subtree-text store, and the `text` export (SPEC 4.3,
//   4.4). The re-export shell reaches it by its exact file name, so the
//   consumer's emit of `NAME.xspec.js` never collides with it.
// - `NAME.xspec.impl.d.ts` — the type companion the shell's re-export
//   resolves to (`./NAME.xspec.impl.js` → `.d.ts` under standard
//   resolution): the branded node interfaces (SPEC 4.1, 4.4), the default
//   export, and the `text` signature. Keeping every declaration here — not
//   in the `.ts` shell — is what lets go-to-definition land in a
//   declaration file, which the declaration map added by the documentation
//   layer (SPEC 4.2) can redirect into the source `.mdx`; standard tooling
//   maps only declaration-file positions.
//
// Every companion is named `NAME.xspec.` plus a suffix (SPEC 13.1), so all
// generated files carry `.xspec.` in their names and fall under the
// source-discovery exclusion (SPEC 13.4).
//
// Runtime design (SPEC 4.1, 4.3, 4.4):
//
// - Nodes are frozen plain objects whose enumerable own properties are
//   exactly their child sections by ID segment — opaque tokens carrying no
//   requirement text as values (SPEC 4.1). Segment names are safe as object
//   keys because SPEC 1.4 excludes `__proto__`, `constructor`, `prototype`,
//   `then`, and `$` as segments.
// - Subtree texts live in a module-scope WeakMap keyed by node, closed over
//   by the `text` export and never exported, so requirement text is
//   reachable at runtime only through `text` (SPEC 4.3): a consumer that
//   never imports `text` can observe only child structure.
// - Each node carries its owning module's workspace-relative source path
//   under the shared registry symbol `Symbol.for("xspec.module")` — not
//   requirement text — so a foreign module's `text` can name both modules
//   when it throws on a cross-module call (SPEC 4.4 → 14.11 runtime half).
//
// Type design (SPEC 4.1, 4.4): each type companion declares its own
// module-local `unique symbol` and brands every node interface with it plus
// the module's source path as a string-literal type. Distinct declaration
// sites make distinct symbol types, so another module's nodes are never
// assignable here — the cross-module `text` call is a type error at the
// argument (SPEC 4.4) — and the unexported symbol makes node types
// unconstructible by consumers. Child sections are readonly properties named
// by ID segment (bracket-form string names when the segment is not an
// identifier, SPEC 1.4), and a missing requirement path is a property-access
// type error (SPEC 4.1).
//
// All output is a pure function of the document, its subtree texts, and the
// workspace-relative path: byte-deterministic, LF-only line breaks of its
// own, no wall clock, no absolute paths (SPEC 12.0). Requirement text enters
// string literals only through JSON escaping, which never introduces raw
// line breaks.

import type { SpecDocument, SpecSection } from "./mdx.js";
import type { WorkspaceTextModel } from "./text-model.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** One generated file: workspace-relative path and exact content. */
export interface GeneratedFile {
  /** Workspace-relative `/`-separated path (SPEC 1.5). */
  readonly path: string;
  /** The file's exact text (UTF-8 once written, SPEC 12.0). */
  readonly content: string;
}

/** The generated-file paths of one spec source (SPEC 13.1). */
export interface SpecModulePaths {
  /** `DIR/NAME.xspec.ts` — the generated module (SPEC 13.1). */
  readonly module: string;
  /** `DIR/NAME.xspec.impl.js` — the runtime companion. */
  readonly runtime: string;
  /** `DIR/NAME.xspec.impl.d.ts` — the type companion. */
  readonly types: string;
}

/**
 * The generated-module paths for the spec source at `specPath`
 * (workspace-relative): `NAME.mdx` generates `NAME.xspec.ts` and its
 * companions in the source file's directory (SPEC 13.1).
 */
export function specModulePaths(specPath: string): SpecModulePaths {
  const stem = specPath.endsWith(".mdx")
    ? specPath.slice(0, -".mdx".length)
    : specPath;
  return {
    module: `${stem}.xspec.ts`,
    runtime: `${stem}.xspec.impl.js`,
    types: `${stem}.xspec.impl.d.ts`,
  };
}

/**
 * Render the generated TypeScript module and companions for one parsed spec
 * source (SPEC 4, 13.1), in `SpecModulePaths` order (module, runtime,
 * types). Only valid workspaces emit generated output (SPEC 12.1); to stay
 * total, a section without a usable ID (null, possible only alongside its
 * own findings) is skipped with its subtree.
 */
export function generateSpecModule(
  document: SpecDocument,
  textModel: WorkspaceTextModel,
): readonly GeneratedFile[] {
  const paths = specModulePaths(document.path);
  const fileName = lastPathSegment(document.path);
  const moduleFileName = lastPathSegment(paths.module);
  const root = collectNodes(document);
  const nodes = flattenPreOrder(root);
  const brand = brandTypeName(fileName);
  return [
    { path: paths.module, content: renderShell(document.path, paths) },
    {
      path: paths.runtime,
      content: renderRuntime(document, textModel, moduleFileName, nodes),
    },
    {
      path: paths.types,
      content: renderTypes(document.path, moduleFileName, brand, nodes),
    },
  ];
}

// ---------------------------------------------------------------------------
// Node collection
// ---------------------------------------------------------------------------

/** One emitted node: a section (root included) with a usable identity. */
interface EmitNode {
  readonly section: SpecSection;
  /** Pre-order index over emitted nodes; the root is 0. */
  readonly index: number;
  /** The child's ID segment — its property name; null for the root. */
  readonly segment: string | null;
  readonly children: readonly EmitNode[];
}

/** Collect the emitted node tree in document order (root first). */
function collectNodes(document: SpecDocument): EmitNode {
  let nextIndex = 0;
  const build = (section: SpecSection, segment: string | null): EmitNode => {
    const index = nextIndex;
    nextIndex += 1;
    const children: EmitNode[] = [];
    for (const child of section.children) {
      if (child.id === null) {
        // No usable identity (its own 14.1/14.17 finding accounts for it;
        // such workspaces never emit) — skipped with its subtree.
        continue;
      }
      children.push(build(child, lastIdSegment(child.id)));
    }
    return { section, index, segment, children };
  };
  return build(document.root, null);
}

/** Pre-order flattening of the emitted node tree (document order). */
function flattenPreOrder(root: EmitNode): readonly EmitNode[] {
  const nodes: EmitNode[] = [];
  const visit = (node: EmitNode): void => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

/** The final segment of a structural ID (SPEC 1.3). */
function lastIdSegment(id: string): string {
  return id.slice(id.lastIndexOf(".") + 1);
}

/** The final `/`-separated component of a workspace-relative path. */
function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/**
 * A double-quoted TypeScript/JavaScript string literal holding exactly
 * `value`. JSON escaping covers every control character, quote, and
 * backslash; U+2028/U+2029 are escaped additionally so the literal never
 * contains a raw line terminator (safe inside `//` comments too).
 */
function stringLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** ASCII identifier test for property-name and type-name rendering. */
const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A property name for an ID segment: bare when it is an identifier name,
 * a string literal otherwise (bracket access on the consumer side,
 * SPEC 1.4, 4.1). Both forms declare the same property.
 */
function propertyName(segment: string): string {
  return IDENTIFIER_NAME.test(segment) ? segment : stringLiteral(segment);
}

/**
 * The brand interface name, derived from the source file name so
 * cross-module assignability errors name both modules readably. Uniqueness
 * is not needed — every emitted type name is local to its own declaration
 * file — so the sanitization is purely cosmetic.
 */
function brandTypeName(fileName: string): string {
  const stem = fileName.endsWith(".mdx")
    ? fileName.slice(0, -".mdx".length)
    : fileName;
  const sanitized = stem.replace(/[^A-Za-z0-9_$]/g, "_");
  return `XspecNode_${sanitized === "" ? "_" : sanitized}`;
}

/** The per-node interface name (pre-order index; the root is 0). */
function nodeTypeName(brand: string, index: number): string {
  return `${brand}_${String(index)}`;
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

/**
 * `NAME.xspec.ts` — the generated module (SPEC 13.1): the header
 * identifying it as generated by xspec from its source file (SPEC 4),
 * then the re-export of the runtime companion's default and `text`
 * bindings, which keeps every navigable declaration in the type companion
 * (see the module header).
 */
function renderShell(specPath: string, paths: SpecModulePaths): string {
  const runtimeSpecifier = `./${lastPathSegment(paths.runtime)}`;
  return [
    // SPEC 4: the generated-file header — the module begins with a comment
    // region identifying xspec and the source file.
    `// Generated by xspec from ${stringLiteral(specPath)}. Do not edit: manual`,
    `// edits are invalid (SPEC 4) and \`xspec check\` reports them as staleness`,
    `// (SPEC 14.10); \`xspec build\` regenerates this module and its companion`,
    `// files (SPEC 13.1).`,
    ``,
    `export { default, text } from ${stringLiteral(runtimeSpecifier)};`,
    ``,
  ].join("\n");
}

/**
 * `NAME.xspec.impl.js` — the runtime companion: a plain CommonJS module
 * providing the frozen node tokens, the module-private subtree-text store,
 * and the `text` export (SPEC 4.1, 4.3, 4.4).
 */
function renderRuntime(
  document: SpecDocument,
  textModel: WorkspaceTextModel,
  moduleFileName: string,
  nodes: readonly EmitNode[],
): string {
  const lines: string[] = [
    `// Generated by xspec from ${stringLiteral(document.path)} — the runtime`,
    `// companion of ${stringLiteral(moduleFileName)} (SPEC 13.1). Do not edit:`,
    `// \`xspec build\` regenerates this file.`,
    `"use strict";`,
    `Object.defineProperty(exports, "__esModule", { value: true });`,
    `// SPEC 4.4: every node carries its owning module's source path under the`,
    `// shared registry symbol, so a foreign module's \`text\` can identify the`,
    `// node's module when it throws (14.11).`,
    `var XSPEC_MODULE = ${stringLiteral(document.path)};`,
    `var XSPEC_MODULE_KEY = Symbol.for("xspec.module");`,
    `// SPEC 4.3: requirement text is reachable at runtime only through the`,
    `// \`text\` export — subtree texts live in this module-private map, never`,
    `// on the nodes (SPEC 4.1: nodes carry no requirement text as values).`,
    `var XSPEC_TEXTS = new WeakMap();`,
    `function xspecNode(children) {`,
    `  Object.defineProperty(children, XSPEC_MODULE_KEY, { value: XSPEC_MODULE });`,
    `  return Object.freeze(children);`,
    `}`,
    `// SPEC 4.1: each node's enumerable properties are exactly its child`,
    `// sections by ID segment; declarations are children-first so every`,
    `// literal references already-built nodes.`,
  ];
  const emitDeclarations = (node: EmitNode): void => {
    for (const child of node.children) emitDeclarations(child);
    const entries = node.children
      .map((child) => {
        // Runtime object keys are always string literals: uniform, and safe
        // for every segment SPEC 1.4 admits.
        return `${stringLiteral(child.segment ?? "")}: n${String(child.index)}`;
      })
      .join(", ");
    const identity =
      node.section.id === null
        ? document.path
        : `${document.path}#${node.section.id}`;
    lines.push(
      `var n${String(node.index)} = xspecNode({${entries === "" ? "" : ` ${entries} `}}); // ${stringLiteral(identity)}`,
    );
  };
  const root = nodes[0];
  if (root !== undefined) emitDeclarations(root);
  for (const node of nodes) {
    lines.push(
      `XSPEC_TEXTS.set(n${String(node.index)}, ${stringLiteral(
        textModel.subtreeText(document, node.section),
      )});`,
    );
  }
  lines.push(
    `// SPEC 4.1: the default export is the root node.`,
    `exports.default = n0;`,
    `// SPEC 4.3: \`text(node)\` returns the node's subtree text as a string.`,
    `// SPEC 4.4 → 14.11: a node from another generated module causes a throw`,
    `// identifying both the node's module and the called module.`,
    `exports.text = function text(node) {`,
    `  var value = XSPEC_TEXTS.get(node);`,
    `  if (value !== undefined) {`,
    `    return value;`,
    `  }`,
    `  var owner =`,
    `    node !== null && (typeof node === "object" || typeof node === "function")`,
    `      ? node[XSPEC_MODULE_KEY]`,
    `      : undefined;`,
    `  if (typeof owner === "string" && owner !== XSPEC_MODULE) {`,
    `    throw new Error(`,
    `      "xspec: cross-module text() call (SPEC 4.4): the node belongs to the " +`,
    `        "spec module generated from " +`,
    `        JSON.stringify(owner) +`,
    `        " but was passed to the \`text\` export of the module generated " +`,
    `        "from " +`,
    `        JSON.stringify(XSPEC_MODULE) +`,
    `        ".",`,
    `    );`,
    `  }`,
    `  throw new Error(`,
    `    "xspec: text() expects a node of the spec module generated from " +`,
    `      JSON.stringify(XSPEC_MODULE) +`,
    `      " (SPEC 4.1, 4.3).",`,
    `  );`,
    `};`,
    ``,
  );
  return lines.join("\n");
}

/**
 * `NAME.xspec.impl.d.ts` — the type companion: the module-local brand
 * (SPEC 4.4), the per-node interfaces with readonly segment-named child
 * properties (SPEC 4.1), the default export, and the `text` signature
 * (SPEC 4.3).
 */
function renderTypes(
  specPath: string,
  moduleFileName: string,
  brand: string,
  nodes: readonly EmitNode[],
): string {
  const lines: string[] = [
    `// Generated by xspec from ${stringLiteral(specPath)} — the type`,
    `// companion of ${stringLiteral(moduleFileName)} (SPEC 13.1). Do not edit:`,
    `// \`xspec build\` regenerates this file.`,
    ``,
    `// SPEC 4.4: node types are branded per generated module. The brand`,
    `// symbol is module-local and never exported, so nodes are opaque tokens`,
    `// (SPEC 4.1) consumers can neither construct nor unbrand, and another`,
    `// module's nodes — branded with that module's own symbol — are never`,
    `// assignable to this module's node types: the cross-module \`text\` call`,
    `// is a type error at the argument (14.11).`,
    `declare const XSPEC_BRAND: unique symbol;`,
    `interface ${brand} {`,
    `  readonly [XSPEC_BRAND]: ${stringLiteral(specPath)};`,
    `}`,
    ``,
  ];
  for (const node of nodes) {
    // SPEC 4.1: child sections as readonly properties named by ID segment;
    // a missing requirement path is a property-access type error.
    lines.push(
      `interface ${nodeTypeName(brand, node.index)} extends ${brand} {`,
    );
    for (const child of node.children) {
      lines.push(
        `  readonly ${propertyName(child.segment ?? "")}: ${nodeTypeName(brand, child.index)};`,
      );
    }
    lines.push(`}`);
  }
  lines.push(
    ``,
    `declare const root: ${nodeTypeName(brand, 0)};`,
    `// SPEC 4.1: the default export is the root node.`,
    `export default root;`,
    `// SPEC 4.3: \`text(node)\` returns the node's subtree text as a \`string\`.`,
    `// SPEC 4.4: only this module's nodes are accepted (14.11).`,
    `export declare function text(node: ${brand}): string;`,
    ``,
  );
  return lines.join("\n");
}
