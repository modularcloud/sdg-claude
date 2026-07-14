// TEST-SPEC §16 P-2 + P-3 (PROP-02): thin Vitest wrapper over the registered
// property tests — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section16P2P3Tests } from "./registry/section-16-p2-p3.js";

declareProductTests(section16P2P3Tests);
