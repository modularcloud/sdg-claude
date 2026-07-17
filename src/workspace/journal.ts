// Journal storage — the I/O half (SPEC 6.1, 13.4; IMPLEMENTATION
// Architecture: journal storage is workspace-layer I/O).
//
// The journal lives at `.xspec/journal` under the workspace root. It is a
// durable file (SPEC 13.4): written only by `xspec rename` and `xspec move`
// — every other command at most reads it — never regenerated, and never
// modified or deleted by other commands. An absent file is an empty journal
// (SPEC 6.1). A journal path occupied by anything other than a plain file —
// a symbolic link included — is never read, appended to, or replaced: it is
// a journal error (SPEC 13.4 → 14.13).
//
// Parsing, validation, and the canonical-identity walk are the pure core's
// (src/core/journal.ts); this module only classifies the occupant, reads
// bytes, and appends canonical lines.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Finding } from "../core/findings.js";
import type { JournalEntry, PositionedJournalEntry } from "../core/journal.js";
import {
  Journal,
  JOURNAL_PATH,
  parseJournal,
  serializeJournalEntry,
} from "../core/journal.js";

/** What occupies the journal's path (SPEC 6.1, 13.4). */
export type JournalFileState = "absent" | "plain" | "occupied";

/** The loaded journal: parse results plus the file-state classification. */
export interface LoadedJournal {
  readonly fileState: JournalFileState;
  /**
   * The walkable journal over the parsed entries. Meaningful for canonical
   * identities and replay only when `findings` is empty — a journal error
   * fails workspace validation before identities are ever used (SPEC 14).
   */
  readonly journal: Journal;
  readonly entries: readonly PositionedJournalEntry[];
  /** The journal's 14.13 findings: bad lines, or a non-plain-file occupant. */
  readonly findings: readonly Finding[];
}

/** The journal's absolute path under the workspace root. */
function journalAbsolutePath(root: string): string {
  return path.join(root, ".xspec", "journal");
}

/**
 * Load the workspace's journal (SPEC 6.1): an absent file is an empty
 * journal; a plain file is parsed and validated (core); anything else at the
 * path — symbolic link, directory, or other non-plain occupant — is never
 * read and reports a journal error (SPEC 13.4 → 14.13). Classification uses
 * lstat, so a symbolic link is judged itself, never through its target.
 */
export async function loadJournal(root: string): Promise<LoadedJournal> {
  const absolute = journalAbsolutePath(root);
  let stats;
  try {
    stats = await fsp.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        fileState: "absent",
        journal: new Journal([]),
        entries: [],
        findings: [],
      };
    }
    throw error;
  }
  if (!stats.isFile()) {
    const occupant = stats.isSymbolicLink()
      ? "a symbolic link"
      : stats.isDirectory()
        ? "a directory"
        : "a non-plain file";
    const finding: Finding = {
      condition: 13,
      file: JOURNAL_PATH,
      message:
        `journal error: the journal path ${JOURNAL_PATH} is occupied by ` +
        `${occupant}, not a plain file — a durable file's path occupied by ` +
        `anything other than a plain file is never read, appended to, or ` +
        `replaced (SPEC 6.1, 13.4); remove the occupant and restore the ` +
        `journal as a plain file from version control (SPEC 14.13)`,
    };
    return {
      fileState: "occupied",
      journal: new Journal([]),
      entries: [],
      findings: [finding],
    };
  }
  const parsed = parseJournal(await fsp.readFile(absolute));
  return {
    fileState: "plain",
    journal: new Journal(parsed.entries),
    entries: parsed.entries,
    findings: parsed.findings,
  };
}

/**
 * Append one entry to the journal as its canonical line (SPEC 6.1:
 * append-only, one entry per line, byte-deterministic; the file comes into
 * existence with the first journaled operation). Callers are `rename` and
 * `move` only, running under workspace exclusivity (SPEC 13.5) and after
 * full workspace validation (SPEC 6.4) — so an occupied journal path or a
 * tampered `.xspec` component has already refused the operation as a
 * finding, and the guards here are terminal defenses, thrown as errors
 * rather than carried as findings.
 */
export async function appendJournalEntry(
  root: string,
  entry: JournalEntry,
): Promise<void> {
  const directory = path.join(root, ".xspec");
  let directoryStats;
  try {
    directoryStats = await fsp.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    directoryStats = null;
  }
  if (directoryStats === null) {
    await fsp.mkdir(directory, { recursive: true });
  } else if (directoryStats.isSymbolicLink()) {
    // SPEC 13.4 → 14.22: writes never traverse symbolic links — a symbolic
    // link at a workspace-relative directory component of a write path
    // refuses the write.
    throw new Error(
      `cannot append to the journal: .xspec is a symbolic link — writes ` +
        `never traverse symbolic links (SPEC 13.4, 14.22)`,
    );
  } else if (!directoryStats.isDirectory()) {
    throw new Error(
      `cannot append to the journal: .xspec exists and is not a directory`,
    );
  }
  const absolute = journalAbsolutePath(root);
  let occupantStats;
  try {
    occupantStats = await fsp.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    occupantStats = null;
  }
  if (occupantStats !== null && !occupantStats.isFile()) {
    // SPEC 13.4: a durable file's path occupied by anything other than a
    // plain file is never appended to (a symbolic link included — never
    // written through).
    throw new Error(
      `cannot append to the journal: ${JOURNAL_PATH} is not a plain file ` +
        `(SPEC 6.1, 13.4)`,
    );
  }
  const line = Buffer.from(serializeJournalEntry(entry) + "\n", "utf8");
  // One O_APPEND write of the whole line: concurrent readers see the prior
  // content or the complete new line (SPEC 13.5), and line-oriented appends
  // merge textually (SPEC 13.4).
  const handle = await fsp.open(absolute, "a");
  try {
    let written = 0;
    while (written < line.length) {
      const result = await handle.write(line, written);
      written += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}
