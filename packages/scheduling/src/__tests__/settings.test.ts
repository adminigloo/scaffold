import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DEFAULT_SCHEDULING_SETTINGS,
  createBooking,
  createResource,
  getBooking,
  getSchedulingSettings,
  schedulingSettings,
  setBookingStatus,
  settingsToPolicy,
  updateSchedulingSettings,
  type UpdateSchedulingSettingsInput,
} from "../index.js";
import { eventRecorder } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * A business's settings: the defaults without a row, a partial upsert, every
 * range the settings screen can't save, and the one write with consequences —
 * changing the time zone keeps every visit at its wall-clock time.
 */

const NOW = new Date("2026-03-02T09:00:00Z"); // Monday

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("reading settings", () => {
  it("a tenant that never saved any reads the defaults, and reading writes nothing", async () => {
    const tenantId = tenant();
    const settings = await getSchedulingSettings(t.db, tenantId);
    expect(settings).toMatchObject({
      ...DEFAULT_SCHEDULING_SETTINGS,
      tenantId,
      saved: false,
      updatedAt: null,
      timeZone: "UTC",
      services: [{ key: "visit", name: "Visit", durationMinutes: 60 }],
    });
    expect(await t.db.select().from(schedulingSettings)).toEqual([]);
  });
});

describe("updateSchedulingSettings", () => {
  it("upserts, and a patch changes only the keys it names", async () => {
    const tenantId = tenant();
    const first = await updateSchedulingSettings(t.db, tenantId, { businessName: "Acme Windows", autoConfirm: true });
    expect(first).toMatchObject({ saved: true, businessName: "Acme Windows", autoConfirm: true, timeZone: "UTC" });
    expect(first.updatedAt).toBeInstanceOf(Date);

    const second = await updateSchedulingSettings(t.db, tenantId, {
      timeZone: "America/Denver",
      contactPhone: "(801) 555-0143",
      contactEmail: "",
      ...({ tenantId: "someone-else", saved: false, bogus: 1 } as object),
    });
    expect(second).toMatchObject({
      tenantId,
      businessName: "Acme Windows",
      autoConfirm: true,
      timeZone: "America/Denver",
      contactPhone: "(801) 555-0143",
      contactEmail: null, // a blank field means none
      saved: true,
    });
    expect(await getSchedulingSettings(t.db, tenantId)).toMatchObject({ businessName: "Acme Windows" });
    expect(await getSchedulingSettings(t.db, "someone-else")).toMatchObject({ saved: false });
  });

  const refusals: Array<[string, UpdateSchedulingSettingsInput, Array<string | number>]> = [
    ["a zone that isn't one", { timeZone: "Mountain" }, ["timeZone"]],
    ["an offset instead of a zone", { timeZone: "+05:30" }, ["timeZone"]],
    ["a 121-character name", { businessName: "x".repeat(121) }, ["businessName"]],
    ["a contact email that isn't one", { contactEmail: "nope" }, ["contactEmail"]],
    ["a 41-character phone", { contactPhone: "1".repeat(41) }, ["contactPhone"]],
    ["six staff addresses", { staffNotifyEmails: ["a@x.co", "b@x.co", "c@x.co", "d@x.co", "e@x.co", "f@x.co"] }, ["staffNotifyEmails"]],
    ["a staff address that isn't one", { staffNotifyEmails: ["office"] }, ["staffNotifyEmails", 0]],
    ["no services", { services: [] }, ["services"]],
    ["21 services", { services: Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, name: "S", durationMinutes: 60 })) }, ["services"]],
    ["a 10-minute service", { services: [{ key: "quick", name: "Quick", durationMinutes: 10 }] }, ["services", 0, "durationMinutes"]],
    ["a 62-minute service", { services: [{ key: "odd", name: "Odd", durationMinutes: 62 }] }, ["services", 0, "durationMinutes"]],
    ["a 725-minute service", { services: [{ key: "long", name: "Long", durationMinutes: 725 }] }, ["services", 0, "durationMinutes"]],
    ["a key with spaces", { services: [{ key: "Window Clean", name: "W", durationMinutes: 60 }] }, ["services", 0, "key"]],
    ["a service with no name", { services: [{ key: "w", name: " ", durationMinutes: 60 }] }, ["services", 0, "name"]],
    ["a 7-minute grid", { slotStepMinutes: 7 }, ["slotStepMinutes"]],
    ["a 245-minute grid", { slotStepMinutes: 245 }, ["slotStepMinutes"]],
    ["negative notice", { minNoticeMinutes: -1 }, ["minNoticeMinutes"]],
    ["31 days' notice", { minNoticeMinutes: 43201 }, ["minNoticeMinutes"]],
    ["a zero horizon", { horizonDays: 0 }, ["horizonDays"]],
    ["a 366-day horizon", { horizonDays: 366 }, ["horizonDays"]],
    ["a 241-minute buffer", { travelBufferMinutes: 241 }, ["travelBufferMinutes"]],
    ["0 slots a day", { maxSlotsPerDay: 0 }, ["maxSlotsPerDay"]],
    ["101 slots a day", { maxSlotsPerDay: 101 }, ["maxSlotsPerDay"]],
    ["0 open requests", { maxOpenRequestsPerRequester: 0 }, ["maxOpenRequestsPerRequester"]],
    ["51 open requests", { maxOpenRequestsPerRequester: 51 }, ["maxOpenRequestsPerRequester"]],
    ["requests that never expire", { pendingExpiryHours: 0 }, ["pendingExpiryHours"]],
    ["a 721-hour expiry", { pendingExpiryHours: 721 }, ["pendingExpiryHours"]],
    ["a reminder a week and an hour ahead", { reminderLeadHours: 169 }, ["reminderLeadHours"]],
    ["a 169-hour cutoff", { cancelCutoffHours: 169 }, ["cancelCutoffHours"]],
    ["a fractional hour", { cancelCutoffHours: 1.5 }, ["cancelCutoffHours"]],
  ];
  for (const [what, patch, path] of refusals) {
    it(`refuses ${what}, with the field's path, and saves nothing`, async () => {
      const tenantId = tenant();
      const error = await updateSchedulingSettings(t.db, tenantId, patch).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues.map((issue) => issue.path)).toContainEqual(path);
      expect((await getSchedulingSettings(t.db, tenantId)).saved).toBe(false);
    });
  }

  it('a bad zone reads "Pick a time zone from the list."', async () => {
    const error = (await updateSchedulingSettings(t.db, tenant(), { timeZone: "Mountain" }).catch((e: unknown) => e)) as ZodError;
    expect(error.issues[0]?.message).toBe("Pick a time zone from the list.");
  });

  it("refuses two services with one key, pointing at the second", async () => {
    const error = (await updateSchedulingSettings(t.db, tenant(), {
      services: [
        { key: "estimate", name: "Free estimate", durationMinutes: 60 },
        { key: "estimate", name: "Estimate again", durationMinutes: 30 },
      ],
    }).catch((e: unknown) => e)) as ZodError;
    expect(error).toBeInstanceOf(ZodError);
    expect(error.issues.map((issue) => issue.path)).toContainEqual(["services", 1, "key"]);
  });

  it("settingsToPolicy: the distinct service lengths in order, auto-confirm as the landing status", () => {
    const policy = settingsToPolicy({
      ...DEFAULT_SCHEDULING_SETTINGS,
      autoConfirm: true,
      maxSlotsPerDay: 4,
      services: [
        { key: "clean", name: "Clean", durationMinutes: 120 },
        { key: "estimate", name: "Estimate", durationMinutes: 60 },
        { key: "touch-up", name: "Touch-up", durationMinutes: 60 },
      ],
    });
    expect(policy).toEqual({
      minNoticeMinutes: 1440,
      horizonDays: 30,
      slotStepMinutes: 30,
      durationsMinutes: [60, 120],
      requestStatus: "confirmed",
      maxSlotsPerDay: 4,
      travelBufferMinutes: 30,
      maxOpenRequestsPerRequester: 3,
      requireAddress: false,
    });
  });
});

