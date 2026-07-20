// Baseline reconstruction from git (SPEC 6.3).
//
// SPEC 6.3: when a command takes a baseline git ref, the baseline graph is
// reconstructed from the workspace content at that ref — sources and
// configuration alike, so group membership reflects the configuration as
// it stood at the ref. The journal content at the ref is the baseline
// journal (absent = empty; an empty journal is a prefix of every journal),
// and baseline hashes are computed with it. The journal entries present in
// the current journal but absent from the journal content at the baseline
// ref are applied, in file order, to map baseline identities to current
// identities — chained mappings compose (core/journal.ts,
// `computeJournalReplay`). If replay produces an ambiguous or unresolvable
// mapping, if the baseline journal is not a prefix of the current journal,
// or if the baseline content cannot be parsed and validated as a
// workspace, resolution fails with an actionable error naming the
// offending entries or files; a baseline that cannot be read or
// reconstructed is a usage error — exit 2 (SPEC 12.0). Baseline resolution
// precedes source validation (SPEC 12.0): callers resolve the baseline
// before analyzing the current sources, so an unresolvable baseline is
// reported as a usage error even when the current sources also fail build
// validation.
//
// IMPLEMENTATION (Key libraries, Architecture): the system `git`
// executable via read-only plumbing subcommands only — `rev-parse`,
// `ls-tree`, `cat-file` (./git.ts) — and the same pure core the filesystem
// pipeline composes (classification, parsing, validation, hashing), over
// bytes read from the ref's tree (pipeline.ts `analyzeWorkspaceContent`):
// the baseline analysis and the current analysis can never drift apart.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { classifySources } from "../core/discovery.js";
import type { Finding } from "../core/findings.js";
import type { Journal } from "../core/journal.js";
import { computeJournalReplay, JOURNAL_PATH } from "../core/journal.js";
import type { LoadedWorkspace } from "./config.js";
import { parseConfigurationBytes } from "./config.js";
import { runGit } from "./git.js";
import { journalFromBytes, occupiedJournal } from "./journal.js";
import type { WorkspaceAnalysis } from "./pipeline.js";
import { analyzeWorkspaceContent } from "./pipeline.js";
import type { PathOccupant } from "./writes.js";
import { classifyOccupant, describeOccupant } from "./writes.js";

/** A successfully reconstructed baseline (SPEC 6.3). */
export interface ResolvedBaseline {
  /** The full hash of the commit the ref resolved to. */
  readonly commit: string;
  /**
   * The baseline workspace's analysis — graph, text model, and hashes
   * computed with the baseline journal (SPEC 6.3). Validated: `findings`
   * and `configurationErrors` are empty.
   */
  readonly analysis: WorkspaceAnalysis;
  /**
   * SPEC 6.3: the journal entries present in the current journal but
   * absent from the journal content at the baseline ref, as a walkable
   * Journal — `mapForward` maps a baseline identity to its current
   * identity, composing chained mappings.
   */
  readonly replay: Journal;
}

/** The outcome of baseline resolution (SPEC 6.3). */
export type BaselineResolution =
  | { readonly ok: true; readonly baseline: ResolvedBaseline }
  | {
      /**
       * SPEC 6.3 → 12.0: the baseline cannot be read or reconstructed — a
       * usage error. `message` is the actionable diagnostic naming the
       * offending entries or files; callers report it on standard error
       * and exit 2, before source validation of the current workspace.
       */
      readonly ok: false;
      readonly message: string;
    };

function failure(message: string): BaselineResolution {
  return { ok: false, message };
}

const LF = 0x0a;
const NUL = 0x00;
const TAB = 0x09;

/** One `git ls-tree -r` record: mode, object name, and raw path bytes. */
interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: Buffer;
}

/**
 * Parse `git ls-tree -r -z` output: NUL-terminated records of
 * `<mode> SP <type> SP <oid> TAB <path>`, the path as raw bytes (`-z`
 * disables quoting).
 */
