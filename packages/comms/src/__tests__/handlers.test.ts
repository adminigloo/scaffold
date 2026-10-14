import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMMS_ADMIN_ROUTES,
  commsPermissions,
  commsScheduled,
  createCommsAdminHandlers,
  enqueueMessage,
  sendNow,
  setTemplateActive,
  upsertTemplate,
  type CommsPermission,
  type CommsSenders,
  type CreateCommsAdminHandlersOptions,
  type OutboundEmail,
} from "../index.js";
import { COMMS_ADMIN_ROUTE_PERMISSIONS } from "../routes.js";
import type { CommsStatusWire, MessagesWire, RunDueWire, TemplatesWire } from "../wire.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * `createCommsAdminHandlers` (Tenancy 2a, 9.5) on a real Postgres: the
 * Messages console's routes, each behind its permission, each scoped to the
 * company the request names.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const BASE = "http://app.test/api/app";

function req(tenantId: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const method = init.method ?? "GET";
  return new Request(`${BASE}/${tenantId}/messages/${path}`, {
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(method === "POST" ? { body: JSON.stringify(init.body ?? {}) } : {}),
  });
}

/** The tenant is the path segment after /api/app/, as createCompanyRouteSeams reads it. */
function resolveTenant(r: Request): string | null {
  const match = /\/api\/app\/([^/]+)\//.exec(new URL(r.url).pathname);
  return match?.[1] ?? null;
}

function capture() {
  const emails: OutboundEmail[] = [];
  return {
    emails,
    email: async (m: OutboundEmail) => {
      emails.push(m);
      return { id: `em_${emails.length}` };
    },
  };
}

/** A member of `member` holding `grants` (all keys by default). */
function handlers(member: string, grants: readonly CommsPermission[] = Object.keys(commsPermissions) as CommsPermission[], extra: Partial<CreateCommsAdminHandlersOptions> = {}) {
  const asked: { permission: CommsPermission; tenantId: string }[] = [];
  const c = capture();
  const senders: CommsSenders = {
    email: c.email,
    identity: (id) => (id === member ? { name: "Green Acres", replyTo: "gail@greenacres.test" } : null),
  };
  const h = createCommsAdminHandlers({
    db: t.db,
    senders,
    resolveTenant,
    authorize: (_r, permission, tenantId) => {
      asked.push({ permission, tenantId });
      if (tenantId !== member) {
        return new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 });
      }
      return grants.includes(permission) ? { userId: "u1" } : false;
    },
    ...extra,
  });
  return { ...h, asked, emails: c.emails };
}

async function body<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seed(tenantId: string): Promise<void> {
  await upsertTemplate(t.db, { tenantId, key: "visit_reminder", subject: "See you {{date}}", body: "Hi {{name}}, see you {{date}} at {{time}}." });
  await upsertTemplate(t.db, { tenantId, key: "visit_text", channel: "sms", body: "See you {{date}}." });
}

