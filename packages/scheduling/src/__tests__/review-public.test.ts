import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookVisit,
  clientIpKey,
  createGoogleMapsProvider,
  createResource,
  createSchedulingHandlers,
  findPublicSlots,
  getBooking,
  getVisitByToken,
  listBookings,
  requestPublicBooking,
  rescheduleBooking,
  rescheduleVisitByToken,
  cancelVisitByToken,
  updateSchedulingSettings,
  type CreateSchedulingHandlersOptions,
} from "../index.js";
import { apiRequest, eventRecorder, fakeGoogle, GOOGLE_KEY, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The 0.4 review's findings on the CUSTOMER side, each a test that failed
 * before its fix (run against the pre-fix build as a negative control):
 *
 *   F2  the booking form can't carry line breaks or links into an email
 *   F3  a request past its deadline is treated as expired everywhere
 *   F4  a repeat gets no key and none of another requester's details
 *   F6  auto-confirm doesn't switch the per-caller cap off
 *   F8  a write in the old time zone after a zone change is refused
 *   BO-07  "send it anyway" for an address the map can't find
 *   RL-02  the requester key is the address your proxy saw
 *   RL-03  no listener, no promise of email
 *
 * NOW is Monday 2026-03-02 09:00 UTC; a tenant that never saved settings is
 * on UTC.
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const HOUR = 3_600_000;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const manageUrl = (token: string) => `https://acme.test/visit/${token}`;

async function publicApi(overrides: Partial<CreateSchedulingHandlersOptions> = {}, settings: Parameters<typeof updateSchedulingSettings>[2] = {}) {
  const tenantId = tenant();
  if (Object.keys(settings).length > 0) await updateSchedulingSettings(t.db, tenantId, settings);
  const crew = await createResource(t.db, { tenantId, name: "Crew" });
  let clock = NOW;
  const { handle } = createSchedulingHandlers({ db: t.db, tenantId, manageUrl, now: () => clock, ...overrides });
  return {
    tenantId,
    crew,
    handle,
    setNow(next: Date) {
      clock = next;
    },
  };
}

const form = (slotId: string, extra: Record<string, unknown> = {}) => ({
  slotId,
  service: "visit",
  name: "Pat Visitor",
  email: "pat@example.com",
  fillMs: 5000,
  ...extra,
});

async function slotAt(handle: (req: Request) => Promise<Response>, startTime: string, date = WED) {
  const body = await readJson(await handle(apiRequest("GET", `/v1/slots?service=visit&from=${date}&days=1`)));
  const slot = (body.slots as Array<{ slotId: string; startTime: string }>).find((s) => s.startTime === startTime);
  if (!slot) throw new Error(`no ${startTime} slot on ${date}`);
  return slot;
}

describe("F2: the booking form can't make the business send a phishing email", () => {
  it("a line break or a web address in the name or address is refused on the field, before anything is written", async () => {
    const { tenantId, handle } = await publicApi();
    const slot = await slotAt(handle, "10:00");
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ name: "Pat\r\nBcc: x@evil.example" }, "name"],
      [{ address: "1 Main St\n\nIMPORTANT: your card on file was declined. Update it here https://evil.example/pay" }, "address"],
      [{ address: "1 Main St, update at www.evil.example" }, "address"],
      [{ address: "1 Main St — see evil.com/pay" }, "address"],
      [{ name: "Visit https://evil.example now" }, "name"],
      [{ phone: "801\n555" }, "phone"],
    ];
    for (const [extra, field] of attempts) {
      const response = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, extra)));
      const body = await readJson(response);
      expect([response.status, body.error.code, body.error.issues?.[0]?.path?.[0]]).toEqual([400, "invalid", field]);
    }
    expect(await listBookings(t.db, tenantId, { from: new Date(`${WED}T00:00:00Z`), to: new Date(`${WED}T00:00:00Z`) })).toEqual([]);
  });

  it("an ordinary name and address still book", async () => {
    const { handle } = await publicApi();
    const slot = await slotAt(handle, "10:00");
    const response = await handle(
      apiRequest("POST", "/v1/request", form(slot.slotId, { name: "Mary-Jo O'Brien", address: "12 St. Louis Ave, P.O. Box 4, Salt Lake City, UT 84101" })),
    );
    expect(response.status).toBe(201);
  });

  it("the functions refuse it too, not only the HTTP form (staff paths: one line)", async () => {
    const tenantId = tenant();
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    await expect(
      requestPublicBooking(
        t.db,
        { tenantId, slotId: slot!.slotId, service: "visit", customerName: "Pat", customerEmail: "p@example.com", address: "1 Main St\nhttps://evil.example" },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "09:00", endTime: "10:00", customerName: "A\r\nB" }, { now: NOW }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("F3: a request past its deadline is expired, wherever a customer acts on it", () => {
  async function overdue() {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { pendingExpiryHours: 1, cancelCutoffHours: 0 });
    await createResource(t.db, { tenantId, name: "Crew" });
    const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slots.find((s) => s.startTime === "09:00")!.slotId, service: "visit", customerName: "Ann", customerEmail: "ann@example.com" },
      { now: NOW },
    );
    // Two hours on: the deadline (an hour after asking) has passed and no sweep has run.
    return { tenantId, receipt, later: new Date(NOW.getTime() + 2 * HOUR) };
  }

  it("the customer's page reads expired, with nothing to change", async () => {
    const { tenantId, receipt, later } = await overdue();
    expect(await getVisitByToken(t.db, tenantId, receipt.manageToken!, { now: later })).toMatchObject({
      status: "expired",
      canReschedule: false,
      canCancel: false,
      googleCalendarUrl: null,
    });
  });

  it("moving it is refused too_late — and the time it no longer holds stays bookable by the next customer", async () => {
    const { tenantId, receipt, later } = await overdue();
    const own = await findPublicSlots(t.db, { tenantId, service: "visit", manageToken: receipt.manageToken, from: WED, days: 1 }, { now: later });
    const anyone = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: later });
    // The overdue visit's token earns nothing: the same list anybody gets.
    expect(own).toEqual(anyone);
    const target = anyone.find((s) => s.startTime === "13:00")!;
    await expect(
      rescheduleVisitByToken(t.db, tenantId, receipt.manageToken!, { slotId: target.slotId }, { now: later }),
    ).rejects.toMatchObject({ code: "too_late" });
    await expect(cancelVisitByToken(t.db, tenantId, receipt.manageToken!, {}, { now: later })).rejects.toMatchObject({ code: "too_late" });
    expect((await getBooking(t.db, tenantId, receipt.id))?.startTime).toBe("09:00");
  });

  it("staff moving an overdue request answer it: it gets a fresh deadline and holds its new time", async () => {
    const { tenantId, receipt, later } = await overdue();
    const moved = await rescheduleBooking(t.db, tenantId, { id: receipt.id, date: WED, startTime: "13:00" }, { now: later });
    expect(moved?.visit.status).toBe("pending");
    expect(moved!.visit.pendingExpiresAt!.getTime()).toBeGreaterThan(later.getTime());
  });
});

