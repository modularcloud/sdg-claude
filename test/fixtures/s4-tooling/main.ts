// Consumer file of the S-4 fixture project: imports and correctly uses the
// fixture's exported function. S-4 probes hover and go-to-definition on the
// greet reference below.

import { greet } from "./greeting.js";

export const greetingForWorld: string = greet("world");
