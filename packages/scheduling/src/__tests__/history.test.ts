import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookVisit,
  createResource,
  createSchedulingAdminHandlers,
  getSchedulingSettings,
  schedulingAlertsFor,
  schedulingBookings,
  schedulingPermissions,
  setAvailability,
  setBookingStatus,
  updateSchedulingSettings,
  type SchedulingEvent,
} from "../index.js";
import { apiRequest, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * PAST RECORDS WITH THEIR REAL DATES (scheduling 0.7): a visit booked on an
 * earlier day keeps that day as when it was booked (and records when and by
 * whom it was entered), a past "done" or "cancelled" keeps its own day, and
 * none of it tells the customer, alerts the crew, or is held to today's
 * hours. Future dates, dates before 2000 and a status before the booking are
 * refused, naming the field.
 */

const NOW = new Date("2026-10-20T15:00:00.000Z");
const STAFF = { type: "staff" as const, id: "u-sam" };
const HREFS = { visit: "/app/schedule?date={date}&visit={id}", crewDay: "/app/schedule/today" };
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function company() {
  const tenantId = tenant("acme");
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    services: [{ key: "clean", name: "Window cleaning", durationMinutes: 60 }],
  });
  const crew = await createResource(t.db, { tenantId, name: "Crew A", userId: "user-cam" });
  return { tenantId, crewId: crew.id };
}

async function issuesOf(p: Promise<unknown>): Promise<{ path: (string | number)[]; message: string }[]> {
  try {
    await p;
  } catch (error) {
    return ((error as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? []).map((i) => ({ path: i.path, message: i.message }));
  }
  throw new Error("expected a refusal");
}

describe("bookVisit with bookedAt, setBookingStatus with occurredAt", () => {
  it("keeps the real days, records when it was entered, tells nobody and alerts nobody", async () => {
    const { tenantId, crewId } = await company();
    const events: SchedulingEvent[] = [];
    const onEvent = (e: SchedulingEvent) => void events.push(e);
    // A Sunday at 6 am: outside any hours today's rules would allow. It happened.
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crewId, serviceType: "clean", customerName: "Pat Lee", scheduledDate: "2025-05-11", startTime: "06:00", endTime: "07:00" },
      { now: NOW, actor: STAFF, onEvent, notify: true, bookedAt: "2025-05-02" },
    );
    expect(visit.createdAt.toISOString()).toBe("2025-05-02T18:00:00.000Z");
    expect(visit.enteredAt?.toISOString()).toBe(NOW.toISOString());
    expect(visit.enteredBy).toBe("u-sam");
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" }, { now: NOW, actor: STAFF, onEvent, occurredAt: "2025-05-11T14:00:00Z" })).toBe(
      true,
    );
    const [row] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, visit.id));
    expect(row!.completedAt?.toISOString()).toBe("2025-05-11T14:00:00.000Z");
    expect(events.map((e) => [e.type, e.occurredAt, e.data.notify, e.enteredLater])).toEqual([
      ["visit.confirmed", "2025-05-02T18:00:00.000Z", false, true],
      ["visit.completed", "2025-05-11T14:00:00.000Z", false, true],
    ]);
    for (const event of events) expect(await schedulingAlertsFor(t.db, event, { hrefs: HREFS, now: NOW })).toEqual([]);
  });

  it("refuses a future day, one before 2000 and a status before the booking; another company's visit isn't found", async () => {
    const { tenantId, crewId } = await company();
    const input = { tenantId, resourceId: crewId, scheduledDate: "2025-05-11", startTime: "09:00", endTime: "10:00" };
    expect(await issuesOf(bookVisit(t.db, input, { now: NOW, actor: STAFF, bookedAt: "2026-11-01" }))).toEqual([
      { path: ["bookedAt"], message: "That date is in the future. Enter the day it really happened." },
    ]);
    expect(await issuesOf(bookVisit(t.db, input, { now: NOW, actor: STAFF, bookedAt: "1999-01-01" }))).toEqual([
      { path: ["bookedAt"], message: "That date is before 2000. Check the year." },
    ]);
    const { visit } = await bookVisit(t.db, input, { now: NOW, actor: STAFF, bookedAt: "2025-05-02" });
    expect(await issuesOf(setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" }, { now: NOW, occurredAt: "2025-04-01" }))).toEqual([
      { path: ["occurredAt"], message: "That's before the visit was booked (2025-05-02)." },
    ]);
    const other = await company();
    expect(await setBookingStatus(t.db, other.tenantId, { id: visit.id, status: "cancelled" }, { now: NOW, occurredAt: "2025-05-05" })).toBe(false);
    const [row] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, visit.id));
    expect(row!.status).toBe("confirmed");
  });
});

