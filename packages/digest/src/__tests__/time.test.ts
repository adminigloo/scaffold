import { describe, expect, it } from "vitest";
import { addDays, deliveryWindow, digestDay, hourLabel, isDay, isTimeZone, localDay, zonedInstant } from "../time.js";

describe("each person's clock, from Intl alone", () => {
  it("knows a zone from a typo", () => {
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Asia/Kolkata")).toBe(true);
    expect(isTimeZone("America/Chicgo")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });

  it("reads the local day an instant falls on", () => {
    const at = new Date("2026-10-21T03:30:00Z");
    expect(localDay(at, "America/New_York")).toBe("2026-10-20");
    expect(localDay(at, "Asia/Tokyo")).toBe("2026-10-21");
    expect(localDay(at, "UTC")).toBe("2026-10-21");
  });

  it("adds days across months and years", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("only takes real calendar days", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
  });

  it("finds a local hour as an instant, in zones with half and quarter hours", () => {
    expect(zonedInstant("2026-10-21", 7, "America/New_York").toISOString()).toBe("2026-10-21T11:00:00.000Z");
    expect(zonedInstant("2026-10-21", 7, "Asia/Kolkata").toISOString()).toBe("2026-10-21T01:30:00.000Z");
    expect(zonedInstant("2026-10-21", 7, "Asia/Kathmandu").toISOString()).toBe("2026-10-21T01:15:00.000Z");
    expect(zonedInstant("2026-10-21", 0, "Pacific/Auckland").toISOString()).toBe("2026-10-20T11:00:00.000Z");
  });

  it("an hour the clocks jump over is the first moment after the jump", () => {
    // New York, 8 March 2026: 2 AM never happens; the clocks go to 3 AM EDT.
    expect(zonedInstant("2026-03-08", 2, "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(zonedInstant("2026-03-08", 3, "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
    // London, 29 March 2026: 1 AM jumps to 2 AM BST.
    expect(zonedInstant("2026-03-29", 1, "Europe/London").toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("an hour that happens twice is the first of the two", () => {
    // New York, 1 November 2026: 1 AM EDT, then 1 AM EST an hour later.
    expect(zonedInstant("2026-11-01", 1, "America/New_York").toISOString()).toBe("2026-11-01T05:00:00.000Z");
    // Lord Howe goes back half an hour (2 AM → 1:30 AM): 1 AM happens once.
    expect(zonedInstant("2026-04-05", 1, "Australia/Lord_Howe").toISOString()).toBe("2026-04-04T14:00:00.000Z");
  });

  it("the window is a person's hour today until their hour tomorrow, back to back", () => {
    const zone = "America/Chicago";
    const before = deliveryWindow(new Date("2026-10-21T11:59:00Z"), zone, 7); // 6:59 AM CDT
    const after = deliveryWindow(new Date("2026-10-21T12:00:00Z"), zone, 7); // 7:00 AM CDT
    expect(before.day).toBe("2026-10-20");
    expect(after.day).toBe("2026-10-21");
    expect(before.closesAt.getTime()).toBe(after.opensAt.getTime());
    expect(after.opensAt.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(after.closesAt.toISOString()).toBe("2026-10-22T12:00:00.000Z");
  });

  it("the window around the clocks going back is 25 hours, and its day is still one day", () => {
    const window = deliveryWindow(new Date("2026-10-31T12:00:00Z"), "America/New_York", 7);
    expect(window.day).toBe("2026-10-31");
    expect(window.closesAt.getTime() - window.opensAt.getTime()).toBe(25 * 3_600_000);
  });

  it("names the day in the person's own zone", () => {
    const day = digestDay("2026-10-21", "Asia/Tokyo");
    expect(day.label).toBe("Wednesday, October 21");
    expect(day.start.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-10-21T15:00:00.000Z");
  });

  it("writes an hour the way people say it", () => {
    expect([0, 7, 12, 13, 23].map(hourLabel)).toEqual(["12 AM", "7 AM", "12 PM", "1 PM", "11 PM"]);
  });
});
