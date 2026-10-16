import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  addTicketMessage,
  createCategory,
  createFeedbackAdminHandlers,
  createStatus,
  createTicket,
  FEEDBACK_ADMIN_ROUTE_PERMISSIONS,
  FEEDBACK_ADMIN_ROUTES,
  feedbackPermissions,
  issueClientKey,
  submitPayloadSchema,
  type FeedbackEvent,
  type FeedbackPermission,
  type FeedbackRoute,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * The staff routes, from the route table: every row reaches its route and
 * asks its permission; company B, calling every row with A's ids, gets "not
 * found" for a row the path names and nothing of A anywhere — and A's rows
 * are exactly as they were. Then the seams: a refusal is the host's, a POST
 * from another site never runs, the reporter's events fire.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

interface Asked {
  permission: FeedbackPermission;
  tenantId: string;
}

/** /api/app/{company}/feedback/… → that company; authorize records what it was asked and says yes. */
function handlers(asked: Asked[] = [], events: FeedbackEvent[] = []) {
  return createFeedbackAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) => {
      asked.push({ permission, tenantId });
      return { userId: `user-of-${tenantId}` };
    },
    staffName: (userId) => (userId ? `Person ${userId}` : null),
    onEvent: (event) => void events.push(event),
  });
}

function fill(text: string, rows: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-z][a-z-]*)\}/g, (_w, entity: string) => {
    const value = rows[entity];
    if (value === undefined) throw new Error(`no row for {${entity}}`);
    return value;
  });
}

function requestFor(tenantId: string, route: FeedbackRoute, rows: Readonly<Record<string, string>>): Request {
  const url = new URL(`http://localhost/api/app/${tenantId}/feedback/${fill(route.path, rows)}`);
  for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, fill(value, rows));
  const headers = { "sec-fetch-site": "same-origin" };
  if (route.method === "GET") return new Request(url, { headers });
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: fill(JSON.stringify(route.body ?? {}), rows),
  });
}

async function plant(tenantId: string, label: string) {
  const ticket = await createTicket(t.db, {
    tenantId,
    payload: submitPayloadSchema.parse(report(`${label} probe report, with enough words.`, { reporter: { name: `${label} Reporter`, email: `${label}@reporter.test` } })),
  });
  await addTicketMessage(t.db, tenantId, { ticketId: ticket.id, senderType: "staff", senderName: `${label} Staff`, body: `${label} staff note` });
  const column = await createStatus(t.db, tenantId, { key: "waiting", label: `${label} waiting` });
  const category = await createCategory(t.db, tenantId, { key: "billing", label: `${label} billing` });
  const key = await issueClientKey(t.db, { tenantId, label: `${label} website` });
  return {
    rows: { ticket: ticket.id, column: column.id, category: category.id, "feedback-key": key.id } as Record<string, string>,
    strings: [tenantId, ticket.id, ticket.ticketToken, column.id, category.id, key.id, key.key, `${label} probe report`, `${label} Reporter`, `${label}@reporter.test`, `${label} staff note`, `${label} waiting`, `${label} billing`, `${label} website`],
  };
}

async function snapshot(tenantId: string): Promise<string> {
  const rows = async (q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as { rows: unknown[] }).rows;
  return JSON.stringify([
    await rows(sql`select * from feedback_tickets where tenant_id = ${tenantId} order by id`),
    await rows(sql`select * from feedback_statuses where tenant_id = ${tenantId} order by id`),
    await rows(sql`select * from feedback_categories where tenant_id = ${tenantId} order by id`),
    await rows(sql`select * from feedback_client_keys where tenant_id = ${tenantId} order by id`),
    await rows(sql`select m.* from feedback_messages m join feedback_tickets t on t.id = m.ticket_id where t.tenant_id = ${tenantId} order by m.id`),
  ]);
}

