// CONF-DISC conformer fixture (CERTIFICATIONS.md §CONF-DISC; TEST-SPEC 17
// C-1/C-2). A harness-owned executable product implementing §CONF-DISC's
// Scope with the simplest conforming behavior — driven only through the C-2
// executable/workspace binding, never importing product code (the product and
// the harness are distinct programs; this fixture is part of the harness).
//
// Scope implemented (see CERTIFICATIONS.md §CONF-DISC):
// - Workspaces of trivial single-section `.mdx` sources whose file and
//   directory names carry glob-significant bytes, plus, as T7-6 stages them,
//   files at derived-classified paths and an import target unmatched by every
//   group; spec groups with the glob grammar of SPEC 7 (a no-match group, and
//   the empty `specs` and `code` maps, are valid with zero sources); imports
//   of 2.1's single-default-binding form, resolving against the importing
//   file's directory to a discovered source, an undiscovered target failing
//   with 14.15; `markdown` with `emit: true` and default destinations,
//   classified by configuration alone (7.3); symbolic links present in the
//   tree; no code groups (`code` appears only as the empty map), `coverage`,
//   `policy`, or git; content of derived and emitted files beyond path is out
//   of scope.
// - Command surface: `build` and `ids` (12.3) as the observation of the
//   discovered set, the configuration-error behavior of 14.14/12.0 for
//   patterns resolving outside the workspace root, and the source-error
//   reporting of 14.15.
// - Contracts under certification: glob semantics of 7 — `*`, `?`, `**`,
//   byte-wise case-sensitive matching, the dot-segment rule, every other
//   character a literal — discovery's refusal to follow symbolic links, and
//   the source exclusion of 13.4 (`.xspec.` names, `.xspec/` paths, and
//   enabled Markdown emit destinations in no group).
//
// Key mechanisms:
// - The glob matcher is a port of the harness oracle's discovery half
//   (test/helpers/oracles/glob.ts, S-6-vetted; its header states a CONF-DISC
//   fixture may share it — the "may share HARNESS-09's matcher" of the
//   CERT-14 plan entry). Matching is byte-wise: patterns and workspace-
//   relative paths are matched as their UTF-8 bytes, so `?` is one byte (the
//   two-byte `é.mdx` is not matched by `?.mdx` but is by `??.mdx`), `*` a
//   possibly empty byte run within one segment, `**` whole segments including
//   none, matching case-sensitive, a dot-initial path segment matched only by
//   a pattern segment written with a leading `.` (and never consumed by
//   `**`), and every character outside `*`/`?`/`**` a literal — bracket,
//   brace, bang, and extglob characters included.
// - Pattern resolution (SPEC 7): patterns resolve relative to the
//   configuration file's directory (the workspace root). `.` and `..`
//   segments resolve lexically (wildcard segments count as ordinary names);
//   an absolute pattern, or one whose resolution escapes the root, is a
//   configuration error (14.14) reported at load by every command as a usage
//   error (12.0) — exit 2, message on stderr, stdout empty.
// - Discovery pipeline order (SPEC 7, 13.4): walk plain files (symbolic links
//   never discovered, never traversed — so link cycles cannot hang the walk),
//   match the union of all groups' globs, then apply the 13.4 source
//   exclusion to the matches — paths whose file name contains `.xspec.`,
//   files under `.xspec/`, and, exactly while `markdown.emit` is true, the
//   default emit destinations (`X.md` beside each discovered `X.mdx` source;
//   destinations exist by configuration alone, whether or not emission has
//   run, 7.3). A surviving match without the `.mdx` extension, or whose path
//   contains `#`, is a 14.19 finding; exclusion precedes that check, so an
//   excluded occupant of an emit destination is silently no source.
// - Sources are scanned by a hand-rolled MDX-lite lexer for exactly the
//   scope's constructs: spec module imports at line start (2.1) and
//   `<S>`/`<Spec>` opening/self-closing/closing tags with quoted or braced
//   attribute values (`id` retained); everything else is uninterpreted
//   content, and an unbalanced or malformed tag is 14.20. That is enough for
//   every staged source and for anything a violator wrongly discovers in the
//   in-scope fixtures (each decoy is itself a valid single-section source, so
//   wrong discovery surfaces as a clean listing mismatch, never a crash).
// - `build` (12.1, scoped): on findings, exit 1 writing nothing; on success,
//   write the derived files at their 13.4-classified paths — the generated
//   module `X.xspec.ts` beside each source (13.1; companions are not needed
//   by any in-scope observation) and, exactly when emission is enabled, the
//   emitted `X.md` (13.2), replacing whatever occupies those paths (13.4).
//   Content beyond path is out of scope and deliberately trivial, fixed
//   bytes. Writing real files keeps T7-6's after-build listing arm
//   non-vacuous against this conformer: the generated and emitted files exist,
//   are matched by `specs/*`, and stay excluded. No graph data is kept:
//   `ids` recomputes from sources on every run (13.3's refresh, minus the
//   unobservable-in-scope stored form), reporting validation findings with
//   exit 1 without writing anything when the sources are invalid.
// - `ids` (12.3): requirement IDs grouped by file — files in byte order of
//   workspace-relative path (UTF-8 byte comparison, not code-unit order), IDs
//   within a file in document order; `--json` emits the single JSON document
//   as the entire stdout (12.0).
//
// Determinism (SPEC 12.0): no wall clock, no randomness, no absolute paths in
// any output; files in byte order of workspace-relative path; all JSON is
// serialized with byte-sorted keys; generated/emitted content is fixed bytes.
//
// Deviation seam: runXspec(argv, cwd, options) assigns `options` onto the
// module-level `deviations` switches (all off = this conformer). Each
// VIOL-DISC-* violator entry is a bin-<name>.mjs passing exactly one switch,
// consumed at the hook points pinned below:
//   - §VIOL-DISC-DIALECT (CERT-15, bin-dialect.mjs): `dialectMetachars`,
//     consumed in `parseSegment` — the single place a pattern character
//     acquires meaning — making `[ ]` bracket expressions and `{ }` brace
//     alternations active metacharacters while `*`, `?`, `**`, case
//     sensitivity, and the dot-segment rule stay unchanged.
//   - §VIOL-DISC-SYMLINK (CERT-16, bin-symlink.mjs): `followFileSymlinks`,
//     consumed in `walkPlainFiles`'s symbolic-link branch — a link resolving
//     to an existing regular file is discovered (read through the link) while
//     broken links stay ignored and directory links stay untraversed, so the
//     walk still terminates and T7-5 fails by assertion, not by hang.
//   - §VIOL-DISC-DERIVED (CERT-17, bin-derived.mjs): `noDerivedExclusion`,
//     consumed in `discoverSources`' exclusion filter — the 13.4 source
//     exclusion is not applied to glob matches, so `.xspec.`-named files,
//     files under `.xspec/` (where a pattern spells the dot segment), and
//     occupants of enabled emit destinations are treated as ordinary matches
//     (a non-`.mdx` occupant then surfaces as 14.19).

