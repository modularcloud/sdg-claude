// TEST-SPEC §1.4 (SUITE-03): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section14Tests } from "./registry/section-1.4.js";

declareProductTests(section14Tests);
