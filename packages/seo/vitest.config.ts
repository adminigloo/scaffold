import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const analyticsVersion: string = JSON.parse(readFileSync("node_modules/@adminigloo/analytics/package.json", "utf8")).version;

export default defineConfig({
  define: { __ADMINIGLOO_ANALYTICS_VERSION__: JSON.stringify(analyticsVersion) },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 30_000,
  },
});
