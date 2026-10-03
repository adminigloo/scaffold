import { describe, expect, it } from "vitest";
import {
  generateSlots,
  horizonEnd,
  mergeRanges,
  pickHost,
  resolveWindows,
  subtractRanges,
  unionSlots,
  windowsByDateFor,
  type BusyInterval,
  type DateException,
  type MinuteRange,
  type SlotRules,
  type WeeklyWindow,
} from "../engine.js";

const DENVER = "America/Denver";
const host = { id: "h1", timezone: DENVER };
/** Monday–Friday, 09:00–17:00. */
const WEEK: WeeklyWindow[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 }));
const MONDAY = "2026-10-05";

const rules = (overrides: Partial<SlotRules> = {}): SlotRules => ({
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  stepMinutes: 30,
  minNoticeMinutes: 0,
  horizonDays: 21,
  maxPerDay: null,
  ...overrides,
});

/** Slots on one Denver date, as "HH:MM" wall clock. */
function slotsOn(
  date: string,
  windows: MinuteRange[],
  type: SlotRules,
  extra: { busy?: Array<{ start: string; end: string }>; now?: string; counts?: number } = {},
): string[] {
  const now = new Date(extra.now ?? "2026-10-01T00:00:00Z");
  const slots = generateSlots({
    host,
    type,
    windowsByDate: new Map([[date, windows]]),
    busy: (extra.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
    bookedCountByDate: new Map(extra.counts === undefined ? [] : [[date, extra.counts]]),
    now,
    from: now,
    to: new Date("2026-12-31T00:00:00Z"),
  });
  return slots.map((slot) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: DENVER, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.start),
  );
}

describe("ranges", () => {
  it("merges overlapping and touching ranges", () => {
    expect(mergeRanges([[660, 900], [540, 720], [900, 960], [1000, 1000]])).toEqual([[540, 960]]);
  });

  it("subtracts blocks, splitting a window around a part-day block", () => {
    expect(subtractRanges([[540, 1020]], [[720, 780]])).toEqual([[540, 720], [780, 1020]]);
    expect(subtractRanges([[540, 1020]], [[500, 600], [1000, 1100]])).toEqual([[600, 1000]]);
    expect(subtractRanges([[540, 600]], [[540, 600]])).toEqual([]);
  });
});

describe("resolveWindows — the precedence", () => {
  const ex = (kind: DateException["kind"], start: number | null = null, end: number | null = null): DateException => ({
    date: MONDAY,
    kind,
    startMinute: start,
    endMinute: end,
  });

  it("uses the weekly windows for the weekday", () => {
    expect(resolveWindows(MONDAY, WEEK, [], [])).toEqual([[540, 1020]]);
    expect(resolveWindows("2026-10-04", WEEK, [], [])).toEqual([]); // Sunday: nothing entered, nothing bookable
  });

  it("a tenant blackout empties the day", () => {
    expect(resolveWindows(MONDAY, WEEK, [], [MONDAY])).toEqual([]);
    expect(resolveWindows(MONDAY, WEEK, [], [{ date: MONDAY }])).toEqual([]);
  });

  it("'off' wins over everything", () => {
    expect(resolveWindows(MONDAY, WEEK, [ex("hours", 600, 700), ex("off")], [])).toEqual([]);
  });

  it("'hours' REPLACE the weekly windows", () => {
    expect(resolveWindows(MONDAY, WEEK, [ex("hours", 600, 720), ex("hours", 840, 900)], [])).toEqual([
      [600, 720],
      [840, 900],
    ]);
    // …including on a day with no weekly hours at all.
    expect(resolveWindows("2026-10-04", WEEK, [{ ...ex("hours", 600, 660), date: "2026-10-04" }], [])).toEqual([[600, 660]]);
  });

  it("'block' rows are subtracted from whichever base applies", () => {
    expect(resolveWindows(MONDAY, WEEK, [ex("block", 720, 840)], [])).toEqual([[540, 720], [840, 1020]]);
    expect(resolveWindows(MONDAY, WEEK, [ex("hours", 600, 720), ex("block", 660, 690)], [])).toEqual([
      [600, 660],
      [690, 720],
    ]);
  });

  it("ignores exceptions for other dates and merges overlapping weekly windows", () => {
    const overlapping: WeeklyWindow[] = [
      { dayOfWeek: 1, startMinute: 540, endMinute: 720 },
      { dayOfWeek: 1, startMinute: 660, endMinute: 900 },
    ];
    expect(resolveWindows(MONDAY, overlapping, [{ ...ex("off"), date: "2026-10-06" }], [])).toEqual([[540, 900]]);
  });

  it("windowsByDateFor maps every date", () => {
    const map = windowsByDateFor(["2026-10-04", MONDAY], WEEK, [], []);
    expect(map.get("2026-10-04")).toEqual([]);
    expect(map.get(MONDAY)).toEqual([[540, 1020]]);
  });
});

