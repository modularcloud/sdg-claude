#!/usr/bin/env node
// CONF-MD conformer executable (CERTIFICATIONS.md §CONF-MD). The
// certification runner drives this file exactly as it drives the built
// product — an executable/workspace binding and nothing else (TEST-SPEC C-2).
// Violator fixtures (VIOL-MD-*) will reuse product.mjs with exactly one
// behavioral deviation each; this entry runs the conformer, deviation-free.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {});
process.exit(code);
