#!/usr/bin/env node
// VIOL-CORE-PERSISTREADS violator executable (CERTIFICATIONS.md
// §VIOL-CORE-PERSISTREADS). The CONF-CORE conformer with exactly one
// behavioral deviation: review reads persist read-time invalidation — when
// `status`, `next`, `show`, or `export` computes that a resolved item's
// recorded state differs from the current graph (SPEC 10.4), it rewrites
// that item's stored status to `invalidated` in the session file. Reads over
// sessions with no stale resolution write nothing. Certifies T10.4-5 (C-1):
// exactly it fails against this fixture; every other §CONF-CORE in-scope
// test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  persistReadInvalidation: true,
});
process.exit(code);
