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
import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** Does this project charge each company a plan? */
export function plansEnforced(answers: Answers): boolean {
  return companiesMode(answers) && (answers.businessModel === "subscription" || answers.businessModel === "both");
}

// ---------------------------------------------------------------------------
// src/server/plan-gate.ts
// ---------------------------------------------------------------------------

export function renderPlanGate(answers: Answers): string {
  const scope = answers.scope;
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

/** Spread into the tenancy service's options: no seat limit. */
export const seatLimitOption = {} as const;

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
  });
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
 * (src/plans.ts, "websites of your own counted"; Tenancy 2b-4a). Checked when
 * one is added (src/server/website.ts); its pages here are always counted.
 * A number: the limit; null: unlimited; undefined: the plan doesn't say.
 */
export async function websiteQuota(tenantId: string): Promise<number | null | undefined> {
  return planLimit(tenantId, "websites");
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
import { auth } from "@clerk/nextjs/server";
import type { PlanStanding } from "${scope}/billing";
import { env } from "@/env";
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
    const { userId } = await auth();
    if (!userId) return null;
    const session = await tenancy.resolveSession({ userId });
    if (session.state !== "ready") return null;
    const standing = await planStandingOf(session.company.id);
    const sentence = bannerSentence(standing, session.company.name);
    if (sentence === null) return null;
    const permissions = await loadTenantPermissions({ principal: { userId }, tenantId: session.company.id });
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