describe("the staff routes take past dates", () => {
  it("POST visits with bookedAt and POST visits/{id}/status with occurredAt", async () => {
    const { tenantId, crewId } = await company();
    const admin = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-sam" }), now: () => NOW });
    const created = await admin.handle(
      apiRequest("POST", "/v1/admin/visits", { resourceId: crewId, date: "2025-05-11", startTime: "06:00", service: "clean", bookedAt: "2025-05-02" }),
    );
    expect(created.status).toBe(201);
    const visit = (await readJson(created)).visit;
    const done = await admin.handle(apiRequest("POST", `/v1/admin/visits/${visit.id}/status`, { status: "completed", occurredAt: "2025-05-11" }));
    expect(done.status).toBe(200);
    const [row] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, visit.id));
    expect(row!.createdAt.toISOString()).toBe("2025-05-02T18:00:00.000Z");
    expect(row!.completedAt?.toISOString()).toBe("2025-05-11T18:00:00.000Z");
    const future = await admin.handle(apiRequest("POST", "/v1/admin/visits", { resourceId: crewId, date: "2025-05-12", startTime: "09:00", bookedAt: "2030-01-01" }));
    expect(future.status).toBe(400);
  });
});

describe("a booked-on date makes a visit history only when the visit is over (review: bookedAt double-booked a future slot)", () => {
  // Four days after NOW, in Denver.
  const DAY = "2026-10-24";
  async function crewWithHours() {
    const { tenantId, crewId } = await company();
    await setAvailability(t.db, {
      tenantId,
      resourceId: crewId,
      blocks: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: "08:00", endTime: "17:00" })),
    });
    return { tenantId, crewId };
  }
  async function attempt(p: Promise<{ visit: { status: string } }>): Promise<string> {
    try {
      return `BOOKED ${(await p).visit.status}`;
    } catch (error) {
      return `REFUSED ${(error as { code?: string }).code ?? (error as Error).message}`;
    }
  }

  it("a future visit with a booked-on date is checked like any booking: a taken slot and 2 am are refused", async () => {
    const { tenantId, crewId } = await crewWithHours();
    const at = (startTime: string, endTime: string) => ({ tenantId, resourceId: crewId, scheduledDate: DAY, startTime, endTime });
    // NEGATIVE CONTROL: without a booked-on date, the ordinary checks refuse both.
    expect(await attempt(bookVisit(t.db, at("10:00", "11:00"), { now: NOW, actor: STAFF }))).toBe("BOOKED confirmed");
    expect(await attempt(bookVisit(t.db, at("10:00", "11:00"), { now: NOW, actor: STAFF }))).toBe("REFUSED slot_unavailable");
    expect(await attempt(bookVisit(t.db, at("02:00", "03:00"), { now: NOW, actor: STAFF }))).toBe("REFUSED outside_hours");
    // With one, the same checks hold.
    expect(await attempt(bookVisit(t.db, at("10:00", "11:00"), { now: NOW, actor: STAFF, bookedAt: "2026-01-05" }))).toBe("REFUSED slot_unavailable");
    expect(await attempt(bookVisit(t.db, at("02:00", "03:00"), { now: NOW, actor: STAFF, bookedAt: "2026-01-05" }))).toBe("REFUSED outside_hours");
    const rows = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.tenantId, tenantId));
    expect(rows).toHaveLength(1);
  });

  it("a future visit booked earlier keeps its booked-on day, and the customer is told as usual", async () => {
    const { tenantId, crewId } = await crewWithHours();
    const events: SchedulingEvent[] = [];
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crewId, customerName: "Pat Lee", customerEmail: "pat@example.test", scheduledDate: DAY, startTime: "13:00", endTime: "14:00" },
      { now: NOW, actor: STAFF, onEvent: (e) => void events.push(e), bookedAt: "2026-10-01" },
    );
    expect(visit.createdAt.toISOString()).toBe("2026-10-01T18:00:00.000Z");
    expect(visit.enteredAt?.toISOString()).toBe(NOW.toISOString());
    expect(events.map((e) => [e.type, e.occurredAt, e.enteredLater ?? null])).toEqual([["visit.confirmed", NOW.toISOString(), null]]);
    expect(events[0]?.data.notify).not.toBe(false);
  });

  it("the staff route refuses a booked-on date that would put a second visit in a taken slot", async () => {
    const { tenantId, crewId } = await crewWithHours();
    const admin = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-sam" }), now: () => NOW });
    const body = { resourceId: crewId, date: DAY, startTime: "10:00", endTime: "11:00" };
    expect((await admin.handle(apiRequest("POST", "/v1/admin/visits", body))).status).toBe(201);
    expect((await admin.handle(apiRequest("POST", "/v1/admin/visits", { ...body, bookedAt: "2026-01-05" }))).status).toBe(409);
  });

  it("putting a cancelled future visit back with a past date re-claims its slot (refused when it's taken)", async () => {
    const { tenantId, crewId } = await crewWithHours();
    const at = { tenantId, resourceId: crewId, scheduledDate: DAY, startTime: "10:00", endTime: "11:00" };
    const { visit } = await bookVisit(t.db, at, { now: NOW, actor: STAFF });
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" }, { now: NOW, actor: STAFF })).toBe(true);
    await bookVisit(t.db, at, { now: NOW, actor: STAFF });
    await expect(
      setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" }, { now: NOW, actor: STAFF, occurredAt: "2026-10-20" }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("done is never dated before the visit starts", async () => {
    const { tenantId, crewId } = await company();
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crewId, scheduledDate: "2025-05-11", startTime: "09:00", endTime: "10:00" },
      { now: NOW, actor: STAFF, bookedAt: "2025-05-02" },
    );
    expect(await issuesOf(setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" }, { now: NOW, occurredAt: "2025-05-05" }))).toEqual([
      { path: ["occurredAt"], message: "That's before the visit starts (2025-05-11)." },
    ]);
    // The visit's own day is fine: done that afternoon, never before 09:00.
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" }, { now: NOW, occurredAt: "2025-05-11" })).toBe(true);
    const [row] = await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.id, visit.id));
    expect(row!.completedAt!.getTime()).toBeGreaterThanOrEqual(row!.startsAt!.getTime());
  });
});

