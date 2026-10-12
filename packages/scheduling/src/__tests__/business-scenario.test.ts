import { commsMessages, commsScheduled, runDueMessages, type ScheduledRow } from "@adminigloo/comms";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulingCommsListener, SCHEDULING_COMMS_REF_TYPE } from "../comms.js";
import {
  createSchedulingAdminHandlers,
  createSchedulingHandlers,
  selectMapsProvider,
  type SchedulingEvent,
} from "../index.js";
import { encodeSlotId } from "../public.js";
import { fakeGoogle, GOOGLE_KEY, recordingSender } from "./fixtures.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE ACCEPTANCE TEST (contract section 10.3): a window-cleaning business in
 * Salt Lake City runs its week through the package, end to end, with nothing
 * but the two HTTP handlers, the comms listener and the comms cron.
 *
 * Acme Windows: America/Denver, auto-confirm off, requests released after 24
 * hours, a reminder 24 hours ahead, changes online until 24 hours before, one
 * service ("Free estimate", 60 minutes), an address required. Two crews with
 * home bases. Google Maps is a fake that geocodes known addresses, answers a
 * fixed 15-minute drive and counts every call. The clock starts Thursday
 * 2026-10-29 09:00 MDT; the clocks fall back on Sunday 2026-11-01.
 *
 * The steps share one database and one clock, in order (vitest runs a file's
 * tests sequentially). comms' `enqueueMessage` reads the real clock, so the
 * system clock (Date only) is pinned to the scenario's.
 */

const TENANT = "acme-windows";
const START = new Date("2026-10-29T15:00:00Z"); // Thu 09:00 MDT
const HOUR = 3_600_000;

const PLACES = {
  "1 Depot Rd, Salt Lake City": { lat: 40.75, lng: -111.9 },
  "2 Yard Ln, Salt Lake City": { lat: 40.7, lng: -111.85 },
  "12 Oak St, Salt Lake City": { lat: 40.76, lng: -111.88 },
  "40 Elm Ave, Salt Lake City": { lat: 40.77, lng: -111.86 },
  "7 Pine Ct, Salt Lake City": { lat: 40.72, lng: -111.87 },
  "300 Maple Dr, Salt Lake City": { lat: 40.71, lng: -111.83 },
  "18 Birch Way, Salt Lake City": { lat: 40.73, lng: -111.84 },
  "55 Cedar Rd, Salt Lake City": { lat: 40.74, lng: -111.82 },
  "9 Aspen Pl, Salt Lake City": { lat: 40.78, lng: -111.81 },
};

let t: TestDb;
let clock = START;
const google = fakeGoogle({
  places: PLACES,
  driveMinutes: 15,
  miles: 5.5,
  geocodeFailures: { "500 Outage Blvd, Salt Lake City": { http: 500 } },
});
const mail = recordingSender();
const events: SchedulingEvent[] = [];
let listener: ReturnType<typeof createSchedulingCommsListener>;
let publicApi: ReturnType<typeof createSchedulingHandlers>;
let adminApi: ReturnType<typeof createSchedulingAdminHandlers>;
const crews: { a: string; b: string } = { a: "", b: "" };

function setClock(next: Date) {
  clock = next;
  vi.setSystemTime(next);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(START);
  t = await createTestDb({ comms: true });
  const maps = selectMapsProvider({ googleMapsApiKey: GOOGLE_KEY, db: t.db, fetch: google.fetch });
  listener = createSchedulingCommsListener({
    db: t.db,
    senders: mail.senders,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    bookUrl: "https://acme.test/book",
    adminUrl: "https://acme.test/admin/schedule",
    now: () => clock,
  });
  const onEvent = async (event: SchedulingEvent) => {
    events.push(event);
    await listener.onEvent(event);
  };
  publicApi = createSchedulingHandlers({
    db: t.db,
    tenantId: TENANT,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    maps,
    onEvent,
    now: () => clock,
  });
  adminApi = createSchedulingAdminHandlers({
    db: t.db,
    tenantId: TENANT,
    authorize: () => ({ userId: "owner" }),
    maps,
    onEvent,
    now: () => clock,
  });
});
afterAll(async () => {
  vi.useRealTimers();
  await t.close();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
});

