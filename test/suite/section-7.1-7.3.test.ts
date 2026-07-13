// TEST-SPEC §7.1–7.3 T7.1-1, T7.2-1, T7.3-1 (SUITE-28): thin Vitest wrapper
// over the registered bodies — the identical bodies the certification runner
// executes against fixture products (C-2 "one code path"). Expected to fail
// as diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section71to73Tests } from "./registry/section-7.1-7.3.js";

declareProductTests(section71to73Tests);