function parseTreeListing(stdout: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < stdout.length) {
    const terminator = stdout.indexOf(NUL, offset);
    const end = terminator === -1 ? stdout.length : terminator;
    if (end > offset) {
      const record = stdout.subarray(offset, end);
      const tab = record.indexOf(TAB);
      if (tab === -1) {
        throw new Error("xspec internal error: malformed git ls-tree record");
      }
      const header = record.subarray(0, tab).toString("utf8").split(" ");
      if (header.length < 3) {
        throw new Error("xspec internal error: malformed git ls-tree header");
      }
      entries.push({
        mode: header[0],
        oid: header[2],
        path: record.subarray(tab + 1),
      });
    }
    offset = end + 1;
  }
  return entries;
}

/**
 * Read blob objects by name through one `git cat-file --batch` run — a
 * read-only plumbing bulk read. Returns the content bytes per object name,
 * or `null` when any object cannot be read as a blob (repository
 * corruption, a shallow clone missing objects).
 */
async function readBlobs(
  cwd: string,
  oids: readonly string[],
): Promise<Map<string, Uint8Array> | null> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Uint8Array>();
  if (unique.length === 0) return blobs;
  const result = await runGit(
    cwd,
    ["cat-file", "--batch"],
    Buffer.from(unique.join("\n") + "\n", "utf8"),
  );
  if (!result.ok) return null;
  // Batch response per requested name: `<oid> SP <type> SP <size> LF`
  // followed by <size> raw content bytes and a closing LF; a missing
  // object answers `<name> SP missing LF` instead.
  const stdout = result.stdout;
  let offset = 0;
  for (const oid of unique) {
    const headerEnd = stdout.indexOf(LF, offset);
    if (headerEnd === -1) return null;
    const header = stdout.subarray(offset, headerEnd).toString("utf8");
    const parts = header.split(" ");
    if (parts.length !== 3 || parts[1] !== "blob") return null;
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const start = headerEnd + 1;
    if (start + size > stdout.length) return null;
    blobs.set(oid, stdout.subarray(start, start + size));
    offset = start + size + 1; // past the content's closing LF
  }
  return blobs;
}

/** An injective per-byte string key for raw path bytes (never rendered). */
function byteKey(bytes: Buffer): string {
  return bytes.toString("latin1");
}

