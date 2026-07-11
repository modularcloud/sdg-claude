// TEST-SPEC §1.6–1.7 (SUITE-05): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section16to17Tests } from "./registry/section-1.6-1.7.js";

declareProductTests(section16to17Tests);
