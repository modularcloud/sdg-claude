// TEST-SPEC §7 basics T7-1…T7-3 (SUITE-26): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section7BasicsTests } from "./registry/section-7-basics.js";

declareProductTests(section7BasicsTests);
