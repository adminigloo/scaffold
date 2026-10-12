import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  addTimeOff,
  bookVisit,
  createResource,
  findPublicSlots,
  getAvailabilitySummary,
  listAvailability,
  removeTimeOff,
  resolveDayWindow,
  resolveDayWindows,
  setAvailability,
  setBookingStatus,
  validateBookingSlot,
  type AvailabilityRow,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Hours as a business has them: a split shift, a weekly edit that doesn't
 * erase the days off, time off by date range with a warning about the visits
 * already booked, and what a never-configured crew actually works.
 */

const NOW = new Date("2026-03-02T09:00:00Z"); // Monday
const WED = "2026-03-04";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const split = [3, 4].flatMap((dayOfWeek) => [
  { dayOfWeek, startTime: "08:00", endTime: "12:00" },
  { dayOfWeek, startTime: "13:00", endTime: "17:00" },
]);

describe("several windows a day", () => {
  it("resolveDayWindows sorts and merges, a dated day off wins, special hours replace the week", () => {
    const row = (overrides: Partial<AvailabilityRow>): AvailabilityRow =>
      ({
        id: "r",
        tenantId: "t",
        resourceId: "c",
        dayOfWeek: null,
        specificDate: null,
        startTime: "08:00",
        endTime: "17:00",
        isAvailable: true,
        note: null,
        createdAt: NOW,
        ...overrides,
      }) as AvailabilityRow;
    const crew = { workStartTime: "08:00", workEndTime: "17:00", hoursConfigured: true };
    const rows = [
      row({ dayOfWeek: 3, startTime: "13:00", endTime: "17:00" }),
      row({ dayOfWeek: 3, startTime: "08:00", endTime: "12:00" }),
      row({ dayOfWeek: 3, startTime: "11:00", endTime: "12:30" }),
      row({ specificDate: new Date("2026-03-11T00:00:00Z"), isAvailable: false, startTime: "00:00", endTime: "24:00" }),
      row({ specificDate: new Date("2026-03-18T00:00:00Z"), startTime: "10:00", endTime: "14:00" }),
    ];
    expect(resolveDayWindows(rows, crew, WED)).toEqual([
      { start: "08:00", end: "12:30" },
      { start: "13:00", end: "17:00" },
    ]);
    expect(resolveDayWindow(rows, crew, new Date(`${WED}T00:00:00Z`))).toEqual({ start: "08:00", end: "12:30" });
    expect(resolveDayWindows(rows, crew, "2026-03-11")).toEqual([]);
    expect(resolveDayWindows(rows, crew, "2026-03-18")).toEqual([{ start: "10:00", end: "14:00" }]);
    expect(resolveDayWindows(rows, crew, "2026-03-05")).toEqual([]); // Thursday: no rows, hours configured
    expect(resolveDayWindows([], { ...crew, hoursConfigured: false }, "2026-03-05")).toEqual([{ start: "08:00", end: "17:00" }]);
  });

  it("a split shift is offered on both sides of lunch, and nothing that spans it", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    await setAvailability(t.db, { tenantId, resourceId: crew.id, blocks: split });
    const starts = (await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW })).map((s) => s.startTime);
    expect(starts).toContain("08:00");
    expect(starts).toContain("11:00");
    expect(starts).not.toContain("11:30"); // would run into lunch
    expect(starts).not.toContain("12:00");
    expect(starts).toContain("13:00");
    expect(starts.at(-1)).toBe("16:00");
  });

  it("validates inside ONE window: a visit spanning the lunch gap is outside_hours, naming the windows", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    await setAvailability(t.db, { tenantId, resourceId: crew.id, blocks: split });
    const spanning = await validateBookingSlot(t.db, {
      tenantId,
      resourceId: crew.id,
      date: new Date(`${WED}T00:00:00Z`),
      startTime: "11:30",
      endTime: "13:30",
    });
    expect(spanning).toMatchObject({
      valid: false,
      code: "outside_hours",
      // BO-09: the crew's name and the owner's 12-hour clock, not "Time slot
      // 11:30–13:30 is outside availability (08:00–12:00, 13:00–17:00)".
      reason: "Crew works 8:00 AM – 12:00 PM and 1:00 PM – 5:00 PM on Wednesdays; 11:30 AM – 1:30 PM is outside those hours",
    });
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "11:30", endTime: "13:30" }, { now: NOW }),
    ).rejects.toMatchObject({ code: "outside_hours" });
    const afternoon = await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: NOW });
    expect(afternoon.visit.status).toBe("confirmed");
  });
});

describe("a weekly-only save", () => {
  it("replaces the week and keeps the days off; a dated row in it is refused", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: "2026-03-09", to: "2026-03-10", note: "Dentist" }, { now: NOW });
    expect(await setAvailability(t.db, { tenantId, resourceId: crew.id, scope: "weekly", blocks: split })).toBe(true);
    const rows = await listAvailability(t.db, tenantId, crew.id);
    expect(rows.filter((r) => r.specificDate)).toHaveLength(2);
    expect(rows.filter((r) => !r.specificDate)).toHaveLength(4);

    await expect(
      setAvailability(t.db, {
        tenantId,
        resourceId: crew.id,
        scope: "weekly",
        blocks: [{ specificDate: new Date("2026-03-20T00:00:00Z"), startTime: "08:00", endTime: "12:00" }],
      }),
    ).rejects.toBeInstanceOf(ZodError);

    // "all" (0.3's full replace) still replaces the dated rows too.
    await setAvailability(t.db, { tenantId, resourceId: crew.id, blocks: split });
    expect((await listAvailability(t.db, tenantId, crew.id)).filter((r) => r.specificDate)).toEqual([]);
  });
});

