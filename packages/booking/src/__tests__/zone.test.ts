import { describe, expect, it } from "vitest";
import {
  addDays,
  dateIn,
  dayOfWeekIn,
  eachDate,
  isValidDateString,
  isValidTimeZone,
  startOfDayIn,
  utcToZonedParts,
  zonedWallClockToUtc,
} from "../zone.js";

const iso = (date: Date) => date.toISOString();

describe("isValidTimeZone", () => {
  it("accepts IANA names", () => {
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Pacific/Chatham")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it("refuses free text, offsets and junk", () => {
    expect(isValidTimeZone("Mountain")).toBe(false);
    expect(isValidTimeZone("America/Nowhere")).toBe(false);
    expect(isValidTimeZone("+05:30")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone("a".repeat(65))).toBe(false);
  });
});

describe("isValidDateString", () => {
  it("knows real calendar dates", () => {
    expect(isValidDateString("2026-02-28")).toBe(true);
    expect(isValidDateString("2028-02-29")).toBe(true);
    expect(isValidDateString("2026-02-29")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-1-1")).toBe(false);
  });
});

describe("zonedWallClockToUtc — America/Denver spring forward (2026-03-08)", () => {
  const zone = "America/Denver";
  it("reads times before the change on MST (-7)", () => {
    expect(iso(zonedWallClockToUtc("2026-03-08", 0, zone))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(zonedWallClockToUtc("2026-03-08", 60, zone))).toBe("2026-03-08T08:00:00.000Z");
  });

  it("moves a wall time inside the gap forward by the gap (02:30 → 03:30 MDT)", () => {
    expect(iso(zonedWallClockToUtc("2026-03-08", 150, zone))).toBe("2026-03-08T09:30:00.000Z");
  });

  it("reads times after the change on MDT (-6)", () => {
    expect(iso(zonedWallClockToUtc("2026-03-08", 180, zone))).toBe("2026-03-08T09:00:00.000Z");
    expect(iso(zonedWallClockToUtc("2026-03-08", 9 * 60, zone))).toBe("2026-03-08T15:00:00.000Z");
  });

  it("is a 23-hour day", () => {
    const start = zonedWallClockToUtc("2026-03-08", 0, zone);
    const end = zonedWallClockToUtc("2026-03-08", 1440, zone);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
    expect(iso(end)).toBe(iso(startOfDayIn("2026-03-09", zone)));
  });
});

describe("zonedWallClockToUtc — America/Denver fall back (2026-11-01)", () => {
  const zone = "America/Denver";
  it("resolves the repeated 01:30 to the EARLIER instant (MDT)", () => {
    expect(iso(zonedWallClockToUtc("2026-11-01", 90, zone))).toBe("2026-11-01T07:30:00.000Z");
  });

  it("reads both 01:30s back as 01:30", () => {
    expect(utcToZonedParts(new Date("2026-11-01T07:30:00Z"), zone).minuteOfDay).toBe(90);
    expect(utcToZonedParts(new Date("2026-11-01T08:30:00Z"), zone).minuteOfDay).toBe(90);
  });

  it("reads 02:00 on MST and the day as 25 hours", () => {
    expect(iso(zonedWallClockToUtc("2026-11-01", 120, zone))).toBe("2026-11-01T09:00:00.000Z");
    const start = zonedWallClockToUtc("2026-11-01", 0, zone);
    const end = zonedWallClockToUtc("2026-11-01", 1440, zone);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("half- and quarter-hour offsets", () => {
  it("Asia/Kolkata is +05:30 all year", () => {
    expect(iso(zonedWallClockToUtc("2026-10-05", 9 * 60, "Asia/Kolkata"))).toBe("2026-10-05T03:30:00.000Z");
    expect(iso(zonedWallClockToUtc("2026-01-15", 0, "Asia/Kolkata"))).toBe("2026-01-14T18:30:00.000Z");
    const parts = utcToZonedParts(new Date("2026-10-04T19:00:00Z"), "Asia/Kolkata");
    expect(parts.date).toBe("2026-10-05");
    expect(parts.minuteOfDay).toBe(30);
  });

  it("Pacific/Chatham is +12:45 in winter and +13:45 in summer", () => {
    // July: standard time.
    expect(iso(zonedWallClockToUtc("2026-07-06", 9 * 60, "Pacific/Chatham"))).toBe("2026-07-05T20:15:00.000Z");
    // October: daylight time (from the last Sunday of September).
    expect(iso(zonedWallClockToUtc("2026-10-05", 9 * 60, "Pacific/Chatham"))).toBe("2026-10-04T19:15:00.000Z");
  });

  it("round-trips every quarter hour of a Chatham day", () => {
    for (let minute = 0; minute < 1440; minute += 15) {
      const instant = zonedWallClockToUtc("2026-10-05", minute, "Pacific/Chatham");
      const back = utcToZonedParts(instant, "Pacific/Chatham");
      expect(back.date).toBe("2026-10-05");
      expect(back.minuteOfDay).toBe(minute);
    }
  });
});

describe("dates", () => {
  it("dayOfWeekIn: a calendar date's weekday is zone-independent; an instant's is not", () => {
    expect(dayOfWeekIn("2026-03-08", "America/Denver")).toBe(0);
    expect(dayOfWeekIn("2026-03-08", "Asia/Kolkata")).toBe(0);
    // Tuesday 22:30 in Denver is Wednesday in Kolkata.
    const instant = new Date("2026-10-07T04:30:00Z");
    expect(dayOfWeekIn(instant, "America/Denver")).toBe(2);
    expect(dayOfWeekIn(instant, "Asia/Kolkata")).toBe(3);
  });

  it("addDays and eachDate walk calendar days, across month ends and DST", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(eachDate("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(eachDate("2026-11-02", "2026-10-30")).toEqual([]);
  });

  it("dateIn reads the zone's calendar day", () => {
    expect(dateIn(new Date("2026-10-06T03:00:00Z"), "America/Denver")).toBe("2026-10-05");
    expect(dateIn(new Date("2026-10-06T03:00:00Z"), "UTC")).toBe("2026-10-06");
  });
});
