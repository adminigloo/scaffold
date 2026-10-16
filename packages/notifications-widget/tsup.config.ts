import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles, comms-widget's arrangement (Tenancy 2b-1,
 * section 5): the wire types, the wire version and the transport only (`.`),
 * and the alerts screens (`./admin`: AlertsBell, AlertsInbox, AlertSettings).
 * The screens sit under ./admin like every other staff screen, so a page that
 * only needs the types never ships them.
 * tsup strips in-file "use client" directives while bundling, so the banner
 * re-applies it to every bundle head (shared chunks included); without it
 * every app-router page that renders one of these from a server component
 * (the bell in the header is exactly that) fails to build.
 *
 * The admin entry lives at src/admin/index.ts and is NAMED `admin` here, so it
 * lands at dist/admin.js, the path package.json's "./admin" export points at.
 * `clean` is done once in the build script.
 */
export default defineConfig({
  entry: { index: "src/index.ts", admin: "src/admin/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  banner: { js: '"use client";' },
  external: ["react", "react-dom"],
});
