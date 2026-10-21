import { desc, eq } from "drizzle-orm";
import { LIVE_SUBSCRIPTION_STATUSES } from "__SCOPE__/billing";
import type { SubscriptionStatus } from "__SCOPE__/billing";
import { plans, subscriptions } from "__SCOPE__/billing/schema";
import { lineOfStoredRow } from "__SCOPE__/billing/server";
import { db } from "@/db";
import { plans as planRecord } from "@/plans";
import { linePlansOf } from "@/server/plan-gate";

/**
 * WHAT A PERSON (OR A COMPANY) PAYS FOR, read for the account area.
 *
 * SUBSCRIPTIONS ARE PER TENANT AND THAT IS CORRECT. `subscriptions.tenant_id`
 * is the account that pays — a company, or a person's own account — so
 * `/account/billing` resolves the viewer's own tenant with `currentTenantFor`
 * and checks the tenant permission ladder against it. What a person bought
 * from a shop (a project with one) is read per PERSON instead, through the
 * orders they own: src/server/account-orders.ts.
 */

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export interface AccountSubscription {
  readonly id: string;
  readonly status: SubscriptionStatus;
  /**
   * `plans.key` — `<tier>:<interval>:<currency>`. The handle everything that
   * has to act on this subscription resolves the TIER through, because a
   * subscription row names a priced row and the record names what that row
   * includes. Carried on the view so cancel, resume and the plan comparison do
   * not each re-derive it from the name.
   */
  readonly planKey: string;
  readonly planName: string;
  readonly planPriceMinor: bigint;
  readonly planCurrency: string;
  readonly interval: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly stripeCustomerId: string | null;
  /** NULL for a subscription with no Stripe object — a simulated or comped one. */
  readonly stripeSubscriptionId: string | null;
  /** The product line this row is (billing 0.5): `plans.line(key)`. */
  readonly line: string;
  /** The Stripe item that bills the line; NULL with no Stripe object, or on a row from before 0.5. */
  readonly stripeItemId: string | null;
  /** True while this row occupies the tenant's one live-subscription slot. */
  readonly live: boolean;
  /**
   * Free months an operator gave (billing 0.3): no Stripe object, recorded by
   * Give free months. They end on their own date and can't be resumed.
   */
  readonly freeMonths?: boolean;
}

/**
 * The subscription `/account/billing` is about, or NULL.
 *
 * THE LIVE ONE IF THERE IS ONE, otherwise the most recent. A cancelled
 * subscription is not nothing: "you were on Pro and it ended on the 3rd" is the
 * sentence somebody opening this page after a lapse needs, and returning NULL
 * for it would render the same empty state as a person who never subscribed.
 *
 * "Live" is `LIVE_SUBSCRIPTION_STATUSES`, imported rather than spelled out. The
 * database enforces at-most-one over exactly that set with a partial unique
 * index, and a local copy of the list would let this reader pick a row the
 * index was not protecting — the invariant enforced on one list and read
 * through another.
 *
 * ONE QUERY, sorted in memory. A tenant has a handful of these rows, and
 * expressing "live first, then newest" as an ORDER BY needs a CASE over the
 * status list, which is the second copy this comment just argued against.
 *
 * WHAT WRITES THIS TABLE is `applySubscription` in `@/server/subscription`,
 * and nothing else. The webhook mirror calls it for a real subscription, the
 * simulated path calls it for one nobody paid for, cancel and resume call it,
 * and the staff resync calls it — so every row this reads back was written by
 * one function through one set of rules. A second writer is the failure that
 * matters here rather than a tidiness point: the firm owns this table, so two
 * writers disagreeing is a customer being told the wrong thing about their own
 * money with nothing to reconcile against.
 */
export async function readSubscriptionForTenant(
  tenantId: string,
  /** One product line's subscription (billing 0.5). Omitted: the tenant's, whichever line — exactly the one-line read. */
  line?: string,
): Promise<AccountSubscription | null> {
  const rows = await readRows(tenantId);
  const onLine = line === undefined ? rows : rows.filter((row) => row.line === line);
  return chooseRow(onLine);
}

