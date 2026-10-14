import { commsMessages, commsScheduled } from "@adminigloo/comms";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSchedulingCommsListener } from "../comms.js";
import {
  addTimeOff,
  bookVisit,
  createResource,
  createSchedulingAdminHandlers,
  createSchedulingHandlers,
  findPublicSlots,
  issueManageToken,
  requestPublicBooking,
  resolveSchedulingSettings,
  SCHEDULING_ADMIN_ROUTE_PERMISSIONS,
  SCHEDULING_ADMIN_ROUTES,
  SCHEDULING_CREW_ROLE,
  SCHEDULING_PUBLIC_ROUTES,
  schedulingChecklistItems,
  schedulingPermissions,
  setAvailability,
  updateSchedulingSettings,
  type SchedulingCompany,
  type SchedulingEvent,
  type SchedulingPermission,
  type SchedulingRoute,
} from "../index.js";
import { schedulingAvailability, schedulingBookings, schedulingResources, schedulingSettings } from "../schema.js";
import { recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Scheduling inside companies (Tenancy 2a, 13.2), two tenants on one real
 * Postgres: the company's basics overlaid, the zone CONVERGED (visits keep
 * their clock times, reminders re-queued, nothing written twice), the
 * closed answer before any query, async links and a per-company inbox, the
 * route tables, and company B getting not-found or nothing of company A's
 * through every staff and public route.
 */

const THU = new Date("2026-10-29T15:00:00Z"); // Thu 2026-10-29 09:00 MDT
let t: TestDb;
let clock = THU;

beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  vi.useRealTimers();
});

function pinClock(at: Date = THU) {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = at;
  vi.setSystemTime(at);
}

const COMPANIES = new Map<string, SchedulingCompany>();
const company = (tenantId: string) => COMPANIES.get(tenantId) ?? null;
function companyFor(tenantId: string, extra: Partial<SchedulingCompany> = {}): SchedulingCompany {
  const value: SchedulingCompany = {
    name: "Green Acres",
    timeZone: "America/Denver",
    contactEmail: "gail@greenacres.test",
    contactPhone: "(801) 555-0100",
    logoUrl: null,
    brandColor: "#1f7a3a",
    ...extra,
  };
  COMPANIES.set(tenantId, value);
  return value;
}

const ALL = Object.keys(schedulingPermissions) as SchedulingPermission[];

function staffHandlers(member: string, extra: Partial<Parameters<typeof createSchedulingAdminHandlers>[0]> = {}) {
  return createSchedulingAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) =>
      tenantId === member && ALL.includes(permission)
        ? { userId: `user-of-${member}` }
        : new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 }),
    company,
    companySettingsHref: "/settings/company#details",
    now: () => clock,
    ...extra,
  });
}

function publicHandlers(extra: Partial<Parameters<typeof createSchedulingHandlers>[0]> = {}) {
  return createSchedulingHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/t\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    manageUrl: async (token, id) => `https://app.test/t/${id}/visit/${token}`,
    company,
    minFillMs: 0,
    now: () => clock,
    ...extra,
  });
}

function fill(text: string, rows: Record<string, string>): string {
  return text.replace(/\{([a-z-]+)\}/g, (_m, entity: string) => rows[entity] ?? `{${entity}}`);
}