describe("a day is the company's day (review: '2025-06-14' was saved as UTC midnight)", () => {
  const dayIn = (instant: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);

  it("America/Denver: booked on the 2nd reads the 2nd there (UTC midnight read the 1st)", async () => {
    const { tenantId, crewId } = await company();
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crewId, scheduledDate: "2025-05-11", startTime: "09:00", endTime: "10:00" },
      { now: NOW, actor: STAFF, bookedAt: "2025-05-02" },
    );
    expect(dayIn(visit.createdAt, "America/Denver")).toBe("2025-05-02");
    expect(dayIn(new Date("2025-05-02T00:00:00Z"), "America/Denver")).toBe("2025-05-01");
  });

  it("Asia/Tokyo: today's date in the Tokyo morning is today, not 'in the future'", async () => {
    const tenantId = tenant("tokyo");
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "Asia/Tokyo", businessName: "Tokyo Glass" });
    expect((await getSchedulingSettings(t.db, tenantId)).timeZone).toBe("Asia/Tokyo");
    const crew = await createResource(t.db, { tenantId, name: "Crew T" });
    const morning = new Date("2026-10-20T23:30:00Z"); // 08:30 on the 21st in Tokyo
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-10-20", startTime: "09:00", endTime: "10:00" },
      { now: morning, actor: STAFF, bookedAt: "2026-10-21" },
    );
    expect(dayIn(visit.createdAt, "Asia/Tokyo")).toBe("2026-10-21");
    expect(visit.createdAt.getTime()).toBeLessThanOrEqual(morning.getTime());
  });
});

describe("a past date needs its own permission; the visit says it was entered later", () => {
  it("without schedule.history a dated visit or status is refused; the same without a date goes through", async () => {
    const { tenantId, crewId } = await company();
    const admin = createSchedulingAdminHandlers({
      db: t.db,
      tenantId,
      authorize: (_req, permission) => (permission === "schedule.history" ? false : { userId: "u-sam" }),
      now: () => NOW,
    });
    const body = { resourceId: crewId, date: "2025-05-11", startTime: "06:00", service: "clean" };
    const dated = await admin.handle(apiRequest("POST", "/v1/admin/visits", { ...body, bookedAt: "2025-05-02" }));
    expect(dated.status).toBe(403);
    expect((await readJson(dated)).error.message).toBe("Giving a past date needs the “Enter past records” permission. Leave the date out to record it as today, or ask the owner.");
    expect(await t.db.select().from(schedulingBookings).where(eq(schedulingBookings.tenantId, tenantId))).toEqual([]);
    // NEGATIVE CONTROL: the same visit without a booked-on date is booked (and checked as usual).
    const plain = await admin.handle(apiRequest("POST", "/v1/admin/visits", { ...body, date: "2026-10-26", startTime: "09:00" }));
    expect(plain.status).toBe(201);
    const id = (await readJson(plain)).visit.id;
    expect((await admin.handle(apiRequest("POST", `/v1/admin/visits/${id}/status`, { status: "cancelled", occurredAt: "2026-10-20" }))).status).toBe(403);
    expect(schedulingPermissions["schedule.history"].defaultFor).toEqual(["owner", "admin"]);
  });

  it("a visit typed in later carries enteredLater on the calendar's snapshot; one booked today doesn't", async () => {
    const { tenantId, crewId } = await company();
    const admin = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-sam" }), now: () => NOW });
    const past = await admin.handle(
      apiRequest("POST", "/v1/admin/visits", { resourceId: crewId, date: "2025-05-11", startTime: "06:00", service: "clean", bookedAt: "2025-05-02" }),
    );
    expect((await readJson(past)).visit.enteredLater).toEqual({ at: NOW.toISOString(), by: "u-sam" });
    // NEGATIVE CONTROL
    await setAvailability(t.db, { tenantId, resourceId: crewId, blocks: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startTime: "08:00", endTime: "17:00" })) });
    const today = await admin.handle(apiRequest("POST", "/v1/admin/visits", { resourceId: crewId, date: "2026-10-26", startTime: "09:00", service: "clean" }));
    expect(today.status).toBe(201);
    expect((await readJson(today)).visit.enteredLater).toBeNull();
  });
});
