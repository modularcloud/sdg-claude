// Thin Vitest wrapper over the product-test registry (C-2 "one code path"):
// each suite file declares its section's registered entries with
// `declareProductTests`, and every body runs here against the default
// binding — the built product (helpers/subprocess.ts, builtProductBinding) —
// byte-for-byte the same body the certification runner executes against
// CERTIFICATIONS.md fixture products. No test hard-codes the product path.
//
// Membership guard: an entry declared to Vitest but absent from the manifest
// (test/suite/registry/index.ts) would run in the suite yet be invisible to
// certification and to the S-7 red-green sweep — so declaration refuses it
// outright.

import { test } from "vitest";
import type { ProductTestEntry } from "../helpers/registry.js";
import { builtProductBinding } from "../helpers/subprocess.js";
import { productTestSuite } from "./registry/index.js";

/**
 * Declare registered product-facing tests as Vitest tests against the built
 * product. The entry's own budget is the Vitest timeout — the same budget the
 * certification runner uses as its hang watchdog.
 */
export function declareProductTests(
  entries: readonly ProductTestEntry[],
): void {
  for (const entry of entries) {
    if (
      !productTestSuite.has(entry.id) ||
      productTestSuite.get(entry.id) !== entry
    ) {
      throw new Error(
        `product test ${entry.id} is not in the manifest (test/suite/registry/index.ts) — ` +
          `every declared suite test must be registered there, or the certification runner ` +
          `and the S-7 red-green sweep would never see it (C-1, C-2).`,
      );
    }
    test(
      `${entry.id} ${entry.title}`,
      { timeout: entry.timeoutMs },
      async () => {
        await entry.run(builtProductBinding());
      },
    );
  }
}
