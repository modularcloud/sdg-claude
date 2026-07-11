import { expect, test } from "vitest";

// Scaffolding smoke test: proves the `self` project wiring (vitest.config.ts,
// test/tsconfig.json, the `npm run test:self` script, and the harness-self CI
// job) executes tests. It carries no TEST-SPEC coverage and is superseded by
// the real harness self-tests and certification runner of TEST-SPEC section
// 17; remove it once they exist.
test("self project runs on a supported Node.js line (>= 22)", () => {
  const major = Number(process.versions.node.split(".")[0]);
  expect(major).toBeGreaterThanOrEqual(22);
});
