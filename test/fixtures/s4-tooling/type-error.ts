// The S-4 known type error: a number argument where `greet` requires a
// string (TS2345). Deliberately broken and therefore excluded from
// `npm run typecheck` (test/tsconfig.json excludes fixtures/); the harness
// compiles this project through the tooling driver at test run time.

import { greet } from "./greeting.js";

export const wrong: string = greet(12345);
