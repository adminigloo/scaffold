import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignBooking,
  bookVisit,
  cancelVisitByToken,
  createResource,
  expirePendingRequests,
  findPublicSlots,
  getBooking,
  requestPublicBooking,
  rescheduleBooking,
  rescheduleVisitByToken,
  setBookingStatus,
  updateSchedulingSettings,
  type SchedulingEvent,
} from "../index.js";
import { eventRecorder } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The event envelope (section 5): every type from every emitter, exactly as
 * specified; after commit (a listener reads the new state; a rolled-back
 * write tells nobody); contained (a throwing listener never fails the
 * action); no secrets; in order.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectEnvelope(event: SchedulingEvent, tenantId: string) {
  expect(event.id).toMatch(UUID);
  expect(event.tenantId).toBe(tenantId);
  expect(event.visitId).toBe(event.data.visit.id);
  expect(event.occurredAt).toBe(NOW.toISOString());
  expect(Object.keys(event).sort()).toEqual(["actor", "data", "id", "occurredAt", "tenantId", "type", "visitId"]);
  expect(Object.keys(event.actor).sort()).toEqual(["id", "type"]);
}

async function setUp(settings: Parameters<typeof updateSchedulingSettings>[2] = {}) {
  const tenantId = tenant();
  if (Object.keys(settings).length > 0) await updateSchedulingSettings(t.db, tenantId, settings);
  const crew = await createResource(t.db, { tenantId, name: "Crew A" });
  const recorder = eventRecorder();
  const request = async (startTime = "10:00", requesterKey = "ip:203.0.113.7") => {
    const slot = (await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW })).find(
      (s) => s.startTime === startTime,
    )!;
    return requestPublicBooking(
      t.db,
      { tenantId, slotId: slot.slotId, service: "visit", customerName: "Pat Visitor", customerEmail: "pat@example.com" },
      { now: NOW, requesterKey, onEvent: recorder.onEvent },
    );
  };
  return { tenantId, crew, recorder, request };
}

