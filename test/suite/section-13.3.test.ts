// TEST-SPEC §13.3 (SUITE-46): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section133Tests } from "./registry/section-13.3.js";

declareProductTests(section133Tests);
