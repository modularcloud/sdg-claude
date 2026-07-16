#!/usr/bin/env node
// VIOL-DISC-DERIVED violator executable (CERTIFICATIONS.md
// §VIOL-DISC-DERIVED). The CONF-DISC conformer with exactly one behavioral
// deviation: discovery does not apply the source exclusion of 13.4 — a path
// whose file name contains `.xspec.`, a file under `.xspec/`, or a file at
// an enabled Markdown emit destination, when matched by a spec-group glob,
// is treated as an ordinary match (a non-`.mdx` occupant then surfaces as
// 14.19). Glob semantics, the dot-segment rule, link behavior, and the
// import and empty-map rules are unchanged. Certifies T7-6 (C-1): exactly it
// fails against this fixture — on its exclusion arms — while every other
// §CONF-DISC in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  noDerivedExclusion: true,
});
process.exit(code);
