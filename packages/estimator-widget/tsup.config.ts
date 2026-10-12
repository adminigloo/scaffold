import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles, the scheduling-widget arrangement: the
 * customer-facing components (`.`: EstimateTool, the button + modal, QuoteView)
 * and the staff screens (`./admin`: EstimatorAdmin, PriceBook, EstimatesQueue,
 * EstimateEditor, EmbedKeys, EstimatorSettings). Separate entries so a
 * contractor's marketing page that embeds the estimate never ships the price
 * book. tsup strips in-file "use client" directives while bundling, so the
 * banner re-applies it to every bundle head (shared chunks included); without
 * it an app-router page that renders one of these from a server component
 * fails to build.
 *
 * The admin entry lives at src/admin/index.ts and is NAMED `admin` here, so it
 * lands at dist/admin.js, the path package.json's "./admin" export points at.
 * `clean` is done once in the build script, so a second config added later
 * cannot delete this one's output mid-build.
 */
export default defineConfig({
  entry: { index: "src/index.ts", admin: "src/admin/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  external: ["react", "react-dom"],
  banner: { js: '"use client";' },
});
