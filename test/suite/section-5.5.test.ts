// TEST-SPEC §5.5 (SUITE-19): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section55Tests } from "./registry/section-5.5.js";

declareProductTests(section55Tests);