import { Buffer } from "node:buffer";
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
 * @typedef {{ condition: string, message: string, file?: string,
 *             location?: { start: number, end: number } }} Finding
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
// Deviation switches (CERTIFICATIONS.md §VIOL-DISC-*), all off in the
// conformer; assigned by runXspec from each entry's options. See the module
// header for the hook point each named switch is consumed at when its CERT
// task lands: `dialectMetachars` (§VIOL-DISC-DIALECT → parseSegment),
// `followFileSymlinks` (§VIOL-DISC-SYMLINK → walkPlainFiles),
// `noDerivedExclusion` (§VIOL-DISC-DERIVED → discoverSources).
// ---------------------------------------------------------------------------

let deviations = {};

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
 * Validate one glob pattern and resolve its `.`/`..` segments lexically
 * (SPEC 7: patterns resolve relative to the configuration file's directory;
 * wildcard segments are ordinary names to resolution, and walked paths never
 * contain dot segments, so matching uses the resolved form). An absolute
 * pattern, or one resolving outside the workspace root, is a configuration
 * error (14.14) — reported at load, before any source analysis.
 */
function validatedPattern(glob, groupName) {
  if (typeof glob !== "string" || glob === "") {
    throw new UsageError(
      `configuration error: group ${groupName} must hold non-empty glob strings (SPEC 7.1, 14.14)`,
    );
  }
  if (glob.startsWith("/")) {
    throw new UsageError(
      `configuration error: pattern ${glob} is absolute and resolves outside the workspace root (SPEC 7, 14.14)`,
    );
  }
  const normalized = path.posix.normalize(glob);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new UsageError(
      `configuration error: pattern ${glob} resolves outside the workspace root (SPEC 7, 14.14)`,
    );
  }
  return normalized;
}

