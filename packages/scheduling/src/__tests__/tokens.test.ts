import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelVisitByToken,
  createResource,
  findPublicSlots,
  getBooking,
  getVisitByToken,
  issueManageToken,
  requestPublicBooking,
  rescheduleVisitByToken,
  setBookingStatus,
  updateSchedulingSettings,
} from "../index.js";
import { eventRecorder } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Manage tokens: the customer's key to their own visit. Only hashes are
 * stored; many tokens open one visit; the change cutoff is exact; a move may
 * land right next to the visit's own time; a closed booking page still lets a
 * customer cancel.
 *
 * NOW is Monday 2026-03-02 09:00 UTC. Wednesday's visits start 48+ hours out.
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

async function booked(options: { startTime?: string; settings?: Parameters<typeof updateSchedulingSettings>[2] } = {}) {
  const tenantId = tenant();
  if (options.settings) await updateSchedulingSettings(t.db, tenantId, options.settings);
  await createResource(t.db, { tenantId, name: "Crew" });
  const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
  const slot = slots.find((s) => s.startTime === (options.startTime ?? "10:00"))!;
  const receipt = await requestPublicBooking(
    t.db,
    { tenantId, slotId: slot.slotId, service: "visit", customerName: "Pat", customerEmail: "pat@example.com", address: "1 Main St" },
    { now: NOW, requesterKey: "ip:203.0.113.7" },
  );
  return { tenantId, receipt, token: receipt.manageToken! };
}

