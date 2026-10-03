import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateLicenseKeypair, signLicense } from "@adminigloo/license";
import type { BusySource } from "../busy-source.js";
import { createBookingHandlers, isCrossSiteRequest, type CreateBookingHandlersOptions, type RateLimitBucket } from "../handlers.js";
import { bookingBookings } from "../schema.js";
import type { BookingEvent } from "../services/context.js";
import { rotateHostFeedToken, setWeeklyAvailability, upsertHost, upsertType } from "../services/admin.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const NOW = new Date("2026-10-05T15:00:00Z"); // Monday 09:00 MDT
const FIRST = "2026-10-05T19:00:00.000Z";
const TUE_10 = "2026-10-06T16:00:00.000Z";
const BASE = "https://site.test/api/booking";

async function seedTenant(options: { busyIcsUrl?: string } = {}) {
  const tenantId = tenant("wire");
  const ctx = { db: t.db, tenantId, now: NOW };
  const host = await upsertHost(ctx, {
    displayName: "Dallin",
    email: "dallin@adminigloo.com",
    timezone: "America/Denver",
    meetingLink: "https://meet.example.com/dallin",
    ...(options.busyIcsUrl ? { busyIcsUrl: options.busyIcsUrl } : {}),
  });
  await setWeeklyAvailability(ctx, {
    hostId: host.id,
    windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
  });
  await upsertType(ctx, { key: "intro", name: "Intro call", description: "Twenty minutes, no slides.", durationMinutes: 30, media: ["video", "phone"] });
  return { tenantId, host, ctx };
}

function handlers(tenantId: string, extra: Partial<CreateBookingHandlersOptions> = {}) {
  return createBookingHandlers({
    db: t.db,
    tenantId,
    now: () => NOW,
    uidDomain: "site.test",
    manageUrl: (token) => `https://site.test/book/manage/${token}`,
    ...extra,
  });
}

const get = (path: string) => new Request(`${BASE}${path}`, { method: "GET" });
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const bookBody = (overrides: Record<string, unknown> = {}) => ({
  type: "intro",
  start: FIRST,
  name: "Ada Lovelace",
  email: "ada@example.com",
  medium: "video",
  timezone: "Europe/London",
  ...overrides,
});

