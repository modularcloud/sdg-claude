import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/dryrun.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
