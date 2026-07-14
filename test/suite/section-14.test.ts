// TEST-SPEC §14 (SUITE-49): thin Vitest wrapper over the registered bodies —
// the identical bodies the certification runner executes against fixture
// products (C-2 "one code path"). Expected to fail as diagnosed assertion
// failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section14ValidationTests } from "./registry/section-14.js";

declareProductTests(section14ValidationTests);