describe("the wire contract", () => {
  it("GET /v1/config", async () => {
    const { tenantId } = await seedTenant();
    const res = await handlers(tenantId).handle(get("/v1/config"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({
      sandbox: false,
      hostDisplayName: "Dallin",
      hostTimezone: "America/Denver",
      types: [
        {
          key: "intro",
          name: "Intro call",
          description: "Twenty minutes, no slides.",
          durationMinutes: 30,
          media: ["video", "phone"],
          minNoticeMinutes: 240,
          horizonDays: 21,
        },
      ],
      emailsEnabled: true,
      contactEmail: null,
    });
  });

  it("GET /v1/slots?type&from&to", async () => {
    const { tenantId } = await seedTenant();
    const res = await handlers(tenantId).handle(get(`/v1/slots?type=intro&from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z`));
    const body = (await res.json()) as { slots: Array<{ start: string; end: string }>; busySync: string };
    expect(res.status).toBe(200);
    expect(body.busySync).toBe("off");
    expect(body.slots[0]).toEqual({ start: FIRST, end: "2026-10-05T19:30:00.000Z" });
    expect(body.slots.every((slot) => slot.start < "2026-10-06T00:00:00.000Z")).toBe(true);
  });

  it("hold → book → manage → reschedule → ics → cancel, end to end", async () => {
    const events: BookingEvent[] = [];
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId, { onEvent: (event) => void events.push(event) });

    const holdRes = await handle(post("/v1/hold", { type: "intro", start: FIRST }));
    expect(holdRes.status).toBe(200);
    const hold = (await holdRes.json()) as { holdToken: string; expiresAt: string; start: string; end: string };
    expect(Object.keys(hold).sort()).toEqual(["end", "expiresAt", "holdToken", "start"]);

    const bookRes = await handle(post("/v1/book", bookBody({ holdToken: hold.holdToken, company: "Engines" })));
    expect(bookRes.status).toBe(200);
    const booked = (await bookRes.json()) as { booking: Record<string, unknown>; manageToken: string; manageUrl: string };
    expect(booked.manageUrl).toBe(`https://site.test/book/manage/${booked.manageToken}`);
    expect(Object.keys(booked.booking).sort()).toEqual(
      [
        "canCancel",
        "canReschedule",
        "durationMinutes",
        "end",
        "googleCalendarUrl",
        "hostDisplayName",
        "hostPhone",
        "hostTimezone",
        "inviteMailbox",
        "inviteeName",
        "inviteeTimezone",
        "medium",
        "meetingLink",
        "sandbox",
        "start",
        "status",
        "typeKey",
        "typeName",
      ].sort(),
    );
    expect(booked.booking.typeKey).toBe("intro");
    expect(JSON.stringify(booked)).not.toContain("dallin@adminigloo.com");

    const token = booked.manageToken;
    const manage = await handle(get(`/v1/manage/${token}`));
    expect(manage.status).toBe(200);
    expect(manage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(manage.headers.get("x-robots-tag")).toBe("noindex");
    expect(manage.headers.get("cache-control")).toBe("no-store");
    expect(((await manage.json()) as { booking: { start: string } }).booking.start).toBe(FIRST);

    const moved = await handle(post(`/v1/manage/${token}/reschedule`, { start: TUE_10 }));
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { booking: { start: string } }).booking.start).toBe(TUE_10);

    const ics = await handle(get(`/v1/manage/${token}/ics`));
    expect(ics.status).toBe(200);
    expect(ics.headers.get("content-type")).toBe("text/calendar; charset=utf-8; method=PUBLISH");
    expect(ics.headers.get("content-disposition")).toMatch(/^attachment; filename=/);
    expect(ics.headers.get("referrer-policy")).toBe("no-referrer");
    const icsText = await ics.text();
    expect(icsText).toContain("SEQUENCE:1");
    expect(icsText).toContain("DTSTART:20261006T160000Z");

    const cancelled = await handle(post(`/v1/manage/${token}/cancel`, { reason: "No longer needed" }));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { booking: { status: string } }).booking.status).toBe("cancelled");
    const cancelIcs = await handle(get(`/v1/manage/${token}/ics`));
    expect(cancelIcs.headers.get("content-type")).toContain("method=CANCEL");

    expect(events.map((event) => event.event)).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
  });

  it("POST /v1/hold/release answers ok, even for sendBeacon's text/plain body", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const hold = (await (await handle(post("/v1/hold", { type: "intro", start: FIRST }))).json()) as { holdToken: string };
    const beacon = new Request(`${BASE}/v1/hold/release`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ holdToken: hold.holdToken }),
    });
    const res = await handle(beacon);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Released: the same time can be held again.
    expect((await handle(post("/v1/hold", { type: "intro", start: FIRST }))).status).toBe(200);
  });

  it("reschedule-aware: slots?manage= and hold {manageToken} treat the invitee's own call as free", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const booked = (await (await handle(post("/v1/book", bookBody({ start: TUE_10 })))).json()) as { manageToken: string };
    const startsOf = async (res: Response) =>
      ((await res.json()) as { slots: Array<{ start: string }> }).slots.map((slot) => slot.start);

    const plain = await handle(get("/v1/slots?type=intro"));
    expect(plain.headers.get("referrer-policy")).toBeNull();
    expect(await startsOf(plain)).not.toContain(TUE_10);

    const moving = await handle(get(`/v1/slots?type=intro&manage=${booked.manageToken}`));
    expect(moving.status).toBe(200);
    // The token is in the URL here, so the response gets the private headers.
    expect(moving.headers.get("referrer-policy")).toBe("no-referrer");
    expect(moving.headers.get("x-robots-tag")).toBe("noindex");
    expect(await startsOf(moving)).toContain(TUE_10);

    // Without the token, the booked time cannot be held; with it, it can.
    expect((await handle(post("/v1/hold", { type: "intro", start: TUE_10 }))).status).toBe(409);
    const held = await handle(post("/v1/hold", { type: "intro", start: TUE_10, manageToken: booked.manageToken }));
    expect(held.status).toBe(200);
  });

  it("an unknown manage token: ignored by slots, not_found on hold", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const plain = await (await handle(get("/v1/slots?type=intro"))).json();
    const junk = await handle(get(`/v1/slots?type=intro&manage=${"a".repeat(43)}`));
    expect(junk.status).toBe(200);
    expect(await junk.json()).toEqual(plain);
    const garbled = await handle(get(`/v1/slots?type=intro&manage=${encodeURIComponent("../../etc")}`));
    expect(await garbled.json()).toEqual(plain);
    for (const manageToken of ["a".repeat(43), "", 42]) {
      const res = await handle(post("/v1/hold", { type: "intro", start: FIRST, manageToken }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
    // null reads as "not given": an ordinary hold.
    expect((await handle(post("/v1/hold", { type: "intro", start: FIRST, manageToken: null }))).status).toBe(200);
  });

  it("defaultCallingCode: advertised in the config and applied to the phone", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId, { defaultCallingCode: "+1" });
    expect(((await (await handle(get("/v1/config"))).json()) as { defaultCallingCode?: string }).defaultCallingCode).toBe("1");
    const res = await handle(post("/v1/book", bookBody({ medium: "phone", phone: "801-555-0143" })));
    expect(res.status).toBe(200);
    // Without the option the same body is refused, naming the field.
    const strict = await handlers(tenantId).handle(post("/v1/book", bookBody({ start: TUE_10, medium: "phone", phone: "801-555-0143" })));
    expect(strict.status).toBe(400);
    expect(((await strict.json()) as { error: { issues: Array<{ path: unknown[] }> } }).error.issues[0]?.path).toEqual(["phone"]);
  });

  it("defaultCallingCode: a typo throws at construction; blank means unset", () => {
    expect(() => handlers("t", { defaultCallingCode: "USA" })).toThrow(/calling code/);
    expect(() => handlers("t", { defaultCallingCode: "0044" })).toThrow(/calling code/);
    expect(() => handlers("t", { defaultCallingCode: "  " })).not.toThrow();
  });

  it("GET /v1/feed/:token.ics serves the host feed inline", async () => {
    const { tenantId, host, ctx } = await seedTenant();
    const { handle } = handlers(tenantId);
    await handle(post("/v1/book", bookBody()));
    const { feedToken } = await rotateHostFeedToken(ctx, host.id);
    const res = await handle(get(`/v1/feed/${feedToken}.ics`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const text = await res.text();
    expect(text).toContain("Intro call: Ada");
    expect(text).not.toContain("ada@example.com");
    expect((await handle(get(`/v1/feed/${"x".repeat(43)}.ics`))).status).toBe(404);
  });
});

