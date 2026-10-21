import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { describeTenancyAuditEntry } from "../index.js";
import { TENANCY_OPERATOR_ROUTES, type CompanyDeletion, type TenancyEvent } from "../server.js";
import { call, codeOf, handlersFor, harness, jsonOf, type Harness } from "./harness.js";

/**
 * DELETE A COMPANY (tenancy 0.8): staff only, the web address typed again,
 * never the site's own, a company still paying refused unless forced with a
 * reason — and then everything of that company goes in one transaction (the
 * project's forget step, tenancy's own rows), its row is emptied and kept so
 * its address stays reserved, and one audit row outlives it. The other
 * company is untouched throughout.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

interface Calls {
  forgot: string[];
  after: string[];
  paying: string | null;
  failForget: boolean;
}

function deletionFor(calls: Calls): CompanyDeletion {
  return {
    async forget(tx, tenantId) {
      calls.forgot.push(tenantId);
      // A package's rows, on the deletion's own transaction.
      await tx.execute(sql`delete from widget_rows where tenant_id = ${tenantId}`);
      if (calls.failForget) throw new Error("a package's forget failed");
      return { counts: { widget_rows: 2, empty_table: 0 }, afterCommit: async () => void calls.after.push(tenantId) };
    },
    async livePaidSubscription() {
      return calls.paying;
    },
  };
}

async function world(calls: Calls, events: TenancyEvent[] = []) {
  h = await harness({ deletion: deletionFor(calls), onEvent: (e) => void events.push(e) });
  await h.db.execute(sql`create table widget_rows (id text primary key, tenant_id text not null)`);
  const ava = await h.user("ava@igloo.test", { name: "Ava" });
  await h.staff(ava, "admin");
  const olivia = await h.user("olivia@summit.test", { name: "Olivia" });
  const sam = await h.user("sam@summit.test", { name: "Sam" });
  const bea = await h.user("bea@beta.test", { name: "Bea" });
  const summit = await h.company(olivia, "Summit Window Co.", { [sam]: "member" });
  const beta = await h.company(bea, "Beta Plumbing");
  for (const [id, t] of [["w1", summit], ["w2", summit], ["w3", beta]] as const) {
    await h.db.execute(sql`insert into widget_rows (id, tenant_id) values (${id}, ${t})`);
  }
  await h.tenancy.sendInvitation({ actorUserId: olivia, tenantId: summit, email: "rae@x.test", roleKey: "member" });
  await h.tenancy.sendInvitation({ actorUserId: bea, tenantId: beta, email: "kim@x.test", roleKey: "member" });
  await h.tenancy.updateCompanyProfile({ actorUserId: olivia, tenantId: summit, slug: "summit-windows" });
  await h.tenancy.setActiveCompany({ userId: sam, tenantId: summit });
  return { ava, olivia, sam, bea, summit, beta };
}

async function count(table: string, tenantId: string): Promise<number> {
  const r = await h.db.execute(sql`select count(*)::int as n from ${sql.raw(table)} where tenant_id = ${tenantId}`);
  return Number((r.rows[0] as { n: number }).n);
}

async function companyCounts(tenantId: string) {
  return {
    members: await count("tenant_members", tenantId),
    invitations: await count("tenant_invitations", tenantId),
    slugChanges: await count("tenant_slug_changes", tenantId),
    roles: await count("principal_role", tenantId),
    widgets: await count("widget_rows", tenantId),
  };
}

describe("deleteCompany: who may, and what must be typed", () => {
  it("non-staff → not_staff; staff without staff.tenants.delete → forbidden; nothing changes", async () => {
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: false };
    const w = await world(calls);
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: w.olivia, tenantId: w.summit, confirmSlug: "summit-windows" }))).toBe("not_staff");
    const lead = await h.user("lead@igloo.test");
    await h.staff(lead, "cs_lead");
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: lead, tenantId: w.summit, confirmSlug: "summit-windows" }))).toBe("forbidden");
    expect(calls.forgot).toEqual([]);
    expect((await companyCounts(w.summit)).members).toBe(2);
  });

  it("the web address must be typed exactly (case and spaces aside); the old address or the name won't do", async () => {
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: false };
    const w = await world(calls);
    for (const typed of ["", "summit", "summit-window-co", "Summit Window Co."]) {
      const error = await h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: typed }).catch((e: unknown) => e);
      expect((error as { code: string }).code, typed).toBe("confirmation_mismatch");
      expect((error as Error).message).toContain("summit-windows");
    }
    expect(calls.forgot).toEqual([]);
    await h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: "  SUMMIT-windows " });
    expect(calls.forgot).toEqual([w.summit]);
  });

  it("never the site's own records (\"*\"), an unknown id or an already-deleted company", async () => {
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: false };
    const w = await world(calls);
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: "*", confirmSlug: "*" }))).toBe("not_found");
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: "nope", confirmSlug: "nope" }))).toBe("not_found");
    await h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.beta, confirmSlug: "beta-plumbing" });
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.beta, confirmSlug: "beta-plumbing" }))).toBe("not_found");
    expect(calls.forgot).toEqual([w.beta]);
  });

  it("without the project's forget step it is unavailable, and the console offers no Delete", async () => {
    h = await harness();
    const ava = await h.user("ava@igloo.test");
    await h.staff(ava, "admin");
    const o = await h.user("o@x.test");
    const id = await h.company(o, "Lone Co");
    expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: ava, tenantId: id, confirmSlug: "lone-co" }))).toBe("unavailable");
    const d = await h.tenancy.getCompanyDetail({ actorUserId: ava, tenantId: id });
    expect(d.can.delete).toBe(false);
    expect(d.deletion).toEqual({ available: false, stillPaying: null });
  });
});

describe("deleteCompany: a company still paying", () => {
  it("is refused with still_paying, naming the plan; the detail warns before anyone types", async () => {
    const calls: Calls = { forgot: [], after: [], paying: "Pro, active", failForget: false };
    const w = await world(calls);
    const d = await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit });
    expect(d.can.delete).toBe(true);
    expect(d.deletion).toEqual({ available: true, stillPaying: "Pro, active" });
    const error = await h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: "summit-windows" }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("still_paying");
    expect((error as Error).message).toBe("Summit Window Co. is still paying for Pro, active. Cancel it first, or delete anyway and say why.");
    expect(calls.forgot).toEqual([]);
  });

  it("forced, it needs a reason of 3 to 500 characters, and the audit row keeps it", async () => {
    const calls: Calls = { forgot: [], after: [], paying: "Pro, active", failForget: false };
    const w = await world(calls);
    for (const reason of ["", "no", "x".repeat(501)]) {
      expect(await codeOf(h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: "summit-windows", force: { reason } }))).toBe(
        "invalid",
      );
    }
    const out = await h.tenancy.deleteCompany({
      actorUserId: w.ava,
      tenantId: w.summit,
      confirmSlug: "summit-windows",
      force: { reason: "Owner asked by phone; refunded in Stripe" },
    });
    expect(out.forced).toBe(true);
    expect(h.audit.find((a) => a.action === "company.deleted")?.metadata).toMatchObject({
      forced: true,
      reason: "Owner asked by phone; refunded in Stripe",
      stillPaying: "Pro, active",
    });
    const words = describeTenancyAuditEntry("company.deleted", h.audit.find((a) => a.action === "company.deleted")?.metadata) ?? "";
    expect(words.startsWith("Summit Window Co. (/summit-windows): ")).toBe(true);
    expect(words.endsWith(" records removed. Deleted while still paying: Owner asked by phone; refunded in Stripe")).toBe(true);
  });
});

describe("deleteCompany: what goes and what stays", () => {
  it("forgets the company's team, invitations, address history and its packages' rows — and nothing of the other company", async () => {
    const events: TenancyEvent[] = [];
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: false };
    const w = await world(calls, events);
    const betaBefore = await companyCounts(w.beta);
    expect(await companyCounts(w.summit)).toMatchObject({ members: 2, invitations: 1, slugChanges: 1, widgets: 2 });
    h.clock.now = new Date("2026-10-20T09:30:00.000Z");
    const out = await h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: "summit-windows" });

    expect(await companyCounts(w.summit)).toEqual({ members: 0, invitations: 0, slugChanges: 0, roles: 2, widgets: 0 });
    expect(await companyCounts(w.beta)).toEqual(betaBefore);
    expect(out).toMatchObject({ id: w.summit, name: "Summit Window Co.", slug: "summit-windows", forced: false });
    expect(out.deletedAt.toISOString()).toBe("2026-10-20T09:30:00.000Z");
    // The package's count is kept (its zero tables dropped); tenancy's own are added.
    expect(out.counts).toEqual({ widget_rows: 2, tenant_members: 2, tenant_invitations: 1, tenant_slug_changes: 1 });
    expect(out.rows).toBe(6);

    // The row stays, emptied and marked; its addresses stay reserved; the console no longer lists it.
    const row = (await h.db.execute(sql`select deleted_at, owner_user_id, branding, settings, slug from tenants where id = ${w.summit}`)).rows[0] as Record<
      string,
      unknown
    >;
    expect(row["deleted_at"]).not.toBeNull();
    expect(row).toMatchObject({ owner_user_id: null, branding: {}, settings: {}, slug: "summit-windows" });
    expect(await count("tenant_retired_slugs", w.summit)).toBe(1);
    expect((await h.tenancy.checkSlug({ actorUserId: w.bea, slug: "summit-windows" })).available).toBe(false);
    expect((await h.tenancy.checkSlug({ actorUserId: w.bea, slug: "summit-window-co" })).available).toBe(false);
    expect(await h.tenancy.resolveCompanyBySlug("summit-windows")).toBeNull();
    expect((await h.tenancy.listCompanies({ actorUserId: w.ava })).companies.map((c) => c.name)).toEqual(["Beta Plumbing"]);

    // Nobody's current company points at it any more; its people have no way in.
    const active = await h.db.execute(sql`select count(*)::int as n from users where active_tenant_id = ${w.summit}`);
    expect(Number((active.rows[0] as { n: number }).n)).toBe(0);
    expect((await h.tenancy.resolveSession({ userId: w.sam })).state).toBe("needs-onboarding");

    // One audit row, staff-scoped, with who, when, the name and the counts.
    const audit = h.audit.filter((a) => a.action === "company.deleted");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: w.ava,
      scope: "staff",
      tenantId: w.summit,
      metadata: { name: "Summit Window Co.", slug: "summit-windows", rows: 6, counts: out.counts },
    });
    // In words on the audit log: what went.
    expect(describeTenancyAuditEntry("company.deleted", audit[0]!.metadata)).toBe("Summit Window Co. (/summit-windows): 6 records removed");

    // After the commit: the event, then the files' step.
    await h.tenancy.settleEvents();
    expect(events.filter((e) => e.type === "company.deleted")).toMatchObject([{ tenantId: w.summit, by: w.ava }]);
    expect(calls.after).toEqual([w.summit]);
  });

  it("is all or nothing: a package's forget failing leaves every row as it was, with no audit row", async () => {
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: true };
    const w = await world(calls);
    const before = await companyCounts(w.summit);
    await expect(h.tenancy.deleteCompany({ actorUserId: w.ava, tenantId: w.summit, confirmSlug: "summit-windows" })).rejects.toThrow(
      "a package's forget failed",
    );
    expect(await companyCounts(w.summit)).toEqual(before);
    expect(h.audit.some((a) => a.action === "company.deleted")).toBe(false);
    expect(calls.after).toEqual([]);
    expect((await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit })).company.name).toBe("Summit Window Co.");
  });

  it("a files step that fails after the commit is reported, and the deletion stands", async () => {
    const reported: string[] = [];
    h = await harness({
      deletion: {
        forget: async () => ({
          counts: {},
          afterCommit: async () => {
            throw new Error("blob store down");
          },
        }),
      },
      onEventError: (_e, event) => void reported.push(event.type),
    });
    const ava = await h.user("ava@igloo.test");
    await h.staff(ava, "admin");
    const o = await h.user("o@x.test");
    const id = await h.company(o, "Lone Co");
    await h.tenancy.deleteCompany({ actorUserId: ava, tenantId: id, confirmSlug: "lone-co" });
    expect(reported).toContain("company.deleted.afterCommit");
    expect(await codeOf(h.tenancy.getCompanyDetail({ actorUserId: ava, tenantId: id }))).toBe("not_found");
  });
});

describe("the console's route", () => {
  it("POST v1/admin/companies/:tenantId/delete: staff.tenants.delete; refusals as codes; the deleted company's summary", async () => {
    expect(TENANCY_OPERATOR_ROUTES.find((r) => r.kind === "admin-delete")).toMatchObject({
      method: "POST",
      path: "v1/admin/companies/:tenantId/delete",
      scope: "staff",
      permission: "staff.tenants.delete",
    });
    const calls: Calls = { forgot: [], after: [], paying: null, failForget: false };
    const w = await world(calls);
    const { operator } = handlersFor(h);
    const post = (user: string, body: unknown) =>
      operator.handle(
        new Request(`https://app.test/api/admin/tenancy/v1/admin/companies/${w.summit}/delete`, {
          method: "POST",
          headers: { "x-test-user": user, "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify(body),
        }),
      );
    const owner = await post(w.olivia, { confirmSlug: "summit-windows" });
    expect(owner.status).toBe(403);
    const wrong = await post(w.ava, { confirmSlug: "summit" });
    expect(wrong.status).toBe(422);
    expect((await jsonOf<{ error: { code: string; issues: { path: string[] }[] } }>(wrong)).error).toMatchObject({
      code: "confirmation_mismatch",
      issues: [{ path: ["confirmSlug"] }],
    });
    const ok = await post(w.ava, { confirmSlug: "summit-windows" });
    expect(ok.status).toBe(200);
    expect((await jsonOf<{ deleted: Record<string, unknown> }>(ok)).deleted).toMatchObject({
      id: w.summit,
      name: "Summit Window Co.",
      slug: "summit-windows",
      rows: 6,
      forced: false,
    });
    // A cross-site POST never reaches it.
    const cross = await operator.handle(
      new Request(`https://app.test/api/admin/tenancy/v1/admin/companies/${w.beta}/delete`, {
        method: "POST",
        headers: { "x-test-user": w.ava, "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ confirmSlug: "beta-plumbing" }),
      }),
    );
    expect(cross.status).toBe(403);
    expect(await count("tenant_members", w.beta)).toBe(1);
    void call;
  });
});
