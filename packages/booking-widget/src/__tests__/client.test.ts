import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingClient, CLIENT_KEY_HEADER, joinUrl, parseBooking, resolveBookingTypeKey } from "../client.js";
import type { PublicBooking, PublicBookingType } from "../types.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records each call and answers with the next queued response. */
function fakeFetch(...responses: Array<{ status?: number; body?: unknown; raw?: string } | Error>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: {} };
    if (next instanceof Error) throw next;
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    return new Response(text, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string> | undefined)?.[name];

const booking: PublicBooking = {
  status: "confirmed",
  start: "2026-10-06T15:00:00Z",
  end: "2026-10-06T15:30:00Z",
  typeName: "Intro call",
  durationMinutes: 30,
  hostDisplayName: "Dallin",
  hostTimezone: "America/Denver",
  inviteeName: "Ada",
  inviteeTimezone: "Europe/London",
  medium: "video",
  meetingLink: "https://meet.example.com/abc",
  hostPhone: null,
  inviteMailbox: null,
  googleCalendarUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE",
  canCancel: true,
  canReschedule: true,
  sandbox: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("URLs", () => {
  it("joins the base and path with exactly one slash", () => {
    expect(joinUrl("/api/booking/", "/v1/config")).toBe("/api/booking/v1/config");
    expect(joinUrl("https://x.test/api/booking", "v1/config")).toBe("https://x.test/api/booking/v1/config");
  });

  it("puts the manage token in the path, encoded", () => {
    const client = new BookingClient({ baseUrl: "/api/booking" });
    expect(client.icsUrl("ab/c+d")).toBe("/api/booking/v1/manage/ab%2Fc%2Bd/ics");
  });
});

describe("reads", () => {
  it("fetches config without custom headers when there is no key (no CORS preflight)", async () => {
    const { impl, calls } = fakeFetch({
      body: {
        sandbox: true,
        hostDisplayName: "Dallin",
        hostTimezone: "America/Denver",
        types: [{ key: "intro", name: "Intro call", description: null, durationMinutes: 30, media: ["video", "fax"] }],
      },
    });
    const client = new BookingClient({ baseUrl: "/api/booking/", fetchImpl: impl });
    const res = await client.config();
    expect(calls[0]!.url).toBe("/api/booking/v1/config");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers).toEqual({});
    expect(calls[0]!.init.cache).toBe("no-store");
    expect(res.ok && res.data.sandbox).toBe(true);
    // Unknown media values from a newer server are dropped, not rendered.
    expect(res.ok && res.data.types[0]!.media).toEqual(["video"]);
  });

  it("sends the client key on every call when there is one", async () => {
    const { impl, calls } = fakeFetch({ body: { slots: [], busySync: "ok" } });
    const client = new BookingClient({ baseUrl: "https://host.test/api/booking", clientKey: "abk_123", fetchImpl: impl });
    await client.slots({ type: "intro call", from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" });
    expect(header(calls[0]!, CLIENT_KEY_HEADER)).toBe("abk_123");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/booking/v1/slots");
    expect(url.searchParams.get("type")).toBe("intro call");
    expect(url.searchParams.get("from")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("reads each type's notice and horizon and the calling code — and an older config without them", async () => {
    const { impl } = fakeFetch(
      {
        body: {
          sandbox: false,
          hostDisplayName: "Dallin",
          hostTimezone: "America/Denver",
          defaultCallingCode: "1",
          types: [
            { key: "intro", name: "Intro", description: "", durationMinutes: 30, media: ["video"], minNoticeMinutes: 240, horizonDays: 21 },
            // Nonsense from a misbehaving server is dropped, not trusted.
            { key: "odd", name: "Odd", description: "", durationMinutes: 30, media: ["video"], minNoticeMinutes: -5, horizonDays: 0.5 },
          ],
        },
      },
      {
        body: {
          sandbox: false,
          hostDisplayName: "Dallin",
          hostTimezone: "America/Denver",
          defaultCallingCode: "US",
          types: [{ key: "intro", name: "Intro", description: "", durationMinutes: 30, media: ["video"] }],
        },
      },
    );
    const client = new BookingClient({ baseUrl: "/b", fetchImpl: impl });
    const current = await client.config();
    expect(current.ok && current.data.defaultCallingCode).toBe("1");
    expect(current.ok && current.data.types[0]).toMatchObject({ minNoticeMinutes: 240, horizonDays: 21 });
    expect(current.ok && "horizonDays" in current.data.types[1]!).toBe(false);
    expect(current.ok && "minNoticeMinutes" in current.data.types[1]!).toBe(false);
    const older = await client.config();
    expect(older.ok && "defaultCallingCode" in older.data).toBe(false);
    expect(older.ok && "horizonDays" in older.data.types[0]!).toBe(false);
  });

  it("reads whether the server sends email and its contact address — absent keeps the old meaning", async () => {
    const base = { sandbox: false, hostDisplayName: "Dallin", hostTimezone: "America/Denver", types: [] };
    const { impl } = fakeFetch(
      { body: { ...base, emailsEnabled: false, contactEmail: " hello@site.test " } },
      { body: { ...base, emailsEnabled: true, contactEmail: null } },
      { body: base },
      // A misbehaving server: a string "false" is not a boolean, and a
      // malformed address must never become a mailto: link.
      { body: { ...base, emailsEnabled: "false", contactEmail: "javascript:alert(1)" } },
    );
    const client = new BookingClient({ baseUrl: "/b", fetchImpl: impl });
    const off = await client.config();
    expect(off.ok && off.data).toMatchObject({ emailsEnabled: false, contactEmail: "hello@site.test" });
    const on = await client.config();
    expect(on.ok && on.data).toMatchObject({ emailsEnabled: true, contactEmail: null });
    const older = await client.config();
    expect(older.ok && "emailsEnabled" in older.data).toBe(false);
    expect(older.ok && "contactEmail" in older.data).toBe(false);
    const odd = await client.config();
    expect(odd.ok && "emailsEnabled" in odd.data).toBe(false);
    expect(odd.ok && odd.data.contactEmail).toBeNull();
  });

  it("asks for slots as a reschedule only when given a manage token", async () => {
    const { impl, calls } = fakeFetch({ body: { slots: [], busySync: "off" } }, { body: { slots: [], busySync: "off" } });
    const client = new BookingClient({ baseUrl: "https://host.test/b", fetchImpl: impl });
    await client.slots({ type: "intro", from: "a", to: "b" });
    await client.slots({ type: "intro", from: "a", to: "b", manage: "mt_1" });
    expect(new URL(calls[0]!.url).searchParams.has("manage")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.get("manage")).toBe("mt_1");
  });

  it("keeps only well-formed slots and defaults busySync", async () => {
    const { impl } = fakeFetch({
      body: { slots: [{ start: "2026-10-06T15:00:00Z", end: "2026-10-06T15:30:00Z" }, { start: 5 }], busySync: "nope" },
    });
    const res = await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).slots({ type: "t", from: "a", to: "b" });
    expect(res.ok && res.data).toEqual({
      slots: [{ start: "2026-10-06T15:00:00Z", end: "2026-10-06T15:30:00Z" }],
      busySync: "off",
    });
  });
});

describe("failures come back as values", () => {
  it("maps an error body", async () => {
    const { impl } = fakeFetch({ status: 409, body: { error: { code: "slot_taken", message: "gone" } } });
    const res = await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).hold({ type: "intro", start: "x" });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe("slot_taken");
  });

  it("turns a thrown fetch into a network error", async () => {
    const { impl } = fakeFetch(new TypeError("Failed to fetch"));
    const res = await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).config();
    expect(!res.ok && res.error).toMatchObject({ code: "network", status: 0 });
  });

  it("treats a 200 that is not the contract (a proxy's HTML page) as a server error", async () => {
    const { impl } = fakeFetch({ raw: "<html>hello</html>" }, { body: { nothing: true } });
    const client = new BookingClient({ baseUrl: "/b", fetchImpl: impl });
    const config = await client.config();
    expect(!config.ok && config.error.code).toBe("server");
    const manage = await client.getBooking("t");
    expect(!manage.ok && manage.error.code).toBe("server");
  });
});

describe("writes", () => {
  it("posts JSON for a hold, with the previous token", async () => {
    const { impl, calls } = fakeFetch({
      body: { holdToken: "h2", expiresAt: "2026-10-06T15:10:00Z", start: "2026-10-06T15:00:00Z", end: "2026-10-06T15:30:00Z" },
    });
    const res = await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).hold({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      previousHoldToken: "h1",
    });
    expect(calls[0]!.url).toBe("/b/v1/hold");
    expect(calls[0]!.init.method).toBe("POST");
    expect(header(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      type: "intro",
      start: "2026-10-06T15:00:00Z",
      previousHoldToken: "h1",
    });
    expect(res.ok && res.data.holdToken).toBe("h2");
  });

  it("sends a reschedule's manage token with the hold", async () => {
    const { impl, calls } = fakeFetch({
      body: { holdToken: "h1", expiresAt: "2026-10-06T15:10:00Z", start: "2026-10-06T15:00:00Z", end: "2026-10-06T15:30:00Z" },
    });
    await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).hold({ type: "intro", start: "2026-10-06T15:00:00Z", manageToken: "mt_1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ type: "intro", start: "2026-10-06T15:00:00Z", manageToken: "mt_1" });
  });

  it("books, and reads the manage token and URL", async () => {
    const { impl, calls } = fakeFetch({
      body: { booking, manageToken: "m_1", manageUrl: "https://site.test/booking/manage/m_1" },
    });
    const res = await new BookingClient({ baseUrl: "/b", fetchImpl: impl }).book({
      type: "intro",
      start: booking.start,
      name: "Ada",
      email: "ada@example.com",
      medium: "video",
      timezone: "Europe/London",
    });
    expect(calls[0]!.url).toBe("/b/v1/book");
    expect(res.ok && res.data.manageToken).toBe("m_1");
    expect(res.ok && res.data.booking.meetingLink).toBe("https://meet.example.com/abc");
  });

  it("cancels and reschedules on the token's routes", async () => {
    const { impl, calls } = fakeFetch(
      { body: { booking: { ...booking, status: "cancelled" } } },
      { body: { booking: { ...booking, start: "2026-10-07T15:00:00Z", end: "2026-10-07T15:30:00Z" } } },
    );
    const client = new BookingClient({ baseUrl: "/b", fetchImpl: impl });
    const cancelled = await client.cancel("tok", { reason: "Conflict" });
    const moved = await client.reschedule("tok", { start: "2026-10-07T15:00:00Z", holdToken: "h" });
    expect(calls.map((c) => c.url)).toEqual(["/b/v1/manage/tok/cancel", "/b/v1/manage/tok/reschedule"]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ start: "2026-10-07T15:00:00Z", holdToken: "h" });
    expect(cancelled.ok && cancelled.data.booking.status).toBe("cancelled");
    expect(moved.ok && moved.data.booking.start).toBe("2026-10-07T15:00:00Z");
  });

  it("releases with a keepalive fetch that carries the key", () => {
    const { impl, calls } = fakeFetch({ body: { ok: true } });
    new BookingClient({ baseUrl: "/b", clientKey: "k", fetchImpl: impl }).release("h1");
    expect(calls[0]!.url).toBe("/b/v1/hold/release");
    expect(calls[0]!.init.keepalive).toBe(true);
    expect(header(calls[0]!, CLIENT_KEY_HEADER)).toBe("k");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ holdToken: "h1" });
  });

  it("falls back to sendBeacon (text/plain, no preflight) when fetch refuses keepalive", async () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const throwing = (() => {
      throw new TypeError("keepalive unsupported");
    }) as unknown as typeof fetch;
    new BookingClient({ baseUrl: "/b", fetchImpl: throwing }).release("h1");
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0]!;
    expect(url).toBe("/b/v1/hold/release");
    expect((blob as Blob).type).toBe("text/plain;charset=utf-8");
    expect(JSON.parse(await (blob as Blob).text())).toEqual({ holdToken: "h1" });
  });

  it("never throws from release, even with nothing to send it with", () => {
    vi.stubGlobal("navigator", {});
    const throwing = (() => {
      throw new Error("no");
    }) as unknown as typeof fetch;
    expect(() => new BookingClient({ baseUrl: "/b", fetchImpl: throwing }).release("h1")).not.toThrow();
  });
});

