import { defineConfig } from "vitest/config";

/**
 * The queue, handler and tenancy suites run against PGlite (real Postgres in
 * WASM, in-process); the card suite paints real PNGs through next/og. Both
 * take a second or two on a laptop and several on a shared CI runner, past
 * vitest's 5-second default: the same generous limits as the other PGlite
 * packages. The tests themselves are quick.
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