describe("F4: a repeated request gets no key and none of the stored details", () => {
  it("with no requester key (no forwarding header), a second ask for the same time and email is just a taken time", async () => {
    const { handle, tenantId } = await publicApi();
    const slot = await slotAt(handle, "10:00");
    const victim = await handle(
      apiRequest("POST", "/v1/request", form(slot.slotId, { name: "Victoria Victim", email: "vic@example.com", address: "42 Private Ln" }), {
        "x-forwarded-for": "198.51.100.9",
      }),
    );
    expect(victim.status).toBe(201);
    const attacker = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { name: "X", email: "VIC@example.com" })));
    const body = await readJson(attacker);
    expect([attacker.status, body.error?.code]).toEqual([409, "slot_unavailable"]);
    expect(JSON.stringify(body)).not.toMatch(/Victoria|Private|manageToken/);
    expect(await listBookings(t.db, tenantId, { from: new Date(`${WED}T00:00:00Z`), to: new Date(`${WED}T00:00:00Z`) })).toHaveLength(1);
  });

  it("the same requester again: told it landed — the time, no token, and what THEY typed, not what is stored", async () => {
    const { handle } = await publicApi();
    const slot = await slotAt(handle, "11:00");
    const headers = { "x-forwarded-for": "203.0.113.50" };
    const first = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { name: "Victoria Victim", address: "42 Private Ln" }), headers));
    expect(first.status).toBe(201);
    const again = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { name: "Someone Else", address: "1 Other St" }), headers));
    const body = await readJson(again);
    expect(again.status).toBe(200);
    expect(body).toMatchObject({ repeated: true, manageToken: null, manageUrl: null, visit: { startTime: "11:00", customerName: "Someone Else", address: "1 Other St" } });
    expect(JSON.stringify(body)).not.toMatch(/Victoria|Private/);
  });
});

describe("F6: auto-confirm doesn't switch the per-caller cap off", () => {
  it("confirmed online visits count against the cap, as requests do", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { autoConfirm: true, maxOpenRequestsPerRequester: 1 });
    await createResource(t.db, { tenantId, name: "Crew" });
    const slots = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    const ask = (startTime: string, email: string) =>
      requestPublicBooking(
        t.db,
        { tenantId, slotId: slots.find((s) => s.startTime === startTime)!.slotId, service: "visit", customerName: "Bot", customerEmail: email },
        { now: NOW, requesterKey: "ip:203.0.113.66" },
      );
    expect((await ask("09:00", "a@example.com")).status).toBe("confirmed");
    await expect(ask("13:00", "b@example.com")).rejects.toMatchObject({ code: "too_many_requests" });
  });
});

