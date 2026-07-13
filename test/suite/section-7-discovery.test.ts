// TEST-SPEC §7 discovery T7-4…T7-6 (SUITE-27): thin Vitest wrapper over the
// registered bodies — the identical bodies the certification runner executes
// against fixture products (C-2 "one code path"). Expected to fail as
// diagnosed assertion failures until the product exists (H-8).

import { declareProductTests } from "./declare.js";
import { section7DiscoveryTests } from "./registry/section-7-discovery.js";

declareProductTests(section7DiscoveryTests);
