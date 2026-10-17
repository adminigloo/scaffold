import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBookingAdminHandlers, type CreateBookingAdminHandlersOptions } from "../admin-handlers.js";
import { bookingEmailVars } from "../emails.js";
import { createBookingHandlers, type AdmitVerdict, type CreateBookingHandlersOptions } from "../handlers.js";
import { bookingCompanyPermissions, bookingPermissions } from "../permissions.js";
import { BOOKING_ADMIN_ROUTE_PERMISSIONS, BOOKING_ADMIN_ROUTES, BOOKING_PUBLIC_ROUTES, type BookingRoute } from "../routes.js";
import {
  addBlackout,
  addException,
  rotateHostFeedToken,
  setWeeklyAvailability,
  upsertHost,
  upsertType,
} from "../services/admin.js";
import type { BookingContext, BookingEvent } from "../services/context.js";
import { book, holdSlot } from "../services/public.js";
import { claimReminder, dueReminders } from "../services/reminders.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * BOOK-A-CALL PER COMPANY (0.2), as a companies project mounts it: the id in
 * the path (admin) or the web address (public) decides the business, and
 * nothing of another business's is reachable — every route of both route
 * tables is driven as company B with company A's ids and tokens, and must be
 * "not found" (a row named in the path) or refused below 500, with nothing of
 * A in the answer and A's rows unchanged.
 */

/** Monday 2026-10-05, 09:00 in Denver. */
const NOW = new Date("2026-10-05T15:00:00Z");
const HOST = "https://app.lawnco.test";
const WEEKDAYS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 }));

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

interface Planted {
  tenantId: string;
  rows: Record<string, string>;
  strings: string[];
}

/** One business with one of every kind of row the routes name. */
async function plant(label: string): Promise<Planted> {
  const tenantId = tenant(label);
  const ctx: BookingContext = { db: t.db, tenantId, now: NOW };
  const host = await upsertHost(ctx, { displayName: `${label} Host`, email: `host@${label}.test`, timezone: "America/Denver" });
  await setWeeklyAvailability(ctx, { hostId: host.id, windows: WEEKDAYS });
  const exception = await addException(ctx, { hostId: host.id, date: "2026-10-20", kind: "off", note: `${label} dentist` });
  const holiday = await addBlackout(ctx, { date: "2026-12-25", label: `${label} Christmas` });
  const type = await upsertType(ctx, { key: `${label}-call`, name: `${label} intro call`, durationMinutes: 30, media: ["video"] });
  const { feedToken } = await rotateHostFeedToken(ctx, host.id);
  const booked = await book(ctx, {
    typeKey: type.key,
    start: "2026-10-06T16:00:00.000Z",
    name: `${label} Customer`,
    email: `customer@${label}.test`,
    medium: "video",
    timezone: "America/Denver",
  });
  const hold = await holdSlot(ctx, { typeKey: type.key, start: "2026-10-07T16:00:00.000Z" });
  const bookingId = (await t.client.query<{ id: string }>(`select id from booking_bookings where tenant_id = $1 and status = 'confirmed'`, [tenantId])).rows[0]!.id;
  return {
    tenantId,
    rows: {
      booking: bookingId,
      host: host.id,
      exception: exception.id,
      holiday: holiday.id,
      type: type.id,
      "type-key": type.key,
      "manage-token": booked.manageToken,
      "feed-token": feedToken,
      "hold-token": hold.holdToken,
    },
    strings: [tenantId, host.id, bookingId, type.id, exception.id, holiday.id, booked.manageToken, feedToken, hold.holdToken, `${label} Host`, `host@${label}.test`, `${label} Customer`, `customer@${label}.test`, `${label} dentist`, `${label} Christmas`, `${label} intro call`, `${label}-call`],
  };
}

async function snapshot(tenantId: string): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const table of ["booking_hosts", "booking_availability", "booking_exceptions", "booking_blackouts", "booking_types", "booking_bookings", "booking_events"]) {
    out[table] = (await t.client.query(`select * from ${table} where tenant_id = $1 order by id`, [tenantId])).rows;
  }
  return JSON.stringify(out);
}

const PLACEHOLDER = /\{([a-z][a-z-]*)\}/g;
const fill = (text: string, rows: Record<string, string>, encode: boolean) =>
  text.replace(PLACEHOLDER, (_w, entity: string) => {
    const value = rows[entity];
    if (value === undefined) throw new Error(`no planted row for {${entity}}`);
    return encode ? encodeURIComponent(value) : value;
  });
const fillDeep = (value: unknown, rows: Record<string, string>): unknown =>
  typeof value === "string"
    ? fill(value, rows, false)
    : Array.isArray(value)
      ? value.map((item) => fillDeep(item, rows))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, rows)]))
        : value;

function requestFor(base: string, route: BookingRoute, rows: Record<string, string>): Request {
  const url = new URL(base + fill(route.path, rows, true));
  for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, fill(value, rows, false));
  const headers = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  return route.method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method: "POST", headers, body: JSON.stringify(fillDeep(route.body ?? {}, rows)) });
}

const tenantInPath = (req: Request) => decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");

function adminFor(extra: Partial<CreateBookingAdminHandlersOptions> = {}) {
  const asked: string[] = [];
  const handlers = createBookingAdminHandlers({
    db: t.db,
    resolveTenant: tenantInPath,
    authorize: (_req, permission) => {
      asked.push(permission);
      return { userId: "u_owner" };
    },
    feedUrl: (token) => ({ httpsUrl: `${HOST}/api/t/x/calls/v1/feed/${token}.ics` }),
    now: () => NOW,
    ...extra,
  });
  return { ...handlers, asked };
}

