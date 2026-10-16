import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createResource,
  createSchedulingAdminHandlers,
  createSchedulingHandlers,
  getBooking,
  setAvailability,
  updateSchedulingSettings,
  type CreateSchedulingAdminHandlersOptions,
  type CreateSchedulingHandlersOptions,
  type SchedulingPermission,
} from "../index.js";
import { encodeSlotId } from "../public.js";
import { apiRequest, eventRecorder, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Both handler factories, request in and response out: every route, the
 * error codes and their statuses, the CSRF matrix, CORS, the rate-limit
 * buckets, the token-route headers, the honeypot and fill time, a table test
 * that every staff route asks `authorize` for exactly the contract's
 * permission, and the sweep throttle.
 *
 * NOW is Monday 2026-03-02 09:00 UTC (a tenant that never saved settings is
 * on UTC), so Wednesday's starts are well inside the notice.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const manageUrl = (token: string) => `https://acme.test/visit/${token}`;

async function publicApi(overrides: Partial<CreateSchedulingHandlersOptions> = {}) {
  const tenantId = tenant();
  const crew = await createResource(t.db, { tenantId, name: "Crew" });
  let clock = NOW;
  const { handle } = createSchedulingHandlers({ db: t.db, tenantId, manageUrl, now: () => clock, ...overrides });
  return {
    tenantId,
    crew,
    handle,
    setNow(next: Date) {
      clock = next;
    },
  };
}

const form = (slotId: string, extra: Record<string, unknown> = {}) => ({
  slotId,
  service: "visit",
  name: "Pat Visitor",
  email: "pat@example.com",
  fillMs: 5000,
  ...extra,
});

async function firstSlot(handle: (req: Request) => Promise<Response>, query = `service=visit&from=${WED}&days=1`) {
  const body = await readJson(await handle(apiRequest("GET", `/v1/slots?${query}`)));
  return body.slots[0] as { slotId: string; startTime: string };
}

describe("public: config and slots", () => {
  it("config is the business's public settings, no-store", async () => {
    const { tenantId, handle } = await publicApi({ emailsEnabled: false, minFillMs: 1500 });
    await updateSchedulingSettings(t.db, tenantId, {
      businessName: "Acme Windows",
      timeZone: "America/Denver",
      contactPhone: "(801) 555-0143",
      services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60, description: "We measure and quote.", requiredSkill: "glass" }],
    });
    const response = await handle(apiRequest("GET", "/v1/config"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(await readJson(response)).toEqual({
      businessName: "Acme Windows",
      timeZone: "America/Denver",
      publicBookingEnabled: true,
      autoConfirm: false,
      services: [{ key: "estimate", name: "Free estimate", description: "We measure and quote.", durationMinutes: 60 }],
      minNoticeMinutes: 1440,
      horizonDays: 30,
      requireAddress: false,
      cancelCutoffHours: 24,
      contactEmail: null,
      contactPhone: "(801) 555-0143",
      emailsEnabled: false,
      minFillMs: 1500,
    });
  });

  it("slots: the window and the slots; from defaults to today; bad queries are 400", async () => {
    const { handle } = await publicApi();
    const ok = await readJson(await handle(apiRequest("GET", `/v1/slots?service=visit`)));
    expect(ok).toMatchObject({ timeZone: "UTC", service: "visit", from: "2026-03-03", to: "2026-03-16", closed: false });
    expect(ok.slots[0]).toMatchObject({ date: "2026-03-03", startTime: "09:00", startsAt: "2026-03-03T09:00:00.000Z" });
    expect(Object.keys(ok.slots[0]).sort()).toEqual(["date", "endTime", "endsAt", "slotId", "startTime", "startsAt"]);

    const status = async (query: string) => {
      const response = await handle(apiRequest("GET", `/v1/slots?${query}`));
      return [response.status, (await readJson(response)).error?.code];
    };
    expect(await status("")).toEqual([400, "invalid"]); // no service, no manage
    expect(await status("service=gutters")).toEqual([400, "unknown_service"]);
    expect(await status("service=visit&from=2026-02-30")).toEqual([400, "invalid"]);
    expect(await status("service=visit&days=0")).toEqual([400, "invalid"]);
    expect(await status("service=visit&days=32")).toEqual([400, "invalid"]);
    expect(await status("service=visit&days=abc")).toEqual([400, "invalid"]);
    expect(await status("service=visit&days=31")).toEqual([200, undefined]);
  });

  it("closed for online booking: 200, closed, no slots", async () => {
    const { tenantId, handle } = await publicApi();
    await updateSchedulingSettings(t.db, tenantId, { publicBookingEnabled: false });
    const body = await readJson(await handle(apiRequest("GET", `/v1/slots?service=visit&from=${WED}&days=2`)));
    expect(body).toEqual({ timeZone: "UTC", service: "visit", from: WED, to: "2026-03-05", closed: true, slots: [] });
    const request = await handle(apiRequest("POST", "/v1/request", form(encodeSlotId({ date: WED, startTime: "10:00" }))));
    expect([request.status, (await readJson(request)).error.code]).toEqual([403, "booking_closed"]);
  });
});

describe("public: the request", () => {
  it("201 with the visit, a manage token and its link; a repeat is 200 with repeated: true", async () => {
    const recorder = eventRecorder();
    const { tenantId, handle } = await publicApi({ onEvent: recorder.onEvent });
    const slot = await firstSlot(handle);
    const response = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { phone: "801 555 0100", address: "1 Main St" }), { "x-forwarded-for": "198.51.100.66, 203.0.113.7" }));
    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body).toMatchObject({
      visit: { status: "requested", date: WED, startTime: slot.startTime, customerName: "Pat Visitor", address: "1 Main St", canCancel: true },
      manageToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      repeated: false,
    });
    expect(body.manageUrl).toBe(`https://acme.test/visit/${body.manageToken}`);
    expect(recorder.types()).toEqual(["visit.requested"]);
    // The requester key is the address the nearest proxy saw — the LAST
    // X-Forwarded-For entry — not the first, which the client wrote (RL-02).
    const row = await getBooking(t.db, tenantId, recorder.events[0]!.visitId);
    expect(row).toMatchObject({ requesterKey: "ip:203.0.113.7", customerPhone: "801 555 0100", origin: "public" });

    const again = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { phone: "801 555 0100", address: "1 Main St" }), { "x-forwarded-for": "203.0.113.7" }));
    expect(again.status).toBe(200);
    const repeat = await readJson(again);
    expect(repeat).toMatchObject({ repeated: true, visit: { startTime: slot.startTime }, manageToken: null, manageUrl: null });
    expect(recorder.types()).toEqual(["visit.requested"]);
  });

  it("the honeypot and a too-quick form are spam_suspected, before any database work", async () => {
    const { tenantId, handle } = await publicApi();
    const slotId = encodeSlotId({ date: WED, startTime: "10:00" });
    for (const body of [
      form(slotId, { website: "http://spam.example" }),
      form(slotId, { fillMs: 100 }),
      { ...form(slotId), fillMs: undefined },
    ]) {
      t.queries.length = 0;
      const response = await handle(apiRequest("POST", "/v1/request", body));
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        error: {
          code: "spam_suspected",
          message: "That was quicker than a person can fill in the form. Please check your details and send it again.",
        },
      });
      expect(t.queries.filter((q) => /scheduling_bookings|scheduling_visit_tokens/.test(q.sql))).toEqual([]);
    }
    expect(await t.client.query(`select 1 from scheduling_bookings where tenant_id = $1`, [tenantId]).then((r) => r.rows)).toEqual([]);
    // An empty honeypot is fine; minFillMs 0 turns the time check off.
    const relaxed = await publicApi({ minFillMs: 0 });
    const ok = await relaxed.handle(apiRequest("POST", "/v1/request", { ...form((await firstSlot(relaxed.handle)).slotId), fillMs: undefined, website: "" }));
    expect(ok.status).toBe(201);
  });

  it("a malformed form is 400 invalid with wire-named issues and no echo of the input", async () => {
    const { handle } = await publicApi();
    const response = await handle(apiRequest("POST", "/v1/request", form(encodeSlotId({ date: WED, startTime: "10:00" }), { email: "not-an-email<script>", name: "" })));
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.code).toBe("invalid");
    expect(body.error.issues.map((i: { path: unknown[] }) => i.path)).toEqual(expect.arrayContaining([["email"], ["name"]]));
    expect(JSON.stringify(body)).not.toContain("<script>");
    for (const bad of ["{not json", "[1,2]", "x".repeat(20_001)]) {
      const r = await handle(apiRequest("POST", "/v1/request", bad));
      expect([r.status, (await readJson(r)).error.code]).toEqual([400, "invalid"]);
    }
  });

  it("refusal codes and statuses: slot_unavailable 409, too_soon 400, too_far 400, address_unresolved 400, too_many_requests 429", async () => {
    const { tenantId, handle } = await publicApi();
    const status = async (body: Record<string, unknown>, ip = "203.0.113.9") => {
      const r = await handle(apiRequest("POST", "/v1/request", body, { "x-forwarded-for": ip }));
      return [r.status, (await readJson(r)).error?.code];
    };
    expect(await status(form(encodeSlotId({ date: WED, startTime: "03:00" })))).toEqual([409, "slot_unavailable"]);
    expect(await status(form(encodeSlotId({ date: "2026-03-02", startTime: "15:00" })))).toEqual([400, "too_soon"]);
    expect(await status(form(encodeSlotId({ date: "2026-05-02", startTime: "10:00" })))).toEqual([400, "too_far"]);
    expect(await status(form(encodeSlotId({ date: WED, startTime: "10:00" }), { service: "gutters" }))).toEqual([400, "unknown_service"]);
    await updateSchedulingSettings(t.db, tenantId, { requireAddress: true, maxOpenRequestsPerRequester: 1 });
    expect(await status(form(encodeSlotId({ date: WED, startTime: "10:00" })))).toEqual([400, "address_unresolved"]);
    expect(await status(form(encodeSlotId({ date: WED, startTime: "10:00" }), { address: "1 Main St" }))).toEqual([201, undefined]);
    expect(await status(form(encodeSlotId({ date: WED, startTime: "13:00" }), { address: "1 Main St", email: "x@example.com" }))).toEqual([429, "too_many_requests"]);
  });
});

