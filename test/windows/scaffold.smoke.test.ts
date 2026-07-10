import { expect, test } from "vitest";

// Scaffolding smoke test: proves the `windows` project wiring
// (vitest.config.ts, test/tsconfig.json, the `npm run test:windows` script,
// and the suite-windows CI job) executes tests on the Windows leg. It carries
// no TEST-SPEC coverage and is superseded by the real E-6 platform-sensitive
// subset; remove it once that exists. It is deliberately platform-neutral so
// the script also runs locally on any OS.
test("windows project runs on a supported Node.js line (>= 22)", () => {
  const major = Number(process.versions.node.split(".")[0]);
  expect(major).toBeGreaterThanOrEqual(22);
});
