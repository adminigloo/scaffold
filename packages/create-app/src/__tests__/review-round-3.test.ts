/**
 * Review round 3 (Tenancy 1): what a buyer's generated project proves about
 * itself, where round 3 found a proof that could be passed by the bug. Each
 * `describe` names the finding. The proofs themselves run in the generated
 * project's `pnpm test` (scripts/verify-generated.mjs, the generator matrix).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
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
const SINGLE = answers({ tenantNoun: "none", adminShell: "minimal" });

describe("TB2-01 (round 3): an OPTIONAL id can't pass the isolation proof as tenant-only", () => {
  it("reads every declared input off the parsers — optional, nested, arrays — and refuses another id-like one", async () => {
    const test = get(await planEmit(TEMPLATE_DIR, "/out", COMPANIES), "src", "server", "__tests__", "tenant-isolation.test.ts");
    expect(test).toContain('import { createScaffoldContext, inputFieldsOf, inventoryOf, looksLikeAnId, scopeOfProcedure } from "@adminigloo/trpc";');
    expect(test).toContain('const fields = inputFieldsOf(entry.procedure).filter((f) => f.path !== "tenantId");');
    expect(test).toContain("const extra = fields.filter((f) => !(f.segments[0]! in globals));");
    // Round 4 widened "id-like" to anything not explained in allow; an allowed field is never a row id.
    expect(test).toContain("const unexplained = extra.filter((f) => !(f.path in allow))");
    expect(test).toContain("looksLikeAnId(field?.key ?? path)");
    expect(test).toContain('is marked "tenant-only" but may also be given');
    // Queries are also asked with each of A's ids in every text input they may be given.
    expect(test).toContain("const probe = withField(input, field.segments, value);");
    expect(test).toContain("answered with A's rows");
  });
});

describe("TB2-10 (round 3): accepting by the link is proved through the project's own route", () => {
  for (const [label, a] of [["companies", COMPANIES], ["single-business", SINGLE]] as const) {
    it(`${label}: the test posts to app/api/tenancy/[...path]/route.ts, with Clerk as the only stand-in`, async () => {
      const test = get(await planEmit(TEMPLATE_DIR, "/out", a), "src", "server", "__tests__", "invite-accept-route.test.ts");
      expect(test).toContain('import { POST } from "../../../app/api/tenancy/[...path]/route";');
      // No handler built by hand with its own verifiedEmails: the route's wiring is what's under test.
      expect(test).not.toContain("buildTenancyHandlers(");
      expect(test).not.toContain("verifiedEmails:");
      expect(test).toContain('vi.mock("@clerk/nextjs/server"');
      expect(test).toContain('{ id: "idn_typed", emailAddress: PAT.typed, verification: { status: "unverified" } }');
      expect(test).toContain('expect(out.body.status).toBe("wrong-email");');
      expect(test).toContain('expect(out.body.status, "an invitation to a verified second address").toBe("accepted");');
      expect(test).toContain(label === "companies" ? "tenancy.createCompany(" : "personalWorkspaceId(ownerId)");
    });
  }

  it("the route the test imports is the one the project serves", async () => {
    const route = await readFile(join(TEMPLATE_DIR, "app", "api", "tenancy", "[...path]", "route.ts"), "utf8");
    expect(route).toContain("const { handle } = buildTenancyHandlers();");
    expect(route).toContain("export const POST = handle;");
  });
});

describe("TB2-09 (round 3): admin:grant names a database it can't reach", () => {
  it("passes the host and database to describeScriptFailure, which reads drizzle's cause; the script itself is run by a test", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", SINGLE);
    const grant = get(plan, "scripts", "admin-grant.ts");
    expect(grant).toContain("target = `${url.host}${url.pathname}`;");
    expect(grant).toContain("const described = describeScriptFailure(error, target);");
    expect(grant).not.toContain("fail(describeScriptFailure(error));");
    expect(get(plan, "src", "permissions", "seed.ts")).toContain("THE CAUSE CHAIN IS READ");
    const run = get(plan, "src", "permissions", "__tests__", "admin-grant-script.test.ts");
    expect(run).toContain('spawnSync(process.execPath, [TSX, "scripts/admin-grant.ts", "owner@example.com"]');
    expect(run).toContain('expect(out).toContain("Could not reach the database at 127.0.0.1:9/appdb.");');
  });
});
