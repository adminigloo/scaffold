import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Directory, draft, greenAcres, ROLE_PERMISSIONS, rowsFor, rowsOf, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Housekeeping (Tenancy 2b-1, D9): `forget` on a removal, `prune` on a role
 * change (review G4), and `cleanup` on a schedule. Every statement names the
 * company.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const DAY = 24 * 60 * 60 * 1000;

describe("forget", () => {
  it("removes the person's alerts, choices and routing places in THAT company only", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    // The same person is also a member of B.
    directory.add(b, { ...p.admin });
    greenAcres(directory, b);
    for (const tenantId of [a, b]) {
      await w.alerts.setRouting({ tenantId, routing: "estimates", mode: "chosen", userIds: [p.admin.userId], extraEmails: [], by: "x" });
      await w.alerts.setRouting({ tenantId, routing: "visits", mode: "chosen", userIds: [p.admin.userId], extraEmails: [], by: "x" });
      await w.alerts.setChoice({ tenantId, userId: p.admin.userId, kind: "estimator.lead", channel: "in_app" });
      await w.alerts.notify([draft(tenantId, "estimator.lead"), draft(tenantId, "tenancy.member.joined")]);
    }
    t.queries.length = 0;
    expect(await w.alerts.forget({ tenantId: a, userId: p.admin.userId })).toEqual({ alerts: 2, choices: 1, routings: 2 });
    for (const query of t.queries) expect(query.params, query.sql).toContain(a);
    expect(await rowsFor(t, a, p.admin.userId)).toEqual([]);
    expect((await w.alerts.choices({ tenantId: a, userId: p.admin.userId })).size).toBe(0);
    expect((await w.alerts.routing(a)).get("estimates")?.userIds).toEqual([]);
    // B is untouched.
    expect(await rowsFor(t, b, p.admin.userId)).toHaveLength(2);
    expect((await w.alerts.choices({ tenantId: b, userId: p.admin.userId })).get("estimator.lead")).toBe("in_app");
    expect((await w.alerts.routing(b)).get("estimates")?.userIds).toEqual([p.admin.userId]);
  });
});

describe("prune (review G4)", () => {
  it("with a Crew-shaped set: lead and invoice rows go, assigned visit rows stay, and they're off \"estimates\"", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.admin.userId, p.member.userId], extraEmails: [], by: p.owner.userId });
    await w.alerts.setRouting({ tenantId: a, routing: "invoices", mode: "chosen", userIds: [p.admin.userId], extraEmails: [], by: p.owner.userId });
    await w.alerts.notify([
      draft(a, "estimator.lead"),
      draft(a, "invoicing.invoice.paid"),
      draft(a, "scheduling.visit.moved", { assignedUserIds: [p.admin.userId] }),
      draft(a, "tenancy.member.joined"),
    ]);
    // "visits" is on The owner, so Ada's visit row came through assignment.
    expect((await rowsFor(t, a, p.admin.userId)).map((r) => [r.kind, r.reachedVia]).sort()).toEqual(
      [
        ["estimator.lead", "audience"],
        ["invoicing.invoice.paid", "audience"],
        ["scheduling.visit.moved", "assigned"],
        ["tenancy.member.joined", "audience"],
      ].sort(),
    );
    // Ada is changed to Crew.
    w.directory.member(a, p.admin.userId)!.role = "crew";
    t.queries.length = 0;
    const result = await w.alerts.prune({ tenantId: a, userId: p.admin.userId, permissions: [...ROLE_PERMISSIONS.crew] });
    expect(result).toEqual({ alerts: 3, routings: 2 });
    for (const query of t.queries) expect(query.params, query.sql).toContain(a);
    expect((await rowsFor(t, a, p.admin.userId)).map((r) => r.kind)).toEqual(["scheduling.visit.moved"]);
    const routing = await w.alerts.routing(a);
    expect(routing.get("estimates")?.userIds).toEqual([p.member.userId]);
    expect(routing.get("invoices")?.userIds).toEqual([]);
    // Nobody else lost anything.
    expect(await rowsFor(t, a, p.owner.userId)).not.toEqual([]);
  });

  it("keeps everything the new set still allows", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "estimator.lead"), draft(a, "tenancy.member.joined")]);
    expect(await w.alerts.prune({ tenantId: a, userId: p.owner.userId, permissions: [...ROLE_PERMISSIONS.owner] })).toEqual({ alerts: 0, routings: 0 });
    expect(await rowsFor(t, a, p.owner.userId)).toHaveLength(2);
  });

  it("never throws", async () => {
    const w = world(t);
    expect(await w.alerts.prune({ tenantId: 5 as never, userId: null as never, permissions: null as never })).toEqual({ alerts: 0, routings: 0 });
  });
});

describe("cleanup", () => {
  it("deletes read alerts older than 30 days and any alert older than 180, and nothing newer", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const start = w.clock.now;
    const at = (days: number) => new Date(start.getTime() - days * DAY);
    const reader = { tenantId: a, userId: p.owner.userId, permissions: [...ROLE_PERMISSIONS.owner] };
    const make = async (title: string, days: number, readDaysAgo: number | null) => {
      w.clock.now = at(days);
      await w.alerts.notify(draft(a, "tenancy.member.joined", { title }));
      if (readDaysAgo !== null) {
        w.clock.now = at(readDaysAgo);
        const row = (await rowsFor(t, a, p.owner.userId)).find((r) => r.title === title)!;
        await w.alerts.markRead({ ...reader, alertId: row.id });
      }
    };
    await make("old read", 40, 31);
    await make("recently read", 40, 2);
    await make("ancient unread", 200, null);
    await make("new unread", 1, null);
    w.clock.now = start;
    const result = await w.alerts.cleanup();
    expect(result.stoppedEarly).toBe(false);
    expect((await rowsFor(t, a, p.owner.userId)).map((r) => r.title).sort()).toEqual(["new unread", "recently read"]);
    expect(result.deleted).toBeGreaterThanOrEqual(2);
  });

  it("works in batches and within its budget", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    w.clock.now = new Date(w.clock.now.getTime() - 400 * DAY);
    await w.alerts.notify(Array.from({ length: 5 }, () => draft(a, "tenancy.member.joined")));
    w.clock.now = new Date(w.clock.now.getTime() + 400 * DAY);
    expect(await w.alerts.cleanup({ timeBudgetMs: 0 })).toEqual({ deleted: 0, stoppedEarly: true });
    t.queries.length = 0;
    const result = await w.alerts.cleanup({ limit: 3 });
    expect(result.deleted).toBeGreaterThanOrEqual(10);
    expect(await rowsOf(t, a)).toEqual([]);
    const deletes = t.queries.filter((q) => /^delete/i.test(q.sql));
    expect(deletes.length).toBeGreaterThanOrEqual(4);
    // The two package-only columns are named on purpose (D14).
    for (const query of deletes) {
      expect(query.sql).toContain(`"dedupe_key" is not null`);
      expect(query.sql).toContain(`"email_status" is not null`);
    }
  });
});
