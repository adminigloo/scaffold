import { defineConfig } from "tsup";

/**
 * Two builds because the entries have different natures.
 *
 *   - `.`, `./core`, `./schema`, `./testing` are server code. `./core` is the
 *     part with NO peer dependency at all (rules, classification, the
 *     `AudienceStore` interface, `createAudience`), so an app on MySQL or with
 *     no Drizzle — Road Rally — can use it; `.` adds the Drizzle Postgres store
 *     and the `sql` fragments; `./schema` is the pgTables alone, so a
 *     drizzle-kit config can glob it without loading the rest; `./testing` is
 *     the source guard, which reads files with node:fs.
 *   - `./ui` is a client entry: React components that need the "use client"
 *     banner re-applied after bundling (tsup strips in-file directives). One
 *     config would stamp the banner on the server entries too, and a route
 *     handler importing a client-marked module is a build error in app router.
 *
 * `clean` is OFF in both and done once in the build script instead: the two
 * configs run concurrently, and a clean inside either one deletes the other's
 * freshly written output (how feedback 0.2.0 shipped without board.d.ts).
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/core.ts", "src/schema.ts", "src/testing.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/ui.tsx"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react"],
  },
]);
