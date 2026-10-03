import { describe, expect, it } from "vitest";
import {
  addDays,
  buildDateStrip,
  chooseDay,
  daysBetween,
  formatCountdown,
  formatDuration,
  formatLongDate,
  formatTime,
  formatUtcOffset,
  formatWhen,
  groupByPartOfDay,
  groupSlotsByDay,
  holdAnnouncement,
  holdDeadline,
  HOLD_MS,
  horizonEndMs,
  isValidTimeZone,
  lastBookableDay,
  listTimeZones,
  localizeSlot,
  mayHaveLaterSlots,
  partOfDay,
  resolveInitialZone,
  sameInstant,
  slotWindow,
  startOfDateIn,
  stripStartDay,
  timeLabels,
  zoneAbbreviation,
  zoneCity,
  zoneDisplayName,
  zonedParts,
  zoneOffsetMinutes,
  zoneOptionLabel,
  zoneRegion,
} from "../time.js";

/** ICU 72+ puts a narrow no-break space before AM/PM; compare on plain spaces. */
const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");

const slot = (start: string, minutes = 30) => ({
  start,
  end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
});

describe("zones", () => {
  it("knows real zones and rejects made-up ones", () => {
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("opens in the prop's zone, else the browser's, else the host's — skipping bad ones", () => {
    expect(resolveInitialZone("Asia/Tokyo", "America/Chicago", "America/Denver")).toBe("Asia/Tokyo");
    expect(resolveInitialZone("Not/AZone", "America/Chicago", "America/Denver")).toBe("America/Chicago");
    expect(resolveInitialZone(undefined, "", "America/Denver")).toBe("America/Denver");
    expect(resolveInitialZone(undefined, "nope", undefined)).toBe("UTC");
  });

  it("lists the runtime's zones plus the ones it must include, without duplicates", () => {
    const zones = listTimeZones(["America/Denver", "America/Denver"]);
    expect(zones).toContain("America/Denver");
    expect(zones.filter((zone) => zone === "America/Denver")).toHaveLength(1);
    expect(zones.length).toBeGreaterThan(20);
  });

  it("names zones the way people read them", () => {
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCity("UTC")).toBe("UTC");
    expect(zoneRegion("Europe/Paris")).toBe("Europe");
    expect(zoneRegion("UTC")).toBe("Other");
  });

  it("formats offsets with a real minus sign and half hours", () => {
    expect(formatUtcOffset(-360)).toBe("UTC−6");
    expect(formatUtcOffset(330)).toBe("UTC+5:30");
    expect(formatUtcOffset(-570)).toBe("UTC−9:30");
    expect(formatUtcOffset(0)).toBe("UTC");
  });

  it("computes offsets from the wall clock, across DST", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/Denver")).toBe(-420);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/Denver")).toBe(-360);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(330);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:34.567Z"), "UTC")).toBe(0);
    expect(zoneOptionLabel("America/Denver", new Date("2026-01-15T12:00:00Z"))).toBe("Denver (UTC−7)");
    expect(zoneOptionLabel("America/Denver", new Date("2026-07-15T12:00:00Z"))).toBe("Denver (UTC−6)");
  });

  it("gives a display name that always mentions the city", () => {
    const name = zoneDisplayName("America/Denver", new Date("2026-07-15T12:00:00Z"));
    expect(name).toContain("Denver");
    expect(zoneDisplayName("UTC", new Date("2026-07-15T12:00:00Z")).length).toBeGreaterThan(0);
  });
});

