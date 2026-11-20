import { readdirSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Two builds, as in feedback: the server entries (index, schema, and one
 * glances/<package> file per feature) and the client entry (ui), which needs
 * the "use client" banner put back after bundling. One config would stamp the
 * banner on the server entries too, and a route handler importing a
 * client-marked module is a build error in the app router.
 *
 * Each glances/<package> entry imports only its own feature package, so an
 * app imports the ones for the features it has and never needs the rest
 * installed.
 *
 * `clean` is off in both and done once in the build script: the two configs
 * run at the same time, and a clean in either deletes the other's output.
 */
const glances = Object.fromEntries(
  readdirSync("src/glances")
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => [`glances/${file.slice(0, -3)}`, `src/glances/${file}`]),
);

export default defineConfig([
  {
    entry: { index: "src/index.ts", schema: "src/schema.ts", ...glances },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
  },
  {
    entry: { ui: "src/ui.tsx" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react"],
  },
]);
