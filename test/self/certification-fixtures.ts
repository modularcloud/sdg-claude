// CERTIFICATIONS.md fixture products: bindings and in-scope test sets
// (TEST-SPEC 17 C-1, C-2). Each fixture is a harness-owned executable under
// test/fixtures/, driven by the certification runner through the identical
// ProductBinding shape as the built product — an executable/workspace
// binding and nothing else (C-2), so certifying and testing use one code
// path and fixtures are invocable in CI without network or a build step
// (plain Node ESM programs).
//
// Each conformer entry carries its CERTIFICATIONS.md in-scope test IDs
// verbatim; each violator entry (added by its own CERT task) carries the IDs
// it certifies — the tests that must fail against it while every other
// in-scope test passes. The C-1 gate over the whole document is CERT-18's
// certification self-test; per-fixture verification lives in
// certification.test.ts.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProductBinding } from "../helpers/subprocess.js";

const fixturesRoot = path.resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);

/** Binding for a plain-Node fixture executable under test/fixtures/. */
function nodeFixtureBinding(label: string, relBin: string): ProductBinding {
  const bin = path.join(fixturesRoot, relBin);
  return {
    label,
    command: process.execPath,
    prefixArgs: [bin],
    requiredFiles: [bin],
  };
}

/**
 * CONF-CORE (CERTIFICATIONS.md §CONF-CORE): operational core — exclusion
 * seam, journal, durable files, review reads.
 */
export function confCoreBinding(): ProductBinding {
  return nodeFixtureBinding("CONF-CORE conformer", "conf-core/bin.mjs");
}

/** §CONF-CORE's in-scope tests, verbatim from CERTIFICATIONS.md. */
export const CONF_CORE_IN_SCOPE: readonly string[] = [
  "T6.1-1",
  "T6.1-2",
  "T10.4-5",
  "T13.4-5",
  "T13.5-1",
  "T13.5-2",
  "T13.5-3",
  "T13.5-4",
  "T13.5-5",
];

/**
 * VIOL-CORE-NOLOCK (CERTIFICATIONS.md §VIOL-CORE-NOLOCK): the CONF-CORE
 * conformer, except mutating commands do not exclude one another — the hold
 * file is still created before any modification and honored, but a second
 * mutating command started while another runs or is held proceeds normally
 * instead of failing with the usage error of SPEC 13.5/12.0.
 */
export function violCoreNolockBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-NOLOCK violator",
    "conf-core/bin-nolock.mjs",
  );
}

/** The tests §VIOL-CORE-NOLOCK certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_CORE_NOLOCK_CERTIFIES: readonly string[] = ["T13.5-2"];

/**
 * VIOL-CORE-EARLYWRITE (CERTIFICATIONS.md §VIOL-CORE-EARLYWRITE): the
 * CONF-CORE conformer, except a mutating command performs its workspace
 * modifications before creating the hold file — it acquires exclusivity,
 * completes the operation's writes (journal append included), then creates
 * the hold file, waits for its deletion, and exits normally.
 */
export function violCoreEarlywriteBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-EARLYWRITE violator",
    "conf-core/bin-earlywrite.mjs",
  );
}

/**
 * The tests §VIOL-CORE-EARLYWRITE certifies, verbatim from CERTIFICATIONS.md.
 */
export const VIOL_CORE_EARLYWRITE_CERTIFIES: readonly string[] = [
  "T13.5-1",
  "T13.5-4",
];

/**
 * VIOL-CORE-STALELOCK (CERTIFICATIONS.md §VIOL-CORE-STALELOCK): the
 * CONF-CORE conformer, except workspace exclusivity is not released by
 * abnormal termination — after a mutating command's process is killed, every
 * later mutating command in that workspace is refused with the usage error
 * of SPEC 13.5/12.0. Normal completion still releases.
 */
export function violCoreStalelockBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-STALELOCK violator",
    "conf-core/bin-stalelock.mjs",
  );
}

/**
 * The tests §VIOL-CORE-STALELOCK certifies, verbatim from CERTIFICATIONS.md.
 */
export const VIOL_CORE_STALELOCK_CERTIFIES: readonly string[] = ["T13.5-3"];

/**
 * VIOL-CORE-PARTIALWRITE (CERTIFICATIONS.md §VIOL-CORE-PARTIALWRITE): the
 * CONF-CORE conformer, except derived-file writes are not atomic in their
 * observable effect — while a derived file is being written, its path holds
 * a strict prefix of the new content for a sustained interval (long relative
 * to a concurrent reader's polling cadence) before the complete content
 * appears. Durable files are unaffected.
 */
export function violCorePartialwriteBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-PARTIALWRITE violator",
    "conf-core/bin-partialwrite.mjs",
  );
}

