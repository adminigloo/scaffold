/**
 * The Tenancy 2b-4b renderers for WEBSITE REPORTS: the SEARCH CHECK
 * (--seo-reports, @adminigloo/seo-reports 0.2) and AI MENTIONS (--aeo,
 * @adminigloo/aeo 0.2), each per company:
 *
 *   src/server/search-check.ts           the glue: which addresses a check
 *                                        reads (the company's own websites
 *                                        from the analytics register and its
 *                                        pages here), its plan's checks a
 *                                        month, and every handler's builder
 *   src/server/ai-mentions.ts            the glue: the answer engine (Claude
 *                                        Haiku 4.5 with web search, with --ai),
 *                                        its metering on @adminigloo/ai's
 *                                        ledger, and every handler's builder
 *   app/api/cron/search-check/route.ts   the daily job: each address checked
 *   app/api/cron/ai-mentions/route.ts    once a week, inside a time budget
 *   app/(site)/app/website/page.tsx      a company's Website screen, written
 *                                        with the sections it has (visits,
 *                                        Search check, AI mentions)
 *
 * Who reads what:
 *
 *   each company's own   /app/website over /api/app/{id}/search-check and
 *                        /api/app/{id}/ai-mentions — the id in the PATH,
 *                        asked on every call; another company's report or
 *                        question is "not found"
 *   this site's own      /admin/seo and /admin/aeo over /api/admin/… on staff
 *                        keys — "*"
 *
 * In its own module because emit.ts is long enough already. No emitted `if`
 * asks about an answer: each file is written per mode and per feature set;
 * the `if`s that ARE emitted are about runtime data (a key that isn't set, a
 * price missing from the rate table, a permission the person holds).
 */

import { tenantLabel, type Answers } from "./answers.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** Does AI mentions have an engine to ask (aeo + ai)? */
export function aiMentionsChecks(answers: Answers): boolean {
  return answers.includeAeo && answers.includeAi;
}

/** "Search checks a month" is sold only where plans are enforced and checks exist. */
export function siteChecksQuota(answers: Answers): boolean {
  return plansEnforced(answers) && answers.includeSeoReports;
}

/** "AI mention checks a month" is sold only where plans are enforced and checks can run (they need --ai). */
export function aiMentionChecksQuota(answers: Answers): boolean {
  return plansEnforced(answers) && aiMentionsChecks(answers);
}

/** Does a companies project write the Website screen (/app/website)? */
export function hasCompanyWebsitePage(answers: Answers): boolean {
  return companiesMode(answers) && (answers.includeAnalytics || answers.includeSeoReports || answers.includeAeo);
}

/** The permission that opens /app/website: the first section's. */
export function websitePagePermission(answers: Answers): string {
  return answers.includeAnalytics ? "analytics.view" : answers.includeSeoReports ? "seo_reports.view" : "aeo.view";
}

// ---------------------------------------------------------------------------
// src/server/search-check.ts
// ---------------------------------------------------------------------------

