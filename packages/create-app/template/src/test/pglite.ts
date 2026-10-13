import { createPgliteDb } from "__SCOPE__/testing/pglite";
import { schema } from "@/db/schema";

/**
 * A real Postgres, in this process, holding every table this project has.
 *
 *   vi.mock("@/db", async () => {
 *     const { createAppPglite } = await import("@/test/pglite");
 *     return { db: (await createAppPglite()).db };
 *   });
 *
 * WHY: the proofs that matter most — one company can't reach another's rows,
 * setting a person up works in either order, the rank rules hold — need a
 * database, and a test that needs a database people have to set up is a test
 * that gets skipped. PGlite is Postgres compiled to run in-process, built here
 * from src/db/schema.ts (the same object the app hands drizzle), so these run
 * in `pnpm test` on every laptop and in CI with nothing configured.
 *
 * One connection: two transactions never truly run at once here. The race
 * tests in the packages prove the locking; these prove the wiring.
 */
export async function createAppPglite() {
  return createPgliteDb({ schema, logQueries: false });
}
