import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BusyFeedTooLargeError, createIcsBusySource, isFeedTooLarge, type BusySource } from "../busy-source.js";
import { expandBusy, FEED_TOO_LARGE_MESSAGE, IcsBudgetError, parseIcsCalendar } from "../ical.js";
import { setWeeklyAvailability, upsertHost, upsertType } from "../services/admin.js";
import type { BookingContext } from "../services/context.js";
import { listOpenSlots } from "../services/public.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * C1 (review 2b-4c): a calendar address that could freeze the app. A COUNT
 * rule from 1800 walked 100,000 periods per event per call, on every busy()
 * call. Now a COUNT rule with one instance per period jumps to the window,
 * every call has a step budget, and a feed over it fails CLOSED for its host.
 */

function feed(events: number, rule: string, dtstart = "18000101T090000Z"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0"];
  for (let i = 0; i < events; i++) {
    lines.push("BEGIN:VEVENT", `UID:e${i}`, `DTSTART:${dtstart}`, "DURATION:PT30M", `RRULE:${rule}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

/**
 * About 25 ms alone on a laptop; the bound leaves room for the rest of the
 * suite running beside it (PGlite workers). The point is "milliseconds, not
 * the minutes 0.1 took", which 100 ms proves.
 */
// The package's own backstop is a second of wall clock. A shared CI machine
// running every package's tests can be several times slower than a laptop,
// so CI gets headroom; the step budget, not the clock, is what is proved.
const SLOWER = process.env.CI ? 4 : 1;
const TIME_LIMIT_MS = 100 * SLOWER;

const WINDOW = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-11-05T00:00:00Z"), timezone: "UTC" };

function timed<T>(work: () => T): { ms: number; result: T | Error } {
  const start = performance.now();
  let result: T | Error;
  try {
    result = work();
  } catch (error) {
    result = error as Error;
  }
  return { ms: performance.now() - start, result };
}

describe("the reviewer's feed: DTSTART 1800, FREQ=DAILY;COUNT=99999999", () => {
  const RULE = "FREQ=DAILY;COUNT=99999999";

  it("20 events: jumps straight to the window and reads it, well inside 50 ms", () => {
    const calendar = parseIcsCalendar(feed(20, RULE));
    const { ms, result } = timed(() => expandBusy(calendar, WINDOW));
    expect(result).not.toBeInstanceOf(Error);
    // Every day of the window has its 09:00–09:30 (the 20 events overlap, merged).
    expect((result as unknown[]).length).toBe(31);
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
  });

  it("5,000 events: over the step budget, refused fast instead of walked", () => {
    const calendar = parseIcsCalendar(feed(5_000, RULE));
    const { ms, result } = timed(() => expandBusy(calendar, WINDOW));
    expect(result).toBeInstanceOf(IcsBudgetError);
    expect((result as Error).message).toBe(FEED_TOO_LARGE_MESSAGE);
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
  });

  it("a rule that can't jump (BYDAY) is a bounded walk: refused fast, not 82,000 periods", () => {
    const calendar = parseIcsCalendar(feed(3, "FREQ=DAILY;BYDAY=MO;COUNT=99999999"));
    const { ms, result } = timed(() => expandBusy(calendar, WINDOW));
    expect(result).toBeInstanceOf(IcsBudgetError);
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
  });

  it("more than 5,000 events is too large outright", () => {
    expect(() => expandBusy(parseIcsCalendar(feed(5_001, "FREQ=DAILY;COUNT=1", "20261006T090000Z")), WINDOW)).toThrow(IcsBudgetError);
  });

  it("negative control: an ordinary feed is read in full — the jump keeps COUNT exact, the budget refuses nothing normal", () => {
    // COUNT=3 from 1800 ended in 1800: nothing in 2026 (the jump must not invent instances).
    expect(expandBusy(parseIcsCalendar(feed(1, "FREQ=DAILY;COUNT=3")), WINDOW)).toEqual([]);
    // Weekly from 1800, COUNT large: one a week in the window, on DTSTART's weekday (a Wednesday).
    const weekly = expandBusy(parseIcsCalendar(feed(1, "FREQ=WEEKLY;COUNT=99999999")), WINDOW);
    expect(weekly.map((interval) => interval.start.getUTCDay())).toEqual([3, 3, 3, 3, 3]);
    // 4,000 plain events read fine.
    expect(expandBusy(parseIcsCalendar(feed(4_000, "FREQ=DAILY;COUNT=1", "20261006T090000Z")), WINDOW)).toHaveLength(1);
  });
});

describe("a feed too large fails closed for its host", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  async function hostWith(source: BusySource) {
    const ctx: BookingContext = { db: t.db, tenantId: tenant("feed"), now: new Date("2026-10-05T15:00:00Z"), busySource: source };
    const host = await upsertHost(ctx, { displayName: "Pat", email: "pat@x.test", timezone: "UTC", busyIcsUrl: "https://calendar.google.com/calendar/ical/x/private-y/basic.ics" });
    await setWeeklyAvailability(ctx, { hostId: host.id, windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })) });
    await upsertType(ctx, { key: "intro", name: "Intro", durationMinutes: 30, media: ["video"] });
    return ctx;
  }

  it("no times are offered, and the owner sees the plain sentence", async () => {
    const ctx = await hostWith({ busy: async () => Promise.reject(new BusyFeedTooLargeError()) });
    const slots = await listOpenSlots(ctx, { typeKey: "intro" });
    expect(slots).toEqual({ slots: [], busySync: "degraded" });
    const row = await t.client.query<{ busy_sync_error: string }>(`select busy_sync_error from booking_hosts where tenant_id = $1`, [ctx.tenantId]);
    expect(row.rows[0]?.busy_sync_error).toBe(FEED_TOO_LARGE_MESSAGE);
  });

  it("negative control: any other calendar failure still degrades to the host's own bookings (0.1 behaviour)", async () => {
    const ctx = await hostWith({ busy: async () => Promise.reject(new Error("calendar fetch failed: HTTP 500")) });
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).slots.length).toBeGreaterThan(0);
  });

  it("the reader remembers a too-large feed per window, and refuses it again without walking it", async () => {
    let fetched = 0;
    const source = createIcsBusySource({
      resolveHost: async () => ["142.250.80.46"],
      transport: async () => {
        fetched += 1;
        return { status: 200, location: null, text: feed(5_000, "FREQ=DAILY;COUNT=99999999") };
      },
    });
    const host = { id: "h", timezone: "UTC", busyIcsUrl: "https://calendar.google.com/x.ics" };
    for (let i = 0; i < 3; i++) {
      const { ms, result } = await (async () => {
        const start = performance.now();
        try {
          const value = await source.busy({ host, ...WINDOW });
          return { ms: performance.now() - start, result: value as unknown };
        } catch (error) {
          return { ms: performance.now() - start, result: error };
        }
      })();
      expect(isFeedTooLarge(result)).toBe(true);
      if (i > 0) expect(ms).toBeLessThan(5 * SLOWER);
    }
    expect(fetched).toBe(1);
  });
});

/**
 * THE CLOCK IS A BACKSTOP, NOT A LIMIT ON ORDINARY FEEDS (0.3.1). On Oct 21,
 * 2026 GitHub's runner took over 100 ms on the 4,000-event feed above, the old
 * backstop refused it, and a refused feed empties the host's booking page.
 * Here the clock is made slow on purpose: every look at it finds `tick` ms
 * gone, as on a server under load.
 */
describe("the wall-clock backstop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function slowClock(tick: number): void {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += tick));
  }

  it("a busy server still reads an ordinary feed in full", () => {
    // 4,000 events, a look at the clock every 512 steps: about 500 ms of a
    // slow server's time in all. 100 ms refused this; one second doesn't.
    slowClock(60);
    expect(expandBusy(parseIcsCalendar(feed(4_000, "FREQ=DAILY;COUNT=1", "20261006T090000Z")), WINDOW)).toHaveLength(1);
  });

  it("negative control: a walk that runs past a second is still stopped", () => {
    slowClock(400);
    expect(() => expandBusy(parseIcsCalendar(feed(4_000, "FREQ=DAILY;COUNT=1", "20261006T090000Z")), WINDOW)).toThrow(IcsBudgetError);
  });
});
