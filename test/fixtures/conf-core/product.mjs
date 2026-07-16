// CONF-CORE conformer fixture (CERTIFICATIONS.md §CONF-CORE; TEST-SPEC 17
// C-1/C-2). A harness-owned executable product implementing §CONF-CORE's
// Scope with the simplest conforming behavior — driven only through the C-2
// executable/workspace binding, never importing product code (the product and
// the harness are distinct programs; this fixture is part of the harness).
//
// Scope implemented (see CERTIFICATIONS.md §CONF-CORE):
// - Workspaces with one configured spec group of `.mdx` sources without
//   imports, embeddings, `d` props, or tags; no `code`, `markdown`,
//   `coverage`, or `policy` keys; no git.
// - `build`; the 13.3 read commands per 12.0 (`check` with no findings on
//   valid state, `ids`, `show`, `query`, `coverage` reporting zero profiles,
//   the `review` read subcommands; `impact --base` without git is the exit-2
//   unreadable-baseline case of SPEC 6.3/12.0).
// - `rename` and file-form `move` with journal append (SPEC 6.1, 6.2).
// - `review` with the `audit` strategy (SPEC 10.6) through `create`,
//   `resolve`, `split`, and the read subcommands, including read-time
//   invalidation over the recorded state of SPEC 10.4.
// - SPEC 13.4 durable protection and SPEC 13.5 in full, `--test-hold`
//   included.
//
// Key mechanisms:
// - Exclusivity (SPEC 13.5): a lock file in the OS temp directory keyed by
//   the workspace root's realpath, holding the owner's PID. A second mutating
//   command finds a live owner and fails promptly with a usage error; a dead
//   owner (abnormal termination) is stale and is cleaned, so exclusivity ends
//   with the process. The lock lives outside the workspace, so holding it
//   changes no workspace byte (T13.5-1's byte-identical-while-held compare).
// - `--test-hold` (SPEC 13.5): immediately after acquiring exclusivity and
//   before modifying anything, an empty file is created at the given path
//   with O_EXCL (anything already there — a symbolic link included — fails
//   the command exit 2 without modifying anything); the command proceeds
//   only once that file has been deleted.
// - Atomic visibility (SPEC 13.5): every derived and durable write goes
//   through a temp file in the target's directory renamed over the target,
//   so a concurrent reader observes prior content, complete new content, or
//   absence-before-first-write — never a partial file. Temp names carry
//   `.xspec.` and a leading dot, so they are never discovered (SPEC 7, 13.4).
// - Hashes: SHA-256 over own-content framing and child structure only —
//   never over identities — so journaled renames and moves are hash-pure by
//   construction (SPEC 6.2) and any text edit changes the edited node's
//   subtreeHash (SPEC 5.5's in-scope observable).
// - Journal (SPEC 6.1): one JSON entry per line, appended only by `rename`
//   and `move`; recorded review-node identities are mapped forward through
//   the journal suffix appended since their recording (SPEC 6.3, 10.4), so
//   reads present recorded nodes under current identities.
// - Reads never write (SPEC 10.4, 13.3, 13.4): every read command computes
//   its answer from the sources and stored files in memory and writes
//   nothing — durable files are touched only by their owning commands.
//
// Determinism (SPEC 12.0): no wall clock, no randomness, no absolute paths
// in any output, generated file, or stored data; all JSON is serialized with
// byte-sorted keys (SPEC 13.4).

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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
 * A refused operation (SPEC 12.0 exit 1: refused rename/move, refused
 * review operations). SPEC pins no report content for refusals; the message
 * goes to stdout as the report.
 */
class RefusalError extends Error {}

/**
 * @typedef {{ condition: string, message: string, file?: string,
 *             location?: { start: number, end: number } }} Finding
 */

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys, SPEC 12.0/13.4)
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

/** One canonical serializer for stored and emitted JSON. */
function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Atomic file writes (SPEC 13.5 atomic visibility; 13.4 occupant replacement)
// ---------------------------------------------------------------------------

let tmpCounter = 0;

/**
 * Write via a temp file in the target's directory renamed over the target:
 * the path holds prior state or the complete new content at every moment.
 * The temp name starts with `.` and contains `.xspec.`, so it is never
 * discovered as a source even mid-write (SPEC 7 dot rule, 13.4 exclusion).
 */
async function writeFileAtomic(absPath, data) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = path.join(
    path.dirname(absPath),
    `.xspec.tmp-${String(process.pid)}-${String(tmpCounter++)}`,
  );
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, absPath);
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
 * spec groups. The in-scope shape is one spec group and no other keys
 * (CERTIFICATIONS.md §CONF-CORE); `specs` is required (SPEC 7).
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