describe("routing and the gate", () => {
  it("every route asks exactly its permission, for the tenant in the path", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    for (const row of COMMS_ADMIN_ROUTES) {
      h.asked.length = 0;
      const path = row.path.replace("v1/admin/", "v1/admin/").replace("{template-key}", "visit_reminder");
      const query = row.query ? `?${new URLSearchParams(row.query as Record<string, string>).toString()}` : "";
      const res = await h.handle(req(a, `${path}${query}`, { method: row.method, body: row.body }));
      expect(res.status, row.kind).toBeLessThan(300);
      expect(h.asked[0], row.kind).toEqual({ permission: row.permission, tenantId: a });
    }
  });

  it("without the permission, every route is 403 forbidden with the plain sentence", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a, []);
    for (const row of COMMS_ADMIN_ROUTES) {
      const path = row.path.replace("{template-key}", "visit_reminder");
      const res = await h.handle(req(a, path, { method: row.method, body: row.body }));
      expect(res.status, row.kind).toBe(403);
      expect(await body(res), row.kind).toEqual({ error: { code: "forbidden", message: "You don't have permission to do that." } });
    }
  });

  it("a viewer (comms.view) reads but can't edit or send", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a, ["comms.view"]);
    expect((await h.handle(req(a, "v1/admin/templates"))).status).toBe(200);
    expect((await h.handle(req(a, "v1/admin/messages"))).status).toBe(200);
    expect((await h.handle(req(a, "v1/admin/run-due", { method: "POST" }))).status).toBe(403);
    expect((await h.handle(req(a, "v1/admin/templates/visit_reminder", { method: "POST", body: { subject: "x", body: "y" } }))).status).toBe(403);
  });

  it("authorize's Response (a host's 401 or the company gate's 403) is returned as it is", async () => {
    const a = tenant();
    const b = tenant();
    const h = handlers(a);
    const res = await h.handle(req(b, "v1/admin/status"));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: { code: "forbidden", message: "You're not part of this company." } });
  });

  it("an unknown path is 404; a known one on the wrong method is 405 with allow", async () => {
    const a = tenant();
    const h = handlers(a);
    const unknown = await h.handle(req(a, "v1/admin/nope"));
    expect(unknown.status).toBe(404);
    expect((await body<{ error: { code: string } }>(unknown)).error.code).toBe("not_found");
    const wrong = await h.handle(req(a, "v1/admin/run-due"));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    const wrong2 = await h.handle(req(a, "v1/admin/templates", { method: "POST" }));
    expect(wrong2.status).toBe(405);
    expect(wrong2.headers.get("allow")).toBe("GET");
  });

  it("a POST from another site is refused before any work, and nothing has CORS", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/run-due", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: { code: "cross_site", message: "This request came from another site, so it was refused." } });
    expect(h.asked).toHaveLength(0);
    const ok = await h.handle(req(a, "v1/admin/status"));
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("a body over 32 KB is refused as invalid", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/visit_reminder", { method: "POST", body: { subject: "s", body: "x".repeat(40_000) } }));
    expect(res.status).toBe(400);
  });

  it("an unexpected error is a plain 500 and reaches onError", async () => {
    const a = tenant();
    const errors: unknown[] = [];
    const h = handlers(a, undefined, {
      delivery: () => {
        throw new Error("boom: secret detail");
      },
      onError: (error, context) => errors.push([error, context]),
    });
    const res = await h.handle(req(a, "v1/admin/status"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret detail");
    expect(errors).toHaveLength(1);
    expect((errors[0] as unknown[])[1]).toEqual({ tenantId: a, route: "status" });
  });

  it("the permission table matches the route table", () => {
    for (const row of COMMS_ADMIN_ROUTES) expect(row.permission).toBe(COMMS_ADMIN_ROUTE_PERMISSIONS[row.kind]);
    expect(new Set(COMMS_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(COMMS_ADMIN_ROUTE_PERMISSIONS).length);
    expect(Object.isFrozen(COMMS_ADMIN_ROUTES)).toBe(true);
  });
});

describe("templates", () => {
  it("ensureTemplates runs before the list, and the list carries each template's placeholders in first-seen order", async () => {
    const a = tenant();
    const h = handlers(a, undefined, { ensureTemplates: (id) => seed(id) });
    const res = await h.handle(req(a, "v1/admin/templates"));
    const wire = await body<TemplatesWire>(res);
    expect(wire.templates.map((x) => x.key)).toEqual(["visit_reminder", "visit_text"]);
    expect(wire.templates[0]).toMatchObject({
      channel: "email",
      subject: "See you {{date}}",
      active: true,
      variables: ["date", "name", "time"],
    });
    expect(typeof wire.templates[0]?.updatedAt).toBe("string");
  });

  it("a failing ensureTemplates is reported and the list still answers", async () => {
    const a = tenant();
    await seed(a);
    const errors: unknown[] = [];
    const h = handlers(a, undefined, {
      ensureTemplates: async () => {
        throw new Error("templates broke");
      },
      onError: (e) => errors.push(e),
    });
    const res = await h.handle(req(a, "v1/admin/templates"));
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it("save updates the wording and leaves the channel and the switch alone", async () => {
    const a = tenant();
    await seed(a);
    await setTemplateActive(t.db, a, "visit_reminder", false);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/visit_reminder", { method: "POST", body: { subject: "New {{date}}", body: "New body {{name}}" } }));
    expect(res.status).toBe(200);
    const { template } = await body<{ template: TemplatesWire["templates"][number] }>(res);
    expect(template).toMatchObject({ key: "visit_reminder", channel: "email", subject: "New {{date}}", body: "New body {{name}}", active: false });
  });

  it("save can't create a key the company doesn't have", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/made_up_key", { method: "POST", body: { subject: "s", body: "b" } }));
    expect(res.status).toBe(404);
    const list = await body<TemplatesWire>(await h.handle(req(a, "v1/admin/templates")));
    expect(list.templates.map((x) => x.key)).not.toContain("made_up_key");
  });

  it("an email template with an empty subject is refused on `subject`", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/visit_reminder", { method: "POST", body: { subject: "  ", body: "b" } }));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({
      error: { code: "invalid", message: "An email needs a subject.", issues: [{ path: ["subject"], message: "An email needs a subject." }] },
    });
  });

  it("an SMS template saves with no subject", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/visit_text", { method: "POST", body: { subject: "ignored", body: "Text {{date}}" } }));
    expect(res.status).toBe(200);
    expect((await body<{ template: { subject: string | null } }>(res)).template.subject).toBeNull();
  });

  it("an empty body is refused with the issue on `body`", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const res = await h.handle(req(a, "v1/admin/templates/visit_reminder", { method: "POST", body: { subject: "s", body: "" } }));
    expect(res.status).toBe(400);
    const wire = await body<{ error: { issues: { path: string[] }[] } }>(res);
    expect(wire.error.issues[0]?.path).toEqual(["body"]);
  });

  it("switching one off and on", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    const off = await h.handle(req(a, "v1/admin/templates/visit_reminder/active", { method: "POST", body: { active: false } }));
    expect((await body<{ template: { active: boolean } }>(off)).template.active).toBe(false);
    const on = await h.handle(req(a, "v1/admin/templates/visit_reminder/active", { method: "POST", body: { active: true } }));
    expect((await body<{ template: { active: boolean } }>(on)).template.active).toBe(true);
    const missing = await h.handle(req(a, "v1/admin/templates/nope/active", { method: "POST", body: { active: true } }));
    expect(missing.status).toBe(404);
  });
});

