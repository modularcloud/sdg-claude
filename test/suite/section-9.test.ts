// TEST-SPEC §9 through §9.2 (SUITE-31): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section9Tests } from "./registry/section-9.js";

declareProductTests(section9Tests);