describe("instants on a zone's clock", () => {
  it("cuts the date and minute in the viewer's zone", () => {
    const instant = new Date("2026-10-07T04:30:00Z");
    expect(zonedParts(instant, "America/Denver")).toEqual({ date: "2026-10-06", minuteOfDay: 22 * 60 + 30 });
    expect(zonedParts(instant, "America/New_York")).toEqual({ date: "2026-10-07", minuteOfDay: 30 });
    expect(zonedParts(instant, "Asia/Kolkata")).toEqual({ date: "2026-10-07", minuteOfDay: 10 * 60 });
  });

  it("files a midnight slot under the new day, not as hour 24 of the old one", () => {
    expect(zonedParts(new Date("2026-10-07T04:00:00Z"), "America/New_York")).toEqual({
      date: "2026-10-07",
      minuteOfDay: 0,
    });
  });

  it("is right on the spring-forward day", () => {
    // US clocks jump 02:00 → 03:00 MDT on 2026-03-08 (09:00 UTC in Denver).
    expect(zonedParts(new Date("2026-03-08T08:30:00Z"), "America/Denver")).toEqual({
      date: "2026-03-08",
      minuteOfDay: 90,
    });
    expect(zonedParts(new Date("2026-03-08T09:30:00Z"), "America/Denver")).toEqual({
      date: "2026-03-08",
      minuteOfDay: 210,
    });
  });

  it("tells the two 1:30 AMs of the fall-back day apart by zone name", () => {
    const first = new Date("2026-11-01T07:30:00Z");
    const second = new Date("2026-11-01T08:30:00Z");
    expect(zonedParts(first, "America/Denver").minuteOfDay).toBe(90);
    expect(zonedParts(second, "America/Denver").minuteOfDay).toBe(90);
    expect(zoneOffsetMinutes(first, "America/Denver")).toBe(-360);
    expect(zoneOffsetMinutes(second, "America/Denver")).toBe(-420);
    expect(zoneAbbreviation("America/Denver", first)).toBe("MDT");
    expect(zoneAbbreviation("America/Denver", second)).toBe("MST");
  });

  it("formats times and dates for people", () => {
    const instant = new Date("2026-10-06T15:30:00Z");
    expect(plain(formatTime(instant, "America/Denver"))).toBe("9:30 AM");
    expect(plain(formatTime(instant, "Europe/London"))).toBe("4:30 PM");
    expect(formatLongDate("2026-10-06")).toBe("Tuesday, October 6");
    expect(plain(formatWhen(instant, "America/Denver"))).toBe("Tuesday, October 6 at 9:30 AM");
    // Same instant, Tokyo: past midnight, so the next day.
    expect(plain(formatWhen(instant, "Asia/Tokyo"))).toBe("Wednesday, October 7 at 12:30 AM");
  });

  it("formats durations", () => {
    expect(formatDuration(1)).toBe("1 minute");
    expect(formatDuration(30)).toBe("30 minutes");
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("1 hour 30 minutes");
    expect(formatDuration(120)).toBe("2 hours");
  });

  it("compares instants, not spellings", () => {
    expect(sameInstant("2026-10-06T15:00:00Z", "2026-10-06T15:00:00.000Z")).toBe(true);
    expect(sameInstant("2026-10-06T15:00:00Z", "2026-10-06T09:00:00-06:00")).toBe(true);
    expect(sameInstant("2026-10-06T15:00:00Z", "2026-10-06T15:30:00Z")).toBe(false);
    expect(sameInstant(null, "2026-10-06T15:00:00Z")).toBe(false);
    expect(sameInstant("garbage", "garbage")).toBe(false);
  });
});

