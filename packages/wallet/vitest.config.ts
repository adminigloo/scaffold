import { defineConfig } from "vitest/config";

/**
 * Some suites here run against PGlite (real Postgres in WASM). Booting one and
 * replaying a schema takes a second or two on a laptop and five or more on
 * GitHub's shared runner, past vitest's 5-second default: CI timed out on
 * them (Oct 23, 2026) while the code was fine. The same generous limits as
 * the other PGlite packages; the tests themselves are quick.
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
