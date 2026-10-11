import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one validator port + Postgres dir: run files one at a time.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["sdk/test/**/*.test.ts", "indexer/test/**/*.test.ts", "api/test/**/*.test.ts", "keeper/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
    ],
  },
});
