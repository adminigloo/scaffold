/**
 * TENANCY 2b-4a, AS THE GENERATOR WRITES IT (create-app 0.30): website visits
 * and search basics per company. Read from the PLAN as text; the generated
 * project's own suite (the isolation proof on PGlite) runs the routes.
 *
 *   - --analytics brings analytics AND audience; --seo brings seo;
 *   - companies mode: /app/website, the company routes and the beacon on each
 *     company's pages, the company keys, the plan's websites, the proof;
 *   - this site's own numbers on staff keys at /admin/analytics, in both modes;
 *   - --seo: the site's own SEO on the package, each company's pages in search,
 *     token pages out; without it, today's files;
 *   - no emitted `if` about an answer, no fixed tenant in a companies project.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, DEFAULT_ANSWERS, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { packageVersions, planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-website", ...overrides };
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

const COMPANIES: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", includeAnalytics: true, includeSeo: true };
const FIELD: Partial<Answers> = { includeScheduling: true, includeEstimator: true, includeInvoicing: true, includeComms: true, includeEmail: true };
const SELLS: Partial<Answers> = { businessModel: "subscription" };
const SINGLE: Partial<Answers> = { tenantNoun: "none", adminShell: "full", includeAnalytics: true, includeSeo: true };

describe("packages, overlays, versions and capabilities", () => {
  it("--analytics installs analytics and audience; --seo installs seo; neither, nothing", () => {
    expect(packagesFor(answers({ includeAnalytics: true }))).toEqual(expect.arrayContaining(["@adminigloo/analytics", "@adminigloo/audience"]));
    expect(packagesFor(answers({ includeAnalytics: true }))).not.toContain("@adminigloo/seo");
    expect(packagesFor(answers({ includeSeo: true }))).toContain("@adminigloo/seo");
    expect(packagesFor(answers()).filter((name) => /\/(analytics|audience|seo)$/.test(name))).toEqual([]);
    const versions = packageVersions();
    expect([versions.analytics, versions.audience, versions.seo]).toEqual(["0.3.0", "0.2.0", "0.2.0"]);
  });

  it("selects the analytics overlays by their conditions", () => {
    expect(overlayNamesFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["analytics", "analytics-admin", "analytics-companies"]));
    expect(overlayNamesFor(answers({ ...COMPANIES, adminShell: "none" }))).not.toContain("analytics-admin");
    expect(overlayNamesFor(answers(SINGLE))).not.toContain("analytics-companies");
    expect(overlayNamesFor(answers({ ...COMPANIES, includeAnalytics: false })).filter((name) => name.startsWith("analytics"))).toEqual([]);
  });

  it("claims what it emits", () => {
    expect(capabilitiesFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["analytics.visits", "analytics.audience", "analytics.dashboard", "analytics.companies", "seo.package", "seo.companies"]));
    expect(capabilitiesFor(answers(SINGLE))).not.toContain("analytics.companies");
    expect(capabilitiesFor(answers(SINGLE))).not.toContain("seo.companies");
  });
});

describe("companies mode", () => {
  it("each company's numbers: its routes, its gate, its plan's websites, its beacon", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD, ...SELLS });
    const glue = code(file(p, "src", "server", "website.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("websiteLimit: (tenantId) => websiteQuota(tenantId)");
    expect(glue).toContain("admitPublic(tenantId, req)");
    expect(glue).toContain("audience: (tenantId) => audiences.for(tenantId)");
    expect(glue).toContain("tenantMembers.status} = 'active'");
    expect(glue).not.toContain('"primary"');
    for (const route of [
      ["app", "api", "app", "[tenantId]", "website", "[...path]", "route.ts"],
      ["app", "api", "app", "[tenantId]", "audience", "[...path]", "route.ts"],
      ["app", "api", "t", "[slug]", "website", "[...path]", "route.ts"],
      ["app", "api", "w", "[...path]", "route.ts"],
      ["app", "api", "analytics", "[...path]", "route.ts"],
    ]) {
      expect(has(p, ...route), route.join("/")).toBe(true);
    }
    const page = file(p, "app", "(site)", "app", "website", "page.tsx");
    expect(page).toContain('permission="analytics.view"');
    expect(page).toContain('can.includes("audience.manage")');
    const gate = file(p, "src", "components", "PublicCompanyGate.tsx");
    expect(gate).toContain("<CompanyAnalytics slug={company.slug} />");
    expect(gate).toContain("recordCompanyCrawlerHit(found.company.id, facts)");
    expect(file(p, "src", "nav.ts")).toContain('"/app/website"');
    const catalog = file(p, "src", "permissions", "catalog.ts");
    expect(catalog).toContain("analyticsPermissions");
    expect(catalog).toContain("audiencePermissions");
    expect(catalog).toContain('"staff.analytics.view"');
    expect(catalog).toContain('"staff.audience.manage"');
    expect(file(p, "src", "plans.ts")).toContain("websites:");
    expect(file(p, "src", "server", "plan-gate.ts")).toContain('planLimit(tenantId, "websites")');
    expect(file(p, "vercel.json")).toContain("/api/cron/analytics");
    expect(file(p, "src", "db", "schema.ts")).toContain("/analytics/schema");
    expect(file(p, "src", "db", "schema.ts")).toContain("/audience/schema");
  });

  it("the isolation proof drives every analytics and audience route table, plants their rows, and checks the keyed beacon", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    expect(featureSuiteNames(answers({ ...COMPANIES, ...FIELD }))).toEqual(expect.arrayContaining(["analytics", "audience"]));
    expect(FEATURE_ENTITIES.analytics).toEqual(["website"]);
    expect(FEATURE_ENTITIES.audience).toEqual(["rule"]);
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toMatch(/adminRoutes: ANALYTICS_ADMIN_ROUTES/);
    expect(proof).toMatch(/publicRoutes: ANALYTICS_PUBLIC_ROUTES/);
    expect(proof).toMatch(/adminRoutes: AUDIENCE_ADMIN_ROUTES/);
    expect(proof).toContain("analytics_sessions: await all(");
    expect(proof).toContain('describe("feature isolation: website beacons"');
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    expect(rows).toContain("rows.website = website.id");
    expect(rows).toContain('rows["site-key"] = website.siteKey');
    expect(rows).toContain("rows.rule = audienceRule.rule.id");
  });

  it("a company's people are only ever its own: members and invitations, never the whole users table (review H1)", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    const glue = code(file(p, "src", "server", "website.ts"));
    // Every lookup of a company's people carries "belongs": an active member, or an invitation not withdrawn.
    expect(glue).toContain("const belongs = sql`(${isMember} or ${isInvited})`;");
    expect(glue).toContain("${tenantInvitations.revokedAt} is null");
    expect(glue).toContain(".where(sql`${users.id} = ${id} and ${belongs}`)");
    expect(glue).toContain(".where(sql`${named} and ${belongs}`)");
    // The isolation proof checks it from B's side, with A's side able to fail.
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toContain('describe("feature isolation: who a company can leave out"');
    expect(proof).toContain('preview(fx.B, fx.bId, { kind: "email_domain", value: domain })');
    expect(proof).toContain('preview(fx.A, fx.aId, { kind: "email_domain", value: domain })');
  });

  it("a company's pages here count only under its own web address, and websites refuse the app's own address once deployed", async () => {
    const glue = code(file(await plan({ ...COMPANIES, ...FIELD }), "src", "server", "website.ts"));
    expect(glue).toContain("pathPrefix: `/t/${slug}`");
    expect(glue).toContain("addressRules: websiteAddressRules");
    expect(glue).toContain("return isDeployed() ? { hosts: appHosts(), local: true } : { hosts: [] };");
    // The Host header is trusted only in development, never in a production build.
    expect(glue).toContain('if (!isDeployed() && process.env.NODE_ENV !== "production") {');
  });

  it("a company whose plan has closed is shut like a suspended one: no widget, no counter, no crawler log, not indexed", async () => {
    const sells = file(await plan({ ...COMPANIES, ...FIELD, ...SELLS }), "src", "components", "PublicCompanyGate.tsx");
    expect(sells).toContain('import { planStandingOf } from "@/server/plan-gate";');
    expect(sells).toContain("return (await planStandingOf(found.company.id)).open;");
    expect(sells).toContain("(await companyOpen(slug)) && !options.noReferrer");
    expect(sells).toContain("if (open && classifyCrawler(userAgent)) {");
    expect(sells).toContain("{open ? <CompanyAnalytics slug={company.slug} /> : null}");
    expect(sells).toContain('props.path === "" && open ? await businessDetails(found.company.id) : null');
    // No plans sold: the status alone, and no plan import.
    const free = file(await plan({ ...COMPANIES, ...FIELD }), "src", "components", "PublicCompanyGate.tsx");
    expect(free).not.toContain("planStandingOf");
    expect(code(free)).toMatch(/if \(!found \|\| found\.status !== "active"\) return false;\s+return true;/);
  });

  it("the sitemap lists a company only while it takes requests, and its estimate page only once the estimator is set up", async () => {
    const sells = file(await plan({ ...COMPANIES, ...FIELD, ...SELLS }), "app", "sitemap.ts");
    expect(sells).toContain("if (!(await open(tenantId))) return [];");
    expect(sells).toContain('"/estimate": async (tenantId) => publicEstimatesOpen(await getEstimatorSettings(db, tenantId)),');
    expect(sells).toContain("the companies change as they sign up");
    expect(sells).not.toContain("companys");
    const plain = file(await plan({ ...COMPANIES, includeScheduling: true }), "app", "sitemap.ts");
    expect(plain).not.toContain("planStandingOf");
    expect(plain).not.toContain("getEstimatorSettings");
  });

  it("a companies project with analytics alone has its isolation proof", async () => {
    const p = await plan({ tenantNoun: "Company", adminShell: "minimal", includeAnalytics: true });
    expect(has(p, "src", "server", "__tests__", "feature-isolation.test.ts")).toBe(true);
    expect(featureSuiteNames(answers({ tenantNoun: "Company", includeAnalytics: true }))).toEqual(["analytics", "audience"]);
  });

  it("no plan, no websites quota; the open plan gate answers no limit", async () => {
    const p = await plan(COMPANIES);
    expect(file(p, "src", "server", "plan-gate.ts")).toContain("export async function websiteQuota(_tenantId: string)");
    expect(has(p, "src", "plans.ts")).toBe(false);
    const sells = await plan({ ...COMPANIES, ...SELLS, includeAnalytics: false });
    expect(file(sells, "src", "plans.ts")).not.toContain("websites:");
  });
});

describe("this site's own numbers, and a single business", () => {
  it("--tenant-noun none: one site on staff keys, and no company area", async () => {
    const p = await plan(SINGLE);
    const glue = code(file(p, "src", "server", "website.ts"));
    expect(glue).not.toContain("company-routes");
    expect(glue).toContain("buildPlatformAnalyticsHandlers");
    expect(glue).toContain("authorizeStaffFor(ANALYTICS_STAFF_KEYS");
    expect(has(p, "app", "(site)", "app", "website", "page.tsx")).toBe(false);
    expect(file(p, "app", "admin", "analytics", "page.tsx")).toContain('can("staff.analytics.view")');
    expect(file(p, "src", "components", "admin", "AdminNav.tsx")).toContain("/admin/analytics");
  });

  it("the (site) layout mounts the slot in every project; the slot is the beacon only with --analytics", async () => {
    const on = await plan(SINGLE);
    const off = await plan({ ...SINGLE, includeAnalytics: false });
    for (const p of [on, off]) expect(file(p, "app", "(site)", "layout.tsx")).toContain("<SiteAnalyticsSlot />");
    expect(file(on, "src", "components", "SiteAnalyticsSlot.tsx")).toContain("<SiteAnalytics />");
    expect(code(file(off, "src", "components", "SiteAnalyticsSlot.tsx"))).toContain("return null;");
    expect(has(off, "src", "components", "SiteAnalytics.tsx")).toBe(false);
  });

  it("no emitted file asks whether analytics or seo is installed", async () => {
    for (const overrides of [COMPANIES, SINGLE, { ...COMPANIES, includeSeo: false }, { ...SINGLE, includeAnalytics: false }]) {
      const p = await plan(overrides);
      for (const [path, contents] of p.files) {
        if (!/\.(ts|tsx)$/.test(path)) continue;
        expect(code(contents), path).not.toMatch(/includeAnalytics|includeSeo|features\.(analytics|seo)/);
      }
    }
  });
});

describe("search basics", () => {
  it("--seo: one path list on the package, each company's token pages private, its pages listed", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    const seo = file(p, "src", "seo.ts");
    expect(seo).toContain("definePaths({");
    for (const path of ['"/t/*/quote"', '"/t/*/visit"', '"/t/*/invoice"']) expect(seo).toContain(path);
    expect(code(seo)).not.toContain('"/t/",');
    expect(file(p, "app", "robots.ts")).toContain("robotsPolicy(site, { crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS] })");
    const sitemap = file(p, "app", "sitemap.ts");
    expect(sitemap).toContain("PUBLIC_COMPANY_PAGES");
    expect(sitemap).toContain("isNull(tenants.suspendedAt)");
    const gate = file(p, "src", "components", "PublicCompanyGate.tsx");
    expect(gate).toContain("alternates: { canonical }");
    expect(gate).toContain("localBusiness(site, {");
    expect(gate).toContain("parentOrganization: false");
    expect(gate).toContain("!options.noReferrer");
  });

  it("without --seo: today's files, and company pages stay out of search", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD, includeSeo: false });
    expect(file(p, "src", "seo.ts")).not.toContain("@adminigloo/seo");
    expect(file(p, "app", "robots.ts")).toContain('"/t/"');
    const gate = file(p, "src", "components", "PublicCompanyGate.tsx");
    expect(gate).toContain("robots: { index: false, follow: false }");
    expect(gate).not.toContain("localBusiness");
  });

  it("--seo in a single business keeps its own pages listed and robots on the package", async () => {
    const p = await plan({ ...SINGLE, ...FIELD });
    expect(file(p, "src", "seo.ts")).toContain('"/book-visit"');
    expect(file(p, "app", "sitemap.ts")).not.toContain("tenants");
    expect(file(p, "app", "llms.txt", "route.ts")).toContain("recordSiteCrawlerHit(facts)");
  });
});

describe("the project's README", () => {
  it("says where the numbers are and what isn't included, in plain words", async () => {
    const readme = file(await plan({ ...COMPANIES, ...FIELD, ...SELLS }), "README.md");
    expect(readme).toContain("### Website visits");
    expect(readme).toContain("/app/website");
    expect(readme).toContain("### Search");
    expect(readme).toContain("Search checks and AI mentions");
    expect(readme).toContain("Google Search Console");
    expect(readme).not.toContain("**Search indexing of company pages**");
    const without = file(await plan({ ...COMPANIES, ...FIELD, includeSeo: false, includeAnalytics: false }), "README.md");
    expect(without).toContain("**Search indexing of company pages**");
  });
});
