import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  BookingNotBookableError,
  createBooking,
  createCachedMapsProvider,
  createHaversineMapsProvider,
  createResource,
  deactivateResource,
  findPublicSlots,
  getBooking,
  listResources,
  reactivateResource,
  requestPublicBooking,
  setAvailability,
  setBookingStatus,
  updateResource,
  type MapsProvider,
} from "../index.js";
import { schedulingBookings, schedulingDriveCache } from "../schema.js";
import { createTestDb, tenant, type LoggedQuery, type TestDb } from "./pglite.js";

/**
 * How the writers write: the crew lock taken first, nothing slow under it,
 * times that are real times, a removed crew that stays removed, a day that is
 * a whole day, and staff refusals that say what kind they are.
 *
 * Same clock as services.test.ts: NOW is Monday 2026-03-02 09:00 UTC.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function crew(tenantId: string, overrides: Record<string, unknown> = {}) {
  return createResource(t.db, { tenantId, name: "Field crew", ...overrides });
}

const staffVisit = (tenantId: string, resourceId: string, startTime: string, endTime: string, extra = {}) => ({
  tenantId,
  resourceId,
  scheduledDate: day(WED),
  startTime,
  endTime,
  ...extra,
});

/** Three visits with coordinates on Wednesday: 08:00, 11:00 and 15:00. */
async function busyWednesday(tenantId: string, resourceId: string) {
  for (const [startTime, endTime, lat] of [
    ["08:00", "09:00", 40.7],
    ["11:00", "12:00", 40.72],
    ["15:00", "16:00", 40.74],
  ] as const) {
    await createBooking(t.db, staffVisit(tenantId, resourceId, startTime, endTime, { lat, lng: -111.9 }));
  }
}

/** A provider that records whether it was called while a transaction was open. */
function spyingMaps() {
  const drives = createHaversineMapsProvider();
  const calls: Array<{ inTransaction: boolean }> = [];
  const maps: MapsProvider = {
    geocode: async () => ({ lat: 40.71, lng: -111.9 }),
    driveTime: async (origin, dest) => {
      calls.push({ inTransaction: t.inTransaction() });
      return drives.driveTime(origin, dest);
    },
  };
  return { maps, calls };
}

