import { defineConfig } from "vitest/config";

/**
 * The 0.3 suites run against PGlite (real Postgres in WASM, see
 * src/__tests__/pglite.ts, copied from @adminigloo/scheduling). Booting it
 * takes a second or two, and a cold CI box is slower, so the hook timeout is
 * generous; the tests themselves are quick. The 0.2 suites keep their
 * in-memory fake (src/__tests__/fake-db.ts), which is a helper, not a suite.
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
