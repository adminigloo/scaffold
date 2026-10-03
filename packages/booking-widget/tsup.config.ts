import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles: the public widget (`.`) and the host's
 * admin screens (`./admin`). Separate entries so a marketing page that
 * embeds <BookingWidget> never ships the admin; one config because both
 * need the same banner. tsup strips in-file "use client" directives while
 * bundling, so the banner re-applies it to every bundle head (shared chunks
 * included) — without it every app-router consumer that renders a component
 * from a server component fails to build. The pure helpers ride in the same
 * entries; they are plain functions and work from a client module on either
 * side.
 *
 * `clean` is done once in the build script (the analytics precedent), so a
 * future second config cannot delete this one's output mid-build.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/admin.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  banner: { js: '"use client";' },
  external: ["react", "react-dom"],
});
