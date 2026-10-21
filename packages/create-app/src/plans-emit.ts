/**
 * PLANS FOR EVERY PACKAGE (billing 0.3): the one plan check a companies
 * project asks at every checkpoint, and the banner that tells a company where
 * it stands.
 *
 * WHY GENERATED, IN EVERY PROJECT. `src/server/permissions.ts`, the company
 * routes, the tenancy service and the files glue all import from
 * `src/server/plan-gate.ts`, and none of them may carry an `if` about whether
 * this project charges companies (the generator's rule). So the file exists
 * everywhere, in the variant the answers call for:
 *
 *   ENFORCED  a companies project that sells subscriptions (--model
 *             subscription or both): the real gate, a free trial, plan
 *             limits for seats, storage and online estimates.
 *   OPEN      anything else (one business; or companies with no plans to
 *             sell): every helper answers "no limit", the loaders pass
 *             through untouched.
 *
 * The emitted proof of the enforced variant is `company-plans.test.ts`
 * (feature-proofs-emit.ts): a company whose plan ended can read but not work,
 * its public pages are closed, its billing still opens, and the company next
 * door is untouched.
 */
import { consumerProduct, tenantLabel, type Answers } from "./answers.js";
import { personalPlans, renderPersonalPlanBannerSlot, renderPersonalPlanGate } from "./personal-plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

export { personalPlans } from "./personal-plans-emit.js";

/** Does this project charge each company a plan? */
export function plansEnforced(answers: Answers): boolean {
  return companiesMode(answers) && (answers.businessModel === "subscription" || answers.businessModel === "both");
}

// ---------------------------------------------------------------------------
// src/server/plan-gate.ts
// ---------------------------------------------------------------------------

