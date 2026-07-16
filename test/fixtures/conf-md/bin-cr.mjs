#!/usr/bin/env node
// VIOL-MD-CR violator executable (CERTIFICATIONS.md §VIOL-MD-CR).
// The CONF-MD conformer with exactly one behavioral deviation: a lone U+000D
// is not recognized as a line terminator by the line model of SPEC 3 —
// consistently in Markdown output and, through SPEC 1.6, in own and subtree
// text. CRLF and lone U+000A remain terminators; a lone U+000D is an
// ordinary in-line character.
// Certifies T3-4 and P-2 (C-1): exactly they fail against this fixture;
// every other §CONF-MD in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  loneCrNotTerminator: true,
});
process.exit(code);