function request(base: string, route: SchedulingRoute, rows: Record<string, string>): Request {
  const query = route.query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, fill(v, rows)])))}` : "";
  return new Request(`${base}${fill(route.path, rows)}${query}`, {
    method: route.method,
    headers: { "sec-fetch-site": "same-origin", ...(route.method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(route.method === "POST" ? { body: fill(JSON.stringify(route.body ?? {}), rows) } : {}),
  });
}

const get = (h: { handle: (r: Request) => Promise<Response> }, url: string) => h.handle(new Request(url, { headers: { "sec-fetch-site": "same-origin" } }));
const post = (h: { handle: (r: Request) => Promise<Response> }, url: string, body: unknown) =>
  h.handle(new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) }));

async function saved(tenantId: string, extra: Parameters<typeof updateSchedulingSettings>[2] = {}) {
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Old Stored Name",
    contactEmail: "old@stored.test",
    services: [{ key: "visit", name: "Lawn visit", durationMinutes: 60 }],
    staffNotifyEmails: [],
    ...extra,
  });
}

describe("the company's basics (D5, D6)", () => {
  it("the public config's name, contact and zone are the company's", async () => {
    pinClock();
    const a = tenant("green");
    await saved(a);
    companyFor(a, { timeZone: "America/Denver" });
    const res = await get(publicHandlers(), `https://app.test/api/t/${a}/schedule/v1/config`);
    const config = (await res.json()) as Record<string, unknown>;
    expect(config).toMatchObject({ businessName: "Green Acres", contactEmail: "gail@greenacres.test", contactPhone: "(801) 555-0100", timeZone: "America/Denver" });
  });

  it("settings-get reports managedByCompany with the href; without a seam it is null", async () => {
    pinClock();
    const a = tenant();
    await saved(a);
    companyFor(a);
    const managed = (await (await get(staffHandlers(a), `https://app.test/api/app/${a}/schedule/v1/admin/settings`)).json()) as { settings: Record<string, unknown> };
    expect(managed.settings).toMatchObject({ businessName: "Green Acres", managedByCompany: { href: "/settings/company#details" } });
    const plain = (await (await get(staffHandlers(a, { company: undefined }), `https://app.test/api/app/${a}/schedule/v1/admin/settings`)).json()) as { settings: Record<string, unknown> };
    expect(plain.settings).toMatchObject({ businessName: "Old Stored Name", managedByCompany: null });
  });

  it("settings-update drops the company-owned keys; a body of only them changes nothing", async () => {
    pinClock();
    const a = tenant();
    await saved(a);
    companyFor(a);
    const h = staffHandlers(a);
    const [before] = await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a));
    const only = await post(h, `https://app.test/api/app/${a}/schedule/v1/admin/settings`, {
      businessName: "Hacked",
      timeZone: "Asia/Tokyo",
      contactEmail: "evil@x.test",
      contactPhone: "000",
    });
    expect(only.status).toBe(200);
    expect(((await only.json()) as { settings: Record<string, unknown> }).settings).toMatchObject({ businessName: "Green Acres", timeZone: "America/Denver" });
    const [after] = await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a));
    expect(after).toEqual(before);
    const mixed = await post(h, `https://app.test/api/app/${a}/schedule/v1/admin/settings`, { businessName: "Hacked", slotStepMinutes: 15 });
    expect(((await mixed.json()) as { settings: Record<string, unknown> }).settings).toMatchObject({ businessName: "Green Acres", slotStepMinutes: 15 });
    const [stored] = await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a));
    expect(stored).toMatchObject({ businessName: "Old Stored Name", slotStepMinutes: 15, timeZone: "America/Denver" });
  });

  it("a throwing company seam is reported and the request uses the stored settings", async () => {
    pinClock();
    const a = tenant();
    await saved(a);
    const errors: unknown[] = [];
    const h = publicHandlers({
      company: () => {
        throw new Error("profile down");
      },
      onError: (e) => errors.push(e),
    });
    const config = (await (await get(h, `https://app.test/api/t/${a}/schedule/v1/config`)).json()) as Record<string, unknown>;
    expect(config.businessName).toBe("Old Stored Name");
    expect(errors).toHaveLength(1);
  });
});

