import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignBooking,
  bookVisit,
  createHaversineMapsProvider,
  createResource,
  deactivateResource,
  getBooking,
  rescheduleBooking,
  setBookingStatus,
  updateBookingDetails,
  type MapsProvider,
} from "../index.js";
import { eventRecorder } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The office moving visits around: a move, a crew change, a details edit.
 * Every refusal code, the warnings, the sequence rules, "nothing changed
 * means no event", a details edit that never refuses, and an unassigned
 * visit that can finally be given a crew.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const THU = "2026-03-05";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function setUp() {
  const tenantId = tenant();
  const alpha = await createResource(t.db, { tenantId, name: "Alpha" });
  const bravo = await createResource(t.db, { tenantId, name: "Bravo" });
  const book = async (resourceId: string | null, date: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) =>
    (
      await bookVisit(
        t.db,
        { tenantId, resourceId, scheduledDate: date, startTime, endTime, customerEmail: "c@example.com", ...extra },
        { now: NOW },
      )
    ).visit;
  return { tenantId, alpha, bravo, book };
}

describe("rescheduleBooking", () => {
  it("moves the same row, bumps the sequence, and says where it was", async () => {
    const { tenantId, alpha, bravo, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    const recorder = eventRecorder();
    const moved = await rescheduleBooking(
      t.db,
      tenantId,
      { id: visit.id, date: THU, startTime: "13:00", resourceId: bravo.id },
      { now: NOW, onEvent: recorder.onEvent, actor: { type: "staff", id: "u-1" } },
    );
    expect(moved?.visit).toMatchObject({
      id: visit.id,
      resourceId: bravo.id,
      startTime: "13:00",
      endTime: "14:00", // the same length
      durationMinutes: 60,
      sequence: 1,
      status: "confirmed",
    });
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      type: "visit.rescheduled",
      actor: { type: "staff", id: "u-1" },
      data: {
        notify: true,
        previous: { date: WED, startTime: "10:00", endTime: "11:00", resourceId: alpha.id, resourceName: "Alpha" },
        visit: { date: THU, startTime: "13:00", resourceId: bravo.id, resourceName: "Bravo", sequence: 1 },
      },
    });
  });

  it("an explicit end sets the new length; notify passes through", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    const recorder = eventRecorder();
    const moved = await rescheduleBooking(
      t.db,
      tenantId,
      { id: visit.id, date: WED, startTime: "13:00", endTime: "15:30" },
      { now: NOW, onEvent: recorder.onEvent, notify: false },
    );
    expect(moved?.visit).toMatchObject({ durationMinutes: 150, endTime: "15:30" });
    expect(recorder.events[0]?.data.notify).toBe(false);
  });

  it("only the crew changed: reassigned, no sequence bump", async () => {
    const { tenantId, alpha, bravo, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    const recorder = eventRecorder();
    const moved = await rescheduleBooking(
      t.db,
      tenantId,
      { id: visit.id, date: WED, startTime: "10:00", resourceId: bravo.id },
      { now: NOW, onEvent: recorder.onEvent },
    );
    expect(moved?.visit).toMatchObject({ resourceId: bravo.id, sequence: 0 });
    expect(recorder.types()).toEqual(["visit.reassigned"]);
  });

  it("nothing changed: no write and no event", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    const recorder = eventRecorder();
    const same = await rescheduleBooking(
      t.db,
      tenantId,
      { id: visit.id, date: WED, startTime: "10:00" },
      { now: NOW, onEvent: recorder.onEvent },
    );
    expect(same).toEqual({ visit, warnings: [] });
    expect(recorder.events).toEqual([]);
    expect((await getBooking(t.db, tenantId, visit.id))?.updatedAt).toEqual(visit.updatedAt);
  });

  it("every refusal code, and nothing written", async () => {
    const { tenantId, alpha, bravo, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    await book(alpha.id, WED, "13:00", "15:00");
    const attempt = (input: Record<string, unknown>) =>
      rescheduleBooking(t.db, tenantId, { id: visit.id, date: WED, startTime: "10:00", ...input } as never, { now: NOW }).catch(
        (e: unknown) => e,
      );

    const clash = await attempt({ startTime: "14:00" });
    expect(clash).toMatchObject({ code: "slot_unavailable", message: "Alpha already has a visit 1:00 PM – 3:00 PM" });
    expect(await attempt({ startTime: "03:00" })).toMatchObject({ code: "outside_hours" });
    expect(await attempt({ startTime: "12:00", endTime: "11:00" })).toMatchObject({ code: "invalid_window" });
    expect(await attempt({ startTime: "23:30" })).toMatchObject({ code: "invalid_window" }); // would cross midnight
    await deactivateResource(t.db, tenantId, bravo.id);
    expect(await attempt({ resourceId: bravo.id, startTime: "09:00" })).toMatchObject({ code: "resource_unavailable" });
    expect(await attempt({ resourceId: "no-such-crew", startTime: "09:00" })).toMatchObject({ code: "resource_unavailable" });

    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" }, { now: NOW });
    const done = await attempt({ startTime: "09:00" });
    expect(done).toMatchObject({ code: "not_changeable", message: "This visit is completed, so it can't be moved." });

    expect(await getBooking(t.db, tenantId, visit.id)).toMatchObject({ startTime: "10:00", resourceId: alpha.id, sequence: 0 });
    expect(await rescheduleBooking(t.db, tenant("other"), { id: visit.id, date: WED, startTime: "09:00" })).toBeNull();
  });

  it("warns about a tight drive", async () => {
    const { tenantId, alpha, book } = await setUp();
    await book(alpha.id, WED, "08:00", "09:00", { lat: 40.7, lng: -111.9 });
    const visit = await book(alpha.id, WED, "13:00", "14:00", { lat: 40.79, lng: -111.9 }); // ~6 mi, ~12 min at 30 mph
    const moved = await rescheduleBooking(t.db, tenantId, { id: visit.id, date: WED, startTime: "09:20" }, { now: NOW });
    expect(moved?.warnings).toEqual([expect.stringMatching(/^Tight schedule: a \d+ min drive from the 8:00 AM visit into a 20 min gap$/)]);
  });

  it("a pending visit keeps its deadline unless the new start is sooner", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(alpha.id, "2026-03-10", "10:00", "11:00", { status: "pending" });
    expect(visit.pendingExpiresAt?.toISOString()).toBe("2026-03-04T09:00:00.000Z"); // 48 hours from NOW
    const sooner = await rescheduleBooking(t.db, tenantId, { id: visit.id, date: "2026-03-03", startTime: "08:00" }, { now: NOW });
    expect(sooner?.visit).toMatchObject({ status: "pending", pendingExpiresAt: new Date("2026-03-03T08:00:00.000Z") });
  });

  it("an unassigned visit moved without a crew is written unvalidated, as in 0.3", async () => {
    const { tenantId, book } = await setUp();
    const visit = await book(null, WED, "10:00", "11:00");
    const moved = await rescheduleBooking(t.db, tenantId, { id: visit.id, date: "2026-03-07", startTime: "03:00" }, { now: NOW });
    expect(moved?.visit).toMatchObject({ resourceId: null, startTime: "03:00", sequence: 1 });
  });
});

