import { defineConfig } from "vitest/config";

/**
 * The store, migration and upgrade suites run against PGlite (real Postgres
 * in WASM). Booting one and replaying a schema takes a second or two on a
 * laptop and five to six on GitHub's shared runner, past vitest's 5-second
 * default: the upgrade suites timed out there (CI on Oct 22, 2026) while the
 * code was fine. The same generous limits as the other PGlite packages; the
 * tests themselves are quick.
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
