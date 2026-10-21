import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { entitlements, plans, subscriptions } from "./schema.js";

function checkTenant(tenantId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
}

/**
 * Is the company still paying through Stripe? Its newest subscription, when
 * it is on Stripe (a subscription id), still live (trialing with a card,
 * active, past due or unpaid) and on a plan that costs money. What deleting a
 * company must stop at: the business would go on being charged for
 * something that no longer exists. null when it isn't.
 */
export async function livePaidSubscription(
  db: PgDatabase<any, any, any>,
  tenantId: string,
): Promise<{ readonly planName: string; readonly status: string; readonly stripeSubscriptionId: string } | null> {
  const [row] = await db
    .select({ planName: plans.name, status: subscriptions.status, stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        isNotNull(subscriptions.stripeSubscriptionId),
        inArray(subscriptions.status, ["trialing", "active", "past_due", "unpaid"]),
        gt(plans.priceMinor, 0n),
      ),
    )
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  if (!row || row.stripeSubscriptionId === null) return null;
  return { planName: row.planName, status: row.status, stripeSubscriptionId: row.stripeSubscriptionId };
}

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): the company's
 * subscriptions here (the history of its plan — Stripe keeps its own), its
 * limits and anything granted to it, and any plan of its own; each statement
 * filtered by the company's id, subscriptions before plans. Run it on the
 * deletion's transaction, after `livePaidSubscription` said it isn't paying
 * (or staff chose to delete it anyway). The site's own plans ("*") are never
 * one company's.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  checkTenant(tenantId);
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts["subscriptions"] = (await db.delete(subscriptions).where(eq(subscriptions.tenantId, tenantId)).returning(one)).length;
  counts["entitlements"] = (await db.delete(entitlements).where(eq(entitlements.tenantId, tenantId)).returning(one)).length;
  counts["plans"] = (await db.delete(plans).where(eq(plans.tenantId, tenantId)).returning(one)).length;
  return counts;
}