describe("drive times are looked up before the crew lock, never under it", () => {
  // A real provider is an HTTP round trip. Under the lock it held the crew —
  // and a pooled connection — through every one: one request on a day with
  // three visits made eight of them inside the transaction.
  it("a public request", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await busyWednesday(tenantId, resource.id);
    const { maps, calls } = spyingMaps();
    const [slot] = await findPublicSlots(t.db, { tenantId, durationMinutes: 60, from: day(WED), days: 1 }, { now: NOW });
    await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, durationMinutes: 60, customerName: "V", customerEmail: "v@example.com", address: "1 Main St" },
      { now: NOW, maps },
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.inTransaction)).toEqual([]);
  });

  it("a staff booking", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await busyWednesday(tenantId, resource.id);
    const { maps, calls } = spyingMaps();
    await createBooking(t.db, staffVisit(tenantId, resource.id, "13:00", "14:00", { lat: 40.73, lng: -111.9 }), { maps });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.inTransaction)).toEqual([]);
  });

  it("an un-cancel", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await busyWednesday(tenantId, resource.id);
    const visit = await createBooking(t.db, staffVisit(tenantId, resource.id, "13:00", "14:00", { lat: 40.73, lng: -111.9 }));
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" });
    const { maps, calls } = spyingMaps();
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" }, { maps })).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.inTransaction)).toEqual([]);
  });

  it("the cached provider, built on the same handle as the README shows, completes instead of waiting forever", async () => {
    // Its cache reads on the handle it was built with. Called inside the
    // transaction, on a one-connection handle, that read waited for the
    // connection the transaction held: requestPublicBooking never returned.
    // Its own database, so a regression hangs this test and not the file.
    const own = await createTestDb();
    try {
      const tenantId = tenant();
      const resource = await createResource(own.db, { tenantId, name: "Crew" });
      await createBooking(own.db, staffVisit(tenantId, resource.id, "08:00", "09:00", { lat: 40.7, lng: -111.9 }));
      const real: MapsProvider = {
        geocode: async () => ({ lat: 40.71, lng: -111.9 }),
        driveTime: (o, d) => createHaversineMapsProvider().driveTime(o, d),
      };
      const maps = createCachedMapsProvider(real, own.db);
      const [slot] = await findPublicSlots(own.db, { tenantId, durationMinutes: 60, from: day(WED), days: 1 }, { now: NOW });
      const booking = requestPublicBooking(
        own.db,
        { tenantId, slotId: slot!.slotId, durationMinutes: 60, customerName: "V", customerEmail: "v@example.com", address: "1 Main St" },
        { now: NOW, maps },
      );
      const outcome = await Promise.race([
        booking.then(() => "booked"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ]);
      expect(outcome).toBe("booked");
      expect(await own.db.select().from(schedulingDriveCache)).not.toHaveLength(0);
    } finally {
      await Promise.race([own.close(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  });
});

describe("every writer takes the crew lock first, on its transaction", () => {
  // PGlite runs one transaction at a time, so the race tests pass with or
  // without the lock. This is what fails when a writer stops taking it.
  function lockedBeforeFirstRead(queries: LoggedQuery[], key: string): boolean {
    const inTx = queries.filter((q) => q.inTransaction);
    const lockAt = inTx.findIndex((q) => q.sql.includes("pg_advisory_xact_lock") && q.params.includes(key));
    const firstTouch = inTx.findIndex((q) => /"scheduling_/.test(q.sql));
    return lockAt >= 0 && (firstTouch === -1 || lockAt < firstTouch);
  }

  it("createBooking, requestPublicBooking, setBookingStatus (un-cancel) and setAvailability", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const key = `scheduling:${tenantId}:${resource.id}`;

    t.queries.length = 0;
    const visit = await createBooking(t.db, staffVisit(tenantId, resource.id, "08:00", "09:00"));
    expect(lockedBeforeFirstRead(t.queries, key)).toBe(true);

    const [slot] = await findPublicSlots(t.db, { tenantId, durationMinutes: 60, from: day(WED), days: 1 }, { now: NOW });
    t.queries.length = 0;
    await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, durationMinutes: 60, customerName: "V", customerEmail: "v@example.com" },
      { now: NOW, requesterKey: "ip:203.0.113.7" },
    );
    expect(lockedBeforeFirstRead(t.queries, key)).toBe(true);

    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" });
    t.queries.length = 0;
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" });
    expect(lockedBeforeFirstRead(t.queries, key)).toBe(true);

    t.queries.length = 0;
    await setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [{ dayOfWeek: 3, startTime: "08:00", endTime: "17:00" }] });
    expect(lockedBeforeFirstRead(t.queries, key)).toBe(true);
  });
});

describe("times are real times", () => {
  it("16:99 is not a time; a visit can't run past closing by writing one", async () => {
    // "16:99" passed the old \d{2}:\d{2} pattern, compared below "17:00" as
    // text, and was 17:39 to the duration math: stored as a 99-minute visit.
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await expect(createBooking(t.db, staffVisit(tenantId, resource.id, "16:00", "16:99"))).rejects.toBeInstanceOf(ZodError);
    await expect(createBooking(t.db, staffVisit(tenantId, resource.id, "9:00", "10:00"))).rejects.toBeInstanceOf(ZodError);
    await expect(createBooking(t.db, staffVisit(tenantId, resource.id, "16:00", "17:30"))).rejects.toMatchObject({
      code: "outside_hours",
    });
  });

  it("hours like 99:99 can't be saved; 24:00 closes at midnight", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await expect(
      setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [{ dayOfWeek: 3, startTime: "99:99", endTime: "99:99" }] }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(updateResource(t.db, tenantId, resource.id, { workEndTime: "17:60" })).rejects.toBeInstanceOf(ZodError);
    await expect(
      setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [{ dayOfWeek: 3, startTime: "24:00", endTime: "24:00" }] }),
    ).rejects.toBeInstanceOf(ZodError);

    await setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [{ dayOfWeek: 3, startTime: "18:00", endTime: "24:00" }] });
    const late = await createBooking(t.db, staffVisit(tenantId, resource.id, "23:00", "24:00"));
    expect(late).toMatchObject({ durationMinutes: 60 });
  });
});

