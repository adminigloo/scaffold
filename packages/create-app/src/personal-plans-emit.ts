/**
 * PERSONAL PLANS (billing 0.5): a project whose customers are PEOPLE
 * (`--tenant-noun none --audience consumers --model subscription|both`).
 *
 * Every person who signs up gets an invisible personal workspace, and that
 * workspace is what pays: plans are enforced per person, a person can hold
 * one tier of every product line at once (one Stripe subscription, one bill),
 * nobody shares an account (one seat, no team page), and the founder sees who
 * pays for what at /admin/billing/subscribers.
 *
 * WHAT A PERSONAL PLAN CLOSES — NOTHING BY ITSELF. A person with no plan is a
 * free account, not a closed one, so the permission loaders pass through and
 * every feature that is for sale asks for itself, by name:
 * `requireEntitlement("weather_tools")` on a page, a route handler or a tRPC
 * procedure (src/server/access.ts, emitted wherever plans are sold, companies
 * included). The banner tells the person where each of their plans stands.
 *
 * This module writes three files: the personal variant of
 * src/server/plan-gate.ts, of src/components/PlanBannerSlot.tsx, and the
 * proof src/server/__tests__/personal-plans.test.ts.
 */
import { consumerProduct, type Answers } from "./answers.js";

/** A consumers project that sells subscriptions charges each PERSON for their plans. */
export function personalPlans(answers: Answers): boolean {
  return consumerProduct(answers) && (answers.businessModel === "subscription" || answers.businessModel === "both");
}

// ---------------------------------------------------------------------------
// src/server/plan-gate.ts — the personal variant
// ---------------------------------------------------------------------------