describe("errors", () => {
  async function error(res: Response) {
    return { status: res.status, body: (await res.json()) as { error: { code: string; message: string; issues?: Array<{ path: unknown[] }> } } };
  }

  it("not_found: unknown route, unknown type, unknown token — one shape", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    for (const res of [
      await handle(get("/v1/nope")),
      await handle(get("/v1/slots?type=missing")),
      await handle(get(`/v1/manage/${"a".repeat(43)}`)),
      await handle(post(`/v1/manage/${"a".repeat(43)}/cancel`, {})),
      await handle(new Request(`${BASE}/v1/book`, { method: "GET" })),
    ]) {
      const { status, body } = await error(res);
      expect(status).toBe(404);
      expect(body.error.code).toBe("not_found");
    }
  });

  it("slot_taken 409 and hold_expired 409", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    await handle(post("/v1/book", bookBody()));
    const taken = await error(await handle(post("/v1/book", bookBody({ email: "b@example.com" }))));
    expect(taken).toMatchObject({ status: 409, body: { error: { code: "slot_taken" } } });
    const held = await error(await handle(post("/v1/hold", { type: "intro", start: FIRST })));
    expect(held.body.error.code).toBe("slot_taken");
    const stale = await error(
      await handle(post("/v1/book", bookBody({ email: "c@example.com", holdToken: "Z".repeat(43) }))),
    );
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "hold_expired" } } });
  });

  it("already_booked 409: the same form sent twice", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const hold = (await (await handle(post("/v1/hold", { type: "intro", start: FIRST }))).json()) as { holdToken: string };
    expect((await handle(post("/v1/book", bookBody({ holdToken: hold.holdToken })))).status).toBe(200);
    const twice = await error(await handle(post("/v1/book", bookBody({ holdToken: hold.holdToken }))));
    expect(twice).toMatchObject({ status: 409, body: { error: { code: "already_booked" } } });
    expect(twice.body.error.message).toMatch(/Check your email/);
  });

  it("invalid 400 with issues, named in the wire's terms", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const missingType = await error(await handle(post("/v1/book", bookBody({ type: undefined }))));
    expect(missingType.status).toBe(400);
    expect(missingType.body.error.code).toBe("invalid");
    expect(missingType.body.error.issues?.some((issue) => issue.path[0] === "type")).toBe(true);
    const phone = await error(await handle(post("/v1/book", bookBody({ medium: "phone" }))));
    expect(phone.body.error.issues?.[0]?.path).toEqual(["phone"]);
    const notJson = await error(
      await handle(new Request(`${BASE}/v1/book`, { method: "POST", body: "{not json" })),
    );
    expect(notJson).toMatchObject({ status: 400, body: { error: { code: "invalid" } } });
    const badFrom = await error(await handle(get("/v1/slots?type=intro&from=yesterday")));
    expect(badFrom.status).toBe(400);
  });

  it("rate_limited 429, per bucket", async () => {
    const { tenantId } = await seedTenant();
    const seen: RateLimitBucket[] = [];
    const { handle } = handlers(tenantId, {
      rateLimit: (_req, bucket) => {
        seen.push(bucket);
        return bucket !== "book";
      },
    });
    expect((await handle(get("/v1/config"))).status).toBe(200);
    expect((await handle(post("/v1/hold", { type: "intro", start: TUE_10 }))).status).toBe(200);
    const limited = await error(await handle(post("/v1/book", bookBody())));
    expect(limited).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
    await handle(get(`/v1/manage/${"a".repeat(43)}`));
    expect(seen).toEqual(["read", "hold", "book", "manage"]);
  });

  it("an unexpected failure is a JSON 500, not a stack trace", async () => {
    const broken = createBookingHandlers({
      db: { select: () => { throw new Error("connection reset"); } } as never,
      tenantId: "t",
      uidDomain: "x",
      manageUrl: (token) => token,
    });
    const res = await broken.handle(get("/v1/config"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  });
});

