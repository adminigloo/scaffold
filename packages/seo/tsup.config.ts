import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

/** The analytics version whose crawler list is compiled in (ROBOTS_BOTS_SOURCE.analytics). */
const analyticsVersion: string = JSON.parse(readFileSync("node_modules/@adminigloo/analytics/package.json", "utf8")).version;

/**
 * Three entries, one build: none of them is a client module.
 *
 *   - `.` is the pure core: no React, no Next, no Node APIs (it runs on the
 *     edge). It BUNDLES @adminigloo/analytics' `crawlers` module (a
 *     devDependency, so tsup inlines it): robots.txt is built from the same bot
 *     list the crawler log classifies with, compiled in from the same commit,
 *     and the published package has no runtime dependency on analytics. No
 *     public type names an analytics type, so the .d.ts needs nothing from it.
 *   - `./react` is a server-safe component (no hooks), so it gets NO
 *     "use client" banner: structured data belongs in the server HTML.
 *   - `./og` imports `next/og`, an optional peer, kept external.
 *
 * `clean` is done once in the build script (the feedback package's lesson).
 *
 * The analytics version is stamped in (`ROBOTS_BOTS_SOURCE`), so an app can
 * see which list a published build carries. The list itself still comes from
 * whatever analytics is built in the workspace at build time; the drift test
 * (robots-drift.test.ts) makes a changed list ship in a new release of this
 * package.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx", "src/og.tsx"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  external: ["react", "react/jsx-runtime", "react-dom", "next", "next/og"],
  define: { __ADMINIGLOO_ANALYTICS_VERSION__: JSON.stringify(analyticsVersion) },
});
