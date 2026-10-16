import { defineConfig } from "tsup";

// One config, server code only: the root, the schema, the three adapters and
// the test helpers (Tenancy 2b-1, 6.13). `clean` stays off in the config and
// happens once in the build script — the rule the feedback package learned
// when parallel configs raced each other's output (0.2.0 shipped without
// board.d.ts). `./s3` and `./local` import node:crypto and node:fs, which is
// why they are their own entries and never reached from the root.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    "vercel-blob": "src/vercel-blob.ts",
    s3: "src/s3.ts",
    local: "src/local.ts",
    testing: "src/testing.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
  external: ["node:crypto", "node:fs/promises", "node:path"],
});
