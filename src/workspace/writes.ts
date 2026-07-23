// The workspace write layer — every product file write goes through here
// (IMPLEMENTATION Architecture: derived-file writes are atomic — temp file +
// rename in the same directory; the workspace layer owns all I/O).
//
// SPEC 13.5: file writes are atomic in their observable effect — at every
// moment, concurrent readers and interrupted commands included, a path xspec
// writes holds either its prior state (the previous content, or absence) or
// the complete new content, never a partial write. Temp-file-plus-rename in
// the target's own directory gives exactly that: the temp file carries the
// complete bytes before the rename, and the rename replaces the target in
// one atomic step.
//
// SPEC 13.4: every file xspec writes is a plain file suitable for
// committing (temp + rename only ever creates regular files; stable
// ordering and sorted keys are the canonical serializer's, core/
// canonical-json.ts). Derived-file paths belong to xspec: writing a derived
// file replaces whatever occupies its path — a symbolic link included,
// which is replaced as itself and never written through. A durable file's
// path occupied by anything other than a plain file is never read, appended
// to, or replaced: the read side reports it (journal → 14.13, session →
// 14.21), and the write primitives here refuse it as a terminal defense.
//
// SPEC 13.4 → 14.22: writes never traverse symbolic links. A symbolic link
// at a workspace-relative directory component of any write path refuses the
// write, reported before anything is modified; `check` reports it without
// writing. `symlinkWritePathFindings` is that report's producer — callers
// (build, and every command that writes) run it over their complete write
// set before touching the workspace, and the write primitives re-check as a
// terminal defense. Path components above the workspace root are
// unrestricted (SPEC 13.4).

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as process from "node:process";
import { compareBytes } from "../core/bytes.js";
import type { Finding } from "../core/findings.js";

/**
 * What occupies a filesystem path, judged by `lstat` — a symbolic link is
 * always judged itself, never through its target (SPEC 13.4).
 */
export type PathOccupant =
  "absent" | "file" | "directory" | "symlink" | "other";

