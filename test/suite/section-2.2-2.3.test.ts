// TEST-SPEC §2.2–2.3 (SUITE-07): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section22to23Tests } from "./registry/section-2.2-2.3.js";

declareProductTests(section22to23Tests);
