// E-6 platform-sensitive subset, part 1 of 2 (TEST-SPEC §18 E-6; CI-01) —
// the path/identity assertions and the single-casing case-mismatch probes.
// Run by the suite-windows CI job (`npm run test:windows`); the byte-identity
// comparison lives in e6-byte-identity.test.ts.
//
// One code path with the suite leg (C-2):
//
// - T1.5-1, T1.5-3, and T12.0-5 are the registered suite entries themselves,
//   declared here against the built product exactly as test/suite/ declares
//   them. A Linux runner cannot discriminate a product emitting native path
//   separators (`/` is native there); on Windows these same assertions do.
//   T12.0-5's non-UTF-8 arm gates itself to the Linux leg inside the shared
//   body ("less its Linux-leg arm", E-6), so no arm is skipped here — it is
//   simply not part of this platform's staging.
//
// - The four single-casing probes are the exact probe functions the
//   registered bodies call on the suite leg, re-invoked here: each stages one
//   casing and probes another, so the fixture stages identically on any
//   filesystem, and on a case-insensitive one it exposes a product resolving
//   session names (T10.1-2), session file paths (T10.1-3), path arguments
//   (T12.0-6), or glob matches (T7-4) through case-insensitive filesystem
//   lookups. On Linux the case-sensitive filesystem masks such products;
//   here nothing does.
//
// Expected red against the stub product, as diagnosed assertion failures
// (H-8) — on this leg and on any platform this project is run on locally.

import { test } from "vitest";
import { DEFAULT_PRODUCT_TEST_TIMEOUT_MS } from "../helpers/registry.js";
import { builtProductBinding } from "../helpers/subprocess.js";
import type { ProductBinding } from "../helpers/subprocess.js";
import { declareProductTests } from "../suite/declare.js";
import { productTestSuite } from "../suite/registry/index.js";
import {
  runT1012SessionNameCasingProbe,
  runT1013WrongCaseExtensionProbe,
} from "../suite/registry/section-10.1.js";
import { runT1206SingleCasingPathProbe } from "../suite/registry/section-12.0-i.js";
import { runT74SingleCasingGlobProbe } from "../suite/registry/section-7-discovery.js";

// The full registered entries rerun on this leg (E-6), resolved from the
// manifest — an unknown ID is a hard error, so subset drift fails loudly.
declareProductTests(productTestSuite.select(["T1.5-1", "T1.5-3", "T12.0-5"]));

// The single-casing case-mismatch probes (E-6), shared with their registered
// suite bodies.
const PROBES: readonly (readonly [
  string,
  (product: ProductBinding) => Promise<void>,
])[] = [
  [
    "T7-4 single-casing probe: the glob SPECS/*.mdx over directory specs/ (and specs2/b.mdx over specs2/B.mdx) discovers zero sources — glob matching is case-sensitive on every platform (SPEC 7, 12.0; E-6)",
    runT74SingleCasingGlobProbe,
  ],
  [
    "T10.1-2 single-casing probe: `review status Foo` against stored session `foo` is exit 2 — session names are case-sensitive for every subcommand (SPEC 10.1, 12.0; E-6)",
    runT1012SessionNameCasingProbe,
  ],
  [
    "T10.1-3 single-casing probe: NAME.JSON is no session — `review status NAME` is exit 2 unknown session, paths compare byte-wise (SPEC 10.1, 12.0; E-6)",
    runT1013WrongCaseExtensionProbe,
  ],
  [
    "T12.0-6 single-casing probe: with sole source specs/A.mdx, the argument specs/a.mdx is an unknown-file usage error, exit 2 — paths compare byte-wise (SPEC 12.0; E-6)",
    runT1206SingleCasingPathProbe,
  ],
];

for (const [title, probe] of PROBES) {
  test(title, { timeout: DEFAULT_PRODUCT_TEST_TIMEOUT_MS }, async () => {
    await probe(builtProductBinding());
  });
}
