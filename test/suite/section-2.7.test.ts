// TEST-SPEC §2.7 (SUITE-10): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section27Tests } from "./registry/section-2.7.js";

declareProductTests(section27Tests);