describe("converging the zone (D5)", () => {
  async function setUpVisits() {
    pinClock();
    const a = tenant("green");
    await saved(a, { staffNotifyEmails: ["office@greenacres.test"] });
    companyFor(a, { timeZone: "America/Denver" });
    const crew = await createResource(t.db, { tenantId: a, name: "Crew A" });
    const mail = recordingSender();
    const events: SchedulingEvent[] = [];
    const listener = createSchedulingCommsListener({
      db: t.db,
      senders: mail.senders,
      manageUrl: async (token, id) => `https://app.test/t/${id}/visit/${token}`,
      company,
      now: () => clock,
    });
    const onEvent = async (event: SchedulingEvent) => {
      events.push(event);
      await listener.onEvent(event);
    };
    const confirmed = await bookVisit(
      t.db,
      { tenantId: a, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerName: "Pat", customerEmail: "pat@example.com" },
      { now: clock, onEvent, actor: { type: "staff", id: "u1" } },
    );
    const slot = (await findPublicSlots(t.db, { tenantId: a, service: "visit", from: "2026-11-03", days: 1 }, { now: clock })).find((s) => s.startTime === "10:00")!;
    const pending = await requestPublicBooking(
      t.db,
      { tenantId: a, slotId: slot.slotId, service: "visit", customerName: "Lee", customerEmail: "lee@example.com" },
      { now: clock, onEvent },
    );
    return { a, crew, events, onEvent, listener, mail, confirmedId: confirmed.visit.id, pendingId: pending.id };
  }

  it("the next request moves every visit's instants to the company's zone at the same clock time, re-queues the reminder, emails nobody", async () => {
    const { a, events, onEvent, mail, confirmedId, pendingId } = await setUpVisits();
    const [beforeConfirmed] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, confirmedId));
    const [oldReminder] = await t.db.select().from(commsScheduled).where(and(eq(commsScheduled.tenantId, a), eq(commsScheduled.refId, confirmedId), eq(commsScheduled.status, "pending")));
    expect(oldReminder).toBeDefined();
    const sentBefore = mail.sent.length;
    events.length = 0;

    companyFor(a, { timeZone: "America/Chicago" });
    const config = (await (await get(publicHandlers({ onEvent }), `https://app.test/api/t/${a}/schedule/v1/config`)).json()) as Record<string, unknown>;
    expect(config.timeZone).toBe("America/Chicago");

    const [afterConfirmed] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, confirmedId));
    const [afterPending] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, pendingId));
    // 09:00 on Nov 2 (after DST ended): MST is 16:00Z, CST is 15:00Z.
    expect(beforeConfirmed?.startsAt?.toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(afterConfirmed).toMatchObject({ startTime: "09:00", scheduledDate: beforeConfirmed?.scheduledDate });
    expect(afterConfirmed?.startsAt?.toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(afterConfirmed?.sequence).toBe((beforeConfirmed?.sequence ?? 0) + 1);
    expect(afterPending?.startTime).toBe("10:00");
    expect(afterPending?.startsAt?.toISOString()).toBe("2026-11-03T16:00:00.000Z");

    const moved = events.filter((e) => e.type === "visit.rescheduled");
    expect(moved.map((e) => e.visitId).sort()).toEqual([confirmedId, pendingId].sort());
    expect(moved.every((e) => e.data.via === "time_zone" && e.data.notify === false && e.actor.type === "system")).toBe(true);
    // Customers aren't emailed, and the office isn't either (nothing a customer did).
    expect(mail.sent.length).toBe(sentBefore);

    const queue = await t.db.select().from(commsScheduled).where(and(eq(commsScheduled.tenantId, a), eq(commsScheduled.refId, confirmedId)));
    expect(queue.find((r) => r.id === oldReminder!.id)?.status).toBe("cancelled");
    const fresh = queue.find((r) => r.status === "pending");
    expect(fresh).toBeDefined();
    // The new reminder runs on the new instant: 24 hours (and an hour for the cutoff) before 15:00Z.
    expect(fresh!.sendAt.getTime()).toBe(oldReminder!.sendAt.getTime() - 3_600_000);
  });

  it("a second request writes nothing (an in-memory compare)", async () => {
    const { a, onEvent } = await setUpVisits();
    companyFor(a, { timeZone: "America/Chicago" });
    const h = publicHandlers({ onEvent });
    await get(h, `https://app.test/api/t/${a}/schedule/v1/config`);
    t.queries.length = 0;
    await get(h, `https://app.test/api/t/${a}/schedule/v1/config`);
    const writes = t.queries.filter((q) => /^(insert|update|delete)\b/i.test(q.sql.trim()) || q.sql.includes("pg_advisory_xact_lock"));
    expect(writes).toEqual([]);
  });

  it("the admin side converges the same way, and the listener's re-entrance is a no-op", async () => {
    const { a, events, onEvent } = await setUpVisits();
    companyFor(a, { timeZone: "America/Chicago" });
    events.length = 0;
    await get(staffHandlers(a, { onEvent }), `https://app.test/api/app/${a}/schedule/v1/admin/settings`);
    const moved = events.filter((e) => e.type === "visit.rescheduled");
    // Each visit moved ONCE: the listener read settings again with the company
    // seam inside its own event, found the zone already converged, and wrote nothing.
    expect(moved).toHaveLength(2);
    const [row] = await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a));
    expect(row?.timeZone).toBe("America/Chicago");
  });

  it("with no stored row the zone is overlaid in memory: nothing is inserted, online booking stays as it was", async () => {
    pinClock();
    const a = tenant();
    companyFor(a, { timeZone: "America/Chicago" });
    const settings = await resolveSchedulingSettings(t.db, a, { company });
    expect(settings).toMatchObject({ timeZone: "America/Chicago", saved: false, managedByCompany: true, businessName: "Green Acres", publicBookingEnabled: true });
    expect(await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a))).toEqual([]);
  });

  it("a company with no zone yet leaves scheduling's own", async () => {
    pinClock();
    const a = tenant();
    await saved(a, { timeZone: "America/New_York" });
    companyFor(a, { timeZone: null });
    const settings = await resolveSchedulingSettings(t.db, a, { company });
    expect(settings.timeZone).toBe("America/New_York");
    const [row] = await t.db.select().from(schedulingSettings).where(eq(schedulingSettings.tenantId, a));
    expect(row?.timeZone).toBe("America/New_York");
  });
});

