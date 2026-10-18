import { defineConfig } from "vitest/config";

/**
 * The suites run against PGlite — real Postgres in WASM, in-process
 * (src/__tests__/pglite.ts, copied from @adminigloo/commerce) — so the unique
 * partial indexes that make a double-create one customer are the real ones.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
