// TEST-SPEC §16 P-5/P-6 (PROP-04): thin Vitest wrappers over the registered
// property tests — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section16P5P6Tests } from "./registry/section-16-p5-p6.js";

declareProductTests(section16P5P6Tests);
