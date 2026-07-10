// TEST-SPEC §1.5 (SUITE-04): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section15Tests } from "./registry/section-1.5.js";

declareProductTests(section15Tests);
