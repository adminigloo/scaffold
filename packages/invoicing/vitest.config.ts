import { defineConfig } from "vitest/config";

/**
 * The handler suites (Tenancy 2a) run against PGlite (real Postgres in WASM,
 * see src/__tests__/pglite.ts, copied from @adminigloo/scheduling). Booting it
 * takes a second or two, and a cold CI box is slower — so the hook timeout is
 * generous; the tests themselves are quick. `pglite.ts` and `fake-db.ts` are
 * helpers, not suites.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
