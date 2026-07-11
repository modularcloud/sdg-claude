// TEST-SPEC §6.1 (SUITE-21): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section61Tests } from "./registry/section-6.1.js";

declareProductTests(section61Tests);
