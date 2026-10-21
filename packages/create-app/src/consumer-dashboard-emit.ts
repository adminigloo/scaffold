/**
 * THE FOUNDER'S DASHBOARD FOR A PROJECT WHOSE CUSTOMERS ARE PEOPLE
 * (create-app 0.39): `--audience consumers` with plans (`--model subscription`
 * or `both`). A business's dashboard counts orders, invitations and companies;
 * a consumer product's founder asks different questions every morning:
 *
 *   who pays, for which plan of which line     subscribers by plan and line
 *   how                                        monthly vs yearly
 *   how much it's worth                         MRR and ARR, per currency
 *   what moved this month                       new and cancelled
 *   what needs a hand                           failed payments, errors
 *   is the free account working                 free to paid
 *
 * and, only when there is a shop (--model both), the shop's own numbers.
 *
 * Three files: the page (app/admin/page.tsx), the arithmetic as a pure module
 * (src/server/subscriber-numbers.ts — every number defined in one place, in
 * words), and its proof (src/server/__tests__/subscriber-numbers.test.ts).
 */
import type { Answers } from "./answers.js";
import { sellsShop } from "./shop-emit.js";

// ---------------------------------------------------------------------------
// src/server/subscriber-numbers.ts
// ---------------------------------------------------------------------------

