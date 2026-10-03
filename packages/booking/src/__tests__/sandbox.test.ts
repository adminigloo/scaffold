import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  createSandboxBookingHandlers,
  type CreateSandboxBookingHandlersOptions,
  type SandboxRateLimitBucket,
} from "../sandbox.js";
import { bookingBookings, bookingHosts } from "../schema.js";
import type { BookingEvent } from "../services/context.js";
import { hashToken } from "../tokens.js";
import { createTestDb, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

/** Monday 2026-10-05, 09:00 in Denver. */
const NOW = new Date("2026-10-05T15:00:00Z");
const HOUR = 3_600_000;
/** Monday 11:00 MDT: inside the sample week, past the hour's notice. */
const SLOT = "2026-10-05T17:00:00.000Z";
const SLOT_2 = "2026-10-06T16:00:00.000Z";
const BASE = "https://site.test/api/book-demo";
const COOKIE = "demo_sess";

/** A sample business, not a person: what a buyer's own customers would book. */
const SEED: CreateSandboxBookingHandlersOptions["seed"] = {
  host: { displayName: "Maya at Northwind (sample)", email: "host@example.com", timezone: "America/Denver", inviteMailbox: "invites@example.com" },
  weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
  types: [{ key: "consult", name: "Consultation (sample)", durationMinutes: 30, media: ["video", "phone"], minNoticeMinutes: 60 }],
};

let counter = 0;
function demo(extra: Partial<CreateSandboxBookingHandlersOptions> = {}) {
  counter += 1;
  const prefix = `sbx${counter}:`;
  const preview = `sbx${counter}-preview`;
  let clock = NOW;
  const deferred: Array<() => Promise<unknown>> = [];
  const handlers = createSandboxBookingHandlers({
    db: t.db,
    cookieName: COOKIE,
    secureCookie: false,
    tenantPrefix: prefix,
    previewTenant: preview,
    seed: SEED,
    uidDomain: "demo.site.test",
    manageUrl: (token) => `https://site.test/demo/manage/${token}`,
    now: () => clock,
    defer: (task) => void deferred.push(task),
    ...extra,
  });
  return {
    ...handlers,
    prefix,
    preview,
    setClock: (date: Date) => {
      clock = date;
    },
    runDeferred: async () => {
      while (deferred.length) await deferred.shift()?.();
    },
  };
}

const get = (path: string, cookie?: string) =>
  new Request(`${BASE}${path}`, { headers: cookie ? { cookie: `${COOKIE}=${cookie}` } : {} });
const post = (path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
const bookBody = (overrides: Record<string, unknown> = {}) => ({
  type: "consult",
  start: SLOT,
  name: "Test Visitor",
  email: "visitor@example.com",
  medium: "video",
  timezone: "America/New_York",
  ...overrides,
});

/** The session token a response set, or null; "" for a clearing cookie. */
function sessionFrom(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const match = new RegExp(`${COOKIE}=([^;]*)`).exec(header);
  return match ? (match[1] ?? "") : null;
}

const rowsUnder = async (prefix: string) =>
  t.db.select().from(bookingBookings).where(like(bookingBookings.tenantId, `${prefix}%`));
const hostsUnder = async (prefix: string) => t.db.select().from(bookingHosts).where(like(bookingHosts.tenantId, `${prefix}%`));

describe("who gets a sandbox", () => {
  it("reads with no cookie are served from the read-only preview, and create nothing for the visitor", async () => {
    const d = demo();
    const config = await d.handle(get("/v1/config"));
    expect(config.status).toBe(200);
    expect(sessionFrom(config)).toBeNull();
    expect(await config.json()).toMatchObject({ sandbox: true, hostDisplayName: "Maya at Northwind (sample)" });
    const slots = (await (await d.handle(get("/v1/slots?type=consult"))).json()) as { slots: Array<{ start: string }> };
    expect(slots.slots[0]?.start).toBe("2026-10-05T16:00:00.000Z"); // 10:00 MDT: an hour's notice from 09:00
    expect(await hostsUnder(d.prefix)).toHaveLength(0);
    const preview = await t.db.select().from(bookingHosts).where(eq(bookingHosts.tenantId, d.preview));
    expect(preview).toHaveLength(1);
  });

  it("the first hold mints a sandbox: an httpOnly session cookie whose SHA-256 is the tenant, kept for later requests", async () => {
    const d = demo();
    const holdRes = await d.handle(post("/v1/hold", { type: "consult", start: SLOT }));
    expect(holdRes.status).toBe(200);
    const header = holdRes.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Max-Age|Expires|Secure/); // a session cookie; not Secure in this config
    const token = sessionFrom(holdRes) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tenantId = `${d.prefix}${await hashToken(token)}`;
    expect(d.isSandboxTenant(tenantId)).toBe(true);
    const hold = (await holdRes.json()) as { holdToken: string };

    // The same browser books in the same sandbox, with no new cookie.
    const booked = await d.handle(post("/v1/book", bookBody({ holdToken: hold.holdToken }), token));
    expect(booked.status).toBe(200);
    expect(sessionFrom(booked)).toBeNull();
    const rows = await t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, tenantId));
    expect(rows.map((row) => row.status)).toEqual(["confirmed"]);
    // The capability itself is stored nowhere.
    expect(JSON.stringify(await rowsUnder(d.prefix))).not.toContain(token);
    // Reads from this browser now show its own sandbox: its booked time is gone from the list.
    const slots = (await (await d.handle(get("/v1/slots?type=consult", token))).json()) as { slots: Array<{ start: string }> };
    expect(slots.slots.some((slot) => slot.start === SLOT)).toBe(false);
    // …while the preview, which only ever serves reads, still has nobody booked.
    expect(await t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, d.preview))).toHaveLength(0);
  });

  it("manage, release and feed are only for the visitor's own sandbox", async () => {
    const d = demo();
    const a = await d.handle(post("/v1/book", bookBody()));
    const aToken = sessionFrom(a) ?? "";
    const { manageToken } = (await a.json()) as { manageToken: string };
    const b = await d.handle(post("/v1/hold", { type: "consult", start: SLOT_2 }));
    const bToken = sessionFrom(b) ?? "";
    expect(bToken).not.toBe(aToken);
    expect((await d.handle(get(`/v1/manage/${manageToken}`))).status).toBe(404); // no sandbox
    expect((await d.handle(get(`/v1/manage/${manageToken}`, bToken))).status).toBe(404); // someone else's
    const own = await d.handle(get(`/v1/manage/${manageToken}`, aToken));
    expect(own.status).toBe(200);
    expect(own.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await d.handle(post(`/v1/manage/${manageToken}/cancel`, {}))).status).toBe(404);
    expect((await d.handle(get("/v1/feed/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG.ics"))).status).toBe(404);
  });

  it("a forged or unknown cookie is never adopted: it is cleared, and a claim mints a fresh one", async () => {
    const d = demo();
    const junk = await d.handle(get("/v1/config", "not-a-token"));
    expect(junk.status).toBe(200); // served from the preview
    expect(sessionFrom(junk)).toBe("");
    expect(junk.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const unknown = "A".repeat(43); // the right shape, but no sandbox behind it
    const claim = await d.handle(post("/v1/hold", { type: "consult", start: SLOT }, unknown));
    expect(claim.status).toBe(200);
    const minted = sessionFrom(claim);
    expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted).not.toBe(unknown);
    expect(await t.db.select().from(bookingHosts).where(eq(bookingHosts.tenantId, `${d.prefix}${await hashToken(unknown)}`))).toHaveLength(0);
  });
});