describe("admission (D7)", () => {
  it("closed → 409 booking_closed with the message on EVERY public route, before any scheduling query", async () => {
    pinClock();
    const a = tenant();
    const message = "Green Acres isn't taking requests online right now. Call (801) 555-0100.";
    let limited = 0;
    const h = publicHandlers({ admit: () => ({ open: false, message }), rateLimit: () => (limited++, true) });
    for (const route of SCHEDULING_PUBLIC_ROUTES) {
      t.queries.length = 0;
      const res = await h.handle(request(`https://app.test/api/t/${a}/schedule/`, route, { "visit-token": "A".repeat(43) }));
      expect(res.status, route.kind).toBe(409);
      expect(await res.json(), route.kind).toEqual({ error: { code: "booking_closed", message } });
      expect(t.queries, route.kind).toHaveLength(0);
      if (route.path.includes("{visit-token}") || route.query?.manage) expect(res.headers.get("referrer-policy"), route.kind).toBe("no-referrer");
    }
    expect(limited).toBe(0);
  });

  it("open → the routes answer as before", async () => {
    pinClock();
    const a = tenant();
    const res = await get(publicHandlers({ admit: () => ({ open: true }) }), `https://app.test/api/t/${a}/schedule/v1/config`);
    expect(res.status).toBe(200);
  });
});

