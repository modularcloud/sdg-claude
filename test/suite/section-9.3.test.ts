// TEST-SPEC §9.3 (SUITE-32): thin Vitest wrapper over the registered bodies —
// the identical bodies the certification runner executes against fixture
// products (C-2 "one code path"). Expected to fail as diagnosed assertion
// failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section93Tests } from "./registry/section-9.3.js";

declareProductTests(section93Tests);
