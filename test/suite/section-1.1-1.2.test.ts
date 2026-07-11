// TEST-SPEC §1.1–1.2 (SUITE-01): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section11to12Tests } from "./registry/section-1.1-1.2.js";

declareProductTests(section11to12Tests);
