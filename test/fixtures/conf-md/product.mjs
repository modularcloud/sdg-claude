// CONF-MD conformer fixture (CERTIFICATIONS.md §CONF-MD; TEST-SPEC 17
// C-1/C-2). A harness-owned executable product implementing §CONF-MD's Scope
// with the simplest conforming behavior — driven only through the C-2
// executable/workspace binding, never importing product code (the product and
// the harness are distinct programs; this fixture is part of the harness).
//
// Scope implemented (see CERTIFICATIONS.md §CONF-MD):
// - Spec-group workspaces of `.mdx` sources with imports (SPEC 2.1, valid
//   forms as staged), same-file and cross-file `text(...)` embeddings (2.3),
//   MDX comments, mixed line terminators, and sections carrying the full prop
//   set of 2.7 — `id`, `d` (local or external form, resolving as staged),
//   `coverage`, and `tags`; `markdown` absent, `{ emit: false }`, and
//   `{ emit: true }` with default emission next to each source (13.2); no
//   code groups, no `coverage` or `policy` configuration keys, no git.
// - `build` with byte-exact Markdown output per SPEC 3, and `query node`
//   reporting own and subtree text (SPEC 1.6, defined through the rules of 3).
// - Contracts under certification: SPEC 3 in full — removal, replacement, the
//   line-drop rule, line terminators — and the emission scope of 7.3.
//
// Key mechanisms:
// - Sources are scanned by a hand-rolled MDX-lite lexer recognizing exactly
//   the scope's constructs: spec module imports at line start, `<S>`/`<Spec>`
//   opening/closing/self-closing tags with the 2.7 prop set (quoted `id`,
//   `coverage`, `tags`; quote-aware braced `d`), MDX comments (single- and
//   multi-line), and `{text(...)}` embeddings with local (string) or external
//   (property chain) arguments. Deliberately no stock MDX parser: the
//   committed SUITE-11 fixtures stage shapes remark-mdx cannot parse — an
//   import line directly followed by a non-blank line (T3-3), and an opening
//   tag with trailing same-line content whose closing tag sits on a later
//   line (T3-1's `gamma`) — and the line-drop fixtures depend on exact exotic
//   bytes (boundary code points, lone-CR terminators) that tooling silently
//   normalizes. That mis-staging hazard is exactly what §CONF-MD certifies
//   against.
// - Compilation is a port of the harness oracle's line model
//   (test/helpers/oracles/markdown.ts, S-6-vetted; the "may share HARNESS-08's
//   compilation logic" of the CERT-11 plan entry) extended with node
//   attribution: every kept output atom — a content chunk, a `text(...)`
//   expansion, a line terminator — carries its owning requirement node (the
//   innermost section enclosing its source position; an expansion is owned by
//   the section containing the `text(...)` expression, per SPEC 1.6 own text
//   carrying embedded text fully expanded). Emitted Markdown is the atom
//   concatenation; a node's subtree text is the atoms owned by the node or a
//   descendant; its own text the atoms it owns exactly. Emission and query
//   answers therefore come from one attributed compile, so the SPEC 1.6
//   algebra (P-3: own-text runs interleaved with child subtree texts in
//   document order) holds by construction and any future line-model deviation
//   is automatically "consistent in Markdown output and, through 1.6, in own
//   and subtree text".
// - Expansions: a same-file target is closed before its embedding as the
//   in-scope tests stage it, so its atoms are final when the embedding's line
//   compiles — the expansion reads the running atom list. A cross-file target
//   compiles its file first (memoized recursion; an import/embedding cycle
//   surfaces as a finding instead of recursing forever). Chains (A embeds B
//   embeds C) therefore expand fully, bottom-up.
// - `build` writes nothing but the emitted Markdown (with `markdown.emit`
//   true; nothing at all otherwise — SPEC 7.3): the scope observes compiled
//   output and the query surface only, and every query recomputes from
//   sources, so reads need no stored graph data. A `build` that fails writes
//   nothing (SPEC 12.1: findings are collected before any write).
//
// Determinism (SPEC 12.0): no wall clock, no randomness, no absolute paths in
// any output; files in byte order of workspace-relative path; all JSON is
// serialized with byte-sorted keys.
//
// Deviation seam: runXspec(argv, cwd, options) assigns `options` onto the
// module-level `deviations` switches (all off = this conformer). Each
// VIOL-MD-* violator entry is a bin-<name>.mjs passing exactly one switch,
// consumed in the classification points below:
//   - §VIOL-MD-CLASS (CERT-12, bin-class.mjs): `widenDropWhitespace`,
//     consumed in `isDropWhitespaceCode` — the line-drop rule's whitespace
//     classification, the only whitespace class the compile consults,
//     feeding both "contained non-whitespace in the source" and "left empty
//     or whitespace-only".
//   - §VIOL-MD-CR (CERT-13, bin-cr.mjs): `loneCrNotTerminator`, consumed in
//     `terminatorAt` — the only place the compile's line model ends a line —
//     so a lone U+000D is an ordinary in-line character while CRLF and lone
//     U+000A remain terminators.
// Both points feed the single attributed compile, so a deviation applied
// there is consistent across output and text values by construction.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Outcome carriers
// ---------------------------------------------------------------------------

/** Usage or configuration error (SPEC 12.0 exit 2): message on stderr. */
class UsageError extends Error {}

/** Findings (SPEC 12.0 exit 1): a findings report on stdout. */
class FindingsError extends Error {
  /** @param {readonly Finding[]} findings */
  constructor(findings) {
    super("findings");
    this.findings = findings;
  }
}

/**
 * @typedef {{ condition: string, message: string, file: string,
 *             location: { start: number, end: number } }} Finding
 */

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys, SPEC 12.0)
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {unknown} */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(
        /** @type {Record<string, unknown>} */ (value)[key],
      );
    }
    return sorted;
  }
  return value;
}

