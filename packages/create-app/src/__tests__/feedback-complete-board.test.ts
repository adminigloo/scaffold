/**
 * FEEDBACK 0.11, AS THE GENERATOR WRITES IT (create-app 0.27): the complete
 * board. The settings pages are the package's own screens, the glue lists the
 * right people for the assignee picker (a company's members; this site's
 * staff — never by sign-in address), and the emitted isolation proof plants
 * what the new routes take (a column's and a category's short name, an
 * assignee) and keeps A's activity trail in the snapshot that must not move.
 * Read from the PLAN as text; the generated project's own suite runs it.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES } from "../feature-proofs-emit.js";
import { packageVersions } from "../emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

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

const COMPANIES: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", includeFeedback: true };
const COMPANIES_ALL: Partial<Answers> = {
  ...COMPANIES,
  businessModel: "subscription",
  includeScheduling: true,
  includeEmail: true,
  includeComms: true,
  includeNotifications: true,
  includeStorage: true,
};
const SINGLE: Partial<Answers> = { tenantNoun: "none", adminShell: "full", includeFeedback: true };
const SINGLE_NO_SHELL: Partial<Answers> = { tenantNoun: "none", adminShell: "none", includeFeedback: true };

describe("the settings pages are package UI", () => {
  it("renders FeedbackSettingsPanel from the ./admin entry on both boards, and writes no settings component of its own", async () => {
    for (const config of [COMPANIES, COMPANIES_ALL, SINGLE, SINGLE_NO_SHELL]) {
      const p = await plan(config);
      expect(has(p, "src", "components", "FeedbackSettings.tsx"), JSON.stringify(config)).toBe(false);
      if (config.adminShell !== "none") {
        const platform = file(p, "app", "admin", "feedback", "settings", "page.tsx");
        expect(platform).toContain('import { FeedbackSettingsPanel } from "@adminigloo/feedback/admin";');
        expect(code(platform)).toContain('baseUrl="/api/admin/feedback"');
        expect(code(platform)).not.toContain("@/components/FeedbackSettings");
      } else {
        expect(has(p, "app", "admin", "feedback", "settings", "page.tsx")).toBe(false);
      }
    }
    const company = file(await plan(COMPANIES), "app", "(site)", "app", "feedback", "settings", "page.tsx");
    expect(company).toContain('import { FeedbackSettingsPanel } from "@adminigloo/feedback/admin";');
    expect(code(company)).toContain("baseUrl={`/api/app/${company.id}/feedback`}");
    expect(code(company)).toContain("publicPageUrl={companyLinksFor(company.slug).feedback}");
  });

  it("the boards stay the package's FeedbackWorkspace, filters and New ticket included", async () => {
    const p = await plan(COMPANIES);
    expect(file(p, "app", "(site)", "app", "feedback", "page.tsx")).toContain("<FeedbackWorkspace");
    expect(file(p, "app", "admin", "feedback", "page.tsx")).toContain("<FeedbackWorkspace");
  });
});

describe("the glue lists the right people", () => {
  it("a company's board: its active members; this site's board: its staff — by display name, never a sign-in address", async () => {
    const glue = file(await plan(COMPANIES), "src", "server", "feedback.ts");
    const body = code(glue);
    expect(body).toContain("listPeople: (tenantId) => companyPeople(tenantId),");
    expect(body).toContain("listPeople: () => staffPeople(),");
    expect(body).toContain('eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.status, "active"), isNull(users.deletedAt)');
    expect(body).toContain("if (tenantId === FEEDBACK_PLATFORM_BOARD) return staffPeople();");
    expect(body).toContain('eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE)');
    expect(body).not.toContain("users.email");
  });

  it("a single business: only this site's staff, and no company tables", async () => {
    for (const config of [SINGLE, SINGLE_NO_SHELL]) {
      const glue = code(file(await plan(config), "src", "server", "feedback.ts"));
      expect(glue).toContain("listPeople: () => staffPeople(),");
      expect(glue).not.toContain("tenantMembers");
      expect(glue).not.toContain("companyPeople");
      expect(glue).not.toContain("users.email");
    }
  });
});

describe("the isolation proof drives the new routes", () => {
  it("plants the values the new routes take, assigns and files A's ticket, and snapshots A's trail", async () => {
    expect(FEATURE_ENTITIES.feedback).toEqual(
      expect.arrayContaining(["ticket", "column", "category", "feedback-key", "ticket-number", "ticket-token", "column-key", "category-key", "assignee"]),
    );
    const p = await plan(COMPANIES_ALL);
    const rows = file(p, "src", "test", "company-rows.ts");
    expect(rows).toContain('rows["column-key"] = column.key;');
    expect(rows).toContain('rows["category-key"] = category.key;');
    expect(rows).toContain("rows.assignee = `${label}-assignee`;");
    expect(rows).toContain("{ ticketId: report.id, category: category.key, assignee: { id: rows.assignee, name: `${Label} Assignee` } },");
    expect(rows).toMatch(/import \{[^}]*updateTicket,[^}]*\} from "@adminigloo\/feedback";/);
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("feedback_ticket_events: await all(sql`select * from feedback_ticket_events where tenant_id = ${a} order by id`),");
    expect(proof).toContain("adminRoutes: FEEDBACK_ADMIN_ROUTES,");
  });

  it("a single business has no company proof to plant for, and still generates", async () => {
    const p = await plan(SINGLE);
    expect(has(p, "src", "test", "company-rows.ts")).toBe(false);
  });
});

describe("the release", () => {
  it("pins feedback 0.11.0, whose ./admin entry and listPeople the emitted code uses", () => {
    expect(packageVersions()["feedback"] ?? "").toMatch(/^\^?0\.11\.0$/);
  });

  it("the README says what the boards do now and what's next, and DEPLOYMENT says how to get there from 0.26", async () => {
    const p = await plan(COMPANIES);
    const readme = file(p, "README.md");
    expect(readme).toContain("**New ticket** for the team");
    expect(readme).toContain("**Epics** (grouping tickets under a bigger piece of work) — the next release of the feedback board.");
    expect(readme).not.toContain("src/components/FeedbackSettings.tsx");
    const deployment = file(p, "DEPLOYMENT.md");
    expect(deployment).toContain("### From create-app 0.26 to 0.27 (the complete feedback board)");
    expect(deployment).toContain("node_modules/@adminigloo/feedback/sql/upgrade-0.10-to-0.11.sql");
  });
});

describe("the 0.11 review's fixes, as generated", () => {
  it("the reply box is told, per variant, whether a company's board emails its reporters; this site's own never does", async () => {
    const withComms = file(await plan(COMPANIES_ALL), "src", "server", "feedback.ts");
    const without = file(await plan(COMPANIES), "src", "server", "feedback.ts");
    expect(code(withComms)).toContain("export const FEEDBACK_EMAILS_REPORTERS = true;");
    expect(code(without)).toContain("export const FEEDBACK_EMAILS_REPORTERS = false;");
    const companyBoard = file(await plan(COMPANIES), "app", "(site)", "app", "feedback", "page.tsx");
    expect(companyBoard).toContain('import { FEEDBACK_EMAILS_REPORTERS } from "@/server/feedback";');
    expect(companyBoard).toContain("emailsReporters={FEEDBACK_EMAILS_REPORTERS}");
    for (const config of [COMPANIES, SINGLE]) {
      expect(file(await plan(config), "app", "admin", "feedback", "page.tsx")).toContain("emailsReporters={false}");
    }
    // A single business has no company board, and no such constant.
    expect(code(file(await plan(SINGLE), "src", "server", "feedback.ts"))).not.toContain("FEEDBACK_EMAILS_REPORTERS");
  });

  it("the isolation proof's snapshot holds A's board-set-up mark", async () => {
    const proof = file(await plan(COMPANIES_ALL), "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("feedback_boards: await all(sql`select * from feedback_boards where tenant_id = ${a}`),");
  });
});
