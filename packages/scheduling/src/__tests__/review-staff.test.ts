import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookVisit,
  createResource,
  createSchedulingAdminHandlers,
  getBooking,
  updateSchedulingSettings,
  type CreateSchedulingAdminHandlersOptions,
  type SchedulingEvent,
  type SchedulingPermission,
} from "../index.js";
import { eventRecorder, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The 0.4 review's findings on the STAFF side, each a test that failed before
 * its fix (run against the pre-fix build as a negative control):
 *
 *   BO-06  a crew member gets their own route and their own stops, nothing more
 *   BO-11  a crew can undo, and record "couldn't do it" with a note
 *   BO-02  a picker of people for a crew's login, and the host told when it changes
 *   RL-09  integer user ids find their crew
 *   BO-04  the staff screens are told whether anything reaches a customer
 *   BO-08  a time-zone correction can email the customers it affects
 *   BO-09  refusals in an owner's words
 *   F8     a zone change re-queues reminders several at a time
 *
 * NOW is Monday 2026-03-02 09:00 UTC.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const SAT = "2026-03-07";
const ADMIN = "https://acme.test/api/admin/schedule/v1/admin";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

function adminRequest(method: "GET" | "POST", path: string, body?: unknown): Request {
  return new Request(`${ADMIN}${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * A business with two crews; Casey drives Crew A. `roles` says what each
 * signed-in person may do — the host's own permission check, as
 * create-app's crew role does it.
 */
async function business(overrides: Partial<CreateSchedulingAdminHandlersOptions> = {}, roles: Record<string, SchedulingPermission[]> = {}) {
  const tenantId = tenant();
  const crewA = await createResource(t.db, { tenantId, name: "Crew A", userId: "casey" });
  const crewB = await createResource(t.db, { tenantId, name: "Crew B" });
  const grants: Record<string, SchedulingPermission[]> = {
    owner: ["schedule.view", "schedule.manage", "schedule.resources.manage", "schedule.route"],
    casey: ["schedule.route"],
    ...roles,
  };
  let who = "owner";
  const recorder = eventRecorder();
  const { handle } = createSchedulingAdminHandlers({
    db: t.db,
    tenantId,
    authorize: (_req, permission) => (grants[who]?.includes(permission) ? { userId: who } : false),
    onEvent: recorder.onEvent,
    now: () => NOW,
    ...overrides,
  });
  const as = (person: string) => {
    who = person;
    return handle;
  };
  const visitOn = async (resourceId: string, startTime = "10:00") =>
    (
      await bookVisit(
        t.db,
        { tenantId, resourceId, scheduledDate: WED, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, customerEmail: "c@example.com", customerName: "Cus Tomer" },
        { now: NOW },
      )
    ).visit;
  return { tenantId, crewA, crewB, as, recorder, visitOn };
}

describe("BO-06: a crew member's login opens their own route and nothing else", () => {
  it("their own day and their own stops; not another crew's day or stop, not the calendar, not settings", async () => {
    const { crewA, crewB, as, visitOn } = await business();
    const mine = await visitOn(crewA.id);
    const theirs = await visitOn(crewB.id);
    const casey = as("casey");
    const day = await casey(adminRequest("GET", "/crew-day"));
    expect(day.status).toBe(200);
    expect((await readJson(day)).resource.name).toBe("Crew A");
    expect((await casey(adminRequest("GET", `/crew-day?resource=${crewB.id}`))).status).toBe(403);
    expect((await casey(adminRequest("POST", `/visits/${mine.id}/progress`, { status: "in_progress" }))).status).toBe(200);
    expect((await casey(adminRequest("POST", `/visits/${theirs.id}/progress`, { status: "in_progress" }))).status).toBe(403);
    expect((await casey(adminRequest("GET", `/calendar?from=${WED}&to=${WED}`))).status).toBe(403);
    expect((await casey(adminRequest("POST", "/settings", { timeZone: "America/Chicago" }))).status).toBe(403);
    expect((await casey(adminRequest("POST", `/visits/${mine.id}/status`, { status: "cancelled" }))).status).toBe(403);
  });

  it("the office (schedule.manage) can mark any crew's stop, and open any crew's day", async () => {
    const { crewB, as, visitOn } = await business();
    const theirs = await visitOn(crewB.id);
    const owner = as("owner");
    expect((await owner(adminRequest("GET", `/crew-day?date=${WED}&resource=${crewB.id}`))).status).toBe(200);
    expect((await owner(adminRequest("POST", `/visits/${theirs.id}/progress`, { status: "in_progress" }))).status).toBe(200);
  });
});

describe("SEC-2A-05 (Tenancy 2a review): a crew member opens TODAY's route only", () => {
  it("another day — past or future — is refused with a plain sentence; today is offered and marked today-only", async () => {
    const { crewA, as, visitOn } = await business();
    await visitOn(crewA.id);
    const casey = as("casey");
    for (const date of [WED, "2031-03-04", "2020-01-01"]) {
      const res = await casey(adminRequest("GET", `/crew-day?date=${date}`));
      expect(res.status, date).toBe(403);
      const body = await readJson(res);
      expect(body.error.message, date).toBe("You can open today's route only.");
      expect(JSON.stringify(body), date).not.toContain("Cus Tomer");
    }
    const today = await readJson(await casey(adminRequest("GET", "/crew-day?date=2026-03-02")));
    expect(today.date).toBe("2026-03-02");
    expect(today.todayOnly).toBe(true);
  });

  it("anyone who may see the schedule still pages through the days", async () => {
    const { crewA, as, visitOn } = await business();
    await visitOn(crewA.id);
    const day = await readJson(await as("owner")(adminRequest("GET", `/crew-day?date=${WED}&resource=${crewA.id}`)));
    expect(day.date).toBe(WED);
    expect(day.todayOnly).toBe(false);
    expect(JSON.stringify(day.stops)).toContain("Cus Tomer");
  });
});

describe("BO-11: a crew can undo, and record a stop they couldn't do", () => {
  it("complete → undo; couldn't do it, with a note → undo; never an email to the customer", async () => {
    const { tenantId, crewA, as, recorder, visitOn } = await business();
    const stop = await visitOn(crewA.id);
    const casey = as("casey");
    const move = async (status: string, note?: string) => {
      const response = await casey(adminRequest("POST", `/visits/${stop.id}/progress`, { status, ...(note ? { note } : {}) }));
      return [response.status, (await readJson(response)).visit?.status];
    };
    expect(await move("in_progress")).toEqual([200, "in_progress"]);
    expect(await move("completed")).toEqual([200, "completed"]);
    expect(await move("in_progress")).toEqual([200, "in_progress"]); // Undo a fat-fingered Complete
    expect(await move("no_show", "Gate locked, nobody home")).toEqual([200, "no_show"]);
    expect((await getBooking(t.db, tenantId, stop.id))?.cancelReason).toBe("Gate locked, nobody home");
    expect(await move("confirmed")).toEqual([200, "confirmed"]); // Undo "couldn't do it"
    expect((await getBooking(t.db, tenantId, stop.id))?.cancelReason).toBeNull();
    // A move a crew can't make from here is refused, not guessed at.
    const odd = await casey(adminRequest("POST", `/visits/${stop.id}/progress`, { status: "completed" }));
    expect([odd.status, (await readJson(odd)).error.code]).toEqual([409, "transition_not_allowed"]);
    // Nothing the crew did told the customer anything.
    expect(recorder.events.filter((e: SchedulingEvent) => e.data.notify)).toEqual([]);
  });
});

describe("BO-02: who opens a crew's route is picked from people, and the host is told", () => {
  it("GET people lists the host's people (null without a hook); linking someone calls onCrewMemberChange", async () => {
    const changes: unknown[] = [];
    const { crewB, as } = await business({
      listPeople: () => [
        { userId: "casey", name: "Casey Crew", email: "casey@acme.test" },
        { userId: "dana", name: "Dana Driver", email: null },
      ],
      onCrewMemberChange: (change) => {
        changes.push({ resource: change.resource.name, userId: change.userId, previousUserId: change.previousUserId, changedBy: change.changedBy });
      },
    });
    const owner = as("owner");
    expect(await readJson(await owner(adminRequest("GET", "/people")))).toEqual({
      people: [
        { userId: "casey", name: "Casey Crew", email: "casey@acme.test" },
        { userId: "dana", name: "Dana Driver", email: null },
      ],
    });
    await owner(adminRequest("POST", `/resources/${crewB.id}`, { userId: "dana" }));
    await owner(adminRequest("POST", `/resources/${crewB.id}`, { maxJobsPerDay: 4 })); // no change of person: not told
    await owner(adminRequest("POST", `/resources/${crewB.id}`, { userId: null }));
    await owner(adminRequest("POST", "/resources", { name: "Crew C", userId: "erin" }));
    expect(changes).toEqual([
      { resource: "Crew B", userId: "dana", previousUserId: null, changedBy: "owner" },
      { resource: "Crew B", userId: null, previousUserId: "dana", changedBy: "owner" },
      { resource: "Crew C", userId: "erin", previousUserId: null, changedBy: "owner" },
    ]);

    const bare = await business();
    expect(await readJson(await bare.as("owner")(adminRequest("GET", "/people")))).toEqual({ people: null });
  });
});

describe("RL-09: a host whose user ids are numbers", () => {
  it("authorize answering { userId: 42 } finds the crew linked to \"42\"", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew 42", userId: "42" });
    const { handle } = createSchedulingAdminHandlers({
      db: t.db,
      tenantId,
      authorize: () => ({ userId: 42 }),
      now: () => NOW,
    });
    const day = await handle(adminRequest("GET", `/crew-day?date=${WED}`));
    expect([day.status, (await readJson(day)).resource?.id]).toEqual([200, crew.id]);
  });
});

describe("BO-04: the staff screens are told whether anything reaches a customer", () => {
  it("no listener: customer emails are off, and the banner says so", async () => {
    const { as } = await business({ onEvent: undefined });
    const status = await readJson(await as("owner")(adminRequest("GET", "/status")));
    expect(status).toMatchObject({ customerEmails: false, reminders: false });
    expect(status.notices.map((n: { code: string }) => n.code)).toContain("emails_off");
  });

  it("the host's answer: emails on, reminders once a day (said in the business's clock), and its problems", async () => {
    const { tenantId, as } = await business({
      delivery: () => ({
        customerEmails: true,
        reminders: true,
        reminderRuns: { dailyAtUtc: "14:00" },
        problems: ["2 visit emails couldn't be sent this week. See Messages."],
      }),
    });
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver", businessName: "Acme", contactPhone: "(801) 555-0143" });
    const status = await readJson(await as("owner")(adminRequest("GET", "/status")));
    expect(status).toMatchObject({ customerEmails: true, reminders: true });
    const notices = status.notices as Array<{ code: string; message: string }>;
    expect(notices.map((n) => n.code)).toEqual(["delivery_problem", "reminders_daily"]);
    expect(notices[1]!.message).toMatch(/^Reminders go out once a day, at 7:00 AM, so each one arrives the day before the visit/);
  });

  it("first-boot setup: booking off, no name, no phone — each said, with the zone", async () => {
    const { tenantId, as } = await business({ delivery: () => ({ customerEmails: false, customerEmailsOffReason: "no email service is set up yet", reminders: false }) });
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver", publicBookingEnabled: false });
    const status = await readJson(await as("owner")(adminRequest("GET", "/status")));
    const codes = (status.notices as Array<{ code: string }>).map((n) => n.code);
    expect(codes).toEqual(["emails_off", "booking_off", "setup_name", "setup_contact", "setup_zone"]);
    expect(status.notices[0].message).toBe(
      "Customer emails are off: no email service is set up yet. Nobody is told about your answers, moves or cancellations, so call customers yourself until it's set up.",
    );
    expect(status.notices[4].message).toMatch(/^Visits are in Mountain Time \(America\/Denver\)/);
  });
});

describe("BO-08: correcting the time zone with visits booked", () => {
  it("the status counts the visits a change would move; saving with notifyCustomers emails each of them the corrected time", async () => {
    const { tenantId, crewA, as, recorder, visitOn } = await business();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver" });
    await visitOn(crewA.id, "09:00");
    await visitOn(crewA.id, "13:00");
    const owner = as("owner");
    expect((await readJson(await owner(adminRequest("GET", "/status")))).upcomingVisits).toBe(2);
    recorder.events.length = 0;
    const saved = await owner(adminRequest("POST", "/settings", { timeZone: "America/Chicago", notifyCustomers: true }));
    expect(saved.status).toBe(200);
    const moved = recorder.events.filter((e) => e.type === "visit.rescheduled");
    expect(moved.map((e) => [e.data.via, e.data.notify])).toEqual([
      ["time_zone", true],
      ["time_zone", true],
    ]);
    // Saving again without it emails nobody.
    recorder.events.length = 0;
    await owner(adminRequest("POST", "/settings", { timeZone: "America/Denver" }));
    expect(recorder.events.every((e) => e.data.notify === false)).toBe(true);
  });
});

describe("BO-09: a refusal in an owner's words", () => {
  it("a crew's day off and its hours, by name and on the 12-hour clock", async () => {
    const { crewA, as, visitOn } = await business();
    const visit = await visitOn(crewA.id);
    const owner = as("owner");
    const saturday = await readJson(await owner(adminRequest("POST", `/visits/${visit.id}/reschedule`, { date: SAT, startTime: "10:00" })));
    expect(saturday.error).toEqual({ code: "outside_hours", message: "Crew A doesn't work on Saturday, March 7" });
    const evening = await readJson(await owner(adminRequest("POST", `/visits/${visit.id}/reschedule`, { date: WED, startTime: "18:00" })));
    expect(evening.error).toEqual({
      code: "outside_hours",
      message: "Crew A works 8:00 AM – 5:00 PM on Wednesdays; 6:00 PM – 7:00 PM is outside those hours",
    });
  });
});

describe("F8: a zone change re-queues reminders several at a time, not one by one inside the request", () => {
  it("the listener sees more than one visit at once (at most eight)", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver" });
    const crew = await createResource(t.db, { tenantId, name: "Crew", maxJobsPerDay: 50 });
    for (let day = 4; day <= 13; day += 1) {
      const date = `2026-03-${String(day).padStart(2, "0")}`;
      for (const start of ["08:00", "10:00", "13:00"]) {
        await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: date, startTime: start, endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00` }, { now: NOW, skipValidation: true });
      }
    }
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    const listener = async () => {
      calls += 1;
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    };
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Chicago" }, { now: NOW, onEvent: listener });
    expect(calls).toBe(30);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });
});
