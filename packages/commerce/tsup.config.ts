import { defineConfig } from "tsup";

/**
 * Two builds (commerce 0.2):
 *
 *   server  .         pure cart maths, order numbers, the route tables and keys
 *           ./schema  the drizzle tables
 *           ./store   a store of its own: Check out, the webhook's rules, the handlers
 *   client  ./widget  the store's screens (React), stamped "use client" —
 *                     tsup strips in-file directives while bundling, so the
 *                     banner puts it back at every bundle head
 *
 * Two configs because only the screens may carry the banner. `clean` is done
 * once in the build script so neither config deletes the other's output.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts", "src/store-server.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/widget.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react", "react-dom"],
  },
]);