/**
 * The tests §VIOL-CORE-PARTIALWRITE certifies, verbatim from
 * CERTIFICATIONS.md.
 */
export const VIOL_CORE_PARTIALWRITE_CERTIFIES: readonly string[] = ["T13.5-5"];

/**
 * VIOL-CORE-CHATTYREADS (CERTIFICATIONS.md §VIOL-CORE-CHATTYREADS): the
 * CONF-CORE conformer, except `build` and the read commands modify the
 * journal — each such invocation that is not refused as a usage or
 * configuration error (exit 2) appends one fixed line to `.xspec/journal`,
 * creating the file when absent. Mutating commands, and the entries
 * `rename`/`move` append, are unchanged.
 */
export function violCoreChattyreadsBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-CHATTYREADS violator",
    "conf-core/bin-chattyreads.mjs",
  );
}

/**
 * The tests §VIOL-CORE-CHATTYREADS certifies, verbatim from
 * CERTIFICATIONS.md.
 */
export const VIOL_CORE_CHATTYREADS_CERTIFIES: readonly string[] = [
  "T6.1-1",
  "T13.4-5",
];

/**
 * VIOL-CORE-PERSISTREADS (CERTIFICATIONS.md §VIOL-CORE-PERSISTREADS): the
 * CONF-CORE conformer, except review reads persist read-time invalidation —
 * when `status`, `next`, `show`, or `export` computes that a resolved item's
 * recorded state differs from the current graph (SPEC 10.4), it rewrites
 * that item's stored status to `invalidated` in the session file. Reads over
 * sessions with no stale resolution write nothing.
 */
export function violCorePersistreadsBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-CORE-PERSISTREADS violator",
    "conf-core/bin-persistreads.mjs",
  );
}

/**
 * The tests §VIOL-CORE-PERSISTREADS certifies, verbatim from
 * CERTIFICATIONS.md.
 */
export const VIOL_CORE_PERSISTREADS_CERTIFIES: readonly string[] = ["T10.4-5"];

/**
 * CONF-VALID (CERTIFICATIONS.md §CONF-VALID): segment and tag validity —
 * `build` with the 14.1–14.4 error reporting and `query node`/`query nodes`
 * reporting identity, tags, and metadataHash, over `.mdx` workspaces whose
 * sections carry `id`/`tags` props.
 */
export function confValidBinding(): ProductBinding {
  return nodeFixtureBinding("CONF-VALID conformer", "conf-valid/bin.mjs");
}

/** §CONF-VALID's in-scope tests, verbatim from CERTIFICATIONS.md. */
export const CONF_VALID_IN_SCOPE: readonly string[] = [
  "T1.3-1",
  "T1.3-2",
  "T1.3-3",
  "T1.3-4",
  "T1.3-5",
  "T1.3-6",
  "T1.4-1",
  "T1.4-2",
  "T1.4-4",
  "T2.6-1",
  "T2.6-2",
  "P-1",
];

/**
 * VIOL-VALID-CTRL (CERTIFICATIONS.md §VIOL-VALID-CTRL): the CONF-VALID
 * conformer, except the control-character rule of SPEC 1.4 is not enforced
 * for code points outside the whitespace class — segments and tags containing
 * U+0000–U+0008, U+000E–U+001F, or U+007F are accepted as valid. Whitespace
 * characters (U+0009–U+000D, U+0020) remain rejected in segments, and tag
 * splitting is unchanged.
 */
export function violValidCtrlBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-VALID-CTRL violator",
    "conf-valid/bin-ctrl.mjs",
  );
}

/** The tests §VIOL-VALID-CTRL certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_VALID_CTRL_CERTIFIES: readonly string[] = [
  "T1.4-1",
  "T1.4-4",
  "P-1",
];

/**
 * VIOL-VALID-WIDE (CERTIFICATIONS.md §VIOL-VALID-WIDE): the CONF-VALID
 * conformer, except U+00A0, U+0085, and U+2028 are treated as whitespace for
 * SPEC 1.4 validity — a segment or tag containing any of them is rejected
 * with 14.4. Tag splitting and all other classifications are unchanged.
 */
export function violValidWideBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-VALID-WIDE violator",
    "conf-valid/bin-wide.mjs",
  );
}

/** The tests §VIOL-VALID-WIDE certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_VALID_WIDE_CERTIFIES: readonly string[] = [
  "T1.4-2",
  "T1.4-4",
  "P-1",
];

/**
 * CONF-MD (CERTIFICATIONS.md §CONF-MD): Markdown compilation — `build` with
 * byte-exact Markdown output per SPEC 3 (removal, replacement, the line-drop
 * rule, line terminators), `query node` reporting own and subtree text
 * (SPEC 1.6), and the emission scope of SPEC 7.3, over spec-group workspaces
 * with imports, embeddings, comments, mixed line terminators, and the full
 * 2.7 prop set.
 */