/**
 * Every product line's subscription for `/account/billing` (billing 0.5),
 * keyed by line in the record's order: the live one if there is one,
 * otherwise the most recent. A line never subscribed to is absent.
 */
export async function readSubscriptionsForTenant(tenantId: string): Promise<ReadonlyMap<string, AccountSubscription>> {
  const rows = await readRows(tenantId);
  const byLine = new Map<string, AccountSubscription>();
  for (const line of planRecord.lines) {
    const chosen = chooseRow(rows.filter((row) => row.line === line.key));
    if (chosen !== null) byLine.set(line.key, chosen);
  }
  return byLine;
}

// ---------------------------------------------------------------------------
// What the account is ON, per line — the plan check's answer
// ---------------------------------------------------------------------------

/** What an account holds on one product line, as the plan check reads it. */
export interface LineHolding {
  readonly line: string;
  /** Is a plan on this line serving the account right now? */
  readonly open: boolean;
  /** The tier it is served (only while open); null on the free tier or with nothing. */
  readonly tierKey: string | null;
  /** On the line's free tier: the record declares one and nothing paid is open on the line. */
  readonly onFree: boolean;
}

/**
 * WHAT THE ACCOUNT IS ON, per product line, for /account and /account/billing:
 * the tier marked "You're on this plan", whether Free is, and which features
 * the overview lists (create-app 0.39).
 *
 * FROM THE PLAN CHECK'S OWN STANDING (`linePlansOf`, src/server/plan-gate.ts),
 * never from `live` above (review). `live` is the database's one-live-row
 * rule — it counts `incomplete`, `past_due` and `unpaid` rows, and free
 * months stay `active` for ever because no event ever closes them — so the
 * pages said Pro while the check had gone back to Free. One reading, so the two
 * can't disagree. (`live` stays right for what it is: which row the card
 * describes, and whether a change goes through the Stripe subscription.)
 */
export async function readLineHoldings(tenantId: string): Promise<ReadonlyMap<string, LineHolding>> {
  const lines = await linePlansOf(tenantId);
  const out = new Map<string, LineHolding>();
  for (const line of planRecord.lines) {
    const standing = lines.get(line.key)?.standing ?? null;
    const open = standing?.open === true;
    const tierKey = open ? (standing?.tierKey ?? null) : null;
    out.set(line.key, { line: line.key, open, tierKey, onFree: line.free !== null && line.free !== undefined && !open });
  }
  return out;
}

type StoredRow = Omit<AccountSubscription, "live" | "freeMonths"> & { readonly lastEventId: string | null };

async function readRows(tenantId: string): Promise<readonly StoredRow[]> {
  const rows = await db
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      canceledAt: subscriptions.canceledAt,
      trialEndsAt: subscriptions.trialEndsAt,
      stripeCustomerId: subscriptions.stripeCustomerId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeItemId: subscriptions.stripeItemId,
      storedLine: subscriptions.line,
      lastEventId: subscriptions.lastEventId,
      planKey: plans.key,
      planName: plans.name,
      planPriceMinor: plans.priceMinor,
      planCurrency: plans.currency,
      interval: plans.interval,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(50);
  // The line by the row's TIER, so a row written before lines sits on the right card.
  return rows.map(({ storedLine, ...row }) => ({ ...row, line: lineOfStoredRow(planRecord, row.planKey, storedLine) }));
}

function chooseRow(rows: readonly StoredRow[]): AccountSubscription | null {
  const live: readonly string[] = LIVE_SUBSCRIPTION_STATUSES;
  const chosen = rows.find((row) => live.includes(row.status)) ?? rows[0];
  if (chosen === undefined) return null;

  const { lastEventId, ...row } = chosen;
  return {
    ...row,
    live: live.includes(chosen.status),
    freeMonths: chosen.stripeSubscriptionId === null && (lastEventId ?? "").startsWith("comp:"),
  };
}