/**
 * Load and validate the configuration; returns the workspace root, the spec
 * groups (patterns validated and resolved), and the emission switch. The
 * in-scope shape (CERTIFICATIONS.md §CONF-DISC) is spec groups of glob
 * strings, an optional `code` that MUST be the empty map, and an optional
 * `markdown: { emit: boolean }` with default destinations — no `outDir`, no
 * `coverage` or `policy` keys; anything else is refused loudly as a
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
    if (key !== "specs" && key !== "code" && key !== "markdown") {
      throw new UsageError(
        `configuration error: the key ${JSON.stringify(key)} is unknown or outside this fixture's scope (CERTIFICATIONS.md §CONF-DISC; SPEC 7, 14.14)`,
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
    if (!Array.isArray(globs)) {
      throw new UsageError(
        `configuration error: spec group ${name} must be a list of glob strings (SPEC 7.1)`,
      );
    }
    groups[name] = globs.map((glob) => validatedPattern(glob, name));
  }
  if (data.code !== undefined) {
    const code = data.code;
    if (code === null || typeof code !== "object" || Array.isArray(code)) {
      throw new UsageError(
        "configuration error: `code` must be a map of groups (SPEC 7.2)",
      );
    }
    if (Object.keys(code).length > 0) {
      // SPEC 7 allows code groups; §CONF-DISC's scope does not (`code`
      // appears only as the empty map). Refuse loudly rather than
      // half-implement code discovery.
      throw new UsageError(
        "configuration error: non-empty `code` groups are outside this fixture's scope (CERTIFICATIONS.md §CONF-DISC; SPEC 7.2, 14.14)",
      );
    }
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
          `configuration error: markdown.${key} is unknown or outside this fixture's scope (CERTIFICATIONS.md §CONF-DISC: default emission destinations only; SPEC 7.3, 14.14)`,
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
// Byte-wise glob matching (SPEC 7) — port of the harness oracle's discovery
// half (test/helpers/oracles/glob.ts, S-6-vetted; shareable per its header
// and the CERTIFICATIONS.md CONF-DISC entry's may-share note). `$` is an
// ordinary literal in discovery globs (capture wildcards exist only in
// policy `files` selectors, SPEC 7.5, out of this fixture's scope).
// ---------------------------------------------------------------------------

const SLASH = 0x2f; // "/"
const STAR = 0x2a; // "*"
const QUESTION = 0x3f; // "?"
const DOT = 0x2e; // "."

/** Split UTF-8 bytes on `/` (0x2F). UTF-8 never embeds 0x2F inside a
 * multi-byte sequence, so byte-level splitting is exact. */
function splitOnSlash(bytes) {
  const segments = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === SLASH) {
      segments.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return segments;
}

/**
 * Tokenize one pattern segment: the whole-segment `**` wildcard, or a token
 * list of literals, `?` (one byte), and `*` (a possibly empty byte run).
 * Every character outside `*`/`?`/`**` is a literal (SPEC 7) — bracket,
 * brace, bang, extglob, and `$` characters included.
 *
 * §VIOL-DISC-DIALECT hook (CERT-15, bin-dialect.mjs): this tokenizer is the
 * single place a pattern character acquires meaning; under
 * `dialectMetachars`, `[ ]` bracket expressions and `{ }` brace alternations
 * become active metacharacters of a common dialect while `*`, `?`, `**`,
 * case sensitivity, and the dot-segment rule stay unchanged.
 */
function parseSegment(segment) {
  if (segment.length === 2 && segment[0] === STAR && segment[1] === STAR) {
    return { kind: "globstar" };
  }
  const tokens = [];
  let literalStart = -1;
  const endLiteral = (end) => {
    if (literalStart !== -1) {
      tokens.push({
        kind: "literal",
        bytes: segment.subarray(literalStart, end),
      });
      literalStart = -1;
    }
  };
  for (let i = 0; i < segment.length; i += 1) {
    const byte = segment[i];
    if (byte === STAR) {
      endLiteral(i);
      tokens.push({ kind: "byte-run" });
    } else if (byte === QUESTION) {
      endLiteral(i);
      tokens.push({ kind: "one-byte" });
    } else if (literalStart === -1) {
      literalStart = i;
    }
  }
  endLiteral(segment.length);
  return {
    kind: "tokens",
    tokens,
    // SPEC 7 dot rule reads the pattern as written: its first byte is `.`.
    writtenLeadingDot: segment.length > 0 && segment[0] === DOT,
  };
}

