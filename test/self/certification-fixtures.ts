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
