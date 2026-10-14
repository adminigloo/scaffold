import { defineConfig } from "tsup";

/**
 * Three entries, all server code (Tenancy 2a adds the third):
 *
 *   .        functions, types, permission keys, the settings fragment, the
 *            HTTP handler factories and their route tables
 *   ./schema the drizzle pgTables, for an app's drizzle config to glob
 *   ./comms  the invoice email: its templates and the sender
 *
 * `./comms` is its own entry because it is the only code that imports
 * `@adminigloo/comms` (an OPTIONAL peer), scheduling's arrangement: an app
 * that emails its own invoices, or none, imports the barrel and never needs
 * comms installed. tsup leaves peers external, so the comms entry requires the
 * app's own copy of comms rather than bundling a second one with its own tables.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/comms.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