export function renderPlanGate(answers: Answers): string {
  const scope = answers.scope;
  // PERSONAL PLANS (billing 0.5): each person pays for their own.
  if (personalPlans(answers)) return renderPersonalPlanGate(answers);
  if (!plansEnforced(answers)) {
    const why = companiesMode(answers)
      ? `this project's ${tenantLabel(answers).toLowerCase()}s aren't sold a plan (it was generated with --model ${answers.businessModel})`
      : "this project runs one business, so there is nobody else's plan to check";
    return `/**
 * THE PLAN CHECK — the open variant: ${why}. Every helper here answers "no
 * limit", and the permission loaders pass through untouched. GENERATED in two
 * variants; the other one (a companies project that sells subscriptions)
 * enforces each company's plan at every checkpoint.
 */

/** Spread into createCompanyRouteSeams / createPublicCompanySeams: nothing to add. */
export const companyPlanOption = {} as const;
${consumerProduct(answers) ? `
/**
 * Spread into the tenancy service's options: ONE PERSON PER ACCOUNT (billing
 * 0.5). This project's customers sign up as themselves, so nobody invites
 * anyone into their account: the owner fills the only seat.
 */
export const seatLimitOption = {
  seats: {
    limitFor: async (): Promise<number> => 1,
  },
} as const;` : `
/** Spread into the tenancy service's options: no seat limit. */
export const seatLimitOption = {} as const;`}

/** No free trial at checkout: there are no plans to try here. */
export const CHECKOUT_TRIAL_DAYS = 0;

/** The permission loaders, unchanged. */
export function gateLoaders<L>(loaders: L): L {
  return loaders;
}

/** How much a company may store: the project's own allowance. */
export async function storageAllowanceBytes(_tenantId: string, fallback: number | null): Promise<number | null> {
  return fallback;
}

/** A plan standing's shape, for code shared with projects that do sell plans. */
export interface PlanStandingView {
  readonly state: "trial" | "active" | "ending" | "grace" | "ended" | "none";
  readonly open: boolean;
  readonly until: Date | null;
  readonly tierKey: string | null;
}

/** Where a company stands with its plan: nowhere to stand — this project doesn't sell plans. */
export async function planStandingOf(_tenantId: string): Promise<PlanStandingView | null> {
  return null;
}

/** Online estimate requests are never limited by a plan here. */
export async function estimateQuota(
  _tenantId: string,
): Promise<{ readonly open: true } | { readonly open: false; readonly message: string }> {
  return { open: true };
}

/** The assistant's questions a month from a plan: none here (undefined), so the project's own allowance applies. */
export async function assistantMessageLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** How many websites of its own a company may count: no limit here (undefined). */
export async function websiteQuota(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Search checks a month from a plan: none here (undefined), so the package's own default applies. */
export async function siteCheckLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Questions tracked by AI mentions from a plan: none here (undefined), so the project's own number applies. */
export async function aiQuestionLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** AI mention checks a month from a plan: none here (undefined), so the project's own allowance applies. */
export async function aiMentionCheckLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** People taking calls from a plan: none here (undefined), so there's no limit. */
export async function bookingHostLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Products in a store from a plan: none here (undefined), so there's no limit. */
export async function storeProductLimit(_tenantId: string): Promise<number | null | undefined> {
  return undefined;
}

/** Is this company on a free trial? Never: there are no plans here. */
export async function companyOnTrial(_tenantId: string): Promise<boolean> {
  return false;
}

/** May this company start new paid work (a search check, an AI answer)? Always: there is no plan here to end. */
export async function companyPlanOpen(_tenantId: string): Promise<true | string> {
  return true;
}
`;
  }

  const noun = tenantLabel(answers).toLowerCase();
  const estimator = answers.includeEstimator;
  return `import { and, count, eq, gte, min, ne } from "drizzle-orm";
import {
  createPlanGate,
  gatePermissionLoaders,
  grantsForPlan,
  type PlanStanding,
} from "${scope}/billing";
import { loadCompanyPlan, type BillingDb, type CompanyPlan } from "${scope}/billing/server";${estimator ? `
import { estimatorEstimates } from "${scope}/estimator/schema";` : ""}
import { tenants } from "${scope}/tenancy/schema";
import type { CompanyPlanGate } from "${scope}/tenancy/server";
import { db } from "@/db";
import { env } from "@/env";
import { plans } from "@/plans";

/**
 * THE PLAN CHECK — every ${noun} pays for a plan, and this is where each one
 * stands (billing 0.3). ONE answer, asked from every checkpoint a ${noun}
 * request passes through, so a plan applies to every package at once:
 *
 *   src/server/permissions.ts   the tRPC ${noun} rung and every page gate
 *                               (\`gateLoaders\`)
 *   src/server/company-routes.ts  every feature route and every public page
 *                               (\`companyPlanOption\`)
 *   src/server/tenancy.ts       inviting people past the plan's seats
 *                               (\`seatLimitOption\`)
 *
 * WHAT A CLOSED PLAN MEANS. A ${noun} whose free trial ran out without a plan,
 * whose plan was cancelled and has ended, or whose card kept failing past the
 * grace (14 days) can still SEE everything it has, open Billing to choose a
 * plan, and manage its team and settings. It can't do new work — no estimates,
 * bookings, invoices, messages or uploads — and its public pages say it isn't
 * taking requests online. Nothing is deleted; choosing a plan opens it again.
 * Your own staff are never locked out.
 *
 * THE FREE TRIAL (BILLING_TRIAL_DAYS, default 14) starts when the ${noun} is
 * made, so nobody needs a card to start. On a project that ran before plans
 * were enforced, set PLANS_ENFORCED_FROM to the day you deployed this, and
 * every existing ${noun} gets a fresh trial from then instead of being
 * closed the moment you deploy.
 *
 * LIMITS come from the plan (src/plans.ts). On the free trial, a ${noun} gets
 * the limits of the highlighted plan, so it tries what most people buy.
 */

export const TRIAL_DAYS = env.BILLING_TRIAL_DAYS ?? 14;

/**
 * No trial at Stripe's checkout: a ${noun}'s free trial is the app's own
 * (above), from the day it was made, with no card.
 */
export const CHECKOUT_TRIAL_DAYS = 0;

/**
 * When this ${noun}'s free trial started: when it was made, or
 * PLANS_ENFORCED_FROM if that's later. Read straight off the companies table
 * with the caller's own handle, so the seat check (which runs inside the
 * tenancy service's transaction) asks on that transaction rather than
 * waiting for a second connection.
 */
async function trialStartedAt(executor: BillingDb, tenantId: string): Promise<Date | null> {
  const [company] = await executor
    .select({ createdAt: tenants.createdAt, ownerUserId: tenants.ownerUserId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!company) return null;
  // ONE free trial per owner (review M3): a second ${noun} by the same owner
  // starts its trial when their first one did, so a fresh ${noun} is never a
  // fresh free trial.
  let started = company.createdAt;
  if (company.ownerUserId !== null) {
    const [first] = await executor
      .select({ at: min(tenants.createdAt) })
      .from(tenants)
      .where(and(eq(tenants.ownerUserId, company.ownerUserId), eq(tenants.kind, "org")));
    if (first?.at && first.at < started) started = first.at;
  }
  const enforcedFrom = env.PLANS_ENFORCED_FROM ? new Date(\`\${env.PLANS_ENFORCED_FROM}T00:00:00Z\`) : null;
  return enforcedFrom !== null && enforcedFrom > started ? enforcedFrom : started;
}

/** The ${noun}'s standing and everything its plan allows, from three small queries. */
export async function companyPlan(tenantId: string, executor: BillingDb = db): Promise<CompanyPlan> {
  return loadCompanyPlan(executor, {
    tenantId,
    trialStartedAt: await trialStartedAt(executor, tenantId),
    trialDays: TRIAL_DAYS,
    // Per product line (billing 0.5): open while any line is paid for.
    plans,
  });
}

/**
 * Everything the ${noun}'s plan allows, one answer per feature — what
 * \`requireEntitlement\` reads (src/server/access.ts). On the free trial, the
 * highlighted plan's allowances for anything it doesn't already hold, so it
 * tries what most people buy.
 */
export async function tenantEntitlements(tenantId: string): Promise<CompanyPlan["entitlements"]> {
  const plan = await companyPlan(tenantId);
  if (plan.standing.state !== "trial") return plan.entitlements;
  const tier = trialTier();
  if (!tier) return plan.entitlements;
  const merged = new Map(plan.entitlements);
  for (const grant of grantsForPlan(tier)) {
    if (merged.has(grant.feature)) continue;
    merged.set(grant.feature, {
      limit: grant.limitValue,
      used: 0,
      remaining: grant.limitValue,
      unlimited: grant.limitValue === null,
    });
  }
  return merged;
}

/**
 * The gate itself. A ${noun}'s standing is reused for 15 seconds per server
 * copy, so a page that asks ten times reads once; a new plan opens the
 * ${noun} within those seconds of Stripe telling us.
 */
export const planGate = createPlanGate({
  standing: async (tenantId) => (await companyPlan(tenantId)).standing,
  noun: ${JSON.stringify(noun)},
  cacheMs: 15_000,
});

/** Where a ${noun} stands, for the banner and the Billing page. */
export function planStandingOf(tenantId: string): Promise<PlanStanding> {
  return planGate.standing(tenantId);
}

/** Spread into createCompanyRouteSeams / createPublicCompanySeams. */
export const companyPlanOption: { readonly plan: CompanyPlanGate } = { plan: planGate };

/** The permission loaders, trimmed to "see, pay, manage the team" while a ${noun}'s plan is closed. */
export function gateLoaders<L extends Parameters<typeof gatePermissionLoaders>[0]>(loaders: L): L {
  return gatePermissionLoaders(loaders, planGate);
}

/** The cheapest plan on sale (by its lowest monthly price): what a closed ${noun} is held to. */
function smallestTier() {
  const priced = plans.rows
    .filter((row) => row.isActive && row.interval === "month")
    .sort((a, b) => (a.priceMinor < b.priceMinor ? -1 : a.priceMinor > b.priceMinor ? 1 : 0));
  const key = priced[0]?.tierKey;
  return (key ? plans.tier(key) : undefined) ?? plans.tiers.find((tier) => tier.isActive);
}

/** The plan everyone tries on the free trial: the highlighted one, else the first on sale. */
function trialTier() {
  return plans.tiers.find((tier) => tier.isActive && tier.highlight) ?? plans.tiers.find((tier) => tier.isActive);
}

/**
 * One limit from the ${noun}'s plan. A number: the limit. null: unlimited.
 * undefined: the plan doesn't mention it, so the project's own default applies.
 */
export async function planLimit(
  tenantId: string,
  feature: string,
  executor: BillingDb = db,
): Promise<number | null | undefined> {
  const plan = await companyPlan(tenantId, executor);
  const held = plan.entitlements.get(feature);
  if (held) return held.limit;
  if (plan.standing.state === "trial") {
    const tier = trialTier();
    const grant = tier ? grantsForPlan(tier).find((g) => g.feature === feature) : undefined;
    if (grant) return grant.limitValue;
  }
  // A closed ${noun} holds the SMALLEST plan's limits (review M2): with no
  // plan it could otherwise invite without end, then subscribe to a plan its
  // team has already outgrown.
  if (!plan.standing.open) {
    const tier = smallestTier();
    const grant = tier ? grantsForPlan(tier).find((g) => g.feature === feature) : undefined;
    if (grant) return grant.limitValue;
  }
  return undefined;
}

/** Spread into the tenancy service's options: inviting people stops at the plan's seats. */
export const seatLimitOption = {
  seats: {
    // On the tenancy service's own transaction (it holds the company's lock).
    limitFor: async (tx: unknown, tenantId: string): Promise<number | null> =>
      (await planLimit(tenantId, "seats", tx as BillingDb)) ?? null,
    upgradeHref: "/account/billing",
  },
} as const;

/** How much a ${noun} may store: its plan's GB, else the project's own allowance. */
export async function storageAllowanceBytes(tenantId: string, fallback: number | null): Promise<number | null> {
  const gb = await planLimit(tenantId, "storage_gb");
  if (gb === undefined) return fallback;
  return gb === null ? null : gb * 1024 * 1024 * 1024;
}

/**
 * The AI assistant's questions a month, from the ${noun}'s plan (src/plans.ts,
 * "AI assistant messages a month"). A number: the limit; null: unlimited;
 * undefined: the plan doesn't say, so src/server/assistant.ts's own
 * allowance applies. Counted by the assistant from ai_usage before every
 * question it answers with AI (Tenancy 2b-3).
 */
export async function assistantMessageLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "assistant_messages");
}

/**
 * How many websites of its own a ${noun} may count, from its plan
 * (src/plans.ts, "websites of your own, with visit counts"; Tenancy 2b-4a). Checked when
 * one is added (src/server/website.ts); its pages here are always counted.
 * A number: the limit; null: unlimited; undefined: the plan doesn't say.
 */
export async function websiteQuota(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "websites");
}

/**
 * "Check now" presses a month, from the ${noun}'s plan (src/plans.ts; Tenancy
 * 2b-4b). Counted by the search check when one is pressed; the weekly check
 * is included in every plan and never counts. A number: the limit; null:
 * unlimited; undefined: the plan doesn't say.
 */
export async function siteCheckLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "site_checks");
}

/**
 * AI mention checks a month, from the ${noun}'s plan (src/plans.ts, "AI mention
 * checks a month"; Tenancy 2b-4b): one answer to one question is one check,
 * counted from ai_usage before each is asked. undefined: the plan doesn't say.
 */
export async function aiMentionCheckLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "ai_mention_checks");
}

/**
 * How many of the ${noun}'s people may take calls at once, from its plan
 * (src/plans.ts, "people taking calls"; Tenancy 2b-4c). Checked when someone
 * is added to take calls, or switched back on. undefined: the plan doesn't say.
 */
export async function bookingHostLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "booking_hosts");
}

/**
 * How many products the ${noun}'s store may hold, from its plan (src/plans.ts,
 * "products in your store"; getting paid, part 2). Checked when a product is
 * added; removed products don't count. undefined: the plan doesn't say.
 */
export async function storeProductLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "products");
}

/**
 * Is the ${noun} on its free trial (Tenancy 2b-4c)? Anyone can start one, so a
 * trial ${noun}'s booking emails are capped at 20 a day (src/server/booking.ts).
 */
export async function companyOnTrial(tenantId: string): Promise<boolean> {
  return (await planStandingOf(tenantId)).state === "trial";
}

/**
 * Questions a ${noun} may track with AI mentions, from its plan (src/plans.ts,
 * "questions tracked by AI mentions"): each one is asked about once a week.
 * Checked when a question is added. undefined: the plan doesn't say.
 */
export async function aiQuestionLimit(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "ai_questions");
}

/**
 * May this ${noun} start new PAID work right now — a search check, an AI
 * answer — from a job with no request (the daily crons) as well as a route?
 * true while its plan is open; otherwise the sentence to refuse with. Its old
 * reports and answers stay readable either way.
 */
export async function companyPlanOpen(tenantId: string): Promise<true | string> {
  const standing = await planGate.standing(tenantId);
  return standing.open ? true : "This ${noun}'s plan has ended, so new checks are paused. Choose a plan in Billing to start them again.";
}

/**
 * Online estimate requests this month, against the plan's limit: once a
 * ${noun} has had its month's worth, its estimate page and website widget
 * say it isn't taking online estimate requests right now (staff can still
 * make estimates themselves). Counted from the estimates themselves, so the
 * number is always the real one and starts again each calendar month (UTC).
 */
export async function estimateQuota(
  tenantId: string,
): Promise<{ readonly open: true } | { readonly open: false; readonly message: string }> {${estimator ? `
  const limit = await planLimit(tenantId, "estimates");
  if (limit === undefined || limit === null) return { open: true };
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ n: count() })
    .from(estimatorEstimates)
    .where(
      and(
        eq(estimatorEstimates.tenantId, tenantId),
        // Customers' requests only: the ones the plan sells. Estimates staff make by hand never count.
        ne(estimatorEstimates.source, "staff"),
        gte(estimatorEstimates.createdAt, monthStart),
      ),
    );
  if (Number(row?.n ?? 0) < limit) return { open: true };
  const { tenancy } = await import("./tenancy");
  const name = (await tenancy.companyProfile(tenantId))?.name ?? "This business";
  return { open: false, message: \`\${name} isn't taking online estimate requests right now. Please call or email them instead.\` };` : `
  // This project has no estimator, so there are no online estimate requests to limit.
  void tenantId;
  return { open: true };`}
}
`;
}

// ---------------------------------------------------------------------------
// src/components/PlanBannerSlot.tsx
// ---------------------------------------------------------------------------

export function renderPlanBannerSlot(answers: Answers): string {
  if (personalPlans(answers)) return renderPersonalPlanBannerSlot(answers);
  if (!plansEnforced(answers)) {
    return `import type { ReactNode } from "react";