export function renderPersonalPlanGate(answers: Answers): string {
  const scope = answers.scope;
  return `import { createPlanGate, type PlanStanding } from "${scope}/billing";
import { loadCompanyPlan, type BillingDb, type CompanyPlan, type LinePlan } from "${scope}/billing/server";
import { db } from "@/db";
import { env } from "@/env";
import { plans } from "@/plans";

/**
 * THE PLAN CHECK — personal plans (billing 0.5): every person who signs up
 * pays for their own plans, through their own (invisible) workspace.
 *
 * A PERSON WITHOUT A PLAN IS A FREE ACCOUNT, NOT A CLOSED ONE. So nothing
 * here closes the person's workspace: the permission loaders pass through,
 * and each feature that is for sale asks for itself by name with
 * \`requireEntitlement(feature)\` (src/server/access.ts) — on a page, a route
 * handler or a tRPC procedure. Their plans grant those features
 * (src/plans.ts), one product line at a time: Weather Pro and Sports can be
 * held at once, on one bill.
 *
 * NOBODY SHARES AN ACCOUNT: one person per workspace (\`seatLimitOption\`),
 * so a subscriber can't invite anyone in to use what they pay for.
 *
 * THE FREE TRIAL is Stripe's, and optional: BILLING_TRIAL_DAYS days (off
 * unless set), only for someone who has never had a subscription, with the
 * card taken up front so the first charge just happens when it ends.
 */

/** The free trial at Stripe, in days (BILLING_TRIAL_DAYS; 0, off, unless set). */
export const CHECKOUT_TRIAL_DAYS = env.BILLING_TRIAL_DAYS ?? 0;

/** The person's plans: where each product line stands, and everything they hold. */
export async function personalPlan(tenantId: string, executor: BillingDb = db): Promise<CompanyPlan> {
  return loadCompanyPlan(executor, { tenantId, trialStartedAt: null, trialDays: 0, plans });
}

/**
 * Where a person stands (the best of their lines), reused for 15 seconds per
 * server copy so a page that asks ten times reads once.
 */
export const planGate = createPlanGate({
  standing: async (tenantId) => (await personalPlan(tenantId)).standing,
  noun: "account",
  cacheMs: 15_000,
});

/** Where a person stands with their plans, for the Subscribers list and anything that wants one answer. */
export function planStandingOf(tenantId: string): Promise<PlanStanding> {
  return planGate.standing(tenantId);
}

/** One product line's standing for this person (null for a line the record doesn't declare). */
export async function lineStandingOf(tenantId: string, line: string): Promise<LinePlan | null> {
  return (await personalPlan(tenantId)).lines.get(line) ?? null;
}

/** Everything the person's plans grant, one answer per feature: what \`requireEntitlement\` reads. */
export async function tenantEntitlements(tenantId: string): Promise<CompanyPlan["entitlements"]> {
  return (await personalPlan(tenantId)).entitlements;
}

/**
 * Each product line's standing, EXACTLY as the plan check reads it — what
 * /account and /account/billing show: which tier a person is on, and whether
 * it's the free tier (create-app 0.39, review: the pages read the
 * subscription's status instead, so once free months ended — or for a plan
 * that never started — they said Pro while the check said Free).
 */
export async function linePlansOf(tenantId: string): Promise<CompanyPlan["lines"]> {
  return (await personalPlan(tenantId)).lines;
}

/** A plan standing's shape, for code shared with projects that sell plans to companies. */
export type PlanStandingView = PlanStanding;

/** Spread into createCompanyRouteSeams / createPublicCompanySeams: nothing (there are no companies). */
export const companyPlanOption = {} as const;

/**
 * Spread into the tenancy service's options: ONE PERSON PER ACCOUNT. The owner
 * fills the only seat, so every invitation is refused before it is sent — a
 * subscriber can't share their plan by inviting people in.
 */
export const seatLimitOption = {
  seats: {
    limitFor: async (): Promise<number> => 1,
  },
} as const;

/** The permission loaders, unchanged: a person without a plan keeps their free account. */
export function gateLoaders<L>(loaders: L): L {
  return loaders;
}

/** One limit from the person's plans: a number, null (unlimited), or undefined (the plans don't say). */
async function planLimit(tenantId: string, feature: string): Promise<number | null | undefined> {
  const held = (await tenantEntitlements(tenantId)).get(feature);
  return held ? held.limit : undefined;
}

/** How much a person may store: their plans' GB, else the project's own allowance. */
export async function storageAllowanceBytes(tenantId: string, fallback: number | null): Promise<number | null> {
  const gb = await planLimit(tenantId, "storage_gb");
  if (gb === undefined) return fallback;
  return gb === null ? null : gb * 1024 * 1024 * 1024;
}

/** Online estimate requests are the one business's, never limited by a person's plan. */
export async function estimateQuota(
  _tenantId: string,
): Promise<{ readonly open: true } | { readonly open: false; readonly message: string }> {
  return { open: true };
}

/** The assistant's questions a month, when a plan sells them ("assistant_messages"); else the project's own. */
export async function assistantMessageLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "assistant_messages");
}

/** Websites of a person's own: not something people buy here (undefined). */
export async function websiteQuota(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Search checks a month: the one business's (undefined). */
export async function siteCheckLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Questions tracked by AI mentions: the one business's (undefined). */
export async function aiQuestionLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** AI mention checks a month: the one business's (undefined). */
export async function aiMentionCheckLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** People taking calls: the one business's (undefined). */
export async function bookingHostLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Products in a store: the one business's (undefined). */
export async function storeProductLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** A free trial here is Stripe's, on a subscription: never the app-side kind companies have. */
export async function companyOnTrial(_tenantId: string): Promise<boolean> {
  return false;
}

/** New paid work for a person's account: always open — features ask for themselves (requireEntitlement). */
export async function companyPlanOpen(_tenantId: string): Promise<true | string> {
  return true;
}

// The banner's words (src/components/PlanBannerSlot.tsx), here so a test reads them with no page around.

const DAY_MS = 24 * 60 * 60 * 1000;

function dateWords(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** "Weather Pro": the tier's own name, else the line's. */
function nameOf(line: LinePlan): string {
  const tierKey = line.standing.tierKey ?? line.subscription?.tierKey ?? null;
  return (tierKey ? plans.tier(tierKey)?.name : undefined) ?? plans.line(line.line)?.name ?? "Your plan";
}

/** The banner's words for a person's lines, the most urgent first; null when there's nothing to say. */
export function personalBannerSentence(
  lines: readonly LinePlan[],
  now: Date = new Date(),
): { readonly sentence: string; readonly urgent: boolean } | null {
  const soon = (at: Date | null, days: number) => at !== null && at.getTime() - now.getTime() <= days * DAY_MS;
  for (const line of lines) {
    if (line.standing.state === "grace") {
      return {
        sentence: line.standing.until
          ? \`The last payment for \${nameOf(line)} didn't go through. Update your card by \${dateWords(line.standing.until)} to keep it.\`
          : \`The last payment for \${nameOf(line)} didn't go through. Update your card to keep it.\`,
        urgent: true,
      };
    }
  }
  for (const line of lines) {
    const sub = line.subscription;
    if (line.standing.open && sub?.status === "trialing" && sub.trialEndsAt !== null && !sub.cancelAtPeriodEnd) {
      const daysLeft = Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY_MS));
      return {
        sentence: \`Free trial of \${nameOf(line)}: \${daysLeft === 1 ? "1 day" : \`\${daysLeft} days\`} left (until \${dateWords(sub.trialEndsAt)}).\`,
        urgent: false,
      };
    }
  }
  for (const line of lines) {
    if (line.standing.state === "ending" && line.standing.until !== null && soon(line.standing.until, 14)) {
      return { sentence: \`\${nameOf(line)} ends on \${dateWords(line.standing.until)}.\`, urgent: false };
    }
  }
  for (const line of lines) {
    const ended = line.subscription?.currentPeriodEnd ?? null;
    if (line.standing.state === "ended" && ended !== null && now.getTime() - ended.getTime() <= 14 * DAY_MS) {
      return { sentence: \`\${nameOf(line)} has ended. Choose it again any time to get it back.\`, urgent: false };
    }
  }
  return null;
}
`;
}

