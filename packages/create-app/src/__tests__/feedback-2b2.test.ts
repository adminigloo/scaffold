/**
 * TENANCY 2b-2a, AS THE GENERATOR WRITES IT: a feedback board per company.
 *
 * With `--feedback` in a companies project, each company works its own board
 * at /app/feedback (over /api/app/{id}/feedback), its customers write to it
 * at /t/{web address}/feedback, and this site's own board — the in-app
 * button's — stays at /admin/feedback for the site's staff. A single-business
 * project keeps its one board. Read from the PLAN as text, as the 2a and 2b-1
 * tests do; the emitted modules run for real in a generated project (its own
 * feature-isolation test drives every feedback route).
 */

import { sep } from "node:path";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, capabilitiesFor, overlayNamesFor, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { featureSuiteNames, FEATURE_ENTITIES } from "../feature-proofs-emit.js";
import { FEEDBACK_2B2A_NOT_INCLUDED } from "../readme-emit.js";
import { TEMPLATE_DIR, TENANCY_2B1_CONFIGURATIONS as C } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
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

function pathsOf(p: EmitPlan): string[] {
  return [...p.files.keys()].map((path) => path.split(sep).join("/"));
}

/** Every field feature, alerts, files, messages with email, and feedback: the brief's companies project. */
const COMPANY_ALL: Partial<Answers> = { ...C.companyAll, includeComms: true, includeEmail: true, includeFeedback: true };
/** Feedback alone in a companies project: no alerts, no messages. */
const COMPANY_FEEDBACK_ALONE: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", includeFeedback: true };
/** A single business with the shell and feedback. */
const SINGLE_FEEDBACK: Partial<Answers> = { tenantNoun: "none", adminShell: "full", includeFeedback: true };

const COMPANY_FILES = [
  "app/(site)/app/feedback/page.tsx",
  "app/(site)/app/feedback/settings/page.tsx",
  "app/api/app/[tenantId]/feedback/[...path]/route.ts",
  "app/(company)/t/[slug]/feedback/page.tsx",
  "app/api/t/[slug]/feedback/[...path]/route.ts",
  "src/components/CompanyFeedbackForm.tsx",
];

describe("the overlays", () => {
  it("copy each company's board and feedback page in a companies project, and none of it in a single business", async () => {
    expect(overlayNamesFor(answers(COMPANY_FEEDBACK_ALONE))).toContain("feedback-companies");
    expect(overlayNamesFor(answers(SINGLE_FEEDBACK))).not.toContain("feedback-companies");
    const companies = pathsOf(await plan(COMPANY_FEEDBACK_ALONE));
    const single = pathsOf(await plan(SINGLE_FEEDBACK));
    for (const path of COMPANY_FILES) {
      expect(companies, path).toContain(path);
      expect(single, path).not.toContain(path);
    }
  });

  it("keep this site's own board, its routes and its settings in both modes", async () => {
    for (const config of [COMPANY_FEEDBACK_ALONE, SINGLE_FEEDBACK]) {
      const p = await plan(config);
      expect(file(p, "app", "api", "admin", "feedback", "[...path]", "route.ts")).toContain("buildPlatformFeedbackAdminHandlers()");
      expect(file(p, "app", "api", "igloo", "[...path]", "route.ts")).toContain("buildFeedbackIntakeHandlers()");
      expect(file(p, "app", "admin", "feedback", "page.tsx")).toContain('baseUrl="/api/admin/feedback"');
      expect(file(p, "app", "admin", "feedback", "page.tsx")).toContain('can?.can("staff.feedback.view")');
      expect(file(p, "app", "admin", "feedback", "settings", "page.tsx")).toContain('can.can("staff.feedback.settings")');
      expect(file(p, "src", "components", "FeedbackSettings.tsx")).toContain("new FeedbackAdminClient(baseUrl)");
      // The old pages lead to the new ones.
      expect(file(p, "app", "admin", "feedback", "board", "page.tsx")).toContain('redirect("/admin/feedback")');
      expect(file(p, "app", "admin", "feedback", "statuses", "page.tsx")).toContain('redirect("/admin/feedback/settings")');
      expect(file(p, "app", "admin", "feedback", "categories", "page.tsx")).toContain('redirect("/admin/feedback/settings")');
      // The tRPC router is retired.
      expect(has(p, "src", "server", "routers", "feedback.ts")).toBe(false);
      expect(file(p, "src", "server", "routers", "_app.ts")).not.toContain("feedback");
      // This site's button's key has no company.
      expect(file(p, "scripts", "issue-feedback-key.ts")).toContain("tenantId: FEEDBACK_PLATFORM_BOARD");
    }
  });

  it("give a company's pages its own routes and its customers' page the company gate", async () => {
    const p = await plan(COMPANY_FEEDBACK_ALONE);
    const board = file(p, "app", "(site)", "app", "feedback", "page.tsx");
    expect(board).toContain('permission="feedback.view"');
    expect(board).toContain("baseUrl={`/api/app/${company.id}/feedback`}");
    expect(board).toContain('can.includes("feedback.manage")');
    const settings = file(p, "app", "(site)", "app", "feedback", "settings", "page.tsx");
    expect(settings).toContain('can.includes("feedback.settings.manage")');
    expect(settings).toContain("companyLinksFor(company.slug).feedback");
    const pub = file(p, "app", "(company)", "t", "[slug]", "feedback", "page.tsx");
    expect(pub).toContain("<PublicCompanyGate");
    expect(pub).toContain("publicCompanyMetadata(slug");
    expect(pub).toContain("baseUrl={`/api/t/${company.slug}/feedback`}");
    const form = file(p, "src", "components", "CompanyFeedbackForm.tsx");
    expect(form).toContain("screenshot: false");
    expect(form).toContain("askContact: true");
    expect(code(form)).not.toContain("clientKey");
    expect(file(p, "app", "api", "app", "[tenantId]", "feedback", "[...path]", "route.ts")).toContain("buildFeedbackAdminHandlers()");
    expect(file(p, "app", "api", "t", "[slug]", "feedback", "[...path]", "route.ts")).toContain("buildFeedbackPublicHandlers()");
  });
});