describe("grouping", () => {
  it("splits the day at noon and 5 PM", () => {
    expect(partOfDay(0)).toBe("morning");
    expect(partOfDay(11 * 60 + 59)).toBe("morning");
    expect(partOfDay(12 * 60)).toBe("afternoon");
    expect(partOfDay(16 * 60 + 59)).toBe("afternoon");
    expect(partOfDay(17 * 60)).toBe("evening");
    expect(partOfDay(23 * 60 + 59)).toBe("evening");
  });

  it("re-cuts slots into the VIEWER's days: a late Denver slot is next-morning in New York", () => {
    const slots = [slot("2026-10-06T15:00:00Z"), slot("2026-10-07T04:30:00Z")];
    const denver = groupSlotsByDay(slots, "America/Denver");
    expect(denver.map((day) => day.date)).toEqual(["2026-10-06"]);
    expect(denver[0]!.slots.map((s) => s.part)).toEqual(["morning", "evening"]);

    const newYork = groupSlotsByDay(slots, "America/New_York");
    expect(newYork.map((day) => day.date)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(newYork[1]!.slots[0]!.part).toBe("morning");
    expect(newYork[1]!.slots[0]!.minuteOfDay).toBe(30);
  });

  it("sorts, and drops the same instant listed twice (a multi-host union)", () => {
    const days = groupSlotsByDay(
      [slot("2026-10-06T18:00:00Z"), slot("2026-10-06T15:00:00Z"), slot("2026-10-06T15:00:00.000Z"), { start: "nope", end: "nope" }],
      "UTC",
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.slots.map((s) => s.start)).toEqual(["2026-10-06T15:00:00Z", "2026-10-06T18:00:00Z"]);
  });

  it("groups a day into Morning / Afternoon / Evening, in order, skipping empty parts", () => {
    const local = ["2026-10-06T19:00:00Z", "2026-10-06T08:00:00Z", "2026-10-06T09:30:00Z"].map((start) =>
      localizeSlot(slot(start), "UTC"),
    );
    const groups = groupByPartOfDay(local);
    expect(groups.map((g) => [g.label, g.slots.length])).toEqual([
      ["Morning", 2],
      ["Evening", 1],
    ]);
  });
});

describe("the date strip", () => {
  const day = (date: string, count: number) => ({
    date,
    slots: Array.from({ length: count }, (_, i) => localizeSlot(slot(`${date}T1${i}:00:00Z`), "UTC")),
  });

  it("runs from today to the last bookable day, showing empty days as zero", () => {
    const strip = buildDateStrip([day("2026-10-06", 1), day("2026-10-09", 2)], "2026-10-05", 1);
    expect(strip.map((d) => [d.date, d.count])).toEqual([
      ["2026-10-05", 0],
      ["2026-10-06", 1],
      ["2026-10-07", 0],
      ["2026-10-08", 0],
      ["2026-10-09", 2],
    ]);
  });

  it("is at least a week long", () => {
    const strip = buildDateStrip([day("2026-10-06", 1)], "2026-10-05");
    expect(strip).toHaveLength(7);
    expect(strip[6]!.date).toBe("2026-10-11");
    expect(buildDateStrip([], "2026-12-30").map((d) => d.date)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
      "2027-01-04",
      "2027-01-05",
    ]);
  });

  it("with a known last day, runs exactly to it — no padding past the horizon", () => {
    const strip = buildDateStrip([day("2026-10-06", 1)], "2026-10-05", 7, "2026-10-07");
    expect(strip.map((d) => [d.date, d.count])).toEqual([
      ["2026-10-05", 0],
      ["2026-10-06", 1],
      ["2026-10-07", 0],
    ]);
    // A time that lands after it (a pool host elsewhere) still gets its tile.
    expect(buildDateStrip([day("2026-10-09", 1)], "2026-10-05", 7, "2026-10-07").at(-1)!.date).toBe("2026-10-09");
    // A long horizon is a long strip, empty days and all.
    expect(buildDateStrip([day("2026-10-06", 1)], "2026-10-05", 7, "2026-11-03")).toHaveLength(30);
  });

  it("starts at the first day with a time: no run of dead tiles up front", () => {
    // A Friday with a day's notice: today, Saturday and Sunday have nothing.
    const days = [day("2026-10-12", 2), day("2026-10-14", 1)];
    expect(stripStartDay(days, "2026-10-09")).toBe("2026-10-12");
    const strip = buildDateStrip(days, stripStartDay(days, "2026-10-09"), 1);
    expect(strip.map((d) => [d.date, d.count])).toEqual([
      ["2026-10-12", 2],
      ["2026-10-13", 0], // a closed day BETWEEN open ones stays, dimmed
      ["2026-10-14", 1],
    ]);
    // Times today: today. No times at all: today (the strip is an empty week).
    expect(stripStartDay([day("2026-10-09", 1)], "2026-10-09")).toBe("2026-10-09");
    expect(stripStartDay([], "2026-10-09")).toBe("2026-10-09");
  });

  it("labels the repeated hour of a fall-back night with its zone, and nothing else", () => {
    // Denver, 2026-11-01: 07:30Z = 1:30 AM MDT, 08:30Z = 1:30 AM MST.
    const slots = [slot("2026-11-01T07:00:00Z"), slot("2026-11-01T07:30:00Z"), slot("2026-11-01T08:30:00Z"), slot("2026-11-01T16:00:00Z")];
    const labels = timeLabels(slots, "America/Denver");
    expect(plain(labels.get("2026-11-01T07:00:00Z")!)).toBe("1:00 AM");
    expect(plain(labels.get("2026-11-01T07:30:00Z")!)).toBe("1:30 AM MDT");
    expect(plain(labels.get("2026-11-01T08:30:00Z")!)).toBe("1:30 AM MST");
    expect(plain(labels.get("2026-11-01T16:00:00Z")!)).toBe("9:00 AM");
    // Negative control: an ordinary day gets no zone names at all.
    const ordinary = timeLabels([slot("2026-10-06T15:00:00Z"), slot("2026-10-06T15:30:00Z")], "America/Denver");
    expect([...ordinary.values()].map(plain)).toEqual(["9:00 AM", "9:30 AM"]);
  });

  it("opens the chosen day, else the picked time's day, else the first", () => {
    const days = [day("2026-10-06", 1), day("2026-10-09", 1)];
    expect(chooseDay(days, "2026-10-09", null, "UTC")).toBe("2026-10-09");
    expect(chooseDay(days, "2026-10-07", "2026-10-09T10:00:00Z", "UTC")).toBe("2026-10-09");
    expect(chooseDay(days, null, null, "UTC")).toBe("2026-10-06");
    expect(chooseDay([], null, null, "UTC")).toBeNull();
  });

  it("does calendar arithmetic across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-05", "2026-10-09")).toBe(4);
    // A DST change inside the span does not make a day 23 hours short.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });
});

