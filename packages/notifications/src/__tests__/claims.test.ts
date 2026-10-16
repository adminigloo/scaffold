import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELEASED_SENTENCE } from "../email.js";
import { createNotifications } from "../instance.js";
import { defineNotificationTables } from "../schema.js";
import { AlertsUnavailableError } from "../types.js";
import { Directory, draft, greenAcres, REGISTRY, rowsFor, rowsOf, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * A producer's own office email (Tenancy 2b-1, D6; reviews BO-02, BO-03):
 * the office rows are OWED to the producer, claimed once; crew reached only
 * through assignment get notifications' own copy; a failed office email goes
 * back to the cron, once.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const MINUTE = 60_000;

describe("a producer kind", () => {
  it("writes `owed` for the office and `pending` for crew reached only through assignment, who get a team alert at their own page (BO-03)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(
      draft(a, "scheduling.visit.moved", {
        dedupeKey: "scheduling.visit.moved:v1:2",
        href: "/app/schedule?visit=v1",
        assignedHref: "/app/schedule/today",
        assignedUserIds: [p.crew.userId],
      }),
    );
    expect((await rowsFor(t, a, p.owner.userId))[0]).toMatchObject({ emailStatus: "owed", emailTo: p.owner.email });
    expect((await rowsFor(t, a, p.crew.userId))[0]).toMatchObject({ emailStatus: "sent", reachedVia: "assigned" });
    // notifications emailed the crew member only; the office's is the producer's.
    expect(w.mailbox.sent).toMatchObject([{ to: p.crew.email, href: "/app/schedule/today", kind: "scheduling.visit.moved" }]);
  });

  it("claimEmails returns the owed addresses once, and [] the second time (the same event twice)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.owner.userId, p.admin.userId], extraEmails: ["office@greenacres.test"], by: p.owner.userId });
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:e1" }));
    const first = await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e1", assignedUserIds: [] });
    expect([...first].sort()).toEqual([p.admin.email, "office@greenacres.test", p.owner.email].sort());
    expect(await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e1" })).toEqual([]);
    for (const row of await rowsOf(t, a)) expect(row.emailStatus).toBe("claimed");
    expect(w.errors).toEqual([]);
  });

  it("a person on In the app is not returned", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setChoice({ tenantId: a, userId: p.owner.userId, kind: "estimator.lead", channel: "in_app" });
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:e2" }));
    expect(await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e2" })).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it("with no rows at all, works the office out live (crew left out) and reports it", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const emails = await w.alerts.claimEmails({
      tenantId: a,
      kind: "scheduling.visit.moved",
      dedupeKey: "scheduling.visit.moved:never-written:1",
      assignedUserIds: [p.crew.userId],
    });
    expect(emails).toEqual([p.owner.email]);
    expect(w.errors.map((e) => e.context.step)).toEqual(["claim-without-alerts"]);
  });

  it("is per company: B's claim never takes A's rows", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    greenAcres(directory, a);
    const q = greenAcres(directory, b);
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:shared" }));
    const fromB = await w.alerts.claimEmails({ tenantId: b, kind: "estimator.lead", dedupeKey: "estimator.lead:shared" });
    expect(fromB).toEqual([q.owner.email]); // B's own owner, worked out live
    for (const row of await rowsOf(t, a)) expect(row.emailStatus).toBe("owed");
  });
});

describe("refusals", () => {
  it("a kind notifications sends is never claimed (it would go twice), reported", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:i1" }));
    expect(await w.alerts.claimEmails({ tenantId: a, kind: "invoicing.invoice.paid", dedupeKey: "invoicing.invoice.paid:i1" })).toEqual([]);
    expect(w.errors.map((e) => e.context.step)).toEqual(["claim"]);
    expect((await rowsOf(t, a))[0]?.emailStatus).toBe("sent");
  });

  it("a database failure throws AlertsUnavailableError after reporting (the office falls back to the business address)", async () => {
    const directory = new Directory();
    const steps: string[] = [];
    const alerts = createNotifications({
      db: t.db,
      tables: defineNotificationTables({ prefix: "missing_" }),
      registry: REGISTRY,
      people: directory.people,
      onError: (_e, context) => steps.push(context.step),
    });
    await expect(alerts.claimEmails({ tenantId: "a", kind: "estimator.lead", dedupeKey: "estimator.lead:x" })).rejects.toBeInstanceOf(AlertsUnavailableError);
    expect(steps).toEqual(["claim"]);
  });

  it("people failing in the live fallback is unavailable too", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    w.directory.failPeople = true;
    await expect(w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:none" })).rejects.toBeInstanceOf(AlertsUnavailableError);
  });
});

describe("releaseClaim (BO-02)", () => {
  it("turns one claimed row back to due, the cron sends it once as a team alert, and a second release moves nothing", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:e9", title: "Pat Rivera asked for an estimate", href: "/app/estimates/e9" }));
    await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e9" });
    // The producer's deliverNow said failed + retryable for the owner.
    expect(await w.alerts.releaseClaim({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e9", to: p.owner.email!.toUpperCase() })).toBe(1);
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "pending", emailError: RELEASED_SENTENCE });
    expect(row!.emailNextAt!.getTime()).toBe(w.clock.now.getTime() + 5 * MINUTE);
    expect(await w.alerts.releaseClaim({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e9", to: p.owner.email! })).toBe(0);

    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 0 }); // not due yet
    w.clock.now = new Date(w.clock.now.getTime() + 6 * MINUTE);
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 1 });
    expect(await w.alerts.deliverPendingEmails({ tenantIds: [a] })).toMatchObject({ sent: 0 });
    expect(w.mailbox.sent).toMatchObject([{ to: p.owner.email, kind: "estimator.lead", title: "Pat Rivera asked for an estimate", href: "/app/estimates/e9" }]);
  });

  it("a non-producer kind is never touched", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    w.mailbox.answer = () => ({ status: "failed", error: "x", retryable: false });
    await w.alerts.notify(draft(a, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:i2" }));
    expect(await w.alerts.releaseClaim({ tenantId: a, kind: "invoicing.invoice.paid", dedupeKey: "invoicing.invoice.paid:i2", to: p.owner.email! })).toBe(0);
    expect((await rowsOf(t, a))[0]?.emailStatus).toBe("failed");
  });

  it("only the company's own row moves", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    greenAcres(directory, b);
    await w.alerts.notify(draft(a, "estimator.lead", { dedupeKey: "estimator.lead:e10" }));
    await w.alerts.claimEmails({ tenantId: a, kind: "estimator.lead", dedupeKey: "estimator.lead:e10" });
    expect(await w.alerts.releaseClaim({ tenantId: b, kind: "estimator.lead", dedupeKey: "estimator.lead:e10", to: p.owner.email! })).toBe(0);
    expect((await rowsOf(t, a))[0]?.emailStatus).toBe("claimed");
  });
});
