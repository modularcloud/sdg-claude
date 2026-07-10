// Whole-directory byte snapshots and compares for the xspec test harness
// (TEST-SPEC H-4, H-6). Harness machinery only: no product imports.
//
// A snapshot records every entry under a directory, byte-exactly and
// normalizing nothing: regular files with their exact bytes, directories
// (empty ones included), symbolic links with their verbatim target bytes
// (never followed, never traversed — a symlinked directory is a leaf), and
// a catch-all kind for anything else. Entry names are handled as raw bytes,
// so non-UTF-8 file names (Linux staging, TEST-SPEC T1.5-2) round-trip.
// Entry permissions and timestamps are deliberately not part of a snapshot:
// H-4/H-6 assert *byte* state (file set, kinds, contents, link targets), and
// mode bits would tie compares to platform- and umask-specific metadata.
//
// Snapshots serve the modifies-nothing and compare-around-command tests
// (`assertLeavesUnchanged`, e.g. read commands never write, refused commands
// modify nothing, `.git/` untouched around git-reading invocations) and the
// H-6 determinism protocol in determinism.ts (same command twice; identical
// workspace rebuilt in two directories).

import { Buffer } from "node:buffer";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import {
  bytesEqual,
  describeByteDifference,
  HarnessAssertionError,
} from "./assertions.js";

/** One directory entry as captured by a snapshot. */
export type SnapshotEntry =
  | { readonly kind: "file"; readonly bytes: Uint8Array }
  | { readonly kind: "dir" }
  | { readonly kind: "symlink"; readonly target: Uint8Array }
  | { readonly kind: "other" };

/**
 * The byte state of a directory tree. `entries` maps the `/`-separated
 * relative path of every entry — keyed by its exact bytes, latin1-encoded so
 * non-UTF-8 names are lossless — to what occupies it, in bytewise path order.
 */
export interface DirectorySnapshot {
  readonly root: string;
  readonly entries: ReadonlyMap<string, SnapshotEntry>;
}

export interface SnapshotOptions {
  /**
   * Omit entries whose relative byte path (`/`-separated) matches; an
   * excluded directory's whole subtree is pruned.
   */
  readonly exclude?: (relPathBytes: Uint8Array) => boolean;
}

/** One difference between two snapshots ("added" = only in the second). */
export interface SnapshotChange {
  /** Exact relative path, latin1-encoded (the snapshot map key). */
  readonly key: string;
  /** Human-readable form of the relative path. */
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  readonly detail: string;
}

/**
 * Capture the byte state of the directory tree at `absDir`. The root must
 * exist and be a directory — anything else is a harness-usage error, thrown
 * as a plain `Error` (this is machinery misuse, not a product observation).
 */
export async function snapshotDirectory(
  absDir: string,
  options: SnapshotOptions = {},
): Promise<DirectorySnapshot> {
  let rootStats: Stats;
  try {
    rootStats = await fsp.stat(absDir);
  } catch (error) {
    throw new Error(
      `snapshotDirectory: cannot stat ${absDir}: ${(error as Error).message}`,
    );
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`snapshotDirectory: not a directory: ${absDir}`);
  }
  const entries = new Map<string, SnapshotEntry>();
  await walk(Buffer.from(absDir), null, entries, options.exclude);
  return { root: absDir, entries };
}

/**
 * All differences between two snapshots, in bytewise path order. "added" and
 * "removed" are relative to the second snapshot (added = present only in
 * `after`); for entries present in both, kind changes, file-byte changes
 * (diagnosed with the first differing offset), and symlink-target changes
 * are reported.
 */
export function diffSnapshots(
  before: DirectorySnapshot,
  after: DirectorySnapshot,
): SnapshotChange[] {
  const keys = [
    ...new Set([...before.entries.keys(), ...after.entries.keys()]),
  ].sort();
  const changes: SnapshotChange[] = [];
  for (const key of keys) {
    const entryBefore = before.entries.get(key);
    const entryAfter = after.entries.get(key);
    if (entryBefore === undefined && entryAfter !== undefined) {
      changes.push({
        key,
        path: displaySnapshotPath(key),
        change: "added",
        detail: `only in the second snapshot: ${describeEntry(entryAfter)}`,
      });
    } else if (entryBefore !== undefined && entryAfter === undefined) {
      changes.push({
        key,
        path: displaySnapshotPath(key),
        change: "removed",
        detail: `only in the first snapshot: ${describeEntry(entryBefore)}`,
      });
    } else if (entryBefore !== undefined && entryAfter !== undefined) {
      const detail = describeEntryDifference(entryBefore, entryAfter);
      if (detail !== undefined) {
        changes.push({
          key,
          path: displaySnapshotPath(key),
          change: "changed",
          detail,
        });
      }
    }
  }
  return changes;
}

/**
 * Assert two snapshots are byte-identical (same entry set, kinds, file bytes,
 * and link targets), failing diagnosed with every difference (H-4/H-6,
 * normalizing nothing).
 */
