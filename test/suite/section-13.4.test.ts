// TEST-SPEC §13.4 (SUITE-47): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section134Tests } from "./registry/section-13.4.js";

declareProductTests(section134Tests);
