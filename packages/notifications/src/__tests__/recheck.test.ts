import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_LONGER_SENTENCE } from "../email.js";
import { draft, greenAcres, rowsFor, world, type World } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Checked again before every retry (Tenancy 2b-1, D9; review G3). A copy
 * waiting for the cron goes only to someone who still qualifies NOW, at the
 * address they would get it at now. A member removed while their copy waited
 * (the `forget` listener cut off, or a removal racing the write) never gets
 * an email with a customer's details; nor does a demoted member or a dropped
 * office address.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const MINUTE = 60_000;

/** `kind` alerted with the first send failing (retryable), then the clock moved past the backoff. */
async function waiting(w: World, tenantId: string, kind: string, extra: Parameters<typeof draft>[2] = {}) {
  w.mailbox.answer = () => ({ status: "failed", error: "provider busy", retryable: true });
  await w.alerts.notify(draft(tenantId, kind, extra));
  w.mailbox.answer = () => ({ status: "sent" });
  w.mailbox.sent.length = 0;
  w.clock.now = new Date(w.clock.now.getTime() + 5 * MINUTE);
}

describe("before a retry", () => {
  it("(a) a member removed without `forget` gets nothing, and the row ends skipped", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await waiting(w, a, "invoicing.invoice.paid");
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "pending" });
    // Removed from the company; the alerts listener that would `forget` them never ran.
    w.directory.remove(a, p.owner.userId);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ skipped: 1, sent: 0 });
    expect(w.mailbox.sent).toEqual([]);
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "skipped", emailError: NO_LONGER_SENTENCE });
  });

  it("(b) a member whose role no longer holds the kind's permission gets nothing", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.member.userId], extraEmails: [], by: p.owner.userId });
    await waiting(w, a, "invoicing.invoice.paid");
    // Demoted to Crew: no invoices.view any more.
    w.directory.member(a, p.member.userId)!.role = "crew";
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ skipped: 1, sent: 0 });
    expect(w.mailbox.sent).toEqual([]);
  });

  it("(c) an extra address taken off its group gets nothing", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.admin.userId], extraEmails: ["books@greenacres.test"], by: p.owner.userId });
    await waiting(w, a, "invoicing.invoice.paid");
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.admin.userId], extraEmails: [], by: p.owner.userId });
    const result = await w.alerts.deliverPendingEmails({ tenantIds: [a] });
    expect(result).toMatchObject({ skipped: 1, sent: 1 });
    expect(w.mailbox.to("books@greenacres.test")).toEqual([]);
    expect(w.mailbox.to(p.admin.email!)).toHaveLength(1);
    expect((await rowsFor(t, a, "email:books@greenacres.test"))[0]).toMatchObject({ emailStatus: "skipped" });
  });

  it("(c') …and so does one whose group went back to The owner", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.admin.userId], extraEmails: ["books@greenacres.test"], by: p.owner.userId });
    await waiting(w, a, "invoicing.invoice.paid");
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "owner", userIds: [p.admin.userId], extraEmails: ["books@greenacres.test"], by: p.owner.userId });
    await w.alerts.deliverPendingEmails({ tenantIds: [a] });
    expect(w.mailbox.to("books@greenacres.test")).toEqual([]);
  });

  it("(d) a member whose address changed gets it at the new one, and email_to follows", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await waiting(w, a, "invoicing.invoice.paid");
    w.directory.member(a, p.owner.userId)!.email = "gail.new@greenacres.test";
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1 });
    expect(w.mailbox.sent.map((m) => m.to)).toEqual(["gail.new@greenacres.test"]);
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "sent", emailTo: "gail.new@greenacres.test" });
  });

  it("the owner of a group on The owner gets it at the business email as it is NOW (review BO-01)", async () => {
    let business: string | null = null;
    const w = world(t, { ownerEmail: () => business });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await waiting(w, a, "invoicing.invoice.paid");
    expect((await rowsFor(t, a, p.owner.userId))[0]?.emailTo).toBe(p.owner.email);
    business = "office@greenacres.test";
    await w.alerts.deliverPendingEmails({ tenantIds: [a] });
    expect(w.mailbox.sent.map((m) => m.to)).toEqual(["office@greenacres.test"]);
  });

  it("a crew member reached through assignment is checked against the assigned permission", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setChoice({ tenantId: a, userId: p.owner.userId, kind: "scheduling.visit.moved", channel: "in_app" });
    await waiting(w, a, "scheduling.visit.moved", { assignedUserIds: [p.crew.userId], assignedHref: "/app/schedule/today" });
    const [crewRow] = await rowsFor(t, a, p.crew.userId);
    expect(crewRow).toMatchObject({ reachedVia: "assigned", emailStatus: "pending" });
    // Cam still holds schedule.route: sent, to the crew page.
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1 });
    expect(w.mailbox.sent).toMatchObject([{ to: p.crew.email, href: "/app/schedule/today" }]);
  });

  it("a kind switched off in Messages since is skipped", async () => {
    let off: Record<string, string> = {};
    const w = world(t, { emailDelivery: () => ({ available: true, offReason: null, offKinds: off }) });
    const a = tenant("a");
    greenAcres(w.directory, a);
    await waiting(w, a, "invoicing.invoice.paid");
    off = { "invoicing.invoice.paid": "Team alert" };
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ skipped: 1, sent: 0 });
  });

  it("people failing during the check is not a no: the row is tried again later", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await waiting(w, a, "invoicing.invoice.paid");
    w.directory.failPeople = true;
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ retrying: 1, skipped: 0 });
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "pending" });
    w.directory.failPeople = false;
    w.clock.now = new Date(w.clock.now.getTime() + 10 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1 });
  });
});
