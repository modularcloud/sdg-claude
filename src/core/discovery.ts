// Source discovery — the pure half: group matching, derived-file
// exclusions, and path validation (SPEC 7, 7.1–7.3, 13.4).
//
// SPEC 7: discovery of source files is controlled exclusively by
// configuration — each configured spec or code group's globs (compiled in
// plain mode, ./glob.ts) are applied to workspace-relative paths, matched
// as their UTF-8 bytes; imports resolve references between files but never
// add files to the workspace (2.1). A file MAY belong to multiple groups;
// a group matching no files, and a `specs` or `code` map with no groups,
// are valid and simply yield fewer, possibly zero, sources.
//
// This module classifies candidate files — the workspace-relative byte
// paths of plain, symlink-free files, produced by the walk in
// src/workspace/discovery.ts (or any other symlink-free file listing, e.g.
// a git tree at a baseline ref, SPEC 6.3) — and is pure and deterministic
// (IMPLEMENTATION Architecture): output order depends only on the byte
// order of the candidate paths and the configuration's written group order.

import type { Configuration, ConfiguredGroup } from "./config.js";
import type { Finding } from "./findings.js";

const SLASH = 0x2f; // "/"
const HASH = 0x23; // "#" — reserved by node identities (SPEC 1.5)

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8Decoder = new TextDecoder("utf-8");

/** SPEC 13.4: derived-file name marker — `.xspec.` within the file name. */
const XSPEC_NAME_INFIX = utf8Encoder.encode(".xspec.");
/** SPEC 13.4/13.3: the workspace-root graph-data directory prefix. */
const XSPEC_DIR_PREFIX = utf8Encoder.encode(".xspec/");
/** SPEC 7.1: every spec-group match must have the `.mdx` extension. */
const MDX_SUFFIX = utf8Encoder.encode(".mdx");

/** One discovered source file of one kind (spec or code). */
export interface DiscoveredSource {
  /**
   * Workspace-relative `/`-separated path (SPEC 1.5). Valid discovered
   * sources always have UTF-8-valid, `#`-free paths (SPEC 7 → 14.19), so
   * the string form re-encodes to the exact matched bytes.
   */
  readonly path: string;
  /**
   * Names of the configured groups of this source's kind whose globs match
   * the path, in the configuration's written group order (SPEC 7: a file
   * MAY belong to multiple groups). Never empty.
   */
  readonly groups: readonly string[];
}

/** The classified discovery outcome, all lists byte-ordered (SPEC 12.0). */
export interface SourceClassification {
  /** Valid discovered spec sources, byte-ordered by path. */
  readonly specSources: readonly DiscoveredSource[];
  /** Valid discovered code sources, byte-ordered by path. */
  readonly codeSources: readonly DiscoveredSource[];
  /**
   * Discovery-level conditions, as data: 14.14 for a file matched by both
   * a spec and a code group (SPEC 7.2; usage class — it precedes all
   * source analysis, SPEC 14) and 14.19 for invalid source paths (SPEC 7,
   * 7.1). Ordered by the offending path's bytes, then condition order. A
   * file with any finding here is no source: it appears in neither list.
   */
  readonly findings: readonly Finding[];
}

/** Three-way lexicographic comparison of two byte arrays (SPEC 12.0). */
function compareByteArrays(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const shorter = Math.min(a.length, b.length);
  for (let index = 0; index < shorter; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function bytesStartWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function bytesEndWith(bytes: Uint8Array, suffix: Uint8Array): boolean {
  const offset = bytes.length - suffix.length;
  if (offset < 0) return false;
  for (let index = 0; index < suffix.length; index += 1) {
    if (bytes[offset + index] !== suffix[index]) return false;
  }
  return true;
}

function bytesInclude(bytes: Uint8Array, sequence: Uint8Array): boolean {
  const last = bytes.length - sequence.length;
  outer: for (let start = 0; start <= last; start += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[start + index] !== sequence[index]) continue outer;
    }
    return true;
  }
  return false;
}

function bytesContainByte(bytes: Uint8Array, byte: number): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === byte) return true;
  }
  return false;
}

/** The final path segment — the file name (paths never end with `/`). */
function fileNameOf(path: Uint8Array): Uint8Array {
  let lastSlash = -1;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === SLASH) lastSlash = index;
  }
  return path.subarray(lastSlash + 1);
}

/**
 * An injective string key for a byte path (one UTF-16 code unit per byte),
 * for exact byte-path set membership. Never rendered anywhere.
 */
function byteKey(bytes: Uint8Array): string {
  let key = "";
  for (let index = 0; index < bytes.length; index += 1) {
    key += String.fromCharCode(bytes[index]);
  }
  return key;
}

/** The decoded path, or null when the bytes are not valid UTF-8 (SPEC 7). */
function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The configured groups whose globs match the path, in written order
 * (SPEC 7: matching is byte-wise against the workspace-relative path).
 */
