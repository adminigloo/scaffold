import { defineConfig } from "tsup";

// The server entries (the store, the runner, the handlers, the Anthropic
// engine — whose SDK import is type-only) and the screen (`./ui`, React).
// `clean` happens once, in the build script.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts", "src/anthropic.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    external: ["@anthropic-ai/sdk"],
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
