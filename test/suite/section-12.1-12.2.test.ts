// TEST-SPEC §12.1–12.2 (SUITE-43): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section121to122Tests } from "./registry/section-12.1-12.2.js";

declareProductTests(section121to122Tests);
