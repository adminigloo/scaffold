import { defineConfig } from "vitest/config";

/**
 * The store suites (commerce 0.2) run against PGlite — real Postgres in WASM,
 * in-process (src/__tests__/pglite.ts, copied from @adminigloo/invoicing) — so
 * the row locks, the conditional stock UPDATE and the unique indexes are the
 * real ones. Booting it takes a second or two; the hook timeout is generous.
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
