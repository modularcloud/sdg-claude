// TEST-SPEC §8 T8-1…T8-5, T8.2-1 (SUITE-30): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section8Tests } from "./registry/section-8.js";

declareProductTests(section8Tests);
