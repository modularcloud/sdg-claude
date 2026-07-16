#!/usr/bin/env node
// CONF-CORE conformer executable (CERTIFICATIONS.md §CONF-CORE). The
// certification runner drives this file exactly as it drives the built
// product — an executable/workspace binding and nothing else (TEST-SPEC C-2).
// Violator fixtures (VIOL-CORE-*) will reuse product.mjs with exactly one
// behavioral deviation each; this entry runs the conformer, deviation-free.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {});
process.exit(code);
