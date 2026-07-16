#!/usr/bin/env node
// VIOL-MD-CLASS violator executable (CERTIFICATIONS.md §VIOL-MD-CLASS).
// The CONF-MD conformer with exactly one behavioral deviation: the line-drop
// rule classifies U+00A0, U+0085, and U+2028 as whitespace when deciding
// whether a line is left empty or whitespace-only — consistently in Markdown
// output and, through SPEC 1.6, in own and subtree text. A line left holding
// only those code points after removals is dropped with its terminator.
// Certifies T3-3 and P-2 (C-1): exactly they fail against this fixture;
// every other §CONF-MD in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  widenDropWhitespace: true,
});
process.exit(code);
