/**
 * FEEDBACK 0.12, AS THE GENERATOR WRITES IT (create-app 0.28): epics. Each
 * company's epics at /app/feedback/epics (and /{id}) and this site's own at
 * /admin/feedback/epics, as thin pages over @adminigloo/feedback/epics on the
 * board's own keys; nav entries for both; the boards link to them; and the
 * emitted isolation proof plants an epic (with A's ticket in it) so every
 * epic route — read straight from the package's route table — is driven with
 * A's epic from B, and A's ticket into B's epic in the mixed pass. Read from
 * the PLAN as text; the generated project's own suite runs it.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, packageVersions, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES } from "../feature-proofs-emit.js";
import { FEEDBACK_2B2A_NOT_INCLUDED } from "../readme-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-epics", ...overrides };
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

const COMPANIES: Partial<Answers> = {
  tenantNoun: "Company",
  businessModel: "subscription",
  adminShell: "full",
  includeFeedback: true,
  includeEmail: true,
  includeComms: true,
  includeNotifications: true,
};
const SINGLE: Partial<Answers> = { tenantNoun: "none", adminShell: "full", includeFeedback: true };
const SINGLE_NO_SHELL: Partial<Answers> = { tenantNoun: "none", adminShell: "none", includeFeedback: true };
const NO_FEEDBACK: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", includeFeedback: false };

const COMPANY_LIST = ["app", "(site)", "app", "feedback", "epics", "page.tsx"] as const;
const COMPANY_ONE = ["app", "(site)", "app", "feedback", "epics", "[id]", "page.tsx"] as const;
const SITE_LIST = ["app", "admin", "feedback", "epics", "page.tsx"] as const;
const SITE_ONE = ["app", "admin", "feedback", "epics", "[id]", "page.tsx"] as const;

describe("the epics pages", () => {
  it("a company's: thin pages over FeedbackEpics / FeedbackEpic on its own routes, gated on feedback.view, changes on feedback.manage", async () => {
    const p = await plan(COMPANIES);
    const list = file(p, ...COMPANY_LIST);
    expect(list).toContain('import { FeedbackEpics } from "@adminigloo/feedback/epics";');
    const listCode = code(list);
    expect(listCode).toContain('<CompanyGate path="/app/feedback/epics" permission="feedback.view">');
    expect(listCode).toContain("baseUrl={`/api/app/${company.id}/feedback`}");
    expect(listCode).toContain('canManage={can.includes("feedback.manage")}');
    expect(listCode).toContain('epicsHref="/app/feedback/epics"');
    const one = code(file(p, ...COMPANY_ONE));
    expect(file(p, ...COMPANY_ONE)).toContain('import { FeedbackEpic } from "@adminigloo/feedback/epics";');
    expect(one).toContain('<CompanyGate path={`/app/feedback/epics/${encodeURIComponent(id)}`} permission="feedback.view">');
    expect(one).toContain("epicId={id}");
    // No package code copied into the project: the pages are a few lines.
    for (const source of [list, file(p, ...COMPANY_ONE)]) expect(source.split("\n").length).toBeLessThan(60);
  });

  it("this site's own: over /api/admin/feedback, on the staff keys", async () => {
    for (const config of [COMPANIES, SINGLE]) {
      const p = await plan(config);
      const list = code(file(p, ...SITE_LIST));
      expect(list).toContain('baseUrl="/api/admin/feedback"');
      expect(list).toContain('can?.can("staff.feedback.view")');
      expect(list).toContain('canManage={can.can("staff.feedback.manage")}');
      const one = code(file(p, ...SITE_ONE));
      expect(one).toContain("epicId={id}");
      expect(one).toContain('epicsHref="/admin/feedback/epics"');
    }
  });

  it("a single business has no company epics pages; no admin shell, no site pages; no feedback, none at all", async () => {
    expect(has(await plan(SINGLE), ...COMPANY_LIST)).toBe(false);
    const bare = await plan(SINGLE_NO_SHELL);
    expect(has(bare, ...SITE_LIST)).toBe(false);
    expect(has(bare, ...COMPANY_LIST)).toBe(false);
    const none = await plan(NO_FEEDBACK);
    for (const path of [COMPANY_LIST, COMPANY_ONE, SITE_LIST, SITE_ONE]) expect(has(none, ...path)).toBe(false);
  });

  it("the boards link to their epics", async () => {
    const p = await plan(COMPANIES);
    expect(code(file(p, "app", "(site)", "app", "feedback", "page.tsx"))).toContain('epicsHref="/app/feedback/epics"');
    expect(code(file(p, "app", "admin", "feedback", "page.tsx"))).toContain('epicsHref="/admin/feedback/epics"');
  });

  it("emits no runtime `if` about an answer in the pages", async () => {
    const p = await plan(COMPANIES);
    for (const path of [COMPANY_LIST, COMPANY_ONE, SITE_LIST, SITE_ONE]) {
      expect(code(file(p, ...path))).not.toMatch(/\bif \((answers|ANSWERS|includeFeedback|tenantNoun)/);
    }
  });
});

describe("nav entries", () => {
  it("a company's Epics link on feedback.view, and this site's under Feedback on staff.feedback.view", async () => {
    const p = await plan(COMPANIES);
    const everything = [...p.files.values()].join("\n");
    expect(everything).toContain('"/app/feedback/epics"');
    expect(everything).toContain('"/admin/feedback/epics"');
    const single = [...(await plan(SINGLE)).files.values()].join("\n");
    expect(single).not.toContain('"/app/feedback/epics"');
    expect(single).toContain('"/admin/feedback/epics"');
  });
});

describe("the isolation proof drives the epic routes", () => {
  it("plants an epic led by A's person with A's ticket in it, and snapshots A's epics", async () => {
    expect(FEATURE_ENTITIES.feedback).toContain("epic");
    const p = await plan(COMPANIES);
    const rows = file(p, "src", "test", "company-rows.ts");
    expect(rows).toMatch(/import \{[^}]*createEpic,[^}]*setEpicTickets,[^}]*\} from "@adminigloo\/feedback";/);
    expect(rows).toContain("rows.epic = epic.id;");
    expect(rows).toContain("await setEpicTickets(database, tenantId, epic.id, { add: [report.id] }");
    expect(rows).toContain("owner: { id: rows.assignee, name: `${Label} Assignee` }");
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("feedback_epics: await all(sql`select * from feedback_epics where tenant_id = ${a} order by id`),");
    // The routes come from the package's table, so the epic routes are driven the day they ship.
    expect(proof).toContain("adminRoutes: FEEDBACK_ADMIN_ROUTES,");
  });

  it("works with --tenant-noun none (no company proof to plant for)", async () => {
    const p = await plan(SINGLE);
    expect(has(p, "src", "test", "company-rows.ts")).toBe(false);
    expect(has(p, ...SITE_LIST)).toBe(true);
  });
});

describe("the release", () => {
  it("pins feedback 0.12.0, whose ./epics entry the pages import", () => {
    expect(packageVersions()["feedback"] ?? "").toMatch(/^\^?0\.12\.0$/);
  });

  it("the README says what the epics do and what isn't included; DEPLOYMENT says how to get there from 0.27", async () => {
    const p = await plan(COMPANIES);
    const readme = file(p, "README.md");
    expect(readme).toContain("**Its epics** (/app/feedback/epics)");
    expect(readme).toContain("epics at /admin/feedback/epics");
    for (const item of FEEDBACK_2B2A_NOT_INCLUDED) expect(readme).toContain(item);
    expect(readme).not.toContain("the next release of the feedback board");
    const deployment = file(p, "DEPLOYMENT.md");
    expect(deployment).toContain("### From create-app 0.27 to 0.28 (epics on the feedback boards)");
    expect(deployment).toContain("node_modules/@adminigloo/feedback/sql/upgrade-0.11-to-0.12.sql");
  });
});
