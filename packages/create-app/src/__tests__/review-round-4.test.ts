/**
 * Review round 4 (Tenancy 1): what a buyer's generated project proves about
 * itself, where round 4 found a proof that could be passed by the bug, or a
 * sentence that could say something untrue. Each `describe` names the
 * finding. The proofs themselves run in the generated project's `pnpm test`
 * (scripts/verify-generated.mjs, the generator matrix).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { TENANT_PROCEDURES } from "../tenancy-proofs-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "lawnco", ...overrides };
}

function get(plan: EmitPlan, ...segments: string[]): string {
  const contents = plan.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

const COMPANIES = answers({ tenantNoun: "Company", adminShell: "full", includeEmail: true });
const SINGLE = answers({ tenantNoun: "none", adminShell: "minimal", includeEmail: false });

describe("SEC-T1-B (round 4): 'We emailed' only about an email that went, in the project's own wiring", () => {
  for (const [label, a] of [["companies, with email", COMPANIES], ["single-business, no email package", SINGLE]] as const) {
    it(`${label}: the handlers get a mailer only when the project can send, and a test proves skipped/failed/throws are never held`, async () => {
      const plan = await planEmit(TEMPLATE_DIR, "/out", a);
      const handlers = get(plan, "src", "server", "tenancy-handlers.ts");
      expect(handlers).toContain("...(invitationEmailsConfigured ? { deliverInvitation } : {}),");
      const mail = get(plan, "src", "server", "invitation-mail.ts");
      expect(mail).toMatch(/export const invitationEmailsConfigured: boolean = (sender\.configured|false);/);

      const test = get(plan, "src", "server", "__tests__", "invite-email-route.test.ts");
      // Through THIS project's handlers and mailer module, never the package's with a stand-in.
      expect(test).toContain('import { buildTenancyHandlers } from "@/server/tenancy-handlers";');
      expect(test).toContain('vi.mock("@/server/invitation-mail", async (importOriginal) => {');
      expect(test).toContain("        mail.projectAsked += 1;\n        return actual.sendInvitationEmail(request);");
      // Nothing real is ever sent from a test run, whatever .env.local says.
      expect(test).toContain('if (prop === "RESEND_API_KEY") return undefined;');
      expect(test).toContain('for (const outcome of ["skipped", "failed", "throws"] as const) {');
      expect(test).toContain('expect(out.note ?? "").not.toMatch(/We emailed/);');
      // …and a project that can't send isn't even handed a mailer.
      expect(test).toContain("expect(mail.projectAsked).toBe(0);");
      expect(test).toContain("expect(held.note).toContain(`We emailed ${address} less than a minute ago`);");
      expect(test).toContain(a === COMPANIES ? "tenancy.createCompany(" : "personalWorkspaceId(ownerId)");
      // What .env.local says about a missing key stays true for invitations: they aren't logged as skipped sends.
      const env = [...plan.files.entries()].filter(([path]) => path.includes(".env")).map(([, text]) => text).join("\n");
      if (a.includeEmail) expect(env).toContain("# mailer at all then: the team page gives the inviter the link to send.");
    });
  }
});

describe("TB2-01 (round 4): a tenant-only procedure takes nothing it can't explain, and is asked with everything of A's", () => {
  it("probes queries with every string that identifies A — ids, addresses, names, web address — in every text input", async () => {
    const test = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain("const probes = [...new Set([...fx.aStrings, ...Object.values(fx.aRows)])].filter((s) => s.length > 0);");
    expect(test).toContain("for (const value of probes) {");
    expect(test).not.toContain("const aIds = [");
    // aStrings carries A's people's addresses and names, its name and its web address.
    for (const s of ["fx.A.email,", "fx.A2.email,", '"pat.pending@alpha-lawn.test",', "fx.A.name,", "a.name,", "a.slug,"]) expect(test).toContain(s);
  });

  it("refuses ANY other input, mutations included, unless allow names it with a reason — and an allowed one is never a row's id", async () => {
    const test = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain("const unexplained = extra.filter((f) => !(f.path in allow))");
    // The check sits outside the query-only branch: mutations are held to it too.
    const unexplainedAt = test.indexOf("const unexplained = ");
    const queryBranch = test.indexOf('if (type === "query") {');
    const queryBranchEnd = test.indexOf("// Queries and mutations alike: NOTHING else");
    expect(queryBranch).toBeGreaterThan(0);
    expect(unexplainedAt).toBeGreaterThan(queryBranchEnd);
    expect(test).toContain("without saying why`).toBeGreaterThanOrEqual(10);");
    expect(test).toContain("which it doesn't take: take it out of allow");
    expect(test).toContain('but that names a row: a procedure that may be given a row\'s id is a "by-id" case');
  });

  it("the template's own procedures say why each extra input is safe — a number, a flag or a fixed choice, never an id", async () => {
    const withExtras = TENANT_PROCEDURES.filter((p) => p.allow);
    expect(withExtras.map((p) => p.path).sort()).toEqual(["account.invoices", "ai.spend", "billing.changePlan", "billing.simulateSubscription"]);
    for (const p of withExtras) {
      for (const [field, why] of Object.entries(p.allow!)) {
        expect(why.length, `${p.path}.${field}`).toBeGreaterThanOrEqual(10);
        expect(field, `${p.path}.${field}`).not.toMatch(/(^id$|Id$|_id$|ids?$)/i);
      }
    }
    const test = get(await planEmit(TEMPLATE_DIR, "/out", answers({ businessModel: "both", includeAi: true })), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain('days: "a number of days to look back over the caller\'s own company\'s spend; it names no row",');
    expect(test).toContain('limit: "a page size (1-24) over the caller\'s own company\'s invoices; it names no row",');
    expect(test).toContain("cancelAtPeriodEnd:");
    // The template's overlays declare exactly these: a router that grows a new input fails the project's proof.
    const ai = await readFile(join(TEMPLATE_DIR, "..", "overlays", "ai", "src", "server", "routers", "ai.ts"), "utf8");
    expect(ai).toContain("days: z.number().int().min(1).max(366).default(30),");
    const account = await readFile(join(TEMPLATE_DIR, "..", "overlays", "account", "src", "server", "routers", "account.ts"), "utf8");
    expect(account).toContain(".input(z.object({ limit: z.number().int().min(1).max(24).default(6) }))");
  });
});

describe("TB2-09 (round 4): 'could not reach the database' only from a network error's code", () => {
  it("seed.ts classifies by code through every cause, and reports a failed query without the query or its parameters", async () => {
    const seed = get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "src", "permissions", "seed.ts");
    expect(seed).not.toContain("CONNECTION_FAILURE");
    expect(seed).not.toMatch(/\/[^/\n]*\|connect\|[^/\n]*\/i/);
    expect(seed).toContain("const UNREACHABLE_CODES: ReadonlySet<string> = new Set([");
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "08006"]) {
      expect(seed).toContain(`"${code}",`);
    }
    expect(seed).toContain("queue.push(o.cause, o.error, o.sourceError);");
    expect(seed).toContain("A query on the database");
    const unit = get(await planEmit(TEMPLATE_DIR, "/out", SINGLE), "src", "permissions", "__tests__", "script-failure.test.ts");
    expect(unit).toContain('["connect@acme.test"]');
    expect(unit).toContain("/app/node_modules/pg/lib/connection.js");
  });
});