describe("async links and the company's inbox (6.5, D8)", () => {
  it("async manage, book and admin links land in the emails; the office notice goes to the company's inbox", async () => {
    pinClock();
    const a = tenant("green");
    await saved(a);
    companyFor(a);
    await createResource(t.db, { tenantId: a, name: "Crew A" });
    const mail = recordingSender();
    const inboxAsked: string[] = [];
    const listener = createSchedulingCommsListener({
      db: t.db,
      senders: mail.senders,
      manageUrl: async (token, id) => `https://app.test/t/${id}/visit/${token}`,
      bookUrl: async (id) => `https://app.test/t/${id}/book-visit`,
      adminUrl: async (id) => `https://app.test/app/switch/${id}?next=/app/schedule`,
      staffEmails: async (id) => (inboxAsked.push(id), [`inbox@${id}.test`]),
      company,
      now: () => clock,
    });
    const slot = (await findPublicSlots(t.db, { tenantId: a, service: "visit", from: "2026-11-03", days: 1 }, { now: clock }))[0]!;
    await requestPublicBooking(t.db, { tenantId: a, slotId: slot.slotId, service: "visit", customerName: "Lee", customerEmail: "lee@example.com" }, { now: clock, onEvent: listener.onEvent });
    const customer = mail.sent.find((m) => m.to === "lee@example.com")!;
    expect(customer.body).toContain(`https://app.test/t/${a}/visit/`);
    expect(customer.body).toContain("Green Acres");
    const office = mail.sent.find((m) => m.to === `inbox@${a}.test`)!;
    expect(office).toBeDefined();
    expect(office.body).toContain(`https://app.test/app/switch/${a}?next=/app/schedule`);
    expect(inboxAsked).toEqual([a]);
    // Reply on the office's notice reaches the customer (review T2A-BO-12); the
    // customer's own email keeps the business's reply-to.
    expect(office.replyTo).toBe("lee@example.com");
    expect(customer.replyTo).toBeNull();
    // The manage token never stays in the log.
    const log = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, a));
    expect(log.some((row) => /visit\/[A-Za-z0-9_-]{43}/.test(row.body))).toBe(false);
  });

  it("a throwing link function folds its line and is reported; the email still goes", async () => {
    pinClock();
    const a = tenant();
    await saved(a, { staffNotifyEmails: ["office@x.test"] });
    companyFor(a);
    const crew = await createResource(t.db, { tenantId: a, name: "Crew A" });
    const mail = recordingSender();
    const errors: Array<{ step: string }> = [];
    const listener = createSchedulingCommsListener({
      db: t.db,
      senders: mail.senders,
      manageUrl: async () => {
        throw new Error("no web address");
      },
      bookUrl: () => {
        throw new Error("no booking page");
      },
      company,
      now: () => clock,
      onError: (_e, context) => errors.push(context),
    });
    await bookVisit(
      t.db,
      { tenantId: a, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "pat@example.com" },
      { now: clock, onEvent: listener.onEvent },
    );
    const confirmation = mail.sent.find((m) => m.to === "pat@example.com")!;
    expect(confirmation).toBeDefined();
    expect(confirmation.body).toContain("Need to change it? Please call us at (801) 555-0100.");
    expect(errors.filter((e) => e.step === "links").length).toBeGreaterThanOrEqual(1);
  });

  it("saved staffNotifyEmails win over the company inbox; the inbox function is per tenant", async () => {
    pinClock();
    const a = tenant();
    const b = tenant();
    await saved(a, { staffNotifyEmails: ["saved@a.test"] });
    await saved(b, { staffNotifyEmails: [] });
    companyFor(a);
    companyFor(b, { name: "Summit Lawn" });
    for (const id of [a, b]) await createResource(t.db, { tenantId: id, name: "Crew" });
    const mail = recordingSender();
    const listener = createSchedulingCommsListener({
      db: t.db,
      senders: mail.senders,
      manageUrl: (token) => `https://app.test/v/${token}`,
      staffEmails: (id) => [`inbox@${id}.test`],
      company,
      now: () => clock,
    });
    for (const id of [a, b]) {
      const slot = (await findPublicSlots(t.db, { tenantId: id, service: "visit", from: "2026-11-03", days: 1 }, { now: clock }))[0]!;
      await requestPublicBooking(t.db, { tenantId: id, slotId: slot.slotId, service: "visit", customerName: "Lee", customerEmail: `lee-${id}@example.com` }, { now: clock, onEvent: listener.onEvent });
    }
    const staffTo = mail.sent.filter((m) => m.subject?.startsWith("New request")).map((m) => m.to).sort();
    expect(staffTo).toEqual(["saved@a.test", `inbox@${b}.test`].sort());
  });
});

