import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  bookVisit,
  createResource,
  deactivateResource,
  expirePendingRequests,
  findPublicSlots,
  listCalendar,
  listCrewDay,
  requestPublicBooking,
  selectMapsProvider,
  setAvailability,
  setBookingStatus,
  updateSchedulingSettings,
} from "../index.js";
import { fakeGoogle, GOOGLE_KEY } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The staff calendar and a crew's day. The calendar costs five queries
 * however many crews and days; the crew's day is a route a phone can follow.
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

describe("listCalendar", () => {
  it("costs five queries for 1 crew × 1 day and for 10 crews × 42 days", async () => {
    const small = tenant();
    await createResource(t.db, { tenantId: small, name: "Only" });
    t.queries.length = 0;
    await listCalendar(t.db, small, { from: WED, to: WED }, { now: NOW });
    expect(t.queries).toHaveLength(5);

    const big = tenant();
    for (let i = 0; i < 10; i += 1) {
      const crew = await createResource(t.db, { tenantId: big, name: `Crew ${i}` });
      await bookVisit(t.db, { tenantId: big, resourceId: crew.id, scheduledDate: WED, startTime: "10:00", endTime: "11:00" }, { now: NOW });
    }
    t.queries.length = 0;
    const calendar = await listCalendar(t.db, big, { from: "2026-03-02", to: "2026-04-12" }, { now: NOW });
    expect(t.queries).toHaveLength(5);
    expect(calendar.windows).toHaveLength(10 * 42);
    expect(calendar.visits).toHaveLength(10);
  });

  it("refuses a range over 42 days or upside down", async () => {
    await expect(listCalendar(t.db, tenant(), { from: "2026-03-01", to: "2026-04-12" })).rejects.toBeInstanceOf(ZodError);
    await expect(listCalendar(t.db, tenant(), { from: WED, to: "2026-03-01" })).rejects.toBeInstanceOf(ZodError);
  });

  it("windows per crew and day, the visits (unassigned included), removed crews that still own visits, and the inbox", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { pendingExpiryHours: 24 });
    const alpha = await createResource(t.db, { tenantId, name: "Alpha" });
    const bravo = await createResource(t.db, { tenantId, name: "Bravo" });
    const gone = await createResource(t.db, { tenantId, name: "Zulu" });
    const idle = await createResource(t.db, { tenantId, name: "Yankee" });
    await setAvailability(t.db, {
      tenantId,
      resourceId: bravo.id,
      blocks: [
        { dayOfWeek: 3, startTime: "08:00", endTime: "12:00" },
        { dayOfWeek: 3, startTime: "13:00", endTime: "17:00" },
      ],
    });
    const book = async (resourceId: string | null, date: string, startTime: string, endTime: string, status: "pending" | "confirmed" = "confirmed") =>
      (await bookVisit(t.db, { tenantId, resourceId, scheduledDate: date, startTime, endTime, status }, { now: NOW })).visit;
    const onAlpha = await book(alpha.id, WED, "10:00", "11:00");
    const unassigned = await book(null, WED, "12:00", "13:00");
    const onGone = await book(gone.id, WED, "09:00", "10:00");
    await deactivateResource(t.db, tenantId, gone.id);
    await deactivateResource(t.db, tenantId, idle.id);
    const cancelled = await book(alpha.id, WED, "15:00", "16:00");
    await setBookingStatus(t.db, tenantId, { id: cancelled.id, status: "cancelled" }, { now: NOW });
    // The inbox: two requests far apart (one outside the range), one already overdue.
    const later = await book(bravo.id, "2026-03-25", "09:00", "10:00", "pending");
    const soon = await book(bravo.id, WED, "14:00", "15:00", "pending");
    const lapsedAt = await (async () => {
      const visit = await book(alpha.id, "2026-03-03", "08:00", "09:00", "pending");
      return visit;
    })();

    const at = new Date("2026-03-03T08:30:00Z"); // after lapsedAt's start: it is overdue
    const calendar = await listCalendar(t.db, tenantId, { from: WED, to: "2026-03-05" }, { now: at });
    expect(calendar).toMatchObject({ timeZone: "UTC", today: "2026-03-03", from: WED, to: "2026-03-05", slotStepMinutes: 30 });
    expect(calendar.resources.map((r) => [r.name, r.isActive])).toEqual([
      ["Alpha", true],
      ["Bravo", true],
      ["Zulu", false], // removed, but owns a visit in the range
    ]);
    expect(calendar.windows.find((w) => w.resourceId === bravo.id && w.date === WED)?.windows).toEqual([
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ]);
    expect(calendar.windows.find((w) => w.resourceId === bravo.id && w.date === "2026-03-05")?.windows).toEqual([]);
    expect(calendar.windows.find((w) => w.resourceId === alpha.id && w.date === WED)?.windows).toEqual([{ start: "08:00", end: "17:00" }]);
    expect(calendar.visits.map((v) => v.id)).toEqual([onGone.id, onAlpha.id, unassigned.id, soon.id]);
    expect(calendar.visits.find((v) => v.id === unassigned.id)).toMatchObject({ resourceId: null, resourceName: null });
    expect(calendar.visits.find((v) => v.id === onAlpha.id)).toMatchObject({ resourceName: "Alpha", nextStatuses: ["in_progress", "completed", "cancelled", "no_show"] });
    expect(calendar.pending.map((v) => v.id)).toEqual([soon.id, later.id]);

    const withInactive = await listCalendar(t.db, tenantId, { from: WED, to: WED, includeInactive: true }, { now: at });
    expect(withInactive.visits.map((v) => v.id)).toContain(cancelled.id);
    const narrowed = await listCalendar(t.db, tenantId, { from: WED, to: WED, resourceIds: [bravo.id] }, { now: at });
    expect(narrowed.resources.map((r) => r.id)).toEqual([bravo.id]);
    expect(narrowed.visits.map((v) => v.id)).toEqual([soon.id]);
    expect(lapsedAt.id).toBeTruthy();
  });

  it("an expired request shows only with includeInactive", async () => {
    const tenantId = tenant();
    await createResource(t.db, { tenantId, name: "Crew" });
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, service: "visit", customerName: "V", customerEmail: "v@example.com" },
      { now: NOW },
    );
    await expirePendingRequests(t.db, tenantId, { now: new Date("2026-03-04T09:00:00Z") });
    expect((await listCalendar(t.db, tenantId, { from: WED, to: WED }, { now: NOW })).visits).toEqual([]);
    const all = await listCalendar(t.db, tenantId, { from: WED, to: WED, includeInactive: true }, { now: NOW });
    expect(all.visits.map((v) => [v.id, v.status])).toEqual([[receipt.id, "expired"]]);
  });
});

