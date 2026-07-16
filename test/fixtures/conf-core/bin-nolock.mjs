#!/usr/bin/env node
// VIOL-CORE-NOLOCK violator executable (CERTIFICATIONS.md §VIOL-CORE-NOLOCK).
// The CONF-CORE conformer with exactly one behavioral deviation: mutating
// commands do not exclude one another. The hold file is still created before
// any modification and honored, but a second mutating command started while
// another runs or is held is not refused — it proceeds normally instead of
// failing with the usage error of SPEC 13.5/12.0. Certifies T13.5-2 (C-1):
// exactly it fails against this fixture; every other §CONF-CORE in-scope
// test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  noMutualExclusion: true,
});
process.exit(code);
