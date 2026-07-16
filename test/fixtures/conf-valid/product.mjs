// CONF-VALID conformer fixture (CERTIFICATIONS.md §CONF-VALID; TEST-SPEC 17
// C-1/C-2). A harness-owned executable product implementing §CONF-VALID's
// Scope with the simplest conforming behavior — driven only through the C-2
// executable/workspace binding, never importing product code (the product and
// the harness are distinct programs; this fixture is part of the harness).
//
// Scope implemented (see CERTIFICATIONS.md §CONF-VALID):
// - Workspaces with one configured spec group of one or more `.mdx` sources
//   whose sections carry `id` and `tags` props (multi-file included); no
//   imports, embeddings, `d` props, code groups, `markdown`, `coverage`,
//   `policy`, or git.
// - `build` with the error reporting of SPEC 14 for conditions 14.1–14.4:
//   file, location, condition identity, 14.2's statement of the expected
//   form, exit codes per SPEC 12.0.
// - `query node` / `query nodes` (with `--tag`) reporting identity, tags,
//   and metadataHash — the scoped query surface; source ranges ride along in
//   the natural SPEC 11 row shape.
// - Contracts under certification: SPEC 1.3, SPEC 1.4 with its exact
//   character classes, SPEC 2.6 tag splitting, and the masking rule of
//   SPEC 14.2 (condition 1 masks condition 2 for the immediate children of a
//   section lacking `id`; everything else reports normally).
//
// Key mechanisms:
// - Sources are scanned by a hand-rolled MDX-lite lexer: `<S>`/`<Spec>` tags
//   with quoted `id`/`tags` attribute values taken as their raw characters.
//   Deliberately no stock MDX parser: the 1.4 matrix stages raw control
//   bytes, exotic whitespace, and boundary code points inside attribute
//   values, and those must reach segment/tag validation (14.4) — never
//   surface as parse errors (14.20). That mis-staging hazard is exactly what
//   §CONF-VALID certifies against.
// - Validation (SPEC 1.3/1.4, conditions 14.1–14.4) walks sections in
//   document order. The structural rule compares segment sequences — a child
//   ID's segments are its parent ID's segments plus exactly one more — so an
//   empty segment is a 1.4 violation (14.4), never a structural one:
//   `<S id="">` is one (empty) top-level segment and `a.` → `a..b` nests by
//   exactly one segment per level (T1.4-1's staging).
// - Findings carry the offending construct's own byte range per SPEC 1.7
//   (opening tag through closing tag, byte offsets), so every report lands
//   within its construct's window and never on a sibling construct.
// - `build` writes nothing: the scope observes validation and the query
//   surface only, and every query recomputes from the sources, so reads need
//   no stored graph data.
// - metadataHash: SHA-256 over the node's collapsed, sorted tag set (its
//   `d` set is always empty and its coverage attribute default in this
//   scope, SPEC 5.5) — so 2.6-equivalent spellings hash identically and a
//   `tags` value yielding zero tokens hashes as the omitted prop (T2.6-1,
//   T2.6-2).
//
// Determinism (SPEC 12.0): no wall clock, no randomness, no absolute paths
// in any output; all JSON is serialized with byte-sorted keys.
//
// Deviation seam: runXspec(argv, cwd, options) assigns `options` onto the
// module-level `deviations` switches (all off = this conformer). The
// VIOL-VALID-* violator entries (CERT-09, CERT-10) each add a bin-<name>.mjs
// passing exactly one switch, consumed in the 1.4 validity classification
// below — tag *splitting* (SPEC 2.6) stays on the exact 1.4 whitespace class
// for every fixture (§VIOL-VALID-WIDE deviates validity, not splitting).

import { createHash } from "node:crypto";
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

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
 * Load and validate the configuration; returns the workspace root and the
 * spec groups. The in-scope shape is one spec group of glob strings
 * (CERTIFICATIONS.md §CONF-VALID); `specs` is required (SPEC 7).
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
  return { root: path.dirname(configPath), groups };
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
// SPEC 1.4 character classes and value validity; SPEC 2.6 tag splitting
// ---------------------------------------------------------------------------

/**
 * SPEC 1.4's whitespace class for *validity*, exactly: U+0009–U+000D and
 * U+0020; no other code point (U+00A0, U+0085, U+2028 included) belongs to
 * it. The VIOL-VALID-WIDE deviation switch (CERT-10) hooks here — validity
 * classification only, never `splitTags` below.
 */
