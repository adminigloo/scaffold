import { defineConfig } from "vitest/config";

/**
 * The store and instance suites run against PGlite (real Postgres in WASM,
 * see src/__tests__/pglite.ts). Booting it takes a second or two, and a cold
 * CI box is slower — so the hook timeout is generous; the tests themselves
 * are quick. `pglite.ts` is a helper, not a suite.
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