/** One canonical serializer for emitted JSON. */
function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/** Whether anything (file, directory, or symlink) occupies the path. */
async function pathOccupied(absPath) {
  try {
    await fsp.lstat(absPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Configuration (SPEC 7): upward search + declarative literal parse
// ---------------------------------------------------------------------------

const CONFIG_NAME = "xspec.config.ts";

async function findConfigPath(cwd, configFlag) {
  if (configFlag !== undefined) {
    const abs = path.resolve(cwd, configFlag);
    if (!(await pathOccupied(abs))) {
      throw new UsageError(
        `configuration file not found: --config ${configFlag}`,
      );
    }
    return abs;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (await pathOccupied(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new UsageError(
        `configuration error: no ${CONFIG_NAME} found by upward search from the working directory`,
      );
    }
    dir = parent;
  }
}

/**
 * Parse the declarative configuration (SPEC 7): exactly an import of
 * `defineConfig` from "xspec" (optionally aliased) and a default export of
 * one call whose sole argument is statically literal. Returns the argument
 * as data. Any other form is a configuration error (SPEC 14.14, exit 2).
 */
function parseConfigSource(text) {
  const importMatch =
    /import\s*\{\s*defineConfig(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*(["'])xspec\2\s*;?/.exec(
      text,
    );
  if (!importMatch) {
    throw new UsageError(
      'configuration error: xspec.config.ts must import { defineConfig } from "xspec" (SPEC 7, 14.14)',
    );
  }
  const binding = importMatch[1] ?? "defineConfig";
  const callMatch = new RegExp(
    `export\\s+default\\s+${binding.replace(/\$/g, "\\$")}\\s*\\(`,
  ).exec(text);
  if (!callMatch) {
    throw new UsageError(
      "configuration error: xspec.config.ts must default-export one defineConfig(...) call (SPEC 7, 14.14)",
    );
  }
  const parser = new LiteralParser(text, callMatch.index + callMatch[0].length);
  const value = parser.parseValue();
  parser.skipWs();
  if (parser.text[parser.pos] !== ")") {
    throw new UsageError(
      "configuration error: the defineConfig argument must be one static literal (SPEC 7, 14.14)",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(
      "configuration error: defineConfig takes an object literal (SPEC 7)",
    );
  }
  return value;
}

/** Recursive-descent parser for the static-literal subset of SPEC 7. */
class LiteralParser {
  constructor(text, pos) {
    this.text = text;
    this.pos = pos;
  }

  fail(what) {
    throw new UsageError(
      `configuration error: ${what} at offset ${String(this.pos)} (SPEC 7, 14.14)`,
    );
  }

  skipWs() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]))
      this.pos += 1;
  }

  parseValue() {
    this.skipWs();
    const c = this.text[this.pos];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();
    if (this.text.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    return this.fail("expected an object, array, string, or boolean literal");
  }

  parseObject() {
    this.pos += 1; // "{"
    const obj = {};
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return obj;
    }
    for (;;) {
      this.skipWs();
      let key;
      const c = this.text[this.pos];
      if (c === '"' || c === "'") {
        key = this.parseString();
      } else {
        const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
        if (!match) this.fail("expected an object key");
        key = match[0];
        this.pos += key.length;
      }
      this.skipWs();
      if (this.text[this.pos] !== ":")
        this.fail("expected ':' after an object key");
      this.pos += 1;
      obj[key] = this.parseValue();
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.text[this.pos] === "}") {
          this.pos += 1;
          return obj;
        }
        continue;
      }
      if (this.text[this.pos] === "}") {
        this.pos += 1;
        return obj;
      }
      this.fail("expected ',' or '}' in an object literal");
    }
  }

  parseArray() {
    this.pos += 1; // "["
    const arr = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return arr;
    }
    for (;;) {
      arr.push(this.parseValue());
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.text[this.pos] === "]") {
          this.pos += 1;
          return arr;
        }
        continue;
      }
      if (this.text[this.pos] === "]") {
        this.pos += 1;
        return arr;
      }
      this.fail("expected ',' or ']' in an array literal");
    }
  }

  parseString() {
    const quote = this.text[this.pos];
    this.pos += 1;
    let out = "";
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === quote) {
        this.pos += 1;
        return out;
      }
      if (c === "\\") {
        const next = this.text[this.pos + 1];
        if (next === undefined) break;
        if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else out += next;
        this.pos += 2;
        continue;
      }
      out += c;
      this.pos += 1;
    }
    return this.fail("unterminated string literal");
  }
}

/**
 * Load and validate the configuration; returns the workspace root, the spec
 * groups, and the emission switch. The in-scope shape (CERTIFICATIONS.md
 * §CONF-MD) is spec groups of glob strings plus an optional
 * `markdown: { emit: boolean }` with default destinations — no `outDir`, no
 * `code`, `coverage`, or `policy` keys; anything else is refused loudly as a
 * configuration error rather than half-implemented (SPEC 7, 14.14).
 */
async function loadConfig(cwd, configFlag) {
  const configPath = await findConfigPath(cwd, configFlag);
  let text;
  try {
    text = await fsp.readFile(configPath, "utf8");
  } catch (error) {
    throw new UsageError(
      `configuration error: cannot read ${CONFIG_NAME}: ${error.message}`,
    );
  }
  const data = parseConfigSource(text);
  for (const key of Object.keys(data)) {
    if (key !== "specs" && key !== "markdown") {
      throw new UsageError(
        `configuration error: the key ${JSON.stringify(key)} is unknown or outside this fixture's scope (CERTIFICATIONS.md §CONF-MD; SPEC 7, 14.14)`,
      );
    }
  }
  const specs = data.specs;
  if (
    specs === undefined ||
    specs === null ||
    typeof specs !== "object" ||
    Array.isArray(specs)
  ) {
    throw new UsageError(
      "configuration error: `specs` is required and must be a map of groups (SPEC 7)",
    );
  }
  /** @type {Record<string, string[]>} */
  const groups = {};
  for (const [name, globs] of Object.entries(specs)) {
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) {
      throw new UsageError(
        `configuration error: spec group ${name} must be a list of glob strings (SPEC 7.1)`,
      );
    }
    for (const glob of globs) {
      if (glob.startsWith("/") || glob.split("/").includes("..")) {
        throw new UsageError(
          `configuration error: pattern ${glob} resolves outside the workspace root (SPEC 7, 14.14)`,
        );
      }
    }
    groups[name] = globs;
  }
  let emit = false;
  if (data.markdown !== undefined) {
    const markdown = data.markdown;
    if (
      markdown === null ||
      typeof markdown !== "object" ||
      Array.isArray(markdown)
    ) {
      throw new UsageError(
        "configuration error: `markdown` must be an object (SPEC 7.3, 14.14)",
      );
    }
    for (const key of Object.keys(markdown)) {
      if (key !== "emit") {
        throw new UsageError(
          `configuration error: markdown.${key} is unknown or outside this fixture's scope (CERTIFICATIONS.md §CONF-MD: default emission destinations only; SPEC 7.3, 14.14)`,
        );
      }
    }
    if (typeof markdown.emit !== "boolean") {
      throw new UsageError(
        "configuration error: markdown.emit is required and must be a boolean (SPEC 7.3, 14.14)",
      );
    }
    emit = markdown.emit;
  }
  return { root: path.dirname(configPath), groups, emit };
}