describe("each event type, from each emitter, in the specified envelope", () => {
  it("requested (online, customer) and, auto-confirmed, then confirmed (auto, system) — in that order", async () => {
    const { tenantId, recorder, request } = await setUp({ autoConfirm: true });
    const receipt = await request();
    expect(recorder.types()).toEqual(["visit.requested", "visit.confirmed"]);
    const [requested, confirmed] = recorder.events as [SchedulingEvent, SchedulingEvent];
    expectEnvelope(requested, tenantId);
    expect(requested).toMatchObject({ actor: { type: "customer", id: null }, data: { via: "online", notify: true } });
    expect(confirmed).toMatchObject({ actor: { type: "system", id: null }, data: { via: "auto", notify: true } });
    expect(requested.id).not.toBe(confirmed.id);
    expect(requested.data.visit).toMatchObject({ id: receipt.id, status: "confirmed", origin: "public", resourceName: "Crew A" });
  });

  it("a pending request emits only requested", async () => {
    const { recorder, request } = await setUp();
    await request();
    expect(recorder.types()).toEqual(["visit.requested"]);
    expect(recorder.events[0]?.data.visit.status).toBe("pending");
  });

  it("staff bookings: confirmed (via staff) or requested (via staff)", async () => {
    const { tenantId, crew, recorder } = await setUp();
    const actor = { type: "staff" as const, id: "user-7" };
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "08:00", endTime: "09:00" }, { now: NOW, actor, onEvent: recorder.onEvent });
    await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "14:00", endTime: "15:00", status: "pending" },
      { now: NOW, actor, onEvent: recorder.onEvent },
    );
    expect(recorder.events.map((e) => [e.type, e.data.via, e.actor.id])).toEqual([
      ["visit.confirmed", "staff", "user-7"],
      ["visit.requested", "staff", "user-7"],
    ]);
    for (const event of recorder.events) expectEnvelope(event, tenantId);
  });

  it("setBookingStatus: accept, decline (with reason), cancel, start, complete, restore — and the silent moves", async () => {
    const { tenantId, crew, recorder, request } = await setUp();
    const accepted = await request("08:00");
    const declined = await request("10:00");
    recorder.events.length = 0;
    const move = (id: string, status: string, reason?: string) =>
      setBookingStatus(t.db, tenantId, { id, status: status as "confirmed", ...(reason ? { reason } : {}) }, { now: NOW, onEvent: recorder.onEvent });

    await move(accepted.id, "confirmed");
    await move(declined.id, "declined", "We don't go that far north");
    await move(accepted.id, "in_progress");
    await move(accepted.id, "confirmed"); // started by mistake: silent
    await move(accepted.id, "in_progress");
    await move(accepted.id, "completed");
    await move(accepted.id, "in_progress"); // reopened: silent
    await move(accepted.id, "completed");
    await move(declined.id, "confirmed"); // restore
    await move(declined.id, "no_show"); // silent
    await move(declined.id, "cancelled");
    await move(declined.id, "pending"); // silent revival
    await move(declined.id, "pending"); // re-asserting: no-op

    expect(recorder.events.map((e) => [e.type, e.data.via ?? null, e.data.notify])).toEqual([
      ["visit.confirmed", "accept", true],
      ["visit.declined", null, true],
      ["visit.started", null, false],
      ["visit.started", null, false],
      ["visit.completed", null, false],
      ["visit.completed", null, false],
      ["visit.confirmed", "restore", true],
      ["visit.cancelled", null, true],
    ]);
    expect(recorder.events[1]?.data.reason).toBe("We don't go that far north");
    expect(recorder.events[7]?.data.reason).toBeNull();
    for (const event of recorder.events) expectEnvelope(event, tenantId);
    expect(crew.id).toBeTruthy();
  });

  it("rescheduled and reassigned from staff, rescheduled and cancelled from the customer, expired from the system", async () => {
    const { tenantId, crew, recorder, request } = await setUp();
    const other = await createResource(t.db, { tenantId, name: "Crew B" });
    const mine = await request("10:00");
    const staffVisit = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: NOW })
    ).visit;
    recorder.events.length = 0;

    await rescheduleBooking(t.db, tenantId, { id: staffVisit.id, date: WED, startTime: "15:00" }, { now: NOW, onEvent: recorder.onEvent });
    await assignBooking(t.db, tenantId, { id: staffVisit.id, resourceId: other.id }, { now: NOW, onEvent: recorder.onEvent });
    const own = await findPublicSlots(t.db, { tenantId, manageToken: mine.manageToken, from: "2026-03-05", days: 1 }, { now: NOW });
    await rescheduleVisitByToken(t.db, tenantId, mine.manageToken!, { slotId: own[0]!.slotId }, { now: NOW, onEvent: recorder.onEvent });
    await cancelVisitByToken(t.db, tenantId, mine.manageToken!, { reason: "Found someone else" }, { now: NOW, onEvent: recorder.onEvent });
    const late = await request("11:00", "ip:198.51.100.9");
    recorder.events.length = 0;
    await expirePendingRequests(t.db, tenantId, { now: new Date("2026-03-05T00:00:00Z"), onEvent: recorder.onEvent });

    expect(recorder.types()).toEqual(["visit.expired"]);
    expect(recorder.events[0]).toMatchObject({ visitId: late.id, actor: { type: "system", id: null }, data: { notify: true } });
    expect(recorder.events[0]?.occurredAt).toBe("2026-03-05T00:00:00.000Z");
  });

  it("previous carries the old time and crew", async () => {
    const { tenantId, crew, recorder } = await setUp();
    const other = await createResource(t.db, { tenantId, name: "Crew B" });
    const visit = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: NOW })
    ).visit;
    await rescheduleBooking(
      t.db,
      tenantId,
      { id: visit.id, date: "2026-03-05", startTime: "09:00", resourceId: other.id },
      { now: NOW, onEvent: recorder.onEvent },
    );
    expect(recorder.events[0]?.data.previous).toEqual({
      date: WED,
      startTime: "13:00",
      endTime: "14:00",
      startsAt: `${WED}T13:00:00.000Z`,
      endsAt: `${WED}T14:00:00.000Z`,
      resourceId: crew.id,
      resourceName: "Crew A",
    });
  });
});

