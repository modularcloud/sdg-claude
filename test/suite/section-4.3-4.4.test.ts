// TEST-SPEC §4.3–4.4 (SUITE-14): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section43to44Tests } from "./registry/section-4.3-4.4.js";

declareProductTests(section43to44Tests);
