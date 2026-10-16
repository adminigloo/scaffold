import { desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { resolveEntitlements, type EntitlementRow, type ResolvedEntitlement } from "./entitlements.js";
import { entitlements, plans, subscriptions } from "./schema.js";
import { planStanding, type PlanStanding } from "./standing.js";

/**
 * The database half of billing 0.3: one company's standing and what its plan
 * allows, read in two queries so a checkpoint can answer "open?" and a feature
 * can answer "how many?" from the same read.
 *
 * Kept off the root entry on purpose: the root is pure (no database), which is
 * what lets a browser bundle import the plan record and the standing words.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BillingDb = PgDatabase<any, any, any>;

export interface LoadPlanStandingInput {
  readonly tenantId: string;
  readonly now?: Date;
  /** When the company's free trial started (its creation, or the day plans were first enforced), or null for none. */
  readonly trialStartedAt: Date | null;
  readonly trialDays: number;
}

export interface CompanyPlan {
  readonly standing: PlanStanding;
  /** Every live entitlement the company holds (plan, add-ons, grants, overrides), one answer per feature. */
  readonly entitlements: ReadonlyMap<string, ResolvedEntitlement>;
}

/** A plan row key is `<tier>:<interval>:<currency>`; the tier is what standing names. */
function tierOf(planKey: string | null | undefined): string | null {
  if (!planKey) return null;
  const tier = planKey.split(":")[0];
  return tier && tier.length > 0 ? tier : null;
}

export async function loadCompanyPlan(db: BillingDb, input: LoadPlanStandingInput): Promise<CompanyPlan> {
  const now = input.now ?? new Date();
  const [latest] = await db
    .select({
      status: subscriptions.status,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      planKey: plans.key,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, input.tenantId))
    // Newest first; the id is a uuidv7, so two rows made in the same instant still order.
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);

  const rows = await db
    .select({
      feature: entitlements.feature,
      limitValue: entitlements.limitValue,
      usedValue: entitlements.usedValue,
      source: entitlements.source,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(eq(entitlements.tenantId, input.tenantId));

  const standing = planStanding({
    subscription: latest
      ? {
          status: latest.status,
          cancelAtPeriodEnd: latest.cancelAtPeriodEnd,
          currentPeriodEnd: latest.currentPeriodEnd,
          tierKey: tierOf(latest.planKey),
        }
      : null,
    planRowExpiries: rows.filter((r) => r.source === "plan").map((r) => r.expiresAt),
    trialStartedAt: input.trialStartedAt,
    trialDays: input.trialDays,
    now,
  });

  return { standing, entitlements: resolveEntitlements(rows as EntitlementRow[], now) };
}

/** Just the standing: what a plan gate's `standing(tenantId)` returns. */
export async function loadPlanStanding(db: BillingDb, input: LoadPlanStandingInput): Promise<PlanStanding> {
  return (await loadCompanyPlan(db, input)).standing;
}

/** Does the company hold a live Stripe subscription? (What a second checkout must never start beside.) */
export async function liveStripeSubscription(
  db: BillingDb,
  tenantId: string,
): Promise<{ readonly stripeSubscriptionId: string; readonly stripeCustomerId: string | null; readonly planKey: string | null; readonly status: string } | null> {
  const [row] = await db
    .select({
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeCustomerId: subscriptions.stripeCustomerId,
      status: subscriptions.status,
      planKey: plans.key,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  if (!row || row.stripeSubscriptionId === null) return null;
  if (!["trialing", "active", "past_due", "unpaid"].includes(row.status)) return null;
  return { stripeSubscriptionId: row.stripeSubscriptionId, stripeCustomerId: row.stripeCustomerId, planKey: row.planKey, status: row.status };
}

/** The Stripe customer this company has paid with before, if any, so a new checkout reuses it instead of making a second. */
export async function companyStripeCustomer(db: BillingDb, tenantId: string): Promise<string | null> {
  const rows = await db
    .select({ customer: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(20);
  return rows.find((r) => r.customer !== null)?.customer ?? null;
}
