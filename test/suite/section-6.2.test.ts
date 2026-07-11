// TEST-SPEC §6.2 (SUITE-22): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section62Tests } from "./registry/section-6.2.js";

declareProductTests(section62Tests);