// --- Talking to the two handlers --------------------------------------------------

async function call(
  api: { handle: (req: Request) => Promise<Response> },
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await api.handle(
    new Request(url, {
      method,
      headers: { ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text, headers: response.headers };
}
const pub = (method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) =>
  call(publicApi, method, `https://acme.test/api/schedule${path}`, body, headers);
const admin = (method: "GET" | "POST", path: string, body?: unknown) =>
  call(adminApi, method, `https://acme.test/api/admin/schedule/v1/admin${path}`, body);

/** The public slots for one day. */
async function slotsOn(date: string, extra = "") {
  const response = await pub("GET", `/v1/slots?service=estimate&from=${date}&days=1${extra}`);
  expect(response.status).toBe(200);
  return response.body.slots as Array<{ slotId: string; date: string; startTime: string; startsAt: string }>;
}

/** A customer fills in the booking form (taking a normal five seconds). */
async function requestVisit(date: string, startTime: string, who: { name: string; email: string; ip: string; address: string }) {
  const slot = (await slotsOn(date)).find((s) => s.startTime === startTime);
  expect(slot, `${date} ${startTime} on offer`).toBeDefined();
  return pub(
    "POST",
    "/v1/request",
    { slotId: slot!.slotId, service: "estimate", name: who.name, email: who.email, address: who.address, fillMs: 5000 },
    { "x-forwarded-for": who.ip },
  );
}

/** The emails sent since the last look, as [to, subject]. */
function newMail(): Array<[string, string]> {
  const out = mail.sent.map((m) => [m.to, m.subject] as [string, string]);
  mail.sent.length = 0;
  return out;
}
function lastBodyTo(to: string, all = mail.sent): string {
  return [...all].reverse().find((m) => m.to === to)?.body ?? "";
}

async function log() {
  return t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, TENANT));
}
async function reminders(visitId: string): Promise<ScheduledRow[]> {
  return ((await t.db.select().from(commsScheduled).where(eq(commsScheduled.refId, visitId))) as ScheduledRow[]).filter(
    (row) => row.refType === SCHEDULING_COMMS_REF_TYPE,
  );
}
const tokenIn = (body: string): string => /https:\/\/acme\.test\/visit\/([A-Za-z0-9_-]{43})/.exec(body)?.[1] ?? "";

const PAT = { name: "Pat Visitor", email: "pat@example.com", ip: "203.0.113.10", address: "12 Oak St, Salt Lake City" };
const SAM = { name: "Sam Auto", email: "sam@example.com", ip: "203.0.113.11", address: "40 Elm Ave, Salt Lake City" };
const LEE = { name: "Lee Declined", email: "lee@example.com", ip: "203.0.113.12", address: "7 Pine Ct, Salt Lake City" };
const KIM = { name: "Kim Waiting", email: "kim@example.com", ip: "203.0.113.13", address: "18 Birch Way, Salt Lake City" };

// Shared between steps.
const state = { visitA: "", tokenA: "", visitD: "", tokenD: "", visitE: "", tokenE: "" };

describe("Acme Windows runs its week", () => {
  it("setup: settings and two crews through the staff API", async () => {
    const saved = await admin("POST", "/settings", {
      timeZone: "America/Denver",
      businessName: "Acme Windows",
      contactPhone: "(801) 555-0143",
      staffNotifyEmails: ["office@acme.test"],
      autoConfirm: false,
      pendingExpiryHours: 24,
      reminderLeadHours: 24,
      cancelCutoffHours: 24,
      requireAddress: true,
      services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ timeZone: "America/Denver", saved: true });
    const a = await admin("POST", "/resources", { name: "Crew A", homeBaseAddress: "1 Depot Rd, Salt Lake City" });
    const b = await admin("POST", "/resources", { name: "Crew B", homeBaseAddress: "2 Yard Ln, Salt Lake City" });
    expect([a.status, b.status]).toEqual([201, 201]);
    // Home bases geocoded through Google on the way in.
    expect(a.body.resource).toMatchObject({ homeBaseLat: 40.75, homeBaseLng: -111.9 });
    crews.a = a.body.resource.id;
    crews.b = b.body.resource.id;
  });

  it("1. a customer books on the website and is acknowledged; the office hears about it", async () => {
    const config = await pub("GET", "/v1/config");
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      businessName: "Acme Windows",
      timeZone: "America/Denver",
      publicBookingEnabled: true,
      requireAddress: true,
      services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60, description: null }],
    });

    const slots = await pub("GET", "/v1/slots?service=estimate");
    expect(slots.body).toMatchObject({ timeZone: "America/Denver", service: "estimate", closed: false });
    const first = slots.body.slots[0];
    expect(new Date(first.startsAt).getTime()).toBeGreaterThanOrEqual(START.getTime() + 24 * HOUR);
    expect(first).toMatchObject({ date: "2026-10-30", startTime: "09:00", startsAt: "2026-10-30T15:00:00.000Z" }); // exactly 24 h
    const monday = slots.body.slots.find((s: { date: string; startTime: string }) => s.date === "2026-11-02" && s.startTime === "09:00");
    expect(monday).toMatchObject({ startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z" }); // MST now

    // Spam: the honeypot, and a form sent in a tenth of a second. Nothing is written.
    const spam1 = await pub("POST", "/v1/request", { slotId: monday.slotId, service: "estimate", name: "Bot", email: "b@x.co", address: PAT.address, fillMs: 5000, website: "http://spam" });
    const spam2 = await pub("POST", "/v1/request", { slotId: monday.slotId, service: "estimate", name: "Bot", email: "b@x.co", address: PAT.address, fillMs: 100 });
    expect([spam1.status, spam1.body.error.code, spam2.status, spam2.body.error.code]).toEqual([400, "spam_suspected", 400, "spam_suspected"]);
    expect((await t.client.query(`select count(*)::int as n from scheduling_bookings`)).rows[0]).toEqual({ n: 0 });

    const booked = await requestVisit("2026-11-02", "09:00", PAT);
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ visit: { status: "requested", startsAt: "2026-11-02T16:00:00.000Z", canCancel: true }, repeated: false });
    state.tokenA = booked.body.manageToken;
    expect(booked.body.manageUrl).toBe(`https://acme.test/visit/${state.tokenA}`);
    state.visitA = events.at(-1)!.visitId;

    const sentAck = [...mail.sent];
    expect(newMail()).toEqual([
      ["pat@example.com", "We got your request: Free estimate, Mon, Nov 2, 9:00 AM MST"],
      ["office@acme.test", "New request: Pat Visitor, Mon, Nov 2, 9:00 AM MST"],
    ]);
    const ackLink = tokenIn(lastBodyTo("pat@example.com", sentAck));
    expect((await pub("GET", `/v1/visit/${ackLink}`)).status).toBe(200); // the link works
    const logged = await log();
    expect(logged.find((row) => row.templateKey === "visit_requested")?.body).toContain("https://acme.test/visit/:token");
    expect(logged.some((row) => row.body.includes(ackLink) || row.body.includes(state.tokenA))).toBe(false);

    // The auto-confirm variant: the owner flips the switch, a request lands confirmed.
    expect((await admin("POST", "/settings", { autoConfirm: true })).status).toBe(200);
    const auto = await requestVisit("2026-11-10", "09:00", SAM);
    expect([auto.status, auto.body.visit.status]).toEqual([201, "confirmed"]);
    expect(newMail()).toEqual([
      ["office@acme.test", "New booking: Sam Auto, Tue, Nov 10, 9:00 AM MST"],
      ["sam@example.com", "Confirmed: Free estimate, Tue, Nov 10, 9:00 AM MST"],
    ]);
    expect((await admin("POST", "/settings", { autoConfirm: false })).body.settings.autoConfirm).toBe(false);
  });

  it("2. staff see the request on the calendar, accept one and decline another", async () => {
    const week = await admin("GET", "/calendar?from=2026-11-02&to=2026-11-08");
    expect(week.status).toBe(200);
    expect(week.body.pending.map((v: { id: string }) => v.id)).toEqual([state.visitA]);
    const onCalendar = week.body.visits.find((v: { id: string }) => v.id === state.visitA);
    expect(onCalendar).toMatchObject({ status: "pending", resourceId: crews.a, resourceName: "Crew A", startTime: "09:00", timeZone: "America/Denver" });
    expect(week.body.windows.find((w: { resourceId: string; date: string }) => w.resourceId === crews.a && w.date === "2026-11-02").windows).toEqual([
      { start: "08:00", end: "17:00" },
    ]);

    const accepted = await admin("POST", `/visits/${state.visitA}/accept`, {});
    expect(accepted.body.visit).toMatchObject({ status: "confirmed", sequence: 0, pendingExpiresAt: null });
    expect(newMail()).toEqual([["pat@example.com", "Confirmed: Free estimate, Mon, Nov 2, 9:00 AM MST"]]);
    const [reminder] = await reminders(state.visitA);
    // Mon 09:00 MST (16:00Z) − 24 real hours, across the fall-back, is Sun
    // 16:00Z — the change cutoff itself (24 hours here too). A reminder whose
    // link must still work goes an hour before the cutoff: Sun 15:00Z (F5).
    expect(reminder).toMatchObject({ status: "pending", dedupeKey: `visit:${state.visitA}:reminder:0` });
    expect(reminder!.sendAt.toISOString()).toBe("2026-11-01T15:00:00.000Z");

    const lee = await requestVisit("2026-11-02", "13:00", LEE);
    expect(lee.status).toBe(201);
    const leeId = events.at(-1)!.visitId;
    newMail();
    // While it waits, Mon 13:00 belongs to Lee on Crew A — but Crew B can still take it.
    const declined = await admin("POST", `/visits/${leeId}/decline`, { reason: "We're not in your area that day" });
    expect(declined.body.visit).toMatchObject({ status: "declined", cancelReason: "We're not in your area that day" });
    const sent = [...mail.sent];
    expect(newMail()).toEqual([["lee@example.com", "We can't make Mon, Nov 2, 1:00 PM MST"]]);
    expect(lastBodyTo("lee@example.com", sent)).toContain('Note from us: "We\'re not in your area that day"');
    expect(lastBodyTo("lee@example.com", sent)).toContain("pick one here: https://acme.test/book");
    expect((await slotsOn("2026-11-02")).some((s) => s.startTime === "13:00")).toBe(true);
  });

  it("3. staff move the visit and change its crew; the customer is told each time", async () => {
    const moved = await admin("POST", `/visits/${state.visitA}/reschedule`, { date: "2026-11-03", startTime: "10:00" });
    expect(moved.status).toBe(200);
    expect(moved.body.visit).toMatchObject({ date: "2026-11-03", startTime: "10:00", endTime: "11:00", sequence: 1, startsAt: "2026-11-03T17:00:00.000Z" });
    const sentMove = [...mail.sent];
    expect(newMail()).toEqual([["pat@example.com", "New time: Free estimate, Tue, Nov 3, 10:00 AM MST"]]);
    expect(lastBodyTo("pat@example.com", sentMove)).toContain("We had to move your Free estimate. Sorry for the change.");
    let rows = await reminders(state.visitA);
    expect(rows.map((r) => [r.dedupeKey, r.status])).toEqual([
      [`visit:${state.visitA}:reminder:0`, "cancelled"],
      [`visit:${state.visitA}:reminder:1`, "pending"],
    ]);

    const assigned = await admin("POST", `/visits/${state.visitA}/assign`, { resourceId: crews.b });
    expect(assigned.body.visit).toMatchObject({ resourceId: crews.b, resourceName: "Crew B", sequence: 1 });
    const sentAssign = [...mail.sent];
    expect(newMail()).toEqual([["pat@example.com", "Update to your Free estimate, Tue, Nov 3, 10:00 AM MST"]]);
    expect(lastBodyTo("pat@example.com", sentAssign)).toContain("Crew B from our team will now be doing your Free estimate.");
    rows = await reminders(state.visitA);
    expect(rows.filter((r) => r.status === "pending").map((r) => r.dedupeKey)).toEqual([`visit:${state.visitA}:reminder:1`]);

    // A staff visit on Crew B in the afternoon; moving onto it is refused with the clash.
    const other = await admin("POST", "/visits", { resourceId: crews.b, date: "2026-11-03", startTime: "13:00", endTime: "14:00", customerName: "Walk-in", address: "300 Maple Dr, Salt Lake City" });
    expect(other.status).toBe(201);
    const clash = await admin("POST", `/visits/${state.visitA}/reschedule`, { date: "2026-11-03", startTime: "13:30" });
    expect([clash.status, clash.body.error]).toEqual([409, { code: "slot_unavailable", message: "Crew B already has a visit 1:00 PM – 2:00 PM" }]);
    const early = await admin("POST", `/visits/${state.visitA}/reschedule`, { date: "2026-11-03", startTime: "06:00" });
    expect([early.status, early.body.error.code]).toEqual([400, "outside_hours"]);
    expect(newMail()).toEqual([]);
  });

  it("4. the customer moves it themselves, gets the reminder, can't cancel inside the cutoff, and cancels another in time", async () => {
    const around = await pub("GET", `/v1/slots?manage=${state.tokenA}&from=2026-11-03&days=1`);
    expect(around.status).toBe(200);
    expect(around.headers.get("referrer-policy")).toBe("no-referrer");
    const tuesday = around.body.slots.map((s: { startTime: string }) => s.startTime);
    expect(tuesday).toEqual(expect.arrayContaining(["09:30", "10:00", "10:30", "11:00"]));
    const thursday = (await pub("GET", `/v1/slots?manage=${state.tokenA}&from=2026-11-05&days=1`)).body.slots.find(
      (s: { startTime: string }) => s.startTime === "10:00",
    );
    const self = await pub("POST", `/v1/visit/${state.tokenA}/reschedule`, { slotId: thursday.slotId });
    expect(self.status).toBe(200);
    expect(self.body.visit).toMatchObject({ status: "confirmed", date: "2026-11-05", startTime: "10:00", startsAt: "2026-11-05T17:00:00.000Z" });
    const sentSelf = [...mail.sent];
    expect(newMail()).toEqual([
      ["pat@example.com", "New time: Free estimate, Thu, Nov 5, 10:00 AM MST"],
      ["office@acme.test", "Visit moved: Pat Visitor, Thu, Nov 5, 10:00 AM MST"],
    ]);
    expect(lastBodyTo("pat@example.com", sentSelf)).toContain("Your Free estimate has moved, as you asked.");
    const pending = (await reminders(state.visitA)).filter((r) => r.status === "pending");
    expect(pending.map((r) => [r.dedupeKey, r.sendAt.toISOString()])).toEqual([[`visit:${state.visitA}:reminder:2`, "2026-11-04T16:00:00.000Z"]]);

    // The cron, a minute after the reminder is due — an hour before the cutoff.
    setClock(new Date("2026-11-04T16:01:00Z"));
    const run = await runDueMessages(t.db, mail.senders, { now: clock, beforeSend: async (row) => (await listener.beforeSend(row)) ?? "send" });
    expect(run).toMatchObject({ sent: 1, failed: 0 });
    const sentReminder = [...mail.sent];
    expect(newMail()).toEqual([["pat@example.com", "Reminder: Free estimate, Thu, Nov 5, 10:00 AM MST"]]);
    const reminderToken = tokenIn(lastBodyTo("pat@example.com", sentReminder));
    expect((await pub("GET", `/v1/visit/${reminderToken}`)).status).toBe(200);
    expect(await listener.redactSent()).toBe(1);
    expect((await log()).some((row) => row.body.includes(reminderToken))).toBe(false);

    // 23 h 59 min before the visit: too late to cancel online; the message gives the phone.
    setClock(new Date("2026-11-04T17:01:00Z"));
    const late = await pub("POST", `/v1/visit/${state.tokenA}/cancel`, {});
    expect([late.status, late.body.error]).toEqual([
      409,
      { code: "too_late", message: "This visit starts within 24 hours, so it can't be changed online. Call us at (801) 555-0143." },
    ]);

    // A second visit a week out, accepted, then cancelled online in good time.
    const second = await requestVisit("2026-11-11", "10:00", { ...PAT, address: "9 Aspen Pl, Salt Lake City" });
    expect(second.status).toBe(201);
    state.tokenD = second.body.manageToken;
    state.visitD = events.at(-1)!.visitId;
    await admin("POST", `/visits/${state.visitD}/accept`, {});
    expect((await reminders(state.visitD)).map((r) => r.status)).toEqual(["pending"]);
    newMail();
    const cancelled = await pub("POST", `/v1/visit/${state.tokenD}/cancel`, { reason: "Sorted it myself" });
    expect([cancelled.status, cancelled.body.visit.status, cancelled.body.visit.cancelledBy]).toEqual([200, "cancelled", "customer"]);
    expect((await reminders(state.visitD)).map((r) => r.status)).toEqual(["cancelled"]);
    const sentCancel = [...mail.sent];
    expect(newMail()).toEqual([
      ["pat@example.com", "Cancelled: Free estimate, Wed, Nov 11, 10:00 AM MST"],
      ["office@acme.test", "Visit cancelled: Pat Visitor, Wed, Nov 11, 10:00 AM MST"],
    ]);
    expect(lastBodyTo("pat@example.com", sentCancel)).toContain("is cancelled, as you asked.");
  });

  it("5. the crew opens the day's route: stops in order, directions, Google drive times (cached), start and complete", async () => {
    const day = "2026-11-09";
    const book = (startTime: string, endTime: string, address: string, extra: Record<string, unknown> = {}) =>
      admin("POST", "/visits", { resourceId: crews.b, date: day, startTime, endTime, address, ...extra });
    // Entered out of order.
    const third = await book("15:00", "16:00", "55 Cedar Rd, Salt Lake City");
    const first = await book("09:00", "10:00", "300 Maple Dr, Salt Lake City", { customerName: "Robin", customerEmail: "robin@example.com", customerPhone: "(801) 555-0199" });
    const second = await book("12:00", "13:00", "18 Birch Way, Salt Lake City");
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
    expect(first.body.visit).toMatchObject({ lat: 40.71, lng: -111.83 }); // geocoded by Google
    newMail();

    const fetchesBefore = google.matrices().length;
    const route = await admin("GET", `/crew-day?resource=${crews.b}&date=${day}`);
    expect(route.status).toBe(200);
    expect(route.body.stops.map((s: { visit: { id: string } }) => s.visit.id)).toEqual([first.body.visit.id, second.body.visit.id, third.body.visit.id]);
    expect(route.body.stops[0]).toMatchObject({
      order: 1,
      driveFromPrevious: { minutes: 15, miles: 5.5, from: "home_base", estimated: false },
      telUrl: "tel:8015550199",
    });
    expect(route.body.stops[0].directionsUrl).toContain(encodeURIComponent("300 Maple Dr, Salt Lake City"));
    expect(route.body.stops[1].driveFromPrevious).toMatchObject({ from: "previous_stop", estimated: false });
    expect(route.body.totals).toEqual({ visits: 3, driveMinutes: 45, distanceMiles: 16.5, estimated: false });
    expect(route.body.routeUrl).toContain("https://www.google.com/maps/dir/?api=1&origin=");
    const fetchedOnce = google.matrices().length - fetchesBefore;
    const again = await admin("GET", `/crew-day?resource=${crews.b}&date=${day}`);
    expect(again.body.totals).toEqual(route.body.totals);
    expect(google.matrices().length - fetchesBefore).toBe(fetchedOnce); // all from the cache

    const stop = first.body.visit.id;
    const eventsBefore = events.length;
    const started = await admin("POST", `/visits/${stop}/status`, { status: "in_progress" });
    expect(started.body.visit.startedAt).toBe(clock.toISOString());
    const done = await admin("POST", `/visits/${stop}/status`, { status: "completed" });
    expect(done.body.visit).toMatchObject({ status: "completed", completedAt: clock.toISOString() });
    expect(events.slice(eventsBefore).map((e) => [e.type, e.data.notify])).toEqual([
      ["visit.started", false],
      ["visit.completed", false],
    ]);
    expect(newMail()).toEqual([]);
  });

  it("6. a 24-hour notice is 24 real hours across the fall-back (another business, its own clock)", async () => {
    const own = { now: new Date("2026-10-31T16:00:00Z") }; // Sat 10:00 MDT
    vi.setSystemTime(own.now);
    const sundayApi = createSchedulingAdminHandlers({ db: t.db, tenantId: "sunday-shine", authorize: () => true, now: () => own.now });
    const sundayPublic = createSchedulingHandlers({ db: t.db, tenantId: "sunday-shine", manageUrl: (x) => x, now: () => own.now });
    await call(sundayApi, "POST", "https://x.test/v1/admin/settings", { timeZone: "America/Denver", services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }] });
    const crew = await call(sundayApi, "POST", "https://x.test/v1/admin/resources", { name: "Weekend crew" });
    const hours = await call(sundayApi, "POST", `https://x.test/v1/admin/resources/${crew.body.resource.id}/availability`, {
      weekly: [{ dayOfWeek: 0, startTime: "08:00", endTime: "17:00" }],
    });
    expect(hours.body.effectiveWeekly).toEqual([{ dayOfWeek: 0, startTime: "08:00", endTime: "17:00" }]);
    const ask = (startTime: string) =>
      call(sundayPublic, "POST", "https://x.test/v1/request", {
        slotId: encodeSlotId({ date: "2026-11-01", startTime }),
        service: "estimate",
        name: "Early Bird",
        email: "early@example.com",
        fillMs: 5000,
      });
    const tooSoon = await ask("08:30"); // 15:30Z: 23.5 real hours away
    expect([tooSoon.status, tooSoon.body.error.code]).toEqual([400, "too_soon"]);
    const exactly = await ask("09:00"); // 16:00Z: exactly 24 real hours away (MST by then)
    expect([exactly.status, exactly.body.visit.startsAt]).toEqual([201, "2026-11-01T16:00:00.000Z"]);
    vi.setSystemTime(clock);
  });

  it("7. a request nobody answers is released, the time offered again before any sweep, and the customer told", async () => {
    // Crew B is off that Thursday, so Kim's request holds the only crew.
    const off = await admin("POST", `/resources/${crews.b}/time-off`, { from: "2026-11-12", to: "2026-11-12", note: "Training" });
    expect(off.status).toBe(200);
    const kim = await requestVisit("2026-11-12", "09:00", KIM);
    expect(kim.status).toBe(201);
    state.tokenE = kim.body.manageToken;
    state.visitE = events.at(-1)!.visitId;
    expect((await slotsOn("2026-11-12")).some((s) => s.startTime === "09:00")).toBe(false);
    newMail();

    setClock(new Date(clock.getTime() + 25 * HOUR));
    // Nobody has swept yet: the visit is still pending, but its time is free.
    expect((await admin("GET", `/visits/${state.visitE}`)).body.visit.status).toBe("pending");
    expect((await slotsOn("2026-11-12")).some((s) => s.startTime === "09:00")).toBe(true);

    const swept = await admin("POST", "/expire");
    expect(swept.body).toEqual({ expired: 1 });
    // The customer is told — and so is the office (BO-05): a lapsed request is a lost sale.
    expect(newMail()).toEqual([
      ["kim@example.com", "We couldn't confirm Thu, Nov 12, 9:00 AM MST in time"],
      ["office@acme.test", "Request expired: Kim Waiting, Thu, Nov 12, 9:00 AM MST"],
    ]);
    const seen = await pub("GET", `/v1/visit/${state.tokenE}`);
    expect(seen.body.visit).toMatchObject({ status: "expired", canCancel: false, googleCalendarUrl: null });
  });

  it("8. Google is used when there is a key; a place it can't find is refused; an outage still books; no key means estimates", async () => {
    const geocodesBefore = google.geocodes().length;
    const placed = await requestVisit("2026-11-16", "09:00", { name: "Gina", email: "gina@example.com", ip: "203.0.113.20", address: "9 Aspen Pl, Salt Lake City" });
    expect(placed.status).toBe(201);
    const asked = google.geocodes().slice(geocodesBefore);
    expect(asked).toEqual([
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent("9 Aspen Pl, Salt Lake City")}&key=${GOOGLE_KEY}`,
    ]);
    const placedVisit = await admin("GET", `/visits/${events.at(-1)!.visitId}`);
    expect(placedVisit.body.visit).toMatchObject({ lat: 40.78, lng: -111.81 });

    const nowhere = await requestVisit("2026-11-16", "13:00", { name: "Nadia", email: "nadia@example.com", ip: "203.0.113.21", address: "1 Nowhere Lane, Atlantis" });
    expect([nowhere.status, nowhere.body.error.code]).toEqual([400, "address_unresolved"]);

    const outage = await requestVisit("2026-11-16", "13:00", { name: "Omar", email: "omar@example.com", ip: "203.0.113.22", address: "500 Outage Blvd, Salt Lake City" });
    expect(outage.status).toBe(201);
    const outageVisit = await admin("GET", `/visits/${events.at(-1)!.visitId}`);
    expect(outageVisit.body.visit).toMatchObject({ address: "500 Outage Blvd, Salt Lake City", lat: null, lng: null });

    // The key went to Google in request URLs, and nowhere else.
    const columns = (
      await t.client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb')`,
      )
    ).rows;
    for (const { table_name, column_name } of columns) {
      const hits = await t.client.query(`select 1 from "${table_name}" where "${column_name}"::text like $1 limit 1`, [`%${GOOGLE_KEY}%`]);
      expect(hits.rows, `${table_name}.${column_name}`).toEqual([]);
    }

    // Without a key: the same suggestion, as straight-line estimates, and no request to anybody.
    const keyless = createSchedulingAdminHandlers({ db: t.db, tenantId: TENANT, authorize: () => true, maps: selectMapsProvider({}), now: () => clock });
    const urlsBefore = google.urls.length;
    const suggest = await call(keyless, "GET", `https://acme.test/v1/admin/suggest?service=estimate&lat=40.76&lng=-111.88&from=2026-11-17&days=2`);
    expect(suggest.status).toBe(200);
    expect(suggest.body.estimated).toBe(true);
    expect(suggest.body.slots.length).toBeGreaterThan(0);
    expect(google.urls.length).toBe(urlsBefore);
    const withGoogle = await admin("GET", `/suggest?service=estimate&lat=40.76&lng=-111.88&from=2026-11-17&days=2`);
    expect(withGoogle.body.estimated).toBe(false);
  });
});
