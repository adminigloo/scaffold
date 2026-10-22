import { defineConfig } from "vitest/config";

/**
 * The suites run against PGlite — real Postgres in WASM, in-process
 * (src/__tests__/pglite.ts) — so the ledger's unique index that makes a
 * second run send nobody anything is the real one.
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