describe("listCrewDay", () => {
  const BASE = { lat: 40.76, lng: -111.89 };
  const STOPS = {
    "100 First Ave, Salt Lake City": { lat: 40.77, lng: -111.88 },
    "200 Second Ave, Salt Lake City": { lat: 40.78, lng: -111.87 },
    "300 Third Ave, Salt Lake City": { lat: 40.79, lng: -111.86 },
  };

  it("lists the route in time order with drives, directions, a call link and the whole route", async () => {
    const tenantId = tenant();
    const google = fakeGoogle({ places: { ...STOPS, "1 Depot Rd": BASE }, driveMinutes: 12, miles: 4.3 });
    const maps = selectMapsProvider({ googleMapsApiKey: GOOGLE_KEY, db: t.db, fetch: google.fetch });
    const crew = await createResource(t.db, { tenantId, name: "Crew B", homeBaseAddress: "1 Depot Rd" }, { maps });
    expect(crew).toMatchObject({ homeBaseLat: BASE.lat, homeBaseLng: BASE.lng });
    const book = async (startTime: string, endTime: string, address: string, extra: Record<string, unknown> = {}) =>
      (await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime, endTime, address, ...extra }, { now: NOW, maps })).visit;
    // Entered out of order.
    const third = await book("15:00", "16:00", "300 Third Ave, Salt Lake City", { customerPhone: "+1 (801) 555-0100" });
    const first = await book("09:00", "10:00", "100 First Ave, Salt Lake City", { customerPhone: "(801) 555-0143" });
    const second = await book("12:00", "13:00", "200 Second Ave, Salt Lake City");
    const request = await book("13:30", "14:00", "Somewhere", { status: "pending" }); // not on a route

    const before = google.matrices().length;
    const day = await listCrewDay(t.db, tenantId, { resourceId: crew.id, date: WED }, { maps, now: NOW });
    expect(day?.stops.map((s) => s.visit.id)).toEqual([first.id, second.id, third.id]);
    expect(day?.stops.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(day?.stops[0]).toMatchObject({
      driveFromPrevious: { minutes: 12, miles: 4.3, from: "home_base", estimated: false },
      directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("100 First Ave, Salt Lake City")}&travelmode=driving`,
      telUrl: "tel:8015550143",
    });
    expect(day?.stops[1]?.driveFromPrevious).toEqual({ minutes: 12, miles: 4.3, from: "previous_stop", estimated: false });
    expect(day?.stops[2]?.telUrl).toBe("tel:+18015550100");
    expect(day?.stops[1]?.telUrl).toBeNull();
    expect(day?.totals).toEqual({ visits: 3, driveMinutes: 36, distanceMiles: 12.9, estimated: false });
    expect(day?.routeUrl).toBe(
      "https://www.google.com/maps/dir/?api=1" +
        `&origin=${encodeURIComponent("1 Depot Rd")}` +
        `&destination=${encodeURIComponent("300 Third Ave, Salt Lake City")}` +
        `&waypoints=${encodeURIComponent("100 First Ave, Salt Lake City|200 Second Ave, Salt Lake City")}` +
        "&travelmode=driving",
    );
    expect(day).toMatchObject({ date: WED, today: "2026-03-02", resource: { name: "Crew B", homeBaseAddress: "1 Depot Rd" } });
    expect(day?.windows).toEqual([{ start: "08:00", end: "17:00" }]);
    expect(request.status).toBe("pending");
    const fetchedFirst = google.matrices().length - before;

    // The cached provider: the second load makes no new request.
    const again = await listCrewDay(t.db, tenantId, { resourceId: crew.id, date: WED }, { maps, now: NOW });
    expect(again?.totals).toEqual(day?.totals);
    expect(google.matrices().length - before).toBe(fetchedFirst);
  });

  it("drive estimates without a key are labelled; a stop without a place has no links", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew", homeBaseLat: 40.76, homeBaseLng: -111.89 });
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "09:00", endTime: "10:00", lat: 40.8, lng: -111.89 }, { now: NOW });
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "11:00", endTime: "12:00" }, { now: NOW });
    const day = await listCrewDay(t.db, tenantId, { resourceId: crew.id, date: WED }, { now: NOW });
    expect(day?.stops[0]?.driveFromPrevious).toMatchObject({ from: "home_base", estimated: true });
    expect(day?.stops[0]?.directionsUrl).toContain(encodeURIComponent("40.8,-111.89"));
    expect(day?.stops[1]).toMatchObject({ driveFromPrevious: null, directionsUrl: null, telUrl: null });
    expect(day?.totals.estimated).toBe(true);
    expect(day?.routeUrl).toBe(
      `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent("40.76,-111.89")}&destination=${encodeURIComponent("40.8,-111.89")}&travelmode=driving`,
    );
    expect(await listCrewDay(t.db, tenant("other"), { resourceId: crew.id, date: WED })).toBeNull();
  });

  it("an empty day has no route", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const day = await listCrewDay(t.db, tenantId, { resourceId: crew.id, date: WED }, { now: NOW });
    expect(day).toMatchObject({ stops: [], routeUrl: null, totals: { visits: 0, driveMinutes: 0, distanceMiles: 0, estimated: false } });
  });
});
