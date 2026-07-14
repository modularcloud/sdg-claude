// TEST-SPEC §12.3–§12.5 (SUITE-44): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section123to125Tests } from "./registry/section-12.3-12.5.js";

declareProductTests(section123to125Tests);