function segmentRegex(patternSegment) {
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

function segmentMatches(patternSegment, pathSegment) {
  // Dot rule (SPEC 7): a path segment beginning with `.` is matched only by
  // a pattern segment written with a leading `.`.
  if (pathSegment.startsWith(".") && !patternSegment.startsWith("."))
    return false;
  return segmentRegex(patternSegment).test(pathSegment);
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
    if (!segmentMatches(ps, pathSegments[si])) return false;
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
// MDX-lite parsing (SPEC 1, 2.7-lite): sections, ids, byte ranges
// ---------------------------------------------------------------------------

const WHITESPACE = new Set(["\t", "\n", "\v", "\f", "\r", " "]);
const FORBIDDEN_SEGMENTS = new Set([
  "$",
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

function isWhitespaceOnly(text) {
  for (const ch of text) {
    if (!WHITESPACE.has(ch)) return false;
  }
  return true;
}

function segmentValid(segment) {
  if (segment.length === 0) return false;
  if (FORBIDDEN_SEGMENTS.has(segment)) return false;
  for (const ch of segment) {
    if (ch === "." || ch === "#") return false;
    if (WHITESPACE.has(ch)) return false;
    const code = ch.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Map string (code-unit) indices to UTF-8 byte offsets. In-scope sources are
 * ASCII, where the identity applies; the general path stays correct.
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

/**
 * Parse one source file into a section tree with exact ranges.
 * Returns { root, sections, findings } where each section carries
 * { id, parent, children, openStart, openEnd, closeStart, closeEnd,
 *   idValueStart, idValueEnd } as string indices.
 */
function parseMdx(text, rel) {
  /** @type {Finding[]} */
  const findings = [];
  const root = {
    id: null,
    isRoot: true,
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
  const fail20 = (at, message) => {
    findings.push({
      condition: "14.20",
      message: `unparseable source: ${message}`,
      file: rel,
      location: { start: at, end: at + 1 },
    });
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
        return { root, sections, findings };
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
      id: null,
      parent: stack.at(-1),
      children: [],
      openStart: i,
      openEnd: -1,
      closeStart: -1,
      closeEnd: -1,
      idValueStart: -1,
      idValueEnd: -1,
    };
    let j = i + open[0].length;
    let selfClosing = false;
    for (;;) {
      while (j < text.length && WHITESPACE.has(text[j])) j += 1;
      if (j >= text.length) {
        fail20(i, "unterminated section tag");
        return { root, sections, findings };
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
      const attr = /^[A-Za-z][\w-]*/.exec(text.slice(j));
      if (!attr) {
        fail20(j, "malformed attribute in a section tag");
        return { root, sections, findings };
      }
      const name = attr[0];
      j += name.length;
      let value;
      let valueStart = -1;
      let valueEnd = -1;
      if (text[j] === "=") {
        j += 1;
        const quote = text[j];
        if (quote !== '"' && quote !== "'") {
          fail20(j, "section props in this scope are quoted string literals");
          return { root, sections, findings };
        }
        valueStart = j + 1;
        const end = text.indexOf(quote, valueStart);
        if (end === -1) {
          fail20(j, "unterminated attribute value");
          return { root, sections, findings };
        }
        value = text.slice(valueStart, end);
        valueEnd = end;
        j = end + 1;
      }
      if (name === "id" && value !== undefined) {
        node.id = value;
        node.idValueStart = valueStart;
        node.idValueEnd = valueEnd;
      }
    }
    node.openEnd = j;
    if (selfClosing) {
      node.closeStart = node.openEnd;
      node.closeEnd = node.openEnd;
      node.selfClosing = true;
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
    fail20(text.length - 1, "unclosed section tag");
  }
  return { root, sections, findings };
}

/** Structural, uniqueness, and 1.4 validation (SPEC 1.3, 1.4; 14.1–14.4). */
function validateSections(rel, sections) {
  /** @type {Finding[]} */
  const findings = [];
  const seen = new Set();
  for (const node of sections) {
    const location = { start: node.openStart, end: node.openEnd };
    if (node.id === null || node.id === undefined) {
      findings.push({
        condition: "14.1",
        message:
          "missing id: every non-root section must have an `id` (SPEC 1.3)",
        file: rel,
        location,
      });
      continue;
    }
    const segments = node.id.split(".");
    for (const segment of segments) {
      if (!segmentValid(segment)) {
        findings.push({
          condition: "14.4",
          message: `invalid segment ${JSON.stringify(segment)} in id ${JSON.stringify(node.id)} (SPEC 1.4)`,
          file: rel,
          location,
        });
      }
    }
    // Structural rule (SPEC 1.3). A non-root parent lacking its own id
    // masks this condition for its immediate children (SPEC 14.2).
    const parentIsRoot = node.parent.isRoot === true;
    const parentId = node.parent.id;
    if (parentIsRoot || typeof parentId === "string") {
      const expectedPrefix = parentIsRoot ? "" : `${parentId}.`;
      const structural =
        node.id.startsWith(expectedPrefix) &&
        node.id.length > expectedPrefix.length &&
        !node.id.slice(expectedPrefix.length).includes(".");
      if (!structural) {
        findings.push({
          condition: "14.2",
          message:
            `invalid structural id ${JSON.stringify(node.id)}: expected the parent id ` +
            `${parentIsRoot ? "(top level)" : JSON.stringify(parentId)} plus "." plus exactly one segment (SPEC 1.3)`,
          file: rel,
          location,
        });
      }
    }
    if (seen.has(node.id)) {
      findings.push({
        condition: "14.3",
        message: `duplicate id ${JSON.stringify(node.id)} within ${rel} (SPEC 1.3)`,
        file: rel,
        location,
      });
    }
    seen.add(node.id);
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Text computation (SPEC 3 removal + line-drop; 1.6 own/subtree text)
// ---------------------------------------------------------------------------

/** Lines with terminators per SPEC 3's line model (CRLF, lone LF, lone CR). */
function splitLines(text) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push({ start, contentEnd: i, end });
      start = end;
      i = end;
    } else if (c === "\n") {
      lines.push({ start, contentEnd: i, end: i + 1 });
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (start < text.length) {
    lines.push({ start, contentEnd: text.length, end: text.length });
  }
  return lines;
}

/**
 * Compute the document-order kept text pieces, each attributed to its
 * innermost containing node, applying tag removal and the line-drop rule
 * (SPEC 3). Returns [{ owner, text }] in document order.
 */
function computeTextPieces(text, parsed) {
  const removals = [];
  for (const node of parsed.sections) {
    if (node.selfClosing) {
      removals.push([node.openStart, node.openEnd]);
    } else {
      removals.push([node.openStart, node.openEnd]);
      removals.push([node.closeStart, node.closeEnd]);
    }
  }
  removals.sort((a, b) => a[0] - b[0]);

  const ownerAt = (pos) => {
    let owner = parsed.root;
    for (;;) {
      const child = owner.children.find(
        (candidate) =>
          !candidate.selfClosing &&
          pos >= candidate.openEnd &&
          pos < candidate.closeStart,
      );
      if (!child) return owner;
      owner = child;
    }
  };

  const pieces = [];
  for (const line of splitLines(text)) {
    // Kept intervals of the line's content after exact removal.
    const kept = [];
    let cursor = line.start;
    let hadRemoval = false;
    for (const [rs, re] of removals) {
      if (re <= line.start || rs >= line.contentEnd) continue;
      hadRemoval = true;
      const clippedStart = Math.max(rs, line.start);
      if (clippedStart > cursor) kept.push([cursor, clippedStart]);
      cursor = Math.max(cursor, Math.min(re, line.contentEnd));
    }
    if (cursor < line.contentEnd) kept.push([cursor, line.contentEnd]);
    const remainder = kept.map(([a, b]) => text.slice(a, b)).join("");
    // Line-drop rule (SPEC 3): a line left empty or whitespace-only purely
    // by removals is dropped together with its terminator.
    if (hadRemoval && isWhitespaceOnly(remainder)) continue;
    for (const [a, b] of kept) {
      if (b > a)
        pieces.push({ owner: ownerAt(a), pos: a, text: text.slice(a, b) });
    }
    if (line.end > line.contentEnd) {
      pieces.push({
        owner: ownerAt(line.contentEnd),
        pos: line.contentEnd,
        text: text.slice(line.contentEnd, line.end),
      });
    }
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Graph model: nodes with identities, texts, ranges, hashes; contains edges
// ---------------------------------------------------------------------------

/**
 * Build the file model: nodes (root first, then sections in document order)
 * with identity, sourceRange (bytes), ownText, subtreeText, and hashes.
 */
function buildFileModel(rel, text, byteLength, parsed) {
  const byteOf = byteOffsetMapper(text, byteLength);
  const pieces = computeTextPieces(text, parsed);

  const descendsFrom = (node, ancestor) => {
    for (let n = node; n !== null; n = n.parent ?? null) {
      if (n === ancestor) return true;
    }
    return false;
  };

  const allNodes = [parsed.root, ...parsed.sections];
  const metadataHash = sha256Hex("metadata none");
  for (const node of allNodes) {
    node.identity = node === parsed.root ? rel : `${rel}#${node.id}`;
    node.ownText = pieces
      .filter((piece) => piece.owner === node)
      .map((piece) => piece.text)
      .join("");
    node.subtreeText = pieces
      .filter((piece) => descendsFrom(piece.owner, node))
      .map((piece) => piece.text)
      .join("");
    node.sourceRange =
      node === parsed.root
        ? { start: 0, end: byteLength }
        : { start: byteOf(node.openStart), end: byteOf(node.closeEnd) };
  }
  // Hashes bottom-up: own content framing (length-prefixed runs and child
  // markers interleaved at their document positions, never identities —
  // SPEC 5.4/6.2 purity), then structural subtree/effective hashes.
  const hashNode = (node) => {
    for (const child of node.children) hashNode(child);
    const events = [
      ...pieces
        .filter((piece) => piece.owner === node)
        .map((piece) => ({
          pos: piece.pos,
          frame: `R${String(Buffer.byteLength(piece.text, "utf8"))}:${piece.text}`,
        })),
      ...node.children.map((child) => ({ pos: child.openStart, frame: "C;" })),
    ].sort((a, b) => a.pos - b.pos);
    node.ownHash = sha256Hex(
      `own ${events.map((event) => event.frame).join("")}`,
    );
    node.subtreeHash = sha256Hex(
      `subtree ${node.ownHash}${node.children.map((child) => child.subtreeHash).join("")}`,
    );
    node.effectiveHash = sha256Hex(
      `effective ${node.ownHash}${node.children.map((child) => child.effectiveHash).join("")}`,
    );
    node.metadataHash = metadataHash;
  };
  hashNode(parsed.root);
  return { rel, root: parsed.root, sections: parsed.sections, nodes: allNodes };
}

/**
 * Load the workspace graph: discover, parse, validate. Throws FindingsError
 * (exit 1) when validation fails — reads report the errors and answer
 * nothing (SPEC 13.3), build/check report them (SPEC 12.1, 12.2).
 */
async function loadGraph(root, groups) {
  const sourcePaths = await discoverSources(root, groups);
  /** @type {Finding[]} */
  const findings = [];
  const files = [];
  for (const rel of sourcePaths) {
    if (!rel.endsWith(".mdx")) {
      findings.push({
        condition: "14.19",
        message: `invalid source path: spec-group files must have the .mdx extension (SPEC 7.1): ${rel}`,
        file: rel,
      });
      continue;
    }
    if (rel.includes("#")) {
      findings.push({
        condition: "14.19",
        message: `invalid source path: a discovered source path must not contain '#' (SPEC 1.5): ${rel}`,
        file: rel,
      });
      continue;
    }
    const bytes = await fsp.readFile(path.join(root, rel));
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      findings.push({
        condition: "14.20",
        message: `unparseable source: not valid UTF-8 (SPEC 1.6): ${rel}`,
        file: rel,
        location: { start: 0, end: 1 },
      });
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) {
      findings.push({
        condition: "14.20",
        message: `unparseable source: begins with a byte-order mark (SPEC 1.6): ${rel}`,
        file: rel,
        location: { start: 0, end: 3 },
      });
      continue;
    }
    const parsed = parseMdx(text, rel);
    findings.push(...parsed.findings);
    if (parsed.findings.length > 0) continue; // 14.20 masks conditions inside
    findings.push(...validateSections(rel, parsed.sections));
    files.push({ rel, text, bytes, parsed });
  }
  if (findings.length > 0) throw new FindingsError(findings);

  const models = files.map((file) =>
    buildFileModel(file.rel, file.text, file.bytes.length, file.parsed),
  );
  const byIdentity = new Map();
  for (const model of models) {
    for (const node of model.nodes) byIdentity.set(node.identity, node);
  }
  return {
    root,
    files: models,
    byIdentity,
    /** Document index of a node within its file (root = 0). */
    docIndex(node) {
      const model = models.find((candidate) => candidate.nodes.includes(node));
      return model ? model.nodes.indexOf(node) : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Derived files: generated modules + graph data (SPEC 13.1, 13.3, 13.4)
// ---------------------------------------------------------------------------

const GRAPH_DATA_REL = ".xspec/graph.json";

function modulePathFor(rel) {
  return rel.replace(/\.mdx$/, ".xspec.ts");
}

function moduleContent(model) {
  const data = {};
  for (const node of model.nodes) {
    data[node.identity] = { subtreeText: node.subtreeText };
  }
  return (
    `// Generated by xspec from ${model.rel}. DO NOT EDIT.\n` +
    `// CONF-CORE certification fixture module (SPEC 13.1: content beyond\n` +
    `// path, byte-determinism, write discipline, and atomicity is out of\n` +
    `// this fixture's certified scope).\n` +
    `const DATA = ${canonicalJson(data)};\n` +
    `const SPEC: unknown = DATA;\n` +
    `export default SPEC;\n` +
    `export function text(node: unknown): string {\n` +
    `  void node;\n` +
    `  throw new Error("not supported by the CONF-CORE fixture");\n` +
    `}\n`
  );
}

function graphDataContent(graph) {
  const filesData = {};
  for (const model of graph.files) {
    const nodes = {};
    for (const node of model.nodes) {
      nodes[node.identity] = {
        hashes: {
          effectiveHash: node.effectiveHash,
          metadataHash: node.metadataHash,
          ownHash: node.ownHash,
          subtreeHash: node.subtreeHash,
        },
        sourceRange: [node.sourceRange.start, node.sourceRange.end],
      };
    }
    filesData[model.rel] = {
      ids: model.sections.map((section) => section.id),
      nodes,
    };
  }
  const derived = graph.files.map((model) => modulePathFor(model.rel)).sort();
  return canonicalJson({ derived, files: filesData }) + "\n";
}

async function readRecordedDerived(root) {
  try {
    const parsed = JSON.parse(
      await fsp.readFile(path.join(root, GRAPH_DATA_REL), "utf8"),
    );
    if (Array.isArray(parsed?.derived)) {
      return parsed.derived.filter(
        (entry) =>
          typeof entry === "string" &&
          entry.split("/").at(-1)?.includes(".xspec."),
      );
    }
  } catch {
    // Missing or unreadable graph data reads as no recorded derived paths.
  }
  return [];
}

/**
 * Regenerate every derived file exactly as `build` writes it: modules per
 * source, orphan removal via the recorded derived paths, graph data
 * (SPEC 12.1, 13.3, 13.4). Rename and move finish with this same
 * regeneration (SPEC 6.4, 6.5).
 */
async function regenerate(graph) {
  const recorded = await readRecordedDerived(graph.root);
  const current = new Set(graph.files.map((model) => modulePathFor(model.rel)));
  for (const orphan of recorded) {
    if (!current.has(orphan)) {
      await fsp.rm(path.join(graph.root, orphan), { force: true });
    }
  }
  for (const model of graph.files) {
    await writeFileAtomic(
      path.join(graph.root, modulePathFor(model.rel)),
      moduleContent(model),
    );
  }
  await writeFileAtomic(
    path.join(graph.root, GRAPH_DATA_REL),
    graphDataContent(graph),
  );
}

// ---------------------------------------------------------------------------
// Journal (SPEC 6.1, 6.3): append-only JSON lines; forward identity mapping
// ---------------------------------------------------------------------------

const JOURNAL_REL = ".xspec/journal";

async function readJournal(root) {
  const abs = path.join(root, JOURNAL_REL);
  let stats;
  try {
    stats = await fsp.lstat(abs);
  } catch (error) {
    if (error.code === "ENOENT")
      return { entries: [], lineCount: 0, plain: true, exists: false };
    throw error;
  }
  if (!stats.isFile()) {
    // A journal path occupied by anything other than a plain file is a
    // journal error (SPEC 13.4, 14.13) — never read.
    return { entries: [], lineCount: 0, plain: false, exists: true };
  }
  const text = await fsp.readFile(abs, "utf8");
  const lines = text
    .split("\n")
    .filter((line, index, all) => !(line === "" && index === all.length - 1));
  const entries = lines.map((line) => {
    try {
      const entry = JSON.parse(line);
      if (entry && (entry.kind === "rename" || entry.kind === "move"))
        return entry;
    } catch {
      // Malformed entries surface through `check` (14.13); mapping skips them.
    }
    return null;
  });
  return { entries, lineCount: lines.length, plain: true, exists: true };
}

async function appendJournal(root, entry) {
  const abs = path.join(root, JOURNAL_REL);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.appendFile(abs, canonicalJson(entry) + "\n");
}

/** Map an identity forward through journal entries (SPEC 6.3, 10.4). */
function mapIdentityForward(identity, entries) {
  let current = identity;
  for (const entry of entries) {
    if (entry === null) continue;
    if (entry.kind === "rename") {
      const prefix = `${entry.path}#${entry.from}`;
      if (current === prefix) current = `${entry.path}#${entry.to}`;
      else if (current.startsWith(`${prefix}.`)) {
        current = `${entry.path}#${entry.to}` + current.slice(prefix.length);
      }
    } else if (entry.kind === "move") {
      if (current === entry.from) current = entry.to;
      else if (current.startsWith(`${entry.from}#`))
        current = entry.to + current.slice(entry.from.length);
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Workspace exclusivity (SPEC 13.5): live-PID lock, dies with the process
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Acquire workspace exclusivity. The lock file lives in the OS temp
 * directory keyed by the workspace root's realpath: workspace-scoped (H-1
 * isolation across workspaces), outside the workspace bytes, and released
 * by unlink on completion — or by death detection when the holder was
 * killed (SPEC 13.5: exclusivity ends when the process terminates).
 */
async function acquireExclusivity(root) {
  const real = await fsp.realpath(root);
  const lockPath = path.join(
    os.tmpdir(),
    `xspec-conf-core-${sha256Hex(real).slice(0, 32)}.lock`,
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return {
        release: async () => {
          await fsp.rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (deviations.staleLockBlocks) {
        // VIOL-CORE-STALELOCK (CERTIFICATIONS.md): workspace exclusivity is
        // not released by abnormal termination — an existing lock file
        // refuses the command outright, with no holder-liveness detection
        // and no stale-lock cleanup, so after a mutating command's process
        // is killed every later mutating command in that workspace is
        // refused with the usage error of 13.5/12.0. Normal completion
        // still releases (the completing command unlinks the lock file in
        // release(), unchanged), so only a killed holder leaves this
        // refusing state behind; everything else is exactly the conformer's
        // behavior.
        throw new UsageError(
          "another mutating command is running in this workspace (SPEC 13.5, 12.0)",
        );
      }
      let holder = Number.NaN;
      try {
        holder = Number.parseInt(await fsp.readFile(lockPath, "utf8"), 10);
      } catch {
        // Unreadable lock: treat as stale below.
      }
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        throw new UsageError(
          "another mutating command is running in this workspace (SPEC 13.5, 12.0)",
        );
      }
      // A terminated holder never blocks later commands (SPEC 13.5).
      await fsp.rm(lockPath, { force: true });
    }
  }
  throw new UsageError(
    "could not acquire workspace exclusivity (SPEC 13.5, 12.0)",
  );
}

/**
 * `--test-hold` seam (SPEC 13.5): create an empty file at the path —
 * creation fails if anything, a symbolic link included, already exists —
 * then proceed only once that file has been deleted. Runs immediately after
 * acquiring exclusivity and before modifying anything.
 */
async function holdAtSeam(holdPath, cwd) {
  const abs = path.resolve(cwd, holdPath);
  const handle = await fsp.open(abs, "wx"); // O_CREAT|O_EXCL: symlinks fail too
  await handle.close();
  for (;;) {
    try {
      await fsp.lstat(abs);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await sleep(15);
  }
}

// ---------------------------------------------------------------------------
// Review sessions (SPEC 10): storage, audit strategy, invalidation, payloads
// ---------------------------------------------------------------------------

const REVIEWS_REL = ".xspec/reviews";
const SESSION_NAME = /^[A-Za-z0-9._-]+$/;
const STORED_STATUSES = new Set([
  "unresolved",
  "updated",
  "no-change",
  "skipped",
]);
const RESOLVE_STATUSES = new Set(["updated", "no-change", "skipped"]);
const ITEM_KINDS = new Set([
  "subtree-coherence",
  "parent-consistency",
  "dependency-consistency",
  "metadata-consistency",
  "code-impact",
  "uncovered-requirement",
]);

function sessionNameValid(name) {
  return SESSION_NAME.test(name) && !name.startsWith(".");
}

function sessionRel(name) {
  return `${REVIEWS_REL}/${name}.json`;
}

/** List stored session names (files directly under .xspec/reviews). */
async function listSessionNames(root) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, REVIEWS_REL), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -".json".length);
    if (!sessionNameValid(name)) continue; // any other file there is not a session
    names.push(name);
  }
  return names.sort();
}

/**
 * Load a session. Returns { state: "missing" } (unknown session, exit 2),
 * { state: "corrupt" } (SPEC 14.21, exit 1), or { state: "ok", session }.
 */
async function loadSession(root, name) {
  if (!sessionNameValid(name)) return { state: "invalid-name" };
  const abs = path.join(root, sessionRel(name));
  let stats;
  try {
    stats = await fsp.lstat(abs);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if (!stats.isFile()) return { state: "corrupt" }; // not a plain file (13.4)
  let session;
  try {
    session = JSON.parse(await fsp.readFile(abs, "utf8"));
  } catch {
    return { state: "corrupt" };
  }
  if (!sessionInvariantsHold(session, name)) return { state: "corrupt" };
  return { state: "ok", session };
}

function sessionInvariantsHold(session, name) {
  if (session === null || typeof session !== "object" || Array.isArray(session))
    return false;
  if (session.name !== name) return false;
  if (typeof session.strategy !== "string" || session.strategy.length === 0)
    return false;
  if (!Number.isInteger(session.nextId) || session.nextId < 1) return false;
  if (!Array.isArray(session.items) || !Array.isArray(session.decompositions))
    return false;
  const ids = new Set();
  for (const item of session.items) {
    if (item === null || typeof item !== "object") return false;
    if (typeof item.id !== "string" || item.id.length === 0 || ids.has(item.id))
      return false;
    ids.add(item.id);
    if (!ITEM_KINDS.has(item.kind)) return false;
    if (!STORED_STATUSES.has(item.status)) return false;
    if (typeof item.reason !== "string" || item.reason.length === 0)
      return false;
    if (typeof item.scopeRoot !== "string") return false;
    if (!Number.isInteger(item.journalAt) || item.journalAt < 0) return false;
    for (const key of [
      "scopeNodes",
      "contextNodes",
      "originNodes",
      "blockedBy",
    ]) {
      if (
        !Array.isArray(item[key]) ||
        item[key].some((v) => typeof v !== "string")
      )
        return false;
    }
    if (typeof item.baseline !== "object" || typeof item.current !== "object")
      return false;
  }
  for (const item of session.items) {
    if (item.blockedBy.some((id) => !ids.has(id))) return false;
  }
  // blockedBy acyclic (SPEC 10.1): no item transitively blocks itself.
  const byId = new Map(session.items.map((item) => [item.id, item]));
  const marks = new Map();
  const cyclic = (id) => {
    const mark = marks.get(id);
    if (mark === "done") return false;
    if (mark === "visiting") return true;
    marks.set(id, "visiting");
    for (const dep of byId.get(id).blockedBy) {
      if (cyclic(dep)) return true;
    }
    marks.set(id, "done");
    return false;
  };
  for (const item of session.items) {
    if (cyclic(item.id)) return false;
  }
  // At most one item per kind and scope node (SPEC 10.1).
  const kindScope = new Set();
  for (const item of session.items) {
    const key = `${item.kind} ${item.scopeRoot} ${String(item.journalAt)}`;
    if (kindScope.has(key)) return false;
    kindScope.add(key);
  }
  return true;
}

async function writeSession(root, session) {
  await writeFileAtomic(
    path.join(root, sessionRel(session.name)),
    canonicalJson(session) + "\n",
  );
}

/** Relevant hashes per item kind (SPEC 10.4), by node role. */
function relevantHashes(kind, role, node) {
  if (kind === "subtree-coherence") {
    return role === "scope"
      ? { metadataHash: node.metadataHash, subtreeHash: node.subtreeHash }
      : {};
  }
  if (kind === "parent-consistency") {
    if (role === "scope")
      return { metadataHash: node.metadataHash, ownHash: node.ownHash };
    if (role === "context") return { subtreeHash: node.subtreeHash };
  }
  return {};
}

/**
 * Record the relevant state of an item against the current graph (SPEC
 * 10.4): relevant hashes per kind, presence for every scope/context/origin
 * node, plus the text values the payload provenance rule may need later.
 * Keys are the item's recorded spellings; lookups map them forward through
 * the journal suffix appended since the item's recording.
 */
function recordState(item, graph, journalEntries) {
  const suffix = journalEntries.slice(item.journalAt);
  /** @type {Record<string, unknown>} */
  const nodes = {};
  const record = (spelling, role) => {
    const mapped = mapIdentityForward(spelling, suffix);
    const node = graph.byIdentity.get(mapped);
    if (node === undefined) {
      nodes[spelling] = { hashes: "absent", present: false };
      return;
    }
    nodes[spelling] = {
      hashes: relevantHashes(item.kind, role, node),
      present: true,
      text:
        role === "scope" && item.kind !== "subtree-coherence"
          ? node.ownText
          : node.subtreeText,
    };
  };
  for (const spelling of item.scopeNodes) record(spelling, "scope");
  for (const spelling of item.contextNodes) record(spelling, "context");
  for (const spelling of item.originNodes) record(spelling, "origin");
  return { nodes };
}

/**
 * Read-time invalidation (SPEC 10.4): a resolved item is stale when its
 * recorded state differs from the current graph — a recorded hash changed,
 * a node's presence changed in either direction, or the generator-assigned
 * context set changed. Computed on read, never persisted.
 */
function isStale(item, graph, journalEntries) {
  const recorded = item.current?.nodes ?? {};
  const suffix = journalEntries.slice(item.journalAt);
  const role = (spelling) =>
    item.scopeNodes.includes(spelling)
      ? "scope"
      : item.contextNodes.includes(spelling)
        ? "context"
        : "origin";
  for (const [spelling, state] of Object.entries(recorded)) {
    const mapped = mapIdentityForward(spelling, suffix);
    const node = graph.byIdentity.get(mapped);
    const present = node !== undefined;
    if (present !== state.present) return true; // presence changed either way
    if (!present) continue; // absent then and now: no invalidation (10.4)
    const currentHashes = relevantHashes(item.kind, role(spelling), node);
    for (const [hashName, value] of Object.entries(
      state.hashes === "absent" ? {} : state.hashes,
    )) {
      if (currentHashes[hashName] !== value) return true;
    }
  }
  // Context-set comparison against the generator-assigned set (SPEC 10.4).
  const generated = generatorContext(item, graph, suffix);
  if (generated !== null) {
    const recordedSet = new Set(
      item.contextNodes.map((spelling) => mapIdentityForward(spelling, suffix)),
    );
    if (
      generated.length !== recordedSet.size ||
      generated.some((identity) => !recordedSet.has(identity))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The context set the audit generator (with recorded decompositions)
 * assigns to this item against the current workspace, or null when the
 * generators no longer produce it (the item then retains its recorded set).
 */
function generatorContext(item, graph, journalSuffix) {
  const mappedScope = mapIdentityForward(item.scopeRoot, journalSuffix);
  const node = graph.byIdentity.get(mappedScope);
  if (node === undefined) return null;
  if (item.kind === "subtree-coherence") {
    return ancestorChain(node).map((ancestor) => ancestor.identity);
  }
  if (item.kind === "parent-consistency") {
    return node.children.map((child) => child.identity);
  }
  return null;
}

/** Proper ancestors, nearest first, ending at the file root (SPEC 10.6). */
function ancestorChain(node) {
  const chain = [];
  for (let n = node.parent ?? null; n !== null; n = n.parent ?? null) {
    chain.push(n);
  }
  return chain;
}

/** Effective status on read: stored status with invalidation applied. */
function effectiveStatus(item, graph, journalEntries) {
  if (
    RESOLVE_STATUSES.has(item.status) &&
    isStale(item, graph, journalEntries)
  ) {
    return "invalidated";
  }
  return item.status;
}

/** Whether the item is blocked (SPEC 10.3): any blocker not resolved. */
function isBlocked(item, session, graph, journalEntries) {
  const byId = new Map(
    session.items.map((candidate) => [candidate.id, candidate]),
  );
  return item.blockedBy.some((id) => {
    const blocker = byId.get(id);
    return (
      blocker === undefined ||
      !RESOLVE_STATUSES.has(effectiveStatus(blocker, graph, journalEntries))
    );
  });
}

/**
 * Item order for reads (SPEC 10.6 audit order with 10.5's absent-node rule):
 * scope-node file path (byte order), then document order within the file;
 * present scope nodes first, absent ones after, by identity then item id.
 */
function orderedItems(session, graph, journalEntries) {
  const keyed = session.items.map((item) => {
    const mapped = mapIdentityForward(
      item.scopeRoot,
      journalEntries.slice(item.journalAt),
    );
    const node = graph.byIdentity.get(mapped);
    const file = mapped.includes("#")
      ? mapped.slice(0, mapped.indexOf("#"))
      : mapped;
    return {
      item,
      mappedScope: mapped,
      key: [
        file,
        node === undefined ? 1 : 0,
        node === undefined
          ? mapped
          : String(graph.docIndex(node)).padStart(9, "0"),
        item.kind === "subtree-coherence" ? 0 : 1,
        item.id,
      ],
    };
  });
  keyed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      const av = a.key[i];
      const bv = b.key[i];
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
  return keyed;
}

/** Present a recorded node in a payload (SPEC 10.7): NodeState shape. */
function nodeState(item, spelling, role, graph, journalEntries) {
  const mapped = mapIdentityForward(
    spelling,
    journalEntries.slice(item.journalAt),
  );
  const node = graph.byIdentity.get(mapped);
  if (node === undefined) {
    const recordedText =
      item.current?.nodes?.[spelling]?.text ??
      item.baseline?.nodes?.[spelling]?.text;
    const state = { node: mapped, present: false };
    if (typeof recordedText === "string") state.text = recordedText;
    return state;
  }
  // Text per SPEC 10.7: scope text is subtree text for subtree-coherence and
  // own text for parent-consistency; context text is own text for ancestor
  // chains (subtree-coherence) and subtree text otherwise.
  const text =
    item.kind === "subtree-coherence"
      ? role === "scope"
        ? node.subtreeText
        : node.ownText
      : role === "scope"
        ? node.ownText
        : node.subtreeText;
  return {
    node: mapped,
    present: true,
    sourceRange: { end: node.sourceRange.end, start: node.sourceRange.start },
    text,
  };
}

/** The full item payload of `next --json`, `show`, and `export` (SPEC 10.7). */
function itemPayload(item, session, graph, journalEntries) {
  const payload = {
    baseline: item.baseline,
    blocked: isBlocked(item, session, graph, journalEntries),
    blockedBy: [...item.blockedBy],
    context: item.contextNodes.map((spelling) =>
      nodeState(item, spelling, "context", graph, journalEntries),
    ),
    current: item.current,
    id: item.id,
    kind: item.kind,
    origin: [],
    reason: item.reason,
    scope: nodeState(item, item.scopeRoot, "scope", graph, journalEntries),
    status: effectiveStatus(item, graph, journalEntries),
  };
  if (typeof item.note === "string") payload.note = item.note;
  return payload;
}

/** Audit generation (SPEC 10.6): one subtree-coherence item per node. */
function auditGenerate(graph) {
  const generated = [];
  for (const model of graph.files) {
    for (const node of model.nodes) {
      generated.push({
        kind: "subtree-coherence",
        scopeRoot: node.identity,
        scopeNodes: [node.identity, ...descendantIdentities(node)],
        contextNodes: ancestorChain(node).map((ancestor) => ancestor.identity),
        childIdentities: node.children.map((child) => child.identity),
        reason: `audit: review the subtree rooted at ${node.identity} (SPEC 10.6)`,
      });
    }
  }
  return generated;
}

function descendantIdentities(node) {
  const identities = [];
  for (const child of node.children) {
    identities.push(child.identity, ...descendantIdentities(child));
  }
  return identities;
}

// ---------------------------------------------------------------------------
// Output helpers (SPEC 12.0 streams)
// ---------------------------------------------------------------------------

function emitDoc(io, json, doc, humanLines) {
  if (json) {
    io.stdout(canonicalJson(doc) + "\n");
  } else {
    io.stdout(humanLines.map((line) => `${line}\n`).join(""));
  }
}

/** JSON-only commands (SPEC 11 `query`, 10.7 `export`). */
function emitJsonOnly(io, doc) {
  io.stdout(canonicalJson(doc) + "\n");
}

function findingsDoc(findings) {
  return {
    findings: findings.map((finding) => {
      const entry = { condition: finding.condition, message: finding.message };
      if (finding.file !== undefined) entry.file = finding.file;
      if (finding.location !== undefined) {
        entry.location = {
          end: finding.location.end,
          start: finding.location.start,
        };
      }
      return entry;
    }),
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
            `${finding.file ?? "workspace"}: ${finding.condition}: ${finding.message}\n`,
        )
        .join(""),
    );
  }
}

// ---------------------------------------------------------------------------
// Argument parsing (SPEC 12.0 flag rules)
// ---------------------------------------------------------------------------

/**
 * Parse flags per command. `flagSpec` maps flag names to "bool" | "value";
 * unknown flags, repeated flags, and missing values are usage errors.
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
const MUTATING_FLAGS = { ...READ_FLAGS, "--test-hold": "value" };

// ---------------------------------------------------------------------------
// Mutating-command scaffold: exclusivity, hold seam, operation, release
// ---------------------------------------------------------------------------

/**
 * Run one mutating command (SPEC 13.5): acquire exclusivity, honor the
 * `--test-hold` seam before modifying anything, perform the operation, and
 * release. The lock is released on every path; a killed process releases by
 * dying (the next command detects the dead holder).
 */
async function runMutating(cwd, configFlag, holdFlag, operate) {
  const config = await loadConfig(cwd, configFlag);
  // VIOL-CORE-NOLOCK (CERTIFICATIONS.md): mutating commands do not exclude
  // one another — exclusivity is neither acquired nor checked, so a second
  // mutating command started while another runs or is held proceeds normally
  // instead of failing with the usage error of 13.5/12.0. Everything else,
  // the hold file created below before any modification and honored
  // included, is exactly the conformer's behavior.
  const lock = deviations.noMutualExclusion
    ? { release: async () => {} }
    : await acquireExclusivity(config.root);
  const holdIfRequested = async () => {
    if (holdFlag === undefined) return;
    try {
      await holdAtSeam(holdFlag, cwd);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(
        `cannot create the hold file: ${error.message} (SPEC 13.5, 12.0)`,
      );
    }
  };
  try {
    if (deviations.writesBeforeHold) {
      // VIOL-CORE-EARLYWRITE (CERTIFICATIONS.md): the mutating command
      // performs its workspace modifications before creating the hold file —
      // it acquires exclusivity (above, unchanged), completes the operation's
      // writes (journal append included), then creates the hold file, waits
      // for its deletion, and exits normally with the operation's outcome.
      // The hold seam's own semantics (empty file, occupied path fails
      // exit 2) and everything else are exactly the conformer's behavior.
      const code = await operate(config);
      await holdIfRequested();
      return code;
    }
    await holdIfRequested();
    return await operate(config);
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandBuild(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  await regenerate(graph);
  emitDoc(io, flags["--json"] === true, { ok: true }, ["build: ok"]);
  return 0;
}

async function commandCheck(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  /** @type {Finding[]} */
  const findings = [];
  // 14.10: derived files content-identical to what the current sources
  // generate; no recorded derived file at a no-longer-generated path.
  const expected = new Map(
    graph.files.map((model) => [
      modulePathFor(model.rel),
      moduleContent(model),
    ]),
  );
  expected.set(GRAPH_DATA_REL, graphDataContent(graph));
  for (const [rel, content] of expected) {
    let actual = null;
    try {
      actual = await fsp.readFile(path.join(graph.root, rel), "utf8");
    } catch {
      actual = null;
    }
    if (actual !== content) {
      findings.push({
        condition: "14.10",
        message: `stale generated output: ${rel} does not match what the current sources generate; run \`xspec build\``,
        file: rel,
      });
    }
  }
  for (const orphan of await readRecordedDerived(graph.root)) {
    if (
      !expected.has(orphan) &&
      (await pathOccupied(path.join(graph.root, orphan)))
    ) {
      findings.push({
        condition: "14.10",
        message: `stale generated output: recorded derived file ${orphan} is no longer generated; run \`xspec build\``,
        file: orphan,
      });
    }
  }
  // 14.13: journal well-formed and replayable.
  const journal = await readJournal(config.root);
  if (!journal.plain) {
    findings.push({
      condition: "14.13",
      message: `journal error: ${JOURNAL_REL} is occupied by something other than a plain file (SPEC 13.4)`,
      file: JOURNAL_REL,
    });
  } else {
    journal.entries.forEach((entry, index) => {
      if (entry === null) {
        findings.push({
          condition: "14.13",
          message: `journal error: malformed entry on line ${String(index + 1)} of ${JOURNAL_REL}`,
          file: JOURNAL_REL,
        });
      }
    });
  }
  // 14.21: review sessions not internally corrupt.
  for (const name of await listSessionNames(config.root)) {
    const loaded = await loadSession(config.root, name);
    if (loaded.state === "corrupt") {
      findings.push({
        condition: "14.21",
        message: `corrupt review session: ${name} (SPEC 10.1)`,
        file: sessionRel(name),
      });
    }
  }
  if (findings.length > 0) {
    emitFindings(io, flags["--json"] === true, findings);
    return 1;
  }
  emitDoc(io, flags["--json"] === true, { findings: [] }, ["check: ok"]);
  return 0;
}

async function commandIds(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const doc = {
    files: graph.files.map((model) => ({
      file: model.rel,
      ids: model.sections.map((section) => section.id),
    })),
  };
  emitDoc(
    io,
    flags["--json"] === true,
    doc,
    graph.files.flatMap((model) => [
      model.rel,
      ...model.sections.map((s) => `  ${s.id}`),
    ]),
  );
  return 0;
}

function nodeReportDoc(node) {
  return {
    edges: {
      incoming:
        node.parent && node.parent.identity !== undefined
          ? [
              {
                from: node.parent.identity,
                kind: "contains",
                to: node.identity,
              },
            ]
          : [],
      outgoing: node.children.map((child) => ({
        from: node.identity,
        kind: "contains",
        to: child.identity,
      })),
    },
    hashes: {
      effectiveHash: node.effectiveHash,
      metadataHash: node.metadataHash,
      ownHash: node.ownHash,
      subtreeHash: node.subtreeHash,
    },
    identity: node.identity,
    ownText: node.ownText,
    sourceRange: { end: node.sourceRange.end, start: node.sourceRange.start },
    subtreeText: node.subtreeText,
    tags: [],
  };
}

function requireNode(graph, identity) {
  const node = graph.byIdentity.get(identity);
  if (node === undefined) {
    throw new UsageError(`unknown node ${identity} (SPEC 12.0)`);
  }
  return node;
}

async function commandShow(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, READ_FLAGS, [1, 1]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const doc = nodeReportDoc(requireNode(graph, positionals[0]));
  emitDoc(io, flags["--json"] === true, doc, [canonicalJson(doc)]);
  return 0;
}

function nodeRow(node) {
  return {
    identity: node.identity,
    sourceRange: { end: node.sourceRange.end, start: node.sourceRange.start },
    tags: [],
  };
}

async function commandQuery(io, cwd, argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const flagSpecs = {
    node: READ_FLAGS,
    nodes: READ_FLAGS,
    edges: {
      ...READ_FLAGS,
      "--from": "value",
      "--to": "value",
      "--kinds": "value",
    },
    subtree: READ_FLAGS,
    ancestors: READ_FLAGS,
    reachable: {
      ...READ_FLAGS,
      "--from": "value",
      "--to": "value",
      "--kinds": "value",
    },
  };
  if (sub === undefined || flagSpecs[sub] === undefined) {
    throw new UsageError(
      `unknown query subcommand ${String(sub)} (SPEC 11, 12.0)`,
    );
  }
  const positionalRange =
    sub === "node" || sub === "subtree" || sub === "ancestors"
      ? [1, 1]
      : [0, 0];
  const { flags, positionals } = parseArgs(
    rest,
    flagSpecs[sub],
    positionalRange,
  );
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const allNodes = graph.files.flatMap((model) => model.nodes);
  if (sub === "node") {
    emitJsonOnly(io, nodeReportDoc(requireNode(graph, positionals[0])));
    return 0;
  }
  if (sub === "nodes") {
    emitJsonOnly(io, { nodes: allNodes.map(nodeRow) });
    return 0;
  }
  if (sub === "subtree") {
    const node = requireNode(graph, positionals[0]);
    const nodes = [
      node,
      ...descendantIdentities(node).map((identity) =>
        graph.byIdentity.get(identity),
      ),
    ];
    emitJsonOnly(io, { nodes: nodes.map(nodeRow) });
    return 0;
  }
  if (sub === "ancestors") {
    const node = requireNode(graph, positionals[0]);
    emitJsonOnly(io, { nodes: ancestorChain(node).map(nodeRow) });
    return 0;
  }
  if (sub === "edges") {
    const edges = allNodes.flatMap((node) =>
      node.children.map((child) => ({
        from: node.identity,
        kind: "contains",
        to: child.identity,
      })),
    );
    emitJsonOnly(io, { edges });
    return 0;
  }
  // reachable: dependency kinds only; this scope has no dependency edges.
  const from = flags["--from"];
  const to = flags["--to"];
  if (from === undefined || to === undefined) {
    throw new UsageError(
      "query reachable requires --from and --to (SPEC 11, 12.0)",
    );
  }
  requireNode(graph, from);
  requireNode(graph, to);
  emitJsonOnly(io, { reachable: false });
  return 0;
}

async function commandCoverage(io, cwd, argv) {
  const { flags } = parseArgs(
    argv,
    { ...READ_FLAGS, "--check": "bool" },
    [0, 0],
  );
  const config = await loadConfig(cwd, flags["--config"]);
  await loadGraph(config.root, config.groups); // reads answer per current sources
  emitDoc(io, flags["--json"] === true, { profiles: [] }, [
    "coverage: 0 profiles configured",
  ]);
  return 0;
}

async function commandImpact(io, cwd, argv) {
  const { flags } = parseArgs(
    argv,
    { ...READ_FLAGS, "--base": "value" },
    [0, 0],
  );
  await loadConfig(cwd, flags["--config"]);
  if (flags["--base"] === undefined) {
    throw new UsageError("impact requires --base <ref> (SPEC 9, 12.0)");
  }
  // §CONF-CORE scope has no git: a baseline that cannot be read or
  // reconstructed is a usage error (SPEC 6.3, 12.0).
  throw new UsageError(
    `cannot read the baseline ${flags["--base"]}: the workspace has no git repository (SPEC 6.3, 12.0)`,
  );
}

// --- rename / move (SPEC 6.4, 6.5) ---

async function commandRename(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, MUTATING_FLAGS, [3, 3]);
  const [file, oldId, newId] = positionals;
  return await runMutating(
    cwd,
    flags["--config"],
    flags["--test-hold"],
    async (config) => {
      const graph = await loadGraph(config.root, config.groups);
      const model = graph.files.find((candidate) => candidate.rel === file);
      if (model === undefined) {
        throw new UsageError(
          `unknown file ${file}: not a discovered spec source (SPEC 6.4, 12.0)`,
        );
      }
      const target = model.sections.find((section) => section.id === oldId);
      if (target === undefined) {
        throw new UsageError(`unknown id ${oldId} in ${file} (SPEC 6.4, 12.0)`);
      }
      // Validation (SPEC 6.4): new id valid, differs, collides with nothing,
      // structural parent rules remain satisfied.
      const refusal = (message) => new RefusalError(message);
      if (newId === oldId)
        throw refusal(
          `rename refused: the new id equals the old id (SPEC 6.4)`,
        );
      const segments = newId.split(".");
      if (!segments.every(segmentValid)) {
        throw refusal(
          `rename refused: invalid new id ${JSON.stringify(newId)} (SPEC 1.4, 6.4)`,
        );
      }
      const parentId = target.parent.id ?? null;
      const expectedPrefix = parentId === null ? "" : `${parentId}.`;
      const structural =
        newId.startsWith(expectedPrefix) &&
        newId.length > expectedPrefix.length &&
        !newId.slice(expectedPrefix.length).includes(".");
      if (!structural) {
        throw refusal(
          `rename refused: ${JSON.stringify(newId)} violates the structural parent rules at its position (SPEC 1.3, 6.4)`,
        );
      }
      const rewrittenOf = (id) =>
        id === oldId
          ? newId
          : id.startsWith(`${oldId}.`)
            ? newId + id.slice(oldId.length)
            : id;
      const survivingIds = new Set(
        model.sections.map((section) => rewrittenOf(section.id)),
      );
      if (survivingIds.size !== model.sections.length) {
        throw refusal(
          `rename refused: ${JSON.stringify(newId)} collides with an existing id (SPEC 6.4)`,
        );
      }
      // Minimal in-place edits: rewrite the affected id attribute values,
      // descending by offset so earlier offsets stay valid (SPEC 6.4).
      const edits = model.sections
        .filter(
          (section) =>
            section.id === oldId || section.id.startsWith(`${oldId}.`),
        )
        .map((section) => ({
          start: section.idValueStart,
          end: section.idValueEnd,
          replacement: rewrittenOf(section.id),
        }))
        .sort((a, b) => b.start - a.start);
      let text = await fsp.readFile(path.join(config.root, file), "utf8");
      for (const edit of edits) {
        text =
          text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
      }
      await writeFileAtomic(path.join(config.root, file), text);
      await appendJournal(config.root, {
        from: oldId,
        kind: "rename",
        path: file,
        to: newId,
      });
      // Finishing regeneration exactly as `build` (SPEC 6.4).
      const regenerated = await loadGraph(config.root, config.groups);
      await regenerate(regenerated);
      emitDoc(io, flags["--json"] === true, { ok: true }, [
        `rename: ${file} ${oldId} -> ${newId}`,
      ]);
      return 0;
    },
  );
}

async function commandMove(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, MUTATING_FLAGS, [2, 2]);
  const [oldPath, newPath] = positionals;
  if (oldPath.includes("#") || newPath.includes("#")) {
    // The section form is outside this fixture's certified scope
    // (CERTIFICATIONS.md §CONF-CORE: file-form move only).
    throw new UsageError(
      "this fixture implements the file form of move only (§CONF-CORE scope)",
    );
  }
  return await runMutating(
    cwd,
    flags["--config"],
    flags["--test-hold"],
    async (config) => {
      const graph = await loadGraph(config.root, config.groups);
      if (!graph.files.some((model) => model.rel === oldPath)) {
        throw new UsageError(
          `unknown file ${oldPath}: not a discovered spec source (SPEC 6.5, 12.0)`,
        );
      }
      const refusal = (message) => new RefusalError(message);
      if (await pathOccupied(path.join(config.root, newPath))) {
        throw refusal(
          `move refused: the destination ${newPath} already exists (SPEC 6.5)`,
        );
      }
      if (!newPath.endsWith(".mdx")) {
        throw refusal(
          `move refused: the destination must have the .mdx extension (SPEC 6.5, 14.19)`,
        );
      }
      const matchesGroup = Object.values(config.groups).some((globs) =>
        globs.some((glob) => globMatches(glob, newPath)),
      );
      if (!matchesGroup || isDerivedPath(newPath)) {
        throw refusal(
          `move refused: ${newPath} would not be a valid discovered spec source after the move (SPEC 6.5)`,
        );
      }
      await fsp.mkdir(path.dirname(path.join(config.root, newPath)), {
        recursive: true,
      });
      await fsp.rename(
        path.join(config.root, oldPath),
        path.join(config.root, newPath),
      );
      await appendJournal(config.root, {
        from: oldPath,
        kind: "move",
        to: newPath,
      });
      const regenerated = await loadGraph(config.root, config.groups);
      await regenerate(regenerated);
      emitDoc(io, flags["--json"] === true, { ok: true }, [
        `move: ${oldPath} -> ${newPath}`,
      ]);
      return 0;
    },
  );
}

// --- review (SPEC 10) ---

async function requireSession(root, name) {
  const loaded = await loadSession(root, name);
  if (loaded.state === "invalid-name") {
    throw new UsageError(
      `invalid session name ${JSON.stringify(name)} (SPEC 10.1, 12.0)`,
    );
  }
  if (loaded.state === "missing") {
    throw new UsageError(`unknown session ${name} (SPEC 10.1, 12.0)`);
  }
  if (loaded.state === "corrupt") {
    throw new FindingsError([
      {
        condition: "14.21",
        message: `corrupt review session: ${name} (SPEC 10.1, 14.21)`,
        file: sessionRel(name),
      },
    ]);
  }
  return loaded.session;
}

function requireItem(session, itemId) {
  const item = session.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    throw new UsageError(
      `unknown review item ${itemId} in session ${session.name} (SPEC 12.0)`,
    );
  }
  return item;
}

async function reviewCreate(io, cwd, argv) {
  const { flags } = parseArgs(
    argv,
    {
      ...MUTATING_FLAGS,
      "--strategy": "value",
      "--name": "value",
      "--base": "value",
      "--coverage": "value",
    },
    [0, 0],
  );
  const name = flags["--name"];
  if (name === undefined)
    throw new UsageError(
      "review create requires --name <name> (SPEC 10.7, 12.0)",
    );
  if (!sessionNameValid(name)) {
    throw new UsageError(
      `invalid session name ${JSON.stringify(name)} (SPEC 10.1, 12.0)`,
    );
  }
  const modes = ["--base", "--strategy", "--coverage"].filter(
    (flag) => flags[flag] !== undefined,
  );
  if (modes.length !== 1) {
    throw new UsageError(
      "review create requires exactly one of --base, --strategy audit, or --coverage (SPEC 10.7, 12.0)",
    );
  }
  if (flags["--strategy"] !== undefined && flags["--strategy"] !== "audit") {
    throw new UsageError(
      `unknown strategy ${flags["--strategy"]} (SPEC 10.7, 12.0)`,
    );
  }
  if (flags["--base"] !== undefined) {
    throw new UsageError(
      `cannot read the baseline ${flags["--base"]}: the workspace has no git repository (SPEC 6.3, 12.0)`,
    );
  }
  if (flags["--coverage"] !== undefined) {
    throw new UsageError(
      `unknown coverage profile ${flags["--coverage"]} (SPEC 12.0)`,
    );
  }
  return await runMutating(
    cwd,
    flags["--config"],
    flags["--test-hold"],
    async (config) => {
      const graph = await loadGraph(config.root, config.groups);
      // Create-time restriction (SPEC 10.1): a name matching an existing
      // session's name ignoring ASCII case is refused.
      const existing = await listSessionNames(config.root);
      if (
        existing.some(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        )
      ) {
        throw new RefusalError(
          `review create refused: a session named ${name} already exists (SPEC 10.1, 10.7)`,
        );
      }
      const journal = await readJournal(config.root);
      const session = {
        decompositions: [],
        items: [],
        name,
        nextId: 1,
        strategy: "audit",
      };
      const itemsByScope = new Map();
      for (const generated of auditGenerate(graph)) {
        const item = {
          baseline: null,
          blockedBy: [],
          contextNodes: generated.contextNodes,
          current: null,
          id: `i${String(session.nextId)}`,
          journalAt: journal.lineCount,
          kind: generated.kind,
          originNodes: [],
          reason: generated.reason,
          scopeNodes: generated.scopeNodes,
          scopeRoot: generated.scopeRoot,
          status: "unresolved",
        };
        session.nextId += 1;
        session.items.push(item);
        itemsByScope.set(generated.scopeRoot, { item, generated });
      }
      for (const { item, generated } of itemsByScope.values()) {
        // Audit blocking (SPEC 10.6): each item is blocked by its child
        // sections' items, so leaves are unblocked and review is bottom-up.
        item.blockedBy = generated.childIdentities.map(
          (identity) => itemsByScope.get(identity).item.id,
        );
        // `baseline` is fixed when the item enters an audit session: the
        // values in the current graph at that moment; `current` is recorded
        // at creation the same way (SPEC 10.2, 10.4).
        const recorded = recordState(item, graph, journal.entries);
        item.baseline = recorded;
        item.current = recorded;
      }
      await writeSession(config.root, session);
      emitDoc(io, flags["--json"] === true, { name, ok: true }, [
        `review: created session ${name} (${String(session.items.length)} items)`,
      ]);
      return 0;
    },
  );
}

async function reviewResolve(io, cwd, argv) {
  const { flags, positionals } = parseArgs(
    argv,
    { ...MUTATING_FLAGS, "--status": "value", "--note": "value" },
    [2, 2],
  );
  const [name, itemId] = positionals;
  const status = flags["--status"];
  if (status === undefined || !RESOLVE_STATUSES.has(status)) {
    throw new UsageError(
      `--status accepts updated, no-change, and skipped; got ${String(status)} (SPEC 10.7, 12.0)`,
    );
  }
  return await runMutating(
    cwd,
    flags["--config"],
    flags["--test-hold"],
    async (config) => {
      const graph = await loadGraph(config.root, config.groups);
      const session = await requireSession(config.root, name);
      const item = requireItem(session, itemId);
      const journal = await readJournal(config.root);
      if (isBlocked(item, session, graph, journal.entries)) {
        throw new RefusalError(
          `review resolve refused: item ${itemId} is blocked (SPEC 10.3, 10.7)`,
        );
      }
      item.status = status;
      if (flags["--note"] !== undefined) item.note = flags["--note"];
      // Resolving records the current relevant state (SPEC 10.4).
      item.current = recordState(item, graph, journal.entries);
      if (status === "updated") {
        rederive(session, graph, journal);
      }
      await writeSession(config.root, session);
      emitDoc(io, flags["--json"] === true, { ok: true }, [
        `review: resolved ${itemId} as ${status}`,
      ]);
      return 0;
    },
  );
}

/**
 * Re-derivation on an `updated` resolve (SPEC 10.5 rules via 10.6's
 * generator): matched items keep id/status/record; missing items are added
 * with current state; decomposed kind+scope pairs apply their recorded
 * decomposition instead; blockedBy is recomputed for generated items.
 */
function rederive(session, graph, journal) {
  const decomposed = new Set(
    session.decompositions.map((entry) => `${entry.kind} ${entry.scope}`),
  );
  const byMappedScope = new Map();
  for (const item of session.items) {
    const mapped = mapIdentityForward(
      item.scopeRoot,
      journal.entries.slice(item.journalAt),
    );
    byMappedScope.set(`${item.kind} ${mapped}`, item);
  }
  const generatedItems = new Map();
  for (const generated of auditGenerate(graph)) {
    const key = `${generated.kind} ${generated.scopeRoot}`;
    if (decomposed.has(key)) continue; // the decomposition applies instead
    let item = byMappedScope.get(key);
    if (item === undefined) {
      item = {
        baseline: null,
        blockedBy: [],
        contextNodes: generated.contextNodes,
        current: null,
        id: `i${String(session.nextId)}`,
        journalAt: journal.lineCount,
        kind: generated.kind,
        originNodes: [],
        reason: generated.reason,
        scopeNodes: generated.scopeNodes,
        scopeRoot: generated.scopeRoot,
        status: "unresolved",
      };
      session.nextId += 1;
      const recorded = recordState(item, graph, journal.entries);
      item.baseline = recorded;
      item.current = recorded;
      session.items.push(item);
      byMappedScope.set(key, item);
    }
    generatedItems.set(key, { item, generated });
  }
  for (const { item, generated } of generatedItems.values()) {
    item.blockedBy = generated.childIdentities.flatMap((identity) => {
      const childKey = `subtree-coherence ${identity}`;
      if (decomposed.has(childKey)) {
        const decomposition = session.decompositions.find(
          (entry) => `${entry.kind} ${entry.scope}` === childKey,
        );
        return decomposition.children.flatMap((child) => {
          const childItem = byMappedScope.get(`${child.kind} ${child.scope}`);
          return childItem === undefined ? [] : [childItem.id];
        });
      }
      const childItem = generatedItems.get(childKey);
      return childItem === undefined ? [] : [childItem.item.id];
    });
  }
}

async function reviewSplit(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, MUTATING_FLAGS, [2, 2]);
  const [name, itemId] = positionals;
  return await runMutating(
    cwd,
    flags["--config"],
    flags["--test-hold"],
    async (config) => {
      const graph = await loadGraph(config.root, config.groups);
      const session = await requireSession(config.root, name);
      const original = requireItem(session, itemId);
      const journal = await readJournal(config.root);
      const suffix = journal.entries.slice(original.journalAt);
      const mappedScope = mapIdentityForward(original.scopeRoot, suffix);
      const scopeNode = graph.byIdentity.get(mappedScope);
      if (
        original.kind !== "subtree-coherence" ||
        scopeNode === undefined ||
        scopeNode.children.length === 0
      ) {
        throw new RefusalError(
          "review split refused: only a subtree-coherence item whose scope root has children can be split (SPEC 10.7)",
        );
      }
      const byMappedScope = new Map();
      for (const item of session.items) {
        const mapped = mapIdentityForward(
          item.scopeRoot,
          journal.entries.slice(item.journalAt),
        );
        byMappedScope.set(`${item.kind} ${mapped}`, item);
      }
      const decompositionChildren = [];
      const childItemIds = [];
      const newItems = [];
      const makeItem = (kind, node) => {
        const item = {
          baseline: null,
          blockedBy: [],
          contextNodes:
            kind === "subtree-coherence"
              ? ancestorChain(node).map((ancestor) => ancestor.identity)
              : node.children.map((child) => child.identity),
          current: null,
          id: `i${String(session.nextId)}`,
          journalAt: journal.lineCount,
          kind,
          originNodes: [],
          reason:
            kind === "subtree-coherence"
              ? `audit: review the subtree rooted at ${node.identity} (SPEC 10.6)`
              : `split: review the own text of ${node.identity} against its child subtrees (SPEC 10.7)`,
          scopeNodes:
            kind === "subtree-coherence"
              ? [node.identity, ...descendantIdentities(node)]
              : [node.identity],
          scopeRoot: node.identity,
          status: "unresolved",
        };
        session.nextId += 1;
        const recorded = recordState(item, graph, journal.entries);
        item.baseline = recorded;
        item.current = recorded;
        return item;
      };
      for (const child of scopeNode.children) {
        const key = `subtree-coherence ${child.identity}`;
        let childItem = byMappedScope.get(key);
        if (childItem === undefined || childItem === original) {
          childItem = makeItem("subtree-coherence", child);
          newItems.push(childItem);
          byMappedScope.set(key, childItem);
        }
        childItemIds.push(childItem.id);
        decompositionChildren.push({
          kind: "subtree-coherence",
          scope: child.identity,
        });
      }
      const parentKey = `parent-consistency ${mappedScope}`;
      let parentItem = byMappedScope.get(parentKey);
      if (parentItem === undefined) {
        parentItem = makeItem("parent-consistency", scopeNode);
        parentItem.blockedBy = [...childItemIds];
        newItems.push(parentItem);
        byMappedScope.set(parentKey, parentItem);
      }
      decompositionChildren.push({
        kind: "parent-consistency",
        scope: mappedScope,
      });
      // Newly created decomposition items inherit the original's blockedBy.
      for (const item of newItems) {
        item.blockedBy = [
          ...new Set([...item.blockedBy, ...original.blockedBy]),
        ];
      }
      // Every item blocked by the original becomes blocked by the whole
      // decomposition; the original is removed and its id never reused.
      const decompositionIds = decompositionChildren.map(
        (child) => byMappedScope.get(`${child.kind} ${child.scope}`).id,
      );
      for (const item of session.items) {
        if (item.blockedBy.includes(original.id)) {
          item.blockedBy = [
            ...item.blockedBy.filter((id) => id !== original.id),
            ...decompositionIds.filter((id) => !item.blockedBy.includes(id)),
          ];
        }
      }
      session.items = [
        ...session.items.filter((item) => item !== original),
        ...newItems,
      ];
      session.decompositions.push({
        children: decompositionChildren,
        journalAt: journal.lineCount,
        kind: original.kind,
        scope: mappedScope,
      });
      await writeSession(config.root, session);
      emitDoc(io, flags["--json"] === true, { ok: true }, [
        `review: split ${itemId} into ${String(decompositionIds.length)} items`,
      ]);
      return 0;
    },
  );
}

async function reviewList(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const config = await loadConfig(cwd, flags["--config"]);
  await loadGraph(config.root, config.groups); // 13.3: reads validate sources
  const sessions = [];
  let anyCorrupt = false;
  for (const name of await listSessionNames(config.root)) {
    const loaded = await loadSession(config.root, name);
    if (loaded.state !== "ok") {
      sessions.push({ corrupt: true, name });
      anyCorrupt = true;
      continue;
    }
    // Counts from stored statuses, without read-time invalidation (10.7).
    const counts = {
      invalidated: 0,
      "no-change": 0,
      skipped: 0,
      unresolved: 0,
      updated: 0,
    };
    for (const item of loaded.session.items) counts[item.status] += 1;
    sessions.push({
      corrupt: false,
      counts,
      name,
      strategy: loaded.session.strategy,
    });
  }
  const doc = { sessions };
  emitDoc(
    io,
    flags["--json"] === true,
    doc,
    sessions.map((entry) =>
      entry.corrupt
        ? `${entry.name}: corrupt`
        : `${entry.name}: ${entry.strategy}`,
    ),
  );
  return anyCorrupt ? 1 : 0;
}

async function reviewStatus(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, READ_FLAGS, [1, 1]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const session = await requireSession(config.root, positionals[0]);
  const journal = await readJournal(config.root);
  const totals = {
    invalidated: 0,
    "no-change": 0,
    skipped: 0,
    unresolved: 0,
    updated: 0,
  };
  const rows = orderedItems(session, graph, journal.entries).map(
    ({ item, mappedScope }) => {
      const status = effectiveStatus(item, graph, journal.entries);
      totals[status] += 1;
      return {
        blocked: isBlocked(item, session, graph, journal.entries),
        id: item.id,
        kind: item.kind,
        scope: mappedScope,
        status,
      };
    },
  );
  const doc = { items: rows, totals };
  emitDoc(
    io,
    flags["--json"] === true,
    doc,
    rows.map(
      (row) =>
        `${row.id} ${row.kind} ${row.scope} ${row.status}${row.blocked ? " (blocked)" : ""}`,
    ),
  );
  return 0;
}

async function reviewNext(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, READ_FLAGS, [1, 1]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const session = await requireSession(config.root, positionals[0]);
  const journal = await readJournal(config.root);
  const next = orderedItems(session, graph, journal.entries).find(
    ({ item }) => {
      const status = effectiveStatus(item, graph, journal.entries);
      return (
        (status === "unresolved" || status === "invalidated") &&
        !isBlocked(item, session, graph, journal.entries)
      );
    },
  );
  const doc =
    next === undefined
      ? { fullyResolved: true }
      : {
          fullyResolved: false,
          item: itemPayload(next.item, session, graph, journal.entries),
        };
  emitDoc(io, flags["--json"] === true, doc, [
    next === undefined
      ? "review: fully resolved"
      : `review: next is ${next.item.id}`,
    ...(next === undefined ? [] : [canonicalJson(doc)]),
  ]);
  return 0;
}

async function reviewShow(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, READ_FLAGS, [2, 2]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const session = await requireSession(config.root, positionals[0]);
  const item = requireItem(session, positionals[1]);
  const journal = await readJournal(config.root);
  const doc = itemPayload(item, session, graph, journal.entries);
  emitDoc(io, flags["--json"] === true, doc, [canonicalJson(doc)]);
  return 0;
}

async function reviewExport(io, cwd, argv) {
  const { flags, positionals } = parseArgs(argv, READ_FLAGS, [1, 1]);
  const config = await loadConfig(cwd, flags["--config"]);
  const graph = await loadGraph(config.root, config.groups);
  const session = await requireSession(config.root, positionals[0]);
  const journal = await readJournal(config.root);
  // A single JSON document is export's only output form (SPEC 10.7).
  emitJsonOnly(io, {
    creationParameters: null,
    decompositions: session.decompositions,
    items: orderedItems(session, graph, journal.entries).map(({ item }) =>
      itemPayload(item, session, graph, journal.entries),
    ),
    name: session.name,
    strategy: session.strategy,
  });
  return 0;
}

async function commandReview(io, cwd, argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "create":
      return await reviewCreate(io, cwd, rest);
    case "resolve":
      return await reviewResolve(io, cwd, rest);
    case "split":
      return await reviewSplit(io, cwd, rest);
    case "list":
      return await reviewList(io, cwd, rest);
    case "status":
      return await reviewStatus(io, cwd, rest);
    case "next":
      return await reviewNext(io, cwd, rest);
    case "show":
      return await reviewShow(io, cwd, rest);
    case "export":
      return await reviewExport(io, cwd, rest);
    default:
      throw new UsageError(
        `unknown review subcommand ${String(sub)} (SPEC 10.7, 12.0)`,
      );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Deviation switches active for this invocation (CERTIFICATIONS.md
 * VIOL-CORE-* violators). Set once per invocation by runXspec from its
 * `options` argument; with no switch set, every code path behaves as the
 * conformer. Module state is safe here: each bin*.mjs entry runs exactly one
 * invocation per process.
 *
 * - `noMutualExclusion` (VIOL-CORE-NOLOCK): mutating commands do not exclude
 *   one another; see runMutating.
 * - `writesBeforeHold` (VIOL-CORE-EARLYWRITE): a mutating command performs
 *   its workspace modifications before creating the hold file; see
 *   runMutating.
 * - `staleLockBlocks` (VIOL-CORE-STALELOCK): workspace exclusivity is not
 *   released by abnormal termination — a lock file left by a killed holder
 *   refuses every later mutating command; see acquireExclusivity.
 */
let deviations = {};

/**
 * Run one xspec invocation. Returns the exit code (SPEC 12.0 partition).
 * `io` writes the streams; `options` is the seam through which each violator
 * fixture's bin-<name>.mjs entry threads exactly one deviation switch (the
 * conformer's bin.mjs passes none).
 */
export async function runXspec(argv, cwd, options = {}) {
  deviations = options;
  const io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
  const wantsJson = argv.includes("--json");
  try {
    const command = argv[0];
    const rest = argv.slice(1);
    switch (command) {
      case "build":
        return await commandBuild(io, cwd, rest);
      case "check":
        return await commandCheck(io, cwd, rest);
      case "ids":
        return await commandIds(io, cwd, rest);
      case "show":
        return await commandShow(io, cwd, rest);
      case "query":
        return await commandQuery(io, cwd, rest);
      case "coverage":
        return await commandCoverage(io, cwd, rest);
      case "impact":
        return await commandImpact(io, cwd, rest);
      case "rename":
        return await commandRename(io, cwd, rest);
      case "move":
        return await commandMove(io, cwd, rest);
      case "review":
        return await commandReview(io, cwd, rest);
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
    if (error instanceof RefusalError) {
      // Refused operations are exit-1 findings outcomes (SPEC 12.0); the
      // refusal report is stdout content, with no pinned wording.
      if (wantsJson) {
        io.stdout(canonicalJson({ refused: error.message }) + "\n");
      } else {
        io.stdout(`${error.message}\n`);
      }
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