export function renderSearchCheckGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const analytics = answers.includeAnalytics;
  const imports = [
    `import { createSeoReportsHandlers, type CheckTarget, type CreateSeoReportsHandlersOptions, type SeoReportsPermission } from "${scope}/seo-reports";`,
    ...(companies ? [`import { runForEachCompany } from "${scope}/tenancy/server";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(companies ? [`import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(companies ? [`import { companyPlanOpen, siteCheckLimit } from "@/server/plan-gate";`] : []),
    `import { failClosedLimiter } from "@/server/rate-limit";`,
    `import { authorizeStaffFor } from "@/server/staff-access";`,
    ...(companies ? [`import { tenancy } from "@/server/tenancy";`] : []),
    ...(analytics ? [`import { analytics, SITE_ANALYTICS } from "@/server/website";`] : []),
  ];

  const websites = analytics
    ? `
/**
 * A ${companies ? `${noun}'s` : "business's"} own websites, from the analytics register (/app/website's
 * list), each checked at its first address — but ONLY once the register has
 * counted a visit from it: the line that counts visits is on that site, which
 * shows the site is really theirs. Until then it waits, and the screen says
 * why. A website it removed is no longer read.
 */
async function websitesOf(tenantId: string): Promise<CheckTarget[]> {
  const [list, visits] = await Promise.all([analytics.listWebsites(tenantId), analytics.lastVisits(tenantId)]);
  return list
    .filter((website) => website.domains.length > 0)
    .map((website) => ({
      label: \`your website “\${website.name}”\`,
      baseUrl: \`https://\${website.domains[0]}\`,
      ...(visits.has(website.id) ? {} : { pending: "We'll check this site once your visits line is working." }),
    }));
}
`
    : `
/**
 * No website register in this project (it was generated without --analytics),
 * so a check reads ${companies ? `a ${noun}'s pages here` : "this site's own pages"} only. \`create-app add analytics\` adds
 * websites of their own.
 */
async function websitesOf(_tenantId: string): Promise<CheckTarget[]> {
  return [];
}
`;

  const company = companies
    ? `
/**
 * WHAT A ${noun.toUpperCase()}'S CHECK READS: its pages here (/t/{its web address}, and
 * only those — a neighbour's pages on the same site are never read) and its
 * own websites. Nothing from the request: an address a person typed into a
 * check would be an address the server fetches for them.
 */
async function companyAddresses(tenantId: string): Promise<CheckTarget[]> {
  const profile = await tenancy.companyProfile(tenantId);
  const base = env.NEXT_PUBLIC_APP_URL ?? null;
  return [
    ...(base && profile ? [{ label: \`Your pages on \${SITE_NAME}\`, baseUrl: base, pathPrefix: \`/t/\${profile.slug}\` }] : []),
    ...(await websitesOf(tenantId)),
  ];
}

function companyOptions(overrides: FeatureHandlerOverrides & SearchCheckOverrides): CreateSeoReportsHandlersOptions {
  return {
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    addresses: companyAddresses,
    // Its plan's Check now presses a month (src/plans.ts); the package's 20 when the plan doesn't say. The weekly check is free.
    monthlyLimit: (tenantId) => siteCheckLimit(tenantId),
    automatic: true,
    // A closed plan reads its old reports and checks nothing new.
    admit: (tenantId) => companyPlanOpen(tenantId),
    rateLimit: searchCheckRateLimit,
    ...(overrides.network ? { network: overrides.network } : {}),
    onError: reportSearchCheckError,
  };
}

/**
 * A ${noun}'s search check, for its own people (/app/website over
 * /api/app/{${noun} id}/search-check): seo_reports.view to read, seo_reports.run
 * to press Check now. \`overrides\` is how the project's isolation proof calls
 * it as somebody else, on a stand-in network.
 */
export function buildSearchCheckHandlers(overrides: FeatureHandlerOverrides & SearchCheckOverrides = {}) {
  return createSeoReportsHandlers(companyOptions(overrides));
}
`
    : "";

  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/seo-reports — THE SEARCH CHECK (Tenancy 2b-4b):
 * how Google, Bing and AI assistants read ${companies ? `each ${noun}'s own website and pages, for
 * that ${noun} (its reports are its own; another ${noun}'s is "not found"), and` : ""}
 * this site's own pages${companies ? "" : " (one business: the site's own, \"*\")"}, for its staff at /admin/seo.
 *
 * EVERY REQUEST A CHECK MAKES GOES THROUGH THE PACKAGE'S SAFE FETCHER: only
 * the addresses below, never a private or cloud-internal address (a name that
 * resolves to one is refused), every redirect re-checked, 50 pages, 2 MB a
 * page and 45 seconds a check at most.
 */

/** THIS SITE'S OWN checks: "*"${companies ? `, which can never be a ${noun} id (those are UUIDs)` : ""}. */
export const SITE_CHECKS = "*";

/** What a test swaps: the network (the project's own tests never fetch a real page). */
export interface SearchCheckOverrides {
  readonly network?: CreateSeoReportsHandlersOptions["network"];
}

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportSearchCheckError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "search-check", route: context.route } });
}

/**
 * How often Check now may be pressed: three times in ten minutes per ${companies ? noun : "site"}, on
 * the shared limiter, failing closed — each check fetches up to 50 pages.
 */
const SEARCH_CHECK_POLICY = { limit: 3, windowMs: 10 * 60_000 } as const;

async function searchCheckRateLimit({ tenantId }: { tenantId: string }): Promise<true | string> {
  const verdict = await failClosedLimiter.limit({ key: \`search-check:\${tenantId}\`, policy: SEARCH_CHECK_POLICY });
  return verdict.allowed ? true : "Checks were run a few times just now. Try again in a few minutes.";
}
${websites}
/** THIS SITE'S OWN addresses: its public address (NEXT_PUBLIC_APP_URL)${analytics ? " and any website it registered" : ""}. */
async function siteAddresses(): Promise<CheckTarget[]> {
  const base = env.NEXT_PUBLIC_APP_URL ?? null;
  return [...(base ? [{ label: \`\${SITE_NAME}'s own pages\`, baseUrl: base }] : []), ...(await websitesOf(${analytics ? "SITE_ANALYTICS" : "SITE_CHECKS"}))];
}

/**
 * THE staff keys this site's own checks are asked against (both modes):
 *
 *   staff.seo_reports.view   the reports and their worklists
 *   staff.seo_reports.run    Check now
 */
export const SEARCH_CHECK_STAFF_KEYS: Readonly<Record<SeoReportsPermission, string>> = {
  "seo_reports.view": "staff.seo_reports.view",
  "seo_reports.run": "staff.seo_reports.run",
};

function platformOptions(overrides: SearchCheckOverrides): CreateSeoReportsHandlersOptions {
  return {
    db,
    tenantId: SITE_CHECKS,
    authorize: authorizeStaffFor(SEARCH_CHECK_STAFF_KEYS, "Sign in to see this site's search checks."),
    addresses: () => siteAddresses(),
    rateLimit: searchCheckRateLimit,
    automatic: true,
    ...(overrides.network ? { network: overrides.network } : {}),
    onError: reportSearchCheckError,
  };
}

/** THIS SITE'S OWN search check, for its staff (/admin/seo over /api/admin/search-check). */
export function buildPlatformSearchCheckHandlers(overrides: SearchCheckOverrides = {}) {
  return createSeoReportsHandlers(platformOptions(overrides));
}
${company}
/**
 * THE DAILY JOB'S CLOCK. The route has 60 seconds (maxDuration); the run ends
 * by 50, timed from the moment it starts — this site's own check included.
 * One check is started only while a whole check (CRON_CHECK_MS) and a margin
 * still fit before that end, and each is given only the time left, so the
 * last one can't run past it.
 */
const CRON_BUDGET_MS = 50_000;
const CRON_CHECK_MS = 20_000;
const CRON_MARGIN_MS = 3_000;

/**
 * The daily job (app/api/cron/search-check): every address checked about once
 * a week, free — this site's own${companies ? `, then each active ${noun} whose last check is a week
 * old (the starting ${noun} differs every run; one ${noun}'s failure doesn't stop the
 * rest; a closed plan is skipped)` : ""}. What doesn't fit today goes first another day.
 */
export async function runDailySearchChecks() {
  const deadline = Date.now() + CRON_BUDGET_MS;
  const left = () => deadline - Date.now() - CRON_MARGIN_MS;
  const narrow = () => ({ totalTimeMs: Math.max(1_000, Math.min(CRON_CHECK_MS, left())) });
  const site = left() >= CRON_CHECK_MS ? await createSeoReportsHandlers(platformOptions({})).runScheduled(SITE_CHECKS, narrow()) : { ran: false, reason: "out_of_time" };${
    companies
      ? `
  const handlers = createSeoReportsHandlers(companyOptions({}));
  const companies = await runForEachCompany(tenancy, (tenantId) => handlers.runScheduled(tenantId, narrow()), {
    // Stop starting checks once a whole one no longer fits before the end.
    timeBudgetMs: Math.max(0, left() - CRON_CHECK_MS),
    concurrency: 2,
    onError: (error, tenantId) => reportSearchCheckError(error, { tenantId, route: "cron" }),
  });
  return { site, companies: { ran: companies.ran.length, failed: companies.failed.length, waiting: companies.deferred.length } };`
      : `
  return { site };`
  }
}
`;
}

// ---------------------------------------------------------------------------
// src/server/ai-mentions.ts
// ---------------------------------------------------------------------------

export function renderAiMentionsGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const checks = aiMentionsChecks(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const imports = [
    `import { createAeoHandlers, type AeoPermission, type AnswerEngine, type CreateAeoHandlersOptions${checks ? ", type MentionSpend" : ""} } from "${scope}/aeo";`,
    ...(checks
      ? [
          `import { createAnthropicAnswerEngine, DEFAULT_AEO_MODEL } from "${scope}/aeo/anthropic";`,
          `import { checkAiAllowance, releaseAiReservation, reserveAiAllowance, settleAiReservation, sweepStaleReservations, type AiAllowanceUsage } from "${scope}/ai/server";`,
        ]
      : []),
    ...(companies ? [`import { runForEachCompany } from "${scope}/tenancy/server";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(checks ? [`import { AI_SITE_DAILY_CENTS, alertSiteCeiling, anthropic, MODEL_RATES } from "@/server/ai";`] : []),
    ...(companies ? [`import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(checks ? [`import { log } from "@/server/logger";`] : []),
    ...(companies ? [`import { ${checks ? "aiMentionCheckLimit, " : ""}aiQuestionLimit, companyPlanOpen } from "@/server/plan-gate";`] : []),
    `import { failClosedLimiter } from "@/server/rate-limit";`,
    `import { authorizeStaffFor } from "@/server/staff-access";`,
    ...(companies ? [`import { tenancy } from "@/server/tenancy";`] : []),
  ];

  const engine = checks
    ? `
/**
 * The model the checks ask: Claude Haiku 4.5 with web search — the founder's
 * rule, the cheapest model that does the job. Its price must be in MODEL_RATES
 * (src/server/ai.ts): an unpriced model couldn't be metered, so checking stays
 * off and the server log says why.
 */
export const AI_MENTIONS_MODEL: string = DEFAULT_AEO_MODEL;

/**
 * THE MONTH'S CHECKS — one answer to one question is one check${companies && plansEnforced(answers) ? `, unless the
 * ${noun}'s plan sets its own (src/plans.ts, "AI mention checks a month")` : ""}. Each
 * tracked question is asked about once a week (4–5 times a month), so 10
 * questions use about 44 automatically; the rest is room for Check now.
 */
export const AI_MENTION_MONTHLY_CHECKS = 60;
/** The questions a ${companies ? noun : "business"} may track${companies && plansEnforced(answers) ? " (its plan's, src/plans.ts \"questions tracked by AI mentions\")" : ""}. */
export const AI_MENTION_QUESTIONS = 10;

/**
 * THE MOST ONE CHECK CAN COST — held before it's asked, settled at what the
 * provider reports. A conservative ceiling (the arithmetic is in
 * ${scope}/aeo/anthropic): 2 web searches, and every step re-reading the
 * searches before it, at 25,000 tokens of results a search — about 79,500
 * tokens in (8¢), 3,072 out (1.5¢) and 2 searches (2¢): ≈ 11.5¢. Measured
 * checks cost far less; /admin/aeo shows the real average.
 *
 * So the month's cents cap is 12¢ × its checks — the count is what limits the
 * month — and unlimited checks still stop at AI_MENTION_UNLIMITED_CENTS ($20).
 */
export const AI_MENTION_WORST_CASE_CENTS = 12;
export const AI_MENTION_UNLIMITED_CENTS = 2_000;

/** One ${companies ? noun : "account"}'s share of the site's day: a quarter of AI_SITE_DAILY_CENTS, so nobody spends it all. */
export const AI_MENTION_DAILY_SHARE_CENTS = Math.max(1, Math.floor(AI_SITE_DAILY_CENTS / 4));

/**
 * AI MENTIONS' OWN DAY, across every ${companies ? noun : "account"}: at most $1.50 and never more
 * than half of AI_SITE_DAILY_CENTS — so these checks can never use up the
 * site's day and switch off the assistant or the estimator's photo reading.
 */
export const AI_MENTIONS_DAILY_CENTS = Math.max(1, Math.min(150, Math.floor(AI_SITE_DAILY_CENTS / 2)));

/** What each check is counted as in ai_usage. */
const OPERATION = "aeo_check";

/** The engine, or null: no ANTHROPIC_API_KEY, or a model with no price (fail closed: an unmetered call is never made). */
export function aiMentionsEngine(): AnswerEngine | null {
  if (!anthropic) return null;
  const rate = MODEL_RATES[AI_MENTIONS_MODEL];
  if (!rate) {
    log.error({ model: AI_MENTIONS_MODEL }, "ai mentions: checking is off — MODEL_RATES in src/server/ai.ts has no price for this model");
    return null;
  }
  return createAnthropicAnswerEngine({ client: anthropic, model: AI_MENTIONS_MODEL, rate });
}

/** The checks a month for this ${companies ? noun : "site"}${companies ? ": its plan's, else the project's own" : ""}. */
async function monthlyChecksOf(${companies ? "tenantId" : "_tenantId"}: string): Promise<number | null> {${
        companies
          ? `
  if (tenantId === SITE_MENTIONS) return AI_MENTION_MONTHLY_CHECKS;
  const planned = await aiMentionCheckLimit(tenantId);
  return planned === undefined ? AI_MENTION_MONTHLY_CHECKS : planned;`
          : `
  return AI_MENTION_MONTHLY_CHECKS;`
      }
}

function resetsOn(usage: AiAllowanceUsage | null): string {
  return (usage?.resetsAt ?? new Date()).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Every limit a check is held against, in AI mentions' own words. */
async function allowanceInput(tenantId: string) {
  const checks = await monthlyChecksOf(tenantId);
  return {
    tenantId,
    operations: [OPERATION],
    allowance: {
      monthlyMessages: checks,
      monthlyCents: checks === null ? AI_MENTION_UNLIMITED_CENTS : checks * AI_MENTION_WORST_CASE_CENTS,
      dailyCents: AI_MENTION_DAILY_SHARE_CENTS,
    },
    operationsDailyCents: AI_MENTIONS_DAILY_CENTS,
    siteDailyCents: AI_SITE_DAILY_CENTS,
    onSiteCeiling: alertSiteCeiling,
    words: {
      company_messages: (usage: AiAllowanceUsage | null) =>
        \`This month's AI mention checks are used up\${usage?.messageLimit != null ? \` (\${usage.messageLimit})\` : ""}. They start again on \${resetsOn(usage)}.\`,
      company_spend: (usage: AiAllowanceUsage | null) => \`This month's AI mention checks reached their spending limit. They start again on \${resetsOn(usage)}.\`,
      company_day: () => "Today's share of this site's AI is used up. Checks start again at midnight UTC.",
      feature_day: () => "AI mentions has used today's share of this site's AI. Checks start again at midnight UTC.",
      unavailable: () => "The checks can't confirm their allowance right now, so nothing was asked. Try again in a minute.",
    },
  };
}

/** Is the month (or the day) used up? null while there's room — read only, so the screen and the weekly job hold nothing. */
export async function aiMentionsAllowanceNotice(tenantId: string): Promise<string | null> {
  const verdict = await checkAiAllowance(db, await allowanceInput(tenantId));
  return verdict.ok ? null : verdict.message;
}

/**
 * EVERY CHECK IS METERED on @adminigloo/ai's ledger, as operation "aeo_check":
 * held before it's asked (inside one lock, so checks pressed at once see each
 * other), settled after with the PROVIDER's counts — tokens priced from
 * MODEL_RATES, web searches at $10 per 1,000 — never the model's word, never
 * left free. The month, the ${companies ? noun : "account"}'s share of the day, AI mentions' own day
 * (AI_MENTIONS_DAILY_CENTS) and the site's daily ceiling (AI_SITE_DAILY_CENTS)
 * all apply. A call stopped at its time limit is released, not charged; a
 * hold a dead process left is swept by the daily job.
 */
export const aiMentionsSpend: MentionSpend = {
  async reserve({ tenantId, userId, model, reserveMicros }) {
    const verdict = await reserveAiAllowance(db, {
      ...(await allowanceInput(tenantId)),
      userId,
      operation: OPERATION,
      model,
      reserveMicros,
    });
    return verdict.ok ? { ok: true, reservationId: verdict.reservationId } : { ok: false, message: verdict.message };
  },
  async settle(reservationId, outcome) {
    const usage = outcome.usage
      ? {
          model: outcome.usage.model,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          cachedInputTokens: outcome.usage.cachedInputTokens,
          cachedWriteTokens: outcome.usage.cachedWriteTokens,
          reported: outcome.usage.reported,
          feesMicros: outcome.usage.feesMicros,
        }
      : null;
    const settled = await settleAiReservation(db, MODEL_RATES, reservationId, { usage, status: outcome.status, latencyMs: outcome.latencyMs }, {
      onError: (error) => log.error({ err: error instanceof Error ? error.message : String(error) }, "ai mentions: a check's AI use couldn't be recorded"),
    });
    return { costMicros: settled.costMicros };
  },
  release: (reservationId) => releaseAiReservation(db, reservationId),
};
`
    : `
/** The questions a ${companies ? noun : "business"} may track (kept, but not asked, without AI). */
export const AI_MENTION_QUESTIONS = 10;

/**
 * The engine: none. ${answers.projectName} was generated without --ai, so the
 * questions and who the business is can be kept, and Check now says checking
 * isn't switched on. \`create-app add ai\` wires Claude Haiku 4.5 with web
 * search, metered against each ${companies ? noun : "account"}'s month.
 */
export function aiMentionsEngine(): AnswerEngine | null {
  return null;
}
`;

  const overrides = checks
    ? `
/** What a test swaps: the engine (the project's own tests never call a real one). */
export interface AiMentionsOverrides {
  readonly engine?: AnswerEngine | null;
}
`
    : `
/** What a test swaps: nothing here (no engine to swap). */
export type AiMentionsOverrides = Record<never, never>;
`;

  const engineExpr = checks ? "overrides.engine !== undefined ? overrides.engine : aiMentionsEngine()" : "aiMentionsEngine()";
  const spendLine = checks ? "\n    spend: aiMentionsSpend," : "";

  const company = companies
    ? `
function companyOptions(overrides: FeatureHandlerOverrides & AiMentionsOverrides): CreateAeoHandlersOptions {${checks ? "" : "\n  void overrides;"}
  return {
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    engine: ${engineExpr},${spendLine}
    offMessage: OFF_MESSAGE,
    // A closed plan keeps its questions and answers, and asks nothing new.
    admit: (tenantId) => companyPlanOpen(tenantId),
    rateLimit: aiMentionsRateLimit,
    // Its plan's questions (src/plans.ts), else the project's own.
    questionLimit: async (tenantId) => (await aiQuestionLimit(tenantId)) ?? AI_MENTION_QUESTIONS,${checks ? `
    allowanceNotice: aiMentionsAllowanceNotice,
    automatic: true,` : ""}
    // Before it says who it is: its ${noun} name, as the form's starting point.
    suggestedProfile: async (tenantId) => {
      const profile = await tenancy.companyProfile(tenantId);
      return profile ? { brand: profile.name, domain: null } : null;
    },
    onError: reportAiMentionsError,
  };
}

/**
 * A ${noun}'s AI mentions, for its own people (/app/website over
 * /api/app/{${noun} id}/ai-mentions): aeo.view to read, aeo.manage for its
 * questions, who it is, and Check now. Another ${noun}'s question is "not
 * found". \`overrides\` is how the project's isolation proof calls it as
 * somebody else${checks ? ", with a scripted engine" : ""}.
 */
export function buildAiMentionsHandlers(overrides: FeatureHandlerOverrides & AiMentionsOverrides = {}) {
  return createAeoHandlers(companyOptions(overrides));
}
`
    : "";

  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/aeo — AI MENTIONS (Tenancy 2b-4b): for the
 * questions customers ask an AI assistant ("wheelchair ramp rental Raleigh"),
 * does the answer name the business? ${companies ? `Each ${noun} keeps its own questions,
 * who it is and its answers (another ${noun}'s question is "not found"), and` : "One business:"}
 * this site keeps its own ("*") for its staff at /admin/aeo.
 *
 * THE MODEL ONLY ANSWERS. Whether the business was named, which source was
 * its own, and which competitors came up are worked out in code
 * (${scope}/aeo's analyzeAnswer) from the text and the cited addresses; what
 * the model found on the web is never treated as an instruction.
 */

/** THIS SITE'S OWN questions: "*"${companies ? `, which can never be a ${noun} id` : ""}. */
export const SITE_MENTIONS = "*";

/** What Check now says while there's no engine (no key, or no price for the model). */
const OFF_MESSAGE = "Checking AI answers isn't switched on here yet.";
${engine}${overrides}
/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportAiMentionsError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "ai-mentions", route: context.route } });
}

/**
 * How often Check now may be pressed: twice in ten minutes per person and six
 * times an hour per ${companies ? noun : "site"} — each press asks every question, and each
 * answer is paid for. On the shared limiter, failing closed.
 */
const AI_MENTIONS_PERSON_POLICY = { limit: 2, windowMs: 10 * 60_000 } as const;
const AI_MENTIONS_COMPANY_POLICY = { limit: 6, windowMs: 60 * 60_000 } as const;

async function aiMentionsRateLimit({ tenantId, userId }: { tenantId: string; userId: string | null }): Promise<true | string> {
  const person = await failClosedLimiter.limit({ key: \`ai-mentions:person:\${tenantId}:\${userId ?? "unknown"}\`, policy: AI_MENTIONS_PERSON_POLICY });
  if (!person.allowed) return "You've checked twice in the last few minutes. Give it ten minutes.";
  const company = await failClosedLimiter.limit({ key: \`ai-mentions:company:\${tenantId}\`, policy: AI_MENTIONS_COMPANY_POLICY });
  return company.allowed ? true : "Your team has checked several times this hour. Try again later.";
}

/**
 * THE staff keys this site's own AI mentions are asked against (both modes):
 *
 *   staff.aeo.view     the questions, the answers, the trend
 *   staff.aeo.manage   the questions, who the site is, Check now
 */
export const AEO_STAFF_KEYS: Readonly<Record<AeoPermission, string>> = {
  "aeo.view": "staff.aeo.view",
  "aeo.manage": "staff.aeo.manage",
};

/** This site's own host, for the form's starting point. */
function siteDomain(): string | null {
  try {
    return env.NEXT_PUBLIC_APP_URL ? new URL(env.NEXT_PUBLIC_APP_URL).hostname : null;
  } catch {
    return null;
  }
}

function platformOptions(overrides: AiMentionsOverrides): CreateAeoHandlersOptions {${checks ? "" : "\n  void overrides;"}
  return {
    db,
    tenantId: SITE_MENTIONS,
    authorize: authorizeStaffFor(AEO_STAFF_KEYS, "Sign in to see this site's AI mentions."),
    engine: ${engineExpr},${spendLine}
    offMessage: OFF_MESSAGE,
    rateLimit: aiMentionsRateLimit,
    questionLimit: () => AI_MENTION_QUESTIONS,${checks ? `
    allowanceNotice: aiMentionsAllowanceNotice,
    automatic: true,` : ""}
    suggestedProfile: () => ({ brand: SITE_NAME, domain: siteDomain() }),
    onError: reportAiMentionsError,
  };
}

/** THIS SITE'S OWN AI mentions, for its staff (/admin/aeo over /api/admin/ai-mentions). */
export function buildPlatformAiMentionsHandlers(overrides: AiMentionsOverrides = {}) {
  return createAeoHandlers(platformOptions(overrides));
}
${company}
/**
 * THE DAILY JOB'S CLOCK. The route has 60 seconds (maxDuration); the run ends
 * by 50, timed from the moment it starts — this site's own questions
 * included. A ${companies ? noun : "run"} is started only while one call (CRON_CALL_MS) and a
 * margin still fit, and is given only the time left; inside it, a call starts
 * only when its whole time limit fits, and one stopped at its limit is
 * released, not charged.
 */
const CRON_BUDGET_MS = 50_000;
const CRON_CALL_MS = 15_000;
const CRON_MARGIN_MS = 3_000;

/**
 * The daily job (app/api/cron/ai-mentions): each question asked again once a
 * week — this site's own${companies ? `, then each active ${noun}'s (the starting ${noun} differs
 * every run; a closed plan, or a month used up, asks nothing)` : ""}. What doesn't
 * fit today waits for tomorrow.${checks ? " First, holds a dead process left behind are released." : ""}
 */
export async function runDailyAiMentions() {
  const deadline = Date.now() + CRON_BUDGET_MS;
  const left = () => deadline - Date.now() - CRON_MARGIN_MS;
  const timing = () => ({ budgetMs: Math.max(1_000, Math.min(20_000, left())), callTimeoutMs: CRON_CALL_MS });${
    checks
      ? `
  const swept = await sweepStaleReservations(db, { operations: [OPERATION], olderThanMs: 10 * 60_000 });`
      : ""
  }
  const site = left() >= CRON_CALL_MS + CRON_MARGIN_MS ? await createAeoHandlers({ ...platformOptions({}), ...timing() }).runScheduled(SITE_MENTIONS) : { ran: false, reason: "out_of_time" };${
    companies
      ? `
  const companies = await runForEachCompany(tenancy, (tenantId) => createAeoHandlers({ ...companyOptions({}), ...timing() }).runScheduled(tenantId), {
    // Stop starting ${noun}s once one call and a margin no longer fit before the end.
    timeBudgetMs: Math.max(0, left() - CRON_CALL_MS - CRON_MARGIN_MS),
    concurrency: 2,
    onError: (error, tenantId) => reportAiMentionsError(error, { tenantId, route: "cron" }),
  });
  return { site, companies: { ran: companies.ran.length, failed: companies.failed.length, waiting: companies.deferred.length }${checks ? ", swept" : ""} };`
      : `
  return { site${checks ? ", swept" : ""} };`
  }
}
`;
}

// ---------------------------------------------------------------------------
// The two daily jobs' routes
// ---------------------------------------------------------------------------

function cronRoute(what: { readonly title: string; readonly fn: string; readonly module: string; readonly body: string }): string {
  return `import { NextResponse } from "next/server";
import { env } from "@/env";
import { log } from "@/server/logger";
import { ${what.fn} } from "${what.module}";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * ${what.title}
 *
${what.body}
 *
 * SCHEDULED IN vercel.json (daily; each one weekly); refuses every call while
 * CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await ${what.fn}();
  log.info({ result }, "${what.module.replace("@/server/", "")} cron: ran");
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
`;
}

export function renderSearchCheckCron(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return cronRoute({
    title: "The daily search check (Tenancy 2b-4b):",
    fn: "runDailySearchChecks",
    module: "@/server/search-check",
    body: ` * this site's own pages${companies ? ` and each active ${noun}'s, each checked again when its
 * last check is a week old (a closed plan, or a month's checks used up, is
 * skipped)` : ", checked again when the last check is a week old"}. Every page through the package's safe fetcher.`,
  });
}

export function renderAiMentionsCron(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return cronRoute({
    title: "The daily AI mentions check (Tenancy 2b-4b):",
    fn: "runDailyAiMentions",
    module: "@/server/ai-mentions",
    body: ` * each question this site${companies ? ` and each active ${noun}` : ""} tracks, asked again when its last
 * answer is a week old — each one held against the month's AI before it's
 * asked, and settled after. Nothing is asked for a closed plan.`,
  });
}

// ---------------------------------------------------------------------------
// app/(site)/app/website/page.tsx — a company's Website screen (companies)
// ---------------------------------------------------------------------------

export function renderCompanyWebsitePage(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const visits = answers.includeAnalytics;
  const search = answers.includeSeoReports;
  const mentions = answers.includeAeo;
  const imports = [
    `import { CompanyGate } from "@/components/CompanyGate";`,
    `import { PageHeader } from "@/components/ui";`,
    ...(mentions ? [`import { AiMentionsSection } from "@/components/AiMentionsSection";`] : []),
    ...(search ? [`import { SearchCheckSection } from "@/components/SearchCheckSection";`] : []),
    ...(visits ? [`import { WebsitePage } from "@/components/WebsitePage";`] : []),
  ];
  const parts = [
    ...(visits ? ["who visits it and where they came from (your team's visits are left out; nothing here uses cookies)"] : []),
    ...(search ? ["how search engines and AI assistants read it, as a list of things to fix"] : []),
    ...(mentions ? ["whether AI assistants name you when customers ask them"] : []),
  ];
  const sentence = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
  const sections = [
    ...(visits
      ? [
          `          <WebsitePage
            baseUrl={\`/api/app/\${company.id}/website\`}
            audienceBaseUrl={can.includes("audience.manage") ? \`/api/app/\${company.id}/audience\` : null}
          />`,
        ]
      : []),
    ...(search ? [`          {can.includes("seo_reports.view") ? <SearchCheckSection baseUrl={\`/api/app/\${company.id}/search-check\`} /> : null}`] : []),
    ...(mentions ? [`          {can.includes("aeo.view") ? <AiMentionsSection baseUrl={\`/api/app/\${company.id}/ai-mentions\`} /> : null}`] : []),
  ];
  return `${imports.join("\n")}

export const dynamic = "force-dynamic";

/**
 * The ${noun}'s Website screen (Tenancy 2b-4a, 2b-4b): ${sentence}.
 *
 * ${[visits && `${scope}/analytics' and /audience's screens`, search && `${scope}/seo-reports' Search check`, mentions && `${scope}/aeo's AI mentions`].filter(Boolean).join(", ")}, each talking to THIS ${noun}'s routes
 * (/api/app/{id}/…), which check the person's permission on every call. A
 * section the person may not see isn't offered (a runtime permission, not a
 * feature switch). GENERATED with the sections this project has.
 */
export default async function CompanyWebsitePage() {
  return (
    <CompanyGate path="/app/website" permission="${websitePagePermission(answers)}">
      {({ company, can }) => (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Website"
            description={\`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} — for \${company.name}.\`}
          />
          <div className="flex flex-col gap-10">
${sections.join("\n")}
          </div>
        </main>
      )}
    </CompanyGate>
  );
}
`;
}
