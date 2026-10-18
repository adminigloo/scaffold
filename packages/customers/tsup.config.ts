import { defineConfig } from "tsup";

/**
 * Two builds (customers 0.1):
 *
 *   server  .         pure pieces: matching keys, the CSV reader, the route
 *                     table and the permission keys (safe in a browser)
 *           ./schema  the drizzle tables
 *           ./server  find-or-create, links, the timeline, merge, import and
 *                     export, the directory, the backfill and the handlers
 *   client  ./admin   the customer screens (React), stamped "use client" —
 *                     tsup strips in-file directives while bundling, so the
 *                     banner puts it back at every bundle head
 *
 * `clean` is done once in the build script so neither config deletes the
 * other's output.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts", "src/server.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/admin.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react", "react-dom"],
  },
]);
