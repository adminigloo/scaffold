import { commsMessages, commsScheduled, type ScheduledRow } from "@adminigloo/comms";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSchedulingCommsListener } from "../comms.js";
import { bookVisit, createResource, rescheduleBooking, schedulingVisitTokens, updateSchedulingSettings, type SchedulingEvent } from "../index.js";
import { recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The same event handed to the comms listener twice (a retried delivery, a
 * replayed queue): the customer hears once (Tenancy 2b-1, the known low item
 * from the 2b-1 scenario's step 1). The office side already was (D6, D7); the
 * customer's "your visit moved" went again on every delivery, with a fresh
 * link each time (so a deduplicating provider saw a different message under
 * the same key and refused it), and the replay withdrew the reminder the
 * first delivery had queued and could not queue it again.
 */

const THU = new Date("2026-10-29T15:00:00Z"); // Thu 2026-10-29 09:00 MDT
const PAT = "pat@example.com";

let t: TestDb;
let clock = THU;

beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setUp() {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = THU;
  vi.setSystemTime(THU);
  const tenantId = tenant("acme");
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    contactPhone: "(801) 555-0143",
    staffNotifyEmails: ["office@acme.test"],
    services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
  });
  const crew = await createResource(t.db, { tenantId, name: "Crew A" });
  const mail = recordingSender();
  const errors: string[] = [];
  const comms = createSchedulingCommsListener({
    db: t.db,
    senders: mail.senders,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    now: () => clock,
    onError: (_error, context) => void errors.push(context.step),
  });
  const events: SchedulingEvent[] = [];
  const onEvent = async (event: SchedulingEvent) => {
    events.push(event);
    await comms.onEvent(event);
  };
  const { visit } = await bookVisit(
    t.db,
    { tenantId, resourceId: crew.id, scheduledDate: "2026-11-02", startTime: "09:00", endTime: "10:00", serviceType: "estimate", customerName: "Pat Visitor", customerEmail: PAT },
    { now: clock, onEvent },
  );
  return { tenantId, crew, mail, comms, errors, events, visit, onEvent };
}

async function customerLog(tenantId: string, templateKey: string) {
  return t.db
    .select()
    .from(commsMessages)
    .where(and(eq(commsMessages.tenantId, tenantId), eq(commsMessages.toAddress, PAT), eq(commsMessages.templateKey, templateKey)));
}
async function tokens(tenantId: string, visitId: string) {
  return t.db.select().from(schedulingVisitTokens).where(and(eq(schedulingVisitTokens.tenantId, tenantId), eq(schedulingVisitTokens.visitId, visitId)));
}
async function reminders(tenantId: string): Promise<ScheduledRow[]> {
  return (await t.db.select().from(commsScheduled).where(and(eq(commsScheduled.tenantId, tenantId), eq(commsScheduled.templateKey, "visit_reminder")))) as ScheduledRow[];
}

describe("a replayed event tells the customer once", () => {
  it("'your visit moved' twice over: one email, one link, and the reminder for the new time still waits", async () => {
    const s = await setUp();
    await rescheduleBooking(t.db, s.tenantId, { id: s.visit.id, date: "2026-11-03", startTime: "10:00" }, { now: clock, actor: { type: "customer", id: null }, onEvent: s.onEvent });
    const moved = s.events.find((event) => event.type === "visit.rescheduled")!;
    expect(moved).toBeDefined();
    expect((await customerLog(s.tenantId, "visit_rescheduled")).map((row) => row.status)).toEqual(["sent"]);
    const linksBefore = (await tokens(s.tenantId, s.visit.id)).length;
    const pendingBefore = (await reminders(s.tenantId)).filter((row) => row.status === "pending").map((row) => row.id);
    expect(pendingBefore).toHaveLength(1);
    const toPat = s.mail.sent.filter((m) => m.to === PAT).length;

    await s.comms.onEvent(moved); // the same event, handed over again

    expect(s.mail.sent.filter((m) => m.to === PAT)).toHaveLength(toPat);
    expect((await customerLog(s.tenantId, "visit_rescheduled")).map((row) => row.status)).toEqual(["sent"]);
    expect(await tokens(s.tenantId, s.visit.id)).toHaveLength(linksBefore);
    expect((await reminders(s.tenantId)).filter((row) => row.status === "pending").map((row) => row.id)).toEqual(pendingBefore);
    expect(s.errors).toEqual([]);
  });

  it("the confirmation twice over: one email, and its reminder still waits", async () => {
    const s = await setUp();
    const confirmed = s.events.find((event) => event.type === "visit.confirmed")!;
    expect(confirmed).toBeDefined();
    const pending = (await reminders(s.tenantId)).filter((row) => row.status === "pending").map((row) => row.id);
    expect(pending).toHaveLength(1);
    await s.comms.onEvent(confirmed);
    expect((await customerLog(s.tenantId, "visit_confirmed")).map((row) => row.status)).toEqual(["sent"]);
    expect((await reminders(s.tenantId)).filter((row) => row.status === "pending").map((row) => row.id)).toEqual(pending);
  });

  it("an email that didn't go is tried again when the event is handed over again, and then only once", async () => {
    const s = await setUp();
    s.mail.fail(true);
    await rescheduleBooking(t.db, s.tenantId, { id: s.visit.id, date: "2026-11-03", startTime: "10:00" }, { now: clock, actor: { type: "customer", id: null }, onEvent: s.onEvent });
    const moved = s.events.find((event) => event.type === "visit.rescheduled")!;
    expect((await customerLog(s.tenantId, "visit_rescheduled")).map((row) => row.status)).toEqual(["failed"]);
    s.mail.fail(false);
    await s.comms.onEvent(moved);
    await s.comms.onEvent(moved);
    expect((await customerLog(s.tenantId, "visit_rescheduled")).map((row) => row.status).sort()).toEqual(["failed", "sent"]);
    expect(s.mail.sent.filter((m) => m.to === PAT && m.subject.startsWith("New time"))).toHaveLength(1);
  });

  it("a second, different move is a new fact: the customer hears about it", async () => {
    const s = await setUp();
    await rescheduleBooking(t.db, s.tenantId, { id: s.visit.id, date: "2026-11-03", startTime: "10:00" }, { now: clock, actor: { type: "customer", id: null }, onEvent: s.onEvent });
    await rescheduleBooking(t.db, s.tenantId, { id: s.visit.id, date: "2026-11-04", startTime: "11:00" }, { now: clock, actor: { type: "customer", id: null }, onEvent: s.onEvent });
    expect((await customerLog(s.tenantId, "visit_rescheduled")).map((row) => row.status)).toEqual(["sent", "sent"]);
  });
});
