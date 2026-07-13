// TEST-SPEC §10.2–§10.3 (SUITE-34): thin Vitest wrapper over the registered
// bodies — the identical bodies the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as diagnosed
// assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section102to103Tests } from "./registry/section-10.2-10.3.js";

declareProductTests(section102to103Tests);
