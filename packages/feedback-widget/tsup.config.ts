import { defineConfig } from "tsup";

/**
 * The one runtime package with a tsup config file instead of an inline CLI
 * build (precedent: create-app). It exists for the banner: this is the first
 * package that ships client components, and tsup strips "use client"
 * directives from source files during bundling, so the directive has to be
 * re-applied to the bundle head or every consumer breaks inside app router
 * server components.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  banner: { js: '"use client";' },
  external: ["react", "react-dom"],
});
