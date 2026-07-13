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
import { section27Tests } from "./section-2.7.js";
import { section3Tests } from "./section-3.js";
import { section4Tests } from "./section-4.js";
import { section41to42Tests } from "./section-4.1-4.2.js";
import { section43to44Tests } from "./section-4.3-4.4.js";
import { section45Tests } from "./section-4.5.js";
import { section46Tests } from "./section-4.6.js";
import { section51to53Tests } from "./section-5.1-5.3.js";
import { section54Tests } from "./section-5.4.js";
import { section55Tests } from "./section-5.5.js";
import { section56Tests } from "./section-5.6.js";
import { section61Tests } from "./section-6.1.js";
import { section62Tests } from "./section-6.2.js";
import { section63Tests } from "./section-6.3.js";
import { section64Tests } from "./section-6.4.js";
import { section65Tests } from "./section-6.5.js";
import { section66Tests } from "./section-6.6.js";
import { section7BasicsTests } from "./section-7-basics.js";
import { section7DiscoveryTests } from "./section-7-discovery.js";
import { section71to73Tests } from "./section-7.1-7.3.js";
import { section74to75Tests } from "./section-7.4-7.5.js";
import { section8Tests } from "./section-8.js";

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
  ...section27Tests,
  ...section3Tests,
  ...section4Tests,
  ...section41to42Tests,
  ...section43to44Tests,
  ...section45Tests,
  ...section46Tests,
  ...section51to53Tests,
  ...section54Tests,
  ...section55Tests,
  ...section56Tests,
  ...section61Tests,
  ...section62Tests,
  ...section63Tests,
  ...section64Tests,
  ...section65Tests,
  ...section66Tests,
  ...section7BasicsTests,
  ...section7DiscoveryTests,
  ...section71to73Tests,
  ...section74to75Tests,
  ...section8Tests,
]);
