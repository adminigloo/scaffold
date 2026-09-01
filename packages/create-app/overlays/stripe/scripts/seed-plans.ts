/**
 * Put the plan record into the `plans` table, so there is something to price.
 *
 *   pnpm db:seed        role templates and their grants — run this FIRST
 *   pnpm db:seed:plans  THIS file: the tiers in src/plans.ts, as rows
 *   pnpm db:seed:demo   people, plans and the shop, in that order
 *
 * WHY THIS EXISTS. `src/plans.ts` is the source of truth for what each tier
 * includes and costs, and the pricing page reads it directly — but checkout,
 * `subscriptions.plan_id` and the two cached Stripe ids all need a ROW. With an
 * empty `plans` table the record describes tiers nobody can subscribe to, the
 * billing page has no plan name to print, and the first thing anyone sees of a
 * subscription product is an empty page. The road was missing, not the
 * destination.
 *
 * NOT A FIXTURE, and the distinction matters. `seed-demo.ts` and `seed-shop.ts`
 * write fictional people and book orders nobody paid for, so both refuse to run
 * anywhere but localhost. This writes the projection of a record that is already
 * in this repository, identical in every environment that deploys the same
 * commit. Running it against production is the INTENDED way to publish a price
 * change; the alternative is editing amounts by hand in a table, which is
 * exactly the thing the record exists to stop. So there is no local-only gate
 * here — only the database it is about to write to, printed before it writes.
 *
 * IDEMPOTENT, and upserts on `plans.key` rather than on an id. The key is
 * `<tier>:<interval>:<currency>` and `planRowKey` is the one function that
 * spells it, so a re-run restores the row the record describes — including a
 * price somebody edited in the table, which snaps back. That is the point of
 * having a source of truth.
 *
 * IT NEVER DELETES. `subscriptions.plan_id` is `on delete restrict`, so removing
 * a row would either fail or take a paying customer's subscription with it.
 * A row the record no longer accounts for is REPORTED instead — see the orphan
 * section at the bottom, and `isActive: false` in `src/plans.ts` for the way to
 * retire a tier without stranding the people on it.
 *
 * THE CACHED STRIPE IDS ARE LEFT ALONE. `stripe_product_id` and
 * `stripe_price_id` are written when a plan is synced to Stripe, and a Stripe
 * price is immutable — so overwriting them from here with NULL would orphan
 * every live subscription's price with nothing recording where it went.
 */
import { reconcilePlans } from "__SCOPE__/billing";
import { plans as planTable } from "__SCOPE__/billing/schema";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "../src/db";
import { env } from "../src/env";
import { plans } from "../src/plans";

function fail(message: string): never {
  console.error("");
  console.error("SEED REFUSED");
  console.error(message);
  console.error("");
  process.exit(1);
}

/** Host and database only. The connection string carries a password. */
function describeDatabase(connectionString: string | undefined): string {
  if (connectionString === undefined) return "not configured";
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return "unparseable";
  }
}

/**
 * Everything already in the table, restricted to the keys the record projects
 * PLUS whatever else is there.
 *
 * Read whole rather than filtered, because the interesting rows are precisely
 * the ones the record does NOT project — an orphan is invisible to a query that
 * only asks about keys the record knows.
 */
async function readExisting(): Promise<
  readonly { readonly key: string; readonly isActive: boolean }[]
> {
  // Awaited rather than returned, so the query builder is resolved here. It is
  // thenable rather than a Promise, and handing one back from an async function
  // makes the failure surface at the await in `main` instead of at the query.
  const rows = await db
    .select({ key: planTable.key, isActive: planTable.isActive })
    .from(planTable);
  return rows;
}

async function main(): Promise<void> {
  if (!isDbConfigured(db)) {
    fail(
      "DATABASE_URL is not set, so there is no `plans` table to write into. " +
        "The record in src/plans.ts is still readable by the pricing page " +
        "without one — this script is only the half that has to be stored.",
    );
  }

  console.log("");
  console.log("Seeding the plan catalogue");
  console.log(`  database   ${describeDatabase(env.DATABASE_URL)}`);
  console.log(`  tiers      ${plans.tiers.length}`);
  console.log(`  currencies ${plans.currencies.join(", ")}`);
  console.log("");

  const reconciliation = reconcilePlans(plans, await readExisting());

  for (const row of reconciliation.upsert) {
    await db
      .insert(planTable)
      .values({
        key: row.key,
        name: row.name,
        description: row.description,
        interval: row.interval,
        priceMinor: row.priceMinor,
        currency: row.currency,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        // `tenant_id` is deliberately not set. The record is code, so every row
        // it projects is catalogue-wide and takes the column's FIRM_WIDE
        // default; a tenant-specific plan is a row somebody wrote by hand, and
        // this projection must never adopt one.
      })
      .onConflictDoUpdate({
        target: planTable.key,
        set: {
          name: row.name,
          description: row.description,
          interval: row.interval,
          priceMinor: row.priceMinor,
          currency: row.currency,
          isActive: row.isActive,
          sortOrder: row.sortOrder,
        },
      });
  }

  for (const tier of plans.tiers) {
    const rows = reconciliation.upsert.filter((row) => row.tierKey === tier.key);
    const priced =
      rows.length === 0
        ? "no price — contact us"
        : `${rows.length} row${rows.length === 1 ? "" : "s"}`;
    const state = tier.isActive ? "" : "  (retired)";
    console.log(`  ${tier.key.padEnd(16)} ${priced}${state}`);
  }

  if (reconciliation.orphaned.length > 0) {
    console.log("");
    console.log("ROWS THIS RECORD DOES NOT ACCOUNT FOR");
    console.log("");
    for (const orphan of reconciliation.orphaned) {
      console.log(`  ${orphan.key}`);
      console.log(`      ${orphan.why}`);
    }
    console.log("");
    console.log(
      "Nothing above was deleted. subscriptions.plan_id is on delete restrict,",
    );
    console.log(
      "so a delete either fails or takes a paying customer's subscription with it.",
    );
  }

  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  console.log("");
  console.log("Done. What the rows are for:");
  console.log("");
  console.log(`  ${base}/account/billing`);
  console.log("      a subscription's plan name and renewal amount come from");
  console.log("      plans.name and plans.price_minor, which are these rows");
  console.log("");
  console.log("What the RECORD is for, which needs no database at all:");
  console.log("");
  console.log("  grantsForPlan(plans.tier('pro'))      the entitlement rows a");
  console.log("                                        subscriber should hold");
  console.log("  planGrantDiff(held, plans.tier('pro')) an upgrade that keeps");
  console.log("                                        used_value intact");
  console.log("  planAllows(tier, 'support', 'priority')");
  console.log("");

  // A parting shot, after everything else, so it is the last thing on screen.
  if (reconciliation.needsAttention) {
    console.log(
      "At least one orphaned row is still ACTIVE, which means checkout can",
    );
    console.log(
      "resolve it and grantsForPlan has no tier to entitle the buyer from.",
    );
    console.log("");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
