// TEST-SPEC §10.4 (SUITE-35): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section104Tests } from "./registry/section-10.4.js";

declareProductTests(section104Tests);