function bufferStartsWith(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

/**
 * SPEC 6.3: "cannot be parsed and validated as a workspace" — the baseline
 * content's findings rendered into one actionable usage-error message
 * naming the offending files (SPEC 12.0: standard-error content, so the
 * rendering is local to this diagnostic, not the report renderer's).
 */
function invalidBaselineMessage(
  ref: string,
  findings: readonly Finding[],
): string {
  const lines = findings.map((finding) => {
    const file = finding.file === undefined ? "" : `${finding.file}: `;
    const correction =
      finding.correction === undefined ? "" : ` — ${finding.correction}`;
    return `\n  ${file}${finding.message}${correction}`;
  });
  return (
    `the workspace content at baseline ref '${ref}' cannot be parsed and ` +
    `validated as a workspace (SPEC 6.3, 12.0):${lines.join("")}`
  );
}

/**
 * Resolve a baseline git ref (SPEC 6.3): reconstruct and validate the
 * workspace content as it stood at the ref — sources, configuration, and
 * journal — and compute the replay mapping from baseline identities to
 * current identities. Reads the repository through read-only git plumbing
 * and the current journal from the filesystem; modifies nothing.
 *
 * Callers run this before analyzing the current sources: baseline
 * resolution precedes source validation (SPEC 12.0), and every failure
 * here is a usage error (exit 2) with `message` as the standard-error
 * diagnostic.
 */
export async function resolveBaseline(
  workspace: LoadedWorkspace,
  ref: string,
): Promise<BaselineResolution> {
  const { root, configFileName } = workspace;

  // --- locate the workspace within its repository -----------------------
  const prefixResult = await runGit(root, ["rev-parse", "--show-prefix"]);
  if (!prefixResult.ok) {
    if (prefixResult.kind === "unavailable") {
      return failure(
        `cannot reconstruct the baseline at ref '${ref}': the 'git' ` +
          `executable was not found — the baseline is the workspace ` +
          `content at the ref, read through git (SPEC 6.3); install git ` +
          `and re-run`,
      );
    }
    return failure(
      `cannot reconstruct the baseline at ref '${ref}': the workspace ` +
        `root is not inside a git work tree — the baseline is the ` +
        `workspace content at the ref, read from the repository ` +
        `containing the workspace (SPEC 6.3)`,
    );
  }
  const prefix = prefixResult.stdout
    .toString("utf8")
    .replace(/\n$/, "")
    .replace(/\/$/, "");

  // --- resolve the ref to a commit (SPEC 6.3, 12.0) ---------------------
  const commitResult = await runGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!commitResult.ok) {
    return failure(
      `the baseline ref '${ref}' does not resolve to a commit in the ` +
        `repository containing the workspace — pass a git ref naming a ` +
        `commit (a branch, tag, or commit hash) whose workspace content ` +
        `should serve as the baseline (SPEC 6.3, 12.0)`,
    );
  }
  const commit = commitResult.stdout.toString("utf8").trim();

  // --- the workspace directory's tree at that commit --------------------
  const treeResult = await runGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    prefix === "" ? `${commit}^{tree}` : `${commit}:${prefix}`,
  ]);
  if (!treeResult.ok) {
    return failure(
      `the workspace directory '${prefix}' does not exist at baseline ` +
        `ref '${ref}' — the baseline is reconstructed from the workspace ` +
        `content at the ref (SPEC 6.3)`,
    );
  }
  const tree = treeResult.stdout.toString("utf8").trim();
  // `--full-tree` keeps the listing complete regardless of the working
  // directory git infers a pathspec prefix from.
  const listing = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    tree,
  ]);
  if (!listing.ok) {
    return failure(
      `the workspace content at baseline ref '${ref}' cannot be listed — ` +
        `'${prefix === "" ? "." : prefix}' is not a directory at that ref ` +
        `(SPEC 6.3)`,
    );
  }

  // --- classify the ref's files (SPEC 6.3: configuration at the ref) ----
  const entries = parseTreeListing(listing.stdout);
  const configPathBytes = Buffer.from(configFileName, "utf8");
  const journalPathBytes = Buffer.from(JOURNAL_PATH, "utf8");
  const journalDirBytes = Buffer.from(JOURNAL_PATH + "/", "utf8");
  const files: Buffer[] = [];
  const oidByPath = new Map<string, string>();
  let configOid: string | undefined;
  let configIrregular = false;
  let journalOid: string | undefined;
  let journalOccupant: PathOccupant | undefined;
  for (const entry of entries) {
    // SPEC 7: discovery never follows symbolic links — a symlink entry
    // (mode 120000), like a submodule (160000), is never a source; only
    // regular blobs (100644/100755) are candidate files.
    const regular = entry.mode === "100644" || entry.mode === "100755";
    if (entry.path.equals(configPathBytes)) {
      if (regular) configOid = entry.oid;
      else configIrregular = true;
    }
    if (entry.path.equals(journalPathBytes)) {
      // SPEC 6.1/13.4 → 14.13: a journal path occupied by anything other
      // than a plain file is never read.
      if (regular) journalOid = entry.oid;
      else journalOccupant = entry.mode === "120000" ? "symlink" : "other";
    } else if (bufferStartsWith(entry.path, journalDirBytes)) {
      journalOccupant = "directory";
    }
    if (regular) {
      files.push(entry.path);
      oidByPath.set(byteKey(entry.path), entry.oid);
    }
  }

  if (configOid === undefined) {
    return failure(
      configIrregular
        ? `the configuration file '${configFileName}' is not a regular ` +
            `file in the workspace content at baseline ref '${ref}' ` +
            `(SPEC 6.3, 7)`
        : `the configuration file '${configFileName}' does not exist in ` +
            `the workspace content at baseline ref '${ref}' — the ` +
            `baseline graph is reconstructed with the configuration as ` +
            `it stood at the ref (SPEC 6.3, 7)`,
    );
  }

  const unreadable = failure(
    `the workspace content at baseline ref '${ref}' cannot be read from ` +
      `the repository — git object reads failed; the repository may be ` +
      `corrupt or a shallow clone missing the ref's objects (SPEC 6.3)`,
  );

  const primer = await readBlobs(root, [
    configOid,
    ...(journalOid === undefined ? [] : [journalOid]),
  ]);
  if (primer === null) return unreadable;
  const configBytes = primer.get(configOid);
  if (configBytes === undefined) return unreadable;

  // SPEC 6.3: the baseline configuration is the configuration content at
  // the ref — group membership reflects it, not the current configuration.
  const configParse = parseConfigurationBytes(configBytes, configFileName);
  if (!configParse.ok) {
    return failure(invalidBaselineMessage(ref, configParse.findings));
  }
  const classification = classifySources(files, configParse.configuration);

  // SPEC 6.3: the journal content at the ref; absent = empty journal.
  const baselineJournalBytes =
    journalOid === undefined ? null : (primer.get(journalOid) ?? null);
  if (journalOid !== undefined && baselineJournalBytes === null) {
    return unreadable;
  }
  const journal =
    journalOccupant !== undefined
      ? occupiedJournal(journalOccupant)
      : journalFromBytes(baselineJournalBytes);

  // --- analyze the baseline workspace (the shared pipeline body) --------
  const sourcePaths = [
    ...classification.specSources,
    ...classification.codeSources,
  ].map((source) => source.path);
  const oidForSource = new Map<string, string>();
  for (const sourcePath of sourcePaths) {
    const oid = oidByPath.get(byteKey(Buffer.from(sourcePath, "utf8")));
    if (oid === undefined) {
      // Impossible: classified sources come from the same listing.
      throw new Error(
        `xspec internal error: baseline source without a blob: ${sourcePath}`,
      );
    }
    oidForSource.set(sourcePath, oid);
  }
  const sourceBlobs = await readBlobs(root, [...oidForSource.values()]);
  if (sourceBlobs === null) return unreadable;

  const analysis = await analyzeWorkspaceContent(configParse.configuration, {
    classification,
    readSource: (rel) => {
      const oid = oidForSource.get(rel);
      const bytes = oid === undefined ? undefined : sourceBlobs.get(oid);
      if (bytes === undefined) {
        throw new Error(
          `xspec internal error: baseline blob not preloaded: ${rel}`,
        );
      }
      return Promise.resolve(bytes);
    },
    loadJournal: () => Promise.resolve(journal),
  });
  // SPEC 6.3: baseline content that cannot be parsed and validated as a
  // workspace fails resolution — configuration errors (14.14 class) and
  // validation findings alike are usage errors here (SPEC 12.0).
  if (analysis.configurationErrors.length > 0) {
    return failure(invalidBaselineMessage(ref, analysis.configurationErrors));
  }
  if (analysis.findings.length > 0) {
    return failure(invalidBaselineMessage(ref, analysis.findings));
  }

  // --- replay: current journal entries absent at the ref (SPEC 6.3) -----
  const currentJournalAbsolute = path.join(root, ".xspec", "journal");
  const occupant = await classifyOccupant(currentJournalAbsolute);
  let currentJournalBytes: Uint8Array;
  if (occupant === "absent") {
    // SPEC 6.3: a journal file absent in the current workspace is read as
    // an empty journal.
    currentJournalBytes = new Uint8Array(0);
  } else if (occupant === "file") {
    currentJournalBytes = await fsp.readFile(currentJournalAbsolute);
  } else {
    return failure(
      `the current journal ${JOURNAL_PATH} is occupied by ` +
        `${describeOccupant(occupant)}, not a plain file — the journal ` +
        `entries appended since baseline ref '${ref}' cannot be read for ` +
        `replay (SPEC 6.1, 6.3, 13.4)`,
    );
  }
  const replay = computeJournalReplay(
    baselineJournalBytes ?? new Uint8Array(0),
    currentJournalBytes,
  );
  if (!replay.ok) {
    return failure(
      `cannot map baseline identities at ref '${ref}' to current ` +
        `identities: ${replay.problem}`,
    );
  }

  return {
    ok: true,
    baseline: { commit, analysis, replay: replay.replay },
  };
}