describe("messages, status and run-due", () => {
  it("the log shows what went out, as whom, and never the body", async () => {
    const a = tenant();
    await seed(a);
    const h = handlers(a);
    await sendNow(
      t.db,
      { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", vars: { date: "Tue" } },
      { email: async () => ({ id: "x" }), identity: () => ({ name: "Green Acres", replyTo: "gail@greenacres.test" }) },
    );
    await sendNow(t.db, { tenantId: a, to: "pat@example.com", templateKey: "nope", vars: {} }, {});
    const wire = await body<MessagesWire>(await h.handle(req(a, "v1/admin/messages?limit=10")));
    expect(wire.messages).toHaveLength(2);
    const sent = wire.messages.find((m) => m.status === "sent");
    expect(sent).toMatchObject({
      channel: "email",
      to: "pat@example.com",
      templateKey: "visit_reminder",
      subject: "See you Tue",
      note: null,
      blanks: ["name", "time"],
      fromName: "Green Acres",
      replyTo: "gail@greenacres.test",
    });
    expect(Object.keys(sent ?? {})).not.toContain("body");
    const failed = wire.messages.find((m) => m.status === "failed");
    expect(failed?.note).toContain('no template "nope"');
  });

  it("limit outside 1–200 is refused", async () => {
    const a = tenant();
    const h = handlers(a);
    expect((await h.handle(req(a, "v1/admin/messages?limit=0"))).status).toBe(400);
    expect((await h.handle(req(a, "v1/admin/messages?limit=500"))).status).toBe(400);
    expect((await h.handle(req(a, "v1/admin/messages?limit=abc"))).status).toBe(400);
    expect((await h.handle(req(a, "v1/admin/messages"))).status).toBe(200);
  });

  it("status reports the identity, the pending, behind and late counts, and email on/off", async () => {
    const a = tenant();
    await seed(a);
    const now = new Date();
    // One due tomorrow, one two days overdue (the cron not running), and one
    // three hours past due: it missed its run (the job ran out of time).
    await enqueueMessage(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() + 86_400_000) });
    const overdue = await enqueueMessage(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() + 60_000) });
    await t.db.update(commsScheduled).set({ sendAt: new Date(now.getTime() - 2 * 86_400_000) }).where(eq(commsScheduled.id, overdue as string));
    const missed = await enqueueMessage(t.db, { tenantId: a, to: "lee@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() + 60_000) });
    await t.db.update(commsScheduled).set({ sendAt: new Date(now.getTime() - 3 * 3_600_000) }).where(eq(commsScheduled.id, missed as string));
    const h = handlers(a);
    const wire = await body<CommsStatusWire>(await h.handle(req(a, "v1/admin/status")));
    expect(wire).toEqual({
      emails: true,
      emailsOffReason: null,
      fromName: "Green Acres",
      replyTo: "gail@greenacres.test",
      scheduled: { pending: 3, behind: 1, late: 1 },
    });
  });

  it("status without an email sender says so; a throwing identity shows the defaults", async () => {
    const a = tenant();
    const errors: unknown[] = [];
    const h = createCommsAdminHandlers({
      db: t.db,
      senders: {
        identity: () => {
          throw new Error("x");
        },
      },
      tenantId: a,
      authorize: () => true,
      onError: (e) => errors.push(e),
    });
    const wire = await body<CommsStatusWire>(await h.handle(new Request("http://app.test/api/admin/comms/v1/admin/status")));
    expect(wire.emails).toBe(false);
    expect(wire.emailsOffReason).toMatch(/doesn't send email yet/);
    expect(wire.fromName).toBeNull();
    expect(wire.replyTo).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("delivery() is the truth when given", async () => {
    const a = tenant();
    const h = handlers(a, undefined, { delivery: () => ({ emails: false, emailsOffReason: "Email is switched off on this site." }) });
    const wire = await body<CommsStatusWire>(await h.handle(req(a, "v1/admin/status")));
    expect(wire).toMatchObject({ emails: false, emailsOffReason: "Email is switched off on this site." });
  });

  it("run-due sends only THIS company's due rows, through beforeSend, then afterRun", async () => {
    const a = tenant();
    const b = tenant();
    await seed(a);
    await seed(b);
    const now = new Date();
    await enqueueMessage(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() - 60_000) });
    const bRow = await enqueueMessage(t.db, { tenantId: b, to: "lee@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() - 60_000) });
    const seen: string[] = [];
    let after = 0;
    const h = handlers(a, undefined, {
      beforeSend: (row) => {
        seen.push(row.tenantId);
        return "send";
      },
      afterRun: async () => {
        after += 1;
      },
    });
    const res = await h.handle(req(a, "v1/admin/run-due", { method: "POST" }));
    const wire = await body<RunDueWire>(res);
    expect(wire).toEqual({ sent: 1, skipped: 0, failed: 0, retrying: 0, cancelled: 0, expired: 0, stoppedEarly: false });
    expect(seen).toEqual([a]);
    expect(after).toBe(1);
    expect(h.emails.map((m) => m.tenantId)).toEqual([a]);
    expect(h.emails[0]).toMatchObject({ fromName: "Green Acres", replyTo: "gail@greenacres.test" });
    const [still] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, bRow as string));
    expect(still?.status).toBe("pending");
  });

  it("run-due never touches ANOTHER company's stuck rows, and reports only its own counts (review TB-3)", async () => {
    const a = tenant();
    const b = tenant();
    await seed(a);
    await seed(b);
    const now = new Date();
    // Company A has two reminders a dead worker claimed 20 minutes ago: one
    // out of attempts, one with attempts left.
    const stuck: string[] = [];
    for (const attempts of [5, 1]) {
      const id = (await enqueueMessage(t.db, { tenantId: a, to: "pat@example.com", templateKey: "visit_reminder", sendAt: new Date(now.getTime() + 60_000) })) as string;
      await t.db
        .update(commsScheduled)
        .set({ status: "sending", claimedAt: new Date(now.getTime() - 20 * 60_000), attempts })
        .where(eq(commsScheduled.id, id));
      stuck.push(id);
    }
    // Company B's owner presses "Send what's due now".
    const h = handlers(b);
    const wire = await body<RunDueWire>(await h.handle(req(b, "v1/admin/run-due", { method: "POST" })));
    expect(wire).toEqual({ sent: 0, skipped: 0, failed: 0, retrying: 0, cancelled: 0, expired: 0, stoppedEarly: false });
    for (const id of stuck) {
      const [row] = await t.db.select().from(commsScheduled).where(eq(commsScheduled.id, id));
      expect(row?.status, id).toBe("sending");
    }
    // A's own button does move them.
    const own = await body<RunDueWire>(await handlers(a).handle(req(a, "v1/admin/run-due", { method: "POST" })));
    expect(own.failed).toBe(1);
  });

  it("afterRun runs even when the drain throws", async () => {
    const a = tenant();
    let after = 0;
    const h = handlers(a, undefined, {
      now: () => {
        throw new Error("clock broke");
      },
      afterRun: async () => {
        after += 1;
      },
    });
    const res = await h.handle(req(a, "v1/admin/run-due", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(after).toBe(1);
  });
});

describe("route table", () => {
  const fill = (path: string, value: string) => path.replace("{template-key}", value);

  it("every row routes to its kind (authorize sees that kind's permission)", async () => {
    const a = tenant();
    await seed(a);
    for (const row of COMMS_ADMIN_ROUTES) {
      const asked: string[] = [];
      const h = createCommsAdminHandlers({
        db: t.db,
        senders: {},
        tenantId: a,
        authorize: (_r, permission) => {
          asked.push(permission);
          return false;
        },
      });
      const res = await h.handle(
        new Request(`http://app.test/x/${fill(row.path, "visit_reminder")}`, {
          method: row.method,
          headers: { "sec-fetch-site": "same-origin" },
          ...(row.method === "POST" ? { body: JSON.stringify(row.body ?? {}) } : {}),
        }),
      );
      expect(res.status, row.kind).toBe(403);
      expect(asked, row.kind).toEqual([COMMS_ADMIN_ROUTE_PERMISSIONS[row.kind]]);
    }
  });

  it("every example reaches its lookup: on an EMPTY company, a path placeholder is 404 and the rest answer below 500", async () => {
    const empty = tenant("empty");
    const h = handlers(empty);
    for (const row of COMMS_ADMIN_ROUTES) {
      const path = fill(row.path, `made_up_${Math.random().toString(36).slice(2, 8)}`);
      const query = row.query ? `?${new URLSearchParams(row.query as Record<string, string>).toString()}` : "";
      const res = await h.handle(req(empty, `${path}${query}`, { method: row.method, body: row.body }));
      if (row.path.includes("{")) {
        expect(res.status, row.kind).toBe(404);
        expect((await body<{ error: { code: string } }>(res)).error.code, row.kind).toBe("not_found");
      } else {
        expect(res.status, row.kind).toBeLessThan(500);
      }
    }
  });

  it("two companies: B gets 404 or nothing of A through every route", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    await seed(a);
    await seed(b);
    await upsertTemplate(t.db, { tenantId: a, key: "alpha_only_note", subject: "Alpha only", body: "Alpha Lawn Care private wording" });
    await sendNow(t.db, { tenantId: a, to: "alpha-customer@example.com", templateKey: "alpha_only_note", vars: {} }, { email: async () => ({ id: "a" }) });
    await enqueueMessage(t.db, { tenantId: a, to: "alpha-customer@example.com", templateKey: "alpha_only_note", sendAt: new Date(Date.now() - 60_000) });
    const aStrings = ["alpha_only_note", "Alpha only", "Alpha Lawn Care private wording", "alpha-customer@example.com", a];

    const asB = handlers(b);
    for (const row of COMMS_ADMIN_ROUTES) {
      const path = fill(row.path, "alpha_only_note");
      const query = row.query ? `?${new URLSearchParams(row.query as Record<string, string>).toString()}` : "";
      // A's company in the path: the gate refuses.
      const viaA = await asB.handle(req(a, `${path}${query}`, { method: row.method, body: row.body }));
      expect(viaA.status, row.kind).toBe(403);
      // B's company, A's key.
      const res = await asB.handle(req(b, `${path}${query}`, { method: row.method, body: row.body }));
      const text = await res.text();
      if (row.path.includes("{")) expect(res.status, row.kind).toBe(404);
      else expect(res.status, row.kind).toBeLessThan(500);
      for (const s of aStrings) expect(text, `${row.kind} leaked ${s}`).not.toContain(s);
    }
    // A's queued row was never touched by B's run-due.
    const aRows = await t.db.select().from(commsScheduled).where(eq(commsScheduled.tenantId, a));
    expect(aRows.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("commsPermissions", () => {
  it("has the two keys with the contract's defaults", () => {
    expect(commsPermissions["comms.view"].defaultFor).toEqual(["owner", "admin", "member", "viewer"]);
    expect(commsPermissions["comms.manage"].defaultFor).toEqual(["owner", "admin"]);
    expect(Object.keys(commsPermissions).every((k) => k.startsWith("comms."))).toBe(true);
  });
});
