import { describe, expect, it } from "vitest";
import {
  findFreeSlots,
  haversineDistance,
  minutesToTime,
  scoreSlot,
  sortScoredSlots,
  timeToMinutes,
  windowsOverlap,
  type ScoredSlot,
} from "../math.js";

describe("haversineDistance", () => {
  it("is calibrated in miles (Salt Lake City → Provo ≈ 43mi)", () => {
    const miles = haversineDistance(40.7608, -111.891, 40.2338, -111.6585);
    expect(miles).toBeGreaterThan(38);
    expect(miles).toBeLessThan(48);
  });
  it("is zero for the same point and symmetric", () => {
    expect(haversineDistance(40.76, -111.89, 40.76, -111.89)).toBe(0);
    expect(haversineDistance(40, -111, 41, -112)).toBeCloseTo(haversineDistance(41, -112, 40, -111), 6);
  });
});

describe("time helpers", () => {
  it("round-trips HH:MM ↔ minutes", () => {
    expect(timeToMinutes("08:30")).toBe(510);
    expect(minutesToTime(510)).toBe("08:30");
    expect(minutesToTime(timeToMinutes("13:05"))).toBe("13:05");
  });
});

describe("findFreeSlots", () => {
  it("an empty day is one slot from the window start", () => {
    const slots = findFreeSlots("08:00", "17:00", [], 120);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ startTime: "08:00", endTime: "10:00", previousJob: null });
  });

  it("a booking splits the day and the later slot carries the previous job", () => {
    const slots = findFreeSlots(
      "08:00",
      "17:00",
      [{ start: "10:00", end: "12:00", lat: 40.7, lng: -111.9, address: "123 Main" }],
      120,
    );
    expect(slots).toHaveLength(2);
    expect(slots[0]!.previousJob).toBeNull();
    expect(slots[1]).toMatchObject({ startTime: "12:00", endTime: "14:00" });
    expect(slots[1]!.previousJob?.address).toBe("123 Main");
  });

  it("a gap smaller than the duration yields no slot", () => {
    expect(findFreeSlots("08:00", "08:30", [], 60)).toHaveLength(0);
  });

  it("sorts unsorted bookings before walking the day", () => {
    const slots = findFreeSlots(
      "08:00",
      "17:00",
      [
        { start: "14:00", end: "15:00", lat: null, lng: null, address: "B" },
        { start: "10:00", end: "11:00", lat: null, lng: null, address: "A" },
      ],
      60,
    );
    // 08–10 (null prev), 11–12 (prev A), 15–16 (prev B) all fit a 60-min job.
    expect(slots.map((s) => s.startTime)).toEqual(["08:00", "11:00", "15:00"]);
    expect(slots[2]!.previousJob?.address).toBe("B");
  });
});

describe("scoreSlot — the drive-time differentiator", () => {
  const base = { homeBaseDriveMinutes: null, startTime: "13:00", isPreferredResource: false };

  it("starts at 100 with nothing special", () => {
    expect(scoreSlot({ ...base, driveMinutesFromPrevious: 20 })).toBe(100);
  });
  it("penalizes a long drive and rewards a short one", () => {
    expect(scoreSlot({ ...base, driveMinutesFromPrevious: 50 })).toBe(60); // >45 → −40
    expect(scoreSlot({ ...base, driveMinutesFromPrevious: 35 })).toBe(80); // >30 → −20
    expect(scoreSlot({ ...base, driveMinutesFromPrevious: 10 })).toBe(110); // <15 → +10
  });
  it("adds a morning bonus, a preferred-resource bonus, and a home-base bonus", () => {
    expect(scoreSlot({ ...base, startTime: "08:00", driveMinutesFromPrevious: 20 })).toBe(105);
    expect(scoreSlot({ ...base, isPreferredResource: true, driveMinutesFromPrevious: 20 })).toBe(120);
    expect(scoreSlot({ ...base, driveMinutesFromPrevious: null, homeBaseDriveMinutes: 10 })).toBe(115);
  });
});

describe("sortScoredSlots", () => {
  it("orders by score desc, then earliest date", () => {
    const slots: ScoredSlot[] = [
      { date: "2026-02-02", startTime: "09:00", endTime: "11:00", resourceId: "r", resourceName: "R", driveMinutesFromPrevious: null, previousJobAddress: null, score: 100 },
      { date: "2026-02-01", startTime: "09:00", endTime: "11:00", resourceId: "r", resourceName: "R", driveMinutesFromPrevious: null, previousJobAddress: null, score: 120 },
      { date: "2026-02-03", startTime: "09:00", endTime: "11:00", resourceId: "r", resourceName: "R", driveMinutesFromPrevious: null, previousJobAddress: null, score: 100 },
    ];
    expect(sortScoredSlots(slots).map((s) => `${s.score}:${s.date}`)).toEqual([
      "120:2026-02-01",
      "100:2026-02-02",
      "100:2026-02-03",
    ]);
  });
});

describe("windowsOverlap", () => {
  it("detects intersection and clears adjacency", () => {
    expect(windowsOverlap("09:00", "11:00", "10:00", "12:00")).toBe(true);
    expect(windowsOverlap("09:00", "10:00", "10:00", "11:00")).toBe(false);
  });
});