export function confMdBinding(): ProductBinding {
  return nodeFixtureBinding("CONF-MD conformer", "conf-md/bin.mjs");
}

/** §CONF-MD's in-scope tests, verbatim from CERTIFICATIONS.md. */
export const CONF_MD_IN_SCOPE: readonly string[] = [
  "T3-1",
  "T3-2",
  "T3-3",
  "T3-4",
  "T3-5",
  "T3-6",
  "P-2",
  "P-3",
];

/**
 * VIOL-MD-CLASS (CERTIFICATIONS.md §VIOL-MD-CLASS): the CONF-MD conformer,
 * except the line-drop rule classifies U+00A0, U+0085, and U+2028 as
 * whitespace when deciding whether a line is left empty or whitespace-only —
 * consistently in Markdown output and, through SPEC 1.6, in own and subtree
 * text. A line left holding only those code points after removals is dropped
 * with its terminator.
 */
export function violMdClassBinding(): ProductBinding {
  return nodeFixtureBinding("VIOL-MD-CLASS violator", "conf-md/bin-class.mjs");
}

/** The tests §VIOL-MD-CLASS certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_MD_CLASS_CERTIFIES: readonly string[] = ["T3-3", "P-2"];

/**
 * VIOL-MD-CR (CERTIFICATIONS.md §VIOL-MD-CR): the CONF-MD conformer, except
 * a lone U+000D is not recognized as a line terminator by the line model of
 * SPEC 3 — consistently in Markdown output and, through SPEC 1.6, in own and
 * subtree text. CRLF and lone U+000A remain terminators; a lone U+000D is an
 * ordinary in-line character.
 */
export function violMdCrBinding(): ProductBinding {
  return nodeFixtureBinding("VIOL-MD-CR violator", "conf-md/bin-cr.mjs");
}

/** The tests §VIOL-MD-CR certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_MD_CR_CERTIFIES: readonly string[] = ["T3-4", "P-2"];

/**
 * CONF-DISC (CERTIFICATIONS.md §CONF-DISC): configuration-driven discovery —
 * `build` and `ids` as the observation of the discovered set, over the glob
 * semantics of SPEC 7 (byte-wise case-sensitive matching, the dot-segment
 * rule, every character outside `*`/`?`/`**` a literal), discovery's refusal
 * to follow symbolic links, and the source exclusion of SPEC 13.4, with
 * 14.14 for outside-root patterns and 14.15 for import errors.
 */
export function confDiscBinding(): ProductBinding {
  return nodeFixtureBinding("CONF-DISC conformer", "conf-disc/bin.mjs");
}

/** §CONF-DISC's in-scope tests, verbatim from CERTIFICATIONS.md. */
export const CONF_DISC_IN_SCOPE: readonly string[] = ["T7-4", "T7-5", "T7-6"];

/**
 * VIOL-DISC-DIALECT (CERTIFICATIONS.md §VIOL-DISC-DIALECT): the CONF-DISC
 * conformer, except glob patterns are interpreted in a common dialect in
 * which `[ ]` bracket expressions and `{ }` brace alternations are active
 * metacharacters, instead of the literals SPEC 7 requires — a single
 * deviation: one rule of 7 (every character outside `*`, `?`, and `**` is a
 * literal) broken for one dialect's metacharacter subset. `*`, `?`, `**`,
 * case sensitivity, and the dot-segment rule are unchanged.
 */
export function violDiscDialectBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-DISC-DIALECT violator",
    "conf-disc/bin-dialect.mjs",
  );
}

/** The tests §VIOL-DISC-DIALECT certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_DISC_DIALECT_CERTIFIES: readonly string[] = ["T7-4"];

/**
 * VIOL-DISC-SYMLINK (CERTIFICATIONS.md §VIOL-DISC-SYMLINK): the CONF-DISC
 * conformer, except discovery follows symbolic links to existing files — a
 * symbolic link to an existing file, at a workspace-relative path a
 * spec-group glob matches, is discovered as a source (read through the
 * link). Broken links remain ignored, and symbolic links to directories
 * remain untraversed, so discovery still terminates (T7-5 fails by
 * assertion, not by hang).
 */
export function violDiscSymlinkBinding(): ProductBinding {
  return nodeFixtureBinding(
    "VIOL-DISC-SYMLINK violator",
    "conf-disc/bin-symlink.mjs",
  );
}

/** The tests §VIOL-DISC-SYMLINK certifies, verbatim from CERTIFICATIONS.md. */
export const VIOL_DISC_SYMLINK_CERTIFIES: readonly string[] = ["T7-5"];