describe("assignBooking", () => {
  it("same time, new crew; validated; no sequence bump; reassigned", async () => {
    const { tenantId, alpha, bravo, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    await book(bravo.id, WED, "10:30", "11:30");
    await expect(assignBooking(t.db, tenantId, { id: visit.id, resourceId: bravo.id }, { now: NOW })).rejects.toMatchObject({
      code: "slot_unavailable",
    });
    const third = await createResource(t.db, { tenantId, name: "Charlie" });
    const recorder = eventRecorder();
    const moved = await assignBooking(t.db, tenantId, { id: visit.id, resourceId: third.id }, { now: NOW, onEvent: recorder.onEvent });
    expect(moved?.visit).toMatchObject({ resourceId: third.id, startTime: "10:00", sequence: 0 });
    expect(recorder.events[0]).toMatchObject({
      type: "visit.reassigned",
      data: { previous: { resourceId: alpha.id, resourceName: "Alpha" }, visit: { resourceName: "Charlie" } },
    });
    // The same crew again is a no-op.
    const again = eventRecorder();
    await assignBooking(t.db, tenantId, { id: visit.id, resourceId: third.id }, { now: NOW, onEvent: again.onEvent });
    expect(again.events).toEqual([]);
  });

  it("an unassigned visit can be given a crew (0.3 couldn't)", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(null, WED, "10:00", "11:00");
    const moved = await assignBooking(t.db, tenantId, { id: visit.id, resourceId: alpha.id }, { now: NOW });
    expect(moved?.visit.resourceId).toBe(alpha.id);
  });

  it("is refused for a visit that isn't pending or confirmed", async () => {
    const { tenantId, alpha, bravo, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "in_progress" }, { now: NOW });
    await expect(assignBooking(t.db, tenantId, { id: visit.id, resourceId: bravo.id }, { now: NOW })).rejects.toMatchObject({
      code: "not_changeable",
      message: "This visit is in progress, so it can't be moved.",
    });
  });
});

