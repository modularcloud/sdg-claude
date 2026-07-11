// TEST-SPEC §5.6 (SUITE-20): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section56Tests } from "./registry/section-5.6.js";

declareProductTests(section56Tests);