describe("public: the customer's own visit", () => {
  async function requested() {
    const api = await publicApi();
    await updateSchedulingSettings(t.db, api.tenantId, { businessName: "Acme, Windows", contactPhone: "(801) 555-0143" });
    const slot = await firstSlot(api.handle);
    const body = await readJson(await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId, { address: "1 Main St; Unit 2" }))));
    return { ...api, token: body.manageToken as string };
  }

  it("GET, reschedule and cancel answer with the visit and private headers; unknown tokens are one 404", async () => {
    const { handle, token } = await requested();
    const view = await handle(apiRequest("GET", `/v1/visit/${token}`));
    expect(view.status).toBe(200);
    expect(view.headers.get("referrer-policy")).toBe("no-referrer");
    expect(view.headers.get("x-robots-tag")).toBe("noindex");
    expect(view.headers.get("cache-control")).toBe("no-store");
    expect((await readJson(view)).visit).toMatchObject({ status: "requested", businessName: "Acme, Windows" });

    const slots = await handle(apiRequest("GET", `/v1/slots?manage=${token}&from=2026-03-05&days=1`));
    expect(slots.headers.get("referrer-policy")).toBe("no-referrer");
    const own = (await readJson(slots)).slots[0];
    const moved = await handle(apiRequest("POST", `/v1/visit/${token}/reschedule`, { slotId: own.slotId }));
    expect([moved.status, (await readJson(moved)).visit.date]).toEqual([200, "2026-03-05"]);
    expect(moved.headers.get("x-robots-tag")).toBe("noindex");

    const misses = await Promise.all(
      ["A".repeat(43), "short", "%E0%A4%A"].map(async (bad) => {
        const r = await handle(apiRequest("GET", `/v1/visit/${bad}`));
        return [r.status, await r.text()];
      }),
    );
    expect(new Set(misses.map((m) => JSON.stringify(m))).size).toBe(1);
    expect(misses[0]?.[0]).toBe(404);

    const cancelled = await handle(apiRequest("POST", `/v1/visit/${token}/cancel`, { reason: "Changed plans" }));
    expect([cancelled.status, (await readJson(cancelled)).visit.status]).toEqual([200, "cancelled"]);
  });

  it("too_late is 409 with the business's phone", async () => {
    const { handle, token, setNow } = await requested();
    setNow(new Date("2026-03-03T09:30:00Z")); // inside 24 hours of Wednesday 08:00
    const r = await handle(apiRequest("POST", `/v1/visit/${token}/cancel`, {}));
    expect(r.status).toBe(409);
    expect(await readJson(r)).toEqual({
      error: {
        code: "too_late",
        message: "This visit starts within 24 hours, so it can't be changed online. Call us at (801) 555-0143.",
      },
    });
    setNow(new Date("2026-03-04T09:00:00Z")); // after it started — still a request nobody answered
    const after = await handle(apiRequest("POST", `/v1/visit/${token}/reschedule`, { slotId: "x" }));
    expect((await readJson(after)).error).toEqual({
      code: "too_late",
      message: "This request wasn't confirmed in time, so it can't be changed online. Please book a new time. Call us at (801) 555-0143.",
    });
  });

  it("the .ics: an attachment, CRLF, folded, stable UID, SEQUENCE, TENTATIVE then CANCEL", async () => {
    const { handle, token } = await requested();
    const response = await handle(apiRequest("GET", `/v1/visit/${token}/ics`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8; method=PUBLISH");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="visit.ics"');
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const ics = await response.text();
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(ics).toMatch(/\r\nMETHOD:PUBLISH\r\n/);
    expect(ics).toMatch(/\r\nUID:[0-9a-f-]+@scheduling\.adminigloo\r\n/);
    expect(ics).toContain("\r\nSEQUENCE:0\r\n");
    expect(ics).toContain("\r\nSTATUS:TENTATIVE\r\n");
    expect(ics).toContain("\r\nSUMMARY:Visit — Acme\\, Windows\r\n");
    expect(ics).toContain("\r\nLOCATION:1 Main St\\; Unit 2\r\n");
    expect(ics.replace(/\r\n /g, "")).toContain(`DESCRIPTION:Reschedule or cancel: https://acme.test/visit/${token}`);
    const uid = /UID:(.+)\r\n/.exec(ics)?.[1];

    await handle(apiRequest("POST", `/v1/visit/${token}/cancel`, {}));
    const cancelled = await (await handle(apiRequest("GET", `/v1/visit/${token}/ics`))).text();
    expect(cancelled).toContain("\r\nMETHOD:CANCEL\r\n");
    expect(cancelled).toContain("\r\nSTATUS:CANCELLED\r\n");
    expect(cancelled).toContain("\r\nSEQUENCE:1\r\n");
    expect(/UID:(.+)\r\n/.exec(cancelled)?.[1]).toBe(uid);
  });
});

