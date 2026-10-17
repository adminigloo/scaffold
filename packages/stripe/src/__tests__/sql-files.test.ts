import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { stripeConnectedAccounts } from "../schema.js";

/** sql/upgrade-0.3-to-0.4.sql builds the table the code queries, and runs twice. */
describe("sql/upgrade-0.3-to-0.4.sql", () => {
  it("creates stripe_connected_accounts with one company per account, twice over", async () => {
    const db = new PGlite();
    const upgrade = readFileSync(join(__dirname, "..", "..", "sql", "upgrade-0.3-to-0.4.sql"), "utf8");
    await db.exec(upgrade);
    await db.exec(upgrade);
    const orm = drizzle(db);
    await orm.insert(stripeConnectedAccounts).values({ id: "r1", tenantId: "co_a", accountId: "acct_1" });
    const [row] = await orm.select().from(stripeConnectedAccounts);
    expect(row).toMatchObject({ tenantId: "co_a", accountId: "acct_1", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, disconnectedAt: null });
    await expect(orm.insert(stripeConnectedAccounts).values({ id: "r2", tenantId: "co_b", accountId: "acct_1" })).rejects.toThrow();
    // One ACTIVE account per company; a deauthorized one stays beside a new one.
    await expect(orm.insert(stripeConnectedAccounts).values({ id: "r3", tenantId: "co_a", accountId: "acct_2" })).rejects.toThrow();
    await db.exec(`update stripe_connected_accounts set deauthorized_at = now() where id = 'r1'`);
    await orm.insert(stripeConnectedAccounts).values({ id: "r4", tenantId: "co_a", accountId: "acct_2" });
    await db.close();
  });
});
