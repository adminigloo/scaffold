import { describe } from "vitest";
import { db } from "@/db";

/**
 * The integration sandbox.
 *
 *   import { db, describeIntegration, withRollback } from "@/test/db";
 *
 *   describeIntegration("member invitations", () => {
 *     it("marks the invitation accepted", async () => {
 *       await withRollback(db, async (tx) => {
 *         await tx.insert(tenants).values(buildTenant());
 *         // ...assert here; the transaction is rolled back either way
 *       });
 *     });
 *   });
 */

/**
 * Re-exported, not reimplemented.
 *
 * `withRollback` escapes its transaction by throwing a sentinel that carries
 * the return value, and it checks that the driver really did roll back. A
 * local copy that dropped that check would commit test rows into a shared
 * database and nothing would say so.
 *
 * Because every write is rolled back, this sandbox does not need
 * `assertNotProduction`. A suite that TRUNCATEs instead of rolling back does —
 * import it from __SCOPE__/testing/db and call it before the first statement.
 */
export { withRollback } from "__SCOPE__/db";
export type { Transactable } from "__SCOPE__/db";

/**
 * The app's own handle, so an integration test exercises the same pool,
 * schema and Drizzle config the request path uses. A second handle built here
 * would let a test pass against a schema the app never loads.
 */
export { db };

/**
 * Read after src/test/setup.ts has run — setup files are evaluated before any
 * test module is imported, so .env.local has already been applied here.
 */
export const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * `describe` when a database is configured, `describe.skip` when it is not.
 *
 * WRAP EVERY DATABASE TEST IN THIS. vitest.config.ts separates the integration
 * project from the unit one, but it does not decide whether the tests run —
 * this does, per file, so a file still typechecks, still shows up in the
 * output, and reports as SKIPPED instead of failing on a connection nobody
 * asked it to make.
 *
 * A red suite that a developer cannot turn green without credentials is one
 * they stop reading, and then the unit failure hiding two lines below it goes
 * unread as well.
 */
export const describeIntegration = hasDatabase ? describe : describe.skip;
