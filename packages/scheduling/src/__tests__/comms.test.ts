import {
  commsMessages,
  commsScheduled,
  enqueueMessage,
  getTemplate,
  runDueMessages,
  upsertTemplate,
  type ScheduledRow,
} from "@adminigloo/comms";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SCHEDULING_COMMS_REF_TYPE,
  SCHEDULING_EMAIL_TEMPLATES,
  createSchedulingCommsListener,
  schedulingEmailVars,
} from "../comms.js";
import {
  assignBooking,
  bookVisit,
  cancelVisitByToken,
  createResource,
  expirePendingRequests,
  findPublicSlots,
  getSchedulingSettings,
  getVisitByToken,
  requestPublicBooking,
  rescheduleBooking,
  rescheduleVisitByToken,
  setBookingStatus,
  updateSchedulingSettings,
  type SchedulingEvent,
} from "../index.js";
import { recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The comms listener with the real @adminigloo/comms on PGlite: what each
 * event sends and to whom, the reminder queued at the right instant and
 * withdrawn when the visit moves or stops, the send-time re-check, and a
 * delivery log that never keeps a manage token.
 *
 * comms' `enqueueMessage` checks a reminder's expiry against the real clock,
 * so the system clock is pinned to the test's clock (Date only — timers stay
 * real).
 */

const THU = new Date("2026-10-29T15:00:00Z"); // Thu 2026-10-29 09:00 MDT
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

async function setUp(overrides: Parameters<typeof updateSchedulingSettings>[2] = {}, listenerOverrides: Partial<Parameters<typeof createSchedulingCommsListener>[0]> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(THU);
  const tenantId = tenant("acme");
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    contactPhone: "(801) 555-0143",
    staffNotifyEmails: ["office@acme.test"],
    services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    ...overrides,
  });
  const crew = await createResource(t.db, { tenantId, name: "Crew A" });
  const mail = recordingSender();
  const errors: unknown[] = [];
  const listener = createSchedulingCommsListener({
    db: t.db,
    senders: mail.senders,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    bookUrl: "https://acme.test/book",
    adminUrl: "https://acme.test/admin/schedule",
    now: () => clock,
    onError: (error) => errors.push(error),
    ...listenerOverrides,
  });
  const write = { onEvent: listener.onEvent };
  const request = async (date: string, startTime: string, email = "pat@example.com") => {
    const slot = (await findPublicSlots(t.db, { tenantId, service: "estimate", from: date, days: 1 }, { now: clock })).find(
      (s) => s.startTime === startTime,
    )!;
    return requestPublicBooking(
      t.db,
      { tenantId, slotId: slot.slotId, service: "estimate", customerName: "Pat Visitor", customerEmail: email, address: "1 Main St, SLC" },
      { now: clock, ...write },
    );
  };
  return { tenantId, crew, mail, errors, listener, write, request };
}

async function logRows(tenantId: string) {
  return t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, tenantId));
}
async function queueRows(tenantId: string): Promise<ScheduledRow[]> {
  return (await t.db.select().from(commsScheduled).where(eq(commsScheduled.tenantId, tenantId))) as ScheduledRow[];
}