describe("src/server/feedback.ts", () => {
  it("in a companies project: each company's board through the company check, its page through admitPublic, this site's own on staff keys", async () => {
    const glue = code(file(await plan(COMPANY_ALL), "src", "server", "feedback.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant,");
    expect(glue).toContain("authorize: companyAuthorizer(overrides),");
    expect(glue).toContain("resolveTenant: resolvePublicTenant,");
    expect(glue).toContain("admit: admitPublic,");
    expect(glue).toContain("tenantId: FEEDBACK_PLATFORM_BOARD,");
    expect(glue).toContain('authorize: authorizeStaffFor(FEEDBACK_STAFF_KEYS, "Sign in to see the feedback board."),');
    expect(glue).toContain('"feedback.settings.manage": "staff.feedback.settings",');
    expect(glue).toContain("export async function setupFeedbackFor(tenantId: string)");
  });

  it("alerts the team with --notifications, emails the reporter with --comms, and neither without", async () => {
    const all = code(file(await plan(COMPANY_ALL), "src", "server", "feedback.ts"));
    expect(all).toContain("await alertOnFeedbackEvent(event);");
    expect(all).toContain("onEvent: onFeedbackIntakeEvent,");
    expect(all).toContain("feedbackReporterEmailFor(event, {");
    expect(all).toContain("commsSenders,");
    expect(all).toContain("onEvent: onFeedbackStaffEvent,");
    expect(all).toContain("await ensureFeedbackEmailTemplates(tenantId);");
    const alone = code(file(await plan(COMPANY_FEEDBACK_ALONE), "src", "server", "feedback.ts"));
    expect(alone).not.toContain("alertOnFeedbackEvent");
    expect(alone).not.toContain("sendNow");
    expect(alone).not.toContain("onEvent:");
  });

  it("asks no question about the answers at run time: every emitted if is about the request's data", async () => {
    for (const config of [COMPANY_ALL, COMPANY_FEEDBACK_ALONE, SINGLE_FEEDBACK]) {
      const glue = code(file(await plan(config), "src", "server", "feedback.ts"));
      const ifs = [...glue.matchAll(/\bif \(([^)]*)\)/g)].map((m) => m[1]!);
      for (const condition of ifs) {
        expect(condition, "an emitted if must be about runtime data").toMatch(/tenantId|userId|fileId|profile|email/);
      }
    }
  });

  it("in a single business: one board, the site's own, with no company in it", async () => {
    const p = await plan(SINGLE_FEEDBACK);
    const glue = code(file(p, "src", "server", "feedback.ts"));
    expect(glue).not.toContain("company-routes");
    expect(glue).not.toContain("admitPublic");
    expect(glue).toContain("export function buildFeedbackIntakeHandlers(");
    expect(glue).toContain("export function buildPlatformFeedbackAdminHandlers(");
    expect(has(p, "src", "server", "staff-access.ts")).toBe(true);
  });

  it("names no fixed business in a companies project", async () => {
    const glue = code(file(await plan(COMPANY_ALL), "src", "server", "feedback.ts"));
    expect(glue).not.toContain('"primary"');
    expect(glue).not.toMatch(/\b[A-Z]+_TENANT\b/);
  });
});

