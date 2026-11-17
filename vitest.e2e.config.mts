import { defineConfig } from "vitest/config";

/**
 * End-to-end tests over HTTP against a running app (`pnpm dev` + `pnpm dev:worker`, or the Docker
 * stack). They use the app's own database, so every test creates its own uniquely named businesses.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    setupFiles: ["./e2e/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
