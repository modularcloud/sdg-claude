// TEST-SPEC §13.1–13.2 (SUITE-45): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section131to132Tests } from "./registry/section-13.1-13.2.js";

declareProductTests(section131to132Tests);
