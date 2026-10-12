import { commsMessages, commsScheduled, runDueMessages, type ScheduledRow } from "@adminigloo/comms";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COMMS_TABLES_MISSING,
  SCHEDULING_EMAIL_TEMPLATES,
  createSchedulingCommsListener,
  schedulingEmailVars,
} from "../comms.js";
import {
  bookVisit,
  createResource,
  expirePendingRequests,
  findPublicSlots,
  getSchedulingSettings,
  getVisitByToken,
  requestPublicBooking,
  setBookingStatus,
  updateBookingDetails,
  updateSchedulingSettings,
  type SchedulingEvent,
} from "../index.js";
import { recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The 0.4 review's findings on the EMAILS, each a test that failed before its
 * fix (run against the pre-fix build as a negative control):
 *
 *   BO-01/F5  on a once-a-day cron the reminder still arrives the day before,
 *             with a link that works; past the cutoff it offers the phone
 *   F1        a corrected email address gets the visit re-sent and the old
 *             links revoked; the reminder goes where the visit says NOW
 *   F7        reminders switched off stop the ones already queued
 *   F9        a manage link left in the log by a crashed run is scrubbed
 *   F2        customer-typed text never becomes a link or a header
 *   BO-05     a lapsed request is a notice to the office
 *   BO-13     no "a Aeration"
 *   RL-01     missing comms tables fail loudly
 *   RL-04     a mail server that never answers can't hold a booking open
 */

const THU = new Date("2026-10-29T15:00:00Z"); // Thu 2026-10-29 09:00 MDT
const HOUR = 3_600_000;
const TOKEN_IN_LINK = /https:\/\/acme\.test\/visit\/([A-Za-z0-9_-]{43})/;

let t: TestDb;
let clock = THU;
const setClock = (next: Date) => {
  clock = next;
  vi.setSystemTime(next);
};

beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  vi.useRealTimers();
});

type ListenerOptions = Parameters<typeof createSchedulingCommsListener>[0];

async function setUp(settings: Parameters<typeof updateSchedulingSettings>[2] = {}, listener: Partial<ListenerOptions> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(THU);
  const tenantId = tenant("acme");
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    contactPhone: "(801) 555-0143",
    staffNotifyEmails: ["office@acme.test"],
    services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    ...settings,
  });
  const crew = await createResource(t.db, { tenantId, name: "Crew A" });
  const mail = recordingSender();
  const errors: Array<{ error: unknown; step: string }> = [];
  const comms = createSchedulingCommsListener({
    db: t.db,
    senders: mail.senders,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    bookUrl: "https://acme.test/book",
    adminUrl: "https://acme.test/admin/schedule",
    now: () => clock,
    onError: (error, context) => errors.push({ error, step: context.step }),
    ...listener,
  });
  return { tenantId, crew, mail, errors, comms };
}

/** The comms cron, as create-app runs it: the drain, then the scrub (in a finally). */
async function cron(tenantId: string, comms: ReturnType<typeof createSchedulingCommsListener>, mail: ReturnType<typeof recordingSender>) {
  // runDueMessages drains every tenant: park the other tests' rows.
  await t.client.query(`update comms_scheduled set status = 'cancelled' where tenant_id <> $1 and status = 'pending'`, [tenantId]);
  try {
    return await runDueMessages(t.db, mail.senders, { now: clock, beforeSend: async (row) => (await comms.beforeSend(row)) ?? "send" });
  } finally {
    await comms.redactSent();
  }
}

async function queueRows(tenantId: string): Promise<ScheduledRow[]> {
  return (await t.db.select().from(commsScheduled).where(eq(commsScheduled.tenantId, tenantId))) as ScheduledRow[];
}
async function logRows(tenantId: string) {
  return t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, tenantId));
}

