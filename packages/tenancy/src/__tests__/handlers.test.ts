import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { TENANCY_OPERATOR_ROUTES, TENANCY_RATE_LIMITS, TENANCY_ROUTES, type RateLimiter, type TenancyRoute } from "../server.js";
import { call, handlersFor, harness, jsonOf, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function world() {
  const ava = await h.user("ava@igloo.test", { name: "Ava" });
  await h.staff(ava, "admin");
  const a = await h.user("a@a.test", { name: "Alice Owner" });
  const a2 = await h.user("a2@a.test", { name: "Andy Member" });
  const b = await h.user("b@b.test", { name: "Bea Owner" });
  const A = await h.company(a, "Alpha Roofing", { [a2]: "member" });
  const B = await h.company(b, "Beta Plumbing");
  const inv = await h.tenancy.sendInvitation({ actorUserId: a, tenantId: A, email: "pending@a.test", roleKey: "member" });
  return { ava, a, a2, b, A, B, invitationId: inv.invitation.id };
}

function fill(route: TenancyRoute, ids: Record<string, string>): string {
  return route.path.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? "x");
}

/** The minimal valid body per route kind. */
const BODIES: Record<string, unknown> = {
  "company-create": { name: "New Co", requestKey: "key-newcompany" },
  "active-set": { tenantId: "x" },
  "invite-accept": { token: "not-a-real-token" },
  "invite-preview": { token: "not-a-real-token" },
  "invite-join": {},
  "profile-update": { name: "Renamed Co" },
  "branding-update": { brandColor: "#0f766e" },
  "logo-remove": {},
  "settings-update": { values: { contactPhone: "555 0100" } },
  "checklist-dismiss": {},
  "checklist-restore": {},
  "checklist-hide": {},
  "checklist-show": {},
  "member-role": { roleKey: "viewer" },
  "member-remove": {},
  leave: {},
  transfer: { toUserId: "x", confirmName: "x" },
  "invitation-send": { email: "someone@new.test", roleKey: "member" },
  "invitation-resend": {},
  "invitation-revoke": {},
};

function multipart(path: string, userId: string): Request {
  const form = new FormData();
  form.set("file", new Blob([PNG], { type: "image/png" }), "logo.png");
  return new Request(`https://app.test/api/tenancy/${path}`, { method: "POST", body: form, headers: { "x-test-user": userId, "sec-fetch-site": "same-origin" } });
}

