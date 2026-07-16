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
