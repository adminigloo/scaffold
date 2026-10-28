/**
 * SOCIAL POSTS, AS THE GENERATOR WRITES THEM (create-app 0.41, --social):
 * each company's posts at /app/posts, this site's own at /admin/posts, the
 * signed card route, the metered words with --ai, the migration, the nav, the
 * env and the permissions. Read from the PLAN as text; the generated project's
 * own suite (the isolation proof on PGlite) runs the routes.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDABLE_FEATURES } from "../add.js";
import { assertAnswersCompatible, capabilitiesFor, DEFAULT_ANSWERS, optionalEnvFor, packagesFor, type Answers } from "../answers.js";
import { parseArgs } from "../cli.js";
import { packageVersions, planEmit, schemaOwners, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { forgetSteps } from "../forget-company-emit.js";
import { PACKAGE_TABLES } from "../upgrade-losses.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-posts", includeSocial: true, ...overrides };
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
const has = (p: EmitPlan, ...segments: string[]) => p.files.has(join(...segments));
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const COMPANIES: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", businessModel: "subscription", includeAi: true };

describe("companies mode", () => {
  it("each company's posts over the company seams, its cards in its own name and colour", async () => {
    const p = await plan(COMPANIES);
    const glue = code(file(p, "src", "server", "social.ts"));
    expect(glue).toContain("export function buildSocialAdminHandlers(overrides: FeatureHandlerOverrides & SocialOverrides = {})");
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("cardBrand({ name: profile.name, site: home, accent: profile.brandColor, onAccent: profile.onBrandColor })");
    expect(glue).toContain("link: input.link ?? company.home");
    expect(glue).toContain("dayIn((await tenancy.companyProfile(tenantId))?.timeZone ?? null, now)");
    // Code writes every fact; the AI only the hook and the sign-off, every word checked.
    expect(glue).toContain('mode: "aside"');
    expect(glue).toContain("honesty: genericHonesty");
    expect(file(p, "app", "api", "app", "[tenantId]", "posts", "[...path]", "route.ts")).toContain("buildSocialAdminHandlers()");
    const page = file(p, "app", "(site)", "app", "posts", "page.tsx");
    expect(page).toContain('<CompanyGate path="/app/posts" permission="social.view">');
    expect(page).toContain('canManage={can.includes("social.manage")}');
    expect(page).toContain("baseUrl={`/api/app/${company.id}/posts`}");
  });

  it("and this site's own posts at /admin/posts on staff keys, with an admin panel", async () => {
    const p = await plan(COMPANIES);
    const glue = code(file(p, "src", "server", "social.ts"));
    expect(glue).toContain('export const SOCIAL_SITE = "*";');
    expect(glue).toContain('export const SOCIAL_STAFF_KEYS = { "social.view": "staff.social.view", "social.manage": "staff.social.manage" } as const;');
    expect(glue).toContain("authorize: authorizeStaffFor(SOCIAL_STAFF_KEYS");
    expect(file(p, "app", "api", "admin", "posts", "[...path]", "route.ts")).toContain("buildSiteSocialHandlers()");
    expect(file(p, "app", "admin", "posts", "page.tsx")).toContain('can?.can("staff.social.view")');
    // With no admin panel, only the companies' own: nothing under /admin.
    const bare = await plan({ ...COMPANIES, adminShell: "none" });
    expect(has(bare, "app", "admin", "posts", "page.tsx")).toBe(false);
    expect(has(bare, "app", "api", "admin", "posts", "[...path]", "route.ts")).toBe(false);
    expect(code(file(bare, "src", "server", "social.ts"))).not.toContain("buildSiteSocialHandlers");
    expect(has(bare, "app", "(site)", "app", "posts", "page.tsx")).toBe(true);
  });

  it("the company keys and the staff keys, the nav entries, the proof and the deletion", async () => {
    const p = await plan(COMPANIES);
    const catalog = file(p, "src", "permissions", "catalog.ts");
    expect(catalog).toContain("socialPermissions");
    expect(catalog).toContain('"staff.social.view": {');
    expect(catalog).toContain('"staff.social.manage": {');
    const nav = file(p, "src", "nav.ts");
    expect(nav).toContain('{ href: "/app/posts", label: "Posts", permission: "social.view", group: "Website" }');
    expect(file(p, "src", "components", "admin", "AdminNav.tsx")).toContain('{ href: "/admin/posts", label: "Posts", permission: "staff.social.view" }');
    expect(featureSuiteNames(answers(COMPANIES))).toContain("social");
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("SOCIAL_ADMIN_ROUTES");
    expect(proof).toContain("buildSocialAdminHandlers({ ...overrides, complete: null })");
    expect(proof).toContain("select * from social_posts where tenant_id");
    const rows = file(p, "src", "test", "company-rows.ts");
    for (const entity of FEATURE_ENTITIES["social"]!) expect(rows).toContain(`rows.${entity} =`);
    expect(rows).toContain(`import { postStore } from "@adminigloo/social/server";`);
    expect(forgetSteps(answers(COMPANIES)).map((s) => s.pkg)).toContain("social");
    expect(file(p, "src", "server", "forget-company.ts")).toContain('import { forgetTenant as forgetSocial } from "@adminigloo/social/server";');
    expect(capabilitiesFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["social.posts", "social.companies", "social.ai-words"]));
  });
});

describe("one business", () => {
  it("/admin/posts on staff keys, and no company routes", async () => {
    const p = await plan({ tenantNoun: "none", adminShell: "minimal" });
    const glue = code(file(p, "src", "server", "social.ts"));
    expect(glue).toContain("buildSiteSocialHandlers");
    expect(glue).not.toContain("buildSocialAdminHandlers");
    expect(glue).not.toContain("companyAuthorizer");
    expect(has(p, "app", "admin", "posts", "page.tsx")).toBe(true);
    expect(has(p, "app", "(site)", "app", "posts", "page.tsx")).toBe(false);
    expect(has(p, "src", "server", "staff-access.ts")).toBe(true);
    expect(file(p, "src", "permissions", "catalog.ts")).not.toContain("socialPermissions");
    expect(capabilitiesFor(answers({ tenantNoun: "none" }))).toEqual(expect.arrayContaining(["social.posts"]));
    expect(capabilitiesFor(answers({ tenantNoun: "none" }))).not.toContain("social.companies");
  });

  it("refuses --social with no admin panel, only for one business", () => {
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "none", adminShell: "none" }))).toThrow(/admin panel/);
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "Company", adminShell: "none" }))).not.toThrow();
  });
});

describe("the cards, the AI and the secret", () => {
  it("serves every card from one public, signed route drawn with the embedded fonts and the brand's colours", async () => {
    const p = await plan(COMPANIES);
    const route = file(p, "app", "api", "social", "card", "route.tsx");
    expect(route).toContain('import { ImageResponse } from "next/og";');
    expect(route).toContain('import { cardFonts, CARD_SANS, CARD_SERIF } from "@adminigloo/social/fonts";');
    expect(route).toContain("export const GET = createCardRoute({");
    expect(route).toContain("secret: socialCardSecret,");
    expect(route).toContain('export const runtime = "nodejs";');
    const glue = file(p, "src", "server", "social.ts");
    expect(glue).toContain("ground: BRAND.card.background,");
    // The key: SOCIAL_CARD_SECRET, else made from Clerk's, never written in the file for a deployment.
    expect(glue).toContain("if (env.SOCIAL_CARD_SECRET) return env.SOCIAL_CARD_SECRET;");
    expect(glue).toContain('createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:social-card:v1")');
    expect(glue).toContain("return isDeployed() ? PROCESS_CARD_KEY : LOCAL_CARD_KEY;");
    const envModule = file(p, "src", "env.ts");
    expect(envModule).toContain('SOCIAL_CARD_SECRET: z.string().min(32, "at least 32 characters").optional()');
    expect(envModule).toContain("SOCIAL_CARD_SECRET: process.env.SOCIAL_CARD_SECRET");
    expect(file(p, ".env.example")).toContain("SOCIAL_CARD_SECRET=");
    expect(optionalEnvFor(answers(COMPANIES))).toContain("SOCIAL_CARD_SECRET");
  });

  it("with --ai, Claude Haiku 4.5 writes the words around the facts, every call held against the month and settled", async () => {
    const glue = code(file(await plan(COMPANIES), "src", "server", "social.ts"));
    expect(glue).toContain("export const SOCIAL_MODEL: string = DEFAULT_SOCIAL_MODEL;");
    expect(glue).toContain("export const SOCIAL_AI_POSTS_A_MONTH = 60;");
    expect(glue).toContain("reserveAiAllowance(db, { ...allowanceInput(tenantId), userId, operation: SOCIAL_POST_OPERATION, model, reserveMicros })");
    expect(glue).toContain("settleAiReservation(db, MODEL_RATES, reservationId");
    expect(glue).toContain("createAnthropicComplete({ client: anthropic, model: SOCIAL_MODEL, rate, spend: socialSpend, tenantId, userId })");
    // An unpriced model fails closed: the person's own words, never an unmetered call.
    expect(glue).toContain("if (!rate) {");
  });

  it("without --ai, no model and no meter: every draft is the person's own words", async () => {
    const glue = code(file(await plan({ ...COMPANIES, includeAi: false }), "src", "server", "social.ts"));
    expect(glue).toContain("export function socialComplete(_tenantId: string, _userId: string | null): Complete | null {\n  return null;\n}");
    expect(glue).not.toContain("createAnthropicComplete");
    expect(glue).not.toContain("reserveAiAllowance");
    expect(capabilitiesFor(answers({ ...COMPANIES, includeAi: false }))).not.toContain("social.ai-words");
  });

  it("writes no weather, betting or other one-business words into a generic project", async () => {
    const p = await plan(COMPANIES);
    const text = [
      file(p, "src", "server", "social.ts"),
      file(p, "app", "api", "social", "card", "route.tsx"),
      file(p, "app", "admin", "posts", "page.tsx"),
      file(p, "app", "(site)", "app", "posts", "page.tsx"),
    ].join("\n");
    expect(text).not.toMatch(/kalshi|polymarket|weather|temperature|\bbets?\b|betting|odds|almanac/i);
  });
});

describe("the migration, the packages and the flags", () => {
  it("puts the posts queue in the schema drizzle-kit reads, and in the tables an upgrade can drop", async () => {
    const p = await plan(COMPANIES);
    expect(file(p, "src", "db", "schema.ts")).toContain('export * from "@adminigloo/social/schema";');
    expect(schemaOwners(answers(COMPANIES))).toContain("social");
    expect(PACKAGE_TABLES["social"]).toEqual(["social_posts"]);
  });

  it("installs @adminigloo/social at 0.1, parses --social / --no-social, and can be added later", () => {
    expect(packagesFor(answers())).toContain("@adminigloo/social");
    expect(packagesFor(answers({ includeSocial: false }))).not.toContain("@adminigloo/social");
    expect(packageVersions()["social"]).toBe("0.1.0");
    expect(parseArgs(["acme", "--social"]).social).toBe(true);
    expect(parseArgs(["acme", "--no-social"]).social).toBe(false);
    expect(ADDABLE_FEATURES).toContain("social");
  });

  it("is off unless asked for: a project without it has none of its files", async () => {
    const p = await plan({ ...COMPANIES, includeSocial: false });
    for (const path of [["src", "server", "social.ts"], ["app", "api", "social", "card", "route.tsx"], ["app", "admin", "posts", "page.tsx"], ["app", "(site)", "app", "posts", "page.tsx"]]) {
      expect(has(p, ...path), path.join("/")).toBe(false);
    }
    expect(DEFAULT_ANSWERS.includeSocial).toBe(false);
  });
});
