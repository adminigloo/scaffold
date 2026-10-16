import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createCompanyRouteSeams, createPublicCompanySeams, type CompanyPlanGate } from "../server.js";
import { harness, type Harness } from "./harness.js";

/**
 * Billing 0.3: the company's plan at tenancy's two checkpoints. The gate is
 * a fake here (billing's own suite proves the standing); what's proved is
 * that the seams ask it, in the right order, and answer in plain words.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function company(name = "Summit Window Co") {
  const word = name.split(" ")[0]!.toLowerCase();
  const owner = await h.user(`owner@${word}.test`);
  const member = await h.user(`member@${word}.test`);
  const tenantId = await h.company(owner, name, { [member]: "member" });
  return { tenantId, owner, member };
}

function gate(closed: Set<string>, asked: string[] = []): CompanyPlanGate {
  return {
    allows: async (t, p) => (asked.push(`${t}:${p}`), !closed.has(t) || p.endsWith(".view")),
    isOpen: async (t) => !closed.has(t),
    closedMessage: async () => "This company's plan has ended. An owner can choose a plan in Billing to keep using this.",
  };
}

const req = (tenantId: string, userId: string | null) =>
  new Request(`https://app.test/api/app/${tenantId}/x`, { headers: userId ? { "x-test-user": userId } : {} });
const principal = async (r: Request) => {
  const userId = r.headers.get("x-test-user");
  return userId ? { userId } : null;
};

describe("createCompanyRouteSeams with a plan", () => {
  it("an open plan changes nothing; a closed one refuses work with the gate's sentence and keeps reading open", async () => {
    h = await harness();
    const a = await company();
    const closed = new Set<string>();
    const seams = createCompanyRouteSeams({ tenancy: h.tenancy, principal, plan: gate(closed) });
    expect(await seams.authorize(req(a.tenantId, a.owner), "tenant.edit", a.tenantId)).toEqual({ userId: a.owner });

    closed.add(a.tenantId);
    const refused = (await seams.authorize(req(a.tenantId, a.owner), "tenant.edit", a.tenantId)) as Response;
    expect(refused).toBeInstanceOf(Response);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: { code: "forbidden", message: "This company's plan has ended. An owner can choose a plan in Billing to keep using this." },
    });
    expect(await seams.authorize(req(a.tenantId, a.owner), "tenant.view", a.tenantId)).toEqual({ userId: a.owner });
  });

  it("the plan is asked only for a member who holds the permission: strangers and the signed-out learn nothing about it", async () => {
    h = await harness();
    const a = await company();
    const stranger = await h.user("stranger@else.test");
    const asked: string[] = [];
    const seams = createCompanyRouteSeams({ tenancy: h.tenancy, principal, plan: gate(new Set([a.tenantId]), asked) });
    expect(((await seams.authorize(req(a.tenantId, null), "tenant.edit", a.tenantId)) as Response).status).toBe(401);
    const notPart = (await seams.authorize(req(a.tenantId, stranger), "tenant.edit", a.tenantId)) as Response;
    expect(((await notPart.json()) as { error: { message: string } }).error.message).toBe("You're not part of this company.");
    // A member without the permission gets the ordinary "no", not the plan's sentence.
    expect(await seams.authorize(req(a.tenantId, a.member), "tenant.edit", a.tenantId)).toBe(false);
    expect(asked).toEqual([]);
  });

  it("company A's closed plan never closes company B", async () => {
    h = await harness();
    const a = await company("Summit Window Co");
    const b = await company("Green Acres");
    const seams = createCompanyRouteSeams({ tenancy: h.tenancy, principal, plan: gate(new Set([a.tenantId])) });
    expect(await seams.authorize(req(b.tenantId, b.owner), "tenant.edit", b.tenantId)).toEqual({ userId: b.owner });
  });
});

describe("createPublicCompanySeams with a plan", () => {
  it("a closed plan closes the public pages in the same words as a suspended company; an open one stays open", async () => {
    h = await harness();
    const a = await company();
    await h.tenancy.updateSettings({ actorUserId: a.owner, tenantId: a.tenantId, section: "company", values: { contactPhone: "555 0100" } });
    const closed = new Set<string>([a.tenantId]);
    const seams = createPublicCompanySeams({ tenancy: h.tenancy, plan: gate(closed) });
    const { slug } = (await h.db.execute(sql`select slug from tenants where id = ${a.tenantId}`)).rows[0] as { slug: string };
    const r = new Request(`https://app.test/api/t/${slug}/booking/slots`);
    expect(await seams.resolveTenant(r)).toBe(a.tenantId);
    expect(await seams.admit(a.tenantId, r)).toEqual({ open: false, message: "Summit Window Co isn't taking requests online right now. Call 555 0100." });
    // An embed-key request (no address on it) is closed too.
    expect((await seams.admit(a.tenantId, new Request("https://app.test/api/estimator/estimates"))).open).toBe(false);
    // The links it already sent stay open (review M5): its customers can still accept, reschedule and pay.
    for (const path of ["estimator/v1/quote/tok123/accept", "scheduling/v1/visit/tok123", "invoicing/v1/invoice/tok123"]) {
      expect(await seams.admit(a.tenantId, new Request(`https://app.test/api/t/${slug}/${path}`)), path).toEqual({ open: true });
    }
    expect((await seams.admit(a.tenantId, new Request(`https://app.test/api/t/${slug}/estimator/v1/submit`))).open).toBe(false);
    closed.clear();
    expect(await seams.admit(a.tenantId, new Request(`https://app.test/api/t/${slug}/booking/slots`))).toEqual({ open: true });
  });
});