describe("tenancy, CORS and the license gate", () => {
  it("resolveTenant null → 404; a resolved tenant sees only its own data", async () => {
    const a = await seedTenant();
    const { handle } = createBookingHandlers({
      db: t.db,
      resolveTenant: (req) => req.headers.get("x-tenant"),
      now: () => NOW,
      uidDomain: "site.test",
      manageUrl: (token) => token,
    });
    expect((await handle(get("/v1/config"))).status).toBe(404);
    const ok = await handle(new Request(`${BASE}/v1/config`, { headers: { "x-tenant": a.tenantId } }));
    expect(((await ok.json()) as { hostDisplayName: string }).hostDisplayName).toBe("Dallin");
    const other = await handle(new Request(`${BASE}/v1/config`, { headers: { "x-tenant": "nobody-here" } }));
    expect(((await other.json()) as { types: unknown[] }).types).toEqual([]);
  });

  it("requires a tenant source at construction", () => {
    expect(() => createBookingHandlers({ db: t.db, uidDomain: "x", manageUrl: (token) => token })).toThrow(/tenantId or resolveTenant/);
  });

  it("CORS only when configured; OPTIONS answers the preflight", async () => {
    const { tenantId } = await seedTenant();
    const open = handlers(tenantId, { cors: "*" });
    const preflight = await open.handle(new Request(`${BASE}/v1/book`, { method: "OPTIONS" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    expect((await open.handle(get("/v1/config"))).headers.get("access-control-allow-origin")).toBe("*");
    const pinned = handlers(tenantId, { cors: "https://partner.example" });
    const res = await pinned.handle(get("/v1/config"));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://partner.example");
    expect(res.headers.get("vary")).toBe("Origin");
    const closed = await handlers(tenantId).handle(new Request(`${BASE}/v1/book`, { method: "OPTIONS" }));
    expect(closed.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("402 under enforce without a booking license — before touching the database", async () => {
    const keys = generateLicenseKeypair();
    const nullDb = {} as never;
    const gated = (license: CreateBookingHandlersOptions["license"]) =>
      createBookingHandlers({ db: nullDb, tenantId: "t", uidDomain: "x", manageUrl: (token) => token, ...(license ? { license } : {}) });
    const unlicensed = await gated({ mode: "enforce", publicKey: keys.publicKey }).handle(get("/v1/config"));
    expect(unlicensed.status).toBe(402);
    expect(((await unlicensed.json()) as { error: { code: string } }).error.code).toBe("unlicensed");
    const wrongFeature = signLicense({ v: 1, customer: "acme", features: ["feedback"], issuedAt: 1 }, keys.privateKey);
    expect((await gated({ mode: "enforce", publicKey: keys.publicKey, key: wrongFeature }).handle(get("/v1/config"))).status).toBe(402);
    // mode off: past the gate (and into the null db → 500, proving the gate let it through).
    expect((await gated({ mode: "off", publicKey: keys.publicKey }).handle(get("/v1/config"))).status).toBe(500);
    const good = signLicense(
      { v: 1, customer: "acme", features: ["booking"], issuedAt: Math.floor(Date.now() / 1000) - 60 },
      keys.privateKey,
    );
    expect((await gated({ mode: "enforce", publicKey: keys.publicKey, key: good }).handle(get("/v1/config"))).status).toBe(500);
  });
});

describe("sandbox", () => {
  it("never calls onEvent or the busy source, and says sandbox everywhere", async () => {
    const { tenantId } = await seedTenant({ busyIcsUrl: "https://calendar.google.com/calendar/ical/x/private-y/basic.ics" });
    let eventCalls = 0;
    let busyCalls = 0;
    const busySource: BusySource = {
      busy: async () => {
        busyCalls += 1;
        return [];
      },
    };
    const { handle } = handlers(tenantId, {
      sandbox: true,
      busySource,
      onEvent: () => {
        eventCalls += 1;
      },
    });
    const config = (await (await handle(get("/v1/config"))).json()) as { sandbox: boolean };
    expect(config.sandbox).toBe(true);
    const slots = (await (await handle(get("/v1/slots?type=intro"))).json()) as { busySync: string };
    expect(slots.busySync).toBe("off");
    const booked = (await (await handle(post("/v1/book", bookBody()))).json()) as {
      booking: { sandbox: boolean };
      manageToken: string;
    };
    expect(booked.booking.sandbox).toBe(true);
    await handle(post(`/v1/manage/${booked.manageToken}/reschedule`, { start: TUE_10 }));
    await handle(post(`/v1/manage/${booked.manageToken}/cancel`, {}));
    expect(eventCalls).toBe(0);
    expect(busyCalls).toBe(0);

    // The same tenant outside sandbox mode does read the calendar.
    await handlers(tenantId, { busySource }).handle(get("/v1/slots?type=intro"));
    expect(busyCalls).toBe(1);
  });

  it("calendar exports are labelled non-events, and the file name says so too", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId, { sandbox: true, realBookingUrl: "https://site.test/book" });
    const booked = (await (await handle(post("/v1/book", bookBody()))).json()) as {
      booking: { googleCalendarUrl: string };
      manageToken: string;
    };
    const google = new URL(booked.booking.googleCalendarUrl).searchParams;
    expect(google.get("text")).toBe("[Sandbox — not a real booking] Intro call with Dallin");
    expect(google.get("details")).toBe(
      "This was made in a live demo. Nothing was booked and nobody will join.\n\nBook a real call: https://site.test/book",
    );
    expect(google.get("location")).toBeNull();
    expect(google.get("details")).not.toContain(booked.manageToken);

    const ics = await handle(get(`/v1/manage/${booked.manageToken}/ics`));
    expect(ics.headers.get("content-disposition")).toBe('attachment; filename="sandbox-not-a-real-booking.ics"');
    const text = (await ics.text()).replace(/\r\n /g, "");
    expect(text).toContain("SUMMARY:[Sandbox — not a real booking] Intro call with Dallin");
    expect(text).toContain("STATUS:TENTATIVE");
    expect(text).toContain("TRANSP:TRANSPARENT");
    expect(text).not.toMatch(/ORGANIZER|ATTENDEE|LOCATION|URL:/);
    expect(text).not.toContain(booked.manageToken);

    // Negative control: the same tenant served for real exports a real event.
    const real = handlers(tenantId);
    const realBooked = (await (await real.handle(post("/v1/book", bookBody({ start: TUE_10 })))).json()) as {
      booking: { googleCalendarUrl: string };
      manageToken: string;
    };
    expect(new URL(realBooked.booking.googleCalendarUrl).searchParams.get("text")).toBe("Intro call with Dallin");
    const realIcs = await (await real.handle(get(`/v1/manage/${realBooked.manageToken}/ics`))).text();
    expect(realIcs).toContain("STATUS:CONFIRMED");
    expect(realIcs).toContain("ORGANIZER");
  });
});

describe("CSRF: a cross-site POST is refused before any work", () => {
  const send = (path: string, body: unknown, headers: Record<string, string>, base = BASE) =>
    new Request(`${base}${path}`, {
      method: "POST",
      // text/plain: the "simple request" a foreign page can send without a preflight.
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body: JSON.stringify(body),
    });
  const CROSS = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", origin: "https://evil.example" };
  const SAME = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", origin: "https://site.test" };
  const count = async (tenantId: string) => (await t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, tenantId))).length;

  it("a forged hold is 403 forbidden and writes nothing — the same request same-origin succeeds (control)", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const forged = await handle(send("/v1/hold", { type: "intro", start: FIRST }, CROSS));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: { code: "forbidden", message: "This request came from another site, so it was refused." } });
    expect(await count(tenantId)).toBe(0);

    const own = await handle(send("/v1/hold", { type: "intro", start: FIRST }, SAME));
    expect(own.status).toBe(200);
    expect(await count(tenantId)).toBe(1);
  });

  it("covers every state-changing route: book, release, cancel, reschedule", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const booked = (await (await handle(post("/v1/book", bookBody()))).json()) as { manageToken: string };
    const hold = (await (await handle(post("/v1/hold", { type: "intro", start: TUE_10 }))).json()) as { holdToken: string };
    for (const [path, body] of [
      ["/v1/book", bookBody({ start: "2026-10-07T16:00:00.000Z" })],
      ["/v1/hold/release", { holdToken: hold.holdToken }],
      [`/v1/manage/${booked.manageToken}/cancel`, {}],
      [`/v1/manage/${booked.manageToken}/reschedule`, { start: "2026-10-08T16:00:00.000Z" }],
    ] as const) {
      const res = await handle(send(path, body, CROSS));
      expect(res.status, path).toBe(403);
    }
    // Nothing moved: the booking still stands where it was, the hold is still held.
    const manage = (await (await handle(get(`/v1/manage/${booked.manageToken}`))).json()) as { booking: { status: string; start: string } };
    expect(manage.booking).toMatchObject({ status: "confirmed", start: FIRST });
    expect(await count(tenantId)).toBe(2);
    // …and the control: the same cancel from our own page works.
    expect((await handle(send(`/v1/manage/${booked.manageToken}/cancel`, {}, SAME))).status).toBe(200);
  });

  it("reads Sec-Fetch-Site first: same-site and none pass, cross-site fails whatever Origin claims", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const release = (headers: Record<string, string>) => handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, headers));
    expect((await release({ "sec-fetch-site": "same-site" })).status).toBe(200);
    expect((await release({ "sec-fetch-site": "none" })).status).toBe(200);
    expect((await release({ "sec-fetch-site": "cross-site", origin: "https://site.test" })).status).toBe(403);
  });

  it("without Sec-Fetch-Site, compares the Origin (or Referer) host with the request's", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const release = (headers: Record<string, string>, base?: string) =>
      handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, headers, base));
    expect((await release({ origin: "https://site.test" })).status).toBe(200);
    expect((await release({ origin: "https://evil.example" })).status).toBe(403);
    expect((await release({ origin: "https://site.test.evil.example" })).status).toBe(403);
    expect((await release({ origin: "null" })).status).toBe(403); // sandboxed iframe, file:, data:
    expect((await release({ referer: "https://site.test/book" })).status).toBe(200);
    expect((await release({ referer: "https://evil.example/page" })).status).toBe(403);
    expect((await release({ origin: "not a url" })).status).toBe(403);
    // Behind a proxy that rewrites Host: X-Forwarded-Host names the public host.
    expect((await release({ origin: "https://site.test", "x-forwarded-host": "site.test" }, "http://internal:3000/api/booking")).status).toBe(200);
    expect((await release({ origin: "https://site.test" }, "http://internal:3000/api/booking")).status).toBe(403);
  });

  it("with neither header, only a non-browser call passes (no Sec-Fetch-* at all)", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    const release = (headers: Record<string, string>) => handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, headers));
    expect((await release({})).status).toBe(200); // a server, a test, curl
    expect((await release({ "sec-fetch-mode": "no-cors" })).status).toBe(403); // a browser we cannot vouch for
    expect((await release({ "sec-fetch-dest": "empty" })).status).toBe(403);
  });

  it("GETs are not checked (they change nothing, and CORS already stops another site reading them)", async () => {
    const { tenantId } = await seedTenant();
    const res = await handlers(tenantId).handle(new Request(`${BASE}/v1/config`, { headers: CROSS }));
    expect(res.status).toBe(200);
  });

  it("cors: '*' turns the check off; a single origin lets that origin through and nobody else", async () => {
    const { tenantId } = await seedTenant();
    const open = handlers(tenantId, { cors: "*" });
    expect((await open.handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, CROSS))).status).toBe(200);
    const partner = handlers(tenantId, { cors: "https://partner.example" });
    const fromPartner = { "sec-fetch-site": "cross-site", origin: "https://partner.example" };
    expect((await partner.handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, fromPartner))).status).toBe(200);
    expect((await partner.handle(send("/v1/hold/release", { holdToken: "x".repeat(43) }, CROSS))).status).toBe(403);
  });

  it("isCrossSiteRequest is exported for host apps with their own routes", () => {
    expect(isCrossSiteRequest(new Request(BASE, { method: "POST", headers: CROSS }))).toBe(true);
    expect(isCrossSiteRequest(new Request(BASE, { method: "POST", headers: SAME }))).toBe(false);
  });
});

