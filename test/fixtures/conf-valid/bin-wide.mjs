#!/usr/bin/env node
// VIOL-VALID-WIDE violator executable (CERTIFICATIONS.md §VIOL-VALID-WIDE).
// The CONF-VALID conformer with exactly one behavioral deviation: U+00A0,
// U+0085, and U+2028 are treated as whitespace for SPEC 1.4 validity — a
// segment or tag containing any of them is rejected with 14.4. Tag splitting
// (SPEC 2.6) and all other classifications are unchanged. Certifies T1.4-2,
// T1.4-4, and P-1 (C-1): exactly they fail against this fixture; every other
// §CONF-VALID in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  widenValidityWhitespace: true,
});
process.exit(code);