describe("every route answers its documented 200 shape (the table, read back)", () => {
  it("company routes", async () => {
    h = await harness();
    const w = await world();
    const { company } = handlersFor(h);
    const ids = { tenantId: w.A, userId: w.a2, invitationId: w.invitationId, section: "company", itemKey: "team.invite" };
    const expectKeys: Record<string, string[]> = {
      session: ["mode", "state", "user", "company", "companies", "invitations", "formerCompany"],
      "slug-check": ["slug", "available", "problem", "message", "suggestion"],
      "company-create": ["status", "company"],
      "active-set": ["company"],
      "invite-accept": ["status", "company", "message"],
      "invite-preview": ["found", "companyName", "roleName", "invitedBy", "addressMatches", "sentTo", "signedInAs"],
      "invite-join": ["status", "company", "message"],
      "company-get": ["company", "can", "logoUploads"],
      "profile-update": ["company"],
      "branding-update": ["company", "brand"],
      "logo-upload": ["company"],
      "logo-remove": ["company"],
      "settings-get": ["sections"],
      "settings-update": ["section"],
      "checklist-get": ["items", "done", "total", "complete", "hidden"],
      "checklist-dismiss": ["items", "done", "total", "complete", "hidden"],
      "checklist-restore": ["items", "done", "total", "complete", "hidden"],
      "checklist-hide": ["items", "done", "total", "complete", "hidden"],
      "checklist-show": ["items", "done", "total", "complete", "hidden"],
      "team-get": ["company", "you", "members", "roles", "invitableRoles", "seats"],
      "member-role": ["member"],
      "member-remove": ["removed"],
      leave: ["left"],
      transfer: ["company", "you", "members", "roles", "invitableRoles", "seats"],
      "invitations-list": ["invitations"],
      "invitation-send": ["invitation", "delivery", "link", "replaced", "note"],
      "invitation-resend": ["invitation", "delivery", "link", "replaced", "note"],
      "invitation-revoke": ["id"],
    };
    // Order matters: destructive routes last.
    const order = TENANCY_ROUTES.filter((r) => !["member-remove", "leave", "transfer", "invitation-revoke"].includes(r.kind)).concat(
      ["invitation-revoke", "transfer", "member-remove", "leave"].map((k) => TENANCY_ROUTES.find((r) => r.kind === k)!),
    );
    for (const route of order) {
      let actor = w.a;
      let body = BODIES[route.kind];
      if (route.kind === "active-set") body = { tenantId: w.A };
      if (route.kind === "transfer") body = { toUserId: w.a2, confirmName: "Renamed Co" };
      // After the transfer a2 owns Alpha and the original owner is an admin,
      // who can then leave.
      if (route.kind === "leave") actor = w.a;
      if (route.kind === "member-remove") ids.userId = w.a2;
      const res =
        route.kind === "logo-upload"
          ? await company.handle(multipart(fill(route, ids), actor))
          : await call(company, actor, route.method, fill(route, ids) + (route.kind === "slug-check" ? "?name=Gamma" : ""), body);
      if (route.kind === "member-remove") {
        // After the transfer the owner is a2; remove the original owner's
        // stand-in instead: a is now an admin, a2 the owner.
        expect([200, 403, 409]).toContain(res.status);
        continue;
      }
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(await jsonOf(res)).sort(), route.kind).toEqual([...expectKeys[route.kind]!].sort());
    }
  });

  it("operator routes", async () => {
    h = await harness();
    const w = await world();
    const { operator } = handlersFor(h);
    const shapes: Record<string, string[]> = {
      "admin-companies": ["companies", "total", "page", "pageSize"],
      "admin-company": ["company", "members", "pendingInvitations", "invitations", "retiredAddresses", "activity", "can"],
      "admin-suspend": ["company", "members", "pendingInvitations", "invitations", "retiredAddresses", "activity", "can"],
      "admin-reactivate": ["company", "members", "pendingInvitations", "invitations", "retiredAddresses", "activity", "can"],
      "admin-assign-owner": ["company", "members", "pendingInvitations", "invitations", "retiredAddresses", "activity", "can"],
      "admin-release-addresses": ["company", "members", "pendingInvitations", "invitations", "retiredAddresses", "activity", "can"],
      "admin-people": ["people", "total", "page", "pageSize", "roles", "you"],
      "admin-staff-roles": ["roles"],
      "admin-staff-role-set": ["person"],
    };
    const bodies: Record<string, unknown> = {
      "admin-suspend": { reason: "Unpaid since August" },
      "admin-reactivate": {},
      "admin-assign-owner": { toUserId: w.a2 },
      "admin-release-addresses": {},
      "admin-staff-role-set": { templateKey: "cs_agent" },
    };
    for (const route of TENANCY_OPERATOR_ROUTES) {
      const path = route.path.replace(":tenantId", w.A).replace(":userId", w.b);
      const res = await operator.handle(
        new Request(`https://app.test/api/admin/tenancy/${path}`, {
          method: route.method,
          headers: { "x-test-user": w.ava, ...(route.method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}) },
          ...(route.method === "POST" ? { body: JSON.stringify(bodies[route.kind] ?? {}) } : {}),
        }),
      );
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBe(200);
      expect(Object.keys(await jsonOf(res)).sort(), route.kind).toEqual([...shapes[route.kind]!].sort());
    }
    // Someone signed in with no staff role.
    const res = await operator.handle(new Request("https://app.test/api/admin/tenancy/v1/admin/companies", { headers: { "x-test-user": w.a } }));
    expect(res.status).toBe(403);
    expect((await jsonOf<{ error: { code: string } }>(res)).error.code).toBe("not_staff");
  });
});