describe("emails off, and a contact address", () => {
  it("echoes emailsEnabled and contactEmail in the config", async () => {
    const { tenantId } = await seedTenant();
    const config = (await (await handlers(tenantId, { emailsEnabled: false, contactEmail: " Hello@Site.test " }).handle(get("/v1/config"))).json()) as {
      emailsEnabled: boolean;
      contactEmail: string | null;
    };
    expect(config).toMatchObject({ emailsEnabled: false, contactEmail: "hello@site.test" });
    const blank = (await (await handlers(tenantId, { contactEmail: "" }).handle(get("/v1/config"))).json()) as { contactEmail: string | null };
    expect(blank.contactEmail).toBeNull();
  });

  it("a contactEmail that is not an address, or a nonsense hold cap, throws at construction", () => {
    expect(() => handlers("x", { contactEmail: "call us" })).toThrow(/contactEmail/);
    expect(() => handlers("x", { maxHoldsPerSubject: 0 })).toThrow(/maxHoldsPerSubject/);
    expect(() => handlers("x", { maxHoldsPerSubject: 1.5 })).toThrow(/maxHoldsPerSubject/);
  });

  it("already_booked stops promising an email, and points at the confirmation page and the contact", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId, { emailsEnabled: false, contactEmail: "hello@site.test" });
    const hold = (await (await handle(post("/v1/hold", { type: "intro", start: FIRST }))).json()) as { holdToken: string };
    await handle(post("/v1/book", bookBody({ holdToken: hold.holdToken })));
    const twice = (await (await handle(post("/v1/book", bookBody({ holdToken: hold.holdToken })))).json()) as {
      error: { code: string; message: string };
    };
    expect(twice.error.code).toBe("already_booked");
    expect(twice.error.message).not.toMatch(/email for the confirmation|Check your email/i);
    expect(twice.error.message).toMatch(/private link on your confirmation page/);
    expect(twice.error.message).toContain("hello@site.test");
  });

  it("a video call with no meeting link says who sends it — and nothing about email", async () => {
    const tenantId = tenant("nolink");
    const ctx = { db: t.db, tenantId, now: NOW };
    const host = await upsertHost(ctx, { displayName: "Dallin", email: "dallin@adminigloo.com", timezone: "America/Denver" });
    await setWeeklyAvailability(ctx, { hostId: host.id, windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }] });
    await upsertType(ctx, { key: "intro", name: "Intro call", durationMinutes: 30, media: ["video"] });
    const { handle } = handlers(tenantId);
    const booked = (await (await handle(post("/v1/book", bookBody()))).json()) as { booking: { googleCalendarUrl: string }; manageToken: string };
    const details = new URL(booked.booking.googleCalendarUrl).searchParams.get("details") ?? "";
    expect(details).toMatch(/^Video call — Dallin will send you the link before the call\./);
    const ics = (await (await handle(get(`/v1/manage/${booked.manageToken}/ics`))).text()).replace(/\r\n /g, "");
    expect(ics).toContain("Dallin will send you the link before the call.");
    expect(`${details}\n${ics}`).not.toMatch(/by email|follows by email/i);
  });
});