// ---------------------------------------------------------------------------
// Glob matching (SPEC 7): `*`, `?`, `**`, literals, dot rule, case-sensitive
// ---------------------------------------------------------------------------

const segmentRegexCache = new Map();

function globSegmentRegex(patternSegment) {
  let regex = segmentRegexCache.get(patternSegment);
  if (regex === undefined) {
    let source = "^";
    for (const ch of patternSegment) {
      if (ch === "*") source += "[^/]*";
      else if (ch === "?") source += "[^/]";
      else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    regex = new RegExp(source + "$");
    segmentRegexCache.set(patternSegment, regex);
  }
  return regex;
}

function globSegmentMatches(patternSegment, pathSegment) {
  // Dot rule (SPEC 7): a path segment beginning with `.` is matched only by
  // a pattern segment written with a leading `.`.
  if (pathSegment.startsWith(".") && !patternSegment.startsWith("."))
    return false;
  return globSegmentRegex(patternSegment).test(pathSegment);
}

function globMatches(pattern, relPath) {
  const patternSegments = pattern.split("/");
  const pathSegments = relPath.split("/");
  const match = (pi, si) => {
    if (pi === patternSegments.length) return si === pathSegments.length;
    const ps = patternSegments[pi];
    if (ps === "**") {
      if (match(pi + 1, si)) return true;
      // `**` spans whole segments but is not written with a leading dot, so
      // it never consumes a dot segment (SPEC 7).
      if (si < pathSegments.length && !pathSegments[si].startsWith(".")) {
        return match(pi, si + 1);
      }
      return false;
    }
    if (si >= pathSegments.length) return false;
    if (!globSegmentMatches(ps, pathSegments[si])) return false;
    return match(pi + 1, si + 1);
  };
  return match(0, 0);
}

// ---------------------------------------------------------------------------
// Discovery (SPEC 7, 13.4): walk plain files, never following symlinks
// ---------------------------------------------------------------------------

async function walkPlainFiles(rootAbs, relPrefix = "") {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await fsp.readdir(path.join(rootAbs, relPrefix), {
      withFileTypes: true,
    });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    if (entry.isSymbolicLink()) continue; // never discovered, never traversed
    if (entry.isDirectory()) {
      files.push(...(await walkPlainFiles(rootAbs, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

/** Derived files are never sources (SPEC 13.4). */
function isDerivedPath(rel) {
  const base = rel.split("/").at(-1) ?? rel;
  return (
    base.includes(".xspec.") || rel === ".xspec" || rel.startsWith(".xspec/")
  );
}

async function discoverSources(root, groups) {
  const all = (await walkPlainFiles(root)).sort();
  const discovered = [];
  for (const rel of all) {
    if (isDerivedPath(rel)) continue;
    const matched = Object.values(groups).some((globs) =>
      globs.some((glob) => globMatches(glob, rel)),
    );
    if (matched) discovered.push(rel);
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// SPEC 1.4 / SPEC 3 character classes — the CERT-12 / CERT-13 hook points
// ---------------------------------------------------------------------------

/**
 * Deviation switches (CERTIFICATIONS.md §VIOL-MD-*), all off in the
 * conformer; assigned by runXspec from each entry's options.
 *   - `widenDropWhitespace` (§VIOL-MD-CLASS, bin-class.mjs, CERT-12):
 *     consumed in `isDropWhitespaceCode` — the line-drop rule classifies
 *     U+00A0, U+0085, and U+2028 as whitespace.
 *   - `loneCrNotTerminator` (§VIOL-MD-CR, bin-cr.mjs, CERT-13): consumed in
 *     `terminatorAt` — a lone U+000D is not recognized as a line terminator;
 *     CRLF and lone U+000A remain terminators.
 * Both points feed the single attributed compile, so any deviation there is
 * automatically consistent in Markdown output and, through SPEC 1.6, in own
 * and subtree text.
 */
let deviations = {};

/**
 * The boundary code points SPEC 1.4 excludes from both character classes:
 * U+00A0 (no-break space), U+0085 (next line), U+2028 (line separator).
 * Under `widenDropWhitespace` (§VIOL-MD-CLASS, bin-class.mjs) the line-drop
 * rule classifies them as whitespace.
 */
const CLASS_BOUNDARY_CODE_POINTS = new Set([0x00a0, 0x0085, 0x2028]);

/**
 * SPEC 1.4's whitespace class, exactly: U+0009–U+000D and U+0020; no other
 * code point (U+00A0, U+0085, U+2028 included) belongs to it. Line dropping
 * (SPEC 3) uses this definition — this predicate is the one whitespace class
 * the compile consults (§VIOL-MD-CLASS's hook, CERT-12).
 *
 * §VIOL-MD-CLASS (bin-class.mjs): under `widenDropWhitespace` the boundary
 * code points are additionally classified whitespace. The one predicate
 * feeds both drop-rule decisions, so the drop conjunction ("contained
 * non-whitespace in the source" and "left empty or whitespace-only") still
 * implies characters disappeared: a line is dropped exactly when removals
 * left it holding only whitespace-classified characters — the deviation's "a
 * line left holding only those code points after removals is dropped" — and
 * a removal-free line holding only whitespace and boundary code points stays
 * kept (every removable construct carries ASCII non-whitespace, so such a
 * line has nothing to remove and now contains no non-whitespace at all).
 */
function isDropWhitespaceCode(code) {
  if (deviations.widenDropWhitespace && CLASS_BOUNDARY_CODE_POINTS.has(code)) {
    return true;
  }
  return (code >= 0x0009 && code <= 0x000d) || code === 0x0020;
}

/**
 * True when `text` is empty or consists only of drop-rule whitespace.
 * Iterating UTF-16 code units is exact: every 1.4 whitespace character (and
 * every widened-class boundary code point) is a single BMP code unit, and
 * each half of a surrogate pair is outside both classes, so any astral code
 * point correctly counts as non-whitespace.
 */
function isWhitespaceOnlyForDrop(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (!isDropWhitespaceCode(text.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * The line terminator starting at `index` in `text`, or null when the
 * character there does not end a line: U+000D U+000A is one terminator, a
 * U+000A not preceded by U+000D one, a U+000D not followed by U+000A one
 * (SPEC 3). Callers only invoke this at U+000A/U+000D positions; a U+000A at
 * `index` is never the tail of a CRLF here because content pieces are
 * contiguous source spans and a preceding U+000D in the same piece was
 * consumed as CRLF — true under the deviation too, which stops recognizing
 * only the *lone* U+000D. This function is the compile's whole line model
 * (§VIOL-MD-CR's hook, CERT-13).
 *
 * §VIOL-MD-CR (bin-cr.mjs): under `loneCrNotTerminator` a lone U+000D is not
 * recognized as a line terminator — it stays an ordinary in-line character
 * (still 1.4 whitespace to the drop rule's classification) — while CRLF and
 * lone U+000A remain terminators. Line extents, and with them the drop
 * rule's decisions and which terminator bytes drops consume, diverge; the
 * one hook feeds the single attributed compile, so the deviation is
 * consistent in Markdown output and, through SPEC 1.6, in own and subtree
 * text (P-3's internal consistency is preserved, per §VIOL-MD-CR's
 * expected-failure analysis).
 */
function terminatorAt(text, index) {
  const code = text.charCodeAt(index);
  if (code === 0x000a) return "\n";
  if (code === 0x000d) {
    if (text.charCodeAt(index + 1) === 0x000a) return "\r\n";
    return deviations.loneCrNotTerminator ? null : "\r";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Byte offsets (SPEC 1.7: ranges and locations are byte offsets)
// ---------------------------------------------------------------------------

/**
 * Map string (code-unit) indices to UTF-8 byte offsets. ASCII sources take
 * the identity fast path; the general path handles multi-byte content (the
 * boundary code points and astral characters of T3-3 and P-2's generator).
 */
function byteOffsetMapper(text, byteLength) {
  if (byteLength === text.length) return (i) => i;
  const offsets = new Array(text.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    offsets[i] = bytes;
    const code = text.codePointAt(i);
    const units = code > 0xffff ? 2 : 1;
    if (units === 2) offsets[i + 1] = bytes;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    i += units;
  }
  offsets[text.length] = bytes;
  return (index) => offsets[index];
}

// ---------------------------------------------------------------------------
// MDX-lite lexer: imports, `<S>`/`<Spec>` sections, comments, `{text(...)}`
// ---------------------------------------------------------------------------

/** Inter-attribute whitespace inside a tag (the SPEC 1.4 class, verbatim —
 * never a JS `\s`, which would misclassify U+00A0/U+2028 as whitespace). */
const TAG_WHITESPACE = new Set(["\t", "\n", "\v", "\f", "\r", " "]);

const IMPORT_RE =
  /^import[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]+from[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)');?/;

const EMBED_OPEN_RE = /^\{[ \t]*text[ \t]*\(/;

/**
 * Parse one source file into document-ordered pieces plus the section tree.
 * Pieces cover the whole file:
 *   - { kind: "content", text, owner }  plain bytes, owned by the innermost
 *     enclosing section (or the root);
 *   - { kind: "removal", text }         a construct's own characters — an
 *     import, a section tag with its props, or an MDX comment (SPEC 3);
 *   - { kind: "embed", text, owner, ref, start }  a `{text(...)}` expression.
 * Attribute values are the raw characters between their quotes, and a
 * braced `d` value is scanned quote-aware to its matching brace — exotic
 * bytes never surface as parse errors. Returns { root, sections, imports,
 * pieces, failure } where `failure` is null or { at, message } (an
 * unparseable source, SPEC 14.20 — masking the conditions inside).
 */
function parseMdx(text) {
  const root = {
    isRoot: true,
    id: null,
    dRaw: undefined,
    parent: null,
    children: [],
    openStart: 0,
    openEnd: 0,
    closeStart: text.length,
    closeEnd: text.length,
  };
  const sections = [];
  const imports = [];
  const pieces = [];
  const stack = [root];
  /** @type {{ at: number, message: string } | null} */
  let failure = null;
  let i = 0;
  let contentStart = 0;

  const flushContent = (end) => {
    if (end > contentStart) {
      pieces.push({
        kind: "content",
        text: text.slice(contentStart, end),
        owner: stack[stack.length - 1],
      });
    }
  };
  const result = () => ({ root, sections, imports, pieces, failure });
  const fail20 = (at, message) => {
    failure = { at, message };
  };

  while (i < text.length) {
    const ch = text[i];
    if (
      ch === "i" &&
      (i === 0 || text[i - 1] === "\n" || text[i - 1] === "\r")
    ) {
      // A spec module import (SPEC 2.1) at line start — the MDX ESM position.
      const m = IMPORT_RE.exec(text.slice(i));
      if (m) {
        flushContent(i);
        imports.push({
          binding: m[1],
          specifier: m[2] !== undefined ? m[2] : m[3],
          start: i,
          end: i + m[0].length,
        });
        pieces.push({ kind: "removal", text: m[0] });
        i += m[0].length;
        contentStart = i;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "<") {
      const closeMatch = /^<\/(S|Spec)[ \t\r\n\v\f]*>/.exec(text.slice(i));
      if (closeMatch) {
        const node = stack[stack.length - 1];
        if (node.isRoot) {
          fail20(i, "closing section tag without an open section");
          return result();
        }
        flushContent(i);
        node.closeStart = i;
        node.closeEnd = i + closeMatch[0].length;
        pieces.push({ kind: "removal", text: closeMatch[0] });
        stack.pop();
        i = node.closeEnd;
        contentStart = i;
        continue;
      }
      const openMatch = /^<(S|Spec)(?=[ \t\r\n\v\f/>])/.exec(text.slice(i));
      if (openMatch) {
        flushContent(i);
        const node = {
          isRoot: false,
          id: null,
          dRaw: undefined,
          parent: stack[stack.length - 1],
          children: [],
          openStart: i,
          openEnd: -1,
          closeStart: -1,
          closeEnd: -1,
        };
        let selfClosing = false;
        let j = i + openMatch[0].length;
        for (;;) {
          while (j < text.length && TAG_WHITESPACE.has(text[j])) j += 1;
          if (j >= text.length) {
            fail20(i, "unterminated section tag");
            return result();
          }
          if (text[j] === ">") {
            j += 1;
            break;
          }
          if (text[j] === "/" && text[j + 1] === ">") {
            selfClosing = true;
            j += 2;
            break;
          }
          const attr = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(j));
          if (!attr) {
            fail20(j, "malformed attribute in a section tag");
            return result();
          }
          const name = attr[0];
          j += name.length;
          let quoted;
          let braced;
          if (text[j] === "=") {
            j += 1;
            const open = text[j];
            if (open === '"' || open === "'") {
              const valueStart = j + 1;
              const end = text.indexOf(open, valueStart);
              if (end === -1) {
                fail20(j, "unterminated attribute value");
                return result();
              }
              quoted = text.slice(valueStart, end);
              j = end + 1;
            } else if (open === "{") {
              // Quote-aware brace scan: string literals inside the braced
              // value (e.g. local references in a `d` array) never end it.
              let depth = 0;
              let k = j;
              for (;;) {
                if (k >= text.length) {
                  fail20(j, "unterminated braced attribute value");
                  return result();
                }
                const c = text[k];
                if (c === '"' || c === "'") {
                  const end = text.indexOf(c, k + 1);
                  if (end === -1) {
                    fail20(k, "unterminated string in a braced value");
                    return result();
                  }
                  k = end + 1;
                  continue;
                }
                if (c === "{") depth += 1;
                else if (c === "}") {
                  depth -= 1;
                  if (depth === 0) {
                    k += 1;
                    break;
                  }
                }
                k += 1;
              }
              braced = text.slice(j + 1, k - 1);
              j = k;
            } else {
              fail20(j, "malformed attribute value in a section tag");
              return result();
            }
          }
          // The 2.7 prop set as staged in scope. Values outside it (unknown
          // props, wrong value forms) are out of the fixture's scope and are
          // simply retained without effect.
          if (name === "id" && quoted !== undefined) node.id = quoted;
          else if (name === "d" && braced !== undefined) node.dRaw = braced;
        }
        node.openEnd = j;
        pieces.push({ kind: "removal", text: text.slice(i, j) });
        node.parent.children.push(node);
        sections.push(node);
        if (selfClosing) {
          node.closeStart = j;
          node.closeEnd = j;
        } else {
          stack.push(node);
        }
        i = j;
        contentStart = i;
        continue;
      }
      i += 1; // a plain `<` is ordinary content in this scope
      continue;
    }
    if (ch === "{") {
      if (text.startsWith("{/*", i)) {
        const end = text.indexOf("*/}", i + 3);
        if (end === -1) {
          fail20(i, "unterminated MDX comment");
          return result();
        }
        flushContent(i);
        pieces.push({ kind: "removal", text: text.slice(i, end + 3) });
        i = end + 3;
        contentStart = i;
        continue;
      }
      const embedMatch = EMBED_OPEN_RE.exec(text.slice(i));
      if (embedMatch) {
        let j = i + embedMatch[0].length;
        const skipWs = () => {
          while (j < text.length && TAG_WHITESPACE.has(text[j])) j += 1;
        };
        skipWs();
        let ref;
        const q = text[j];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, j + 1);
          if (end === -1) {
            fail20(j, "unterminated text(...) string argument");
            return result();
          }
          ref = { form: "local", id: text.slice(j + 1, end) };
          j = end + 1;
        } else {
          const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(j));
          if (!ident) {
            fail20(j, "malformed text(...) argument");
            return result();
          }
          const binding = ident[0];
          j += binding.length;
          const segments = [];
          for (;;) {
            if (text[j] === ".") {
              const seg = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(j + 1));
              if (!seg) {
                fail20(j, "malformed property chain in text(...)");
                return result();
              }
              segments.push(seg[0]);
              j += 1 + seg[0].length;
              continue;
            }
            if (text[j] === "[") {
              const qq = text[j + 1];
              if (qq !== '"' && qq !== "'") {
                fail20(j, "malformed computed access in text(...)");
                return result();
              }
              const end = text.indexOf(qq, j + 2);
              if (end === -1 || text[end + 1] !== "]") {
                fail20(j, "malformed computed access in text(...)");
                return result();
              }
              segments.push(text.slice(j + 2, end));
              j = end + 2;
              continue;
            }
            break;
          }
          ref = { form: "external", binding, segments };
        }
        skipWs();
        if (text[j] !== ")") {
          fail20(j, "text(...) takes exactly one argument");
          return result();
        }
        j += 1;
        skipWs();
        if (text[j] !== "}") {
          fail20(j, "unterminated text(...) expression container");
          return result();
        }
        j += 1;
        flushContent(i);
        pieces.push({
          kind: "embed",
          text: text.slice(i, j),
          owner: stack[stack.length - 1],
          ref,
          start: i,
          target: null,
        });
        i = j;
        contentStart = i;
        continue;
      }
      i += 1; // a stray `{` is ordinary content in this scope
      continue;
    }
    i += 1;
  }
  flushContent(text.length);
  if (stack.length !== 1) {
    fail20(Math.max(0, text.length - 1), "unclosed section tag");
  }
  return result();
}

// ---------------------------------------------------------------------------
// `d` reference parsing (SPEC 2.2, 2.4 — resolution-only in this scope)
// ---------------------------------------------------------------------------

/**
 * Parse a braced `d` value's body: a single static reference or an array
 * literal of references, each a string literal (local form) or a property
 * chain rooted at an import binding (external form). Returns the reference
 * list, or null when malformed (never staged in scope).
 */
function parseDReferences(body) {
  let j = 0;
  const skipWs = () => {
    while (j < body.length && TAG_WHITESPACE.has(body[j])) j += 1;
  };
  const parseOne = () => {
    const q = body[j];
    if (q === '"' || q === "'") {
      const end = body.indexOf(q, j + 1);
      if (end === -1) return null;
      const id = body.slice(j + 1, end);
      j = end + 1;
      return { form: "local", id };
    }
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(j));
    if (!ident) return null;
    const binding = ident[0];
    j += binding.length;
    const segments = [];
    for (;;) {
      if (body[j] === ".") {
        const seg = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(j + 1));
        if (!seg) return null;
        segments.push(seg[0]);
        j += 1 + seg[0].length;
        continue;
      }
      if (body[j] === "[") {
        const qq = body[j + 1];
        if (qq !== '"' && qq !== "'") return null;
        const end = body.indexOf(qq, j + 2);
        if (end === -1 || body[end + 1] !== "]") return null;
        segments.push(body.slice(j + 2, end));
        j = end + 2;
        continue;
      }
      break;
    }
    return { form: "external", binding, segments };
  };
  const refs = [];
  skipWs();
  if (body[j] === "[") {
    j += 1;
    skipWs();
    if (body[j] === "]") {
      j += 1; // `d={[]}`: no dependencies (SPEC 2.2)
    } else {
      for (;;) {
        const ref = parseOne();
        if (ref === null) return null;
        refs.push(ref);
        skipWs();
        if (body[j] === ",") {
          j += 1;
          skipWs();
          continue;
        }
        if (body[j] === "]") {
          j += 1;
          break;
        }
        return null;
      }
    }
  } else {
    const ref = parseOne();
    if (ref === null) return null;
    refs.push(ref);
  }
  skipWs();
  return j >= body.length ? refs : null;
}

// ---------------------------------------------------------------------------
// Workspace loading: discovery, parse, import/reference resolution
// ---------------------------------------------------------------------------

/** Import specifier → designated source path (SPEC 2.1), or null. */
function resolveImportTarget(fromRel, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  if (!specifier.endsWith(".xspec")) return null;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromRel), specifier),
  );
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined.slice(0, -".xspec".length) + ".mdx";
}

/** Analyze one source file's bytes into a file record. */
function analyzeFile(rel, bytes) {
  const base = {
    rel,
    bytes,
    text: "",
    byteOf: (index) => index,
    root: null,
    sections: [],
    imports: [],
    pieces: [],
    idMap: new Map(),
    bindings: new Map(),
    failure: null,
  };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ...base,
      failure: { at: 0, message: `${rel} is not valid UTF-8 (SPEC 1.6)` },
    };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    return {
      ...base,
      failure: {
        at: 0,
        message: `${rel} begins with a byte-order mark (SPEC 1.6)`,
      },
    };
  }
  const byteOf = byteOffsetMapper(text, bytes.length);
  const parsed = parseMdx(text);
  if (parsed.failure !== null) {
    return { ...base, text, byteOf, failure: parsed.failure };
  }
  const idMap = new Map();
  for (const section of parsed.sections) {
    if (section.id !== null && !idMap.has(section.id)) {
      idMap.set(section.id, section);
    }
  }
  return {
    ...base,
    text,
    byteOf,
    root: parsed.root,
    sections: parsed.sections,
    imports: parsed.imports,
    pieces: parsed.pieces,
    idMap,
  };
}

/** A finding's byte location for a string-index range, clamped. */
function byteRange(record, startIndex, endIndex) {
  const clamp = (index) => Math.max(0, Math.min(index, record.text.length));
  return {
    start: record.byteOf(clamp(startIndex)),
    end: record.byteOf(clamp(endIndex)),
  };
}

/** Resolve one local/external reference to { rel, node }, or null. */
function resolveRef(files, record, ref) {
  if (ref.form === "local") {
    const node = record.idMap.get(ref.id);
    return node === undefined ? null : { rel: record.rel, node };
  }
  const targetRel = record.bindings.get(ref.binding);
  if (targetRel === undefined) return null;
  const target = files.get(targetRel);
  if (target === undefined || target.failure !== null) return null;
  if (ref.segments.length === 0) return { rel: targetRel, node: target.root };
  const node = target.idMap.get(ref.segments.join("."));
  return node === undefined ? null : { rel: targetRel, node };
}

/**
 * Load the workspace: configuration, discovery, every discovered source's
 * analysis, and import/`d`/embedding resolution. Files in byte order of
 * workspace-relative path — deterministic (SPEC 12.0). An unparseable file
 * (14.20) masks the conditions inside itself; references into it resolve to
 * nothing and report as unresolved (SPEC 14).
 */
async function loadWorkspace(cwd, configFlag) {
  const config = await loadConfig(cwd, configFlag);
  const rels = await discoverSources(config.root, config.groups);
  /** @type {Finding[]} */
  const findings = [];
  const files = new Map();
  for (const rel of rels) {
    const bytes = await fsp.readFile(path.join(config.root, ...rel.split("/")));
    files.set(rel, analyzeFile(rel, bytes));
  }
  // Pass 1: per-file conditions and import bindings.
  for (const record of files.values()) {
    if (record.failure !== null) {
      findings.push({
        condition: "14.20",
        message: `unparseable source: ${record.failure.message} (SPEC 14.20)`,
        file: record.rel,
        location: byteRange(record, record.failure.at, record.failure.at + 1),
      });
      continue;
    }
    for (const section of record.sections) {
      if (section.id === null) {
        findings.push({
          condition: "14.1",
          message:
            "missing id: every non-root section must carry an `id` prop (SPEC 1.3)",
          file: record.rel,
          location: byteRange(record, section.openStart, section.openEnd),
        });
      }
    }
    for (const imp of record.imports) {
      const target = resolveImportTarget(record.rel, imp.specifier);
      if (target === null || !files.has(target)) {
        findings.push({
          condition: "14.15",
          message: `invalid import: ${JSON.stringify(imp.specifier)} does not designate a discovered spec source of a configured group (SPEC 2.1)`,
          file: record.rel,
          location: byteRange(record, imp.start, imp.end),
        });
        continue;
      }
      record.bindings.set(imp.binding, target);
    }
  }
  // Pass 2: `text(...)` and `d` reference resolution (targets need every
  // file's idMap, so this runs after pass 1 completes for all files).
  for (const record of files.values()) {
    if (record.failure !== null) continue;
    for (const piece of record.pieces) {
      if (piece.kind !== "embed") continue;
      const resolved = resolveRef(files, record, piece.ref);
      if (resolved === null) {
        findings.push({
          condition: "14.6",
          message: `unknown text target: the text(...) reference does not resolve (SPEC 2.3, 14.6)`,
          file: record.rel,
          location: byteRange(
            record,
            piece.start,
            piece.start + piece.text.length,
          ),
        });
      } else {
        piece.target = resolved;
      }
    }
    for (const section of record.sections) {
      if (section.dRaw === undefined) continue;
      const refs = parseDReferences(section.dRaw);
      const location = byteRange(record, section.openStart, section.openEnd);
      if (refs === null) {
        findings.push({
          condition: "14.8",
          message:
            "invalid argument: the `d` value is not a static reference or an array literal of static references (SPEC 2.2, 2.4)",
          file: record.rel,
          location,
        });
        continue;
      }
      for (const ref of refs) {
        if (resolveRef(files, record, ref) === null) {
          findings.push({
            condition: "14.5",
            message: `unknown dependency: a \`d\` reference does not resolve (SPEC 2.2, 14.5)`,
            file: record.rel,
            location,
          });
        }
      }
    }
  }
  return { config, files, findings };
}

// ---------------------------------------------------------------------------
// Attributed compilation (SPEC 3 + SPEC 1.6): the oracle's line model with
// node ownership on every kept output atom
// ---------------------------------------------------------------------------

/** Whether `owner` is `node` or one of its descendants. */
function ownerWithin(owner, node) {
  for (let n = owner; n !== null; n = n.parent) {
    if (n === node) return true;
  }
  return false;
}

/** The subtree text of `node` over an atom list (SPEC 1.6). */
function textOfSubtreeAtoms(atoms, node) {
  let out = "";
  for (const atom of atoms) {
    if (ownerWithin(atom.owner, node)) out += atom.text;
  }
  return out;
}

/** The own text of `node` over an atom list (SPEC 1.6). */
function textOfOwnAtoms(atoms, node) {
  let out = "";
  for (const atom of atoms) {
    if (atom.owner === node) out += atom.text;
  }
  return out;
}

/** The compiled Markdown output an atom list denotes. */
function atomsText(atoms) {
  let out = "";
  for (const atom of atoms) out += atom.text;
  return out;
}

/**
 * Compile one parsed file to attributed output atoms per SPEC 3 — a port of
 * the harness oracle's line model (helpers/oracles/markdown.ts, S-6-vetted)
 * with ownership tracked per atom. `expansionFor(piece, atoms)` supplies each
 * embedding's expansion (the target's compiled subtree text, fully expanded);
 * it receives the running atom list, whose finalized lines a same-file
 * target's subtree is read from (the target closed on an earlier line, so its
 * atoms are final by the time its embedding compiles).
 *
 * Line model: only terminators in plain content end logical lines;
 * terminators inside a construct's own characters are deleted with the
 * construct (merging the surrounding lines' residues), and terminators inside
 * an expansion are inserted bytes of the logical line the expansion landed
 * on. Drop rule: a logical line that contained non-whitespace in the source —
 * surviving residues and deleted construct characters alike — but is left
 * empty or whitespace-only purely by removals (or by an empty expansion) is
 * dropped with its terminator; a non-empty expansion is not a removal, so a
 * line it contributed to is never dropped.
 */
function compileAttributed(record, expansionFor) {
  const atoms = [];
  let survivors = [];
  let sourceHadNonWhitespace = false;
  let expansionContributed = false;

  const finalizeLine = (terminator, terminatorOwner) => {
    let remaining = "";
    for (const survivor of survivors) remaining += survivor.text;
    const dropped =
      sourceHadNonWhitespace &&
      !expansionContributed &&
      isWhitespaceOnlyForDrop(remaining);
    if (!dropped) {
      for (const survivor of survivors) {
        if (survivor.text !== "") atoms.push(survivor);
      }
      if (terminator !== "") {
        atoms.push({ text: terminator, owner: terminatorOwner });
      }
    }
    survivors = [];
    sourceHadNonWhitespace = false;
    expansionContributed = false;
  };

  const consumeSourceChunk = (chunk, owner) => {
    if (chunk.length === 0) return;
    survivors.push({ text: chunk, owner });
    if (!isWhitespaceOnlyForDrop(chunk)) sourceHadNonWhitespace = true;
  };

  for (const piece of record.pieces) {
    if (piece.kind === "content") {
      const text = piece.text;
      let start = 0;
      let i = 0;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code !== 0x0a && code !== 0x0d) {
          i += 1;
          continue;
        }
        const terminator = terminatorAt(text, i);
        if (terminator === null) {
          i += 1; // not a line terminator under the active line model
          continue;
        }
        consumeSourceChunk(text.slice(start, i), piece.owner);
        finalizeLine(terminator, piece.owner);
        i += terminator.length;
        start = i;
      }
      consumeSourceChunk(text.slice(start), piece.owner);
    } else {
      // The construct's own characters are source characters of the current
      // logical line: their non-whitespace counts for "contained
      // non-whitespace in the source". They are deleted — internal
      // terminators included.
      if (!isWhitespaceOnlyForDrop(piece.text)) sourceHadNonWhitespace = true;
      if (piece.kind === "embed") {
        const expansion = expansionFor(piece, atoms);
        if (expansion.length > 0) {
          survivors.push({ text: expansion, owner: piece.owner });
          expansionContributed = true;
        }
      }
    }
  }
  // The final line may have no terminator (SPEC 3); it is kept or dropped
  // like any other and never gains one.
  finalizeLine("", record.root);
  return atoms;
}

/**
 * Compile every file of the workspace, memoized, resolving expansions
 * bottom-up: a same-file target is closed before its embedding (as staged in
 * scope), so its atoms are final within the running list; a cross-file target
 * compiles its file first. Returns rel → atoms.
 */
function compileWorkspace(ws) {
  const compiled = new Map();
  const inProgress = new Set();
  const compileFile = (rel) => {
    const memo = compiled.get(rel);
    if (memo !== undefined) return memo;
    if (inProgress.has(rel)) {
      throw new FindingsError([
        {
          condition: "14.9",
          message: `cycle: a spec import/embedding cycle reaches ${rel} (SPEC 2.1, 5.3, 14.9)`,
          file: rel,
          location: { start: 0, end: 0 },
        },
      ]);
    }
    inProgress.add(rel);
    const record = ws.files.get(rel);
    const expansionFor = (piece, runningAtoms) => {
      const target = piece.target;
      if (target === null) {
        // Unreachable: build refuses resolution findings before compiling.
        throw new Error(`unresolved embedding compiled in ${rel}`);
      }
      if (target.rel === rel) {
        if (!(target.node.closeEnd <= piece.start)) {
          throw new FindingsError([
            {
              condition: "14.9",
              message:
                "cycle: a text(...) embedding targets a section not closed before it — an enclosing or forward same-file target is outside this fixture's staged scope (SPEC 2.3, 5.3; CERTIFICATIONS.md §CONF-MD)",
              file: rel,
              location: byteRange(
                record,
                piece.start,
                piece.start + piece.text.length,
              ),
            },
          ]);
        }
        return textOfSubtreeAtoms(runningAtoms, target.node);
      }
      return textOfSubtreeAtoms(compileFile(target.rel), target.node);
    };
    const result = compileAttributed(record, expansionFor);
    inProgress.delete(rel);
    compiled.set(rel, result);
    return result;
  };
  for (const rel of ws.files.keys()) compileFile(rel);
  return compiled;
}

// ---------------------------------------------------------------------------
// Commands (SPEC 12.0 conventions; the §CONF-MD surface)
// ---------------------------------------------------------------------------

function findingsDoc(findings) {
  return {
    findings: findings.map((finding) => ({
      condition: finding.condition,
      message: finding.message,
      file: finding.file,
      location: finding.location,
    })),
  };
}

function emitFindings(io, json, findings) {
  if (json) {
    io.stdout(canonicalJson(findingsDoc(findings)) + "\n");
  } else {
    io.stdout(
      findings
        .map(
          (finding) =>
            `${finding.file}: ${finding.condition}: ${finding.message}\n`,
        )
        .join(""),
    );
  }
}

/**
 * Parse flags per command. `flagSpec` maps flag names to "bool" | "value";
 * unknown and repeated flags are usage errors (SPEC 12.0).
 */
function parseArgs(argv, flagSpec, positionalRange) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const kind = flagSpec[arg];
      if (kind === undefined)
        throw new UsageError(`unknown flag ${arg} (SPEC 12.0)`);
      if (Object.hasOwn(flags, arg)) {
        throw new UsageError(
          `repeated flag ${arg}: a flag may be given at most once (SPEC 12.0)`,
        );
      }
      if (kind === "bool") {
        flags[arg] = true;
      } else {
        const value = argv[i + 1];
        if (value === undefined)
          throw new UsageError(`missing value for ${arg} (SPEC 12.0)`);
        flags[arg] = value;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  const [min, max] = positionalRange;
  if (positionals.length < min || positionals.length > max) {
    throw new UsageError(
      `expected ${min === max ? String(min) : `${String(min)}-${String(max)}`} argument(s), got ${String(positionals.length)} (SPEC 12.0)`,
    );
  }
  return { flags, positionals };
}

const READ_FLAGS = { "--json": "bool", "--config": "value" };

/**
 * `xspec build` (SPEC 12.1, scoped): validate, compile, and — exactly when
 * `markdown: { emit: true }` — emit `NAME.md` next to each discovered source
 * (SPEC 7.3, 13.2). With `markdown` absent or `emit: false`, nothing is
 * written. A failing build (findings) writes nothing.
 */
async function commandBuild(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const ws = await loadWorkspace(cwd, flags["--config"]);
  if (ws.findings.length > 0) {
    throw new FindingsError(ws.findings);
  }
  const compiled = compileWorkspace(ws);
  if (ws.config.emit) {
    for (const [rel, atoms] of compiled) {
      const outRel = rel.slice(0, -".mdx".length) + ".md";
      await fsp.writeFile(
        path.join(ws.config.root, ...outRel.split("/")),
        atomsText(atoms),
        "utf8",
      );
    }
  }
  if (flags["--json"]) {
    io.stdout(canonicalJson(findingsDoc([])) + "\n");
  }
  return 0;
}

/**
 * `xspec query node <node>` (SPEC 11, scoped): a single JSON document — with
 * or without `--json` — reporting the node's own and subtree text (SPEC 1.6,
 * the §CONF-MD query surface); identity and source range ride along in the
 * natural SPEC 11 shape. `<node>` is `path#id`, or a bare `path` for a file's
 * root node (SPEC 1.5).
 */
async function commandQuery(io, cwd, argv) {
  const sub = argv[0];
  if (sub !== "node") {
    throw new UsageError(
      `unknown query subcommand ${String(sub)} (SPEC 11, 12.0; this fixture's scope is \`query node\`, CERTIFICATIONS.md §CONF-MD)`,
    );
  }
  const { flags, positionals } = parseArgs(argv.slice(1), READ_FLAGS, [1, 1]);
  const ws = await loadWorkspace(cwd, flags["--config"]);
  if (ws.findings.length > 0) {
    // SPEC 13.3: when the current sources fail build validation, reads report
    // the validation errors and exit 1 without answering.
    throw new FindingsError(ws.findings);
  }
  const compiled = compileWorkspace(ws);
  const identity = positionals[0];
  const hash = identity.indexOf("#");
  const rel = hash === -1 ? identity : identity.slice(0, hash);
  const id = hash === -1 ? null : identity.slice(hash + 1);
  const record = ws.files.get(rel);
  const node =
    record === undefined
      ? undefined
      : id === null
        ? record.root
        : record.idMap.get(id);
  if (record === undefined || node === undefined) {
    throw new UsageError(
      `unknown node identity ${JSON.stringify(identity)} (SPEC 12.0)`,
    );
  }
  const atoms = compiled.get(rel);
  io.stdout(
    canonicalJson({
      identity,
      sourceRange: {
        start: record.byteOf(node.openStart),
        end: record.byteOf(node.closeEnd),
      },
      ownText: textOfOwnAtoms(atoms, node),
      subtreeText: textOfSubtreeAtoms(atoms, node),
    }) + "\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Entry: deviation seam + dispatch
// ---------------------------------------------------------------------------

/**
 * Run one xspec invocation. Returns the exit code (SPEC 12.0 partition).
 * `options` is the seam through which each violator fixture's bin-<name>.mjs
 * entry threads exactly one deviation switch (the conformer's bin.mjs passes
 * none); see the `deviations` doc above for where CERT-12/CERT-13 hook.
 */
export async function runXspec(argv, cwd, options = {}) {
  deviations = options;
  const io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  return await dispatchCommand(io, cwd, argv);
}

/** Dispatch one parsed invocation and map its outcome to SPEC 12.0's codes. */
async function dispatchCommand(io, cwd, argv) {
  const wantsJson = argv.includes("--json");
  try {
    const command = argv[0];
    const rest = argv.slice(1);
    switch (command) {
      case "build":
        return await commandBuild(io, cwd, rest);
      case "query":
        return await commandQuery(io, cwd, rest);
      default:
        throw new UsageError(`unknown command ${String(command)} (SPEC 12.0)`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      // Usage/configuration errors: stderr content, empty stdout (SPEC 12.0).
      io.stderr(`xspec: ${error.message}\n`);
      return 2;
    }
    if (error instanceof FindingsError) {
      emitFindings(io, wantsJson, error.findings);
      return 1;
    }
    // A crash is a fixture bug: exit outside the 12.0 partition so every
    // exit-code assertion fails loudly and the diagnosis carries the stack.
    io.stderr(
      `xspec: internal fixture error: ${error?.stack ?? String(error)}\n`,
    );
    return 70;
  }
}
