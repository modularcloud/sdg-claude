// Review-session storage — the I/O half (SPEC 10.1, 13.4; IMPLEMENTATION
// Architecture: all filesystem access lives in the workspace layer).
//
// Sessions live at `.xspec/reviews/<session-name>.json` under the workspace
// root (SPEC 10.1). They are durable files (SPEC 13.4): written only by the
// mutating `review` subcommands (`create`, `resolve`, `split`; SPEC 13.5),
// never regenerated, and never modified or deleted by other commands. Only a
// file directly under `.xspec/reviews/` named `<session-name>.json` with a
// valid session name is a session; any other entry there is not a session
// and is ignored by every command, `check` included (SPEC 10.1). A session
// path occupied by anything other than a plain file is never read or
// replaced — such a session is corrupt (SPEC 13.4 → 14.21), as is one whose
// bytes cannot be parsed or violate a session invariant (SPEC 10.1).
//
// Parsing, validation, and the model are the pure core's
// (src/core/review.ts); this module classifies occupants, reads bytes, and
// writes through the workspace write layer (writes.ts), like every product
// file write.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Finding } from "../core/findings.js";
import type { ReviewSession } from "../core/review.js";
import {
  corruptSessionFinding,
  corruptSessionOccupantFinding,
  isValidSessionName,
  parseSessionBytes,
  REVIEWS_DIRECTORY,
  serializeSession,
  sessionFilePath,
  sortSessionNames,
} from "../core/review.js";
import {
  classifyOccupant,
  describeOccupant,
  writeDurableFile,
} from "./writes.js";

/** The extension a session file bears, byte-exact (SPEC 10.1, 12.0). */
const SESSION_EXTENSION = ".json";

/** The reviews directory's absolute path under the workspace root. */
function reviewsAbsolutePath(root: string): string {
  return path.join(root, ...REVIEWS_DIRECTORY.split("/"));
}

/** A session file's absolute path under the workspace root. */
function sessionAbsolutePath(root: string, name: string): string {
  return path.join(reviewsAbsolutePath(root), `${name}${SESSION_EXTENSION}`);
}

/** One loaded session: readable, corrupt (SPEC 14.21), or absent. */
export type LoadedSession =
  | {
      readonly state: "ok";
      readonly name: string;
      readonly session: ReviewSession;
    }
  | {
      /**
       * SPEC 10.1 → 14.21: the session file is not a plain file, cannot be
       * parsed, or violates a session invariant. Every `review` subcommand
       * naming the session reports `finding` and exits 1, modifying
       * nothing; `list` reports the session corrupt in place of its fields
       * (SPEC 10.7); `check` reports it as condition 21.
       */
      readonly state: "corrupt";
      readonly name: string;
      readonly finding: Finding;
    }
  | {
      /**
       * No entry exists at the session's path. Naming an absent session is
       * a usage error (SPEC 10.7 → 12.0), reported by the command layer.
       */
      readonly state: "absent";
      readonly name: string;
    };

/**
 * The names of the workspace's sessions, in byte order (SPEC 12.0): the
 * entries directly under `.xspec/reviews/` named `<valid-name>.json`,
 * byte-exact on the extension (SPEC 10.1: names, like paths, compare
 * byte-wise and case-sensitively — `NAME.JSON` is not a session file).
 * Whether the entry is a plain file is judged at load: a candidate occupied
 * by a directory or symbolic link is a corrupt session (SPEC 13.4 → 14.21),
 * while entries not matching the name pattern are not sessions at all and
 * are ignored. An absent or non-directory `.xspec/reviews` yields no
 * sessions; reads never traverse symbolic links (SPEC 13.4).
 */
export async function listSessionNames(root: string): Promise<string[]> {
  const directory = reviewsAbsolutePath(root);
  if ((await classifyOccupant(directory)) !== "directory") {
    return [];
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SESSION_EXTENSION)) continue;
    const name = entry.slice(0, -SESSION_EXTENSION.length);
    if (!isValidSessionName(name)) continue;
    names.push(name);
  }
  return sortSessionNames(names);
}

/**
 * Load one session by name (SPEC 10.1). The caller has validated the name
 * (an invalid name is a usage error before any lookup, SPEC 12.0). The
 * path's occupant decides: nothing → absent; a plain file → parsed and
 * validated (core); anything else — a directory or symbolic link included —
 * is never read and the session is corrupt (SPEC 13.4 → 14.21).
 * Classification uses lstat (writes.ts), so a symbolic link is judged
 * itself, never through its target.
 */
export async function loadSession(
  root: string,
  name: string,
): Promise<LoadedSession> {
  // SPEC 10.1/12.0: session names, like paths, compare byte-wise and
  // case-sensitively. On a case-insensitive filesystem (the Windows leg,
  // E-6) a path lookup for `Foo.json` reaches an entry spelled
  // `foo.json`, so existence is judged against the directory's exact
  // entry names first: no byte-identical entry, no session — `NAME.JSON`
  // is not a session file and `Foo` never resolves to `foo`.
  const entryName = `${name}${SESSION_EXTENSION}`;
  let entries: string[];
  try {
    entries = await fsp.readdir(reviewsAbsolutePath(root));
  } catch {
    return { state: "absent", name };
  }
  if (!entries.includes(entryName)) {
    return { state: "absent", name };
  }
  const absolute = sessionAbsolutePath(root, name);
  const occupant = await classifyOccupant(absolute);
  if (occupant === "absent") {
    return { state: "absent", name };
  }
  if (occupant !== "file") {
    return {
      state: "corrupt",
      name,
      finding: corruptSessionOccupantFinding(name, describeOccupant(occupant)),
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fsp.readFile(absolute);
  } catch (error) {
    return {
      state: "corrupt",
      name,
      finding: corruptSessionFinding(name, [
        `the session file cannot be read: ${(error as Error).message}`,
      ]),
    };
  }
  const parsed = parseSessionBytes(bytes);
  if (!parsed.ok) {
    return {
      state: "corrupt",
      name,
      finding: corruptSessionFinding(name, parsed.problems),
    };
  }
  return { state: "ok", name, session: parsed.session };
}

/**
 * Load every session of the workspace, in byte order of session name
 * (SPEC 10.7 `list`; `check`'s 14.21 sweep). Entries are `ok` or `corrupt`;
 * a candidate that vanished between listing and loading is skipped — it no
 * longer exists, exactly as if never listed.
 */
export async function loadAllSessions(
  root: string,
): Promise<(LoadedSession & { readonly state: "ok" | "corrupt" })[]> {
  const loaded: (LoadedSession & { readonly state: "ok" | "corrupt" })[] = [];
  for (const name of await listSessionNames(root)) {
    const session = await loadSession(root, name);
    if (session.state !== "absent") {
      loaded.push(session);
    }
  }
  return loaded;
}

/**
 * Write a session to its durable path (SPEC 10.1, 13.4), serialized by the
 * canonical serializer (core) — atomic in its observable effect
 * (SPEC 13.5). Callers are the mutating `review` subcommands only, running
 * under workspace exclusivity (SPEC 13.5) after validating the write path
 * (SPEC 14.22) and the occupant (a corrupt session is reported, never
 * overwritten — the write layer's non-plain-occupant refusal is the
 * terminal defense).
 */
export async function writeSession(
  root: string,
  name: string,
  session: ReviewSession,
): Promise<void> {
  await writeDurableFile(
    root,
    sessionFilePath(name),
    serializeSession(session),
  );
}