describe("the route table", () => {
  it("names a permission for every route, the same one the table of permissions does, from the package's own keys", () => {
    const kinds = FEEDBACK_ADMIN_ROUTES.map((route) => route.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual(Object.keys(FEEDBACK_ADMIN_ROUTE_PERMISSIONS).sort());
    for (const route of FEEDBACK_ADMIN_ROUTES) {
      expect(route.permission, route.kind).toBe(FEEDBACK_ADMIN_ROUTE_PERMISSIONS[route.kind]);
      expect(Object.keys(feedbackPermissions), route.kind).toContain(route.permission);
    }
  });

  it("gives every role its default keys (owner and admin all, member view and manage, viewer view, crew none)", () => {
    const holders = (key: keyof typeof feedbackPermissions) => [...feedbackPermissions[key].defaultFor];
    expect(holders("feedback.view")).toEqual(["owner", "admin", "member", "viewer"]);
    expect(holders("feedback.manage")).toEqual(["owner", "admin", "member"]);
    expect(holders("feedback.settings.manage")).toEqual(["owner", "admin"]);
  });

  it("answers not found for every row-reading route on an empty company (each example reaches its lookup)", async () => {
    const empty = tenant("empty");
    const rows = { ticket: "nope", column: "nope", category: "nope", "feedback-key": "nope" };
    const { handle } = handlers();
    for (const route of FEEDBACK_ADMIN_ROUTES.filter((r) => /\{/.test(r.path))) {
      const res = await handle(requestFor(empty, route, rows));
      expect([res.status, ((await res.json()) as { error?: { code?: string } }).error?.code], route.kind).toEqual([404, "not_found"]);
    }
  });
});

describe("company B gets nothing of company A's, through every route", () => {
  it("not found for A's rows in the path, nothing of A anywhere, A unchanged; then A reaches every one of its own", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const A = await plant(a, "Alpha");
    const B = await plant(b, "Bravo");
    const before = await snapshot(a);
    const asked: Asked[] = [];
    const { handle } = handlers(asked);

    for (const route of FEEDBACK_ADMIN_ROUTES) {
      asked.length = 0;
      const res = await handle(requestFor(b, route, A.rows));
      const text = await res.text();
      expect(A.strings.filter((s) => text.includes(s)), `${route.kind} as B with A's rows: ${text.slice(0, 200)}`).toEqual([]);
      if (/\{/.test(route.path)) {
        expect([res.status, (JSON.parse(text) as { error?: { code?: string } }).error?.code], route.kind).toEqual([404, "not_found"]);
      } else {
        expect(res.status, `${route.kind}: ${text.slice(0, 200)}`).toBeLessThan(500);
      }
      // It asked for exactly its own permission, for B.
      expect(asked, route.kind).toEqual([{ permission: route.permission, tenantId: b }]);
    }
    expect(await snapshot(a)).toBe(before);

    // A, on its own rows, reaches every route (the table matches the router).
    for (const route of FEEDBACK_ADMIN_ROUTES) {
      const res = await handle(requestFor(a, route, A.rows));
      const text = await res.text();
      expect(res.status, `${route.kind} as A on A's rows: ${text.slice(0, 200)}`).toBeLessThan(300);
      expect(B.strings.filter((s) => text.includes(s)), route.kind).toEqual([]);
    }
  });
});

describe("the seams", () => {
  it("returns the host's refusal as it is, and its own sentence for false", async () => {
    const signedOut = Response.json({ error: { code: "forbidden", message: "You've been signed out." } }, { status: 401 });
    const refusing = createFeedbackAdminHandlers({ db: t.db, tenantId: tenant(), authorize: () => signedOut.clone() });
    expect((await refusing.handle(new Request("http://localhost/x/v1/admin/board"))).status).toBe(401);
    const no = createFeedbackAdminHandlers({ db: t.db, tenantId: tenant(), authorize: () => false });
    const res = await no.handle(new Request("http://localhost/x/v1/admin/board"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "You don't have permission to do that." } });
  });

  it("never writes for a request authorize refused (no board is set up for a made-up company)", async () => {
    const made = tenant("made-up");
    const no = createFeedbackAdminHandlers({ db: t.db, resolveTenant: () => made, authorize: () => false });
    await no.handle(new Request("http://localhost/x/v1/admin/board"));
    const rows = (await t.db.execute(sql`select count(*)::int as n from feedback_statuses where tenant_id = ${made}`)) as unknown as {
      rows: Array<{ n: number }>;
    };
    expect(rows.rows[0]?.n).toBe(0);
  });

  it("refuses a POST from another site before any work", async () => {
    const asked: Asked[] = [];
    const { handle } = handlers(asked);
    const res = await handle(
      new Request(`http://localhost/api/app/${tenant()}/feedback/v1/admin/archive-done`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(asked).toEqual([]);
  });

  it("announces a reply and a move with the reporter's address, under the replier's name", async () => {
    const a = tenant();
    const A = await plant(a, "Alpha");
    const events: FeedbackEvent[] = [];
    const { handle } = handlers([], events);
    const reply = FEEDBACK_ADMIN_ROUTES.find((r) => r.kind === "reply")!;
    const move = FEEDBACK_ADMIN_ROUTES.find((r) => r.kind === "move")!;
    const replied = await handle(requestFor(a, reply, A.rows));
    expect(replied.status).toBe(201);
    expect(((await replied.json()) as { message: { senderName: string } }).message.senderName).toBe(`Person user-of-${a}`);
    await handle(requestFor(a, move, A.rows));
    // The same move again changes nothing and tells nobody.
    await handle(requestFor(a, move, A.rows));
    expect(events.map((e) => e.type)).toEqual(["staff.replied", "ticket.moved"]);
    expect(events[1]).toMatchObject({ toStatus: "in_progress", toLabel: "In progress", reporterEmail: "Alpha@reporter.test" });
  });

  it("shows a new website key once, and never again", async () => {
    const a = tenant();
    const { handle } = handlers();
    const issued = (await (
      await handle(
        new Request(`http://localhost/api/app/${a}/feedback/v1/admin/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "Our website" }),
        }),
      )
    ).json()) as { key: { secret: string } };
    expect(issued.key.secret).toMatch(/^aik_/);
    const listed = await (await handle(new Request(`http://localhost/api/app/${a}/feedback/v1/admin/keys`))).text();
    expect(listed).toContain("Our website");
    expect(listed).not.toContain(issued.key.secret);
  });

  it("refuses a duplicate column key with a sentence, and a column that holds tickets", async () => {
    const a = tenant();
    const A = await plant(a, "Alpha");
    const { handle } = handlers();
    const dupe = await handle(
      new Request(`http://localhost/api/app/${a}/feedback/v1/admin/columns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "waiting", label: "Again" }),
      }),
    );
    expect(dupe.status).toBe(409);
    expect(((await dupe.json()) as { error: { message: string } }).error.message).toBe("This board already has a column with that name.");
    const columns = ((await (await handle(new Request(`http://localhost/api/app/${a}/feedback/v1/admin/columns`))).json()) as {
      columns: Array<{ id: string; key: string; ticketCount: number }>;
    }).columns;
    const open = columns.find((c) => c.key === "open")!;
    expect(open.ticketCount).toBe(1);
    const occupied = await handle(
      new Request(`http://localhost/api/app/${a}/feedback/v1/admin/columns/${open.id}/delete`, { method: "POST", body: "{}" }),
    );
    expect(occupied.status).toBe(409);
    expect(((await occupied.json()) as { error: { message: string } }).error.message).toBe("This column holds 1 ticket. Move it to another column first.");
    void A;
  });
});
