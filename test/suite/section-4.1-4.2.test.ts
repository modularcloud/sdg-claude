// TEST-SPEC §4.1–4.2 (SUITE-13): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section41to42Tests } from "./registry/section-4.1-4.2.js";

declareProductTests(section41to42Tests);
