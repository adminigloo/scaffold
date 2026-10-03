import { defineConfig } from "tsup";

/**
 * One build, two entries, both server code: `.` is functions and types only,
 * `./schema` is the pgTables — kept apart so an app's drizzle config can glob
 * the schema entry without dragging the slot engine and the handler factory
 * into its migration tooling, and so nothing that imports the barrel ever
 * receives a table object it could query around the tenant scoping.
 *
 * No client entry and therefore no "use client" banner: the React half is
 * @adminigloo/booking-widget. `clean` is done once in the build script, the
 * same convention every package keeps so a second config added later cannot
 * delete this one's output mid-build.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
]);
