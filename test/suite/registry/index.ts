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
import { section13Tests } from "./section-1.3.js";
import { section14Tests } from "./section-1.4.js";
import { section15Tests } from "./section-1.5.js";
import { section16to17Tests } from "./section-1.6-1.7.js";
import { section21Tests } from "./section-2.1.js";
import { section22to23Tests } from "./section-2.2-2.3.js";
import { section24Tests } from "./section-2.4.js";
import { section25to26Tests } from "./section-2.5-2.6.js";

export const productTestSuite = new ProductTestSuite([
  // Section registration modules are spread here as they are implemented.
  ...section11to12Tests,
  ...section13Tests,
  ...section14Tests,
  ...section15Tests,
  ...section16to17Tests,
  ...section21Tests,
  ...section22to23Tests,
  ...section24Tests,
  ...section25to26Tests,
]);
