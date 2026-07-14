// TEST-SPEC §16 P-4 (PROP-03): thin Vitest wrapper over the registered
// property test — the identical body the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as a
// diagnosed assertion failure until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section16P4Tests } from "./registry/section-16-p4.js";

declareProductTests(section16P4Tests);
