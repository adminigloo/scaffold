import { defineConfig } from "vitest/config";

/**
 * The company suites (0.9.0) run against PGlite — real Postgres in WASM, in
 * process — so every company filter, the full-text search and the one-click
 * confirm are checked on real SQL. `pglite.ts` and `fake-provider.ts` are
 * helpers, not suites.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