describe("lifetime and cleanup", () => {
  it("a sandbox past its lifetime is gone where it is used, and deleted after the response", async () => {
    const d = demo({ ttlHours: 24 });
    const booked = await d.handle(post("/v1/book", bookBody()));
    const token = sessionFrom(booked) ?? "";
    const { manageToken } = (await booked.json()) as { manageToken: string };
    const tenantId = `${d.prefix}${await hashToken(token)}`;
    d.setClock(new Date(NOW.getTime() + 23 * HOUR));
    expect((await d.handle(get(`/v1/manage/${manageToken}`, token))).status).toBe(200); // still alive
    d.setClock(new Date(NOW.getTime() + 25 * HOUR));
    const late = await d.handle(get(`/v1/manage/${manageToken}`, token));
    expect(late.status).toBe(404);
    expect(sessionFrom(late)).toBe("");
    await d.runDeferred();
    expect(await t.db.select().from(bookingHosts).where(eq(bookingHosts.tenantId, tenantId))).toHaveLength(0);
    expect(await t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, tenantId))).toHaveLength(0);
  });

  it("purgeExpired removes old sandboxes and never the preview; removeSandbox takes only full sandbox ids", async () => {
    const d = demo();
    await d.handle(get("/v1/config")); // seeds the preview
    await d.handle(post("/v1/book", bookBody()));
    await d.handle(post("/v1/hold", { type: "consult", start: SLOT_2 }));
    expect(await hostsUnder(d.prefix)).toHaveLength(2);
    expect(await d.purgeExpired({ now: new Date(NOW.getTime() + HOUR) })).toEqual({ idle: 0, aged: 0 });
    const result = await d.purgeExpired({ now: new Date(NOW.getTime() + 30 * HOUR) });
    expect(result.idle + result.aged).toBe(2);
    expect(await hostsUnder(d.prefix)).toHaveLength(0);
    expect(await t.db.select().from(bookingHosts).where(eq(bookingHosts.tenantId, d.preview))).toHaveLength(1);
    expect(await d.removeSandbox(d.preview)).toEqual({ tenants: 0 });
    expect(await d.removeSandbox(d.prefix)).toEqual({ tenants: 0 });
    expect(await d.removeSandbox(`${d.prefix}${"0".repeat(63)}`)).toEqual({ tenants: 0 });
  });
});

