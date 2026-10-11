import { describe, expect, it } from "vitest";
import { crewHoursLabel, scheduleRange, statusLabel, STATUS_LABELS } from "@/components/schedule/scheduleView";

/**
 * The schedule board's presentation decisions. None of them is database
 * behaviour and each is one wrong branch: a range that drops today's visits,
 * a crew that is off every day reading "08:00–17:00".
 */

describe("scheduleRange", () => {
  it("starts at today's UTC midnight, so today's visits stay on the board all day", () => {
    // Visits are stored at their day's UTC midnight. A range from "now" lost
    // them from 00:00:00.001 on the day itself.
    const afternoon = new Date("2026-10-13T14:30:00Z");
    const { from, to } = scheduleRange(afternoon);
    expect(from.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    const todaysVisit = new Date("2026-10-13T00:00:00Z");
    expect(todaysVisit.getTime()).toBeGreaterThanOrEqual(from.getTime());
  });
});

describe("statusLabel", () => {
  it("says Requested, In progress and No-show, never the raw enum", () => {
    expect(statusLabel("pending")).toBe("Requested");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("no_show")).toBe("No-show");
    for (const label of Object.values(STATUS_LABELS)) expect(label).not.toMatch(/_/);
  });
});

describe("crewHoursLabel", () => {
  const crew = { workStartTime: "08:00", workEndTime: "17:00" };

  it("a crew whose hours were never saved works Mon–Fri on its own hours", () => {
    expect(crewHoursLabel({ ...crew, hoursConfigured: false, weeklyDays: 0 })).toEqual({
      text: "08:00–17:00, Mon–Fri (default hours)",
      off: false,
    });
  });

  it("a crew saved with no days ticked is off every day, not 08:00–17:00", () => {
    expect(crewHoursLabel({ ...crew, hoursConfigured: true, weeklyDays: 0 })).toEqual({
      text: "Off every day",
      off: true,
    });
  });

  it("a crew with saved weekdays runs its week, whether or not the flag was backfilled", () => {
    for (const hoursConfigured of [true, false]) {
      expect(crewHoursLabel({ ...crew, hoursConfigured, weeklyDays: 3 }).text).toBe("Works 3 days a week");
    }
    expect(crewHoursLabel({ ...crew, hoursConfigured: true, weeklyDays: 1 }).text).toBe("Works 1 day a week");
  });
});
