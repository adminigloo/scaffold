import { defineConfig } from "tsup";

/**
 * Two builds because the entries have different natures: index and schema are
 * server/isomorphic, board is a client component that needs the "use client"
 * banner re-applied after bundling (tsup strips in-file directives). A single
 * config would stamp the banner on the server entries too, and a route
 * handler importing a client-marked module is a build error in app router.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
  },
  {
    entry: ["src/board.tsx"],
    format: ["esm", "cjs"],
    dts: true,
    banner: { js: '"use client";' },
    external: ["react"],
  },
]);
