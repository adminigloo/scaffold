import { defineConfig } from "tsup";

/**
 * Four entries, all server code:
 *
 *   .           the brain, the engine, the loop, the registry, the handlers
 *   ./schema    the drizzle pgTables, for an app's drizzle config
 *   ./anthropic createAnthropicProvider: the assistant on Claude, with prompt caching
 *   ./vector    the OPTIONAL vector table (pgvector) and reindexPageDoc
 *
 * `./anthropic` and `./vector` are their own entries because they are the
 * only code that touches an optional peer (@anthropic-ai/sdk) or an optional
 * database extension (pgvector): an app on another model, or on keyword
 * search, never loads either.
 */
export default defineConfig({
  entry: ["src/index.ts", "src/schema.ts", "src/anthropic.ts", "src/vector.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: false,
});
