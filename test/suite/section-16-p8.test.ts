// TEST-SPEC §16 P-8 (PROP-06): thin Vitest wrapper over the registered
// fuzz test — the identical body the certification runner executes against
// fixture products (C-2 "one code path"). Expected to fail as a diagnosed
// assertion failure until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section16P8Tests } from "./registry/section-16-p8.js";

declareProductTests(section16P8Tests);
