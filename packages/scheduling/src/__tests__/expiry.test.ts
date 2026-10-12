import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookVisit,
  createResource,
  expirePendingRequests,
  findPublicSlots,
  getBooking,
  requestPublicBooking,
  schedulingBookings,
  setBookingStatus,
  updateSchedulingSettings,
} from "../index.js";
import { eventRecorder } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * A request nobody answers expires. Its time is free again from its deadline
 * on — before any sweep — and the sweep then flips it, tells the customer
 * (an event), and is a no-op the second time.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const HOUR = 3_600_000;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function setUp() {
  const tenantId = tenant();
  await updateSchedulingSettings(t.db, tenantId, { pendingExpiryHours: 24 });
  const crew = await createResource(t.db, { tenantId, name: "Crew", maxJobsPerDay: 1 });
  const slots = () => findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
  const ask = async (startTime: string, email: string, now = NOW) => {
    const { encodeSlotId } = await import("../public.js");
    return requestPublicBooking(
      t.db,
      { tenantId, slotId: encodeSlotId({ date: WED, startTime }), service: "visit", customerName: "V", customerEmail: email },
      { now },
    );
  };
  return { tenantId, crew, slots, ask };
}

describe("an overdue request holds no time", () => {
  it("frees its slot for the offer and for a new request, before any sweep", async () => {
    const { tenantId, ask } = await setUp();
    const first = await ask("10:00", "first@example.com");
    const row = await getBooking(t.db, tenantId, first.id);
    expect(row?.pendingExpiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString());

    // The crew takes one visit a day: while the request holds, the day is full.
    const during = new Date(NOW.getTime() + 23 * HOUR);
    expect(await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: during })).toEqual([]);
    await expect(ask("10:00", "second@example.com", during)).rejects.toMatchObject({ code: "slot_unavailable" });

    // At the deadline it holds nothing, though its status is still pending.
    const after = new Date(NOW.getTime() + 24 * HOUR);
    expect((await getBooking(t.db, tenantId, first.id))?.status).toBe("pending");
    const offered = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: after });
    expect(offered.some((s) => s.startTime === "10:00")).toBe(true);
    const second = await ask("10:00", "second@example.com", after);
    expect(second).toMatchObject({ startTime: "10:00", status: "pending" });
  });
});

