import { defineConfig } from "vitest/config";

/**
 * Comms' config (node, PGlite timeouts: booting it takes a second or two, and
 * a cold CI box is slower), as TWO projects (Tenancy 2b-1, 15.1; review G1):
 *
 *   - "default": every suite, on the 0.1 table names;
 *   - "foreign": the SERVICE suites again, on tables built from
 *     `notificationsSql({ schema: "adminigloo", prefix: "aig_" })` next to a
 *     host's own `public.notifications` table with rows, which each suite's
 *     `close()` checks is untouched (src/__tests__/pglite.ts).
 *
 * `pglite.ts` and `fixtures.ts` are helpers, not suites.
 */

const SERVICE_SUITES = ["audience", "notify", "email", "recheck", "claims", "reads", "prune", "handlers", "routes", "host-seams"].map(
  (name) => `src/__tests__/${name}.test.ts`,
);

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: { name: "default", include: ["src/**/*.test.ts"], env: { NOTIFICATIONS_TEST_LAYOUT: "default" } },
      },
      {
        extends: true,
        test: { name: "foreign", include: SERVICE_SUITES, env: { NOTIFICATIONS_TEST_LAYOUT: "foreign" } },
      },
    ],
  },
});
