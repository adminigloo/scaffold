import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addTimeOff,
  assignBooking,
  bookVisit,
  cancelVisitByToken,
  createHaversineMapsProvider,
  createResource,
  findPublicSlots,
  removeTimeOff,
  requestPublicBooking,
  rescheduleBooking,
  rescheduleVisitByToken,
  setBookingStatus,
  updateBookingDetails,
  type MapsProvider,
} from "../index.js";
import { resourceLockKey } from "../internal.js";
import { createTestDb, tenant, type LoggedQuery, type TestDb } from "./pglite.js";

/**
 * The 0.4 writers take the crew lock — both crews' for a move between them,
 * in sorted key order — on their transaction, before they read anything; and
 * no maps call ever happens inside a transaction. PGlite runs one
 * transaction at a time, so a race test passes with or without the lock:
 * this query-log test is what fails when a writer stops taking it.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** The lock keys taken in the transaction, in order, and whether they all came before its first table read. */
function locksInTx(queries: LoggedQuery[]): { keys: string[]; beforeFirstRead: boolean } {
  const inTx = queries.filter((q) => q.inTransaction);
  const lockAt = inTx
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => q.sql.includes("pg_advisory_xact_lock") && String(q.params[0] ?? "").startsWith("scheduling:"));
  const firstTouch = inTx.findIndex((q) => /"scheduling_/.test(q.sql));
  const keys = lockAt.map(({ q }) => String(q.params[0]));
  const lastLock = lockAt.at(-1)?.index ?? -1;
  return { keys, beforeFirstRead: keys.length > 0 && (firstTouch === -1 || lastLock < firstTouch) };
}

/** A provider that records whether it was called while a transaction was open. */
function spyingMaps() {
  const drives = createHaversineMapsProvider();
  const calls: Array<{ inTransaction: boolean }> = [];
  const maps: MapsProvider = {
    geocode: async () => {
      calls.push({ inTransaction: t.inTransaction() });
      return { lat: 40.71, lng: -111.9 };
    },
    driveTime: async (origin, dest) => {
      calls.push({ inTransaction: t.inTransaction() });
      return drives.driveTime(origin, dest);
    },
  };
  return { maps, calls };
}

async function twoCrews() {
  const tenantId = tenant();
  const a = await createResource(t.db, { tenantId, name: "A" });
  const b = await createResource(t.db, { tenantId, name: "B" });
  const keyA = resourceLockKey(tenantId, a.id);
  const keyB = resourceLockKey(tenantId, b.id);
  return { tenantId, a, b, sorted: [keyA, keyB].sort() };
}

