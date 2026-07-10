import { expect, test } from "vitest";

// Scaffolding smoke test: proves the `suite` project wiring (vitest.config.ts,
// test/tsconfig.json, the `npm test` script, and the suite-linux CI job)
// executes tests. It carries no TEST-SPEC coverage and is superseded by the
// real product-facing tests of TEST-SPEC sections 1–16; remove it once they
// exist.
test("suite project runs on a supported Node.js line (>= 22)", () => {
  const major = Number(process.versions.node.split(".")[0]);
  expect(major).toBeGreaterThanOrEqual(22);
});
