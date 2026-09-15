import { defineConfig } from "tsup";

// One config, no client entry: everything here runs on the server. `clean`
// stays off in the config and happens once in the build script — the rule
// the feedback package learned when parallel configs raced each other's
// output (0.2.0 shipped without board.d.ts).
export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
