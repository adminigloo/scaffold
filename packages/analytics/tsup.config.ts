import { defineConfig } from "tsup";

/**
 * Two builds, as in @adminigloo/feedback: index and schema are server code
 * (crawlers is the dependency-free classifier, its own entry so a request
 * proxy can test a User-Agent without loading the database layer),
 * client and dashboard are client components that need the "use client" banner
 * re-applied after bundling (tsup strips in-file directives) — and a route
 * handler importing a client-marked module is a build error in app router.
 * `clean` is done once in the build script: concurrent configs that each clean
 * delete each other's output.
 */
export default defineConfig([
  {
    entry: ["src/index.ts", "src/schema.ts", "src/crawlers.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: ["src/client.tsx", "src/dashboard.tsx"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react", "web-vitals"],
  },
]);