describe("public: the HTTP rules", () => {
  it("each route asks the rate limiter with the right bucket, and false is 429", async () => {
    const buckets: string[] = [];
    let allow = true;
    const api = await publicApi({ rateLimit: (_req, bucket) => (buckets.push(bucket), allow) });
    const slot = await firstSlot(api.handle);
    const { manageToken } = await readJson(await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId))));
    buckets.length = 0;
    await api.handle(apiRequest("GET", "/v1/config"));
    await api.handle(apiRequest("GET", `/v1/slots?service=visit`));
    await api.handle(apiRequest("GET", `/v1/visit/${manageToken}`));
    await api.handle(apiRequest("GET", `/v1/visit/${manageToken}/ics`));
    await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId)));
    await api.handle(apiRequest("POST", `/v1/visit/${manageToken}/reschedule`, { slotId: slot.slotId }));
    await api.handle(apiRequest("POST", `/v1/visit/${manageToken}/cancel`, {}));
    expect(buckets).toEqual(["read", "read", "read", "read", "request", "manage", "manage"]);
    allow = false;
    const limited = await api.handle(apiRequest("GET", "/v1/config"));
    expect([limited.status, (await readJson(limited)).error.code]).toEqual([429, "rate_limited"]);
  });

  it("the CSRF matrix: cross-site and same-site browser POSTs are refused before any work; servers and same-origin pass", async () => {
    let resolved = 0;
    const api = await publicApi();
    const { handle } = createSchedulingHandlers({
      db: t.db,
      resolveTenant: () => (resolved += 1, api.tenantId),
      manageUrl,
      now: () => NOW,
      minFillMs: 0,
    });
    const post = (headers: Record<string, string>) =>
      handle(new Request("https://acme.test/api/schedule/v1/visit/" + "A".repeat(43) + "/cancel", { method: "POST", headers, body: "{}" }));
    const cases: Array<[Record<string, string>, number]> = [
      [{ "sec-fetch-site": "cross-site" }, 403],
      [{ "sec-fetch-site": "same-origin" }, 404],
      [{ "sec-fetch-site": "same-site" }, 403], // a sibling subdomain (review SEC-04)
      [{ "sec-fetch-site": "none" }, 404],
      [{ origin: "https://evil.test" }, 403],
      [{ origin: "null" }, 403],
      [{ origin: "https://acme.test" }, 404],
      [{ referer: "https://evil.test/page" }, 403],
      [{ referer: "https://acme.test/book" }, 404],
      [{ origin: "https://www.acme.test", "x-forwarded-host": "www.acme.test" }, 404],
      [{ "sec-fetch-mode": "cors" }, 403],
      [{}, 404], // a server or curl
    ];
    for (const [headers, expected] of cases) {
      const before = resolved;
      const response = await post(headers);
      expect([JSON.stringify(headers), response.status]).toEqual([JSON.stringify(headers), expected]);
      if (expected === 403) {
        expect((await readJson(response)).error.code).toBe("forbidden");
        expect(resolved).toBe(before); // refused before the tenant was even looked up
      }
    }
  });

  it("CORS: off by default; with an origin, preflight headers and that origin's POSTs pass", async () => {
    const plain = await publicApi();
    const preflight = await plain.handle(apiRequest("OPTIONS", "/v1/request"));
    expect([preflight.status, preflight.headers.get("access-control-allow-origin")]).toEqual([204, null]);

    const embed = await publicApi({ cors: "https://partner.test" });
    const options = await embed.handle(apiRequest("OPTIONS", "/v1/request"));
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("https://partner.test");
    expect(options.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(options.headers.get("vary")).toBe("Origin");
    const slot = await firstSlot(embed.handle);
    const fromPartner = await embed.handle(
      apiRequest("POST", "/v1/request", form(slot.slotId), { "sec-fetch-site": "cross-site", origin: "https://partner.test" }),
    );
    expect(fromPartner.status).toBe(201);
    expect(fromPartner.headers.get("access-control-allow-origin")).toBe("https://partner.test");
    const fromElsewhere = await embed.handle(
      apiRequest("POST", "/v1/request", form(slot.slotId), { "sec-fetch-site": "cross-site", origin: "https://evil.test" }),
    );
    expect(fromElsewhere.status).toBe(403);

    const open = await publicApi({ cors: "*" });
    const anywhere = await open.handle(
      apiRequest("POST", "/v1/request", form((await firstSlot(open.handle)).slotId), { "sec-fetch-site": "cross-site", origin: "https://x.test" }),
    );
    expect(anywhere.status).toBe(201);
  });

  it("unknown routes and tenants are 404; an unexpected error is a fixed 500", async () => {
    const api = await publicApi();
    for (const req of [apiRequest("GET", "/v1/nope"), apiRequest("POST", "/v1/config", {}), apiRequest("GET", "/v1/request")]) {
      const r = await api.handle(req);
      expect([r.status, (await readJson(r)).error.code]).toEqual([404, "not_found"]);
    }
    const nobody = createSchedulingHandlers({ db: t.db, resolveTenant: () => null, manageUrl });
    expect((await nobody.handle(apiRequest("GET", "/v1/config"))).status).toBe(404);

    const broken = createSchedulingHandlers({
      db: { select() { throw new Error("connection to db.internal:5432 failed, password=hunter2"); } } as never,
      tenantId: "x",
      manageUrl,
    });
    const r = await broken.handle(apiRequest("GET", "/v1/config"));
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
    expect(text).not.toContain("hunter2");
  });

  it("the request route sweeps expired requests at most once a minute per tenant", async () => {
    const api = await publicApi({ minFillMs: 0 });
    const sweeps = () => t.queries.filter((q) => q.sql.startsWith('with "due"')).length;
    t.queries.length = 0;
    const slot = await firstSlot(api.handle);
    await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId, { email: "a@example.com" })));
    await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId, { email: "b@example.com" })));
    expect(sweeps()).toBe(1);
    api.setNow(new Date(NOW.getTime() + 61_000));
    await api.handle(apiRequest("POST", "/v1/request", form(slot.slotId, { email: "c@example.com" })));
    expect(sweeps()).toBe(2);
    const off = await publicApi({ minFillMs: 0, sweepExpired: false });
    t.queries.length = 0;
    await off.handle(apiRequest("POST", "/v1/request", form((await firstSlot(off.handle)).slotId)));
    expect(sweeps()).toBe(0);
  });
});