// ---------------------------------------------------------------------------
// src/components/PlanBannerSlot.tsx — the personal variant
// ---------------------------------------------------------------------------

export function renderPersonalPlanBannerSlot(answers: Answers): string {
  const scope = answers.scope;
  return `import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { personalBannerSentence, personalPlan } from "@/server/plan-gate";
import { currentTenantFor } from "@/server/tenant";

/**
 * Where the signed-in person's plans stand, above every page (billing 0.5).
 * Says nothing while every plan is paid and renewing, and nothing to someone
 * who never had one (a free account is not a problem to report). Shown, one
 * line, the most urgent first:
 *   - a payment failed: the date the plan stops unless the card is fixed;
 *   - a free trial (Stripe's): the day it ends;
 *   - a cancelled plan's last two weeks: the day it ends;
 *   - a plan that ended in the last two weeks: that it has, and how to get it back.
 *
 * It must never fail a page: anything it can't read, it doesn't show.
 */
export async function PlanBannerSlot(): Promise<ReactNode> {
  try {
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return null;
    // A prerendered page has no request, and no reader to tell.
    if ((await headers()).get("host") === null) return null;
    const principal = await currentPrincipal();
    if (!principal) return null;
    const tenant = await currentTenantFor(principal.userId);
    if (!tenant) return null;
    const plan = await personalPlan(tenant.id);
    const banner = personalBannerSentence([...plan.lines.values()]);
    if (banner === null) return null;
    return (
      <div role={banner.urgent ? "alert" : "status"} className="border-b border-line bg-surface px-4 py-2 text-sm text-ink">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <span>{banner.sentence}</span>
          <Link href="/account/billing" className="font-medium text-accent underline underline-offset-2">
            {banner.urgent ? "Update your card" : "See your plans"}
          </Link>
        </div>
      </div>
    );
  } catch {
    return null;
  }
}

`;
}

// ---------------------------------------------------------------------------
// src/server/__tests__/personal-plans.test.ts — the proof
// ---------------------------------------------------------------------------

