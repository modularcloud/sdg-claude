// TEST-SPEC §10.7 first half (SUITE-38): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section107iTests } from "./registry/section-10.7-i.js";

declareProductTests(section107iTests);