describe("hold limits per requester", () => {
  it("a subject holds at most maxHoldsPerSubject at once; replacing one is never refused; others are unaffected", async () => {
    const { tenantId } = await seedTenant();
    let who: string | null = "203.0.113.9";
    const { handle } = handlers(tenantId, { holdSubject: () => who, maxHoldsPerSubject: 2 });
    const hold = async (start: string, extra: Record<string, unknown> = {}) => handle(post("/v1/hold", { type: "intro", start, ...extra }));
    const first = (await (await hold(FIRST)).json()) as { holdToken: string };
    expect((await hold(TUE_10)).status).toBe(200);
    const third = await hold("2026-10-07T16:00:00.000Z");
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // Moving a hold (previousHoldToken) does not count the one being replaced.
    expect((await hold("2026-10-07T16:00:00.000Z", { previousHoldToken: first.holdToken })).status).toBe(200);
    // Another requester, and a request with no subject, are not affected.
    who = "198.51.100.4";
    expect((await hold("2026-10-08T16:00:00.000Z")).status).toBe(200);
    who = null;
    expect((await hold("2026-10-09T16:00:00.000Z")).status).toBe(200);
    // Only a hash is stored, never the subject itself.
    const rows = await t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, tenantId));
    expect(rows.some((row) => /^[0-9a-f]{64}$/.test(row.holdSubjectHash ?? ""))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });

  it("negative control: without holdSubject the same three holds all succeed", async () => {
    const { tenantId } = await seedTenant();
    const { handle } = handlers(tenantId);
    for (const start of [FIRST, TUE_10, "2026-10-07T16:00:00.000Z"]) {
      expect((await handle(post("/v1/hold", { type: "intro", start }))).status).toBe(200);
    }
  });
});