function matchingGroupNames(
  groups: readonly ConfiguredGroup[],
  path: Uint8Array,
): string[] {
  const names: string[] = [];
  for (const group of groups) {
    if (group.globs.some((glob) => glob.matches(path))) {
      names.push(group.name);
    }
  }
  return names;
}

/**
 * SPEC 7.3: the validated `markdown.outDir` (resolves within the workspace
 * root) reduced to its canonical workspace-relative prefix, trailing `/`
 * included — or null when absent or naming the root itself (default
 * placement next to each source).
 */
export function canonicalOutDirPrefix(
  outDir: string | undefined,
): string | null {
  if (outDir === undefined) return null;
  const kept: string[] = [];
  for (const segment of outDir.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      kept.pop(); // validated to resolve within the root (SPEC 7.3, 14.14)
      continue;
    }
    kept.push(segment);
  }
  if (kept.length === 0) return null;
  return kept.join("/") + "/";
}

/** The byte encoding of `canonicalOutDirPrefix` for the byte-wise matcher. */
function outDirPrefixBytes(outDir: string | undefined): Uint8Array | null {
  const prefix = canonicalOutDirPrefix(outDir);
  return prefix === null ? null : utf8Encoder.encode(prefix);
}

/**
 * SPEC 7.3/13.2: the configured Markdown emit destinations of the given
 * discovered spec sources — the paths at which they emit (`NAME.mdx` →
 * `NAME.md`), placed per `markdown.outDir` preserving workspace-relative
 * paths. Destinations exist exactly while `markdown` is present with `emit`
 * true; otherwise the set is empty (SPEC 7.3). `specSourcePaths` are
 * discovered spec-source paths (always `.mdx`, SPEC 7.1), as strings —
 * valid discovered paths re-encode to their exact bytes (SPEC 7), so
 * string equality on these destinations is byte equality.
 */
export function markdownEmitDestinations(
  configuration: Configuration,
  specSourcePaths: Iterable<string>,
): ReadonlySet<string> {
  const destinations = new Set<string>();
  const markdown = configuration.markdown;
  if (markdown === undefined || !markdown.emit) return destinations;
  const prefix = canonicalOutDirPrefix(markdown.outDir) ?? "";
  for (const path of specSourcePaths) {
    // SPEC 13.2: `NAME.mdx` emits `NAME.md` — the trailing "x" dropped.
    destinations.add(prefix + path.slice(0, -1));
  }
  return destinations;
}

/** Why a path is a derived-file path (SPEC 13.4). */
export type DerivedPathKind =
  "xspec-name" | "xspec-dir" | "markdown-destination";

/**
 * SPEC 13.4: classify a workspace-relative `/`-separated path as a
 * derived-file path — a file name containing `.xspec.`, a path under
 * `.xspec/`, or a configured Markdown emit destination
 * (`markdownEmitDestinations`) — or null when it is none. The string-level
 * companion of the byte-wise exclusions in `classifySources`; the
 * TypeScript module-linking rule (SPEC 4 → 14.15) classifies resolved
 * import specifiers with it.
 */
export function derivedFilePathKind(
  path: string,
  markdownDestinations: ReadonlySet<string>,
): DerivedPathKind | null {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName.includes(".xspec.")) return "xspec-name";
  if (path.startsWith(".xspec/")) return "xspec-dir";
  if (markdownDestinations.has(path)) return "markdown-destination";
  return null;
}

/**
 * SPEC 13.2/7.3: `NAME.mdx` emits `NAME.md` — dropping the trailing `x` —
 * placed per `markdown.outDir` preserving workspace-relative paths; the
 * default emits next to each source. Returns the destination's byte key.
 */
function emitDestinationKey(
  source: Uint8Array,
  outDirPrefix: Uint8Array | null,
): string {
  const destination = source.subarray(0, source.length - 1);
  return outDirPrefix === null
    ? byteKey(destination)
    : byteKey(outDirPrefix) + byteKey(destination);
}

/** A glob-matched candidate surviving the static SPEC 13.4 exclusions. */
interface MatchedCandidate {
  readonly bytes: Uint8Array;
  readonly specGroups: readonly string[];
  readonly codeGroups: readonly string[];
  readonly isMdx: boolean;
}

/**
 * Classify candidate files into discovered spec and code sources
 * (SPEC 7). `candidates` are workspace-relative byte paths of plain files
 * — symlink-free by the walk's contract (SPEC 7) — each path unique.
 *
 * Order of rules, per file:
 *
 * 1. Group matching (SPEC 7): a file no group's globs match is not
 *    discovered — no source, no finding.
 * 2. Derived-file exclusion (SPEC 13.4): paths whose file name contains
 *    `.xspec.`, paths under `.xspec/`, and — exactly while `markdown` is
 *    present with `emit` true (SPEC 7.3) — the configured Markdown emit
 *    destinations of the discovered spec sources (13.2) are excluded from
 *    every spec and code group, silently: they are never sources and no
 *    path condition is reported against them (whether or not emission has
 *    yet run — classification is by configuration alone, SPEC 7.3).
 * 3. Path validation on what remains: matched by both a spec and a code
 *    group → configuration error (SPEC 7.2, 14.14); a path containing `#`
 *    or not valid UTF-8 → 14.19 (SPEC 7); a spec-group match without the
 *    `.mdx` extension → 14.19 (SPEC 7.1). Each condition present is
 *    reported (SPEC 14).
 */
