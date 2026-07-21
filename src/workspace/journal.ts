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
// (src/core/journal.ts); this module classifies the occupant and reads
// bytes, and its one write goes through the workspace write layer
// (writes.ts), like every product file write.

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
import type { PathOccupant } from "./writes.js";
import {
  appendDurableFile,
  classifyOccupant,
  describeOccupant,
} from "./writes.js";

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
 * The journal loaded from raw file bytes (`null` = the file is absent, an
 * empty journal, SPEC 6.1) — the I/O-free tail of `loadJournal`, shared
 * with baseline reconstruction (SPEC 6.3), which reads the journal content
 * as it stood at a git ref instead of from the filesystem.
 */
export function journalFromBytes(bytes: Uint8Array | null): LoadedJournal {
  if (bytes === null) {
    return {
      fileState: "absent",
      journal: new Journal([]),
      entries: [],
      findings: [],
    };
  }
  const parsed = parseJournal(bytes);
  return {
    fileState: "plain",
    journal: new Journal(parsed.entries),
    entries: parsed.entries,
    findings: parsed.findings,
  };
}

/**
 * The journal whose path is occupied by something other than a plain file
 * (SPEC 6.1, 13.4 → 14.13): never read — one 14.13 finding, no entries.
 * Shared with baseline reconstruction (SPEC 6.3), where the occupant is a
 * git tree entry (a symbolic link or a directory at the journal's path at
 * the ref) instead of a filesystem occupant.
 */
export function occupiedJournal(occupant: PathOccupant): LoadedJournal {
  const finding: Finding = {
    condition: 13,
    file: JOURNAL_PATH,
    message:
      `journal error: the journal path ${JOURNAL_PATH} is occupied by ` +
      `${describeOccupant(occupant)}, not a plain file — a durable file's ` +
      `path occupied by anything other than a plain file is never read, ` +
      `appended to, or replaced (SPEC 6.1, 13.4); remove the occupant ` +
      `and restore the journal as a plain file from version control ` +
      `(SPEC 14.13)`,
  };
  return {
    fileState: "occupied",
    journal: new Journal([]),
    entries: [],
    findings: [finding],
  };
}

/**
 * Load the workspace's journal (SPEC 6.1): an absent file is an empty
 * journal; a plain file is parsed and validated (core); anything else at the
 * path — symbolic link, directory, or other non-plain occupant — is never
 * read and reports a journal error (SPEC 13.4 → 14.13). Classification uses
 * lstat (writes.ts), so a symbolic link is judged itself, never through its
 * target.
 */
export async function loadJournal(root: string): Promise<LoadedJournal> {
  const absolute = journalAbsolutePath(root);
  const occupant = await classifyOccupant(absolute);
  if (occupant === "absent") {
    return journalFromBytes(null);
  }
  if (occupant !== "file") {
    return occupiedJournal(occupant);
  }
  return journalFromBytes(await fsp.readFile(absolute));
}

/**
 * The journal file's raw bytes — null when the path holds no plain file (an
 * absent journal is empty, SPEC 6.1; a non-plain occupant is never read,
 * SPEC 13.4, and the caller's validation has already reported it, 14.13).
 * `rename` and `move` read these to model the journal as it will stand
 * after their append (SPEC 6.4, 6.5: the post-operation analysis hashes
 * with the journal including the new entry, SPEC 5.4).
 */
export async function readJournalBytes(
  root: string,
): Promise<Uint8Array | null> {
  const absolute = journalAbsolutePath(root);
  if ((await classifyOccupant(absolute)) !== "file") {
    return null;
  }
  try {
    return await fsp.readFile(absolute);
  } catch {
    return null;
  }
}

/**
 * Append one entry to the journal as its canonical line (SPEC 6.1:
 * append-only, one entry per line, byte-deterministic; the file comes into
 * existence with the first journaled operation). The write goes through the
 * workspace write layer (writes.ts): one O_APPEND write of the whole line,
 * atomic in its observable effect (SPEC 13.5) and merging textually with
 * concurrent additions (SPEC 13.4). Callers are `rename` and `move` only,
 * running under workspace exclusivity (SPEC 13.5) and after full workspace
 * validation (SPEC 6.4) — an occupied journal path or a symlinked `.xspec`
 * component has already refused the operation as a finding (14.13, 14.22),
 * and the layer's own guards are the terminal defense, thrown as errors.
 */
export async function appendJournalEntry(
  root: string,
  entry: JournalEntry,
): Promise<void> {
  await appendDurableFile(
    root,
    JOURNAL_PATH,
    serializeJournalEntry(entry) + "\n",
  );
}