describe("a removed crew", () => {
  it("can't be booked or have a visit brought back onto it, until it is put back", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const visit = await createBooking(t.db, staffVisit(tenantId, resource.id, "10:00", "11:00"));
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" });
    expect(await deactivateResource(t.db, tenantId, resource.id)).toBe(true);

    await expect(createBooking(t.db, staffVisit(tenantId, resource.id, "13:00", "14:00"))).rejects.toMatchObject({
      code: "resource_unavailable",
    });
    await expect(setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" })).rejects.toMatchObject({
      code: "resource_unavailable",
    });
    expect((await getBooking(t.db, tenantId, visit.id))?.status).toBe("cancelled");

    // Another tenant can't put it back; its own can, with its settings intact.
    expect(await reactivateResource(t.db, tenant("other"), resource.id)).toBe(false);
    expect(await reactivateResource(t.db, tenantId, resource.id)).toBe(true);
    expect(await listResources(t.db, tenantId)).toHaveLength(1);
    expect((await createBooking(t.db, staffVisit(tenantId, resource.id, "13:00", "14:00"))).status).toBe("confirmed");
  });
});

describe("a day is a whole day", () => {
  it("a visit stamped in the last second of its day still holds its slot and counts toward the cap", async () => {
    // The day used to end at 23:59:59.000 (lte), so this row was on no day:
    // invisible to the overlap check and the cap.
    const tenantId = tenant();
    const resource = await crew(tenantId, { maxJobsPerDay: 1 });
    await t.db.insert(schedulingBookings).values({
      tenantId,
      resourceId: resource.id,
      scheduledDate: new Date(`${WED}T23:59:59.500Z`), // a host's own insert
      startTime: "10:00",
      endTime: "11:00",
      durationMinutes: 60,
      status: "confirmed",
    });
    await expect(createBooking(t.db, staffVisit(tenantId, resource.id, "10:00", "11:00"))).rejects.toMatchObject({
      code: "slot_unavailable",
    });
    expect(await findPublicSlots(t.db, { tenantId, durationMinutes: 60, from: day(WED), days: 1 }, { now: NOW })).toEqual([]);
  });

  it("createBooking stores the day's midnight, whatever time the date carries", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const row = await createBooking(t.db, {
      ...staffVisit(tenantId, resource.id, "10:00", "11:00"),
      scheduledDate: new Date(`${WED}T21:30:00Z`),
    });
    expect(row.scheduledDate.toISOString()).toBe(`${WED}T00:00:00.000Z`);
  });
});

describe("staff refusals say what kind they are", () => {
  // Every staff refusal used to be `slot_unavailable`, which a host answers
  // with "pick another time" — a loop for a booking that can never succeed.
  it("outside hours, an end before the start, no such crew, and a clash with another visit", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await createBooking(t.db, staffVisit(tenantId, resource.id, "10:00", "11:00"));
    const refusal = (startTime: string, endTime: string, resourceId = resource.id) =>
      createBooking(t.db, staffVisit(tenantId, resourceId, startTime, endTime)).catch((e: unknown) => e);

    expect(await refusal("03:00", "04:00")).toMatchObject({ code: "outside_hours" });
    expect(await refusal("12:00", "11:00")).toMatchObject({ code: "invalid_window" });
    expect(await refusal("12:00", "13:00", "no-such-crew")).toMatchObject({ code: "resource_unavailable" });
    const clash = await refusal("10:30", "11:30");
    expect(clash).toBeInstanceOf(BookingNotBookableError);
    expect(clash).toMatchObject({ code: "slot_unavailable" });
  });
});
