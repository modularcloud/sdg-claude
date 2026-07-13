// TEST-SPEC §12.0 I (SUITE-41): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section120iTests } from "./registry/section-12.0-i.js";

declareProductTests(section120iTests);