describe("the horizon", () => {
  it("finds a date's midnight in a zone, across DST changes", () => {
    expect(new Date(startOfDateIn("2026-10-06", "America/Denver")).toISOString()).toBe("2026-10-06T06:00:00.000Z");
    // Spring forward happens at 02:00, so midnight that day is still MST.
    expect(new Date(startOfDateIn("2026-03-08", "America/Denver")).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    // Fall back happens at 02:00, so midnight that day is still MDT.
    expect(new Date(startOfDateIn("2026-11-01", "America/Denver")).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(new Date(startOfDateIn("2026-10-06", "Asia/Kolkata")).toISOString()).toBe("2026-10-05T18:30:00.000Z");
  });

  it("ends where the server's engine stops: host-zone midnight, horizon days after the host's today", () => {
    const now = Date.parse("2026-10-05T16:00:00Z"); // 10:00 Monday in Denver
    expect(new Date(horizonEndMs(now, 2, "America/Denver")).toISOString()).toBe("2026-10-07T06:00:00.000Z");
    // Late evening in Denver is already tomorrow in UTC — the host's day is what counts.
    expect(new Date(horizonEndMs(Date.parse("2026-10-06T04:30:00Z"), 1, "America/Denver")).toISOString()).toBe(
      "2026-10-06T06:00:00.000Z",
    );
  });

  it("names the last bookable date on the VIEWER's clock", () => {
    const now = Date.parse("2026-10-05T16:00:00Z");
    expect(lastBookableDay(now, 2, "America/Denver", "America/Denver")).toBe("2026-10-06");
    // Denver's midnight is 2 AM in New York: that short last day is bookable there.
    expect(lastBookableDay(now, 2, "America/Denver", "America/New_York")).toBe("2026-10-07");
    expect(lastBookableDay(now, 2, "America/Denver", "Pacific/Honolulu")).toBe("2026-10-06");
  });
});

describe("fetch windows", () => {
  it("cuts 30-day windows end to end", () => {
    const origin = Date.parse("2026-10-01T00:00:00Z");
    expect(slotWindow(origin, 0)).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" });
    expect(slotWindow(origin, 1).from).toBe("2026-10-31T00:00:00.000Z");
  });

  it("offers later dates only when times run up to the window's edge", () => {
    const end = "2026-10-31T00:00:00.000Z";
    expect(mayHaveLaterSlots([slot("2026-10-30T15:00:00Z")], end)).toBe(true);
    expect(mayHaveLaterSlots([slot("2026-10-21T15:00:00Z")], end)).toBe(false);
    expect(mayHaveLaterSlots([], end)).toBe(false);
  });
});

describe("the hold countdown", () => {
  const received = Date.parse("2026-10-06T15:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  it("uses the server's expiry as a duration from when the answer arrived", () => {
    expect(holdDeadline(iso(received + HOLD_MS), received)).toBe(received + HOLD_MS);
    // A browser a few seconds out still gets the server's number.
    expect(holdDeadline(iso(received + 570_000), received)).toBe(received + 570_000);
  });

  it("falls back to the nominal ten minutes when the browser's clock is badly off", () => {
    // Browser 20 minutes slow: the expiry looks 30 minutes away.
    expect(holdDeadline(iso(received + 30 * 60_000), received)).toBe(received + HOLD_MS);
    // Browser 15 minutes fast: the expiry looks like it already passed.
    expect(holdDeadline(iso(received - 5 * 60_000), received)).toBe(received + HOLD_MS);
    expect(holdDeadline("not a date", received)).toBe(received + HOLD_MS);
  });

  it("shows minutes and seconds, never negative", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(999)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("announces only at a few thresholds", () => {
    const said = new Set([600_000, 400_000, 300_000, 200_000, 120_000, 90_000, 60_000, 1_000, 0].map(holdAnnouncement));
    expect(said.size).toBe(5);
    expect(holdAnnouncement(600_000)).toBe(holdAnnouncement(301_000));
    expect(holdAnnouncement(300_000)).toMatch(/5 minutes/);
    expect(holdAnnouncement(120_000)).toMatch(/2 minutes/);
    expect(holdAnnouncement(30_000)).toMatch(/Less than a minute/);
    expect(holdAnnouncement(0)).toMatch(/run out/);
  });
});