describe("expirePendingRequests", () => {
  it("flips overdue requests to expired, bumps the sequence, emits, and a second run does nothing", async () => {
    const { tenantId, ask } = await setUp();
    const overdue = await ask("10:00", "a@example.com");
    const recorder = eventRecorder();
    const tooSoon = await expirePendingRequests(t.db, tenantId, { now: new Date(NOW.getTime() + 23 * HOUR), onEvent: recorder.onEvent });
    expect(tooSoon).toEqual({ expired: 0, visitIds: [] });

    const later = new Date(NOW.getTime() + 25 * HOUR);
    const swept = await expirePendingRequests(t.db, tenantId, { now: later, onEvent: recorder.onEvent });
    expect(swept).toEqual({ expired: 1, visitIds: [overdue.id] });
    expect(await getBooking(t.db, tenantId, overdue.id)).toMatchObject({ status: "expired", sequence: 1 });
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      type: "visit.expired",
      visitId: overdue.id,
      actor: { type: "system", id: null },
      data: { notify: true, visit: { status: "expired", sequence: 1 } },
    });

    expect(await expirePendingRequests(t.db, tenantId, { now: later, onEvent: recorder.onEvent })).toEqual({ expired: 0, visitIds: [] });
    expect(recorder.events).toHaveLength(1);
  });

  it("leaves other tenants, confirmed visits and requests still in time alone", async () => {
    const { tenantId, crew, ask } = await setUp();
    const other = await setUp();
    const theirs = await other.ask("10:00", "x@example.com");
    const confirmed = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-03-05", startTime: "10:00", endTime: "11:00" }, { now: NOW })
    ).visit;
    const inTime = await ask("10:00", "y@example.com", new Date(NOW.getTime() + 20 * HOUR));
    const result = await expirePendingRequests(t.db, tenantId, { now: new Date(NOW.getTime() + 25 * HOUR) });
    expect(result.expired).toBe(0);
    expect((await getBooking(t.db, other.tenantId, theirs.id))?.status).toBe("pending");
    expect((await getBooking(t.db, tenantId, confirmed.id))?.status).toBe("confirmed");
    expect((await getBooking(t.db, tenantId, inTime.id))?.status).toBe("pending");
  });

  it("a legacy request with no deadline expires at its start", async () => {
    const { tenantId, crew } = await setUp();
    const [legacy] = (await t.db
      .insert(schedulingBookings)
      .values({
        tenantId,
        resourceId: crew.id,
        scheduledDate: new Date(`${WED}T00:00:00Z`),
        startTime: "10:00",
        endTime: "11:00",
        durationMinutes: 60,
        status: "pending",
        startsAt: new Date(`${WED}T10:00:00Z`),
        endsAt: new Date(`${WED}T11:00:00Z`),
      })
      .returning()) as Array<{ id: string }>;
    expect((await expirePendingRequests(t.db, tenantId, { now: new Date(`${WED}T09:59:00Z`) })).expired).toBe(0);
    expect((await expirePendingRequests(t.db, tenantId, { now: new Date(`${WED}T10:00:00Z`) })).visitIds).toEqual([legacy!.id]);
  });

  it("respects its limit", async () => {
    const { tenantId, crew } = await setUp();
    await updateSchedulingSettings(t.db, tenantId, { pendingExpiryHours: 1 });
    for (const startTime of ["08:00", "10:00", "12:00"]) {
      await bookVisit(
        t.db,
        { tenantId, resourceId: null, scheduledDate: WED, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, status: "pending" },
        { now: NOW },
      );
    }
    const later = new Date(NOW.getTime() + 2 * HOUR);
    expect((await expirePendingRequests(t.db, tenantId, { now: later, limit: 2 })).expired).toBe(2);
    expect((await expirePendingRequests(t.db, tenantId, { now: later, limit: 2 })).expired).toBe(1);
    expect(crew.id).toBeTruthy();
  });
});

describe("accepting an expired request is a restore, with re-validation", () => {
  it("is refused when somebody has taken the time since, and restores when it's free", async () => {
    const { tenantId, crew, ask } = await setUp();
    const lapsed = await ask("10:00", "late@example.com");
    const later = new Date(NOW.getTime() + 25 * HOUR);
    await expirePendingRequests(t.db, tenantId, { now: later });
    const taker = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: later })
    ).visit;
    // The crew's one visit a day is now taken.
    await expect(setBookingStatus(t.db, tenantId, { id: lapsed.id, status: "confirmed" }, { now: later })).rejects.toMatchObject({
      code: "slot_unavailable",
    });
    await setBookingStatus(t.db, tenantId, { id: taker.id, status: "cancelled" }, { now: later });
    const recorder = eventRecorder();
    expect(await setBookingStatus(t.db, tenantId, { id: lapsed.id, status: "confirmed" }, { now: later, onEvent: recorder.onEvent })).toBe(true);
    expect(await getBooking(t.db, tenantId, lapsed.id)).toMatchObject({ status: "confirmed", sequence: 2, pendingExpiresAt: null });
    expect(recorder.events[0]).toMatchObject({ type: "visit.confirmed", data: { via: "restore" } });
  });

  it("an overdue request accepted before the sweep is re-checked too", async () => {
    const { tenantId, crew, ask } = await setUp();
    const lapsed = await ask("10:00", "late@example.com");
    const later = new Date(NOW.getTime() + 25 * HOUR);
    // Its time was free from the deadline, so a staff booking took the day.
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: later });
    await expect(setBookingStatus(t.db, tenantId, { id: lapsed.id, status: "confirmed" }, { now: later })).rejects.toMatchObject({
      code: "slot_unavailable",
    });
    expect((await getBooking(t.db, tenantId, lapsed.id))?.status).toBe("pending");
  });
});
