import { defineConfig } from "vitest/config";

/**
 * The service suites run against PGlite (real Postgres in WASM, see
 * src/__tests__/pglite.ts). Booting it takes a second or two, and a cold CI box
 * is slower — so the hook timeout is generous; the tests themselves are quick.
 * `pglite.ts` is a helper, not a suite. The same settings as
 * @adminigloo/booking, for the same reason.
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
