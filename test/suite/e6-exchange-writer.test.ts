// E-6 Linux-side leg of the cross-platform byte-identity comparison
// (TEST-SPEC §18 E-6; CI-01). Runs the representative fixture — `build`,
// `check`, `query`, `coverage`, `impact`, a journaled `rename`, a journaled
// file-form `move`, and an `audit` review session — against the built product
// (helpers/e6.ts), asserting every step's exact exit code, and writes the
// captured outputs (transcript + final workspace tree) into
// XSPEC_E6_EXCHANGE_DIR when it is set. The suite-linux CI job sets that
// variable and uploads the directory as the `e6-linux-outputs` artifact; the
// Windows leg (test/windows/e6-byte-identity.test.ts) reruns the identical
// fixture and compares byte-for-byte (.github/workflows/ci.yml).
//
// This is a product-facing test: against the stub product it fails at the
// fixture's first step as a diagnosed assertion failure (H-8) and writes
// nothing — the artifact upload tolerates the empty directory
// (if-no-files-found: ignore). Without the environment variable (local runs)
// the fixture still runs in full as an ordinary test; only the exchange write
// is conditional — never the test itself (H-9: no skips).
//
// Not a registry entry: the E-6 exchange is §18 execution machinery keyed to
// no TEST-SPEC T/P ID and no CERTIFICATIONS.md scope; the §1–16 behavior it
// touches is owned by the per-section registered tests. Its product
// invocations still go through the one C-2 binding surface.

import { test } from "vitest";
import {
  E6_EXCHANGE_ENV,
  runE6RepresentativeFixture,
  writeE6Exchange,
} from "../helpers/e6.js";
import { builtProductBinding } from "../helpers/subprocess.js";

// Generous hang guard for the whole 17-invocation fixture (H-8; each product
// invocation also carries its own subprocess timeout). Never an assertion
// input (H-10).
const FIXTURE_TIMEOUT_MS = 240_000;

test(
  "E-6 Linux leg: the representative fixture runs against the built product; its outputs are written to XSPEC_E6_EXCHANGE_DIR for the Windows leg when set (TEST-SPEC E-6)",
  { timeout: FIXTURE_TIMEOUT_MS },
  async () => {
    const run = await runE6RepresentativeFixture(builtProductBinding());
    const exchangeDir = process.env[E6_EXCHANGE_ENV];
    if (exchangeDir !== undefined && exchangeDir.trim() !== "") {
      await writeE6Exchange(run, exchangeDir);
    }
  },
);