/**
 * Where a company stands with its plan, above every page. Nothing: this
 * project doesn't sell plans to companies. (GENERATED in two variants.)
 */
export async function PlanBannerSlot(): Promise<ReactNode> {
  return null;
}
`;
  }
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import type { PlanStanding } from "${scope}/billing";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadTenantPermissions } from "@/server/permissions";
import { planStandingOf } from "@/server/plan-gate";
import { tenancy } from "@/server/tenancy";

/**
 * Where the ${noun} the person is working in stands with its plan, above every
 * page (billing 0.3). Says nothing while a plan is paid and renewing. Shown:
 *   - on the free trial: how many days are left;
 *   - after a failed payment: the date the ${noun} closes unless the card is fixed;
 *   - a cancelled plan's last two weeks: the day it ends;
 *   - a closed plan: that work is paused, and what opens it again.
 * "Choose a plan" is a link only for someone who can manage the plan.
 *
 * It must never fail a page: anything it can't read, it doesn't show.
 */
export async function PlanBannerSlot(): Promise<ReactNode> {
  try {
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return null;
    // A prerendered page has no request, and no reader to tell.
    if ((await headers()).get("host") === null) return null;
    // The app's own user, not Clerk's id: a session is looked up by the
    // users-table id, and a Clerk id finds nobody (so the banner never showed).
    const principal = await currentPrincipal();
    if (!principal) return null;
    const session = await tenancy.resolveSession({ userId: principal.userId });
    if (session.state !== "ready") return null;
    const standing = await planStandingOf(session.company.id);
    const sentence = bannerSentence(standing, session.company.name);
    if (sentence === null) return null;
    const permissions = await loadTenantPermissions({ principal, tenantId: session.company.id });
    const canChoose = permissions?.can("subscriptions.manage") ?? false;
    const closed = !standing.open;
    return (
      <div
        role={closed ? "alert" : "status"}
        className={\`border-b px-4 py-2 text-sm \${closed ? "border-danger bg-danger-soft text-ink" : "border-line bg-surface text-ink"}\`}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <span>{sentence}</span>
          {canChoose ? (
            <Link href="/account/billing" className="font-medium text-accent underline underline-offset-2">
              {closed ? "Choose a plan" : standing.state === "grace" ? "Update your card" : "See plans"}
            </Link>
          ) : closed ? (
            <span className="text-ink-muted">Ask the owner to choose a plan.</span>
          ) : null}
        </div>
      </div>
    );
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateWords(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** The banner's words, or null when there's nothing to say. */
export function bannerSentence(standing: PlanStanding, companyName: string, now: Date = new Date()): string | null {
  const daysLeft = standing.until ? Math.max(0, Math.ceil((standing.until.getTime() - now.getTime()) / DAY_MS)) : null;
  switch (standing.state) {
    case "active":
      return null;
    case "trial":
      return daysLeft === null
        ? null
        : \`Free trial: \${daysLeft === 1 ? "1 day" : \`\${daysLeft} days\`} left for \${companyName}.\`;
    case "grace":
      return standing.until
        ? \`The last payment for \${companyName} didn't go through. Update the card by \${dateWords(standing.until)} to keep everything running.\`
        : \`The last payment for \${companyName} didn't go through. Update the card to keep everything running.\`;
    case "ending":
      if (!standing.until || daysLeft === null || daysLeft > 14) return null;
      return \`\${companyName}'s plan ends on \${dateWords(standing.until)}.\`;
    case "ended":
      return \`\${companyName}'s plan has ended. You can still see everything, but new work is paused until there's a plan again.\`;
    case "none":
      return \`\${companyName}'s free trial has ended. You can still see everything, but new work is paused until there's a plan.\`;
  }
}
`;
}