export function renderPersonalPlansTest(answers: Answers): string {
  const scope = answers.scope;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { entitlements, plans as planTable, subscriptions } from "${scope}/billing/schema";
import { db } from "@/db";
import { plans } from "@/plans";
import { seedPermissions } from "@/permissions/seed";
import { entitlementOf, refusalFor } from "@/server/access";
import { personalBannerSentence, personalPlan, seatLimitOption } from "@/server/plan-gate";
import { applySubscription } from "@/server/subscription";
import { tenancy } from "@/server/tenancy";

/**
 * EACH PERSON'S PLANS, PER PRODUCT LINE (billing 0.5) — proved on this
 * project's own schema and its own src/plans.ts, in-process, on every
 * \`pnpm test\`. Two people:
 *
 *   A  takes the first line, moves up a tier within it (Basic to Pro, the
 *      rows UPDATED so what they've used is kept), adds the second line on
 *      top, then drops the second line: the first is untouched throughout.
 *   B  never pays: a free account — every paid feature refused in plain
 *      words, nothing of A's reaching them.
 *
 * And nobody shares an account: inviting anyone into a person's workspace is
 * refused. Needs at least two lines in src/plans.ts (the generated sample has
 * them); with one, the stacking cases say so and pass.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date());

interface Person {
  readonly id: string;
  readonly email: string;
  readonly workspace: string;
}

const fx = {} as { A: Person; B: Person };

async function person(externalId: string, email: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: email }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  const session = await tenancy.resolveSession({ userId: row.id });
  if (session.state !== "ready") throw new Error(\`no workspace for \${email}: \${session.state}\`);
  return { id: row.id, email, workspace: session.company.id };
}

/** The line's tiers that are sold monthly in a currency, cheapest first. */
function monthly(line: string) {
  return plans.rows
    .filter((row) => row.line === line && row.interval === "month" && row.isActive)
    .sort((a, b) => (a.priceMinor < b.priceMinor ? -1 : a.priceMinor > b.priceMinor ? 1 : 0));
}

/** A simulated subscription to one plan row: the same writer a Stripe webhook runs. */
async function subscribe(tenantId: string, rowKey: string, status: "active" | "canceled" = "active") {
  const row = plans.rows.find((candidate) => candidate.key === rowKey)!;
  const now = new Date();
  return applySubscription({
    tenantId,
    tierKey: row.tierKey,
    planKey: row.key,
    stripeSubscriptionId: null,
    stripeCustomerId: null,
    status,
    currentPeriodStart: now,
    // A line dropped today ends today (what the mirror writes when its item comes off).
    currentPeriodEnd: status === "canceled" ? now : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    canceledAt: status === "canceled" ? now : null,
    trialEndsAt: null,
    observedAt: now,
    source: "simulated",
  });
}

/** Features a tier grants (a flag that's on, or a quota above zero). */
function grantedBy(tierKey: string): string[] {
  const tier = plans.tier(tierKey)!;
  return Object.values(tier.features)
    .filter((f) => (f.kind === "flag" && f.included) || (f.kind === "quota" && (f.limit === null || f.limit > 0)))
    .map((f) => f.feature);
}

/**
 * What a line's free tier gives an account with no plan on it (billing 0.6):
 * feature -> its limit (a flag reads 1 or 0), from src/plans.ts's \`free:\`.
 */
function freeLimits(): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const line of plans.lines) {
    if (line.free === null) continue;
    for (const f of Object.values(line.free.features)) {
      if (f.kind === "quota") out.set(f.feature, f.limit);
      else if (f.kind === "flag") out.set(f.feature, f.included ? 1 : 0);
    }
  }
  return out;
}

/** Features a line's free tier grants (a flag that's on, or a quota above zero). */
function grantedFree(line: string | undefined): Set<string> {
  const free = line === undefined ? null : (plans.line(line)?.free ?? null);
  if (free === null) return new Set();
  return new Set(
    Object.values(free.features)
      .filter((f) => (f.kind === "flag" && f.included) || (f.kind === "quota" && (f.limit === null || f.limit > 0)))
      .map((f) => f.feature),
  );
}

function later(): void {
  vi.setSystemTime(new Date(Date.now() + 1_000));
}