describe("F8: a write worked out in the old time zone is refused after the zone changed", () => {
  it("a request and a staff booking carrying settings read before the save are refused, not stored an hour off", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Denver" });
    const crew = await createResource(t.db, { tenantId, name: "Crew" });
    const stale = await import("../index.js").then((m) => m.getSchedulingSettings(t.db, tenantId));
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW, settings: stale });
    // The owner corrects the zone between this request's read and its write.
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "America/Chicago" });
    await expect(
      requestPublicBooking(
        t.db,
        { tenantId, slotId: slot!.slotId, service: "visit", customerName: "Pat", customerEmail: "p@example.com" },
        { now: NOW, settings: stale },
      ),
    ).rejects.toMatchObject({ code: "slot_unavailable", message: expect.stringMatching(/time zone was changed/) });
    await expect(
      bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "09:00", endTime: "10:00" }, { now: NOW, settings: stale }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/time zone was changed/) });
    expect(await listBookings(t.db, tenantId, { from: new Date(`${WED}T00:00:00Z`), to: new Date(`${WED}T00:00:00Z`) })).toEqual([]);
  });
});

describe("BO-07: an address the map can't find can be sent anyway", () => {
  it("refused once with address_unresolved; sent anyway, it books without coordinates and the office is told to check it", async () => {
    const google = fakeGoogle({ places: {} });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch });
    const recorder = eventRecorder();
    const { handle, tenantId } = await publicApi({ maps, onEvent: recorder.onEvent }, { requireAddress: true });
    const slot = await slotAt(handle, "10:00");
    const address = "9 New Subdivision Rd, Eagle Mountain";
    const first = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { address })));
    expect([first.status, (await readJson(first)).error.code]).toEqual([400, "address_unresolved"]);
    const anyway = await handle(apiRequest("POST", "/v1/request", form(slot.slotId, { address, addressAsTyped: true })));
    expect(anyway.status).toBe(201);
    const row = await getBooking(t.db, tenantId, recorder.events[0]!.visitId);
    expect(row).toMatchObject({ address, lat: null, lng: null, status: "pending" });
    expect(recorder.events[0]!.data.addressUnverified).toBe(true);
  });
});

describe("RL-02: the requester key is the address your own proxy saw", () => {
  it("the LAST X-Forwarded-For entry by default; trustProxy picks further left; X-Real-IP without one", () => {
    const req = (headers: Record<string, string>) => new Request("https://acme.test/", { headers });
    expect(clientIpKey(req({ "x-forwarded-for": "10.0.0.7, 9.9.9.9" }))).toBe("ip:9.9.9.9");
    expect(clientIpKey(req({ "x-forwarded-for": "198.51.100.1, 10.0.0.7, 9.9.9.9" }), { trustProxy: 2 })).toBe("ip:10.0.0.7");
    expect(clientIpKey(req({ "x-forwarded-for": "203.0.113.5" }))).toBe("ip:203.0.113.5");
    expect(clientIpKey(req({ "x-real-ip": "203.0.113.6" }))).toBe("ip:203.0.113.6");
    expect(clientIpKey(req({}))).toBeNull();
  });

  it("a script inventing a new first entry each time is still one caller to the cap", async () => {
    const { handle } = await publicApi({}, { maxOpenRequestsPerRequester: 3 });
    const times = ["09:00", "11:00", "13:00", "15:00"];
    const statuses: number[] = [];
    for (const [index, time] of times.entries()) {
      const slot = await slotAt(handle, time);
      const response = await handle(
        apiRequest("POST", "/v1/request", form(slot.slotId, { email: `bot${index}@example.com` }), { "x-forwarded-for": `10.0.0.${index}, 9.9.9.9` }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
  });
});

describe("RL-03: a deployment with no listener promises no email", () => {
  it("emailsEnabled defaults to whether onEvent was given; an explicit answer wins", async () => {
    const config = async (overrides: Partial<CreateSchedulingHandlersOptions>) =>
      (await readJson(await (await publicApi(overrides)).handle(apiRequest("GET", "/v1/config")))).emailsEnabled;
    expect(await config({})).toBe(false);
    expect(await config({ onEvent: async () => undefined })).toBe(true);
    expect(await config({ onEvent: async () => undefined, emailsEnabled: false })).toBe(false);
  });
});