describe("generateSlots", () => {
  it("lays the grid from the WINDOW start, not the top of the hour", () => {
    expect(slotsOn(MONDAY, [[555, 720]], rules())).toEqual(["09:15", "09:45", "10:15", "10:45", "11:15"]);
  });

  it("offers overlapping starts when the step is shorter than the meeting", () => {
    expect(slotsOn(MONDAY, [[540, 630]], rules({ durationMinutes: 60, stepMinutes: 15 }))).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("fits only the MEETING inside the window; buffers may hang outside it", () => {
    const type = rules({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    // 09:00's lead-in starts at 08:45 and 16:30's write-up ends at 17:15 —
    // clear time between calls, not hours the host promised, so both stand.
    expect(slotsOn(MONDAY, [[540, 1020]], type)).toEqual([
      "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
      "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
    ]);
    // …but the meeting itself never runs past the window.
    expect(slotsOn(MONDAY, [[540, 600]], rules({ durationMinutes: 45, stepMinutes: 15, bufferAfterMinutes: 30 }))).toEqual(["09:00", "09:15"]);
  });

  it("subtracts busy intervals; touching is fine, overlapping is not", () => {
    const busy = [{ start: "2026-10-05T16:00:00Z", end: "2026-10-05T16:30:00Z" }]; // 10:00–10:30 MDT
    expect(slotsOn(MONDAY, [[540, 690]], rules(), { busy })).toEqual(["09:00", "09:30", "10:30", "11:00"]);
  });

  it("pads the candidate by its own buffers against an event that asks for none", () => {
    const busy = [{ start: "2026-10-05T16:00:00Z", end: "2026-10-05T16:30:00Z" }];
    // A 15-minute after-buffer means 09:30 (ends 10:00, clear until 10:15)
    // collides; 11:00's write-up runs past the window's 11:30 end, which is fine.
    expect(slotsOn(MONDAY, [[540, 690]], rules({ bufferAfterMinutes: 15 }), { busy })).toEqual(["09:00", "10:30", "11:00"]);
  });

  it("buffers still pad against busy time across the window's edge", () => {
    // A calendar event 08:30–08:55 MDT, before the host's hours begin.
    const busy = [{ start: "2026-10-05T14:30:00Z", end: "2026-10-05T14:55:00Z" }];
    // 09:00 would leave five minutes of a fifteen-minute lead-in.
    expect(slotsOn(MONDAY, [[540, 600]], rules({ stepMinutes: 15, bufferBeforeMinutes: 15 }), { busy })).toEqual([
      "09:15",
      "09:30",
    ]);
  });

  it("enforces minimum notice on the instant", () => {
    // now = Monday 09:00 MDT, four hours' notice → first start 13:00.
    const out = slotsOn(MONDAY, [[540, 1020]], rules({ minNoticeMinutes: 240 }), { now: "2026-10-05T15:00:00Z" });
    expect(out[0]).toBe("13:00");
    expect(out).toHaveLength(8);
  });

  it("enforces the horizon in whole host-zone days", () => {
    const now = new Date("2026-10-05T16:00:00Z"); // 10:00 MDT
    const windowsByDate = new Map<string, MinuteRange[]>(
      ["2026-10-05", "2026-10-06", "2026-10-07"].map((date) => [date, [[540, 600]]]),
    );
    const slots = generateSlots({
      host,
      type: rules({ horizonDays: 2 }),
      windowsByDate,
      busy: [],
      now,
      from: now,
      to: new Date("2026-12-31T00:00:00Z"),
    });
    // Today's 09:00 has passed; tomorrow's two remain; the third day is past the horizon.
    expect(slots.map((slot) => slot.start.toISOString())).toEqual(["2026-10-06T15:00:00.000Z", "2026-10-06T15:30:00.000Z"]);
    expect(horizonEnd(now, DENVER, 2).toISOString()).toBe("2026-10-07T06:00:00.000Z");
  });

  it("respects from (inclusive) and to (exclusive)", () => {
    const slots = generateSlots({
      host,
      type: rules(),
      windowsByDate: new Map([[MONDAY, [[540, 1020]] as MinuteRange[]]]),
      busy: [],
      now: new Date("2026-10-01T00:00:00Z"),
      from: new Date("2026-10-05T16:00:00Z"),
      to: new Date("2026-10-05T17:00:00Z"),
    });
    expect(slots.map((slot) => slot.start.toISOString())).toEqual(["2026-10-05T16:00:00.000Z", "2026-10-05T16:30:00.000Z"]);
  });

  it("skips a day that has reached maxPerDay", () => {
    expect(slotsOn(MONDAY, [[540, 600]], rules({ maxPerDay: 2 }), { counts: 2 })).toEqual([]);
    expect(slotsOn(MONDAY, [[540, 600]], rules({ maxPerDay: 2 }), { counts: 1 })).toEqual(["09:00", "09:30"]);
  });

  it("lays a DST day in real instants: spring forward has four real hours in 00:00–05:00", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const slots = generateSlots({
      host,
      type: rules({ durationMinutes: 60, stepMinutes: 60 }),
      windowsByDate: new Map([["2026-03-08", [[0, 300]] as MinuteRange[]]]),
      busy: [],
      now,
      from: now,
      to: new Date("2026-04-01T00:00:00Z"),
    });
    expect(slots.map((slot) => slot.start.toISOString())).toEqual([
      "2026-03-08T07:00:00.000Z", // 00:00 MST
      "2026-03-08T08:00:00.000Z", // 01:00 MST
      "2026-03-08T09:00:00.000Z", // 03:00 MDT
      "2026-03-08T10:00:00.000Z", // 04:00 MDT
    ]);
  });

  it("…and fall back has six, every one a distinct instant", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    const slots = generateSlots({
      host,
      type: rules({ durationMinutes: 60, stepMinutes: 60 }),
      windowsByDate: new Map([["2026-11-01", [[0, 300]] as MinuteRange[]]]),
      busy: [],
      now,
      from: now,
      to: new Date("2026-12-01T00:00:00Z"),
    });
    expect(slots).toHaveLength(6);
    expect(new Set(slots.map((slot) => slot.start.getTime())).size).toBe(6);
    expect(slots[0]?.start.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(slots[5]?.start.toISOString()).toBe("2026-11-01T11:00:00.000Z");
  });

  it("returns nothing for a zero duration or step", () => {
    expect(slotsOn(MONDAY, [[540, 1020]], rules({ durationMinutes: 0 }))).toEqual([]);
    expect(slotsOn(MONDAY, [[540, 1020]], rules({ stepMinutes: 0 }))).toEqual([]);
  });
});

describe("two parties, one gap (Squire's test-log D17)", () => {
  const occupant = (
    start: string,
    end: string,
    buffers: { bufferBeforeMinutes?: number; bufferAfterMinutes?: number } = {},
  ): BusyInterval => ({ start: new Date(start), end: new Date(end), ...buffers });

  /** Starts on Monday's Denver wall clock for one window, busy given as BusyIntervals. */
  function startsAround(window: MinuteRange, type: SlotRules, busy: BusyInterval[]): string[] {
    const now = new Date("2026-10-01T00:00:00Z");
    return generateSlots({
      host,
      type,
      windowsByDate: new Map([[MONDAY, [window]]]),
      busy,
      now,
      from: now,
      to: new Date("2026-12-31T00:00:00Z"),
    }).map((slot) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: DENVER, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.start),
    );
  }

  it("the larger of the two buffers wins at a gap; they do not add", () => {
    // A 10:00–10:30 call that wants 30 minutes of write-up after it.
    const call = occupant("2026-10-05T16:00:00Z", "2026-10-05T16:30:00Z", { bufferAfterMinutes: 30 });
    const free = startsAround([540, 720], rules({ stepMinutes: 15, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }), [call]);
    // After it: max(its 30, our 15) = 30 clear → 11:00, not the 11:15 that 30 + 15 would demand.
    expect(free).toContain("11:00");
    expect(free).not.toContain("10:45");
    // Before it: max(our 15 write-up, its 0 lead-in) = 15 → 09:15 ends 09:45, the last that fits.
    expect(free).toContain("09:15");
    expect(free).not.toContain("09:30");
    expect(free).toEqual(["09:00", "09:15", "11:00", "11:15", "11:30"]);
  });

  it("the occupant's lead-in protects it from a candidate placed before it", () => {
    // A 13:00–14:00 call that wants 30 minutes of preparation before it.
    const call = occupant("2026-10-05T19:00:00Z", "2026-10-05T20:00:00Z", { bufferBeforeMinutes: 30 });
    const free = startsAround([660, 900], rules({ stepMinutes: 15 }), [call]);
    expect(free).toContain("12:00"); // ends 12:30: exactly 30 clear
    expect(free).not.toContain("12:15");
    expect(free).toContain("14:00"); // no write-up asked for: a zero-buffer call may follow at once
  });

  it("the candidate's own buffer wins when it is the larger", () => {
    const call = occupant("2026-10-05T19:00:00Z", "2026-10-05T20:00:00Z", { bufferBeforeMinutes: 5, bufferAfterMinutes: 5 });
    const free = startsAround([660, 900], rules({ stepMinutes: 15, bufferBeforeMinutes: 30, bufferAfterMinutes: 30 }), [call]);
    expect(free).toContain("12:00");
    expect(free).not.toContain("12:15");
    expect(free).toContain("14:30");
    expect(free).not.toContain("14:15");
  });

  it("an interval with no buffer fields asks for none — the pre-D17 behaviour for external events", () => {
    const event = occupant("2026-10-05T19:00:00Z", "2026-10-05T20:00:00Z");
    expect(startsAround([720, 900], rules(), [event])).toEqual(["12:00", "12:30", "14:00", "14:30"]);
  });
});

describe("assignment and union", () => {
  it("pickHost: fewest upcoming wins, ties to the lowest id", () => {
    expect(pickHost([{ hostId: "b", upcoming: 2 }, { hostId: "a", upcoming: 3 }, { hostId: "c", upcoming: 2 }])).toBe("b");
    expect(pickHost([{ hostId: "z", upcoming: 0 }, { hostId: "m", upcoming: 0 }])).toBe("m");
    expect(pickHost([])).toBeNull();
  });

  it("unionSlots collapses the same time across hosts", () => {
    const at = (iso: string, hostId: string) => ({ hostId, start: new Date(iso), end: new Date(new Date(iso).getTime() + 1_800_000) });
    const out = unionSlots([at("2026-10-05T16:00:00Z", "a"), at("2026-10-05T15:00:00Z", "b"), at("2026-10-05T16:00:00Z", "b")]);
    expect(out.map((slot) => slot.start.toISOString())).toEqual(["2026-10-05T15:00:00.000Z", "2026-10-05T16:00:00.000Z"]);
  });
});