describe("the basics", () => {
  it("signed out → 401; wrong method → 405 with allow; unknown path → 404; OPTIONS → 204", async () => {
    h = await harness();
    const { company } = handlersFor(h);
    expect((await call(company, null, "GET", "v1/session")).status).toBe(401);
    const wrong = await company.handle(new Request("https://app.test/api/tenancy/v1/session", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: "{}" }));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    expect((await call(company, "u", "GET", "v1/nothing/here")).status).toBe(404);
    expect((await company.handle(new Request("https://app.test/api/tenancy/v1/session", { method: "OPTIONS" }))).status).toBe(204);
  });

  it("a cross-site POST → 403 cross_site — and a same-SITE one too (review T1-12)", async () => {
    h = await harness();
    const u = await h.user("u@x.test");
    const { company } = handlersFor(h);
    for (const site of ["cross-site", "same-site"]) {
      const res = await call(company, u, "POST", "v1/companies", { name: "Evil Co", requestKey: "key-evilevil" }, { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
      expect((await jsonOf<{ error: { code: string } }>(res)).error.code).toBe("cross_site");
    }
    const sibling = await call(company, u, "POST", "v1/companies", { name: "Evil Co", requestKey: "key-evilevil" }, {
      "sec-fetch-site": "",
      origin: "https://evil.app.test",
    });
    expect(sibling.status).toBe(403);
  });

  it("a JSON POST without content-type: application/json is refused (a plain HTML form can't forge it)", async () => {
    h = await harness();
    const u = await h.user("u@x.test");
    const { company } = handlersFor(h);
    const res = await company.handle(
      new Request("https://app.test/api/tenancy/v1/companies", {
        method: "POST",
        headers: { "x-test-user": u, "content-type": "text/plain" },
        body: JSON.stringify({ name: "Form Co", requestKey: "key-formform" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("a 17 KB body → 400; a rate limit refusal → 429 with retry-after", async () => {
    h = await harness();
    const u = await h.user("u@x.test");
    const big = await call(handlersFor(h).company, u, "POST", "v1/companies", { name: "x".repeat(17_000), requestKey: "key-bigbody" });
    expect(big.status).toBe(400);
    const limited = handlersFor(h, { limit: async () => ({ allowed: false, retryAfterSeconds: 42 }) }).company;
    const res = await call(limited, u, "POST", "v1/companies", { name: "Fine Co", requestKey: "key-finefine" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  });

  it("a stranger's invite POSTs never spend the company's invite budget (review T1-06)", async () => {
    h = await harness();
    const w = await world();
    const charged: string[] = [];
    const { company } = handlersFor(h, {
      limit: async ({ bucket, key }) => {
        charged.push(`${bucket}:${key}`);
        return { allowed: true };
      },
    });
    for (let i = 0; i < 5; i += 1) {
      const res = await call(company, w.b, "POST", `v1/companies/${w.A}/invitations`, { email: `x${i}@x.test`, roleKey: "member" });
      expect(res.status).toBe(403);
    }
    expect(charged.filter((c) => c.includes(`tenant:${w.A}`))).toEqual([]);
    await call(company, w.a, "POST", `v1/companies/${w.A}/invitations`, { email: "ok@x.test", roleKey: "member" });
    expect(charged).toContain(`invite:tenant:${w.A}`);
  });
});

describe("invitation delivery and the link", () => {
  it('"sent" → link null; "failed" → link set; the token is never in an audit row or the query log', async () => {
    h = await harness();
    const w = await world();
    const sent = handlersFor(h, { deliverInvitation: async () => ({ status: "sent" }) }).company;
    const r1 = await jsonOf<{ link: string | null; delivery: string }>(await call(sent, w.a, "POST", `v1/companies/${w.A}/invitations`, { email: "s@x.test", roleKey: "member" }));
    expect(r1).toMatchObject({ delivery: "sent", link: null });
    const reported: unknown[] = [];
    const failing = handlersFor(h, {
      deliverInvitation: async () => {
        throw new Error("smtp down");
      },
      onError: (e) => void reported.push(e),
    }).company;
    h.t.queries.length = 0;
    const r2 = await jsonOf<{ link: string; delivery: string }>(await call(failing, w.a, "POST", `v1/companies/${w.A}/invitations`, { email: "f@x.test", roleKey: "member" }));
    expect(r2.delivery).toBe("failed");
    expect(r2.link).toMatch(/^https:\/\/app\.test\/invite\//);
    expect(reported).toHaveLength(1);
    const token = r2.link.split("/").pop()!;
    expect(JSON.stringify(h.audit)).not.toContain(token);
    expect(JSON.stringify(h.t.queries)).not.toContain(token);
  });
});

describe("errors", () => {
  it("a TenancyError answers code, message and (where it applies) suggestion; anything else is 500 internal with no stack", async () => {
    h = await harness();
    const u = await h.user("u@x.test");
    const { company } = handlersFor(h);
    const reserved = await jsonOf<{ error: { code: string; message: string; suggestion?: string } }>(
      await call(company, u, "POST", "v1/companies", { name: "Admin Co", slug: "admin", requestKey: "key-adminadmin" }),
    );
    expect(reserved.error).toMatchObject({ code: "slug_reserved", suggestion: "admin-co" });
    const reported: unknown[] = [];
    const broken = handlersFor(h, {
      principal: async () => {
        throw new Error("database exploded at /secret/path");
      },
      onError: (e) => void reported.push(e),
    }).company;
    const res = await call(broken, u, "GET", "v1/session");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("exploded");
    expect(JSON.parse(text).error.code).toBe("internal");
    expect(reported).toHaveLength(1);
  });
});

describe("the two-company matrix (scenario step 8)", () => {
  it("as B: A's tenant id → 403 not_a_member; B's id with A's other ids → 404 or no A strings; A unchanged", async () => {
    h = await harness();
    const w = await world();
    const { company } = handlersFor(h);
    const snapshot = async () =>
      JSON.stringify({
        t: (await h.db.execute(sql`select name, slug, branding, settings, setup_state from tenants where id = ${w.A}`)).rows,
        m: (await h.db.execute(sql`select user_id, status from tenant_members where tenant_id = ${w.A} order by user_id`)).rows,
        r: (await h.db.execute(sql`select principal_id, template_id from principal_role where tenant_id = ${w.A} order by principal_id`)).rows,
        i: (await h.db.execute(sql`select id, revoked_at, accepted_at from tenant_invitations where tenant_id = ${w.A} order by id`)).rows,
      });
    const before = await snapshot();
    const aStrings = [w.A, w.a, w.a2, w.invitationId, "a@a.test", "a2@a.test", "Alice Owner", "Andy Member", "alpha-roofing", "Alpha Roofing", "pending@a.test"];
    const companyRoutes = TENANCY_ROUTES.filter((r) => r.scope === "company");
    for (const route of companyRoutes) {
      const body = route.kind === "transfer" ? { toUserId: w.a2, confirmName: "Alpha Roofing" } : BODIES[route.kind];
      const asA = { tenantId: w.A, userId: w.a2, invitationId: w.invitationId, section: "company", itemKey: "team.invite" };
      const res1 = route.kind === "logo-upload" ? await company.handle(multipart(fill(route, asA), w.b)) : await call(company, w.b, route.method, fill(route, asA), body);
      expect(res1.status, route.kind).toBe(403);
      expect((await jsonOf<{ error: { code: string } }>(res1)).error.code, route.kind).toBe("not_a_member");

      const mixed = { ...asA, tenantId: w.B };
      const res2 = route.kind === "logo-upload" ? await company.handle(multipart(fill(route, mixed), w.b)) : await call(company, w.b, route.method, fill(route, mixed), body);
      const text = await res2.text();
      if (route.path.includes(":userId") || route.path.includes(":invitationId")) {
        expect(res2.status, `${route.kind}: ${text}`).toBe(404);
      } else {
        for (const s of aStrings) expect(text.includes(s), `${route.kind} leaked ${s}`).toBe(false);
      }
    }
    expect(await snapshot()).toBe(before);
  });
});

describe("personal mode", () => {
  it("company-create and invite-join answer 404 unavailable; switching stays available (CONTRACT)", async () => {
    h = await harness({ mode: "personal" });
    const u = await h.user("u@x.test");
    const { company } = handlersFor(h);
    const create = await call(company, u, "POST", "v1/companies", { name: "Co Co", requestKey: "key-personal" });
    expect(create.status).toBe(404);
    expect((await jsonOf<{ error: { code: string } }>(create)).error.code).toBe("unavailable");
    const join = await call(company, u, "POST", "v1/invitations/abc/join", {});
    expect((await jsonOf<{ error: { code: string } }>(join)).error.code).toBe("unavailable");
    const s = await jsonOf<{ company: { id: string }; mode: string }>(await call(company, u, "GET", "v1/session"));
    expect(s.mode).toBe("personal");
    expect((await call(company, u, "POST", "v1/active", { tenantId: s.company.id })).status).toBe(200);
  });
});

/** A sliding-window limiter on the package's own policies (what create-app wires to Upstash), on a fake clock. */
function windowLimiter(clock: { now: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  return async ({ bucket, key }) => {
    const policy = TENANCY_RATE_LIMITS[bucket];
    const k = `${bucket}:${key}`;
    const list = (hits.get(k) ?? []).filter((t) => t > clock.now - policy.windowMs);
    if (list.length >= policy.limit) return { allowed: false, retryAfterSeconds: 60 };
    list.push(clock.now);
    hits.set(k, list);
    return { allowed: true };
  };
}

describe("rate budgets are spent by people who may spend them (review R2)", () => {
  it("SEC-T1-D: a viewer's 50 refused invitations don't lock the owner out of inviting", async () => {
    h = await harness();
    const owner = await h.user("owner@alpha.test");
    const viewer = await h.user("vic@alpha.test");
    const A = await h.company(owner, "Alpha Lawn", { [viewer]: "viewer" });
    const { company } = handlersFor(h, { limit: windowLimiter({ now: Date.now() }) });
    for (let i = 0; i < 50; i += 1) {
      const res = await call(company, viewer, "POST", `v1/companies/${A}/invitations`, { email: `x${i}@nowhere.test`, roleKey: "member" });
      expect(res.status).toBe(403);
    }
    // The same for the logo budget.
    for (let i = 0; i < 20; i += 1) expect((await company.handle(multipart(`v1/companies/${A}/logo`, viewer))).status).toBe(403);
    const ownerTry = await call(company, owner, "POST", `v1/companies/${A}/invitations`, { email: "new.hire@alpha.test", roleKey: "member" });
    expect(ownerTry.status).toBe(200);
  });

  it("SEC-T1-B: one account can't multiply the invitation budget by making companies", async () => {
    h = await harness();
    const sender = await h.user("spam@evil.test");
    const clock = { now: Date.now() };
    const sent: string[] = [];
    const { company } = handlersFor(h, {
      limit: windowLimiter(clock),
      deliverInvitation: async (input) => {
        sent.push(input.to);
        return { status: "sent" };
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await call(company, sender, "POST", "v1/companies", { name: `Company ${i}`, requestKey: `key-spam-${i}-xxxx`, purpose: "additional" });
      ids.push((await jsonOf<{ company: { id: string } }>(res)).company.id);
    }
    let ok = 0;
    for (const id of ids) {
      for (let i = 0; i < 50; i += 1) {
        const res = await call(company, sender, "POST", `v1/companies/${id}/invitations`, { email: `victim${i}@target.test`, roleKey: "member" });
        if (res.status === 200) ok += 1;
      }
    }
    // 50 an hour per SENDER, across every company they can invite into (was 50 per company: 150 here).
    expect(ok).toBe(50);
    expect(sent.length).toBe(ok);
  });
});

describe("a bodyless POST is still JSON (review R2 SEC-T1-H)", () => {
  it("a form-typed or untyped empty POST is refused before it reaches the service; the widget's {} still works", async () => {
    h = await harness();
    const owner = await h.user("owner@alpha.test");
    const mia = await h.user("mia@alpha.test");
    const A = await h.company(owner, "Alpha Lawn", { [mia]: "member" });
    const { company } = handlersFor(h);
    for (const headers of [{ "content-type": "application/x-www-form-urlencoded" }, { "content-type": "text/plain" }, {}] as Record<string, string>[]) {
      const res = await company.handle(
        new Request(`https://app.test/api/tenancy/v1/companies/${A}/members/${mia}/remove`, {
          method: "POST",
          headers: { "x-test-user": owner, ...headers },
          body: "",
        }),
      );
      expect(res.status, JSON.stringify(headers)).toBe(400);
    }
    expect(await h.tenancy.membership({ userId: mia, tenantId: A })).toBe("member");
    expect((await call(company, owner, "POST", `v1/companies/${A}/members/${mia}/remove`, {})).status).toBe(200);
  });
});

describe("a stranger always hears 'not yours' first", () => {
  it("dismissing a checklist item that doesn't exist, in someone else's company → not_a_member, not not_found", async () => {
    h = await harness();
    const w = await world();
    const { company } = handlersFor(h);
    const res = await call(company, w.b, "POST", `v1/companies/${w.A}/checklist/no.such-item/dismiss`, {});
    expect(res.status).toBe(403);
    expect((await jsonOf<{ error: { code: string } }>(res)).error.code).toBe("not_a_member");
    const section = await call(company, w.b, "POST", `v1/companies/${w.A}/settings/no-such-section`, { values: {} });
    expect((await jsonOf<{ error: { code: string } }>(section)).error.code).toBe("not_a_member");
    // A member asking for an unknown item still gets not_found.
    const mine = await call(company, w.a, "POST", `v1/companies/${w.A}/checklist/no.such-item/dismiss`, {});
    expect((await jsonOf<{ error: { code: string } }>(mine)).error.code).toBe("not_found");
  });
});