function isValidityWhitespace(codePoint) {
  return (codePoint >= 0x0009 && codePoint <= 0x000d) || codePoint === 0x0020;
}

/**
 * SPEC 1.4's control-character class, exactly: U+0000–U+001F and U+007F. The
 * VIOL-VALID-CTRL deviation switch (CERT-09) hooks into the *enforcement* of
 * this class in `valueViolation` (non-whitespace members only).
 */
function isValidityControl(codePoint) {
  return codePoint <= 0x001f || codePoint === 0x007f;
}

/** The forbidden segment names of SPEC 1.4, all five (exact strings). */
const FORBIDDEN_NAMES = new Set([
  "$",
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

function codePointName(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * SPEC 1.4 validity of one segment or tag value: the reason it is invalid,
 * or null when valid. The two roles differ in exactly one rule: a tag MAY
 * contain `.`.
 *
 * @param {string} value
 * @param {"segment" | "tag"} role
 * @returns {string | null}
 */
function valueViolation(value, role) {
  if (value.length === 0) {
    return `the ${role} is empty (SPEC 1.4: segments are non-empty)`;
  }
  if (FORBIDDEN_NAMES.has(value)) {
    return `the ${role} is the forbidden name ${JSON.stringify(value)} (SPEC 1.4)`;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === "." && role === "segment") {
      return 'the segment contains "." (SPEC 1.4)';
    }
    if (character === "#") {
      return `the ${role} contains "#" (SPEC 1.4)`;
    }
    if (isValidityWhitespace(codePoint)) {
      return `the ${role} contains the whitespace character ${codePointName(codePoint)} (SPEC 1.4)`;
    }
    if (isValidityControl(codePoint)) {
      return `the ${role} contains the control character ${codePointName(codePoint)} (SPEC 1.4)`;
    }
  }
  return null;
}

/**
 * SPEC 2.6 tag splitting: tags are split on runs of 1.4 whitespace, and
 * leading/trailing whitespace is ignored — so no token is ever empty or
 * contains whitespace. Deliberately on the literal 1.4 whitespace class (not
 * `isValidityWhitespace`): §VIOL-VALID-WIDE deviates validity classification
 * only, and tag splitting stays unchanged in every fixture.
 */
function splitTags(value) {
  const tokens = [];
  let current = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const isSplitter =
      (codePoint >= 0x0009 && codePoint <= 0x000d) || codePoint === 0x0020;
    if (isSplitter) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** The collapsed, sorted tag set of a `tags` value (SPEC 2.6). */
function collapsedTags(tagsRaw) {
  if (tagsRaw === undefined) return [];
  return [...new Set(splitTags(tagsRaw))].sort();
}

// ---------------------------------------------------------------------------
// Byte offsets (SPEC 1.7: ranges and locations are byte offsets)
// ---------------------------------------------------------------------------

/**
 * Map string (code-unit) indices to UTF-8 byte offsets. ASCII sources take
 * the identity fast path; the general path handles multi-byte content
 * (T1.4-2's boundary code points, P-1's generated values).
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
// MDX-lite parsing: `<S>`/`<Spec>` sections with quoted `id`/`tags` values
// ---------------------------------------------------------------------------

/** Inter-attribute whitespace inside a tag (the SPEC 1.4 class). */
const TAG_WHITESPACE = new Set(["\t", "\n", "\v", "\f", "\r", " "]);

/**
 * Parse one source file into a section tree with exact string-index ranges.
 * Attribute values are the raw characters between their quotes — control
 * bytes, line terminators, and boundary code points included — so 1.4
 * validity, never parseability, is what their content decides. Returns
 * { root, sections, failure } where `failure` is null or { at, message }
 * (an unparseable source, SPEC 14.20 — masking the conditions inside).
 */
function parseMdx(text) {
  const root = {
    isRoot: true,
    id: null,
    tagsRaw: undefined,
    parent: null,
    children: [],
    openStart: 0,
    openEnd: 0,
    closeStart: text.length,
    closeEnd: text.length,
  };
  const sections = [];
  const stack = [root];
  let i = 0;
  /** @type {{ at: number, message: string } | null} */
  let failure = null;
  const fail20 = (at, message) => {
    failure = { at, message };
  };
  while (i < text.length) {
    if (text[i] !== "<") {
      i += 1;
      continue;
    }
    const close = /^<\/(S|Spec)\s*>/.exec(text.slice(i));
    if (close) {
      const node = stack.at(-1);
      if (node === root) {
        fail20(i, "closing tag without an open section");
        return { root, sections, failure };
      }
      node.closeStart = i;
      node.closeEnd = i + close[0].length;
      stack.pop();
      i = node.closeEnd;
      continue;
    }
    const open = /^<(S|Spec)(?=[\s/>])/.exec(text.slice(i));
    if (!open) {
      i += 1;
      continue;
    }
    const node = {
      isRoot: false,
      id: null,
      tagsRaw: undefined,
      parent: stack.at(-1),
      children: [],
      openStart: i,
      openEnd: -1,
      closeStart: -1,
      closeEnd: -1,
      selfClosing: false,
    };
    let j = i + open[0].length;
    for (;;) {
      while (j < text.length && TAG_WHITESPACE.has(text[j])) j += 1;
      if (j >= text.length) {
        fail20(i, "unterminated section tag");
        return { root, sections, failure };
      }
      if (text[j] === ">") {
        j += 1;
        break;
      }
      if (text[j] === "/" && text[j + 1] === ">") {
        node.selfClosing = true;
        j += 2;
        break;
      }
      const attr = /^[A-Za-z][\w-]*/.exec(text.slice(j));
      if (!attr) {
        fail20(j, "malformed attribute in a section tag");
        return { root, sections, failure };
      }
      const name = attr[0];
      j += name.length;
      let value;
      if (text[j] === "=") {
        j += 1;
        const quote = text[j];
        if (quote !== '"' && quote !== "'") {
          fail20(j, "section props in this scope are quoted string literals");
          return { root, sections, failure };
        }
        const valueStart = j + 1;
        const end = text.indexOf(quote, valueStart);
        if (end === -1) {
          fail20(j, "unterminated attribute value");
          return { root, sections, failure };
        }
        value = text.slice(valueStart, end);
        j = end + 1;
      }
      if (name === "id" && value !== undefined) {
        node.id = value;
      } else if (name === "tags" && value !== undefined) {
        node.tagsRaw = value;
      }
    }
    node.openEnd = j;
    if (node.selfClosing) {
      node.closeStart = node.openEnd;
      node.closeEnd = node.openEnd;
      node.parent.children.push(node);
      sections.push(node);
      i = j;
      continue;
    }
    node.parent.children.push(node);
    sections.push(node);
    stack.push(node);
    i = j;
  }
  if (stack.length !== 1) {
    fail20(Math.max(0, text.length - 1), "unclosed section tag");
  }
  return { root, sections, failure };
}

// ---------------------------------------------------------------------------
// Validation (SPEC 1.3, 1.4, 2.6; conditions 14.1–14.4 with 14.2's masking)
// ---------------------------------------------------------------------------

/** Segments of a declared ID: `.` is structural (SPEC 1.3). */
function segmentsOf(id) {
  return id.split(".");
}

/**
 * Validate one parsed file's sections in document order. Every finding
 * carries the offending construct's own byte range (SPEC 14: file, location,
 * condition identity; SPEC 1.7 byte offsets), so it falls within that
 * construct's window and never on a sibling.
 *
 * @returns {Finding[]}
 */
function validateSections(rel, sections, byteOf) {
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();
  for (const node of sections) {
    const location = {
      start: byteOf(node.openStart),
      end: byteOf(node.closeEnd),
    };
    if (node.id === null) {
      // Condition 14.1 (SPEC 1.3): a non-root section without `id`. Its own
      // structural and segment checks need an ID and cannot run; its
      // immediate children's structural checks are masked below (SPEC 14.2).
      findings.push({
        condition: "14.1",
        message:
          "missing id: every non-root section must carry an `id` prop (SPEC 1.3)",
        file: rel,
        location,
      });
    } else {
      const segments = segmentsOf(node.id);
      // Condition 14.4 (SPEC 1.4), one finding per invalid segment.
      for (const segment of segments) {
        const violation = valueViolation(segment, "segment");
        if (violation !== null) {
          findings.push({
            condition: "14.4",
            message: `invalid segment ${JSON.stringify(segment)} in id ${JSON.stringify(node.id)}: ${violation}`,
            file: rel,
            location,
          });
        }
      }
      // Condition 14.2 (SPEC 1.3): the child ID equals the parent ID plus
      // exactly one segment, compared as segment sequences (an empty segment
      // is a 1.4 matter, not a structural one). A top-level section is
      // checked against the empty prefix: exactly one segment. Masking
      // (SPEC 14.2): for the immediate children of a section lacking `id`,
      // condition 1 masks this condition — their other conditions, and this
      // condition for their own children, report normally.
      const parent = node.parent;
      if (parent.isRoot || parent.id !== null) {
        const parentSegments = parent.isRoot ? [] : segmentsOf(parent.id);
        const structural =
          segments.length === parentSegments.length + 1 &&
          parentSegments.every((segment, index) => segments[index] === segment);
        if (!structural) {
          findings.push({
            condition: "14.2",
            message: parent.isRoot
              ? `invalid structural id ${JSON.stringify(node.id)}: a top-level section's id ` +
                `is exactly one segment — checked against the empty prefix (SPEC 1.3)`
              : `invalid structural id ${JSON.stringify(node.id)}: a child id equals its ` +
                `parent's id plus "." plus exactly one segment — expected the form ` +
                `"${parent.id}.<segment>" (SPEC 1.3)`,
            file: rel,
            location,
          });
        }
      }
      // Condition 14.3 (SPEC 1.3): IDs unique within a source file; reported
      // at each repeated occurrence.
      if (seen.has(node.id)) {
        findings.push({
          condition: "14.3",
          message: `duplicate id ${JSON.stringify(node.id)}: ids are unique within a source file (SPEC 1.3)`,
          file: rel,
          location,
        });
      } else {
        seen.add(node.id);
      }
    }
    // Condition 14.4 for tags (SPEC 1.4, 2.6): every token of the 2.6 split
    // follows the segment rules with `.` allowed. Zero tokens behave as an
    // omitted prop and validate nothing.
    if (node.tagsRaw !== undefined) {
      for (const token of splitTags(node.tagsRaw)) {
        const violation = valueViolation(token, "tag");
        if (violation !== null) {
          findings.push({
            condition: "14.4",
            message: `invalid tag ${JSON.stringify(token)}: ${violation} (SPEC 2.6)`,
            file: rel,
            location,
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Workspace model: nodes with identity, sourceRange, tags, metadataHash
// ---------------------------------------------------------------------------

/**
 * metadataHash (SPEC 5.5, scoped): a deterministic digest of the node's
 * collapsed, sorted tag set — its `d` set is always empty and its coverage
 * attribute default in this scope — so 2.6-equivalent `tags` spellings hash
 * identically and zero-token values hash as the omitted prop.
 */
function metadataHashOf(tags) {
  return sha256Hex(`metadata:${canonicalJson(tags)}`);
}

/**
 * Analyze one source file: findings (14.20 masks the file's insides), plus
 * the file's nodes — root first, then sections in document order — when it
 * parsed.
 */
function analyzeFile(rel, bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      findings: [
        {
          condition: "14.20",
          message: `unparseable source: ${rel} is not valid UTF-8 (SPEC 1.6, 14.20)`,
          file: rel,
          location: { start: 0, end: Math.min(1, bytes.length) },
        },
      ],
      nodes: [],
    };
  }
  if (text.startsWith("\uFEFF")) {
    return {
      findings: [
        {
          condition: "14.20",
          message: `unparseable source: ${rel} begins with a byte-order mark (SPEC 1.6, 14.20)`,
          file: rel,
          location: { start: 0, end: 3 },
        },
      ],
      nodes: [],
    };
  }
  const byteOf = byteOffsetMapper(text, bytes.length);
  const parsed = parseMdx(text);
  if (parsed.failure !== null) {
    // An unparseable file masks the conditions inside itself (SPEC 14).
    const at = byteOf(Math.min(parsed.failure.at, text.length));
    return {
      findings: [
        {
          condition: "14.20",
          message: `unparseable source: ${parsed.failure.message} (SPEC 14.20)`,
          file: rel,
          location: { start: at, end: Math.min(at + 1, bytes.length) },
        },
      ],
      nodes: [],
    };
  }
  const findings = validateSections(rel, parsed.sections, byteOf);
  const nodes = [];
  const rootTags = collapsedTags(undefined);
  nodes.push({
    identity: rel,
    isRoot: true,
    sourceRange: { start: 0, end: bytes.length },
    tags: rootTags,
    metadataHash: metadataHashOf(rootTags),
  });
  for (const section of parsed.sections) {
    if (section.id === null) continue; // only reachable alongside findings
    const tags = collapsedTags(section.tagsRaw);
    nodes.push({
      identity: `${rel}#${section.id}`,
      isRoot: false,
      sourceRange: {
        start: byteOf(section.openStart),
        end: byteOf(section.closeEnd),
      },
      tags,
      metadataHash: metadataHashOf(tags),
    });
  }
  return { findings, nodes };
}

/**
 * Load the workspace: configuration, discovery, and every discovered
 * source's analysis. Files in byte order of workspace-relative path, nodes
 * within a file in document order (root first) — deterministic (SPEC 12.0).
 */
async function loadWorkspace(cwd, configFlag) {
  const config = await loadConfig(cwd, configFlag);
  const rels = await discoverSources(config.root, config.groups);
  /** @type {Finding[]} */
  const findings = [];
  const nodes = [];
  for (const rel of rels) {
    const bytes = await fsp.readFile(path.join(config.root, rel));
    const analyzed = analyzeFile(rel, bytes);
    findings.push(...analyzed.findings);
    nodes.push(...analyzed.nodes);
  }
  return { config, findings, nodes };
}

// ---------------------------------------------------------------------------
// Commands (SPEC 12.0 conventions; the §CONF-VALID surface)
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

/** `xspec build` (SPEC 12.1, scoped): validate; write nothing. */
async function commandBuild(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const workspace = await loadWorkspace(cwd, flags["--config"]);
  if (workspace.findings.length > 0) {
    throw new FindingsError(workspace.findings);
  }
  if (flags["--json"]) {
    io.stdout(canonicalJson(findingsDoc([])) + "\n");
  }
  return 0;
}

/** The scoped query-surface document for one node. */
function nodeDoc(node) {
  const doc = {
    identity: node.identity,
    sourceRange: node.sourceRange,
    tags: node.tags,
    hashes: { metadataHash: node.metadataHash },
  };
  if (!node.isRoot) doc.coverage = "required";
  return doc;
}

/** One `query nodes` row (SPEC 11: coverage attribute absent for roots). */
function nodeRow(node) {
  const row = {
    identity: node.identity,
    sourceRange: node.sourceRange,
    tags: node.tags,
  };
  if (!node.isRoot) row.coverage = "required";
  return row;
}

/**
 * `xspec query` (SPEC 11, scoped to `node` and `nodes`): a single JSON
 * document is the only output form, with or without `--json`.
 */
async function commandQuery(io, cwd, argv) {
  const sub = argv[0];
  if (sub === "node") {
    const { flags, positionals } = parseArgs(argv.slice(1), READ_FLAGS, [1, 1]);
    const workspace = await loadWorkspace(cwd, flags["--config"]);
    if (workspace.findings.length > 0) {
      throw new FindingsError(workspace.findings);
    }
    const identity = positionals[0];
    const node = workspace.nodes.find(
      (candidate) => candidate.identity === identity,
    );
    if (node === undefined) {
      throw new UsageError(
        `unknown node identity ${JSON.stringify(identity)} (SPEC 12.0)`,
      );
    }
    io.stdout(canonicalJson(nodeDoc(node)) + "\n");
    return 0;
  }
  if (sub === "nodes") {
    const { flags } = parseArgs(
      argv.slice(1),
      { ...READ_FLAGS, "--tag": "value" },
      [0, 0],
    );
    const workspace = await loadWorkspace(cwd, flags["--config"]);
    if (workspace.findings.length > 0) {
      throw new FindingsError(workspace.findings);
    }
    const tag = flags["--tag"];
    const rows = workspace.nodes
      .filter((node) => tag === undefined || node.tags.includes(tag))
      .map(nodeRow);
    io.stdout(canonicalJson({ nodes: rows }) + "\n");
    return 0;
  }
  throw new UsageError(
    `unknown query subcommand ${String(sub)} (SPEC 11, 12.0)`,
  );
}

// ---------------------------------------------------------------------------
// Entry: deviation seam + dispatch
// ---------------------------------------------------------------------------

/**
 * Deviation switches (CERTIFICATIONS.md §VIOL-VALID-*), all off in the
 * conformer. Each violator's bin-<name>.mjs threads exactly one switch
 * through runXspec's `options`; the violator CERT tasks (CERT-09 CTRL,
 * CERT-10 WIDE) add their switches and consumption when they land.
 */
let deviations = {};

/**
 * Run one xspec invocation. Returns the exit code (SPEC 12.0 partition).
 * `options` is the seam through which each violator fixture's bin-<name>.mjs
 * entry threads exactly one deviation switch (the conformer's bin.mjs passes
 * none).
 */
export async function runXspec(argv, cwd, options = {}) {
  deviations = options;
  void deviations; // consumed by the VIOL-VALID-* switches when they land
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
