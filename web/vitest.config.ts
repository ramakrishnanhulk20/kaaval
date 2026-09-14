import { defineConfig } from "vitest/config";

/**
 * The site's own tests. The account layer runs against an embedded Postgres, which takes
 * a few seconds to start the first time, so the timeout is wider than the default.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