export function classifySources(
  candidates: readonly Uint8Array[],
  configuration: Configuration,
): SourceClassification {
  const sorted = [...candidates].sort(compareByteArrays);
  const matched: MatchedCandidate[] = [];
  for (const bytes of sorted) {
    // SPEC 7: discovery is controlled exclusively by configuration — a
    // file enters only through a configured group's globs (imports never
    // add files, SPEC 2.1).
    const specGroups = matchingGroupNames(configuration.specGroups, bytes);
    const codeGroups = matchingGroupNames(configuration.codeGroups, bytes);
    if (specGroups.length === 0 && codeGroups.length === 0) continue;
    // SPEC 13.4: derived files are never sources — `.xspec.`-bearing file
    // names and files under `.xspec/` are excluded from every group.
    if (bytesInclude(fileNameOf(bytes), XSPEC_NAME_INFIX)) continue;
    if (bytesStartWith(bytes, XSPEC_DIR_PREFIX)) continue;
    matched.push({
      bytes,
      specGroups,
      codeGroups,
      isMdx: bytesEndWith(bytes, MDX_SUFFIX),
    });
  }

  // SPEC 7.3: the configured Markdown emit destinations exist exactly while
  // emission is enabled — with `markdown` present and `emit` true they are
  // the paths at which the discovered spec sources emit (13.2); with
  // `markdown` absent or `emit` false, no path is a destination.
  const destinationKeys = new Set<string>();
  const markdown = configuration.markdown;
  if (markdown !== undefined && markdown.emit) {
    const outDirPrefix = outDirPrefixBytes(markdown.outDir);
    for (const candidate of matched) {
      if (candidate.specGroups.length > 0 && candidate.isMdx) {
        destinationKeys.add(emitDestinationKey(candidate.bytes, outDirPrefix));
      }
    }
  }

  const specSources: DiscoveredSource[] = [];
  const codeSources: DiscoveredSource[] = [];
  const findings: Finding[] = [];
  for (const candidate of matched) {
    if (destinationKeys.has(byteKey(candidate.bytes))) continue;
    const decoded = decodeStrict(candidate.bytes);
    // Findings name the file by its decoded workspace-relative path; a
    // non-UTF-8 path has no exact string spelling, so it renders lossily
    // (U+FFFD) — SPEC.md fixes no spelling for it.
    const fileLabel = decoded ?? lossyUtf8Decoder.decode(candidate.bytes);
    let valid = true;
    if (candidate.specGroups.length > 0 && candidate.codeGroups.length > 0) {
      // SPEC 7.2 → 14.14: a file matched by both a spec and a code group
      // is a configuration error (usage class; precedes source analysis).
      valid = false;
      findings.push({
        condition: 14,
        file: fileLabel,
        message:
          `matched by both spec group "${candidate.specGroups[0]}" and ` +
          `code group "${candidate.codeGroups[0]}" — a configuration ` +
          `error: adjust the configured globs so no file belongs to both ` +
          `a spec and a code group (SPEC 7.2, 14.14)`,
      });
    }
    if (bytesContainByte(candidate.bytes, HASH)) {
      // SPEC 7 → 14.19: `#` is reserved by node identities (SPEC 1.5).
      valid = false;
      findings.push({
        condition: 19,
        file: fileLabel,
        message:
          `the workspace-relative path contains "#", which node ` +
          `identities reserve (path#id) — rename the file to a "#"-free ` +
          `path (SPEC 7, 1.5, 14.19)`,
      });
    }
    if (decoded === null) {
      // SPEC 7 → 14.19: paths are matched as UTF-8 bytes; a discovered
      // path that is not valid UTF-8 is invalid.
      valid = false;
      findings.push({
        condition: 19,
        file: fileLabel,
        message:
          `the workspace-relative path is not valid UTF-8 — rename the ` +
          `file to a valid UTF-8 path (SPEC 7, 14.19)`,
      });
    }
    if (candidate.specGroups.length > 0 && !candidate.isMdx) {
      // SPEC 7.1 → 14.19: every spec-group match MUST end `.mdx`.
      valid = false;
      findings.push({
        condition: 19,
        file: fileLabel,
        message:
          `matched by spec group "${candidate.specGroups[0]}" but the ` +
          `file does not have the .mdx extension — every spec-group match ` +
          `must end ".mdx"; rename the file or narrow the group's globs ` +
          `(SPEC 7.1, 14.19)`,
      });
    }
    if (!valid || decoded === null) continue;
    if (candidate.specGroups.length > 0) {
      specSources.push({ path: decoded, groups: candidate.specGroups });
    } else {
      codeSources.push({ path: decoded, groups: candidate.codeGroups });
    }
  }
  return { specSources, codeSources, findings };
}
