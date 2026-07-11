// TEST-SPEC §5.4 (SUITE-18): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section54Tests } from "./registry/section-5.4.js";

declareProductTests(section54Tests);
