// TEST-SPEC §2.5–2.6 (SUITE-09): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section25to26Tests } from "./registry/section-2.5-2.6.js";

declareProductTests(section25to26Tests);
