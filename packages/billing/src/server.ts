import { desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { resolveEntitlements, type EntitlementRow, type ResolvedEntitlement } from "./entitlements.js";
import { DEFAULT_PLAN_LINE, freeGrantRows, type PlanCatalog } from "./plans.js";
import { entitlements, plans, subscriptions } from "./schema.js";
import { combineStandings, planStanding, type PlanStanding } from "./standing.js";
import type { SubscriptionStatus } from "./status.js";

/**
 * The database half of billing 0.3: one company's standing and what its plan
 * allows, read in two queries so a checkpoint can answer "open?" and a feature
 * can answer "how many?" from the same read.
 *
 * Billing 0.5 reads it PER PRODUCT LINE: a tenant can hold Weather Pro and
 * Sports Basic at once, each with its own standing (one can lapse while the
 * other renews), and `standing` is the best of them.
 *
 * Kept off the root entry on purpose: the root is pure (no database), which is
 * what lets a browser bundle import the plan record and the standing words.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BillingDb = PgDatabase<any, any, any>;

/** The part of the plan record the reads below need: which tier is on which line. */
export type PlanLinesOf = Pick<PlanCatalog, "lines">;

export interface LoadPlanStandingInput {
  readonly tenantId: string;
  readonly now?: Date;
  /** When the company's free trial started (its creation, or the day plans were first enforced), or null for none. */
  readonly trialStartedAt: Date | null;
  readonly trialDays: number;
  /**
   * The plan record (billing 0.5), so the standing is worked out per product
   * line. Omitted: one line, read exactly as before lines existed.
   */
  readonly plans?: PlanLinesOf;
}

/** One product line's newest subscription row, as the screens and the gate need it. */
export interface LineSubscription {
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly tierKey: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly stripeItemId: string | null;
}

/** Where a tenant stands on one product line. */
export interface LinePlan {
  readonly line: string;
  readonly standing: PlanStanding;
  /** The line's newest subscription row (what the standing was worked out from), or null when it never had one. */
  readonly subscription: LineSubscription | null;
}

export interface CompanyPlan {
  /** The best of the lines' standings (the only line's, in a one-line catalog). */
  readonly standing: PlanStanding;
  /** Every live entitlement the company holds (plan, add-ons, grants, overrides), one answer per feature. */
  readonly entitlements: ReadonlyMap<string, ResolvedEntitlement>;
  /** Billing 0.5: each product line's own standing, keyed by line, in the record's order. */
  readonly lines: ReadonlyMap<string, LinePlan>;
}

/** A plan row key is `<tier>:<interval>:<currency>`; the tier is what standing names. */
function tierOf(planKey: string | null | undefined): string | null {
  if (!planKey) return null;
  const tier = planKey.split(":")[0];
  return tier && tier.length > 0 ? tier : null;
}

/**
 * Which line a stored row is on: the line its TIER is declared in, when the
 * record says, else the line the row was written with. The tier wins because
 * a project that moves its tiers into named lines has rows written under the
 * implicit line; reading them by their tier puts them on the right card
 * before the next Stripe event re-labels them.
 */
export function lineOfStoredRow(catalog: PlanLinesOf | undefined, planKey: string | null | undefined, storedLine: string): string {
  const tierKey = tierOf(planKey);
  if (catalog !== undefined && tierKey !== null) {
    for (const line of catalog.lines) if (line.tiers.some((tier) => tier.key === tierKey)) return line.key;
  }
  return storedLine;
}

export async function loadCompanyPlan(db: BillingDb, input: LoadPlanStandingInput): Promise<CompanyPlan> {
  const now = input.now ?? new Date();
  const history = await db
    .select({
      status: subscriptions.status,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      trialEndsAt: subscriptions.trialEndsAt,
      line: subscriptions.line,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeItemId: subscriptions.stripeItemId,
      planKey: plans.key,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, input.tenantId))
    // Newest first; the id is a uuidv7, so two rows made in the same instant still order.
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(200);

  const rows = await db
    .select({
      feature: entitlements.feature,
      limitValue: entitlements.limitValue,
      usedValue: entitlements.usedValue,
      source: entitlements.source,
      sourceRef: entitlements.sourceRef,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(eq(entitlements.tenantId, input.tenantId));

  const catalog = input.plans;
  const lineKeys = catalog && catalog.lines.length > 0 ? catalog.lines.map((line) => line.key) : [DEFAULT_PLAN_LINE];
  const single = lineKeys.length <= 1;

  const lines = new Map<string, LinePlan>();
  for (const key of lineKeys) {
    // One line: the newest row whatever it says, and every plan row — byte for
    // byte what billing 0.3 read. Several: this line's newest row, and the plan
    // rows this line's tiers wrote.
    const latest = single
      ? history[0]
      : history.find((row) => lineOfStoredRow(catalog, row.planKey, row.line) === key);
    const refs = single ? null : new Set((catalog?.lines.find((line) => line.key === key)?.tiers ?? []).map((tier) => tier.key));
    const subscription: LineSubscription | null = latest
      ? {
          status: latest.status,
          cancelAtPeriodEnd: latest.cancelAtPeriodEnd,
          currentPeriodEnd: latest.currentPeriodEnd,
          trialEndsAt: latest.trialEndsAt,
          tierKey: tierOf(latest.planKey),
          stripeSubscriptionId: latest.stripeSubscriptionId,
          stripeItemId: latest.stripeItemId,
        }
      : null;
    const standing = planStanding({
      subscription: subscription
        ? {
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            currentPeriodEnd: subscription.currentPeriodEnd,
            tierKey: subscription.tierKey,
          }
        : null,
      planRowExpiries: rows
        .filter((r) => r.source === "plan" && (refs === null || refs.has(r.sourceRef ?? "")))
        .map((r) => r.expiresAt),
      trialStartedAt: input.trialStartedAt,
      trialDays: input.trialDays,
      now,
    });
    lines.set(key, { line: key, standing, subscription });
  }

  const standing = single
    ? (lines.values().next().value as LinePlan).standing
    : combineStandings([...lines.values()].map((line) => line.standing));

  // THE FREE TIER (billing 0.6): a line the record gives a free tier, and on
  // which nothing paid is open right now, grants what the free tier says —
  // in memory, never written — summed with add-ons and grants like any plan
  // row. The moment a paid tier of the line is live its own rows replace it.
  const freeRows = (catalog?.lines ?? []).flatMap((line) =>
    line.free !== null && line.free !== undefined && lines.get(line.key)?.standing.open !== true ? freeGrantRows(line.free) : [],
  );

  return { standing, entitlements: resolveEntitlements([...(rows as EntitlementRow[]), ...freeRows], now), lines };
}

/** Just the standing: what a plan gate's `standing(tenantId)` returns. */
export async function loadPlanStanding(db: BillingDb, input: LoadPlanStandingInput): Promise<PlanStanding> {
  return (await loadCompanyPlan(db, input)).standing;
}

/** A line of what a tenant pays through Stripe, live right now. */
export interface LiveStripeLine {
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string | null;
  /** NULL on a row mirrored before billing 0.5; the next event fills it in. */
  readonly stripeItemId: string | null;
  readonly planKey: string | null;
  /** The line as stored; read it through `lineOfStoredRow` to place it by its tier. */
  readonly line: string;
  readonly status: string;
}

/** Statuses at which a Stripe-billed row is still being paid (or retried). */
const PAYING: readonly string[] = ["trialing", "active", "past_due", "unpaid"];

/**
 * Every line this tenant pays for through Stripe right now, newest first —
 * one per product line, all on the tenant's ONE Stripe subscription (billing
 * 0.5).
 */
export async function liveStripeLines(db: BillingDb, tenantId: string): Promise<readonly LiveStripeLine[]> {
  const rows = await db
    .select({
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeCustomerId: subscriptions.stripeCustomerId,
      stripeItemId: subscriptions.stripeItemId,
      line: subscriptions.line,
      status: subscriptions.status,
      planKey: plans.key,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(200);
  const live: LiveStripeLine[] = [];
  for (const row of rows) {
    if (row.stripeSubscriptionId === null || !PAYING.includes(row.status)) continue;
    live.push({
      stripeSubscriptionId: row.stripeSubscriptionId,
      stripeCustomerId: row.stripeCustomerId,
      stripeItemId: row.stripeItemId,
      planKey: row.planKey,
      line: row.line,
      status: row.status,
    });
  }
  return live;
}

/**
 * Does the company hold a live Stripe subscription? (What a second checkout
 * must never start beside.) Any line counts: with product lines a second line
 * is an ITEM added to this subscription, never a second subscription.
 */
export async function liveStripeSubscription(
  db: BillingDb,
  tenantId: string,
): Promise<{ readonly stripeSubscriptionId: string; readonly stripeCustomerId: string | null; readonly planKey: string | null; readonly status: string } | null> {
  const [first] = await liveStripeLines(db, tenantId);
  if (!first) return null;
  return { stripeSubscriptionId: first.stripeSubscriptionId, stripeCustomerId: first.stripeCustomerId, planKey: first.planKey, status: first.status };
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

// Delete a company (create-app 0.37): every row of one company, and whether it is still paying.
export { forgetTenant, livePaidSubscription } from "./forget.js";