function publicFor(tenantId: string, extra: Partial<CreateBookingHandlersOptions> = {}) {
  return createBookingHandlers({
    db: t.db,
    tenantId,
    uidDomain: "lawnco.test",
    manageUrl: (token) => `${HOST}/t/x/book/manage/${token}`,
    now: () => NOW,
    ...extra,
  });
}

describe("every route of both tables, as company B with company A's rows", () => {
  let A: Planted;
  let B: Planted;
  beforeAll(async () => {
    A = await plant("alpha");
    B = await plant("bravo");
  });

  it("the tables are what the routers answer, and each route asks its one permission", async () => {
    const admin = adminFor();
    for (const route of BOOKING_ADMIN_ROUTES) {
      expect(route.permission).toBe(BOOKING_ADMIN_ROUTE_PERMISSIONS[route.kind]);
      expect(Object.keys(bookingCompanyPermissions)).toContain(route.permission);
      admin.asked.length = 0;
      const res = await admin.handle(requestFor(`${HOST}/api/app/${B.tenantId}/calls/`, route, B.rows));
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).not.toBe(404);
      expect(res.status, route.kind).toBeLessThan(500);
      expect(admin.asked, route.kind).toEqual([route.permission]);
    }
    expect(Object.keys(bookingCompanyPermissions)).toEqual(Object.keys(bookingPermissions));
  });

  it("private routes: A's ids in B's company are not found, nothing of A comes back, A unchanged", async () => {
    const before = await snapshot(A.tenantId);
    const admin = adminFor();
    for (const route of BOOKING_ADMIN_ROUTES) {
      const res = await admin.handle(requestFor(`${HOST}/api/app/${B.tenantId}/calls/`, route, A.rows));
      const text = await res.text();
      expect(A.strings.filter((s) => text.includes(s)), `${route.kind} leaked A: ${text.slice(0, 300)}`).toEqual([]);
      if (PLACEHOLDER.test(route.path)) {
        expect([res.status, JSON.parse(text).error?.code], `${route.kind}: ${text}`).toEqual([404, "not_found"]);
      } else {
        expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
      }
      PLACEHOLDER.lastIndex = 0;
    }
    expect(await snapshot(A.tenantId)).toBe(before);
  });

  it("public routes: A's type, hold, manage link and feed at B's address are not found, A unchanged", async () => {
    const before = await snapshot(A.tenantId);
    const handlers = publicFor(B.tenantId);
    for (const route of BOOKING_PUBLIC_ROUTES) {
      const res = await handlers.handle(requestFor(`${HOST}/api/t/bravo/calls/`, route, A.rows));
      const text = await res.text();
      expect(A.strings.filter((s) => text.includes(s)), `${route.kind} leaked A: ${text.slice(0, 300)}`).toEqual([]);
      const named = [...route.path.matchAll(PLACEHOLDER)].length > 0;
      if (named) expect([res.status, JSON.parse(text).error?.code], `${route.kind}: ${text}`).toEqual([404, "not_found"]);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
    }
    expect(await snapshot(A.tenantId)).toBe(before);
  });

  it("negative control: A's own tokens open A's own booking and feed", async () => {
    const handlers = publicFor(A.tenantId);
    const manage = await handlers.handle(new Request(`${HOST}/api/t/alpha/calls/v1/manage/${A.rows["manage-token"]}`));
    expect(manage.status).toBe(200);
    expect(await manage.text()).toContain("alpha Customer");
    const feed = await handlers.handle(new Request(`${HOST}/api/t/alpha/calls/v1/feed/${A.rows["feed-token"]}.ics`));
    expect(feed.status).toBe(200);
  });
});

describe("a closed business: no new bookings, the links it sent stay open", () => {
  it("plan closed: config, slots, hold and book say so by name; manage and cancel still work", async () => {
    const A = await plant("closedco");
    const closed: AdmitVerdict = { open: false, message: "Closed Co isn't taking requests online right now. Call 801-555-0100." };
    const asked: string[] = [];
    const handlers = publicFor(A.tenantId, {
      admit: () => {
        asked.push("new");
        return closed;
      },
      admitExisting: () => {
        asked.push("existing");
        return { open: true };
      },
    });
    for (const route of BOOKING_PUBLIC_ROUTES.filter((r) => ["config", "slots", "hold", "book"].includes(r.kind))) {
      const res = await handlers.handle(requestFor(`${HOST}/api/t/closedco/calls/`, route, A.rows));
      expect([res.status, (await res.json()).error], route.kind).toEqual([403, { code: "closed", message: closed.message }]);
    }
    const manage = await handlers.handle(new Request(`${HOST}/api/t/closedco/calls/v1/manage/${A.rows["manage-token"]}`));
    expect(manage.status).toBe(200);
    // A reschedule's own slot list rides the existing link.
    const slots = await handlers.handle(new Request(`${HOST}/api/t/closedco/calls/v1/slots?type=${A.rows["type-key"]}&manage=${A.rows["manage-token"]}`));
    expect(slots.status).toBe(200);
    const cancel = await handlers.handle(
      new Request(`${HOST}/api/t/closedco/calls/v1/manage/${A.rows["manage-token"]}/cancel`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: "{}" }),
    );
    expect(cancel.status).toBe(200);
    expect(asked).toContain("existing");
  });

  it("suspended: the existing links close too", async () => {
    const A = await plant("suspendedco");
    const shut: AdmitVerdict = { open: false, message: "Suspended Co isn't taking requests online right now." };
    const handlers = publicFor(A.tenantId, { admit: () => shut, admitExisting: () => shut });
    const manage = await handlers.handle(new Request(`${HOST}/api/t/s/calls/v1/manage/${A.rows["manage-token"]}`));
    expect([manage.status, (await manage.json()).error.code]).toEqual([403, "closed"]);
  });
});

