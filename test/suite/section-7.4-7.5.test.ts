// TEST-SPEC §7.4–7.5 T7.4-1, T7.4-2, T7.5-1…T7.5-6 (SUITE-29): thin Vitest
// wrapper over the registered bodies — the identical bodies the certification
// runner executes against fixture products (C-2 "one code path"). Expected to
// fail as diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section74to75Tests } from "./registry/section-7.4-7.5.js";

declareProductTests(section74to75Tests);