describe("updateBookingDetails", () => {
  it("edits the details; unknown keys are dropped; any status; clearing the email revokes the links", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00");
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" }, { now: NOW });
    const edited = await updateBookingDetails(t.db, tenantId, {
      id: visit.id,
      patch: {
        title: "Gutters too",
        customerName: "Dana Doe",
        customerEmail: "",
        customerPhone: "+1 801 555 0100",
        notes: "Gate code 1234",
        estimateId: "est-9",
        serviceType: "window-clean",
        ...({ status: "pending", resourceId: "x", tenantId: "y", sequence: 9 } as object),
      },
    });
    expect(edited?.visit).toMatchObject({
      title: "Gutters too",
      customerName: "Dana Doe",
      customerEmail: null,
      customerPhone: "+1 801 555 0100",
      notes: "Gate code 1234",
      estimateId: "est-9",
      serviceType: "window-clean",
      status: "completed",
      resourceId: alpha.id,
      tenantId,
      // The email changed (to none): every link is revoked and the sequence
      // moves on, so a reminder queued for the old address is skipped (F1).
      sequence: 1,
    });
    expect(edited?.warnings).toEqual([]);
  });

  it("never refuses: an address that makes the drive impossible is recorded, with a heads-up", async () => {
    const { tenantId, alpha, book } = await setUp();
    await book(alpha.id, WED, "08:00", "09:00", { lat: 40.7, lng: -111.9 });
    const visit = await book(alpha.id, WED, "09:30", "10:30", { lat: 40.71, lng: -111.9 });
    const far: MapsProvider = {
      geocodes: true,
      geocode: async () => ({ lat: 41.4, lng: -111.9 }), // ~48 miles: 97 minutes at 30 mph
      driveTime: (o, d) => createHaversineMapsProvider().driveTime(o, d),
    };
    const edited = await updateBookingDetails(t.db, tenantId, { id: visit.id, patch: { address: "1 Far Rd, Ogden" } }, { maps: far, now: NOW });
    expect(edited?.visit).toMatchObject({ address: "1 Far Rd, Ogden", lat: 41.4, lng: -111.9 });
    expect(edited?.warnings).toEqual([expect.stringMatching(/^Heads up: Not enough time to drive from the 8:00 AM visit/)]);
  });

  it("an address the provider can't place clears the old coordinates and says so", async () => {
    const { tenantId, alpha, book } = await setUp();
    const visit = await book(alpha.id, WED, "10:00", "11:00", { lat: 40.7, lng: -111.9, address: "Old St" });
    const broken: MapsProvider = {
      geocode: async () => {
        throw new Error("quota");
      },
      driveTime: async () => null,
    };
    const edited = await updateBookingDetails(t.db, tenantId, { id: visit.id, patch: { address: "New St" } }, { maps: broken, now: NOW });
    expect(edited?.visit).toMatchObject({ address: "New St", lat: null, lng: null });
    expect(edited?.warnings).toEqual(["We couldn't place that address on the map, so drive times will skip this visit."]);
    expect(await updateBookingDetails(t.db, tenant("other"), { id: visit.id, patch: { notes: "x" } })).toBeNull();
  });
});

describe("bookVisit", () => {
  it("geocodes an address before the lock, and a failure books the visit with a warning", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const placed = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00", address: "1 Main St" },
      { maps: { geocode: async () => ({ lat: 40.5, lng: -111.5 }), driveTime: async () => null }, now: NOW },
    );
    expect(placed).toMatchObject({ visit: { lat: 40.5, lng: -111.5, origin: "staff" }, warnings: [] });
    const unplaced = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "12:00", endTime: "13:00", address: "Nowhere" },
      { maps: { geocode: async () => null, driveTime: async () => null }, now: NOW },
    );
    expect(unplaced.visit).toMatchObject({ lat: null, lng: null });
    expect(unplaced.warnings).toEqual(["We couldn't place that address on the map, so drive times will skip this visit."]);
  });

  it("a past date is allowed (back-filling yesterday's job)", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const visit = await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-02-27", startTime: "10:00", endTime: "11:00" }, { now: NOW });
    expect(visit.visit.status).toBe("confirmed");
  });
});