describe("parsing a booking", () => {
  it("fills safe defaults instead of crashing on a sparse answer", () => {
    const parsed = parseBooking({ status: "confirmed", start: "2026-10-06T15:00:00Z", end: "2026-10-06T16:00:00Z", medium: "carrier-pigeon" });
    expect(parsed).toMatchObject({ durationMinutes: 60, medium: "video", meetingLink: null, canCancel: false, sandbox: false });
    expect(parseBooking({ status: "confirmed" })).toBeNull();
    expect(parseBooking(null)).toBeNull();
  });

  it("keeps typeKey — even an empty one — and leaves it out when an older server sent none", () => {
    const base = { status: "confirmed", start: "2026-10-06T15:00:00Z", end: "2026-10-06T15:30:00Z" };
    expect(parseBooking({ ...base, typeKey: "intro" })?.typeKey).toBe("intro");
    expect(parseBooking({ ...base, typeKey: "" })?.typeKey).toBe("");
    expect(parseBooking(base) && "typeKey" in parseBooking(base)!).toBe(false);
    expect(parseBooking({ ...base, typeKey: 7 }) && "typeKey" in parseBooking({ ...base, typeKey: 7 })!).toBe(false);
  });
});

describe("which type a booking is", () => {
  const types: PublicBookingType[] = [
    { key: "intro", name: "Intro call", description: null, durationMinutes: 30, media: ["video"] },
    { key: "intro-long", name: "Intro call", description: null, durationMinutes: 60, media: ["video"] },
    { key: "deep", name: "Deep dive", description: null, durationMinutes: 90, media: ["video"] },
  ];

  it("matches on name and duration, then name alone", () => {
    expect(resolveBookingTypeKey(booking, types)).toBe("intro");
    expect(resolveBookingTypeKey({ ...booking, durationMinutes: 60 }, types)).toBe("intro-long");
    expect(resolveBookingTypeKey({ ...booking, typeName: "Deep dive", durationMinutes: 45 }, types)).toBe("deep");
  });

  it("uses a typeKey when a server sends one, and the only type when there is one", () => {
    expect(resolveBookingTypeKey({ ...booking, typeKey: "deep" }, types)).toBe("deep");
    expect(resolveBookingTypeKey({ ...booking, typeName: "Renamed" }, [types[2]!])).toBe("deep");
    expect(resolveBookingTypeKey({ ...booking, typeName: "Renamed" }, types)).toBeNull();
  });

  it("with a typeKey, never falls back to guessing by name", () => {
    // The key wins over a name that points elsewhere.
    expect(resolveBookingTypeKey({ ...booking, typeKey: "intro-long" }, types)).toBe("intro-long");
    // A key the config no longer offers (retired type), or "" (type gone):
    // not movable online — NOT the same-named "intro".
    expect(resolveBookingTypeKey({ ...booking, typeKey: "retired" }, types)).toBeNull();
    expect(resolveBookingTypeKey({ ...booking, typeKey: "" }, types)).toBeNull();
    expect(resolveBookingTypeKey({ ...booking, typeKey: "" }, [types[0]!])).toBeNull();
  });
});
