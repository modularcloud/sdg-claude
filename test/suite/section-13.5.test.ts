// TEST-SPEC §13.5 (SUITE-48): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section135Tests } from "./registry/section-13.5.js";

declareProductTests(section135Tests);
