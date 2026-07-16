#!/usr/bin/env node
// VIOL-DISC-DIALECT violator executable (CERTIFICATIONS.md
// §VIOL-DISC-DIALECT). The CONF-DISC conformer with exactly one behavioral
// deviation: glob patterns are interpreted in a common dialect in which
// `[ ]` bracket expressions and `{ }` brace alternations are active
// metacharacters, instead of the literals SPEC 7 requires — a single
// deviation: one rule of 7 (every character outside `*`, `?`, and `**` is a
// literal) broken for one dialect's metacharacter subset. `*`, `?`, `**`,
// case sensitivity, and the dot-segment rule are unchanged. Certifies T7-4
// (C-1): exactly it fails against this fixture; every other §CONF-DISC
// in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  dialectMetachars: true,
});
process.exit(code);