describe("BO-01 / F5: the reminder on a once-a-day cron", () => {
  it("goes out on the run the day before — at least the lead ahead — with a link that still reschedules", async () => {
    // The e2e scenario's business: 24-hour reminders, a 12-hour change cutoff,
    // and create-app's Vercel Hobby cron, once a day at 14:00 UTC.
    const { tenantId, crew, mail, comms } = await setUp(
      { reminderLeadHours: 24, cancelCutoffHours: 12 },
      { reminderRuns: { dailyAtUtc: "14:00" } },
    );
    // Mon 2026-11-02 09:00 MST = 16:00Z, booked and confirmed by the office.
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", serviceType: "estimate", customerName: "Pat Visitor", customerEmail: "pat@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    mail.sent.length = 0;

    // The cron runs ONLY at 14:00 UTC (07:00 MST / 08:00 MDT), day after day.
    const runs: Array<[string, number]> = [];
    for (const day of ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]) {
      setClock(new Date(`${day}T14:00:00Z`));
      const result = await cron(tenantId, comms, mail);
      runs.push([day, result.sent]);
    }
    expect(runs).toEqual([["2026-10-30", 0], ["2026-10-31", 0], ["2026-11-01", 1], ["2026-11-02", 0]]);
    const reminder = mail.sent.find((m) => m.subject.startsWith("Reminder"))!;
    expect(reminder.subject).toBe("Reminder: Free estimate, Mon, Nov 2, 9:00 AM MST");
    // Sent Sunday 07:00 MST: 26 hours ahead, and the link in it still works.
    expect(reminder.body).toContain("Reschedule or cancel here, no account needed (up to 12 hours before the visit):");
    const token = TOKEN_IN_LINK.exec(reminder.body)![1]!;
    setClock(new Date("2026-11-01T14:05:00Z"));
    expect(await getVisitByToken(t.db, tenantId, token, { now: clock })).toMatchObject({ status: "confirmed", canReschedule: true, canCancel: true });
    expect((await queueRows(tenantId)).find((r) => r.refId === visit.id)?.sendAt.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("a reminder that arrives past the change cutoff never offers what the server would refuse: the phone instead, no link", async () => {
    // A short heads-up (2 hours) with a 24-hour cutoff: by then it can't be changed online.
    const { tenantId, crew, mail, comms } = await setUp({ reminderLeadHours: 2, cancelCutoffHours: 24 });
    await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", serviceType: "estimate", customerName: "Pat Visitor", customerEmail: "pat@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    mail.sent.length = 0;
    setClock(new Date("2026-11-02T14:00:00Z")); // 07:00 MST, two hours before
    expect((await cron(tenantId, comms, mail)).sent).toBe(1);
    const body = mail.sent[0]!.body;
    expect(body).toContain("Need to change it? It's within 24 hours of the visit, so it can't be changed online any more. Please call us at (801) 555-0143.");
    expect(body).not.toMatch(/Reschedule or cancel here/);
    expect(body).not.toMatch(/acme\.test\/visit\//);
  });
});

describe("F1: correcting a customer's email address", () => {
  it("re-sends the visit to the new address with a working link, revokes every old link, and moves the reminder", async () => {
    const { tenantId, crew, mail, comms } = await setUp();
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", serviceType: "estimate", customerName: "Pat Visitor", customerEmail: "pat@exmaple.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    const typoToken = TOKEN_IN_LINK.exec(mail.sent.find((m) => m.to === "pat@exmaple.com")!.body)![1]!;
    mail.sent.length = 0;

    await updateBookingDetails(t.db, tenantId, { id: visit.id, patch: { customerEmail: "pat@example.com" } }, { now: clock, onEvent: comms.onEvent });

    // The link already sent to the typo address opens nothing any more.
    expect(await getVisitByToken(t.db, tenantId, typoToken, { now: clock })).toBeNull();
    // The real customer gets the visit, with a link that works.
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([["pat@example.com", "Confirmed: Free estimate, Mon, Nov 2, 9:00 AM MST"]]);
    expect(mail.sent[0]!.body).toContain("We've updated the email address we have for you");
    const fresh = TOKEN_IN_LINK.exec(mail.sent[0]!.body)![1]!;
    expect(await getVisitByToken(t.db, tenantId, fresh, { now: clock })).toMatchObject({ status: "confirmed" });
    // The reminder queued for the typo is withdrawn; one for the real address waits.
    const queued = (await queueRows(tenantId)).map((r) => [r.toAddress, r.status]);
    expect(queued).toEqual([
      ["pat@exmaple.com", "cancelled"],
      ["pat@example.com", "pending"],
    ]);
  });

  it("at send time the reminder goes where the visit says NOW — the address it's sent to and the details in it", async () => {
    const { tenantId, crew, mail, comms } = await setUp();
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", serviceType: "estimate", customerName: "Pat Visitor", customerEmail: "pat@example.com", address: "1 Old Rd" },
      { now: clock, onEvent: comms.onEvent },
    );
    const [row] = await queueRows(tenantId);
    // Edited behind the queue's back (a host writing the row directly): the reminder still follows.
    await t.client.query(`update scheduling_bookings set address = '7 New Ln', customer_name = 'Patricia Visitor', customer_email = 'patricia@example.com' where id = $1`, [visit.id]);
    setClock(new Date(row!.sendAt.getTime() + 60_000));
    const decision = (await comms.beforeSend(row!)) as { to?: string; vars?: Record<string, string> };
    expect(decision.to).toBe("patricia@example.com");
    expect(decision.vars).toMatchObject({ address: "7 New Ln", firstName: "Patricia" });
    await t.client.query(`update scheduling_bookings set customer_email = null where id = $1`, [visit.id]);
    expect(await comms.beforeSend(row!)).toEqual({ skip: true, reason: "the visit has no email address any more" });
    void mail;
  });
});

describe("F7: switching reminders off stops the ones already queued", () => {
  it("a reminder queued before the lead was set to 0 is skipped at send time", async () => {
    const { tenantId, crew, comms } = await setUp();
    await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "pat@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    const [row] = await queueRows(tenantId);
    await updateSchedulingSettings(t.db, tenantId, { reminderLeadHours: 0 });
    setClock(new Date(row!.sendAt.getTime() + 60_000));
    expect(await comms.beforeSend(row!)).toEqual({ skip: true, reason: "reminders are switched off" });
  });
});

describe("F9: no manage link outlives a crashed run in the delivery log", () => {
  it("a reminder sent by a run that never scrubbed is scrubbed by the next run's redactSent, in a new process", async () => {
    const { tenantId, crew, mail, comms } = await setUp();
    await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "pat@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    const [row] = await queueRows(tenantId);
    setClock(new Date(row!.sendAt.getTime() + 60_000));
    await t.client.query(`update comms_scheduled set status = 'cancelled' where tenant_id <> $1 and status = 'pending'`, [tenantId]);
    // The drain sends the reminder... and the function dies before redactSent.
    await runDueMessages(t.db, mail.senders, { now: clock, beforeSend: async (r) => (await comms.beforeSend(r)) ?? "send" });
    const token = TOKEN_IN_LINK.exec(mail.sent.at(-1)!.body)![1]!;
    expect((await logRows(tenantId)).some((r) => r.body.includes(token))).toBe(true);
    // The next cold start's listener remembers nothing of it.
    const nextProcess = createSchedulingCommsListener({ db: t.db, senders: mail.senders, manageUrl: (x) => `https://acme.test/visit/${x}` });
    expect(await nextProcess.redactSent()).toBeGreaterThanOrEqual(1);
    const log = await logRows(tenantId);
    expect(log.some((r) => r.body.includes(token))).toBe(false);
    expect(log.find((r) => r.templateKey === "visit_reminder")?.body).toContain("https://acme.test/visit/:token");
  });
});

describe("F2: what a customer typed never becomes a link or a header in an email", () => {
  it("a stored multi-line address with a web address is one line with the link broken; a link-shaped first name is 'there'; the subject is one line", async () => {
    const { tenantId } = await setUp();
    const settings = await getSchedulingSettings(t.db, tenantId);
    const event = {
      id: "e1",
      type: "visit.requested",
      tenantId,
      visitId: "v1",
      occurredAt: clock.toISOString(),
      actor: { type: "customer", id: null },
      data: {
        notify: true,
        via: "online",
        visit: {
          id: "v1", status: "pending", nextStatuses: [], date: "2026-11-02", startTime: "09:00", endTime: "10:00",
          startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z", timeZone: "America/Denver",
          durationMinutes: 60, resourceId: null, resourceName: null, serviceKey: "estimate", serviceName: "Free estimate",
          title: null, customerName: "https://evil.example/pay\r\nBcc: x@evil.example", customerEmail: "victim@example.com", customerPhone: null,
          address: "1 Main St\n\nIMPORTANT: your card was declined. Update it here https://evil.example/pay or at www.evil.example",
          lat: null, lng: null, notes: null, estimateId: null, origin: "public", sequence: 0, pendingExpiresAt: null,
          cancelledAt: null, cancelledBy: null, cancelReason: null, startedAt: null, completedAt: null,
          createdAt: clock.toISOString(), updatedAt: clock.toISOString(),
        },
      },
    } as SchedulingEvent;
    const customer = schedulingEmailVars(event, settings, { manageUrl: null });
    expect(customer.firstName).toBe("there");
    expect(customer.address).not.toMatch(/[\r\n]/);
    expect(customer.address).not.toMatch(/https:\/\/|www\.evil/);
    expect(customer.address).toContain("evil[.]example/pay");
    const office = schedulingEmailVars(event, settings, { manageUrl: null, audience: "staff" });
    expect(office.customerName).not.toMatch(/[\r\n]/);
  });
});

describe("BO-05: a request that lapses unanswered is a notice to the office", () => {
  it("the office hears whose request lapsed, alongside the customer", async () => {
    const { tenantId, mail, comms } = await setUp({ pendingExpiryHours: 24 });
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "estimate", from: "2026-11-09", days: 1 }, { now: clock });
    await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, service: "estimate", customerName: "Kim Waiting", customerEmail: "kim@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    mail.sent.length = 0;
    await expirePendingRequests(t.db, tenantId, { now: new Date(clock.getTime() + 25 * HOUR), onEvent: comms.onEvent });
    expect(mail.sent.map((m) => m.to)).toEqual(["kim@example.com", "office@acme.test"]);
    const notice = mail.sent[1]!;
    expect(notice.subject).toMatch(/^Request expired: Kim Waiting, Mon, Nov 9/);
    expect(notice.body).toContain("Nobody answered Kim Waiting's Free estimate request in time");
  });
});

