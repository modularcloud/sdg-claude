// TEST-SPEC §10.7 second half (SUITE-39): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section107iiTests } from "./registry/section-10.7-ii.js";

declareProductTests(section107iiTests);