describe("what each event sends", () => {
  it("every template renders with no missing variable, for every event shape", async () => {
    const { tenantId, crew, write, request } = await setUp({ autoConfirm: false });
    const other = await createResource(t.db, { tenantId, name: "Crew B" });
    const staff = { ...write, now: clock, actor: { type: "staff" as const, id: "u1" } };
    const a = await request("2026-11-02", "09:00"); // requested (pending, online) + office notice
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, staff); // confirmed (accept)
    await rescheduleBooking(t.db, tenantId, { id: a.id, date: "2026-11-03", startTime: "10:00" }, staff); // rescheduled (staff)
    await assignBooking(t.db, tenantId, { id: a.id, resourceId: other.id }, staff); // reassigned
    const own = await findPublicSlots(t.db, { tenantId, manageToken: a.manageToken, from: "2026-11-05", days: 1 }, { now: clock });
    await rescheduleVisitByToken(t.db, tenantId, a.manageToken!, { slotId: own[0]!.slotId }, { now: clock, ...write }); // rescheduled (customer)
    await cancelVisitByToken(t.db, tenantId, a.manageToken!, { reason: "Moving" }, { now: clock, ...write }); // cancelled (customer)
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, staff); // confirmed (restore)
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "cancelled", reason: "Crew sick" }, staff); // cancelled (staff)
    const b = await request("2026-11-04", "10:00", "b@example.com");
    await setBookingStatus(t.db, tenantId, { id: b.id, status: "declined", reason: "Out of our area" }, staff);
    await request("2026-11-04", "13:00", "c@example.com");
    await expirePendingRequests(t.db, tenantId, { now: new Date("2026-11-04T00:00:00Z"), ...write }); // expired
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-11-06", startTime: "09:00", endTime: "10:00", customerEmail: "d@example.com" }, staff); // confirmed (staff)
    await updateSchedulingSettings(t.db, tenantId, { autoConfirm: true });
    await request("2026-11-09", "09:00", "e@example.com"); // requested (auto) + confirmed (auto) + "New booking"

    const log = await logRows(tenantId);
    const keys = new Set(log.map((row) => row.templateKey));
    for (const template of SCHEDULING_EMAIL_TEMPLATES.filter((tpl) => tpl.key !== "visit_reminder")) {
      expect(keys, template.key).toContain(template.key);
    }
    expect(log.filter((row) => row.missingVars !== null)).toEqual([]);
    expect(log.every((row) => row.status === "sent")).toBe(true);
    expect(log.some((row) => /\{\{|\}\}/.test(row.body + (row.subject ?? "")))).toBe(false);
    const tags = log.filter((row) => row.templateKey === "visit_staff_notice").map((row) => row.subject?.split(":")[0]);
    // BO-05: a request that lapses unanswered is a notice to the office too.
    expect(tags.sort()).toEqual(["New booking", "New request", "New request", "New request", "Request expired", "Visit cancelled", "Visit moved"]);
    // The reminder template renders whole too (its queued vars).
    const queued = (await queueRows(tenantId)).find((row) => row.templateKey === "visit_reminder");
    expect(queued).toBeDefined();
    const template = await getTemplate(t.db, tenantId, "visit_reminder");
    const { missingVariables } = await import("@adminigloo/comms");
    expect(missingVariables([template!.subject, template!.body], queued!.vars)).toEqual([]);
  });

  it("the wording follows who acted", async () => {
    const { tenantId, mail, write, request } = await setUp();
    const staff = { ...write, now: clock, actor: { type: "staff" as const, id: null } };
    const a = await request("2026-11-02", "09:00");
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, staff);
    await rescheduleBooking(t.db, tenantId, { id: a.id, date: "2026-11-02", startTime: "13:00" }, staff);
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "cancelled", reason: "Crew sick" }, staff);
    const bodies = mail.sent.filter((m) => m.to === "pat@example.com").map((m) => [m.subject, m.body]);
    expect(bodies[0]?.[0]).toBe("We got your request: Free estimate, Mon, Nov 2, 9:00 AM MST");
    expect(bodies[0]?.[1]).toContain("Thanks, your Free estimate request is in.");
    expect(bodies[0]?.[1]).toMatch(/Requested time: Monday, November 2, 2026, 9:00\s.\s10:00\sAM MST/);
    expect(bodies[0]?.[1]).toContain("Questions? Call (801) 555-0143.");
    expect(bodies[0]?.[1]).toContain("(up to 24 hours before the visit):\nhttps://acme.test/visit/:token".replace(":token", "")); // the link follows
    expect(bodies[1]?.[1]).toContain("Good news: we've confirmed your Free estimate.");
    expect(bodies[2]?.[0]).toBe("New time: Free estimate, Mon, Nov 2, 1:00 PM MST");
    expect(bodies[2]?.[1]).toContain("We had to move your Free estimate. Sorry for the change.");
    expect(bodies[2]?.[1]).toMatch(/Was: Monday, November 2, 2026, 9:00\s.\s10:00\sAM MST/);
    expect(bodies[3]?.[1]).toContain("We had to cancel your Free estimate on Monday, November 2, 2026");
    expect(bodies[3]?.[1]).toContain('Note from us: "Crew sick"');
    expect(bodies[3]?.[1]).toContain("If you'd like another time, pick one here: https://acme.test/book");
    const notice = mail.sent.find((m) => m.to === "office@acme.test")!;
    expect(notice.subject).toBe("New request: Pat Visitor, Mon, Nov 2, 9:00 AM MST");
    expect(notice.body).toContain("New request from Pat Visitor: Free estimate. Accept or decline it in your schedule. If nobody answers by Sat, Oct 31, 9:00 AM MDT, the request is released and they're told.");
    expect(notice.body).toContain("Crew: Crew A");
    expect(notice.body).toContain("Phone: —");
    expect(notice.body).toContain("Your schedule: https://acme.test/admin/schedule");
  });

  it("an auto-confirmed request gets only the confirmation, and the office a New booking", async () => {
    const { mail, request } = await setUp({ autoConfirm: true });
    await request("2026-11-02", "09:00");
    expect(mail.sent.map((m) => [m.to, m.subject.split(":")[0]])).toEqual([
      ["office@acme.test", "New booking"],
      ["pat@example.com", "Confirmed"],
    ]);
    expect(mail.sent[1]?.body).toContain("You're booked. Your Free estimate is on our schedule.");
  });

  it("notify: false and a visit with no email send the customer nothing", async () => {
    const { tenantId, crew, mail, write } = await setUp();
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", customerEmail: "q@example.com" }, { ...write, now: clock, notify: false });
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "13:00", endTime: "14:00" }, { ...write, now: clock });
    expect(mail.sent).toEqual([]);
  });
});