describe("every 0.4 writer locks its crews first, sorted, on its transaction", () => {
  it("rescheduleBooking across crews takes both keys in sorted order; assignBooking too", async () => {
    const { tenantId, a, b, sorted } = await twoCrews();
    const visit = (
      await bookVisit(t.db, { tenantId, resourceId: a.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" }, { now: NOW })
    ).visit;
    t.queries.length = 0;
    await rescheduleBooking(t.db, tenantId, { id: visit.id, date: WED, startTime: "13:00", resourceId: b.id }, { now: NOW });
    expect(locksInTx(t.queries)).toEqual({ keys: sorted, beforeFirstRead: true });

    t.queries.length = 0;
    await assignBooking(t.db, tenantId, { id: visit.id, resourceId: a.id }, { now: NOW });
    expect(locksInTx(t.queries)).toEqual({ keys: sorted, beforeFirstRead: true });
  });

  it("rescheduleVisitByToken and cancelVisitByToken", async () => {
    const { tenantId } = await twoCrews();
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, service: "visit", customerName: "P", customerEmail: "p@example.com" },
      { now: NOW },
    );
    const own = await findPublicSlots(t.db, { tenantId, manageToken: receipt.manageToken, from: "2026-03-05", days: 1 }, { now: NOW });
    t.queries.length = 0;
    await rescheduleVisitByToken(t.db, tenantId, receipt.manageToken!, { slotId: own[0]!.slotId }, { now: NOW });
    const moved = locksInTx(t.queries);
    expect(moved.beforeFirstRead).toBe(true);
    expect(moved.keys).toEqual([...moved.keys].sort());

    t.queries.length = 0;
    await cancelVisitByToken(t.db, tenantId, receipt.manageToken!, {}, { now: NOW });
    expect(locksInTx(t.queries).beforeFirstRead).toBe(true);
    expect(locksInTx(t.queries).keys).toHaveLength(1);
  });

  it("addTimeOff and removeTimeOff", async () => {
    const { tenantId, a } = await twoCrews();
    const key = resourceLockKey(tenantId, a.id);
    t.queries.length = 0;
    await addTimeOff(t.db, { tenantId, resourceId: a.id, from: WED, to: WED }, { now: NOW });
    expect(locksInTx(t.queries)).toEqual({ keys: [key], beforeFirstRead: true });

    const [row] = await t.client.query<{ id: string }>(`select id from scheduling_availability where resource_id = $1`, [a.id]).then((r) => r.rows);
    t.queries.length = 0;
    expect(await removeTimeOff(t.db, tenantId, { resourceId: a.id, exceptionId: row!.id })).toBe(true);
    expect(locksInTx(t.queries)).toEqual({ keys: [key], beforeFirstRead: true });
  });
});

describe("no maps call happens inside a transaction", () => {
  it("staff booking, move, crew change, details edit, accept-after-deadline and a customer move", async () => {
    const { tenantId, a, b } = await twoCrews();
    for (const [startTime, endTime, lat] of [
      ["08:00", "09:00", 40.7],
      ["15:00", "16:00", 40.74],
    ] as const) {
      await bookVisit(t.db, { tenantId, resourceId: a.id, scheduledDate: WED, startTime, endTime, lat, lng: -111.9 }, { now: NOW });
      await bookVisit(t.db, { tenantId, resourceId: b.id, scheduledDate: WED, startTime, endTime, lat, lng: -111.9 }, { now: NOW });
    }
    const { maps, calls } = spyingMaps();
    const visit = (
      await bookVisit(
        t.db,
        { tenantId, resourceId: a.id, scheduledDate: WED, startTime: "11:00", endTime: "12:00", address: "1 Main St" },
        { maps, now: NOW },
      )
    ).visit;
    await rescheduleBooking(t.db, tenantId, { id: visit.id, date: WED, startTime: "12:00" }, { maps, now: NOW });
    await assignBooking(t.db, tenantId, { id: visit.id, resourceId: b.id }, { maps, now: NOW });
    await updateBookingDetails(t.db, tenantId, { id: visit.id, patch: { address: "2 Main St" } }, { maps, now: NOW });

    const pending = (
      await bookVisit(
        t.db,
        { tenantId, resourceId: a.id, scheduledDate: "2026-03-03", startTime: "12:00", endTime: "13:00", status: "pending", lat: 40.72, lng: -111.9 },
        { now: NOW },
      )
    ).visit;
    // Past its deadline (the start, here): accepting it re-checks the slot.
    await setBookingStatus(t.db, tenantId, { id: pending.id, status: "confirmed" }, { maps, now: new Date("2026-03-03T12:30:00Z") });

    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: "2026-03-05", days: 1 }, { now: NOW });
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, service: "visit", customerName: "P", customerEmail: "p@example.com", address: "3 Main St" },
      { now: NOW, maps },
    );
    const own = await findPublicSlots(t.db, { tenantId, manageToken: receipt.manageToken, from: "2026-03-06", days: 1 }, { now: NOW });
    await rescheduleVisitByToken(t.db, tenantId, receipt.manageToken!, { slotId: own[0]!.slotId }, { now: NOW, maps });

    expect(calls.length).toBeGreaterThan(5);
    expect(calls.filter((c) => c.inTransaction)).toEqual([]);
  });
});
