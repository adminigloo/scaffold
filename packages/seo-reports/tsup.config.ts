import { defineConfig } from "tsup";

// Two configs, one build: the server entries (node: imports, the crawler) and
// the screen (`./ui`, React, no node:). `clean` stays off in the configs and
// happens once in the build script — the rule the feedback package learned
// when parallel configs raced each other's output.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    platform: "node",
  },
  {
    entry: ["src/ui.tsx"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    external: ["react", "react-dom"],
    banner: { js: '"use client";' },
  },
]);
