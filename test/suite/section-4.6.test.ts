// TEST-SPEC §4.6 (SUITE-16): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section46Tests } from "./registry/section-4.6.js";

declareProductTests(section46Tests);
