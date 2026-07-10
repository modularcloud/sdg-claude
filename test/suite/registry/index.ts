// Manifest of the product-facing test suite (TEST-SPEC sections 1–16) — the
// single `ProductTestSuite` instance every consumer shares (C-2 "one code
// path"): the thin Vitest wrappers in test/suite/*.test.ts declare exactly
// these entries against the built product (test/suite/declare.ts enforces
// membership), and the certification runner and the S-7 red-green sweep
// (test/self/) execute the full suite or named subsets of it against fixture
// products. A test body registered anywhere else does not exist as far as
// certification is concerned, so every section registration module MUST be
// spread into this list.
//
// Registration modules live beside this file (test/suite/registry/), one per
// TEST-SPEC section group, each exporting a `readonly ProductTestEntry[]`.
// Duplicate IDs across modules fail here at import time.

import { ProductTestSuite } from "../../helpers/registry.js";
import { section11to12Tests } from "./section-1.1-1.2.js";

export const productTestSuite = new ProductTestSuite([
  // Section registration modules are spread here as they are implemented.
  ...section11to12Tests,
]);