export function assertSnapshotsEqual(
  before: DirectorySnapshot,
  after: DirectorySnapshot,
  context: string,
): void {
  const changes = diffSnapshots(before, after);
  if (changes.length === 0) return;
  const where =
    before.root === after.root
      ? `under ${before.root}`
      : `between ${before.root} and ${after.root}`;
  throw new HarnessAssertionError(
    `${context}: ${String(changes.length)} byte-state difference(s) ${where} (H-4/H-6, normalizing nothing):\n${renderChanges(changes)}`,
  );
}

/**
 * Assert two directory trees are byte-identical — the whole-directory
 * compare of the H-6 two-directory protocol and of exchanged-output
 * comparisons (relative paths make this well-defined across directories).
 */
export async function assertDirectoriesEqual(
  dirFirst: string,
  dirSecond: string,
  context: string,
  options: SnapshotOptions = {},
): Promise<void> {
  const first = await snapshotDirectory(dirFirst, options);
  const second = await snapshotDirectory(dirSecond, options);
  assertSnapshotsEqual(first, second, context);
}

/**
 * The compare-around-command protocol: snapshot `absDir`, run `action`,
 * snapshot again, and assert nothing changed — for modifies-nothing
 * assertions (read commands never write; refused commands modify nothing;
 * `.git/` byte-identical around git-reading invocations, T12.0-11). Returns
 * the action's result so the caller can go on asserting it.
 */
export async function assertLeavesUnchanged<T>(
  absDir: string,
  action: () => Promise<T> | T,
  context: string,
  options: SnapshotOptions = {},
): Promise<T> {
  const before = await snapshotDirectory(absDir, options);
  const result = await action();
  const after = await snapshotDirectory(absDir, options);
  assertSnapshotsEqual(before, after, `${context} (modifies-nothing compare)`);
  return result;
}

/** Human-readable rendering of a snapshot key (hex for non-UTF-8 names). */
export function displaySnapshotPath(key: string): string {
  const bytes = Buffer.from(key, "latin1");
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) return text;
  return `<path bytes ${bytes.toString("hex")}>`;
}

/** One-line description of an entry (kind, size, target). */
export function describeEntry(entry: SnapshotEntry): string {
  switch (entry.kind) {
    case "file":
      return `file (${String(entry.bytes.length)} bytes)`;
    case "dir":
      return "directory";
    case "symlink":
      return `symlink → ${JSON.stringify(Buffer.from(entry.target).toString("utf8"))}`;
    case "other":
      return "other entry (not a file, directory, or symlink)";
  }
}

/**
 * How two same-path entries differ, or undefined when byte-identical.
 * Exported for the determinism protocol's written-file compares.
 */
export function describeEntryDifference(
  before: SnapshotEntry,
  after: SnapshotEntry,
): string | undefined {
  if (before.kind !== after.kind) {
    return `kind changed: ${before.kind} → ${after.kind}`;
  }
  if (before.kind === "file" && after.kind === "file") {
    if (!bytesEqual(before.bytes, after.bytes)) {
      return `file bytes differ:\n${describeByteDifference(before.bytes, after.bytes, "first", "second")}`;
    }
  }
  if (before.kind === "symlink" && after.kind === "symlink") {
    if (!bytesEqual(before.target, after.target)) {
      return `symlink target changed: ${JSON.stringify(Buffer.from(before.target).toString("utf8"))} → ${JSON.stringify(Buffer.from(after.target).toString("utf8"))}`;
    }
  }
  return undefined;
}

const MAX_RENDERED_CHANGES = 25;
const SLASH_BUF = Buffer.from([0x2f]); // "/"

function renderChanges(changes: readonly SnapshotChange[]): string {
  const lines = changes
    .slice(0, MAX_RENDERED_CHANGES)
    .map(
      (change) =>
        `  - ${change.change} ${change.path}: ${change.detail.split("\n").join("\n    ")}`,
    );
  if (changes.length > MAX_RENDERED_CHANGES) {
    lines.push(`  … and ${String(changes.length - MAX_RENDERED_CHANGES)} more`);
  }
  return lines.join("\n");
}

async function walk(
  absDir: Buffer,
  relPrefix: Buffer | null,
  entries: Map<string, SnapshotEntry>,
  exclude: SnapshotOptions["exclude"],
): Promise<void> {
  const names = (await fsp.readdir(absDir, { encoding: "buffer" })).sort(
    Buffer.compare,
  );
  for (const name of names) {
    const rel =
      relPrefix === null ? name : Buffer.concat([relPrefix, SLASH_BUF, name]);
    if (exclude?.(rel)) continue;
    const abs = Buffer.concat([absDir, SLASH_BUF, name]);
    const stats = await fsp.lstat(abs);
    const key = rel.toString("latin1");
    if (stats.isSymbolicLink()) {
      entries.set(key, {
        kind: "symlink",
        target: await fsp.readlink(abs, { encoding: "buffer" }),
      });
    } else if (stats.isDirectory()) {
      entries.set(key, { kind: "dir" });
      await walk(abs, rel, entries, exclude);
    } else if (stats.isFile()) {
      entries.set(key, { kind: "file", bytes: await fsp.readFile(abs) });
    } else {
      entries.set(key, { kind: "other" });
    }
  }
}
