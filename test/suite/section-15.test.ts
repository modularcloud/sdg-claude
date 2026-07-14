// TEST-SPEC §15 (SUITE-50): thin Vitest wrapper over the registered body —
// the identical body the certification runner executes against fixture
// products (C-2 "one code path"). Expected to fail as a diagnosed assertion
// failure until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section15ExampleTests } from "./registry/section-15.js";

declareProductTests(section15ExampleTests);
