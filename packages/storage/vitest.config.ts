import { defineConfig } from "vitest/config";

/**
 * Copied from @adminigloo/comms (Tenancy 2b-1, 6.13). The 0.2 suites run
 * against PGlite (real Postgres in WASM, see src/__tests__/pglite.ts). Booting
 * it takes a second or two, and a cold CI box is slower — so the hook timeout
 * is generous; the tests themselves are quick. `pglite.ts` and `fake-s3.ts`
 * are helpers, not suites.
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
