import { defineConfig } from "tsup";

/**
 * Two builds (social 0.1), as in @adminigloo/customers:
 *
 *   server  .            the pure core: platforms, the number guard, the
 *                        writer, the honesty list, the sources, the view, the
 *                        route table and the permission keys (safe anywhere)
 *           ./schema     the drizzle table, under a prefix the app chooses
 *           ./server     the queue (every call inside one company), forget,
 *                        and the HTTP handler
 *           ./cards      the card specs, signed addresses, layout and the
 *                        renderer (React elements, painted by the app's painter)
 *           ./fonts      the cards' fonts, embedded (no file to trace)
 *           ./anthropic  the metered Claude call (type-only SDK import)
 *   client  ./ui         the queue screens (React), stamped "use client" —
 *                        tsup strips in-file directives while bundling, so the
 *                        banner puts it back at every bundle head
 *
 * `clean` is done once in the build script so neither config deletes the
 * other's output.
 */
export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      schema: "src/schema.ts",
      server: "src/server.ts",
      cards: "src/cards/index.ts",
      fonts: "src/cards/fonts.ts",
      anthropic: "src/anthropic.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    external: ["@anthropic-ai/sdk", "react", "react-dom"],
  },
  {
    entry: { ui: "src/ui/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    banner: { js: '"use client";' },
    external: ["react", "react-dom"],
  },
]);
