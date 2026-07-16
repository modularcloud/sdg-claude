#!/usr/bin/env node
// VIOL-CORE-CHATTYREADS violator executable (CERTIFICATIONS.md
// §VIOL-CORE-CHATTYREADS). The CONF-CORE conformer with exactly one
// behavioral deviation: `build` and the read commands modify the journal —
// each such invocation that is not refused as a usage or configuration error
// (exit 2) appends one fixed line to .xspec/journal, creating the file when
// absent. Mutating commands, and the entries `rename`/`move` append, are
// unchanged. Certifies T6.1-1 and T13.4-5 (C-1): exactly they fail against
// this fixture; every other §CONF-CORE in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  chattyReads: true,
});
process.exit(code);
