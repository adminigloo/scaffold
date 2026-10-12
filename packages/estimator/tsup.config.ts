import { defineConfig } from "tsup";

/**
 * Four entries, all server code:
 *
 *   .           functions, types, permission keys, the two handler factories
 *   ./schema    the drizzle pgTables, for an app's drizzle config to glob
 *   ./comms     createEstimatorCommsListener and the default email templates
 *   ./anthropic createAnthropicTakeoffRunner: the photo reading on Claude
 *
 * `./comms` and `./anthropic` are their own entries because they are the only
 * code that touches an OPTIONAL peer (@adminigloo/comms, @anthropic-ai/sdk):
 * an app that sends its own mail, or reads no photos, imports the barrel and
 * never installs either. tsup leaves peers external, so each entry uses the
 * app's own copy rather than bundling a second one.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/comms.ts", "src/anthropic.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