describe("fences", () => {
  it("a cross-site POST is refused before a sandbox is minted (control: the same request from our page mints one)", async () => {
    const d = demo();
    const forged = await d.handle(
      post("/v1/hold", { type: "consult", start: SLOT }, undefined, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }),
    );
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(sessionFrom(forged)).toBeNull();
    expect(await hostsUnder(d.prefix)).toHaveLength(0);
    const own = await d.handle(
      post("/v1/hold", { type: "consult", start: SLOT }, undefined, { "sec-fetch-site": "same-origin", origin: "https://site.test" }),
    );
    expect(own.status).toBe(200);
    expect(await hostsUnder(d.prefix)).toHaveLength(1);
  });

  it("the new-sandbox ceiling answers 'busy' and mints nothing more", async () => {
    const d = demo({ ceilings: { newSandboxesPerHour: 1 } });
    expect((await d.handle(post("/v1/hold", { type: "consult", start: SLOT }))).status).toBe(200);
    const second = await d.handle(post("/v1/hold", { type: "consult", start: SLOT_2 }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("300");
    expect(((await second.json()) as { error: { message: string } }).error.message).toMatch(/demo is busy/);
    expect(await hostsUnder(d.prefix)).toHaveLength(1);
    // An hour on, the ceiling has rolled.
    d.setClock(new Date(NOW.getTime() + HOUR + 1));
    expect((await d.handle(post("/v1/hold", { type: "consult", start: SLOT_2 }))).status).toBe(200);
  });

  it("the claims ceiling refuses holds and bookings — checked before minting, so no empty sandbox is left", async () => {
    const d = demo({ ceilings: { holdsPerHour: 2 } });
    const first = await d.handle(post("/v1/hold", { type: "consult", start: SLOT }));
    const token = sessionFrom(first) ?? "";
    expect((await d.handle(post("/v1/hold", { type: "consult", start: SLOT_2 }, token))).status).toBe(200);
    expect((await d.handle(post("/v1/book", bookBody({ start: "2026-10-07T16:00:00.000Z" }), token))).status).toBe(429);
    expect((await d.handle(post("/v1/hold", { type: "consult", start: "2026-10-08T16:00:00.000Z" }))).status).toBe(429);
    expect(await hostsUnder(d.prefix)).toHaveLength(1);
  });

  it("rateLimit sees each bucket, and 'mint' separately: refusing a mint mints nothing", async () => {
    const seen: SandboxRateLimitBucket[] = [];
    const d = demo({ rateLimit: (_req, bucket) => (seen.push(bucket), bucket !== "mint") });
    expect((await d.handle(get("/v1/config"))).status).toBe(200);
    const refused = await d.handle(post("/v1/hold", { type: "consult", start: SLOT }));
    expect(refused.status).toBe(429);
    expect(seen).toEqual(["read", "hold", "mint"]);
    expect(await hostsUnder(d.prefix)).toHaveLength(0);
  });
});

describe("the sandbox guarantee", () => {
  it("never emails and never reads a calendar, even when an untyped caller passes both", async () => {
    let events = 0;
    let busyCalls = 0;
    const d = demo({
      // Not in the options type; an untyped caller could still pass them.
      ...({ onEvent: (_e: BookingEvent) => void (events += 1), busySource: { busy: async () => (busyCalls++, []) } } as object),
      realBookingUrl: "https://site.test/book",
    });
    const booked = await d.handle(post("/v1/book", bookBody()));
    const token = sessionFrom(booked) ?? "";
    const body = (await booked.json()) as { booking: { sandbox: boolean; googleCalendarUrl: string }; manageToken: string };
    expect(body.booking.sandbox).toBe(true);
    await d.handle(post(`/v1/manage/${body.manageToken}/reschedule`, { start: SLOT_2 }, token));
    await d.handle(post(`/v1/manage/${body.manageToken}/cancel`, {}, token));
    expect(events).toBe(0);
    expect(busyCalls).toBe(0);
    // Its calendar exports are labelled non-events, with the way to a real booking.
    expect(new URL(body.booking.googleCalendarUrl).searchParams.get("details")).toContain("Book a real call: https://site.test/book");
    const ics = await (await d.handle(get(`/v1/manage/${body.manageToken}/ics`, token))).text();
    expect(ics).toContain("[Sandbox — not a real booking]");
    expect(ics).toContain("UID:");
    expect(ics).toMatch(/@demo\.site\.test/);
  });

  it("onBooked hears about a sandbox booking — the request's headers, never the booking", async () => {
    const heard: Array<{ headers: Headers; url: string }> = [];
    const d = demo({ onBooked: (info) => void heard.push(info) });
    await d.handle(post("/v1/hold", { type: "consult", start: SLOT }));
    await d.handle(post("/v1/book", bookBody({ start: SLOT_2 }), undefined, { "user-agent": "vitest" }));
    await d.runDeferred();
    expect(heard).toHaveLength(1);
    expect(heard[0]?.headers.get("user-agent")).toBe("vitest");
    expect(Object.keys(heard[0] ?? {}).sort()).toEqual(["headers", "url"]);
  });
});

describe("construction", () => {
  const base = (extra: Partial<CreateSandboxBookingHandlersOptions>) => () =>
    createSandboxBookingHandlers({
      db: t.db,
      cookieName: COOKIE,
      secureCookie: false,
      tenantPrefix: "demo:",
      previewTenant: "demo-preview",
      seed: SEED,
      uidDomain: "demo.site.test",
      manageUrl: (token) => token,
      ...extra,
    });

  it("refuses configurations that would fail quietly in production", () => {
    expect(base({ cookieName: "__Host-demo" })).toThrow(/secureCookie/);
    expect(base({ cookieName: "__Host-demo", secureCookie: true })).not.toThrow();
    expect(base({ cookieName: "bad name;" })).toThrow(/cookie name/);
    expect(base({ tenantPrefix: "ab" })).toThrow(/3–36/);
    expect(base({ previewTenant: "demo:preview" })).toThrow(/must not start with tenantPrefix/);
    expect(base({ seed: { ...SEED, host: { ...SEED.host, timezone: "Mars/Olympus" } } })).toThrow(/seed is invalid/);
    expect(base({ ttlHours: 0 })).toThrow(/ttlHours/);
    expect(base({ ceilings: { holdsPerHour: -1 } })).toThrow(/holdsPerHour/);
  });

  it("the Secure attribute follows secureCookie", async () => {
    const counterBefore = counter;
    const d = demo({ secureCookie: true });
    expect(counter).toBe(counterBefore + 1);
    const res = await d.handle(post("/v1/hold", { type: "consult", start: SLOT }));
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/);
  });
});
