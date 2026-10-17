/**
 * TENANCY 2b-4b, AS THE GENERATOR WRITES IT (create-app 0.31): the search
 * check (--seo-reports) and AI mentions (--aeo) per company. Read from the
 * PLAN as text; the generated project's own suite (the isolation proof on
 * PGlite) runs the routes.
 *
 *   - companies mode: the two sections on /app/website, the company routes
 *     through the seams, the company keys, the plan's checks, the proof;
 *   - this site's own at /admin/seo and /admin/aeo on staff keys, both modes;
 *   - with --ai the checks are asked and metered; without, never asked;
 *   - the tRPC seo and aeo routers are gone; no emitted `if` about an answer.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, DEFAULT_ANSWERS, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { packageVersions, planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-reports", ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

function has(p: EmitPlan, ...segments: string[]): boolean {
  return p.files.has(join(...segments));
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const REPORTS: Partial<Answers> = { includeSeoReports: true, includeAeo: true };
const COMPANIES: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", ...REPORTS };
const SELLS: Partial<Answers> = { businessModel: "subscription" };
const AI: Partial<Answers> = { includeAi: true };
const SINGLE: Partial<Answers> = { tenantNoun: "none", adminShell: "full", ...REPORTS };

describe("packages, overlays, versions and capabilities", () => {
  it("installs seo-reports 0.2 and aeo 0.2 (and ai 0.3), and the overlays by their conditions", () => {
    expect(packagesFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["@adminigloo/seo-reports", "@adminigloo/aeo"]));
    const versions = packageVersions();
    expect([versions["seo-reports"], versions.aeo, versions.ai]).toEqual(["0.2.0", "0.2.0", "0.3.0"]);
    expect(overlayNamesFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["seo-reports", "seo-admin", "seo-reports-companies", "aeo", "aeo-admin", "aeo-companies"]));
    expect(overlayNamesFor(answers(SINGLE))).not.toContain("seo-reports-companies");
    expect(overlayNamesFor(answers(SINGLE))).not.toContain("aeo-companies");
    expect(overlayNamesFor(answers({ ...COMPANIES, adminShell: "none" }))).not.toContain("seo-admin");
  });

  it("claims what it emits", () => {
    expect(capabilitiesFor(answers({ ...COMPANIES, ...AI }))).toEqual(
      expect.arrayContaining(["seo.audits", "seo.reports", "seo.search-check-companies", "aeo.citations", "aeo.dashboard", "aeo.companies", "aeo.metered-checks"]),
    );
    expect(capabilitiesFor(answers(COMPANIES))).not.toContain("aeo.metered-checks");
    expect(capabilitiesFor(answers(SINGLE))).not.toContain("aeo.companies");
    expect(capabilitiesFor(answers(SINGLE))).not.toContain("seo.search-check-companies");
  });
});

describe("companies mode", () => {
  it("each company's search check: its routes through the seams, its own addresses, its plan's checks, a closed plan's gate", async () => {
    const p = await plan({ ...COMPANIES, ...SELLS, includeAnalytics: true });
    const glue = code(file(p, "src", "server", "search-check.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("monthlyLimit: (tenantId) => siteCheckLimit(tenantId)");
    expect(glue).toContain("admit: (tenantId) => companyPlanOpen(tenantId)");
    expect(glue).toContain("pathPrefix: `/t/${profile.slug}`");
    expect(glue).toContain("analytics.listWebsites(tenantId)");
    expect(glue).toContain("runForEachCompany(tenancy");
    expect(glue).not.toContain('"primary"');
    expect(has(p, "app", "api", "app", "[tenantId]", "search-check", "[...path]", "route.ts")).toBe(true);
    expect(has(p, "app", "api", "admin", "search-check", "[...path]", "route.ts")).toBe(true);
    expect(file(p, "src", "plans.ts")).toContain("site_checks:");
    expect(file(p, "src", "server", "plan-gate.ts")).toContain('planLimit(tenantId, "site_checks")');
    expect(file(p, "src", "server", "plan-gate.ts")).toContain("export async function companyPlanOpen(");
  });

  it("each company's AI mentions: metered on the ledger with --ai, its plan's checks, rate limited", async () => {
    const p = await plan({ ...COMPANIES, ...SELLS, ...AI });
    const glue = code(file(p, "src", "server", "ai-mentions.ts"));
    expect(glue).toContain("createAnthropicAnswerEngine({ client: anthropic, model: AI_MENTIONS_MODEL, rate })");
    expect(glue).toContain("reserveAiAllowance(db, {");
    expect(glue).toContain("settleAiReservation(db, MODEL_RATES, reservationId");
    expect(glue).toContain("feesMicros: outcome.usage.feesMicros");
    expect(glue).toContain("siteDailyCents: AI_SITE_DAILY_CENTS");
    expect(glue).toContain("aiMentionCheckLimit(tenantId)");
    expect(glue).toContain("admit: (tenantId) => companyPlanOpen(tenantId)");
    expect(glue).toContain("rateLimit: aiMentionsRateLimit");
    expect(has(p, "app", "api", "app", "[tenantId]", "ai-mentions", "[...path]", "route.ts")).toBe(true);
    expect(file(p, "src", "plans.ts")).toContain("ai_mention_checks:");
    expect(file(p, "src", "server", "plan-gate.ts")).toContain('planLimit(tenantId, "ai_mention_checks")');
    // Review M2/M3: questions are sold, a month covers them weekly, and AI mentions has its own day.
    expect(file(p, "src", "plans.ts")).toContain("ai_questions: 5,");
    expect(file(p, "src", "plans.ts")).toContain("ai_mention_checks: 40,");
    expect(file(p, "src", "server", "plan-gate.ts")).toContain('planLimit(tenantId, "ai_questions")');
    expect(glue).toContain("questionLimit: async (tenantId) => (await aiQuestionLimit(tenantId)) ?? AI_MENTION_QUESTIONS");
    expect(glue).toContain("operationsDailyCents: AI_MENTIONS_DAILY_CENTS");
    expect(glue).toContain("Math.min(150, Math.floor(AI_SITE_DAILY_CENTS / 2))");
    expect(glue).toContain("allowanceNotice: aiMentionsAllowanceNotice");
    // Review M1: the cron is timed from its start, and sweeps dead holds.
    expect(glue).toContain("const deadline = Date.now() + CRON_BUDGET_MS;");
    expect(glue).toContain("sweepStaleReservations(db, { operations: [OPERATION]");
  });

  it("the search check reads a website only once its visits line works, and its weekly check is free (review L4, M2)", async () => {
    const p = await plan({ ...COMPANIES, ...SELLS, includeAnalytics: true });
    const glue = code(file(p, "src", "server", "search-check.ts"));
    expect(glue).toContain("visits.has(website.id) ? {} : { pending: \"We'll check this site once your visits line is working.\" }");
    expect(glue).toContain("const deadline = Date.now() + CRON_BUDGET_MS;");
    expect(glue).toContain("timeBudgetMs: Math.max(0, left() - CRON_CHECK_MS)");
    expect(file(p, "src", "plans.ts")).toContain("a weekly search check is included");
  });

  it("without --ai: questions are kept, nothing is ever asked, and no plan sells AI checks", async () => {
    const p = await plan({ ...COMPANIES, ...SELLS });
    const glue = code(file(p, "src", "server", "ai-mentions.ts"));
    expect(glue).toContain("export function aiMentionsEngine(): AnswerEngine | null {\n  return null;\n}");
    expect(glue).not.toContain("@/server/ai");
    expect(glue).not.toContain("reserveAiAllowance");
    expect(file(p, "src", "plans.ts")).not.toContain("ai_mention_checks");
    expect(file(p, "src", "plans.ts")).toContain("site_checks:");
  });

  it("the Website screen is written with the sections the project has, each behind its permission", async () => {
    const both = file(await plan({ ...COMPANIES, includeAnalytics: true }), "app", "(site)", "app", "website", "page.tsx");
    expect(both).toContain('permission="analytics.view"');
    expect(both).toContain("<WebsitePage");
    expect(both).toContain('can.includes("seo_reports.view") ? <SearchCheckSection baseUrl={`/api/app/${company.id}/search-check`} />');
    expect(both).toContain('can.includes("aeo.view") ? <AiMentionsSection baseUrl={`/api/app/${company.id}/ai-mentions`} />');
    const reportsOnly = await plan(COMPANIES);
    const page = file(reportsOnly, "app", "(site)", "app", "website", "page.tsx");
    expect(page).toContain('permission="seo_reports.view"');
    expect(page).not.toContain("<WebsitePage");
    expect(file(reportsOnly, "src", "nav.ts")).toContain('"/app/website"');
    const visitsOnly = file(await plan({ tenantNoun: "Company", adminShell: "full", includeAnalytics: true }), "app", "(site)", "app", "website", "page.tsx");
    expect(visitsOnly).not.toContain("SearchCheckSection");
    expect(visitsOnly).not.toContain("AiMentionsSection");
  });

  it("company keys and staff keys, crons in vercel.json, and the tRPC routers gone", async () => {
    const p = await plan({ ...COMPANIES, ...AI });
    const catalog = file(p, "src", "permissions", "catalog.ts");
    expect(catalog).toContain("seoReportsPermissions");
    expect(catalog).toContain("aeoPermissions");
    for (const key of ["staff.seo_reports.view", "staff.seo_reports.run", "staff.aeo.view", "staff.aeo.manage"]) expect(catalog).toContain(`"${key}"`);
    const vercel = file(p, "vercel.json");
    expect(vercel).toContain("/api/cron/search-check");
    expect(vercel).toContain("/api/cron/ai-mentions");
    expect(file(p, "app", "api", "cron", "search-check", "route.ts")).toContain("runDailySearchChecks");
    expect(file(p, "app", "api", "cron", "ai-mentions", "route.ts")).toContain("runDailyAiMentions");
    expect(has(p, "src", "server", "routers", "seo.ts")).toBe(false);
    expect(has(p, "src", "server", "routers", "aeo.ts")).toBe(false);
    expect(has(p, "src", "server", "aeo-asker.ts")).toBe(false);
    const router = code(file(p, "src", "server", "routers", "_app.ts"));
    expect(router).not.toContain("seoRouter");
    expect(router).not.toContain("aeoRouter");
    expect(file(p, "app", "admin", "seo", "page.tsx")).toContain('can?.can("staff.seo_reports.view")');
    expect(file(p, "app", "admin", "aeo", "page.tsx")).toContain('can?.can("staff.aeo.view")');
  });

  it("the isolation proof drives both route tables and plants a check, a profile, a question and an answer", async () => {
    const p = await plan({ ...COMPANIES, ...AI });
    expect(featureSuiteNames(answers({ ...COMPANIES, ...AI }))).toEqual(expect.arrayContaining(["seo-reports", "aeo"]));
    expect(FEATURE_ENTITIES["seo-reports"]).toEqual(["site-check"]);
    expect(FEATURE_ENTITIES.aeo).toEqual(["question"]);
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toMatch(/adminRoutes: SEO_REPORTS_ADMIN_ROUTES/);
    expect(proof).toMatch(/adminRoutes: AEO_ADMIN_ROUTES/);
    expect(proof).toContain("buildSearchCheckHandlers({ ...overrides, network: proofSearchNetwork })");
    expect(proof).toContain("buildAiMentionsHandlers({ ...overrides, engine: proofAnswerEngine })");
    expect(proof).toContain("seo_reports: await all(");
    expect(proof).toContain("aeo_checks: await all(");
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    expect(rows).toContain('rows["site-check"] = searchCheck');
    expect(rows).toContain("rows.question = question.id");
    // Without --ai there's no engine to script.
    expect(code(file(await plan(COMPANIES), "src", "server", "__tests__", "feature-isolation.test.ts"))).not.toContain("proofAnswerEngine");
  });
});

describe("single-business mode", () => {
  it("the site's own only, on staff keys", async () => {
    const p = await plan({ ...SINGLE, ...AI });
    const search = code(file(p, "src", "server", "search-check.ts"));
    expect(search).toContain("tenantId: SITE_CHECKS");
    expect(search).not.toContain("buildSearchCheckHandlers");
    expect(search).not.toContain("company-routes");
    const mentions = code(file(p, "src", "server", "ai-mentions.ts"));
    expect(mentions).toContain("tenantId: SITE_MENTIONS");
    expect(mentions).not.toContain("buildAiMentionsHandlers");
    expect(has(p, "app", "(site)", "app", "website", "page.tsx")).toBe(false);
    expect(has(p, "app", "api", "app", "[tenantId]", "search-check", "[...path]", "route.ts")).toBe(false);
    expect(file(p, "src", "permissions", "catalog.ts")).not.toContain("seoReportsPermissions");
    expect(file(p, "src", "permissions", "catalog.ts")).toContain('"staff.seo_reports.view"');
  });
});

describe("the README and the upgrade notes", () => {
  it("says what each does and isn't, in plain words", async () => {
    const readme = file(await plan({ ...COMPANIES, ...SELLS, ...AI }), "README.md");
    expect(readme).toContain("### Search check");
    expect(readme).toContain("### AI mentions");
    expect(readme).toContain("a check also runs by itself every week, free");
    expect(readme).toContain("never a private or cloud-internal one");
  });

  it("tells a 0.30 project what to run", () => {
    const notes = upgradeNotesFor(answers({ ...COMPANIES, ...AI }), "0.30.0").join("\n");
    expect(notes).toContain("sql/upgrade-0.1-to-0.2.sql");
    expect(notes).toContain("node_modules/@adminigloo/aeo/sql/upgrade-0.1-to-0.2.sql");
    expect(notes).toContain("tenant_id = 'primary'");
    expect(upgradeNotesFor(answers({ ...COMPANIES, ...AI }), "0.31.0")).toEqual([]);
  });
});
