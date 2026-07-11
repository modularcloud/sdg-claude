// TEST-SPEC §5.1–5.3 (SUITE-17): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section51to53Tests } from "./registry/section-5.1-5.3.js";

declareProductTests(section51to53Tests);
