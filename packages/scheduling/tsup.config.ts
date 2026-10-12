import { defineConfig } from "tsup";

/**
 * Three entries, all server code:
 *
 *   .        functions, types, permission keys, the handler factories
 *   ./schema the drizzle pgTables, for an app's drizzle config to glob
 *   ./comms  createSchedulingCommsListener and the default email templates
 *
 * `./comms` is its own entry because it is the only code that imports
 * `@adminigloo/comms` (an OPTIONAL peer): an app that sends its own mail, or
 * none, imports the barrel and never needs comms installed. tsup leaves peers
 * external, so the comms entry requires the app's own copy of comms rather
 * than bundling a second one with its own tables.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/comms.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