/** Parsed patterns, memoized per pattern string (patterns repeat per file).
 * Safe across deviation switches: each process runs exactly one invocation
 * (bin*.mjs calls runXspec once), so `deviations` is fixed before any
 * pattern parses and the cache never spans two settings. */
const patternCache = new Map();

function parsePattern(pattern) {
  let segments = patternCache.get(pattern);
  if (segments === undefined) {
    segments = splitOnSlash(Buffer.from(pattern, "utf8")).map(parseSegment);
    patternCache.set(pattern, segments);
  }
  return segments;
}

function startsWithAt(bytes, prefix, at) {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[at + i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Match one non-`**` pattern segment's tokens against one path segment's
 * bytes, with a (token, offset) failure memo bounding the backtracking.
 */
function matchTokenSegment(tokens, bytes) {
  const width = bytes.length + 1;
  const failed = new Set();
  const matchAt = (ti, at) => {
    const key = ti * width + at;
    if (failed.has(key)) return false;
    const token = tokens[ti];
    let matched;
    if (token === undefined) {
      matched = at === bytes.length;
    } else if (token.kind === "literal") {
      matched =
        startsWithAt(bytes, token.bytes, at) &&
        matchAt(ti + 1, at + token.bytes.length);
    } else if (token.kind === "one-byte") {
      matched = at < bytes.length && matchAt(ti + 1, at + 1);
    } else {
      // `*`: a possibly empty byte run within this segment.
      matched = false;
      for (let end = at; end <= bytes.length; end += 1) {
        if (matchAt(ti + 1, end)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchAt(0, 0);
}

/**
 * Match parsed pattern segments against path segments. `**` spans whole
 * segments including none and never consumes a dot-initial segment (SPEC 7);
 * every other pattern segment matches exactly one path segment, which is what
 * keeps `*` runs and `?` inside a single segment (never `/`).
 */
function matchSegments(patternSegments, pathSegments) {
  const width = pathSegments.length + 1;
  const failed = new Set();
  const matchFrom = (pi, si) => {
    const key = pi * width + si;
    if (failed.has(key)) return false;
    const segment = patternSegments[pi];
    let matched;
    if (segment === undefined) {
      matched = si === pathSegments.length;
    } else if (segment.kind === "globstar") {
      matched = false;
      let end = si;
      for (;;) {
        if (matchFrom(pi + 1, end)) {
          matched = true;
          break;
        }
        if (end === pathSegments.length) break;
        const next = pathSegments[end];
        if (next.length > 0 && next[0] === DOT) break;
        end += 1;
      }
    } else if (si === pathSegments.length) {
      matched = false;
    } else {
      const pathSegment = pathSegments[si];
      const dotBlocked =
        pathSegment.length > 0 &&
        pathSegment[0] === DOT &&
        !segment.writtenLeadingDot;
      matched =
        !dotBlocked &&
        matchTokenSegment(segment.tokens, pathSegment) &&
        matchFrom(pi + 1, si + 1);
    }
    if (!matched) failed.add(key);
    return matched;
  };
  return matchFrom(0, 0);
}

/** SPEC 7: does a discovery glob match a workspace-relative path? Both are
 * matched as their UTF-8 bytes (byte-wise, case-sensitive). */
function globMatches(pattern, relPath) {
  return matchSegments(
    parsePattern(pattern),
    splitOnSlash(Buffer.from(relPath, "utf8")),
  );
}

// ---------------------------------------------------------------------------
// Discovery (SPEC 7, 13.4): walk plain files, match, exclude derived paths
// ---------------------------------------------------------------------------

/**
 * Recursively list the workspace's plain files as `/`-separated relative
 * paths. Symbolic links — to files or directories, broken or not — are never
 * discovered and never traversed (SPEC 7), so link cycles cannot hang the
 * walk and workspace-external content behind a link never enters the set.
 *
 * §VIOL-DISC-SYMLINK hook (CERT-16, bin-symlink.mjs): the symbolic-link
 * branch below is the deviation's single consumption point — under
 * `followFileSymlinks`, a link resolving to an existing regular file is
 * discovered (read later through the link), while broken links stay ignored
 * and directory links stay untraversed, keeping the walk terminating.
 */
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

/** UTF-8 byte comparison of two `/`-separated relative paths (SPEC 12.0). */
function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** SPEC 13.4: `.xspec.`-bearing file names and files under `.xspec/`. */
function isXspecClassified(rel) {
  const base = rel.split("/").at(-1) ?? rel;
  return (
    base.includes(".xspec.") || rel === ".xspec" || rel.startsWith(".xspec/")
  );
}

/**
 * Discover the workspace's sources (SPEC 7, 13.4): walk plain files, match
 * the union of all spec groups' globs, apply the 13.4 source exclusion, and
 * validate surviving matches' paths (14.19). Returns byte-ordered sources
 * plus any 14.19 findings.
 *
 * §VIOL-DISC-DERIVED hook (CERT-17, bin-derived.mjs): the exclusion filter
 * below is the deviation's single consumption point — under
 * `noDerivedExclusion` the 13.4 exclusion is skipped and every glob match is
 * an ordinary match, so an excluded-under-the-conformer path enters the
 * discovered set (or, lacking `.mdx`, surfaces as 14.19); glob semantics,
 * the dot-segment rule, link behavior, and the import and empty-map rules
 * are unchanged.
 */
async function discoverSources(config) {
  const walked = await walkPlainFiles(config.root);
  walked.sort(compareUtf8);
  const allPatterns = Object.values(config.groups).flat();
  const matched = walked.filter((rel) =>
    allPatterns.some((pattern) => globMatches(pattern, rel)),
  );
  // The enabled Markdown emit destinations exist by configuration alone
  // (SPEC 7.3): `X.md` beside each discovered `X.mdx` spec source, whether or
  // not emission has run. Destination paths never end in `.mdx`, so this
  // exclusion can never remove a source and the provisional set below is the
  // final source set.
  const provisional = matched.filter(
    (rel) => !isXspecClassified(rel) && rel.endsWith(".mdx"),
  );
  const destinations = new Set(
    config.emit
      ? provisional.map((rel) => rel.slice(0, -".mdx".length) + ".md")
      : [],
  );
  const excluded = (rel) => isXspecClassified(rel) || destinations.has(rel);
  const kept = matched.filter((rel) => !excluded(rel));
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const sources = [];
  for (const rel of kept) {
    if (rel.includes("#")) {
      findings.push({
        condition: "14.19",
        message: `invalid source path: the discovered path ${JSON.stringify(rel)} contains "#" (SPEC 7, 1.5, 14.19)`,
        file: rel,
      });
      continue;
    }
    if (!rel.endsWith(".mdx")) {
      findings.push({
        condition: "14.19",
        message: `invalid source path: the spec-group match ${JSON.stringify(rel)} does not have the .mdx extension (SPEC 7.1, 14.19)`,
        file: rel,
      });
      continue;
    }
    sources.push(rel);
  }
  return { sources, findings };
}

// ---------------------------------------------------------------------------
// Byte offsets (SPEC 1.7: ranges and locations are byte offsets)
// ---------------------------------------------------------------------------

/**
 * Map string (code-unit) indices to UTF-8 byte offsets. ASCII sources take
 * the identity fast path; the general path handles multi-byte content.
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
// MDX-lite lexer: imports (SPEC 2.1) and `<S>`/`<Spec>` section tags
// ---------------------------------------------------------------------------

/** Inter-attribute whitespace inside a tag (the SPEC 1.4 class, verbatim). */
const TAG_WHITESPACE = new Set(["\t", "\n", "\v", "\f", "\r", " "]);

const IMPORT_RE =
  /^import[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)[ \t]+from[ \t]+(?:"([^"\r\n]*)"|'([^'\r\n]*)');?/;

/**
 * Parse one source file: spec module imports at line start (SPEC 2.1, the
 * single-default-binding form) and `<S>`/`<Spec>` opening/self-closing/
 * closing tags with quoted or (quote-aware) braced attribute values, `id`
 * retained. Content between constructs is uninterpreted — the scope stages
 * trivial single-section sources. Returns { sections, imports, failure }
 * where sections are in document order and `failure` is null or
 * { at, message } (an unparseable source, SPEC 14.20).
 */
function parseMdx(text) {
  /** @type {{ id: string | null, openStart: number, openEnd: number }[]} */
  const sections = [];
  /** @type {{ binding: string, specifier: string, start: number, end: number }[]} */
  const imports = [];
  /** @type {{ at: number, message: string } | null} */
  let failure = null;
  let depth = 0;
  let i = 0;
  const fail20 = (at, message) => {
    failure = { at, message };
  };
  const result = () => ({ sections, imports, failure });

  while (i < text.length) {
    const ch = text[i];
    if (
      ch === "i" &&
      (i === 0 || text[i - 1] === "\n" || text[i - 1] === "\r")
    ) {
      // A spec module import (SPEC 2.1) at line start — the MDX ESM position.
      const m = IMPORT_RE.exec(text.slice(i));
      if (m) {
        imports.push({
          binding: m[1],
          specifier: m[2] !== undefined ? m[2] : m[3],
          start: i,
          end: i + m[0].length,
        });
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "<") {
      const closeMatch = /^<\/(S|Spec)[ \t\r\n\v\f]*>/.exec(text.slice(i));
      if (closeMatch) {
        if (depth === 0) {
          fail20(i, "closing section tag without an open section");
          return result();
        }
        depth -= 1;
        i += closeMatch[0].length;
        continue;
      }
      const openMatch = /^<(S|Spec)(?=[ \t\r\n\v\f/>])/.exec(text.slice(i));
      if (openMatch) {
        let id = null;
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
              // Quote-aware brace scan (robustness for wrongly-discovered
              // content; braced values are retained without effect in scope).
              let braceDepth = 0;
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
                if (c === "{") braceDepth += 1;
                else if (c === "}") {
                  braceDepth -= 1;
                  if (braceDepth === 0) {
                    k += 1;
                    break;
                  }
                }
                k += 1;
              }
              j = k;
            } else {
              fail20(j, "malformed attribute value in a section tag");
              return result();
            }
          }
          if (name === "id" && quoted !== undefined) id = quoted;
        }
        sections.push({ id, openStart: i, openEnd: j });
        if (!selfClosing) depth += 1;
        i = j;
        continue;
      }
      i += 1; // a plain `<` is ordinary content in this scope
      continue;
    }
    i += 1;
  }
  if (depth !== 0) {
    fail20(Math.max(0, text.length - 1), "unclosed section tag");
  }
  return result();
}

/** Analyze one source file's bytes into a file record. */
function analyzeFile(rel, bytes) {
  const base = {
    rel,
    text: "",
    byteOf: (index) => index,
    sections: [],
    imports: [],
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
      text,
      failure: {
        at: 0,
        message: `${rel} begins with a byte-order mark (SPEC 1.6)`,
      },
    };
  }
  const byteOf = byteOffsetMapper(text, bytes.length);
  const parsed = parseMdx(text);
  return {
    ...base,
    text,
    byteOf,
    sections: parsed.sections,
    imports: parsed.imports,
    failure: parsed.failure,
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

// ---------------------------------------------------------------------------
// Workspace loading: discovery, parse, import resolution (SPEC 2.1, 14.15)
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

/** Bindings the compiler provides; imports never shadow them (SPEC 2.1). */
const RESERVED_BINDINGS = new Set(["S", "Spec", "text"]);

/**
 * Load the workspace: configuration, discovery, every discovered source's
 * analysis, and import resolution. Files in byte order of workspace-relative
 * path — deterministic (SPEC 12.0). An unparseable file (14.20) masks the
 * conditions inside itself (SPEC 14).
 */
async function loadWorkspace(cwd, configFlag) {
  const config = await loadConfig(cwd, configFlag);
  const discovery = await discoverSources(config);
  /** @type {Finding[]} */
  const findings = [...discovery.findings];
  const files = new Map();
  for (const rel of discovery.sources) {
    const bytes = await fsp.readFile(path.join(config.root, ...rel.split("/")));
    files.set(rel, analyzeFile(rel, bytes));
  }
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
    const boundNames = new Set();
    for (const imp of record.imports) {
      const location = byteRange(record, imp.start, imp.end);
      if (RESERVED_BINDINGS.has(imp.binding) || boundNames.has(imp.binding)) {
        findings.push({
          condition: "14.15",
          message: `invalid import: the binding ${JSON.stringify(imp.binding)} shadows a compiler-provided name or repeats another import's binding (SPEC 2.1, 14.15)`,
          file: record.rel,
          location,
        });
        continue;
      }
      boundNames.add(imp.binding);
      const target = resolveImportTarget(record.rel, imp.specifier);
      if (target === null || !files.has(target)) {
        findings.push({
          condition: "14.15",
          message: `invalid import: ${JSON.stringify(imp.specifier)} does not designate a discovered spec source of a configured group (SPEC 2.1, 14.15)`,
          file: record.rel,
          location,
        });
      }
    }
  }
  return { config, files, findings };
}

// ---------------------------------------------------------------------------
// Commands (SPEC 12.0 conventions; the §CONF-DISC surface)
// ---------------------------------------------------------------------------

function findingsDoc(findings) {
  return {
    findings: findings.map((finding) => {
      /** @type {Record<string, unknown>} */
      const doc = { condition: finding.condition, message: finding.message };
      if (finding.file !== undefined) doc.file = finding.file;
      if (finding.location !== undefined) doc.location = finding.location;
      return doc;
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
            `${finding.file ?? "(workspace)"}: ${finding.condition}: ${finding.message}\n`,
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

/** Fixed derived-file bytes: content beyond path is out of scope
 * (CERTIFICATIONS.md §CONF-DISC) and byte-deterministic (SPEC 12.0). */
const GENERATED_MODULE_CONTENT =
  "// Generated by xspec (CONF-DISC fixture): content beyond path is out of scope (CERTIFICATIONS.md §CONF-DISC).\nexport {};\n";
const EMITTED_MARKDOWN_CONTENT =
  "Emitted by xspec (CONF-DISC fixture): content beyond path is out of scope (CERTIFICATIONS.md §CONF-DISC).\n";

/**
 * `xspec build` (SPEC 12.1, scoped): discover, validate, and — on success —
 * write the derived files at their 13.4-classified paths: the generated
 * module `X.xspec.ts` beside each source (13.1) and, exactly when
 * `markdown.emit` is true, the emitted `X.md` (13.2, default destinations),
 * replacing whatever occupies those paths (13.4). A failing build (findings,
 * exit 1) writes nothing (12.1).
 */
async function commandBuild(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const ws = await loadWorkspace(cwd, flags["--config"]);
  if (ws.findings.length > 0) {
    throw new FindingsError(ws.findings);
  }
  for (const rel of ws.files.keys()) {
    const stem = rel.slice(0, -".mdx".length);
    const moduleRel = stem + ".xspec.ts";
    await fsp.writeFile(
      path.join(ws.config.root, ...moduleRel.split("/")),
      GENERATED_MODULE_CONTENT,
      "utf8",
    );
    if (ws.config.emit) {
      const mdRel = stem + ".md";
      await fsp.writeFile(
        path.join(ws.config.root, ...mdRel.split("/")),
        EMITTED_MARKDOWN_CONTENT,
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
 * `xspec ids` (SPEC 12.3, scoped): requirement IDs grouped by file — files
 * in byte order of workspace-relative path, IDs within a file in document
 * order. Recomputes from sources (13.3's refresh, storage-free: graph data
 * is unobservable in this scope); when the current sources fail build
 * validation, reports the validation errors and exits 1 without answering
 * and without modifying anything (13.3).
 */
async function commandIds(io, cwd, argv) {
  const { flags } = parseArgs(argv, READ_FLAGS, [0, 0]);
  const ws = await loadWorkspace(cwd, flags["--config"]);
  if (ws.findings.length > 0) {
    throw new FindingsError(ws.findings);
  }
  const files = [];
  for (const [rel, record] of ws.files) {
    files.push({
      file: rel,
      ids: record.sections.map((section) => section.id),
    });
  }
  if (flags["--json"]) {
    io.stdout(canonicalJson({ files }) + "\n");
  } else {
    io.stdout(
      files
        .map(
          (entry) =>
            `${entry.file}\n` + entry.ids.map((id) => `  ${id}\n`).join(""),
        )
        .join(""),
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry: deviation seam + dispatch
// ---------------------------------------------------------------------------

/**
 * Run one xspec invocation. Returns the exit code (SPEC 12.0 partition).
 * `options` is the seam through which each violator fixture's bin-<name>.mjs
 * entry threads exactly one deviation switch (the conformer's bin.mjs passes
 * none); see the `deviations` doc above for where CERT-15/16/17 hook.
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
      case "ids":
        return await commandIds(io, cwd, rest);
      default:
        throw new UsageError(
          `unknown command ${String(command)} (SPEC 12.0; this fixture's surface is build and ids, CERTIFICATIONS.md §CONF-DISC)`,
        );
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
