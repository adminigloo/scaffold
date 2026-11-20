import { countDistinct, eq, inArray, isNull, lte, and, sql } from "drizzle-orm";
import { tenants } from "@adminigloo/tenancy/schema";
import { subscriptions } from "@adminigloo/billing/schema";
import { ago, plural, type Glance } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/billing: every company's plan, across the
 * whole platform (an operator's view, like the companies console — no
 * tenantId, because there is no "one company" version of "how many
 * companies are past due").
 */
export interface BillingGlanceInput {
  readonly db: DashboardDb;
  readonly now: Date;
  /** The full page. */
  readonly href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_WINDOW_DAYS = 7;

/**
 * The states `@adminigloo/billing/schema`'s `subscriptions.status` really
 * has (status.ts: `SubscriptionStatus`) are trialing, active, past_due,
 * unpaid, incomplete and canceled. `incomplete` (a checkout whose first
 * payment never went through) is folded into "past due or unpaid" here —
 * both mean "not currently paying, and not a deliberate cancellation" — so
 * the four tiles the card has room for say something about every row.
 */
const NEEDS_PAYMENT_STATUSES = ["past_due", "unpaid", "incomplete"] as const;

/** Counted by distinct company, not by row: a resubscribed company can hold
 * more than one `canceled` row over its life, and a two-line catalog can have
 * one company trialing two lines at once. Either way this card answers "how
 * many companies", not "how many subscription rows". */
export async function plansGlance(input: BillingGlanceInput): Promise<Glance> {
  const { db, now } = input;
  const href = input.href ?? "/admin/billing/companies";
  const trialCutoff = new Date(now.getTime() + TRIAL_WINDOW_DAYS * DAY_MS);

  const [trialingRows, activeRows, needsPaymentRows, canceledRows, trialsEndingRows, compedRows, needsLook] = await Promise.all([
    db.select({ n: countDistinct(subscriptions.tenantId) }).from(subscriptions).where(eq(subscriptions.status, "trialing")),
    db.select({ n: countDistinct(subscriptions.tenantId) }).from(subscriptions).where(eq(subscriptions.status, "active")),
    db
      .select({ n: countDistinct(subscriptions.tenantId) })
      .from(subscriptions)
      .where(inArray(subscriptions.status, NEEDS_PAYMENT_STATUSES)),
    db.select({ n: countDistinct(subscriptions.tenantId) }).from(subscriptions).where(eq(subscriptions.status, "canceled")),
    // A NULL trial_ends_at never satisfies <=, so nothing extra is needed to
    // exclude it.
    db
      .select({ n: countDistinct(subscriptions.tenantId) })
      .from(subscriptions)
      .where(and(eq(subscriptions.status, "trialing"), lte(subscriptions.trialEndsAt, trialCutoff))),
    // "A comped subscription an admin granted has no Stripe object" (the
    // schema's own words for subscriptions.stripe_subscription_id) — the only
    // mark free months leave once they are live.
    db
      .select({ n: countDistinct(subscriptions.tenantId) })
      .from(subscriptions)
      .where(and(eq(subscriptions.status, "active"), isNull(subscriptions.stripeSubscriptionId))),
    db
      .select({
        tenantName: tenants.name,
        status: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(inArray(subscriptions.status, [...NEEDS_PAYMENT_STATUSES, "trialing"]))
      // Past due, unpaid and incomplete first; trials after. Within each
      // group, the nearest deadline (overdue longest / ending soonest) first.
      .orderBy(
        sql`case when ${subscriptions.status} in ('past_due', 'unpaid', 'incomplete') then 0 else 1 end`,
        sql`case when ${subscriptions.status} = 'trialing' then ${subscriptions.trialEndsAt} else ${subscriptions.currentPeriodEnd} end`,
      )
      .limit(6),
  ]);

  const trialing = trialingRows[0]?.n ?? 0;
  const active = activeRows[0]?.n ?? 0;
  const needsPayment = needsPaymentRows[0]?.n ?? 0;
  const canceled = canceledRows[0]?.n ?? 0;
  const trialsEndingSoon = trialsEndingRows[0]?.n ?? 0;
  const comped = compedRows[0]?.n ?? 0;

  return {
    status:
      needsPayment > 0
        ? { text: `${plural(needsPayment, "company", "companies")} past due or unpaid.`, tone: "bad" }
        : trialsEndingSoon > 0
          ? { text: `${plural(trialsEndingSoon, "trial ends", "trials end")} in the next ${TRIAL_WINDOW_DAYS} days.`, tone: "warn" }
          : { text: `${plural(active, "company", "companies")} on a paid plan.`, tone: "neutral" },
    attention: needsPayment,
    tiles: [
      {
        label: "Trialing",
        value: trialing,
        href,
        hint:
          trialsEndingSoon > 0
            ? `${plural(trialsEndingSoon, "trial ends", "trials end")} within ${TRIAL_WINDOW_DAYS} days.`
            : "None ending soon.",
      },
      {
        label: "Active",
        value: active,
        href,
        tone: active > 0 ? "good" : undefined,
        hint: comped > 0 ? `${plural(comped, "is", "are")} comped, free.` : "None comped.",
      },
      {
        label: "Past due or unpaid",
        value: needsPayment,
        href,
        tone: needsPayment > 0 ? "bad" : undefined,
        hint: "Needs a card, or the last charge failed.",
      },
      {
        label: "Cancelled",
        value: canceled,
        href,
        hint: "No longer paying.",
      },
    ],
    list: {
      title: "Needs a look",
      empty: "No company needs a look.",
      rows: needsLook.map((row) => ({
        title: row.tenantName,
        badge: row.status === "trialing" ? "Trial ending" : row.status === "past_due" ? "Past due" : row.status === "unpaid" ? "Unpaid" : "Needs payment",
        meta: row.status === "trialing" ? until(row.trialEndsAt, now) : ago(row.currentPeriodEnd, now),
        tone: row.status === "trialing" ? "warn" : "bad",
        href,
      })),
    },
    link: { href, label: "Open company plans" },
  };
}

/** "today", "tomorrow", "in N days", else the date. The future-facing twin of `ago` in ../glance.ts. */
function until(when: Date | string | null | undefined, now: Date): string {
  if (!when) return "";
  const at = typeof when === "string" ? new Date(when) : when;
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