describe("no token stays in the delivery log", () => {
  it("the customer got a working link; the log holds :token", async () => {
    const { tenantId, mail, request } = await setUp();
    await request("2026-11-02", "09:00");
    const link = TOKEN_IN_LINK.exec(mail.sent.find((m) => m.to === "pat@example.com")!.body);
    expect(link).not.toBeNull();
    const token = link![1]!;
    expect(await getVisitByToken(t.db, tenantId, token, { now: clock })).toMatchObject({ status: "requested" });
    const log = await logRows(tenantId);
    expect(log.some((row) => row.body.includes(token) || (row.subject ?? "").includes(token))).toBe(false);
    expect(log.find((row) => row.templateKey === "visit_requested")?.body).toContain("https://acme.test/visit/:token");
  });
});

describe("the reminder", () => {
  it("is queued startsAt − lead across the fall-back (an hour before a cutoff of the same length), with its key, ref and expiry, and no link", async () => {
    const { tenantId, write, request } = await setUp();
    const a = await request("2026-11-02", "09:00"); // Mon 09:00 MST = 16:00Z
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, { ...write, now: clock });
    const [row] = (await queueRows(tenantId)).filter((r) => r.templateKey === "visit_reminder");
    expect(row).toMatchObject({
      status: "pending",
      toAddress: "pat@example.com",
      refType: SCHEDULING_COMMS_REF_TYPE,
      refId: a.id,
      dedupeKey: `visit:${a.id}:reminder:0`,
    });
    // Sun 2026-11-01 16:00Z is 24 real hours before Mon 16:00Z (Sun 09:00
    // MST) — and also the 24-hour change cutoff, so the reminder goes an hour
    // earlier, while its link still works (F5).
    expect(row!.sendAt.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(row!.expiresAt?.toISOString()).toBe("2026-11-02T15:30:00.000Z");
    expect(row!.vars).toMatchObject({ manageUrl: "", manageLine: "Need to change it? Use the link in your confirmation email." });
    expect(JSON.stringify(row!.vars)).not.toMatch(/acme\.test\/visit\//);
  });

  it("isn't queued when it would land within the hour, when reminders are off, or with a lead of 0", async () => {
    const soon = await setUp();
    const a = await soon.request("2026-10-30", "10:00"); // Fri 10:00 MDT = 16:00Z; reminder at Thu 16:00Z, an hour from now
    await setBookingStatus(t.db, soon.tenantId, { id: a.id, status: "confirmed" }, { ...soon.write, now: clock });
    expect(await queueRows(soon.tenantId)).toEqual([]);

    const off = await setUp({}, { reminders: false });
    const b = await off.request("2026-11-02", "09:00");
    await setBookingStatus(t.db, off.tenantId, { id: b.id, status: "confirmed" }, { ...off.write, now: clock });
    expect(await queueRows(off.tenantId)).toEqual([]);

    const zero = await setUp({ reminderLeadHours: 0 });
    const c = await zero.request("2026-11-02", "09:00");
    await setBookingStatus(t.db, zero.tenantId, { id: c.id, status: "confirmed" }, { ...zero.write, now: clock });
    expect(await queueRows(zero.tenantId)).toEqual([]);
  });

  it("is withdrawn on a move (and re-queued at the new version), kept on a crew change, withdrawn on cancel", async () => {
    const { tenantId, write, request } = await setUp();
    const other = await createResource(t.db, { tenantId, name: "Crew B" });
    const staff = { ...write, now: clock };
    const a = await request("2026-11-02", "09:00");
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, staff);
    await rescheduleBooking(t.db, tenantId, { id: a.id, date: "2026-11-03", startTime: "10:00" }, staff);
    let rows = await queueRows(tenantId);
    expect(rows.map((r) => [r.dedupeKey, r.status, r.sendAt.toISOString()])).toEqual([
      [`visit:${a.id}:reminder:0`, "cancelled", "2026-11-01T15:00:00.000Z"],
      [`visit:${a.id}:reminder:1`, "pending", "2026-11-02T16:00:00.000Z"],
    ]);
    await assignBooking(t.db, tenantId, { id: a.id, resourceId: other.id }, staff);
    rows = await queueRows(tenantId);
    expect(rows.filter((r) => r.status === "pending").map((r) => r.dedupeKey)).toEqual([`visit:${a.id}:reminder:1`]);
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "cancelled" }, staff);
    expect((await queueRows(tenantId)).filter((r) => r.status === "pending")).toEqual([]);
  });

  it("is withdrawn on a decline and on expiry", async () => {
    const { tenantId, write, request } = await setUp({ pendingExpiryHours: 24 });
    const queueFor = (visitId: string) =>
      enqueueMessage(t.db, {
        tenantId,
        to: "pat@example.com",
        templateKey: "visit_reminder",
        sendAt: new Date("2026-11-08T16:00:00Z"),
        refType: SCHEDULING_COMMS_REF_TYPE,
        refId: visitId,
      });
    const a = await request("2026-11-09", "09:00");
    const b = await request("2026-11-09", "13:00", "b@example.com");
    await queueFor(a.id);
    await queueFor(b.id);
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "declined" }, { ...write, now: clock });
    await expirePendingRequests(t.db, tenantId, { now: new Date(clock.getTime() + 25 * 3_600_000), ...write });
    expect((await queueRows(tenantId)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("beforeSend: not ours → null; gone, cancelled, moved, too close → skip; fine → a working link, which redactSent scrubs", async () => {
    const { tenantId, mail, listener, write, request } = await setUp();
    const a = await request("2026-11-02", "09:00");
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, { ...write, now: clock });
    const [row] = await queueRows(tenantId);
    expect(await listener.beforeSend({ ...row!, refType: "invoice" })).toBeNull();
    expect(await listener.beforeSend({ ...row!, refId: "no-such-visit" })).toEqual({ skip: true, reason: "the visit no longer exists" });
    expect(await listener.beforeSend({ ...row!, dedupeKey: `visit:${a.id}:reminder:7` })).toEqual({
      skip: true,
      reason: "the visit has moved since this reminder was queued",
    });
    setClock(new Date("2026-11-02T15:45:00Z"));
    expect(await listener.beforeSend(row!)).toEqual({ skip: true, reason: "the visit starts in under 30 minutes" });

    // The cron, a minute after the reminder is due. (`runDueMessages` drains
    // every tenant's queue, and this file shares one database: park the other
    // tests' reminders so the counts below are this visit's.)
    await t.client.query(`update comms_scheduled set status = 'cancelled' where tenant_id <> $1 and status = 'pending'`, [tenantId]);
    setClock(new Date("2026-11-01T15:01:00Z"));
    mail.sent.length = 0;
    const result = await runDueMessages(t.db, mail.senders, { now: clock, beforeSend: async (r) => (await listener.beforeSend(r)) ?? "send" });
    expect(result).toMatchObject({ sent: 1 });
    const reminder = mail.sent[0]!;
    expect(reminder.subject).toBe("Reminder: Free estimate, Mon, Nov 2, 9:00 AM MST");
    const token = TOKEN_IN_LINK.exec(reminder.body)![1]!;
    expect(await getVisitByToken(t.db, tenantId, token, { now: clock })).toMatchObject({ status: "confirmed" });
    const before = await logRows(tenantId);
    expect(before.some((r) => r.body.includes(token))).toBe(true); // until redactSent runs
    expect(await listener.redactSent()).toBe(1);
    expect((await logRows(tenantId)).some((r) => r.body.includes(token))).toBe(false);
    expect(await listener.redactSent()).toBe(0);

    await setBookingStatus(t.db, tenantId, { id: a.id, status: "cancelled" }, { now: clock });
    expect(await listener.beforeSend(row!)).toEqual({ skip: true, reason: "the visit is cancelled" });
  });
});

