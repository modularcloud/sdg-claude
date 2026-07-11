// TEST-SPEC §6.6 (SUITE-24): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section66Tests } from "./registry/section-6.6.js";

declareProductTests(section66Tests);