describe("route tables (3.1)", () => {
  it("every staff row routes to its kind; the permission map agrees with the table", async () => {
    pinClock();
    const a = tenant();
    for (const route of SCHEDULING_ADMIN_ROUTES) {
      const asked: string[] = [];
      const h = createSchedulingAdminHandlers({ db: t.db, tenantId: a, authorize: (_r, permission) => (asked.push(permission), false) });
      const res = await h.handle(request("https://app.test/api/x/", route, { resource: "r1", visit: "v1", "time-off": "o1" }));
      expect(res.status, route.kind).toBe(403);
      expect(asked, route.kind).toEqual([SCHEDULING_ADMIN_ROUTE_PERMISSIONS[route.kind]]);
      expect(route.permission, route.kind).toBe(SCHEDULING_ADMIN_ROUTE_PERMISSIONS[route.kind]);
    }
    expect(new Set(SCHEDULING_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(SCHEDULING_ADMIN_ROUTE_PERMISSIONS).length);
    expect(Object.isFrozen(SCHEDULING_ADMIN_ROUTES) && Object.isFrozen(SCHEDULING_PUBLIC_ROUTES)).toBe(true);
  });

  it("every public row routes to its kind (its rate-limit bucket), and nowhere on the wrong method", async () => {
    pinClock();
    const a = tenant();
    const expected: Record<string, string> = { config: "read", slots: "read", request: "request", visit: "read", reschedule: "manage", cancel: "manage", ics: "read" };
    for (const route of SCHEDULING_PUBLIC_ROUTES) {
      const buckets: string[] = [];
      const h = publicHandlers({ rateLimit: (_req, bucket) => (buckets.push(bucket), false) });
      const res = await h.handle(request(`https://app.test/api/t/${a}/schedule/`, route, { "visit-token": "A".repeat(43) }));
      expect(res.status, route.kind).toBe(429);
      expect(buckets, route.kind).toEqual([expected[route.kind]]);
      const wrong = await h.handle(
        new Request(`https://app.test/api/t/${a}/schedule/${fill(route.path, { "visit-token": "A".repeat(43) })}`, {
          method: route.method === "GET" ? "POST" : "GET",
          headers: { "sec-fetch-site": "same-origin" },
          ...(route.method === "GET" ? { body: "{}" } : {}),
        }),
      );
      expect(wrong.status, `${route.kind} wrong method`).toBe(404);
    }
  });

  it("every example reaches its lookup: on an EMPTY company a path placeholder is 404, the rest below 500", async () => {
    pinClock();
    const empty = tenant("empty");
    const made = { resource: crypto.randomUUID(), visit: crypto.randomUUID(), "time-off": crypto.randomUUID(), "visit-token": "Z".repeat(43) };
    const staff = staffHandlers(empty);
    for (const route of SCHEDULING_ADMIN_ROUTES) {
      const res = await staff.handle(request(`https://app.test/api/app/${empty}/schedule/`, route, made));
      if (/\{[a-z-]+\}/.test(route.path)) {
        expect(res.status, route.kind).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, route.kind).toBe("not_found");
      } else expect(res.status, route.kind).toBeLessThan(500);
    }
    const pub = publicHandlers();
    for (const route of SCHEDULING_PUBLIC_ROUTES) {
      const res = await pub.handle(request(`https://app.test/api/t/${empty}/schedule/`, route, made));
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, route.kind).toBe(404);
      else expect(res.status, route.kind).toBeLessThan(500);
    }
  });
});

describe("two companies, every route", () => {
  async function plant(tenantId: string, label: string) {
    await saved(tenantId, { businessName: `${label} Lawn` });
    companyFor(tenantId, { name: `${label} Lawn` });
    const crew = await createResource(t.db, { tenantId, name: `${label} crew` });
    await setAvailability(t.db, { tenantId, resourceId: crew.id, scope: "weekly", blocks: [{ dayOfWeek: 1, startTime: "08:00", endTime: "17:00" }] });
    await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: "2026-12-24", to: "2026-12-24", note: `${label} holiday` }, { now: clock });
    const [off] = await t.db
      .select({ id: schedulingAvailability.id })
      .from(schedulingAvailability)
      .where(and(eq(schedulingAvailability.tenantId, tenantId), isNotNull(schedulingAvailability.specificDate)));
    const visit = await bookVisit(
      t.db,
      {
        tenantId,
        resourceId: crew.id,
        scheduledDate: "2026-11-02",
        startTime: "09:00",
        endTime: "10:00",
        customerName: `${label} Customer`,
        customerEmail: `${label.toLowerCase()}@example.com`,
        address: `1 ${label} Way`,
      },
      { now: clock },
    );
    const token = (await issueManageToken(t.db, tenantId, visit.visit.id)) as string;
    return {
      rows: { resource: crew.id, visit: visit.visit.id, "time-off": (off as { id: string }).id, "visit-token": token },
      strings: [crew.id, visit.visit.id, token, `${label} crew`, `${label} Customer`, `${label.toLowerCase()}@example.com`, `1 ${label} Way`, `${label} holiday`],
    };
  }

  async function snapshot(tenantId: string) {
    const tables = [schedulingBookings, schedulingResources, schedulingAvailability, schedulingSettings] as const;
    const out: unknown[] = [];
    for (const table of tables) out.push(await t.db.select().from(table).where(eq(table.tenantId, tenantId)));
    return JSON.stringify(out);
  }

  it("B gets 403 with A's id, and 404 or nothing of A's with A's rows; A is unchanged", async () => {
    pinClock();
    const a = tenant("alpha");
    const b = tenant("bravo");
    const A = await plant(a, "Alpha");
    await plant(b, "Bravo");
    const before = await snapshot(a);
    const asB = staffHandlers(b);
    for (const route of SCHEDULING_ADMIN_ROUTES) {
      const viaA = await asB.handle(request(`https://app.test/api/app/${a}/schedule/`, route, A.rows));
      expect(viaA.status, route.kind).toBe(403);
      const res = await asB.handle(request(`https://app.test/api/app/${b}/schedule/`, route, A.rows));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, `${route.kind}: ${text}`).toBe(404);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    const pub = publicHandlers();
    for (const route of SCHEDULING_PUBLIC_ROUTES) {
      const res = await pub.handle(request(`https://app.test/api/t/${b}/schedule/`, route, A.rows));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, route.kind).toBe(404);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    expect(await snapshot(a)).toBe(before);
  });
});

