import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignBooking,
  bookVisit,
  createResource,
  findPublicSlots,
  getBooking,
  rescheduleBooking,
  rescheduleVisitByToken,
  requestPublicBooking,
  setAvailability,
  todayIn,
  updateSchedulingSettings,
} from "../index.js";
import { encodeSlotId } from "../public.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * A business in America/Denver sees and enforces its own local times, and a
 * 24-hour notice is 24 REAL hours — on the weekend the clocks change too.
 *
 * Denver: MDT (UTC−6) until 2026-11-01 02:00, then MST (UTC−7); MST until
 * 2026-03-08 02:00, then MDT.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const visitor = { customerName: "Pat Visitor", customerEmail: "pat@example.com" };

/** A Denver tenant with one crew that works every day of the week, 08:00–17:00 (or as given). */
async function denver(hours = { start: "08:00", end: "17:00" }) {
  const tenantId = tenant("den");
  await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver" });
  const crew = await createResource(t.db, { tenantId, name: "Crew" });
  await setAvailability(t.db, {
    tenantId,
    resourceId: crew.id,
    blocks: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: hours.start, endTime: hours.end })),
  });
  return { tenantId, crew };
}

describe("24 hours' notice is 24 real hours", () => {
  it("across fall-back: at Sat 10:00 MDT, Sun 09:00 MST is offered and 08:30 isn't", async () => {
    const { tenantId } = await denver();
    const now = new Date("2026-10-31T16:00:00Z"); // Sat 2026-10-31 10:00 MDT
    const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-11-01", days: 1 }, { now });
    // 24 real hours later is Sun 16:00Z = 09:00 MST. 24 WALL-CLOCK hours would be 10:00.
    expect(slots[0]).toMatchObject({ date: "2026-11-01", startTime: "09:00", startsAt: "2026-11-01T16:00:00.000Z" });
    expect(slots.some((s) => s.startTime === "08:30")).toBe(false);

    const ask = (startTime: string) =>
      requestPublicBooking(t.db, { tenantId, slotId: encodeSlotId({ date: "2026-11-01", startTime }), service: "visit", ...visitor }, { now });
    await expect(ask("08:30")).rejects.toMatchObject({ code: "too_soon" });
    const receipt = await ask("09:00");
    expect(receipt).toMatchObject({ startTime: "09:00", timeZone: "America/Denver" });
    expect(receipt.startsAt.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  it("across spring-forward: at Sat 10:00 MST, the first Sunday start is 11:00 MDT", async () => {
    const { tenantId } = await denver();
    const now = new Date("2026-03-07T17:00:00Z"); // Sat 2026-03-07 10:00 MST
    const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-03-08", days: 1 }, { now });
    // 24 real hours later is Sun 17:00Z = 11:00 MDT; 24 wall-clock hours would be 10:00.
    expect(slots[0]).toMatchObject({ startTime: "11:00", startsAt: "2026-03-08T17:00:00.000Z" });
    expect(slots.some((s) => s.startTime === "10:30")).toBe(false);
  });
});

describe("today is the business's today", () => {
  it("at 20:00 in Denver it is still today, though UTC has rolled over", async () => {
    const { tenantId } = await denver({ start: "08:00", end: "24:00" });
    const now = new Date("2026-03-04T03:00:00Z"); // Tue 2026-03-03 20:00 MST
    expect(todayIn(now, "America/Denver")).toBe("2026-03-03");
    const slots = await findPublicSlots(
      t.db,
      { tenantId, service: "visit", days: 1 },
      { now, policy: { minNoticeMinutes: 0 } },
    );
    // 0.3 read the day in UTC and would have started on the 4th.
    expect(slots[0]).toMatchObject({ date: "2026-03-03", startTime: "20:00", startsAt: "2026-03-04T03:00:00.000Z" });
    expect(slots.at(-1)).toMatchObject({ date: "2026-03-03", startTime: "23:00", endTime: "24:00" });
  });
});

describe("a slot's instants follow the season", () => {
  it("09:00 is 15:00Z on a Mountain Daylight day and 16:00Z on a Mountain Standard day", async () => {
    const { tenantId } = await denver();
    const now = new Date("2026-10-28T15:00:00Z");
    const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-10-30", days: 4 }, { now });
    const at = (date: string) => slots.find((s) => s.date === date && s.startTime === "09:00");
    expect(at("2026-10-30")).toMatchObject({ startsAt: "2026-10-30T15:00:00.000Z", endsAt: "2026-10-30T16:00:00.000Z" }); // Fri, MDT
    expect(at("2026-11-02")).toMatchObject({ startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z" }); // Mon, MST
  });
});

describe("backfillVisitInstants (the 0.3 → 0.4 upgrade, from code)", () => {
  it("fills instants in the tenant's zone, marks public requests, gives waiting requests a deadline — once", async () => {
    const { tenantId, crew } = await denver();
    const { schedulingBookings } = await import("../schema.js");
    const legacy = (await t.db
      .insert(schedulingBookings)
      .values([
        { tenantId, resourceId: crew.id, scheduledDate: new Date("2026-11-02T00:00:00Z"), startTime: "09:00", endTime: "24:00", durationMinutes: 900, status: "confirmed" },
        {
          tenantId,
          resourceId: crew.id,
          scheduledDate: new Date("2026-11-03T00:00:00Z"),
          startTime: "10:00",
          endTime: "11:00",
          durationMinutes: 60,
          status: "pending",
          requesterKey: "ip:203.0.113.7",
          createdAt: new Date("2026-11-02T12:00:00Z"),
        },
      ])
      .returning()) as Array<{ id: string }>;
    const { backfillVisitInstants } = await import("../index.js");
    expect(await backfillVisitInstants(t.db, tenantId)).toBe(2);
    expect(await getBooking(t.db, tenantId, legacy[0]!.id)).toMatchObject({
      startsAt: new Date("2026-11-02T16:00:00.000Z"),
      endsAt: new Date("2026-11-03T07:00:00.000Z"), // "24:00" is the next local midnight
      origin: "staff",
    });
    expect(await getBooking(t.db, tenantId, legacy[1]!.id)).toMatchObject({
      startsAt: new Date("2026-11-03T17:00:00.000Z"),
      origin: "public",
      // 48 hours after it was made would be later than its start: the start wins.
      pendingExpiresAt: new Date("2026-11-03T17:00:00.000Z"),
    });
    expect(await backfillVisitInstants(t.db, tenantId)).toBe(0);
  });
});

describe("every writer writes the instants from the tenant's zone", () => {
  it("staff booking, public request, staff move, customer move — and a crew change keeps them", async () => {
    const { tenantId, crew } = await denver();
    const other = await createResource(t.db, { tenantId, name: "Second crew" });
    await setAvailability(t.db, {
      tenantId,
      resourceId: other.id,
      blocks: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: "08:00", endTime: "17:00" })),
    });
    const now = new Date("2026-10-28T15:00:00Z");

    const staff = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "13:00", endTime: "14:30" },
      { now },
    );
    expect(staff.visit).toMatchObject({
      startsAt: new Date("2026-11-02T20:00:00.000Z"),
      endsAt: new Date("2026-11-02T21:30:00.000Z"),
      origin: "staff",
    });

    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-10-30", days: 1 }, { now });
    const receipt = await requestPublicBooking(t.db, { tenantId, slotId: slot!.slotId, service: "visit", ...visitor }, { now });
    const requested = await getBooking(t.db, tenantId, receipt.id);
    expect(requested).toMatchObject({ startsAt: new Date("2026-10-30T14:00:00.000Z"), origin: "public" }); // 08:00 MDT

    const moved = await rescheduleBooking(t.db, tenantId, { id: staff.visit.id, date: "2026-10-30", startTime: "15:00" }, { now });
    expect(moved?.visit).toMatchObject({
      endTime: "16:30",
      startsAt: new Date("2026-10-30T21:00:00.000Z"),
      endsAt: new Date("2026-10-30T22:30:00.000Z"),
    });

    const reassigned = await assignBooking(t.db, tenantId, { id: staff.visit.id, resourceId: other.id }, { now });
    expect(reassigned?.visit.startsAt?.toISOString()).toBe("2026-10-30T21:00:00.000Z");

    const [later] = await findPublicSlots(
      t.db,
      { tenantId, manageToken: receipt.manageToken, from: "2026-11-03", days: 1 },
      { now },
    );
    const self = await rescheduleVisitByToken(t.db, tenantId, receipt.manageToken!, { slotId: later!.slotId }, { now });
    expect(self).toMatchObject({ date: "2026-11-03", startTime: "08:00", startsAt: "2026-11-03T15:00:00.000Z", timeZone: "America/Denver" });
    expect((await getBooking(t.db, tenantId, receipt.id))?.startsAt?.toISOString()).toBe("2026-11-03T15:00:00.000Z");
  });
});
