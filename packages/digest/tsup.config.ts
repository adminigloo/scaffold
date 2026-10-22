import { defineConfig } from "tsup";

/**
 * Two builds (digest 0.1):
 *
 *   server  .         the kinds, the clock in each person's zone, the signed
 *                     links, the email layout, the instance (preferences,
 *                     the daily run, the preview, alert emails) and the HTTP
 *                     handlers
 *           ./schema  the drizzle tables, with nothing else attached
 *   client  ./ui      the preferences screen and the sign-up choice (React),
 *                     stamped "use client" — tsup strips in-file directives
 *                     while bundling, so the banner puts it back at every
 *                     bundle head
 *
 * `clean` is done once in the build script so neither config deletes the
 * other's output.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/ui.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react", "react-dom"],
  },
]);