describe("Crew and the checklist", () => {
  it("SCHEDULING_CREW_ROLE fits defineTenantRoles' rules; schedule.route includes crew and nothing else does", () => {
    expect(SCHEDULING_CREW_ROLE.key).toMatch(/^[a-z][a-z0-9_]{1,31}$/);
    expect(["owner", "admin", "member", "viewer"]).not.toContain(SCHEDULING_CREW_ROLE.key);
    expect(Number.isInteger(SCHEDULING_CREW_ROLE.rank)).toBe(true);
    expect(SCHEDULING_CREW_ROLE.rank).toBeGreaterThanOrEqual(1);
    expect(SCHEDULING_CREW_ROLE.rank).toBeLessThanOrEqual(29);
    expect([10, 20]).not.toContain(SCHEDULING_CREW_ROLE.rank);
    expect(SCHEDULING_CREW_ROLE.name.length).toBeGreaterThan(0);
    expect(SCHEDULING_CREW_ROLE.description.length).toBeLessThanOrEqual(200);
    expect(schedulingPermissions["schedule.route"].defaultFor).toContain("crew");
    for (const [key, def] of Object.entries(schedulingPermissions)) {
      if (key !== "schedule.route") expect(def.defaultFor, key).not.toContain("crew");
    }
  });

  it("booking: not done until online booking is on; crews: until an active crew has hours; tenant-scoped", async () => {
    pinClock();
    const a = tenant();
    const b = tenant();
    const [booking, crews] = schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" });
    expect(booking).toMatchObject({ key: "schedule.booking", order: 40, permission: "schedule.resources.manage", href: "/app/schedule/settings#booking" });
    expect(crews).toMatchObject({ key: "schedule.crews", order: 50, href: "/app/schedule/settings#crews" });
    expect(await booking!.isDone({ db: t.db, tenantId: a })).toBe(false);
    await saved(a, { publicBookingEnabled: false });
    expect(await booking!.isDone({ db: t.db, tenantId: a })).toBe(false);
    await updateSchedulingSettings(t.db, a, { publicBookingEnabled: true });
    expect(await booking!.isDone({ db: t.db, tenantId: a })).toBe(true);
    expect(await booking!.isDone({ db: t.db, tenantId: b })).toBe(false);

    const crew = await createResource(t.db, { tenantId: a, name: "Crew A" });
    expect(await crews!.isDone({ db: t.db, tenantId: a })).toBe(false);
    await setAvailability(t.db, { tenantId: a, resourceId: crew.id, scope: "weekly", blocks: [{ dayOfWeek: 2, startTime: "08:00", endTime: "16:00" }] });
    expect(await crews!.isDone({ db: t.db, tenantId: a })).toBe(true);
    expect(await crews!.isDone({ db: t.db, tenantId: b })).toBe(false);
  });
});

