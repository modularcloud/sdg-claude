#!/usr/bin/env node
// VIOL-CORE-STALELOCK violator executable (CERTIFICATIONS.md
// §VIOL-CORE-STALELOCK). The CONF-CORE conformer with exactly one behavioral
// deviation: workspace exclusivity is not released by abnormal termination —
// after a mutating command's process is killed, every later mutating command
// in that workspace is refused with the usage error of SPEC 13.5/12.0.
// Normal completion still releases. Certifies T13.5-3 (C-1): exactly it
// fails against this fixture; every other §CONF-CORE in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  staleLockBlocks: true,
});
process.exit(code);
