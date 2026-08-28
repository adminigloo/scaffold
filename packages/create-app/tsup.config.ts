import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // The shebang has to be in the emitted file, not the source: a `#!` line in
  // a .ts file is a syntax error for tsc and for the test runner.
  banner: { js: "#!/usr/bin/env node" },
});