describe("the rest of the wiring", () => {
  it("gives each company its first-time feedback setup, its board link and its public page button", async () => {
    const p = await plan(COMPANY_ALL);
    expect(code(file(p, "src", "server", "company-setup.ts"))).toContain('{ name: "feedback", run: (tenantId) => setupFeedbackFor(tenantId) },');
    expect(file(p, "src", "server", "company-links.ts")).toContain("feedback: at(`${home}/feedback`),");
    expect(file(p, "src", "nav.ts")).toContain('href: "/app/feedback"');
    expect(file(p, "src", "tenancy.ts")).toContain('{ path: "/feedback", label: "Send feedback" },');
  });

  it("puts feedback's keys in the company roles in a companies project, and this site's own on the staff ladder in both", async () => {
    const company = file(await plan(COMPANY_FEEDBACK_ALONE), "src", "permissions", "catalog.ts");
    expect(company).toContain('import { feedbackPermissions } from "@adminigloo/feedback";');
    expect(company).toMatch(/definePermissions\(\s*"tenant",\s*\{[^}]*\.\.\.feedbackPermissions/);
    expect(company).toContain('"staff.feedback.view"');
    const single = file(await plan(SINGLE_FEEDBACK), "src", "permissions", "catalog.ts");
    expect(single).not.toContain("feedbackPermissions");
    expect(single).toContain('"staff.feedback.settings"');
  });

  it("registers feedback's alert kinds and producer only in a companies project with alerts", async () => {
    const alerts = file(await plan(COMPANY_ALL), "src", "server", "alerts.ts");
    expect(alerts).toMatch(/defineAlertRegistry\(\[[^\]]*feedbackAlertKinds/);
    expect(alerts).toContain("export async function alertOnFeedbackEvent(event: FeedbackEvent)");
    expect(alerts).toContain('feedback: "/app/feedback?ticket={id}",');
    const single = file(await plan({ ...SINGLE_FEEDBACK, includeNotifications: true }), "src", "server", "alerts.ts");
    expect(single).not.toContain("feedbackAlertKinds");
  });

  it("drives every feedback route in the companies project's isolation proof, with the keyed intake's own pass", async () => {
    const p = await plan(COMPANY_FEEDBACK_ALONE);
    expect(featureSuiteNames(answers(COMPANY_FEEDBACK_ALONE))).toEqual(["feedback"]);
    expect(capabilitiesFor(answers(COMPANY_FEEDBACK_ALONE))).toContain("companies.feature-isolation-proof");
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toContain("adminRoutes: FEEDBACK_ADMIN_ROUTES,");
    expect(proof).toContain("publicRoutes: FEEDBACK_PUBLIC_ROUTES,");
    expect(proof).toContain("public: buildFeedbackPublicHandlers,");
    expect(proof).toContain("const keyed = buildFeedbackIntakeHandlers({ screenshots: memoryScreenshots });");
    expect(proof).toContain("intake:feedback:");
    expect(proof).toContain("feedback_client_keys: await all(");
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    for (const entity of FEATURE_ENTITIES.feedback ?? []) expect(rows, entity).toContain(`rows${entity.includes("-") ? `["${entity}"]` : `.${entity}`} =`);
    // A ticket's number counts per company, so it never identifies one.
    expect(rows).toContain('entity !== "ticket-number"');
    // No proof in a single business (nothing company-scoped to prove).
    expect(has(await plan(SINGLE_FEEDBACK), "src", "server", "__tests__", "feature-isolation.test.ts")).toBe(false);
  });

  it("says in the README what each company gets, and what isn't included yet", async () => {
    const readme = file(await plan(COMPANY_ALL), "README.md");
    expect(readme).toContain("### Feedback");
    expect(readme).toContain("/t/{web address}/feedback");
    for (const item of FEEDBACK_2B2A_NOT_INCLUDED) expect(readme).toContain(item);
    const single = file(await plan(SINGLE_FEEDBACK), "README.md");
    expect(single).toContain("### Feedback");
    expect(single).not.toContain("/app/feedback");
    expect(file(await plan({ tenantNoun: "Company", adminShell: "full" }), "README.md")).not.toContain("### Feedback");
  });

  it("still works with no admin panel: the routes and the glue are there, the /admin pages are not", async () => {
    const p = await plan({ tenantNoun: "none", adminShell: "none", includeFeedback: true });
    expect(has(p, "src", "server", "feedback.ts")).toBe(true);
    expect(has(p, "app", "api", "admin", "feedback", "[...path]", "route.ts")).toBe(true);
    expect(has(p, "app", "admin", "feedback", "page.tsx")).toBe(false);
  });
});

describe("the 2b-2a review fixes, as the generator writes them", () => {
  it("M5: this site's button stays off a company's public pages", async () => {
    const p = await plan(COMPANY_FEEDBACK_ALONE);
    expect(file(p, "src", "components", "FeedbackWidget.tsx")).toContain("<SiteFeedback clientKey={clientKey}>");
    const site = code(file(p, "src", "components", "SiteFeedback.tsx"));
    expect(site).toContain('const companyPage = pathname === "/t" || pathname.startsWith("/t/");');
    expect(site).toContain("if (companyPage) return <>{children}</>;");
  });

  it("M3: a company's screenshots are private with --storage, on their ticket; public only without it", async () => {
    const p = await plan(COMPANY_ALL);
    const files = code(file(p, "src", "server", "files.ts"));
    expect(files).toContain("feedbackScreenshotPurpose]");
    expect(files).toContain('...feedbackFileRecords(db, { ticketHref: "/app/feedback?ticket={id}" }),');
    expect(files).toContain('export const feedbackScreenshotStore: StoragePurposeStore | undefined = files.purposeStore("feedback.screenshot");');
    const glue = code(file(p, "src", "server", "feedback.ts"));
    expect(glue).toContain("return tenantId === FEEDBACK_PLATFORM_BOARD ? publicScreenshots : privateScreenshots;");
    expect(glue).toContain("record: { type: FEEDBACK_TICKET_RECORD, id: input.ticketId }");
    expect(file(p, "DEPLOYMENT.md")).toContain("### Feedback screenshots");
    expect(file(p, "DEPLOYMENT.md")).toContain("screenshots are kept PRIVATELY in the private Blob store");
    const noStorage = await plan({ ...COMPANY_ALL, includeStorage: false });
    expect(code(file(noStorage, "src", "server", "feedback.ts"))).not.toContain("privateScreenshots");
    expect(file(noStorage, "DEPLOYMENT.md")).toContain("this project was generated without private file storage");
  });

  it("M2: the keyless page builds no screenshot store, and a daily cron sweeps the unused ones", async () => {
    const p = await plan(COMPANY_FEEDBACK_ALONE);
    const glue = code(file(p, "src", "server", "feedback.ts"));
    const publicBuilder = glue.slice(glue.indexOf("export function buildFeedbackPublicHandlers"), glue.indexOf("async function admitIntake"));
    expect(publicBuilder).not.toContain("screenshots");
    expect(file(p, "app", "api", "cron", "feedback", "route.ts")).toContain("await sweepFeedbackScreenshots()");
    expect(JSON.parse(file(p, "vercel.json")).crons).toContainEqual({ path: "/api/cron/feedback", schedule: "30 14 * * *" });
    expect(file(p, "src", "env.ts")).toContain("CRON_SECRET");
  });

  it("M1: the intake is held to the package's counts on the shared limiter", async () => {
    for (const config of [COMPANY_FEEDBACK_ALONE, SINGLE_FEEDBACK]) {
      expect(code(file(await plan(config), "src", "server", "feedback.ts"))).toContain(
        "export const feedbackRateLimit = createFeedbackRateLimit(async (key, policy) => (await limiter.limit({ key, policy })).allowed);",
      );
    }
  });

  it("M4: a reply's sender is a display name or the business's name, never a sign-in address", async () => {
    const glue = code(file(await plan(COMPANY_FEEDBACK_ALONE), "src", "server", "feedback.ts"));
    expect(glue).toContain("db.select({ name: users.displayName })");
    expect(glue).not.toContain("users.email");
    expect(glue).toContain("teamName: (tenantId) => feedbackTeamName(tenantId),");
    expect(glue).toContain("return (await tenancy.companyProfile(tenantId))?.name ?? null;");
  });

  it("H1: upgrading tells the developer to use feedback's upgrade SQL, which keeps the site's own board", async () => {
    const deployment = file(await plan(COMPANY_FEEDBACK_ALONE), "DEPLOYMENT.md");
    expect(deployment).toContain("### From create-app 0.25 to 0.26 (a feedback board per business)");
    expect(deployment).toContain("node_modules/@adminigloo/feedback/sql/upgrade-0.9-to-0.10.sql");
  });
});