describe("the guarantees", () => {
  it("the listener runs after commit: a read inside it sees the new state", async () => {
    const { tenantId, request } = await setUp();
    const receipt = await request();
    const seen: Array<string | undefined> = [];
    await setBookingStatus(t.db, tenantId, { id: receipt.id, status: "confirmed" }, {
      now: NOW,
      onEvent: async (event) => {
        seen.push((await getBooking(t.db, tenantId, event.visitId))?.status);
      },
    });
    expect(seen).toEqual(["confirmed"]);
  });

  it("a refused (rolled-back) write emits nothing", async () => {
    const { tenantId, crew, recorder } = await setUp();
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" }, { now: NOW });
    const other = (
      await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: NOW })
    ).visit;
    await expect(
      rescheduleBooking(t.db, tenantId, { id: other.id, date: WED, startTime: "10:30" }, { now: NOW, onEvent: recorder.onEvent }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" }, { now: NOW, onEvent: recorder.onEvent }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(recorder.events).toEqual([]);
  });

  it("a throwing listener doesn't fail the action, and onEventError gets the error and the event", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const broken = eventRecorder({ fail: true });
    const errors: Array<[unknown, SchedulingEvent]> = [];
    const result = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" },
      { now: NOW, onEvent: broken.onEvent, onEventError: (error, event) => errors.push([error, event]) },
    );
    expect(result.visit.status).toBe("confirmed");
    expect(errors).toHaveLength(1);
    expect((errors[0]?.[0] as Error).message).toBe("listener broke");
    expect(errors[0]?.[1].type).toBe("visit.confirmed");
    // And without an onEventError, still contained.
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "13:00", endTime: "14:00" }, { now: NOW, onEvent: broken.onEvent }),
    ).resolves.toMatchObject({ visit: { status: "confirmed" } });
  });

  it("no manage token, token hash or requester key appears in any event", async () => {
    const { tenantId, recorder, request } = await setUp({ autoConfirm: true });
    const receipt = await request("10:00", "ip:203.0.113.77");
    await cancelVisitByToken(t.db, tenantId, receipt.manageToken!, {}, { now: NOW, onEvent: recorder.onEvent });
    const hashes = (await t.client.query<{ token_hash: string }>(`select token_hash from scheduling_visit_tokens where tenant_id = $1`, [tenantId])).rows;
    const wire = JSON.stringify(recorder.events);
    expect(recorder.events.length).toBe(3);
    expect(wire).not.toContain(receipt.manageToken);
    expect(wire).not.toContain("203.0.113.77");
    expect(wire).not.toMatch(/requesterKey|requester_key|token/i);
    for (const { token_hash } of hashes) expect(wire).not.toContain(token_hash);
  });

  it("no event for a no-op: a repeated request, a re-asserted status", async () => {
    const { tenantId, recorder, request } = await setUp();
    const first = await request();
    // A double click sends the same slot again.
    const { encodeSlotId } = await import("../public.js");
    const again = await requestPublicBooking(
      t.db,
      { tenantId, slotId: encodeSlotId({ date: WED, startTime: "10:00" }), service: "visit", customerName: "Pat Visitor", customerEmail: "pat@example.com" },
      { now: NOW, requesterKey: "ip:203.0.113.7", onEvent: recorder.onEvent },
    );
    expect(again).toMatchObject({ id: first.id, repeated: true });
    await setBookingStatus(t.db, tenantId, { id: first.id, status: "pending" }, { now: NOW, onEvent: recorder.onEvent });
    expect(recorder.types()).toEqual(["visit.requested"]);
  });
});
