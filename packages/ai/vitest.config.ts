import { defineConfig } from "vitest/config";

/**
 * The ledger suites (0.2.0) run against PGlite — real Postgres in WASM, in
 * process — so the allowance is checked on the real SUM and COUNT, not a
 * fake's idea of them. Booting it takes a second or two, hence the hook
 * timeout. `pglite.ts` is a helper, not a suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
