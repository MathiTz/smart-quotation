import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    environment: "node",
    env: { SQ_OFFLINE: "1" },
    testTimeout: 20_000,
  },
});