describe("no plaintext token is stored anywhere", () => {
  it("scans every text and jsonb column of every table", async () => {
    const { tenantId, receipt, token } = await booked();
    const second = (await issueManageToken(t.db, tenantId, receipt.id))!;
    const columns = (
      await t.client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and data_type in ('text', 'jsonb', 'character varying')`,
      )
    ).rows;
    expect(columns.length).toBeGreaterThan(20);
    for (const secret of [token, second]) {
      for (const { table_name, column_name } of columns) {
        const hits = await t.client.query(
          `select 1 from "${table_name}" where "${column_name}"::text like $1 limit 1`,
          [`%${secret}%`],
        );
        expect(hits.rows, `${table_name}.${column_name}`).toEqual([]);
      }
    }
  });
});

describe("opening a visit by token", () => {
  it("several tokens open one visit; another tenant's token, a junk one and an unknown one open nothing", async () => {
    const { tenantId, receipt, token } = await booked();
    const fromAccept = (await issueManageToken(t.db, tenantId, receipt.id))!;
    const fromReminder = (await issueManageToken(t.db, tenantId, receipt.id))!;
    expect(new Set([token, fromAccept, fromReminder]).size).toBe(3);
    for (const key of [token, fromAccept, fromReminder]) {
      expect(await getVisitByToken(t.db, tenantId, key, { now: NOW })).toMatchObject({
        status: "requested",
        date: WED,
        startTime: "10:00",
        serviceName: "Visit",
        customerName: "Pat",
      });
    }
    const other = await booked();
    expect(await getVisitByToken(t.db, tenantId, other.token, { now: NOW })).toBeNull();
    expect(await getVisitByToken(t.db, other.tenantId, token, { now: NOW })).toBeNull();
    expect(await getVisitByToken(t.db, tenantId, "not a token!", { now: NOW })).toBeNull();
    expect(await getVisitByToken(t.db, tenantId, "A".repeat(43), { now: NOW })).toBeNull();
    expect(await issueManageToken(t.db, tenant("nobody"), receipt.id)).toBeNull();
  });

  it("the customer's view carries nothing about the crew or the requester", async () => {
    const { tenantId, token } = await booked();
    const visit = (await getVisitByToken(t.db, tenantId, token, { now: NOW }))!;
    expect(Object.keys(visit).sort()).toEqual(
      [
        "address", "businessName", "canCancel", "canReschedule", "cancelCutoffHours", "cancelledBy", "changeDeadline",
        "contactEmail", "contactPhone", "customerName", "date", "durationMinutes", "endTime", "endsAt",
        "googleCalendarUrl", "serviceKey", "serviceName", "startTime", "startsAt", "status", "timeZone",
      ].sort(),
    );
    expect(JSON.stringify(visit)).not.toMatch(/203\.0\.113\.7|resourceId|Crew/);
  });
});

describe("the change cutoff", () => {
  it("is exact: a millisecond before startsAt − cutoff the visit can change; at it, it can't", async () => {
    const { tenantId, token } = await booked({ settings: { contactPhone: "(801) 555-0143" } });
    const startsAt = new Date(`${WED}T10:00:00Z`);
    const deadline = new Date(startsAt.getTime() - 24 * 3_600_000);
    const before = await getVisitByToken(t.db, tenantId, token, { now: new Date(deadline.getTime() - 1) });
    expect(before).toMatchObject({ canCancel: true, canReschedule: true, changeDeadline: deadline.toISOString() });
    const at = await getVisitByToken(t.db, tenantId, token, { now: deadline });
    expect(at).toMatchObject({ canCancel: false, canReschedule: false, changeDeadline: deadline.toISOString() });

    const refusal = await cancelVisitByToken(t.db, tenantId, token, {}, { now: deadline }).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "too_late" });
    expect((refusal as Error).message).toBe(
      "This visit starts within 24 hours, so it can't be changed online. Call us at (801) 555-0143.",
    );
    expect((await cancelVisitByToken(t.db, tenantId, token, {}, { now: new Date(deadline.getTime() - 1) }))?.status).toBe(
      "cancelled",
    );
  });

  it("with a cutoff of 0 a visit can change right up to its start", async () => {
    // Auto-confirmed: an unanswered REQUEST lapses at its deadline (48 hours
    // after it was made, here before the start) and can't be changed after
    // that (F3), which is not what this test is about.
    const { tenantId, token } = await booked({ settings: { cancelCutoffHours: 0, autoConfirm: true } });
    const startsAt = new Date(`${WED}T10:00:00Z`);
    expect(await getVisitByToken(t.db, tenantId, token, { now: new Date(startsAt.getTime() - 1) })).toMatchObject({ canCancel: true });
    expect(await getVisitByToken(t.db, tenantId, token, { now: startsAt })).toMatchObject({ canCancel: false });
  });

  it("a visit that is done can't be changed online, whatever the clock", async () => {
    const { tenantId, receipt, token } = await booked();
    await setBookingStatus(t.db, tenantId, { id: receipt.id, status: "declined" }, { now: NOW });
    expect(await getVisitByToken(t.db, tenantId, token, { now: NOW })).toMatchObject({
      status: "declined",
      canCancel: false,
      changeDeadline: null,
      googleCalendarUrl: null,
      cancelledBy: "business",
    });
    await expect(cancelVisitByToken(t.db, tenantId, token, {}, { now: NOW })).rejects.toMatchObject({ code: "too_late" });
  });
});

describe("cancelling", () => {
  it("is idempotent: the second cancel returns the visit unchanged, with no second event", async () => {
    const { tenantId, receipt, token } = await booked();
    const recorder = eventRecorder();
    const first = await cancelVisitByToken(t.db, tenantId, token, { reason: "Moving house" }, { now: NOW, onEvent: recorder.onEvent });
    expect(first).toMatchObject({ status: "cancelled", cancelledBy: "customer", canCancel: false });
    const second = await cancelVisitByToken(t.db, tenantId, token, {}, { now: NOW, onEvent: recorder.onEvent });
    expect(second).toEqual(first);
    expect(recorder.types()).toEqual(["visit.cancelled"]);
    expect(recorder.events[0]).toMatchObject({ actor: { type: "customer" }, data: { reason: "Moving house" } });
    expect(await getBooking(t.db, tenantId, receipt.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "customer",
      cancelReason: "Moving house",
      sequence: 1,
      pendingExpiresAt: null,
    });
  });
});

describe("rescheduling", () => {
  it("may land right next to the visit's own time: its own visit isn't in its way", async () => {
    const { tenantId, receipt, token } = await booked();
    // To anybody else, 10:00–11:00 plus the 30-minute buffer blocks 09:30 to 11:00.
    const others = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    expect(others.some((s) => s.startTime === "10:30")).toBe(false);
    const own = await findPublicSlots(t.db, { tenantId, manageToken: token, from: WED, days: 1 }, { now: NOW });
    const next = own.find((s) => s.startTime === "10:30")!;
    expect(next).toBeDefined();
    const recorder = eventRecorder();
    const moved = await rescheduleVisitByToken(t.db, tenantId, token, { slotId: next.slotId }, { now: NOW, onEvent: recorder.onEvent });
    expect(moved).toMatchObject({ status: "requested", startTime: "10:30", endTime: "11:30" });
    const row = (await getBooking(t.db, tenantId, receipt.id))!;
    expect(row).toMatchObject({ id: receipt.id, status: "pending", sequence: 1 });
    expect(recorder.events[0]).toMatchObject({
      type: "visit.rescheduled",
      actor: { type: "customer", id: null },
      data: { previous: { startTime: "10:00" }, visit: { startTime: "10:30" } },
    });
  });

  it("a token that opens nothing is ignored by the offer — the same answer as no token", async () => {
    const { tenantId } = await booked();
    await expect(
      findPublicSlots(t.db, { tenantId, manageToken: "A".repeat(43), from: WED, days: 1 }, { now: NOW }),
    ).rejects.toMatchObject({ name: "ZodError" }); // no service either: nothing to offer
    const withService = await findPublicSlots(
      t.db,
      { tenantId, service: "visit", manageToken: "A".repeat(43), from: WED, days: 1 },
      { now: NOW },
    );
    expect(withService).toEqual(await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW }));
  });

  it("a confirmed visit stays confirmed; a slot the offer doesn't hold is refused", async () => {
    const { tenantId, receipt, token } = await booked();
    await setBookingStatus(t.db, tenantId, { id: receipt.id, status: "confirmed" }, { now: NOW });
    const own = await findPublicSlots(t.db, { tenantId, manageToken: token, from: "2026-03-05", days: 1 }, { now: NOW });
    const moved = await rescheduleVisitByToken(t.db, tenantId, token, { slotId: own[0]!.slotId }, { now: NOW });
    expect(moved).toMatchObject({ status: "confirmed", date: "2026-03-05" });
    const { encodeSlotId } = await import("../public.js");
    await expect(
      rescheduleVisitByToken(t.db, tenantId, token, { slotId: encodeSlotId({ date: "2026-03-05", startTime: "03:00" }) }, { now: NOW }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(
      rescheduleVisitByToken(t.db, tenantId, token, { slotId: encodeSlotId({ date: "2026-03-02", startTime: "15:00" }) }, { now: NOW }),
    ).rejects.toMatchObject({ code: "too_soon" });
  });

  it("booking_closed blocks a reschedule but not a cancel", async () => {
    const { tenantId, token } = await booked();
    const own = await findPublicSlots(t.db, { tenantId, manageToken: token, from: "2026-03-05", days: 1 }, { now: NOW });
    await updateSchedulingSettings(t.db, tenantId, { publicBookingEnabled: false });
    expect(await getVisitByToken(t.db, tenantId, token, { now: NOW })).toMatchObject({ canReschedule: false, canCancel: true });
    await expect(
      rescheduleVisitByToken(t.db, tenantId, token, { slotId: own[0]!.slotId }, { now: NOW }),
    ).rejects.toMatchObject({ code: "booking_closed" });
    expect((await cancelVisitByToken(t.db, tenantId, token, {}, { now: NOW }))?.status).toBe("cancelled");
  });

  it("a moved-from visit can't be moved inside the cutoff", async () => {
    const { tenantId, token } = await booked();
    const own = await findPublicSlots(t.db, { tenantId, manageToken: token, from: "2026-03-05", days: 1 }, { now: NOW });
    const late = new Date(`${WED}T09:30:00Z`);
    await expect(rescheduleVisitByToken(t.db, tenantId, token, { slotId: own[0]!.slotId }, { now: late })).rejects.toMatchObject({
      code: "too_late",
    });
  });
});
