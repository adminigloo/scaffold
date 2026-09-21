import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  external: ["react", "react-dom"],
  // tsup strips in-file "use client" directives; an app-router consumer needs it
  // re-applied to the bundle head, exactly as the feedback widget does.
  banner: { js: '"use client";' },
});