const [FIRST, SECOND] = plans.lines;

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
  fx.A = await person("ext_personal_a", "alex@example.test");
  fx.B = await person("ext_personal_b", "blake@example.test");
});

describe("each person's plans, per product line (billing 0.5)", () => {
  it("1. a free account: what the free tier gives and nothing paid for — every paid feature refused in plain words — not a closed account", async () => {
    const plan = await personalPlan(fx.B.workspace);
    expect(plan.standing).toMatchObject({ state: "none", open: false });
    expect([...plan.lines.keys()]).toEqual(plans.lines.map((line) => line.key));
    const cheapest = monthly(FIRST!.key)[0]!;
    const free = grantedFree(FIRST!.key);
    for (const feature of grantedBy(cheapest.tierKey)) {
      const answer = await entitlementOf(fx.B.workspace, feature);
      if (free.has(feature)) {
        // The free tier (src/plans.ts \`free:\`) gives some of it with no plan at all.
        expect(answer.allowed, feature).toBe(true);
        continue;
      }
      expect(answer.allowed, feature).toBe(false);
      expect(answer.message, feature).toBe(refusalFor(feature, answer));
      expect(answer.upgradeHref).toBe("/account/billing");
    }
    for (const feature of free) expect((await entitlementOf(fx.B.workspace, feature)).allowed, feature).toBe(true);
  });

  it("2. the first line, then a tier up within it: the rows are UPDATED in place, so what was used is kept", async () => {
    const [basic, pro] = monthly(FIRST!.key);
    expect(basic, "the first line sells a tier monthly").toBeDefined();
    await subscribe(fx.A.workspace, basic!.key);
    later();
    let plan = await personalPlan(fx.A.workspace);
    expect(plan.lines.get(FIRST!.key)?.standing).toMatchObject({ state: "active", open: true, tierKey: basic!.tierKey });
    for (const feature of grantedBy(basic!.tierKey)) expect((await entitlementOf(fx.A.workspace, feature)).allowed, feature).toBe(true);
    if (pro === undefined) return;
    // Spend some of a quota, if the tier has one, then move up.
    const quota = Object.values(plans.tier(pro.tierKey)!.features).find((f) => f.kind === "quota");
    if (quota) await db.update(entitlements).set({ usedValue: 1 }).where(and(eq(entitlements.tenantId, fx.A.workspace), eq(entitlements.feature, quota.feature)));
    const rowsBefore = await db.select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.tenantId, fx.A.workspace));
    await subscribe(fx.A.workspace, pro.key);
    later();
    plan = await personalPlan(fx.A.workspace);
    expect(plan.lines.get(FIRST!.key)?.standing).toMatchObject({ state: "active", tierKey: pro.tierKey });
    if (quota) expect(plan.entitlements.get(quota.feature)?.used).toBe(1);
    const rowsAfter = await db.select({ id: entitlements.id }).from(entitlements).where(eq(entitlements.tenantId, fx.A.workspace));
    for (const before of rowsBefore) expect(rowsAfter.map((row) => row.id)).toContain(before.id);
    // ONE live row on the line: the move replaced the tier, it didn't stack it.
    const live = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, fx.A.workspace))).filter((row) => row.status !== "canceled");
    expect(live.filter((row) => row.line === FIRST!.key)).toHaveLength(1);
  });

  it("3. a second line STACKS on the first, and dropping it leaves the first exactly as it was", async () => {
    if (SECOND === undefined) {
      expect(plans.lines, "src/plans.ts declares one product line, so there is nothing to stack").toHaveLength(1);
      return;
    }
    const second = monthly(SECOND.key)[0]!;
    const firstBefore = (await personalPlan(fx.A.workspace)).lines.get(FIRST!.key)!.standing;
    const firstTiers = new Set(plans.line(FIRST!.key)!.tiers.map((tier) => tier.key));
    // The first line's rows, before anything happens to the second: these must survive both.
    const firstRows = (await db.select().from(entitlements).where(eq(entitlements.tenantId, fx.A.workspace))).filter((row) =>
      firstTiers.has(row.sourceRef ?? ""),
    );
    expect(firstRows.length, "the first line wrote its rows").toBeGreaterThan(0);
    await subscribe(fx.A.workspace, second.key);
    later();
    let plan = await personalPlan(fx.A.workspace);
    expect(plan.lines.get(SECOND.key)?.standing).toMatchObject({ state: "active", open: true, tierKey: second.tierKey });
    expect(plan.lines.get(FIRST!.key)?.standing).toEqual(firstBefore);
    for (const feature of grantedBy(second.tierKey)) expect((await entitlementOf(fx.A.workspace, feature)).allowed, feature).toBe(true);
    const live = (await db.select().from(subscriptions).where(eq(subscriptions.tenantId, fx.A.workspace))).filter((row) => row.status !== "canceled");
    expect(new Set(live.map((row) => row.line))).toEqual(new Set([FIRST!.key, SECOND.key]));
    // Adding the second line touched none of the first's rows (same ids, same limits, same use).
    const withBoth = await db.select().from(entitlements).where(eq(entitlements.tenantId, fx.A.workspace));
    for (const row of firstRows) expect(withBoth.find((each) => each.id === row.id), row.feature).toMatchObject({ limitValue: row.limitValue, usedValue: row.usedValue });

    // Drop the second line: its rows go, the first line's stay.
    await subscribe(fx.A.workspace, second.key, "canceled");
    later();
    plan = await personalPlan(fx.A.workspace);
    expect(plan.lines.get(SECOND.key)?.standing.open).toBe(false);
    expect(plan.lines.get(FIRST!.key)?.standing).toEqual(firstBefore);
    const after = await db.select().from(entitlements).where(eq(entitlements.tenantId, fx.A.workspace));
    expect(after.filter((row) => row.sourceRef === second.tierKey)).toEqual([]);
    for (const row of firstRows) expect(after.find((each) => each.id === row.id)).toMatchObject({ limitValue: row.limitValue, usedValue: row.usedValue });
    // A feature only the second line sold is refused again (unless the first sells it too, or a free tier gives it).
    const firstSells = new Set(grantedBy(plan.lines.get(FIRST!.key)!.standing.tierKey!));
    const freeSecond = grantedFree(SECOND.key);
    for (const feature of grantedBy(second.tierKey).filter((f) => !firstSells.has(f) && !freeSecond.has(f))) {
      expect((await entitlementOf(fx.A.workspace, feature)).allowed, feature).toBe(false);
    }
  });

  it("4. nothing of A's reaches B: B holds what the free tier gives, and nothing else", async () => {
    const plan = await personalPlan(fx.B.workspace);
    expect(plan.standing.open).toBe(false);
    const free = freeLimits();
    expect(plan.entitlements.size).toBe(free.size);
    for (const [feature, held] of plan.entitlements) {
      expect(free.has(feature), feature).toBe(true);
      expect(held.limit, feature).toBe(free.get(feature));
    }
  });

  it("5. nobody shares an account: an invitation into a person's account is refused before it is sent", async () => {
    // Two locks (create-app 0.39): no role holds members.invite — the owner
    // included — and the seat limit is one.
    await expect(
      tenancy.sendInvitation({ actorUserId: fx.A.id, tenantId: fx.A.workspace, email: "friend@example.test", roleKey: "member" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await seatLimitOption.seats.limitFor()).toBe(1);
  });

  it("6. the banner speaks for a failed payment first, and says nothing to someone who never had a plan", () => {
    const now = new Date();
    const until = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
    const line = (state: "grace" | "active" | "none") => ({
      line: FIRST!.key,
      standing: { state, open: state !== "none", until: state === "grace" ? until : null, tierKey: plans.lines[0]!.tiers[0]!.key },
      subscription: null,
    });
    expect(personalBannerSentence([line("none")], now)).toBeNull();
    expect(personalBannerSentence([line("active")], now)).toBeNull();
    expect(personalBannerSentence([line("active"), line("grace")], now)).toMatchObject({ urgent: true });
  });
});
`;
}
