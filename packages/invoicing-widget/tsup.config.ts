import { defineConfig } from "tsup";

/**
 * Two entries, both client bundles, the tenancy-widget's arrangement:
 * the customer's invoice page (`.`: InvoiceView) and the business's ledger (`./admin`: InvoicesLedger). Separate entries so a customer's bundle never ships the ledger.
 * tsup strips in-file "use client" directives while bundling, so the banner
 * re-applies it to every bundle head (shared chunks included); without it
 * every app-router page that renders one of these from a server component
 * fails to build.
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
