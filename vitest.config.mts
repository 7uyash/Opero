import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    setupFiles: ["./test/setup-env.ts"],
    // Integration tests share one test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