/** Classify the occupant of an absolute path (SPEC 13.4). */
export async function classifyOccupant(
  absolute: string,
): Promise<PathOccupant> {
  let stats;
  try {
    stats = await fsp.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

/** Human words for an occupant kind, for diagnostics. */
export function describeOccupant(occupant: PathOccupant): string {
  switch (occupant) {
    case "absent":
      return "nothing";
    case "file":
      return "a plain file";
    case "directory":
      return "a directory";
    case "symlink":
      return "a symbolic link";
    case "other":
      return "a non-plain file";
  }
}

/** The absolute filesystem path of a `/`-separated workspace-relative path. */
function absoluteOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/**
 * The proper workspace-relative directory components of `rel`, shallowest
 * first: for `out/specs/A.md`, `["out", "out/specs"]`. The leaf itself is
 * not a directory component — a symbolic link there is an occupant, not a
 * traversal (SPEC 13.4, 14.22).
 */
function directoryComponents(rel: string): string[] {
  const segments = rel.split("/");
  const components: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    components.push(segments.slice(0, i).join("/"));
  }
  return components;
}

/**
 * The first workspace-relative directory component of `rel` that is a
 * symbolic link, or null when the path traverses none (SPEC 13.4, 14.22).
 * Components are examined shallowest first and examination stops at the
 * first symbolic link or missing component — an `lstat` of anything deeper
 * would itself traverse the link, and below a missing component nothing
 * exists (directory creation supplies real directories). Components above
 * the workspace root are unrestricted (SPEC 13.4) and never examined.
 */
export async function symlinkComponentOf(
  root: string,
  rel: string,
): Promise<string | null> {
  for (const component of directoryComponents(rel)) {
    const occupant = await classifyOccupant(absoluteOf(root, component));
    if (occupant === "symlink") return component;
    if (occupant === "absent") return null;
    // A plain-file or other non-directory occupant is not a symbolic link:
    // not this condition (SPEC 14.22). The write itself fails on it.
  }
  return null;
}

/** The SPEC 14.22 finding for `rel` traversing the symlink `component`. */
function symlinkFinding(rel: string, component: string): Finding {
  return {
    condition: 22,
    file: rel,
    message:
      `symbolic link in a write path: writing ${rel} would traverse the ` +
      `workspace-relative directory component ${component}, which is a ` +
      `symbolic link — writes never traverse symbolic links (SPEC 13.4)`,
    correction:
      `replace ${component} with a real directory, or redirect the write ` +
      `so no path xspec writes passes through it (SPEC 14.22)`,
  };
}

/**
 * SPEC 14.22 findings over a set of workspace-relative write paths: one
 * finding per offending path, naming the first symbolic-link directory
 * component it traverses. Deterministic — paths are deduplicated and
 * examined in byte order (SPEC 12.0). Callers run this over their complete
 * write set before modifying anything ("a command refuses the write and
 * reports it before modifying anything"); `check` reports the same findings
 * without writing (SPEC 14.22).
 */
export async function symlinkWritePathFindings(
  root: string,
  rels: Iterable<string>,
): Promise<Finding[]> {
  const unique = [...new Set(rels)].sort(compareBytes);
  const findings: Finding[] = [];
  for (const rel of unique) {
    const component = await symlinkComponentOf(root, rel);
    if (component !== null) findings.push(symlinkFinding(rel, component));
  }
  return findings;
}

/**
 * Terminal defense shared by the write primitives: verify no
 * workspace-relative directory component of `rel` is a symbolic link
 * (callers report SPEC 14.22 gracefully before ever calling a write), then
 * create the missing parent directories. Throws on a symlinked component
 * and on a component occupied by a non-directory, which no directory
 * creation can cure.
 */
async function ensureWritableParent(root: string, rel: string): Promise<void> {
  for (const component of directoryComponents(rel)) {
    const occupant = await classifyOccupant(absoluteOf(root, component));
    if (occupant === "absent") break; // mkdir supplies the rest
    if (occupant === "symlink") {
      throw new Error(
        `cannot write ${rel}: the workspace-relative directory component ` +
          `${component} is a symbolic link — writes never traverse ` +
          `symbolic links (SPEC 13.4, 14.22)`,
      );
    }
    if (occupant !== "directory") {
      throw new Error(
        `cannot write ${rel}: the workspace-relative directory component ` +
          `${component} is ${describeOccupant(occupant)}, not a directory`,
      );
    }
  }
  await fsp.mkdir(path.dirname(absoluteOf(root, rel)), { recursive: true });
}

let temporaryCounter = 0;

/**
 * A fresh temp-file path in the same directory as `absolute` (rename is
 * atomic only within one filesystem, so the temp file lives beside its
 * target; IMPLEMENTATION). The name starts with `.` and contains `.xspec.`,
 * so even mid-write it is never discovered as a source: paths whose file
 * name contains `.xspec.` are excluded from every group (SPEC 13.4), and
 * the leading dot keeps it out of wildcard glob segments (SPEC 7).
 */
function temporaryPathBeside(absolute: string): string {
  temporaryCounter += 1;
  const name = `.xspec.tmp-${String(process.pid)}-${String(temporaryCounter)}`;
  return path.join(path.dirname(absolute), name);
}

/** The write's bytes: strings are UTF-8 (SPEC 12.0 byte determinism). */
function contentBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

/**
 * Atomically replace whatever occupies `absolute` with a plain file holding
 * `content`: the complete bytes land in a temp file beside the target, then
 * one rename replaces the occupant (SPEC 13.5). A symbolic-link occupant is
 * replaced as itself — rename never follows the destination — and nothing
 * is ever written through it (SPEC 13.4). A directory occupant, which
 * rename cannot replace, is removed and the rename retried: derived-file
 * paths belong to xspec, whatever exists at them (SPEC 13.4).
 */
async function replaceWithFile(
  absolute: string,
  content: Uint8Array | string,
): Promise<void> {
  const temporary = temporaryPathBeside(absolute);
  await fsp.writeFile(temporary, contentBytes(content));
  try {
    await fsp.rename(temporary, absolute);
  } catch (renameError) {
    try {
      if ((await classifyOccupant(absolute)) === "directory") {
        await fsp.rm(absolute, { recursive: true, force: true });
        await fsp.rename(temporary, absolute);
        return;
      }
      throw renameError;
    } catch (error) {
      await fsp.rm(temporary, { force: true }); // never leave the temp behind
      throw error;
    }
  }
}

/**
 * Write a derived file (SPEC 13.4: generated TypeScript modules and
 * companions, emitted Markdown, graph data): atomic in its observable
 * effect (SPEC 13.5), replacing whatever occupies the path — a symbolic
 * link included, never writing through it (SPEC 13.4). Missing parent
 * directories are created. Callers have already validated the write path
 * (SPEC 14.22, `symlinkWritePathFindings`); a symlinked component here is a
 * terminal defense and throws.
 */
export async function writeDerivedFile(
  root: string,
  rel: string,
  content: Uint8Array | string,
): Promise<void> {
  await ensureWritableParent(root, rel);
  await replaceWithFile(absoluteOf(root, rel), content);
}

/**
 * Rewrite a source file in place (SPEC 6.4, 6.5: `rename` and `move`
 * rewrite references across configured spec and code sources). Atomic in
 * its observable effect (SPEC 13.5), like every product write. The path
 * holds a discovered source — a plain file — and its rewritten content
 * replaces it; callers have validated the write path (SPEC 14.22) and run
 * under workspace exclusivity (SPEC 13.5).
 */
export async function writeSourceFile(
  root: string,
  rel: string,
  content: Uint8Array | string,
): Promise<void> {
  await ensureWritableParent(root, rel);
  await replaceWithFile(absoluteOf(root, rel), content);
}

/**
 * Remove a source file at its workspace-relative path (SPEC 6.5: the file
 * form of `xspec move` relocates the source file, so the origin path ceases
 * to exist). The occupant is a discovered source — a plain file reached
 * through real directories (discovery never follows symbolic links, SPEC 7)
 * — and removal never traverses a symlinked component (SPEC 13.4): a path
 * whose directory component became a symbolic link is skipped untouched, as
 * in orphan removal. An absent occupant is a completed removal.
 */
export async function removeSourceFile(
  root: string,
  rel: string,
): Promise<void> {
  if ((await symlinkComponentOf(root, rel)) !== null) return;
  await fsp.rm(absoluteOf(root, rel), { force: true });
}

/**
 * Remove a derived file at a recorded path (orphan removal, SPEC 13.3/13.4:
 * a recorded derived file no longer generated is removed via its recorded
 * path). An absent occupant is a completed removal; a symbolic-link
 * occupant is removed as itself, never through the link; a directory
 * occupant is removed whole (the path belongs to xspec, SPEC 13.4). A
 * recorded path with a symbolic link at a workspace-relative directory
 * component is skipped untouched: removal never traverses a link (SPEC
 * 13.4), so the path no longer denotes a location xspec may touch — like an
 * orphan whose record is missing, it is outside xspec's knowledge.
 */
export async function removeDerivedFile(
  root: string,
  rel: string,
): Promise<void> {
  if ((await symlinkComponentOf(root, rel)) !== null) return;
  const absolute = absoluteOf(root, rel);
  const occupant = await classifyOccupant(absolute);
  if (occupant === "absent") return;
  await fsp.rm(absolute, {
    recursive: occupant === "directory",
    force: true,
  });
}

/**
 * Refuse a durable write when `absolute` is occupied by anything other
 * than a plain file (SPEC 13.4: such a path is never read, appended to, or
 * replaced). Callers detect and report the occupant gracefully on the read
 * side (journal → 14.13, session → 14.21) before ever writing; this throw
 * is the terminal defense.
 */
async function requireDurableWritable(
  absolute: string,
  rel: string,
): Promise<void> {
  const occupant = await classifyOccupant(absolute);
  if (occupant !== "absent" && occupant !== "file") {
    throw new Error(
      `cannot write the durable file ${rel}: its path is occupied by ` +
        `${describeOccupant(occupant)} — a durable file's path occupied by ` +
        `anything other than a plain file is never read, appended to, or ` +
        `replaced (SPEC 13.4)`,
    );
  }
}

/**
 * Write a durable file (SPEC 13.4: the journal, review sessions) atomically
 * (SPEC 13.5), by its owning command only. The path must hold a plain file
 * or nothing: any other occupant refuses the write (SPEC 13.4; terminal
 * defense — the read side reports it as 14.13/14.21 first).
 */
export async function writeDurableFile(
  root: string,
  rel: string,
  content: Uint8Array | string,
): Promise<void> {
  await ensureWritableParent(root, rel);
  const absolute = absoluteOf(root, rel);
  await requireDurableWritable(absolute, rel);
  await replaceWithFile(absolute, content);
}

/**
 * Append to a line-oriented durable file (SPEC 6.1: the journal is
 * append-only and comes into existence with the first append; SPEC 13.4:
 * line-oriented so concurrent additions merge textually). Atomic in its
 * observable effect (SPEC 13.5): the first append — the file absent —
 * creates it as a complete file (temp beside the target, one rename), so a
 * concurrent reader only ever observes absence or the complete first entry,
 * never an empty or partial file (opening with O_CREAT and then writing
 * would expose an empty file between the two). Appending callers run under
 * workspace exclusivity (SPEC 13.5), so no concurrent appender races the
 * absence classification. Later appends are one O_APPEND write of the
 * complete bytes. The same non-plain-occupant refusal applies as for
 * `writeDurableFile`.
 */
export async function appendDurableFile(
  root: string,
  rel: string,
  content: Uint8Array | string,
): Promise<void> {
  await ensureWritableParent(root, rel);
  const absolute = absoluteOf(root, rel);
  await requireDurableWritable(absolute, rel);
  const bytes = Buffer.from(contentBytes(content));
  if ((await classifyOccupant(absolute)) === "absent") {
    await replaceWithFile(absolute, bytes);
    return;
  }
  const handle = await fsp.open(absolute, "a");
  try {
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written);
      written += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}