export function renderSubscriberNumbers(_answers: Answers): string {
  return `/**
 * THE SUBSCRIBER NUMBERS, DEFINED ONCE (create-app 0.39). Pure: rows in,
 * numbers out, so every definition below is tested
 * (src/server/__tests__/subscriber-numbers.test.ts, and on the mirror's own
 * rows in subscriber-facts.test.ts) and the dashboard only draws them.
 *
 *   serving             a row still giving someone their plan: live at Stripe
 *                       (trial, active, past due, unpaid) and not past an end
 *                       it was set to — free months and simulated plans only
 *                       until their period's end, since no event closes them
 *   paying              people paying by card right now: a Stripe
 *                       subscription that is active, or past due and still
 *                       being retried. Free trials and free months are counted
 *                       apart, never as paying.
 *   on each plan        serving subscriptions per plan and product line
 *   monthly / yearly    paying subscriptions by how often they're billed
 *   MRR / ARR           what paying subscriptions bring in, per currency, at
 *                       the price each one is ACTUALLY charged (what Stripe
 *                       bills it: a repricing doesn't move people already on
 *                       the old price; the plan's own price only for a row
 *                       mirrored before that was recorded): monthly prices
 *                       plus yearly prices / 12 (ARR is monthly x 12 plus
 *                       yearly). Never summed across currencies: 1,000 JPY
 *                       and 1,000 GBP are 2,000 of nothing.
 *   new this month      people whose FIRST paid subscription started paying
 *                       this calendar month (UTC): one that reached active or
 *                       past due — never a free trial nobody has paid for yet,
 *                       nor a checkout that never finished
 *   cancelled           paid subscriptions people cancelled this calendar
 *                       month, with nothing serving in their place on the
 *                       same line — a row closed because a paid one replaced
 *                       it (free months becoming a card plan) is a
 *                       conversion, not a cancellation
 *   failed payments     serving subscriptions whose last payment didn't go
 *                       through (past due or unpaid), now
 *   free to paid        of every account, how many pay; and of this month's
 *                       sign-ups, how many already do
 */

/** One subscription row, with the price row it points at. */
export interface SubscriptionFact {
  readonly tenantId: string;
  readonly line: string;
  /** \`<tier>:<interval>:<currency>\` */
  readonly planKey: string;
  readonly interval: string;
  /** The plan row's price: what the record sells the tier at today. */
  readonly priceMinor: bigint;
  /** What this subscription is actually charged (billing 0.6); null when not recorded (before 0.6, or not by card). */
  readonly chargedMinor: bigint | null;
  readonly currency: string;
  readonly status: string;
  /** A real Stripe subscription — free months and simulated plans are not. */
  readonly paidByCard: boolean;
  readonly createdAt: Date;
  readonly canceledAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly trialEndsAt: Date | null;
}

export interface MoneyByCurrency {
  readonly currency: string;
  readonly minor: bigint;
}

export interface SubscriberNumbers {
  readonly paying: number;
  readonly trialing: number;
  readonly freeMonths: number;
  readonly byPlan: readonly { readonly line: string; readonly tierKey: string; readonly count: number }[];
  readonly monthly: number;
  readonly yearly: number;
  readonly mrr: readonly MoneyByCurrency[];
  readonly arr: readonly MoneyByCurrency[];
  readonly newThisMonth: number;
  readonly cancelledThisMonth: number;
  readonly failedPayments: number;
  readonly freeToPaid: { readonly accounts: number; readonly paying: number; readonly percent: number | null };
  readonly signups: { readonly thisMonth: number; readonly paying: number };
}

const LIVE = new Set(["trialing", "active", "past_due", "unpaid"]);
const PAYING = new Set(["active", "past_due"]);
const FAILED = new Set(["past_due", "unpaid"]);
/** Statuses a subscription only reaches once it was paid for (unpaid comes after past due). */
const REACHED_PAID = new Set(["active", "past_due", "unpaid"]);

/** The first instant of \`now\`'s calendar month, in UTC. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Is this row still giving someone their plan? (See "serving" above.) */
export function serving(fact: SubscriptionFact, now: Date): boolean {
  if (!LIVE.has(fact.status)) return false;
  const ended = fact.currentPeriodEnd !== null && fact.currentPeriodEnd.getTime() <= now.getTime();
  // Free months and simulated plans: nothing ever closes them but their date.
  if (!fact.paidByCard) return !ended;
  // A card plan set to end, past its end: over, whatever event is still on its way.
  return !(fact.cancelAtPeriodEnd && ended);
}

/** Was this card subscription ever paid for, and from when? Null: never (a free trial, a checkout that never finished). */
export function paidSince(fact: SubscriptionFact): Date | null {
  if (!fact.paidByCard) return null;
  const trialEnd = fact.trialEndsAt !== null && fact.trialEndsAt.getTime() > fact.createdAt.getTime() ? fact.trialEndsAt : null;
  if (REACHED_PAID.has(fact.status)) return trialEnd ?? fact.createdAt;
  if (fact.status !== "canceled") return null;
  // Cancelled during its trial: never charged.
  if (trialEnd !== null && fact.canceledAt !== null && fact.canceledAt.getTime() <= trialEnd.getTime()) return null;
  return trialEnd ?? fact.createdAt;
}

export function subscriberNumbers(input: {
  readonly facts: readonly SubscriptionFact[];
  /** Every account (a person who signed up and wasn't deleted). */
  readonly accounts: number;
  /** The account (tenant) id of everyone who signed up this calendar month. */
  readonly signupsThisMonth: readonly string[];
  readonly now: Date;
}): SubscriberNumbers {
  const now = input.now;
  const monthStart = startOfMonthUtc(now).getTime();
  const payingTenants = new Set<string>();
  const trialing = new Set<string>();
  const freeMonths = new Set<string>();
  const byPlan = new Map<string, { line: string; tierKey: string; count: number }>();
  const monthlySum = new Map<string, bigint>();
  const yearlySum = new Map<string, bigint>();
  const firstPaid = new Map<string, number>();
  let monthly = 0;
  let yearly = 0;
  let cancelled = 0;
  let failed = 0;

  for (const fact of input.facts) {
    const since = paidSince(fact);
    if (since !== null) {
      const at = since.getTime();
      const seen = firstPaid.get(fact.tenantId);
      if (seen === undefined || at < seen) firstPaid.set(fact.tenantId, at);
    }
    // A cancellation: a paid card subscription someone cancelled this month,
    // with nothing serving in its place on the same line afterwards.
    if (since !== null && fact.canceledAt !== null && fact.canceledAt.getTime() >= monthStart) {
      const replaced = input.facts.some(
        (other) =>
          other !== fact &&
          other.tenantId === fact.tenantId &&
          other.line === fact.line &&
          other.createdAt.getTime() >= fact.createdAt.getTime() &&
          serving(other, now),
      );
      if (!replaced) cancelled += 1;
    }
    if (!serving(fact, now)) continue;
    if (FAILED.has(fact.status)) failed += 1;
    const tierKey = fact.planKey.split(":")[0] ?? fact.planKey;
    const key = \`\${fact.line}\\u0000\${tierKey}\`;
    const row = byPlan.get(key) ?? { line: fact.line, tierKey, count: 0 };
    row.count += 1;
    byPlan.set(key, row);
    if (!fact.paidByCard) {
      freeMonths.add(fact.tenantId);
      continue;
    }
    if (fact.status === "trialing") {
      trialing.add(fact.tenantId);
      continue;
    }
    if (!PAYING.has(fact.status)) continue;
    payingTenants.add(fact.tenantId);
    // What this subscription is really charged; the plan's price only when that wasn't recorded.
    const amount = fact.chargedMinor ?? fact.priceMinor;
    if (fact.interval === "month") {
      monthly += 1;
      monthlySum.set(fact.currency, (monthlySum.get(fact.currency) ?? 0n) + amount);
    } else if (fact.interval === "year") {
      yearly += 1;
      yearlySum.set(fact.currency, (yearlySum.get(fact.currency) ?? 0n) + amount);
    }
  }

  const currencies = [...new Set([...monthlySum.keys(), ...yearlySum.keys()])].sort();
  // ARR exactly (monthly x 12 + yearly), MRR as ARR / 12 rounded down: never
  // more than is really coming in.
  const arr = currencies.map((currency) => ({
    currency,
    minor: (monthlySum.get(currency) ?? 0n) * 12n + (yearlySum.get(currency) ?? 0n),
  }));
  const mrr = arr.map((each) => ({ currency: each.currency, minor: each.minor / 12n }));

  let newThisMonth = 0;
  for (const at of firstPaid.values()) if (at >= monthStart) newThisMonth += 1;

  const paying = payingTenants.size;
  return {
    paying,
    trialing: trialing.size,
    freeMonths: freeMonths.size,
    byPlan: [...byPlan.values()].sort((a, b) => b.count - a.count || a.tierKey.localeCompare(b.tierKey)),
    monthly,
    yearly,
    mrr,
    arr,
    newThisMonth,
    cancelledThisMonth: cancelled,
    failedPayments: failed,
    freeToPaid: {
      accounts: input.accounts,
      paying,
      percent: input.accounts > 0 ? Math.round((paying / input.accounts) * 1000) / 10 : null,
    },
    signups: {
      thisMonth: input.signupsThisMonth.length,
      paying: input.signupsThisMonth.filter((tenantId) => payingTenants.has(tenantId)).length,
    },
  };
}
`;
}