describe("changing the time zone keeps every visit at its wall-clock time", () => {
  it("re-derives instants for upcoming visits, bumps their sequence, and emits quiet time_zone reschedules", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const book = (date: string, startTime: string, endTime: string, status: "pending" | "confirmed" = "confirmed") =>
      createBooking(
        t.db,
        { tenantId, resourceId: crew.id, scheduledDate: date, startTime, endTime, status, customerEmail: "c@example.com" },
        { now: NOW },
      );
    const confirmed = await book("2026-03-04", "10:00", "11:00"); // Wednesday
    const pending = await book("2026-03-05", "09:00", "10:00", "pending"); // Thursday
    const started = await book("2026-03-03", "13:00", "14:00"); // Tuesday
    await setBookingStatus(t.db, tenantId, { id: started.id, status: "in_progress" }, { now: NOW });
    const yesterday = await book("2026-02-27", "10:00", "11:00"); // a back-filled visit, in the past
    const done = await book("2026-03-06", "10:00", "11:00");
    await setBookingStatus(t.db, tenantId, { id: done.id, status: "completed" }, { now: NOW });
    const cancelled = await book("2026-03-06", "13:00", "14:00");
    await setBookingStatus(t.db, tenantId, { id: cancelled.id, status: "cancelled" }, { now: NOW });

    expect(confirmed.startsAt?.toISOString()).toBe("2026-03-04T10:00:00.000Z"); // UTC, the default
    const recorder = eventRecorder();
    await updateSchedulingSettings(
      t.db,
      tenantId,
      { timeZone: "America/Denver" },
      { now: NOW, onEvent: recorder.onEvent, actor: { type: "staff", id: "owner-1" } },
    );

    const after = async (id: string) => (await getBooking(t.db, tenantId, id))!;
    // Denver is UTC−7 in early March (before the 8th): the same 10:00 is 17:00Z.
    expect(await after(confirmed.id)).toMatchObject({
      startTime: "10:00",
      endTime: "11:00",
      startsAt: new Date("2026-03-04T17:00:00.000Z"),
      endsAt: new Date("2026-03-04T18:00:00.000Z"),
      sequence: 1,
    });
    const movedPending = await after(pending.id);
    expect(movedPending.startsAt?.toISOString()).toBe("2026-03-05T16:00:00.000Z");
    // Its deadline stays the earlier of the old one and the new start.
    expect(movedPending.pendingExpiresAt?.toISOString()).toBe(pending.pendingExpiresAt?.toISOString());
    expect(movedPending.sequence).toBe(1);
    expect((await after(started.id)).startsAt?.toISOString()).toBe("2026-03-03T20:00:00.000Z");
    expect((await after(yesterday.id)).startsAt?.toISOString()).toBe("2026-02-27T17:00:00.000Z");
    // Done and cancelled visits are history: left as they were.
    expect(await after(done.id)).toMatchObject({ startsAt: new Date("2026-03-06T10:00:00.000Z"), sequence: 0 });
    expect(await after(cancelled.id)).toMatchObject({ startsAt: new Date("2026-03-06T13:00:00.000Z"), sequence: 1 });

    // Only visits still ahead are announced, quietly.
    expect(recorder.events.map((e) => e.visitId).sort()).toEqual([confirmed.id, pending.id, started.id].sort());
    for (const event of recorder.events) {
      expect(event).toMatchObject({
        type: "visit.rescheduled",
        tenantId,
        actor: { type: "staff", id: "owner-1" },
        data: { notify: false, via: "time_zone" },
      });
      expect(event.data.visit.timeZone).toBe("America/Denver");
      expect(event.data.previous?.startTime).toBe(event.data.visit.startTime);
    }
    const wednesday = recorder.events.find((e) => e.visitId === confirmed.id)!;
    expect(wednesday.data.previous?.startsAt).toBe("2026-03-04T10:00:00.000Z");
    expect(wednesday.data.visit.startsAt).toBe("2026-03-04T17:00:00.000Z");
  });

  it("saving the same zone again moves nothing", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver" });
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const visit = await createBooking(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-03-04", startTime: "10:00", endTime: "11:00" });
    const recorder = eventRecorder();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver", businessName: "Acme" }, { now: NOW, onEvent: recorder.onEvent });
    expect(recorder.events).toEqual([]);
    expect((await getBooking(t.db, tenantId, visit.id))?.sequence).toBe(0);
  });
});
