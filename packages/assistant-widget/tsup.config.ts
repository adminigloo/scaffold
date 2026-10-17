import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles: the chat and the launcher (`.`), and the
 * owner's settings screen (`./admin`), so a page that only shows the chat
 * never ships the settings. tsup strips in-file "use client" directives; the
 * banner re-applies it to every bundle head, so an app-router page can render
 * these from a server component.
 */
export default defineConfig({
  entry: { index: "src/index.ts", admin: "src/admin/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  external: ["react", "react-dom"],
  banner: { js: '"use client";' },
});