describe("Tenancy 2a review: the company's zone, contact and crew members, in the schedule's notices", () => {
  const BASE = (id: string) => `https://app.test/api/app/${id}/schedule/v1/admin`;
  type Notice = { code: string; tone: string; message: string; link?: { href: string; label: string } | null };

  it("no company zone: the notice says so and links to company settings; online booking waits for it (T2A-BO-07)", async () => {
    pinClock();
    const a = tenant();
    companyFor(a, { timeZone: null });
    await saved(a, { publicBookingEnabled: false });
    const h = staffHandlers(a);
    const status = (await (await get(h, `${BASE(a)}/status`)).json()) as { notices: Notice[] };
    const zone = status.notices.find((n) => n.code === "setup_zone");
    expect(zone?.tone).toBe("warn");
    expect(zone?.message).toMatch(/^Your company's time zone isn't set yet, so visits are shown in Mountain Time/);
    expect(zone?.link).toEqual({ href: "/settings/company#details", label: "Open company settings" });
    // No notice sends the owner to change a company field in Schedule settings.
    expect(status.notices.filter((n) => /in Schedule settings before|phone number in Schedule settings|name in Schedule settings/.test(n.message))).toEqual([]);

    const refused = await post(h, `${BASE(a)}/settings`, { publicBookingEnabled: true });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: { code: string; issues: { path: string[]; message: string }[] } };
    expect(body.error.code).toBe("invalid");
    expect(body.error.issues[0]).toMatchObject({ path: ["publicBookingEnabled"] });
    expect(body.error.issues[0]!.message).toMatch(/time zone/);

    // Once the company has its zone, booking opens.
    companyFor(a, { timeZone: "America/New_York" });
    const opened = await post(h, `${BASE(a)}/settings`, { publicBookingEnabled: true });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { settings: { publicBookingEnabled: boolean } }).settings.publicBookingEnabled).toBe(true);
  });

  it("a company with no phone is told to add it in COMPANY settings, with the link (T2A-BO-07)", async () => {
    pinClock();
    const a = tenant();
    companyFor(a, { contactPhone: null, contactEmail: null });
    await saved(a, { publicBookingEnabled: false });
    const status = (await (await get(staffHandlers(a), `${BASE(a)}/status`)).json()) as { notices: Notice[] };
    const contact = status.notices.find((n) => n.code === "setup_contact");
    expect(contact?.message).toBe(
      "Add a phone number in your company settings. Customers are told to call it when it's too late to change a visit online.",
    );
    expect(contact?.link?.href).toBe("/settings/company#details");
    const zone = status.notices.find((n) => n.code === "setup_zone");
    expect(zone?.message).toMatch(/your company's time zone\. If that isn't where you work, change it in your company settings/);
  });

  it("a crew member who isn't on a crew yet is named, with a link to pick their crew, until they are (T2A-BO-04)", async () => {
    pinClock();
    const a = tenant();
    companyFor(a);
    await saved(a);
    const h = staffHandlers(a, {
      settingsHref: "/app/schedule/settings",
      listPeople: () => [
        { userId: "gail", name: "Gail Green", email: "gail@greenacres.test", roleKey: "owner" },
        { userId: "cam", name: "Cam Lee", email: "cam@greenacres.test", roleKey: SCHEDULING_CREW_ROLE.key },
      ],
    });
    const before = (await (await get(h, `${BASE(a)}/status`)).json()) as { notices: Notice[] };
    const crew = before.notices.filter((n) => n.code === "crew_unlinked");
    expect(crew).toHaveLength(1);
    expect(crew[0]!.message).toBe(
      "Cam Lee joined as a crew member but isn't on a crew yet, so their route won't open. Pick them for their crew in Schedule settings → Crews.",
    );
    expect(crew[0]!.link).toEqual({ href: "/app/schedule/settings#crews", label: "Pick their crew" });
    // People never reach the wire with their role.
    const people = (await (await get(h, `${BASE(a)}/people`)).json()) as { people: Record<string, unknown>[] };
    expect(people.people.every((p) => !("roleKey" in p))).toBe(true);

    await createResource(t.db, { tenantId: a, name: "Crew 1", userId: "cam" });
    const after = (await (await get(h, `${BASE(a)}/status`)).json()) as { notices: Notice[] };
    expect(after.notices.some((n) => n.code === "crew_unlinked")).toBe(false);
  });
});
