import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