describe("BO-13: the emails read right whatever the service is called", () => {
  it("no template puts an article before the owner's service name", () => {
    for (const template of SCHEDULING_EMAIL_TEMPLATES) {
      expect(`${template.subject}\n${template.body}`, template.key).not.toMatch(/\b(a|an) \{\{serviceName\}\}/i);
    }
  });
});

describe("RL-01: missing comms tables fail loudly", () => {
  it("no onError: the failure reaches console.error; ensureTemplates and verify say which migration is missing", async () => {
    const bare = await createTestDb(); // the scheduling tables only
    try {
      const tenantId = tenant();
      const crew = await createResource(bare.db, { tenantId, name: "Crew" });
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const listener = createSchedulingCommsListener({ db: bare.db, senders: recordingSender().senders, manageUrl: (x) => x });
      await bookVisit(
        bare.db,
        { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "pat@example.com" },
        { now: THU, onEvent: listener.onEvent },
      );
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls.flat().find((arg) => arg instanceof Error))).toContain("comms tables");
      spy.mockRestore();
      await expect(listener.ensureTemplates(tenantId)).rejects.toThrow(COMMS_TABLES_MISSING);
      await expect(listener.verify()).rejects.toThrow(COMMS_TABLES_MISSING);
    } finally {
      await bare.close();
    }
  });
});

