// Source discovery — the I/O half: the symlink-free directory walk
// (SPEC 7; IMPLEMENTATION Architecture: source discovery is workspace-layer
// I/O, and the walk is in-repo — no glob library, no walker dependency).
//
// SPEC 7: discovery never follows symbolic links — a symbolic link, to a
// file or to a directory, broken or not, is never a discovered source and
// is never traversed, so symlinked, cyclic, or workspace-external content
// never enters the discovered set. The walk starts at the workspace root
// (the configuration file's directory, SPEC 7) and matching is against
// workspace-relative paths as their UTF-8 bytes, so directory entries are
// read with buffer encoding and never decoded before matching — a name the
// filesystem reports is matched verbatim (byte-wise, case-sensitive,
// SPEC 7/12.0), never re-derived through filesystem lookups.
//
// Group matching, derived-file exclusion (SPEC 13.4), and path validation
// (14.14/14.19) are the pure core's (src/core/discovery.ts).

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import type { Configuration } from "../core/config.js";
import type { SourceClassification } from "../core/discovery.js";
import { classifySources } from "../core/discovery.js";
import type { CompiledGlob } from "../core/glob.js";

const SLASH = Buffer.from("/");
/** SPEC 13.4/13.3: the workspace-root graph-data directory name. */
const XSPEC_DIR = Buffer.from(".xspec");

/**
 * Discover the workspace's spec and code sources (SPEC 7): walk the
 * workspace root without following symbolic links, then classify every
 * plain file found against the configured groups (core/discovery.ts) —
 * exclusions (13.4) and path conditions (14.14, 14.19) included. `root` is
 * the workspace root's absolute filesystem path (SPEC 7: the configuration
 * file's directory; the walk is independent of the working directory).
 */
export async function discoverSources(
  root: string,
  configuration: Configuration,
): Promise<SourceClassification> {
  const globs: readonly CompiledGlob[] = [
    ...configuration.specGroups,
    ...configuration.codeGroups,
  ].flatMap((group) => group.globs);
  const files: Uint8Array[] = [];
  if (globs.length > 0) {
    // SPEC 7: with no configured globs nothing can match — an empty
    // `specs`/`code` configuration discovers zero sources without touching
    // the filesystem.
    await walk(Buffer.from(root), null, globs, files);
  }
  return classifySources(files, configuration);
}

/**
 * Recursive walk of one directory. `relative` is the directory's
 * workspace-relative byte path (null for the root). Entries are visited in
 * byte order of their names, classified without following symbolic links,
 * and plain files are collected as workspace-relative byte paths.
 */
async function walk(
  absolute: Buffer,
  relative: Buffer | null,
  globs: readonly CompiledGlob[],
  files: Uint8Array[],
): Promise<void> {
  const entries = await fsp.readdir(absolute, {
    withFileTypes: true,
    encoding: "buffer",
  });
  entries.sort((a, b) => Buffer.compare(a.name, b.name));
  for (const entry of entries) {
    const name: Buffer = entry.name;
    // SPEC 7: a symbolic link — to a file or to a directory, broken or
    // not — is never a discovered source and is never traversed.
    if (entry.isSymbolicLink()) continue;
    const entryAbsolute = Buffer.concat([absolute, SLASH, name]);
    const entryRelative =
      relative === null
        ? Buffer.from(name)
        : Buffer.concat([relative, SLASH, name]);
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (!isFile && !isDirectory) {
      // The directory entry reported no type (a filesystem without d_type
      // support). Classify with lstat, which never follows a symbolic
      // link (SPEC 7) — stat would.
      let stats;
      try {
        stats = await fsp.lstat(entryAbsolute);
      } catch {
        continue; // vanished between readdir and lstat: not a source
      }
      if (stats.isSymbolicLink()) continue;
      isFile = stats.isFile();
      isDirectory = stats.isDirectory();
    }
    if (isFile) {
      files.push(entryRelative);
      continue;
    }
    // Anything neither plain file nor directory (FIFOs, sockets, devices)
    // is not a source file and holds none.
    if (!isDirectory) continue;
    // SPEC 13.4: every file under `.xspec/` — the workspace-root
    // graph-data directory (13.3) — is excluded from every group, so the
    // walk need not enter it: only a pattern segment written `.xspec`
    // could reach inside (SPEC 7 dot rule), and classification would drop
    // every hit.
    if (relative === null && Buffer.compare(name, XSPEC_DIR) === 0) continue;
    // Enter only directories some configured pattern could match within —
    // an over-approximation (core/glob.ts) that never skips a matchable
    // path. SPEC 7's dot rule keeps wildcard-only patterns out of
    // dot-directories (`.git`, caches) unless a pattern spells the
    // segment with its leading dot.
    if (globs.some((glob) => glob.mayMatchWithin(entryRelative))) {
      await walk(entryAbsolute, entryRelative, globs, files);
    }
  }
}