// ---------------------------------------------------------------------------
// src/server/access.ts and src/components/Entitled.tsx (billing 0.5)
// ---------------------------------------------------------------------------

/** Does this project sell plans at all — to companies, or to people — and so get the entitlement checks? */
export function sellsPlans(answers: Answers): boolean {
  return plansEnforced(answers) || personalPlans(answers);
}

export function renderAccess(answers: Answers): string {
  const scope = answers.scope;
  const who = personalPlans(answers) ? "person" : tenantLabel(answers).toLowerCase();
  return `import { checkEntitlement, type EntitlementCheck } from "${scope}/billing";
import { plans } from "@/plans";
import { currentPrincipal } from "./auth";
import { tenantEntitlements } from "./plan-gate";
import { currentTenantFor } from "./tenant";
import { requireTenant, TRPCError } from "./trpc";

/**
 * ONE QUESTION FOR EVERY PAID FEATURE (billing 0.5): may this ${who} use
 * \`feature\` right now? Asked from a page, a route handler or a tRPC
 * procedure, always the same way, always with the sentence to show when the
 * answer is no — "Pro tools come with Weather Pro. See plans to add it."
 *
 * The answer comes from the entitlement rows the ${who}'s plans wrote
 * (src/plans.ts says what each tier grants; billing keeps the rows in step
 * with Stripe), so the pricing page and the check can never disagree.
 *
 *   page           \`await pageEntitlement("weather_tools")\`, or wrap the part
 *                  in \`<Entitled feature="weather_tools">\` (it shows the
 *                  upsell instead of the children)
 *   route handler  \`export const GET = withEntitlement("weather_tools", handler)\`:
 *                  401 signed out, 403 { error: { code: "upgrade_required" } }
 *   tRPC           \`requireEntitlement("weather_tools").query(...)\`: a tenant
 *                  procedure (it takes \`tenantId\`) that also needs the feature
 *
 * A quota is asked with an amount: \`entitlementOf(tenantId, "alert_rules", 1)\`
 * before adding one more.
 */

/** Where "see plans" goes. */
export const UPGRADE_HREF = "/account/billing";

export interface Entitlement extends EntitlementCheck {
  /** The sentence to show when the answer is no; null when it's yes. */
  readonly message: string | null;
  /** Where to send someone to change that. */
  readonly upgradeHref: string;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "A", "A or B", "A, B or C". */
function either(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return \`\${names.slice(0, -1).join(", ")} or \${names[names.length - 1]}\`;
}

/** Which plans on sale include a feature (a flag that's on, a quota above zero). */
function plansWith(feature: string): string[] {
  return plans.tiers
    .filter((tier) => {
      if (!tier.isActive) return false;
      const held = tier.features[feature];
      if (held === undefined) return false;
      if (held.kind === "flag") return held.included;
      if (held.kind === "quota") return held.limit === null || held.limit > 0;
      return false;
    })
    .map((tier) => tier.name);
}

/** The sentence for a refusal, from the reason and the plan record. */
export function refusalFor(feature: string, check: Pick<EntitlementCheck, "reason">): string {
  const heading = plans.features.find((candidate) => candidate.feature === feature);
  const label = heading?.label ?? feature;
  const sellers = plansWith(feature);
  // A flag at 0 is "withheld by the plan", which reads like not having it at all.
  if (check.reason === "limit-reached" && heading?.kind !== "flag") {
    return sellers.length > 0 ? \`You've used all of your \${label}. A bigger plan has more.\` : \`You've used all of your \${label}.\`;
  }
  if (sellers.length === 0) return \`\${capitalised(label)} isn't on any plan right now.\`;
  return \`\${capitalised(label)} comes with \${either(sellers)}. See plans to add it.\`;
}

/** May this ${who} use \`amount\` of \`feature\` now? With the sentence for a no. */
export async function entitlementOf(tenantId: string, feature: string, amount = 1): Promise<Entitlement> {
  const check = checkEntitlement(await tenantEntitlements(tenantId), feature, amount);
  return { ...check, message: check.allowed ? null : refusalFor(feature, check), upgradeHref: UPGRADE_HREF };
}

export interface PageEntitlement extends Entitlement {
  readonly signedIn: boolean;
  /** Whose plans were asked (null when nobody is signed in, or they have no workspace yet). */
  readonly tenantId: string | null;
}

/** For a page (a server component): the signed-in ${who}'s answer. Signed out is a no that says to sign in. */
export async function pageEntitlement(feature: string, amount = 1): Promise<PageEntitlement> {
  const principal = await currentPrincipal();
  if (!principal) {
    return { allowed: false, remaining: 0, reason: "no-entitlement", message: "Sign in to use this.", upgradeHref: "/sign-in", signedIn: false, tenantId: null };
  }
  const tenant = await currentTenantFor(principal.userId);
  if (!tenant) {
    return { allowed: false, remaining: 0, reason: "no-entitlement", message: refusalFor(feature, { reason: "no-entitlement" }), upgradeHref: UPGRADE_HREF, signedIn: true, tenantId: null };
  }
  return { ...(await entitlementOf(tenant.id, feature, amount)), signedIn: true, tenantId: tenant.id };
}

/** Who the request is for, handed to a route handler that passed. */
export interface Access {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * For a route handler: answers 401 signed out, 403 \`upgrade_required\` (with
 * the sentence and where to upgrade) when the ${who}'s plans don't include
 * it, and otherwise runs \`handler\` with who it's for.
 */
export function withEntitlement<Context = unknown>(
  feature: string,
  handler: (req: Request, context: Context, access: Access) => Response | Promise<Response>,
  amount = 1,
): (req: Request, context: Context) => Promise<Response> {
  return async (req, context) => {
    const principal = await currentPrincipal();
    if (!principal) {
      return Response.json({ error: { code: "unauthenticated", message: "Sign in to use this." } }, { status: 401 });
    }
    const tenant = await currentTenantFor(principal.userId);
    if (!tenant) {
      return Response.json({ error: { code: "upgrade_required", message: refusalFor(feature, { reason: "no-entitlement" }), upgradeHref: UPGRADE_HREF } }, { status: 403 });
    }
    const answer = await entitlementOf(tenant.id, feature, amount);
    if (!answer.allowed) {
      return Response.json({ error: { code: "upgrade_required", message: answer.message, upgradeHref: answer.upgradeHref } }, { status: 403 });
    }
    return handler(req, context, { tenantId: tenant.id, userId: principal.userId });
  };
}

/**
 * The tRPC rung: a tenant procedure (it takes \`tenantId\`, checked against
 * \`permission\` like every tenant procedure) that also needs \`feature\` from
 * that ${who}'s plans. Refused as FORBIDDEN with the sentence.
 */
export function requireEntitlement(feature: string, permission = "tenant.view") {
  return requireTenant(permission).use(async (opts) => {
    const answer = await entitlementOf(opts.ctx.tenantId, feature);
    if (!answer.allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: answer.message ?? "Your plan doesn't include this." });
    }
    return opts.next();
  });
}
`;
}

export function renderEntitled(answers: Answers): string {
  void answers;
  return `import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/ui";
import { pageEntitlement } from "@/server/access";

/**
 * Show \`children\` only to someone whose plans include \`feature\` (billing
 * 0.5); everyone else sees why not and where to go — or \`fallback\`, when
 * given (a teaser, a blurred preview). Asks on the server, every render.
 *
 *   <Entitled feature="weather_tools"><PayoutCalculator /></Entitled>
 */
export async function Entitled({
  feature,
  amount = 1,
  fallback,
  children,
}: {
  readonly feature: string;
  readonly amount?: number;
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const access = await pageEntitlement(feature, amount);
  if (access.allowed) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <Notice tone="info" title={access.signedIn ? "Not on your plan yet" : "Sign in to use this"}>
      {access.message}{" "}
      <Link href={access.upgradeHref} className="font-medium text-accent underline underline-offset-2">
        {access.signedIn ? "See plans" : "Sign in"}
      </Link>
    </Notice>
  );
}
`;
}
