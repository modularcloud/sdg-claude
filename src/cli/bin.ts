#!/usr/bin/env node
// Scaffolding placeholder for the `xspec` executable (IMPLEMENTATION.md: the
// bin is a trivial wrapper around the cli entry). The product is not
// implemented yet, so this stub behaves as the deliberately empty product of
// TEST-SPEC H-8/S-7: it emits nothing and exits with a code outside the
// SPEC.md 12.0 exit partition (0 | 1 | 2), so every product-facing test fails
// as a diagnosed assertion failure — never a false pass or a harness crash —
// until the real product replaces this file.
process.exit(86);
