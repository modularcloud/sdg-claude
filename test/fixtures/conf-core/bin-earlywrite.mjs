#!/usr/bin/env node
// VIOL-CORE-EARLYWRITE violator executable (CERTIFICATIONS.md
// §VIOL-CORE-EARLYWRITE). The CONF-CORE conformer with exactly one
// behavioral deviation: a mutating command performs its workspace
// modifications before creating the hold file — it acquires exclusivity,
// completes the operation's writes (journal append included), then creates
// the hold file, waits for its deletion, and exits normally. Certifies
// T13.5-1 and T13.5-4 (C-1): exactly those fail against this fixture; every
// other §CONF-CORE in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  writesBeforeHold: true,
});
process.exit(code);