describe("RL-04: a mail server that never answers can't hold a booking open", () => {
  it("each send gives up waiting after sendTimeoutMs, reported, and the event finishes", async () => {
    const hanging = { email: () => new Promise<never>(() => undefined) };
    const { tenantId, crew, errors, comms } = await setUp({}, { senders: hanging, sendTimeoutMs: 50 });
    const started = Date.now();
    vi.useRealTimers();
    await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "pat@example.com" },
      { now: THU, onEvent: comms.onEvent },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(errors.map((e) => e.step)).toContain("send:visit_confirmed");
    expect(String(errors.find((e) => e.step === "send:visit_confirmed")?.error)).toMatch(/longer than 50 ms/);
  });
});

describe("statuses a crew sets never email the customer", () => {
  it("a no-show (with the crew's note) sends nothing", async () => {
    const { tenantId, crew, mail, comms } = await setUp();
    const { visit } = await bookVisit(
      t.db,
      { tenantId, resourceId: crew.id, scheduledDate: "2026-10-29", startTime: "11:00", endTime: "12:00", customerEmail: "pat@example.com" },
      { now: clock, onEvent: comms.onEvent },
    );
    mail.sent.length = 0;
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "no_show", reason: "Gate locked" }, { now: clock, onEvent: comms.onEvent });
    expect(mail.sent).toEqual([]);
  });
});