describe("staff notices", () => {
  it("go to the settings' addresses, else to staffEmails; never for a change staff made", async () => {
    const withList = await setUp();
    await withList.request("2026-11-02", "09:00");
    expect(withList.mail.sent.filter((m) => m.subject.startsWith("New request")).map((m) => m.to)).toEqual(["office@acme.test"]);

    const fallback = await setUp({ staffNotifyEmails: [] }, { staffEmails: ["owner@acme.test", "desk@acme.test"] });
    await fallback.request("2026-11-02", "09:00");
    expect(fallback.mail.sent.filter((m) => m.subject.startsWith("New request")).map((m) => m.to)).toEqual([
      "owner@acme.test",
      "desk@acme.test",
    ]);
    // Staff booking a pending visit themselves: no notice to themselves.
    fallback.mail.sent.length = 0;
    await bookVisit(
      t.db,
      { tenantId: fallback.tenantId, resourceId: fallback.crew.id, scheduledDate: "2026-11-03", startTime: "09:00", endTime: "10:00", status: "pending", customerEmail: "z@example.com" },
      { ...fallback.write, now: clock },
    );
    expect(fallback.mail.sent.map((m) => m.to)).toEqual(["z@example.com"]);
  });
});

describe("templates and failures", () => {
  it("ensureTemplates inserts the nine once and never overwrites an owner's edit", async () => {
    const { tenantId, listener } = await setUp();
    expect(await listener.ensureTemplates(tenantId)).toBe(9);
    await upsertTemplate(t.db, { tenantId, key: "visit_confirmed", subject: "You're on!", body: "See you {{when}}." });
    expect(await listener.ensureTemplates(tenantId)).toBe(0);
    expect(await getTemplate(t.db, tenantId, "visit_confirmed")).toMatchObject({ subject: "You're on!", body: "See you {{when}}." });
  });

  it("a mail server that's down never fails the visit or stops the reminder; the listener never rejects", async () => {
    const { tenantId, mail, write, request } = await setUp();
    mail.fail(true);
    const a = await request("2026-11-02", "09:00");
    await setBookingStatus(t.db, tenantId, { id: a.id, status: "confirmed" }, { ...write, now: clock });
    expect((await logRows(tenantId)).filter((r) => r.templateKey === "visit_confirmed").map((r) => r.status)).toEqual(["failed"]);
    expect((await queueRows(tenantId)).map((r) => r.status)).toEqual(["pending"]);

    const errors: Array<{ step: string }> = [];
    const broken = createSchedulingCommsListener({
      db: { select() { throw new Error("db down"); } } as never,
      senders: mail.senders,
      manageUrl: (token) => token,
      onError: (_error, context) => errors.push(context),
    });
    const event = { id: "e", type: "visit.confirmed", tenantId, visitId: a.id, occurredAt: clock.toISOString(), actor: { type: "staff", id: null }, data: { visit: {} as never, notify: true } } as SchedulingEvent;
    await expect(broken.onEvent(event)).resolves.toBeUndefined();
    expect(errors).toEqual([{ visitId: a.id, eventId: "e", step: "settings" }]);
  });

  it("schedulingEmailVars: staff unknowns are '—', customer unknowns empty; the link-free manage line", async () => {
    const { tenantId } = await setUp({ contactPhone: null, contactEmail: "hi@acme.test" });
    const settings = await getSchedulingSettings(t.db, tenantId);
    const event: SchedulingEvent = {
      id: "e1",
      type: "visit.confirmed",
      tenantId,
      visitId: "v1",
      occurredAt: clock.toISOString(),
      actor: { type: "staff", id: null },
      data: {
        notify: true,
        via: "staff",
        visit: {
          id: "v1", status: "confirmed", nextStatuses: [], date: "2026-11-02", startTime: "09:00", endTime: "10:00",
          startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z", timeZone: "America/Denver",
          durationMinutes: 60, resourceId: null, resourceName: null, serviceKey: "estimate", serviceName: "Free estimate",
          title: null, customerName: null, customerEmail: null, customerPhone: null, address: null, lat: null, lng: null,
          notes: null, estimateId: null, origin: "staff", sequence: 0, pendingExpiresAt: null, cancelledAt: null,
          cancelledBy: null, cancelReason: null, startedAt: null, completedAt: null, createdAt: clock.toISOString(), updatedAt: clock.toISOString(),
        },
      },
    };
    const customer = schedulingEmailVars(event, settings, { manageUrl: null });
    expect(customer).toMatchObject({
      firstName: "there",
      address: "",
      crewName: "our team",
      contactLine: "Questions? Email hi@acme.test.",
      manageLine: "Need to change it? Use the link in your confirmation email.",
      confirmLine: "We've booked your Free estimate.",
      bookLine: "",
      shortWhen: "Mon, Nov 2, 9:00 AM MST",
    });
    const office = schedulingEmailVars(event, settings, { manageUrl: null, audience: "staff" });
    expect(office).toMatchObject({ customerName: "—", address: "—", customerPhone: "—", notes: "—", adminUrl: "—" });
    const zeroCutoff = schedulingEmailVars(event, { ...settings, cancelCutoffHours: 0 }, { manageUrl: "https://acme.test/visit/x" });
    expect(zeroCutoff.manageLine).toBe("Need to change it? Reschedule or cancel here, no account needed (up to the start of the visit):\nhttps://acme.test/visit/x");
  });
});