describe("time off", () => {
  it("adds whole days, skips days already off, and returns the visits on those days", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const wed = (await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" }, { now: NOW })).visit;
    const thu = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-03-05", startTime: "09:00", endTime: "10:00" }, { now: NOW })
    ).visit;
    const gone = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-03-05", startTime: "13:00", endTime: "14:00" }, { now: NOW })
    ).visit;
    await setBookingStatus(t.db, tenantId, { id: gone.id, status: "cancelled" }, { now: NOW });

    const first = await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: WED, to: "2026-03-05" }, { now: NOW });
    expect(first?.added).toBe(2);
    expect(first?.visitsOnThoseDays.map((v) => v.id)).toEqual([wed.id, thu.id]);
    const again = await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: "2026-03-05", to: "2026-03-06" }, { now: NOW });
    expect(again?.added).toBe(1);

    // The days are off now: nothing offered, and a new staff booking is refused.
    expect(await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 3 }, { now: NOW })).toEqual([]);
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "14:00", endTime: "15:00" }, { now: NOW }),
    ).rejects.toMatchObject({ code: "outside_hours" });
    // A never-configured crew keeps its other weekdays.
    expect((await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-03-09", days: 1 }, { now: NOW })).length).toBeGreaterThan(0);

    expect(await addTimeOff(t.db, { tenantId: tenant("other"), resourceId: crew.id, from: WED, to: WED })).toBeNull();
  });

  it("refuses an inverted range, a bad date and more than 62 days", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    for (const [from, to] of [
      ["2026-03-10", "2026-03-09"],
      ["2026-02-30", "2026-03-02"],
      ["2026-03-01", "2026-05-02"],
    ] as const) {
      await expect(addTimeOff(t.db, { tenantId, resourceId: crew.id, from, to })).rejects.toBeInstanceOf(ZodError);
    }
    expect((await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: "2026-03-01", to: "2026-05-01" }))?.added).toBe(62);
  });

  it("removeTimeOff deletes one dated row of this tenant's crew, and nothing else", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    await setAvailability(t.db, { tenantId, resourceId: crew.id, scope: "weekly", blocks: split });
    await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: WED, to: WED });
    const rows = await listAvailability(t.db, tenantId, crew.id);
    const dated = rows.find((r) => r.specificDate)!;
    const weekly = rows.find((r) => !r.specificDate)!;
    expect(await removeTimeOff(t.db, tenant("other"), { resourceId: crew.id, exceptionId: dated.id })).toBe(false);
    expect(await removeTimeOff(t.db, tenantId, { resourceId: crew.id, exceptionId: weekly.id })).toBe(false);
    expect(await removeTimeOff(t.db, tenantId, { resourceId: crew.id, exceptionId: dated.id })).toBe(true);
    expect(await listAvailability(t.db, tenantId, crew.id)).toHaveLength(4);
  });
});

describe("getAvailabilitySummary", () => {
  it("a never-configured crew: no saved week, the Mon–Fri default on its own hours as what applies", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew", workStartTime: "07:00", workEndTime: "15:30" });
    const summary = await getAvailabilitySummary(t.db, tenantId, crew.id, { now: NOW });
    expect(summary).toEqual({
      resourceId: crew.id,
      hoursConfigured: false,
      weekly: [],
      effectiveWeekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: "07:00", endTime: "15:30" })),
      timeOff: [],
      specialHours: [],
    });
    expect(await getAvailabilitySummary(t.db, tenant("other"), crew.id)).toBeNull();
  });

  it("a configured crew: its saved week, and its days off and special hours from today on", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    await setAvailability(t.db, {
      tenantId,
      resourceId: crew.id,
      blocks: [
        ...split,
        { specificDate: new Date("2026-02-20T00:00:00Z"), startTime: "00:00", endTime: "24:00", isAvailable: false }, // past
        { specificDate: new Date("2026-03-21T00:00:00Z"), startTime: "09:00", endTime: "13:00", note: "Saturday blitz" },
      ],
    });
    await addTimeOff(t.db, { tenantId, resourceId: crew.id, from: "2026-03-09", to: "2026-03-09", note: "Dentist" });
    const summary = await getAvailabilitySummary(t.db, tenantId, crew.id, { now: NOW });
    expect(summary?.weekly).toEqual([
      { dayOfWeek: 3, startTime: "08:00", endTime: "12:00" },
      { dayOfWeek: 3, startTime: "13:00", endTime: "17:00" },
      { dayOfWeek: 4, startTime: "08:00", endTime: "12:00" },
      { dayOfWeek: 4, startTime: "13:00", endTime: "17:00" },
    ]);
    expect(summary?.effectiveWeekly).toEqual(summary?.weekly);
    expect(summary?.timeOff).toEqual([{ id: expect.any(String), date: "2026-03-09", note: "Dentist" }]);
    expect(summary?.specialHours).toEqual([
      { id: expect.any(String), date: "2026-03-21", startTime: "09:00", endTime: "13:00", note: "Saturday blitz" },
    ]);
  });
});