// --- Staff ----------------------------------------------------------------------------

const ADMIN = "https://acme.test/api/admin/schedule/v1/admin";

function adminRequest(method: "GET" | "POST" | "OPTIONS", path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ADMIN}${path}`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function adminApi(overrides: Partial<CreateSchedulingAdminHandlersOptions> = {}) {
  const tenantId = tenant();
  const crew = await createResource(t.db, { tenantId, name: "Crew A", userId: "user-a" });
  const asked: SchedulingPermission[] = [];
  const recorder = eventRecorder();
  const { handle } = createSchedulingAdminHandlers({
    db: t.db,
    tenantId,
    authorize: (_req, permission) => {
      asked.push(permission);
      return { userId: "user-a" };
    },
    onEvent: recorder.onEvent,
    now: () => NOW,
    ...overrides,
  });
  return { tenantId, crew, handle, asked, recorder };
}

describe("staff: permissions", () => {
  it("every route asks authorize for exactly the contract's permission", async () => {
    const { handle, asked, crew } = await adminApi();
    const visit = await readJson(
      await handle(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "08:00" })),
    );
    const id = visit.visit.id as string;
    const timeOff = await readJson(await handle(adminRequest("POST", `/resources/${crew.id}/time-off`, { from: "2026-03-20", to: "2026-03-20" })));
    const exceptionId = timeOff.timeOff[0].id as string;
    const table: Array<[Request, SchedulingPermission | SchedulingPermission[]]> = [
      [adminRequest("GET", `/calendar?from=${WED}&to=${WED}`), "schedule.view"],
      // The caller's own crew: schedule.route, then schedule.view — the second
      // answer only decides whether the caller may page to another day (a crew
      // member opens today's route only, review SEC-2A-05) or open another
      // crew's route (see review-staff.test.ts).
      [adminRequest("GET", `/crew-day?date=${WED}&resource=${crew.id}`), ["schedule.route", "schedule.view"]],
      [adminRequest("GET", "/status"), "schedule.view"],
      [adminRequest("GET", "/people"), "schedule.resources.manage"],
      [adminRequest("POST", `/visits/${id}/progress`, { status: "in_progress" }), "schedule.route"],
      [adminRequest("GET", "/suggest?minutes=60"), "schedule.view"],
      [adminRequest("POST", "/visits", { resourceId: null, date: WED, startTime: "10:00" }), "schedule.manage"],
      [adminRequest("GET", `/visits/${id}`), "schedule.view"],
      [adminRequest("POST", `/visits/${id}/accept`, {}), "schedule.manage"],
      [adminRequest("POST", `/visits/${id}/decline`, {}), "schedule.manage"],
      [adminRequest("POST", `/visits/${id}/status`, { status: "confirmed" }), "schedule.manage"],
      [adminRequest("POST", `/visits/${id}/reschedule`, { date: WED, startTime: "08:00" }), "schedule.manage"],
      [adminRequest("POST", `/visits/${id}/assign`, { resourceId: crew.id }), "schedule.manage"],
      [adminRequest("POST", `/visits/${id}/details`, { notes: "x" }), "schedule.manage"],
      [adminRequest("POST", "/expire"), "schedule.manage"],
      [adminRequest("GET", "/settings"), "schedule.view"],
      [adminRequest("POST", "/settings", { businessName: "Acme" }), "schedule.resources.manage"],
      [adminRequest("GET", "/resources"), "schedule.view"],
      [adminRequest("POST", "/resources", { name: "Crew B" }), "schedule.resources.manage"],
      [adminRequest("POST", `/resources/${crew.id}`, { maxJobsPerDay: 5 }), "schedule.resources.manage"],
      [adminRequest("POST", `/resources/${crew.id}/deactivate`), "schedule.resources.manage"],
      [adminRequest("POST", `/resources/${crew.id}/reactivate`), "schedule.resources.manage"],
      [adminRequest("GET", `/resources/${crew.id}/availability`), "schedule.view"],
      [adminRequest("POST", `/resources/${crew.id}/availability`, { weekly: [] }), "schedule.resources.manage"],
      [adminRequest("POST", `/resources/${crew.id}/time-off`, { from: "2026-03-21", to: "2026-03-21" }), "schedule.resources.manage"],
      [adminRequest("POST", `/resources/${crew.id}/time-off/${exceptionId}/remove`), "schedule.resources.manage"],
    ];
    for (const [req, permission] of table) {
      asked.length = 0;
      const label = `${req.method} ${new URL(req.url).pathname}`;
      const response = await handle(req);
      expect([label, asked]).toEqual([label, Array.isArray(permission) ? permission : [permission]]);
      expect([label, response.status < 500]).toEqual([label, true]);
    }
  });

  it("false is 403; a Response passes through; true has no user", async () => {
    const tenantId = tenant();
    const deny = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => false });
    const denied = await deny.handle(adminRequest("GET", "/settings"));
    expect([denied.status, await readJson(denied)]).toEqual([403, { error: { code: "forbidden", message: "You don't have permission to do that." } }]);

    const host401 = createSchedulingAdminHandlers({
      db: t.db,
      tenantId,
      authorize: () => new Response("sign in", { status: 401, headers: { "www-authenticate": "Bearer" } }),
    });
    const challenged = await host401.handle(adminRequest("GET", "/settings"));
    expect([challenged.status, await challenged.text(), challenged.headers.get("www-authenticate")]).toEqual([401, "sign in", "Bearer"]);

    const recorder = eventRecorder();
    const anon = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => true, onEvent: recorder.onEvent, now: () => NOW });
    await anon.handle(adminRequest("POST", "/visits", { resourceId: null, date: WED, startTime: "10:00" }));
    expect(recorder.events[0]?.actor).toEqual({ type: "staff", id: null });
  });

  it("OPTIONS never carries CORS headers; a cross-site POST is refused before authorize", async () => {
    let calls = 0;
    const { handle } = createSchedulingAdminHandlers({ db: t.db, tenantId: tenant(), authorize: () => (calls += 1, true) });
    const preflight = await handle(adminRequest("OPTIONS", "/visits", undefined, { origin: "https://evil.test" }));
    expect(preflight.status).toBe(204);
    expect([...preflight.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual([]);
    const forged = await handle(adminRequest("POST", "/expire", undefined, { "sec-fetch-site": "cross-site" }));
    expect([forged.status, calls]).toEqual([403, 0]);
    expect((await handle(adminRequest("GET", "/nope"))).status).toBe(404);
  });
});

describe("staff: routes", () => {
  it("visits: create (201, the service's length), read, accept, decline, status and the error statuses", async () => {
    const { tenantId, handle, crew, recorder } = await adminApi();
    await updateSchedulingSettings(t.db, tenantId, { services: [{ key: "clean", name: "Window clean", durationMinutes: 120 }] });
    const created = await handle(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "09:00", service: "clean", status: "pending", customerName: "Dana" }));
    expect(created.status).toBe(201);
    const { visit, warnings } = await readJson(created);
    expect(visit).toMatchObject({ endTime: "11:00", serviceKey: "clean", serviceName: "Window clean", status: "pending", resourceName: "Crew A" });
    expect(warnings).toEqual([]);
    expect(recorder.events[0]).toMatchObject({ type: "visit.requested", actor: { type: "staff", id: "user-a" }, data: { via: "staff" } });

    expect((await readJson(await handle(adminRequest("GET", `/visits/${visit.id}`)))).visit.id).toBe(visit.id);
    const accepted = await readJson(await handle(adminRequest("POST", `/visits/${visit.id}/accept`, { notify: false })));
    expect(accepted.visit).toMatchObject({ status: "confirmed", pendingExpiresAt: null });
    expect(recorder.events.at(-1)).toMatchObject({ type: "visit.confirmed", data: { via: "accept", notify: false } });

    const statusOf = async (req: Request) => {
      const r = await handle(req);
      return [r.status, (await readJson(r)).error?.code];
    };
    expect(await statusOf(adminRequest("POST", `/visits/${visit.id}/status`, { status: "pending" }))).toEqual([409, "transition_not_allowed"]);
    expect(await statusOf(adminRequest("POST", `/visits/${visit.id}/status`, { status: "expired" }))).toEqual([400, "invalid"]);
    expect(await statusOf(adminRequest("POST", `/visits/${visit.id}/reschedule`, { date: WED, startTime: "03:00" }))).toEqual([400, "outside_hours"]);
    expect(await statusOf(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "10:00" }))).toEqual([409, "slot_unavailable"]);
    expect(await statusOf(adminRequest("POST", "/visits", { resourceId: crew.id, date: "2026-02-30", startTime: "10:00" }))).toEqual([400, "invalid"]);
    expect(await statusOf(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "10:00", service: "gutters" }))).toEqual([400, "unknown_service"]);
    expect(await statusOf(adminRequest("GET", "/visits/no-such-visit"))).toEqual([404, "not_found"]);
    expect(await statusOf(adminRequest("POST", "/visits/no-such-visit/accept", {}))).toEqual([404, "not_found"]);
    await handle(adminRequest("POST", `/visits/${visit.id}/status`, { status: "completed" }));
    expect(await statusOf(adminRequest("POST", `/visits/${visit.id}/assign`, { resourceId: crew.id }))).toEqual([409, "not_changeable"]);

    const declinable = await readJson(await handle(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "13:00", status: "pending" })));
    const declined = await readJson(await handle(adminRequest("POST", `/visits/${declinable.visit.id}/decline`, { reason: "Too far" })));
    expect(declined.visit).toMatchObject({ status: "declined", cancelReason: "Too far", cancelledBy: "staff" });
  });

  it("crew-day resolves the signed-in person's crew, or asks to pick one", async () => {
    const { handle, crew } = await adminApi();
    const mine = await handle(adminRequest("GET", `/crew-day?date=${WED}`));
    expect([mine.status, (await readJson(mine)).resource.id]).toEqual([200, crew.id]);

    const someoneElse = createSchedulingAdminHandlers({ db: t.db, tenantId: crew.tenantId, authorize: () => ({ userId: "office" }) });
    const pick = await someoneElse.handle(adminRequest("GET", `/crew-day?date=${WED}`));
    expect([pick.status, (await readJson(pick)).error]).toEqual([400, { code: "invalid", message: "Pick a crew.", issues: [{ path: ["resource"], message: "Pick a crew." }] }]);

    const custom = createSchedulingAdminHandlers({
      db: t.db,
      tenantId: crew.tenantId,
      authorize: () => ({ userId: "office" }),
      currentResourceId: () => crew.id,
    });
    expect((await readJson(await custom.handle(adminRequest("GET", "/crew-day")))).resource.name).toBe("Crew A");
  });

  it("settings, resources, availability and time off round-trip", async () => {
    const { handle, crew } = await adminApi();
    const saved = await readJson(await handle(adminRequest("POST", "/settings", { businessName: "Acme", timeZone: "America/Denver" })));
    expect(saved.settings).toMatchObject({ businessName: "Acme", timeZone: "America/Denver", saved: true });
    const bad = await handle(adminRequest("POST", "/settings", { timeZone: "Mountain" }));
    expect([bad.status, (await readJson(bad)).error.issues]).toEqual([400, [{ path: ["timeZone"], message: "Pick a time zone from the list.", code: "custom" }]]);

    const created = await handle(adminRequest("POST", "/resources", { name: "Crew B", skills: ["glass"], tenantId: "elsewhere" }));
    expect(created.status).toBe(201);
    const crewB = (await readJson(created)).resource;
    expect(crewB).toMatchObject({ name: "Crew B", skills: ["glass"], isActive: true, hoursConfigured: false });
    await handle(adminRequest("POST", `/resources/${crewB.id}/deactivate`));
    expect((await readJson(await handle(adminRequest("GET", "/resources")))).resources.map((r: { name: string }) => r.name)).toEqual(["Crew A"]);
    expect((await readJson(await handle(adminRequest("GET", "/resources?include=inactive")))).resources).toHaveLength(2);

    const weekly = await readJson(
      await handle(
        adminRequest("POST", `/resources/${crew.id}/availability`, {
          weekly: [
            { dayOfWeek: 3, startTime: "08:00", endTime: "12:00" },
            { dayOfWeek: 3, startTime: "13:00", endTime: "17:00" },
          ],
        }),
      ),
    );
    expect(weekly).toMatchObject({ hoursConfigured: true, weekly: [{ dayOfWeek: 3 }, { dayOfWeek: 3 }] });
    await handle(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "09:00" }));
    const off = await readJson(await handle(adminRequest("POST", `/resources/${crew.id}/time-off`, { from: WED, to: "2026-03-05", note: "Sick" })));
    expect(off.timeOff.map((d: { date: string }) => d.date)).toEqual([WED, "2026-03-05"]);
    expect(off.visitsOnThoseDays).toHaveLength(1);
    expect(off.visitsOnThoseDays[0]).toMatchObject({ startTime: "09:00", resourceName: "Crew A" });
    const removed = await readJson(await handle(adminRequest("POST", `/resources/${crew.id}/time-off/${off.timeOff[0].id}/remove`)));
    expect(removed.timeOff).toHaveLength(1);
    expect((await handle(adminRequest("POST", `/resources/${crew.id}/time-off/${off.timeOff[0].id}/remove`))).status).toBe(404);
    expect((await handle(adminRequest("GET", "/resources/nope/availability"))).status).toBe(404);
  });

  it("suggest: staff-only slots with the crew, drive and the previous address; best first, at most 20", async () => {
    const { handle, crew } = await adminApi();
    await setAvailability(t.db, { tenantId: crew.tenantId, resourceId: crew.id, blocks: [{ dayOfWeek: 3, startTime: "08:00", endTime: "17:00" }] });
    await handle(adminRequest("POST", "/visits", { resourceId: crew.id, date: WED, startTime: "08:00", address: "12 Elm St", lat: 40.7, lng: -111.9 }));
    const body = await readJson(await handle(adminRequest("GET", `/suggest?minutes=60&lat=40.71&lng=-111.9&from=${WED}&days=1`)));
    expect(body).toMatchObject({ timeZone: "UTC", estimated: true });
    expect(body.slots.length).toBeLessThanOrEqual(20);
    expect(body.slots[0]).toMatchObject({ resourceId: crew.id, resourceName: "Crew A", previousJobAddress: "12 Elm St", startsAt: expect.any(String) });
    const missing = await handle(adminRequest("GET", "/suggest"));
    expect([missing.status, (await readJson(missing)).error.code]).toEqual([400, "invalid"]);
  });

  it("the calendar sweeps at most once a minute; expire sweeps every time", async () => {
    const { handle } = await adminApi();
    const sweeps = () => t.queries.filter((q) => q.sql.startsWith('with "due"')).length;
    t.queries.length = 0;
    await handle(adminRequest("GET", "/calendar"));
    await handle(adminRequest("GET", "/calendar"));
    expect(sweeps()).toBe(1);
    await handle(adminRequest("POST", "/expire"));
    await handle(adminRequest("POST", "/expire"));
    expect(sweeps()).toBe(3);
    expect(await readJson(await handle(adminRequest("POST", "/expire")))).toEqual({ expired: 0 });
  });
});
