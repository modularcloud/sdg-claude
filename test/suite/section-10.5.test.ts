// TEST-SPEC §10.5 (SUITE-36): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section105Tests } from "./registry/section-10.5.js";

declareProductTests(section105Tests);