// ---------------------------------------------------------------------------
// src/server/subscriber-facts.ts — the one read the dashboard makes
// ---------------------------------------------------------------------------

export function renderSubscriberFacts(answers: Answers): string {
  const scope = answers.scope;
  return `import { eq } from "drizzle-orm";
import { plans as planTable, subscriptions } from "${scope}/billing/schema";
import { db } from "@/db";
import type { SubscriptionFact } from "./subscriber-numbers";

/**
 * Every subscription row with the price row it points at, as the founder's
 * dashboard counts them (src/server/subscriber-numbers.ts). One read: a
 * consumer product's subscriptions number in the thousands, not millions;
 * past tens of thousands, move these sums into SQL. Its own module, so the
 * proof (src/server/__tests__/subscriber-facts.test.ts) counts the rows the
 * real mirror wrote exactly as the dashboard does.
 */
export async function readSubscriberFacts(): Promise<SubscriptionFact[]> {
  const rows = await db
    .select({
      tenantId: subscriptions.tenantId,
      line: subscriptions.line,
      status: subscriptions.status,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      createdAt: subscriptions.createdAt,
      canceledAt: subscriptions.canceledAt,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      trialEndsAt: subscriptions.trialEndsAt,
      chargedMinor: subscriptions.priceMinor,
      planKey: planTable.key,
      interval: planTable.interval,
      priceMinor: planTable.priceMinor,
      currency: planTable.currency,
    })
    .from(subscriptions)
    .innerJoin(planTable, eq(planTable.id, subscriptions.planId));
  return rows.map(({ stripeSubscriptionId, ...row }) => ({ ...row, paidByCard: stripeSubscriptionId !== null }));
}
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/subscriber-numbers.test.ts
// ---------------------------------------------------------------------------

export function renderSubscriberNumbersTest(_answers: Answers): string {
  return `import { describe, expect, it } from "vitest";
import { startOfMonthUtc, subscriberNumbers, type SubscriptionFact } from "@/server/subscriber-numbers";

/**
 * The founder's dashboard numbers (create-app 0.39), each definition with its
 * negative control: a free trial or free months never counted as paying, a
 * yearly price never counted as a monthly one, two currencies never summed.
 */
const NOW = new Date("2026-10-21T12:00:00Z");
const fact = (over: Partial<SubscriptionFact>): SubscriptionFact => ({
  tenantId: "ws_a",
  line: "main",
  planKey: "basic:month:usd",
  interval: "month",
  priceMinor: 1000n,
  chargedMinor: null,
  currency: "usd",
  status: "active",
  paidByCard: true,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  canceledAt: null,
  currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  ...over,
});

describe("subscriber numbers", () => {
  it("MRR is monthly plus yearly / 12, ARR monthly x 12 plus yearly — per currency", () => {
    const n = subscriberNumbers({
      facts: [
        fact({ tenantId: "ws_a" }),
        fact({ tenantId: "ws_b", planKey: "basic:year:usd", interval: "year", priceMinor: 10000n }),
        fact({ tenantId: "ws_c", currency: "gbp", priceMinor: 800n, planKey: "basic:month:gbp" }),
      ],
      accounts: 10,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.paying).toBe(3);
    expect(n.monthly).toBe(2);
    expect(n.yearly).toBe(1);
    expect(n.arr).toEqual([
      { currency: "gbp", minor: 9600n },
      { currency: "usd", minor: 22000n },
    ]);
    expect(n.mrr).toEqual([
      { currency: "gbp", minor: 800n },
      { currency: "usd", minor: 1833n },
    ]);
  });

  it("a free trial, free months and an ended plan are never paying (NEGATIVE CONTROLS)", () => {
    const n = subscriberNumbers({
      facts: [
        fact({ tenantId: "ws_t", status: "trialing" }),
        fact({ tenantId: "ws_f", paidByCard: false }),
        fact({ tenantId: "ws_x", status: "canceled", canceledAt: new Date("2026-10-05T00:00:00Z") }),
      ],
      accounts: 3,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.paying).toBe(0);
    expect(n.trialing).toBe(1);
    expect(n.freeMonths).toBe(1);
    expect(n.mrr).toEqual([]);
    expect(n.cancelledThisMonth).toBe(1);
    expect(n.byPlan).toEqual([{ line: "main", tierKey: "basic", count: 2 }]);
  });

  it("new this month is a FIRST paid subscription this month; a plan change isn't new", () => {
    const n = subscriberNumbers({
      facts: [
        fact({ tenantId: "ws_new", createdAt: new Date("2026-10-02T00:00:00Z") }),
        // ws_old switched plans this month: their first paid one was in August.
        fact({ tenantId: "ws_old", status: "canceled", createdAt: new Date("2026-08-01T00:00:00Z"), canceledAt: new Date("2026-10-03T00:00:00Z") }),
        fact({ tenantId: "ws_old", planKey: "pro:month:usd", priceMinor: 2000n, createdAt: new Date("2026-10-03T00:00:00Z") }),
      ],
      accounts: 2,
      signupsThisMonth: ["ws_new", "ws_free"],
      now: NOW,
    });
    expect(n.newThisMonth).toBe(1);
    expect(n.signups).toEqual({ thisMonth: 2, paying: 1 });
    expect(n.freeToPaid).toEqual({ accounts: 2, paying: 2, percent: 100 });
  });

  it("failed payments are the past due and the unpaid, still on their plan", () => {
    const n = subscriberNumbers({
      facts: [fact({ status: "past_due" }), fact({ tenantId: "ws_u", status: "unpaid" }), fact({ tenantId: "ws_ok" })],
      accounts: 3,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.failedPayments).toBe(2);
    // Past due is still billed (and retried), so it is paying; unpaid isn't.
    expect(n.paying).toBe(2);
  });

  it("the month starts at midnight UTC on the 1st", () => {
    expect(startOfMonthUtc(NOW).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("new this month never counts a free trial nobody has paid for, nor a checkout that never finished (review)", () => {
    const n = subscriberNumbers({
      facts: [
        fact({ tenantId: "ws_trial", status: "trialing", createdAt: new Date("2026-10-05T00:00:00Z"), trialEndsAt: new Date("2026-10-26T00:00:00Z") }),
        fact({ tenantId: "ws_stuck", status: "incomplete", createdAt: new Date("2026-10-06T00:00:00Z") }),
        // A trial that ended on the 3rd and was charged: it started PAYING this month.
        fact({ tenantId: "ws_converted", createdAt: new Date("2026-09-20T00:00:00Z"), trialEndsAt: new Date("2026-10-03T00:00:00Z") }),
        // A trial cancelled before it ever charged: never paid, never "new", never "cancelled".
        fact({ tenantId: "ws_quit", status: "canceled", createdAt: new Date("2026-10-02T00:00:00Z"), trialEndsAt: new Date("2026-10-16T00:00:00Z"), canceledAt: new Date("2026-10-04T00:00:00Z") }),
      ],
      accounts: 4,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.trialing).toBe(1);
    expect(n.paying).toBe(1);
    expect(n.newThisMonth).toBe(1);
    expect(n.cancelledThisMonth).toBe(0);
  });

  it("a row closed because a paid one replaced it is a conversion, not a cancellation; a real one still counts (review)", () => {
    const n = subscriberNumbers({
      facts: [
        // Free months, closed the moment the card plan started (the mirror's supersede)…
        fact({ tenantId: "ws_c", paidByCard: false, status: "canceled", createdAt: new Date("2026-09-10T00:00:00Z"), canceledAt: new Date("2026-10-08T00:00:00Z"), cancelAtPeriodEnd: true }),
        fact({ tenantId: "ws_c", createdAt: new Date("2026-10-08T00:00:00Z") }),
        // …a card plan replaced by a new checkout on the same line…
        fact({ tenantId: "ws_r", status: "canceled", createdAt: new Date("2026-08-01T00:00:00Z"), canceledAt: new Date("2026-10-09T00:00:00Z") }),
        fact({ tenantId: "ws_r", createdAt: new Date("2026-10-09T00:00:00Z") }),
        // NEGATIVE CONTROL: someone who really cancelled, and someone who scheduled it.
        fact({ tenantId: "ws_gone", status: "canceled", createdAt: new Date("2026-08-01T00:00:00Z"), canceledAt: new Date("2026-10-10T00:00:00Z") }),
        fact({ tenantId: "ws_leaving", cancelAtPeriodEnd: true, canceledAt: new Date("2026-10-11T00:00:00Z") }),
      ],
      accounts: 4,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.cancelledThisMonth).toBe(2);
    // ws_c started paying this month; ws_r first paid in August.
    expect(n.newThisMonth).toBe(1);
  });

  it("free months count only until their own end, with no event to close them (review)", () => {
    const n = subscriberNumbers({
      facts: [
        fact({ tenantId: "ws_over", planKey: "pro:month:usd", paidByCard: false, cancelAtPeriodEnd: true, createdAt: new Date("2026-08-20T00:00:00Z"), currentPeriodEnd: new Date("2026-09-19T00:00:00Z") }),
        // NEGATIVE CONTROL: free months still running.
        fact({ tenantId: "ws_running", planKey: "pro:month:usd", paidByCard: false, cancelAtPeriodEnd: true, currentPeriodEnd: new Date("2026-11-10T00:00:00Z") }),
      ],
      accounts: 2,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.freeMonths).toBe(1);
    expect(n.byPlan).toEqual([{ line: "main", tierKey: "pro", count: 1 }]);
  });

  it("MRR counts what each subscription is ACTUALLY charged: a repricing doesn't move people on the old price (review)", () => {
    const n = subscriberNumbers({
      facts: [
        // Repriced to $20 in src/plans.ts; this person still pays the $10 Price they signed up on.
        fact({ tenantId: "ws_old", priceMinor: 2000n, chargedMinor: 1000n }),
        // NEGATIVE CONTROL: a row from before the price was recorded counts the plan's price.
        fact({ tenantId: "ws_unknown", priceMinor: 2000n, chargedMinor: null }),
      ],
      accounts: 2,
      signupsThisMonth: [],
      now: NOW,
    });
    expect(n.mrr).toEqual([{ currency: "usd", minor: 3000n }]);
  });
});
`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/subscriber-facts.test.ts — on the mirror's own rows
// ---------------------------------------------------------------------------

export function renderSubscriberFactsTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "${scope}/auth/schema";
import { plans as planTable } from "${scope}/billing/schema";
import { personalWorkspaceId } from "${scope}/tenancy";
import { db } from "@/db";
import { plans } from "@/plans";
import { seedPermissions } from "@/permissions/seed";
import { applySubscription } from "@/server/subscription";
import { readSubscriberFacts } from "@/server/subscriber-facts";
import { subscriberNumbers, type SubscriberNumbers } from "@/server/subscriber-numbers";
import { tenancy } from "@/server/tenancy";

/**
 * THE FOUNDER'S NUMBERS ON THE MIRROR'S OWN ROWS (create-app 0.39, review):
 * written by \`applySubscription\` exactly as Give free months, a Stripe trial
 * and a card checkout write them, read by \`readSubscriberFacts\` exactly as
 * app/admin/page.tsx reads them. Three people:
 *
 *   E  free months of the top tier in August, over in September: no event
 *      ever closes them
 *   T  a Stripe free trial started this month: nothing paid yet
 *   C  free months, then paying for the same tier by card this month: the
 *      free months' row is closed by the paid one (a conversion)
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});
vi.useFakeTimers({ toFake: ["Date"] });
const DAY = 24 * 60 * 60 * 1000;
vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));

/** The record's priciest monthly tier, and its cheapest: whatever src/plans.ts sells. */
const monthly = plans.rows.filter((row) => row.interval === "month" && row.isActive && row.priceMinor > 0n);
const top = [...monthly].sort((a, b) => (a.priceMinor < b.priceMinor ? 1 : -1))[0]!;
const cheapest = [...monthly].sort((a, b) => (a.priceMinor < b.priceMinor ? -1 : 1))[0]!;

async function person(tag: string): Promise<string> {
  const [row] = await db.insert(users).values({ externalId: \`ext_\${tag}\`, email: \`\${tag}@example.test\`, displayName: tag }).returning();
  await tenancy.provisionUser({ userId: row!.id, email: \`\${tag}@example.test\` });
  return personalWorkspaceId(row!.id);
}

async function write(tenantId: string, row: (typeof plans.rows)[number], over: Partial<Parameters<typeof applySubscription>[0]>) {
  const now = new Date();
  return applySubscription({
    tenantId,
    tierKey: row.tierKey,
    planKey: row.key,
    stripeSubscriptionId: null,
    stripeCustomerId: null,
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEndsAt: null,
    observedAt: now,
    source: "simulated",
    ...over,
  } as Parameters<typeof applySubscription>[0]);
}

let numbers: SubscriberNumbers;

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  for (const row of plans.rows) {
    await db.insert(planTable).values({
      key: row.key,
      name: row.name,
      description: row.description,
      interval: row.interval,
      priceMinor: row.priceMinor,
      currency: row.currency,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  }
  // E: Give free months (billing.compPlan's write), in August.
  const e = await person("e_expired_comp");
  await write(e, top, { cancelAtPeriodEnd: true, observedBy: "comp:staff", action: "billing.subscription.comped" });
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  // T: a Stripe free trial, started this month.
  const t = await person("t_trial");
  await write(t, cheapest, {
    status: "trialing",
    stripeSubscriptionId: "sub_trial",
    stripeCustomerId: "cus_t",
    trialEndsAt: new Date(Date.now() + 7 * DAY),
    source: "stripe",
  });
  // C: free months, then the same tier by card — charged what Stripe says (a price from before a repricing).
  const c = await person("c_converted");
  await write(c, top, { cancelAtPeriodEnd: true, observedBy: "comp:staff", action: "billing.subscription.comped" });
  vi.setSystemTime(new Date(Date.now() + 60_000));
  await write(c, top, { stripeSubscriptionId: "sub_paid", stripeCustomerId: "cus_c", source: "stripe", priceMinor: top.priceMinor - 1n });
  numbers = subscriberNumbers({ facts: await readSubscriberFacts(), accounts: 3, signupsThisMonth: [], now: new Date() });
});

describe("the dashboard's numbers, on the mirror's own rows", () => {
  it("one person pays, one is on a trial — and only the payer is new this month", () => {
    expect(numbers.paying).toBe(1);
    expect(numbers.trialing).toBe(1);
    expect(numbers.newThisMonth).toBe(1);
  });

  it("free months becoming a paid plan is not a cancellation", () => {
    expect(numbers.cancelledThisMonth).toBe(0);
  });

  it("free months that ended aren't on a plan any more", () => {
    expect(numbers.freeMonths).toBe(0);
    expect(numbers.byPlan.find((row) => row.tierKey === top.tierKey)?.count).toBe(1);
  });

  it("MRR is what the payer is actually charged, not the plan's price today", () => {
    expect(numbers.mrr).toEqual([{ currency: top.currency, minor: top.priceMinor - 1n }]);
  });
});
`;
}

// ---------------------------------------------------------------------------
// app/admin/page.tsx
// ---------------------------------------------------------------------------

export function renderConsumerDashboard(answers: Answers): string {
  const scope = answers.scope;
  const shop = sellsShop(answers);
  const full = answers.adminShell === "full";
  const shopImports = shop
    ? `
import { products } from "${scope}/catalog/schema";
import { orders } from "${scope}/commerce/schema";
import { FIRM_WIDE } from "${scope}/permissions";`
    : "";
  const shopQueries = shop
    ? `
  // THE SHOP (--model both): this site's own orders and products.
  const [paidOrders, activeProducts] = can.can("catalog.products.view")
    ? await Promise.all([
        db
          .select({ n: count() })
          .from(orders)
          .where(and(eq(orders.tenantId, FIRM_WIDE), inArray(orders.status, ["paid", "fulfilled"]), gte(orders.placedAt, monthStart)))
          .then(first),
        db
          .select({ n: count() })
          .from(products)
          .where(and(eq(products.tenantId, FIRM_WIDE), eq(products.status, "active"), isNull(products.deletedAt)))
          .then(first),
      ])
    : [null, null];`
    : "";
  const shopSection = shop
    ? `
      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">The shop</h2>
        <TileGrid
          tiles={[
            { label: "Orders this month", value: paidOrders === null ? null : String(paidOrders), hint: "Paid or fulfilled since the 1st.", permission: "catalog.products.view" },
            { label: "Products for sale", value: activeProducts === null ? null : String(activeProducts), hint: "Active and not deleted: what /products lists.", permission: "catalog.products.view", href: "/admin/products" },
          ]}
        />
      </section>
`
    : "";
  const drizzle = shop ? "and, count, eq, gte, inArray, isNull" : "and, count, gte, isNull";
  return `import Link from "next/link";
import { ${drizzle} } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { formatMinor } from "${scope}/billing";
import { isDbConfigured } from "${scope}/db";
import { errorLog } from "${scope}/observability/schema";
import { personalWorkspaceId } from "${scope}/tenancy";${shopImports}
import { EmptyState, Notice, PageHeader, Table, TBody, TD, TH, THead, TR } from "@/components/ui";
import { db } from "@/db";
import { plans } from "@/plans";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { readSubscriberFacts } from "@/server/subscriber-facts";
import { startOfMonthUtc, subscriberNumbers, type MoneyByCurrency } from "@/server/subscriber-numbers";

/**
 * THE FOUNDER'S MORNING SCREEN, for a site whose customers are people
 * (create-app 0.39): who pays and for what, what it's worth, what moved this
 * month, and what needs a hand. Every number is defined once, in words, in
 * src/server/subscriber-numbers.ts (and tested there); this page reads the
 * rows and draws them.
 *
 * GENERATED, then yours: change what it shows freely.
 */
export const dynamic = "force-dynamic";

interface TileProps {
  readonly label: string;
  /** NULL means "you may not see this". It never means zero. */
  readonly value: string | null;
  readonly hint: string;
  readonly permission: string;
  readonly href?: string;
}

export default async function AdminDashboard() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn">You are signed in but hold no staff role, so there is nothing here to count.</Notice>
      </>
    );
  }
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Every number on this page is read from Postgres, and this deployment has no connection to one.{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>{" "}
          lists what else is outstanding.
        </Notice>
      </>
    );
  }

  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const first = (result: readonly { readonly n: number }[]): number => result[0]?.n ?? 0;
  const seesSubscribers = can.can("staff.tenants.view");

  // Every subscription with the price it points at (src/server/subscriber-facts.ts).
  const [facts, accounts, signups, errors] = await Promise.all([
    seesSubscribers ? readSubscriberFacts() : Promise.resolve([]),
    db.select({ n: count() }).from(users).where(isNull(users.deletedAt)).then(first),
    seesSubscribers
      ? db
          .select({ id: users.id })
          .from(users)
          .where(and(isNull(users.deletedAt), gte(users.createdAt, monthStart)))
      : Promise.resolve([]),
    can.can("staff.audit.view") ? db.select({ n: count() }).from(errorLog).where(isNull(errorLog.resolvedAt)).then(first) : Promise.resolve(null),
  ]);
${shopQueries}
  const numbers = subscriberNumbers({
    facts,
    accounts,
    signupsThisMonth: signups.map((row) => personalWorkspaceId(row.id)),
    now,
  });
  const gated = (value: string): string | null => (seesSubscribers ? value : null);
  const money = (list: readonly MoneyByCurrency[]): string =>
    list.length === 0 ? formatMinor(0n, "usd") : list.map((each) => formatMinor(each.minor, each.currency)).join(" + ");

  const attention: readonly TileProps[] = [
    {
      label: "Failed payments",
      value: gated(String(numbers.failedPayments)),
      hint: "Subscriptions whose last payment didn't go through. Stripe retries; the person sees a banner to update their card.",
      permission: "staff.tenants.view",
      href: "/admin/billing/subscribers",
    },
    {
      label: "Errors to triage",
      value: errors === null ? null : String(errors),
      hint: "Problems the site recorded that nobody has marked as fixed.",
      permission: "staff.audit.view",${full ? '\n      href: "/admin/errors",' : ""}
    },
  ];
  const money_: readonly TileProps[] = [
    { label: "Paying", value: gated(String(numbers.paying)), hint: "People paying by card now. Free trials and free months are not counted.", permission: "staff.tenants.view", href: "/admin/billing/subscribers" },
    { label: "MRR", value: gated(money(numbers.mrr)), hint: "What paying subscriptions bring in a month: monthly prices, plus yearly ones / 12.", permission: "staff.tenants.view" },
    { label: "ARR", value: gated(money(numbers.arr)), hint: "The same, for a year.", permission: "staff.tenants.view" },
    { label: "Monthly / yearly", value: gated(\`\${numbers.monthly} / \${numbers.yearly}\`), hint: "Paying subscriptions billed every month, and every year.", permission: "staff.tenants.view" },
  ];
  const month: readonly TileProps[] = [
    { label: "New this month", value: gated(String(numbers.newThisMonth)), hint: "People whose first paid subscription started since the 1st.", permission: "staff.tenants.view" },
    { label: "Cancelled this month", value: gated(String(numbers.cancelledThisMonth)), hint: "Subscriptions cancelled since the 1st.", permission: "staff.tenants.view" },
    {
      label: "Free to paid",
      value: gated(numbers.freeToPaid.percent === null ? "0%" : \`\${numbers.freeToPaid.percent}%\`),
      hint: \`\${numbers.freeToPaid.paying} of \${numbers.freeToPaid.accounts} accounts pay. Of this month's \${numbers.signups.thisMonth} sign-ups, \${numbers.signups.paying} already do.\`,
      permission: "staff.tenants.view",
    },
    { label: "On a free trial", value: gated(String(numbers.trialing)), hint: "Not paying yet: the card is charged when the trial ends.", permission: "staff.tenants.view" },
  ];
  const nothingYet = seesSubscribers && facts.length === 0 && accounts <= 1;

  return (
    <>
      <PageHeader title="Dashboard" description="Who pays for what, what it's worth, and what moved this month." />

      {nothingYet ? (
        <EmptyState title="Nobody has subscribed yet">
          Every number below is real, and on a site this new they are all zero. They fill in as people sign up and choose a
          plan.
        </EmptyState>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">Needs attention</h2>
        <TileGrid tiles={attention} />
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">Subscribers</h2>
        <TileGrid tiles={money_} />
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">This month</h2>
        <TileGrid tiles={month} />
      </section>

      {seesSubscribers && numbers.byPlan.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">On each plan</h2>
          <Table>
            <THead>
              <TR>
                {plans.lines.length > 1 ? <TH>Line</TH> : null}
                <TH>Plan</TH>
                <TH>People</TH>
              </TR>
            </THead>
            <TBody>
              {numbers.byPlan.map((row) => (
                <TR key={\`\${row.line}:\${row.tierKey}\`}>
                  {plans.lines.length > 1 ? <TD>{plans.line(row.line)?.name ?? row.line}</TD> : null}
                  <TD>{plans.tier(row.tierKey)?.name ?? row.tierKey}</TD>
                  <TD className="tabular-nums">{row.count}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      ) : null}
${shopSection}    </>
  );
}

function TileGrid({ tiles }: { readonly tiles: readonly TileProps[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((entry) => (
        <Tile key={entry.label} {...entry} />
      ))}
    </div>
  );
}

function Tile({ label, value, hint, permission, href }: TileProps) {
  const body = (
    <div className="h-full rounded-[--radius-card] border border-line bg-surface p-4 shadow-card">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      {value === null ? (
        <p className="mt-2 text-xs text-ink-muted">
          Needs <code className="font-mono">{permission}</code>
        </p>
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</p>
      )}
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{hint}</p>
    </div>
  );
  return href && value !== null ? (
    <Link href={href} className="block no-underline">
      {body}
    </Link>
  ) : (
    body
  );
}
`;
}
