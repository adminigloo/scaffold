import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotifications } from "../instance.js";
import { defineNotificationTables } from "../schema.js";
import { Directory, draft, greenAcres, REGISTRY, rowsFor, rowsOf, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * `notify` (Tenancy 2b-1, 4.5; D7, D18): drafts checked at the boundary, one
 * row per person per fact, email only for rows it inserted, and never a
 * throw.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("drafts (D18)", () => {
  it("refuses a title that isn't one line", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    for (const title of ["Pat\nRivera", "Pat\rRivera", `Pat${LS}Rivera`, `Pat${PS}Rivera`]) {
      const report = await w.alerts.notify(draft(a, "estimator.lead", { title }));
      expect(report.alerted, JSON.stringify(title)).toBe(0);
      expect(report.problems[0]).toMatch(/^refused draft \(title: A title is one line\.\)$/);
    }
    expect(await rowsOf(t, a)).toEqual([]);
  });

  it("refuses an href that could leave the site, keeps a path with a query", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    for (const href of ["/\\evil.com", "/\t/evil.com", "//evil.com", "/a b", "https://evil.com", "javascript:alert(1)", "app/x"]) {
      const report = await w.alerts.notify(draft(a, "estimator.lead", { href }));
      expect(report.alerted, href).toBe(0);
      expect(report.problems[0], href).toMatch(/^refused draft \(href:/);
    }
    for (const assignedHref of ["//evil.com", "/\\evil.com"]) {
      const report = await w.alerts.notify(draft(a, "scheduling.visit.moved", { assignedHref }));
      expect(report.problems[0], assignedHref).toMatch(/^refused draft \(assignedHref:/);
    }
    const kept = await w.alerts.notify(draft(a, "estimator.lead", { href: "/app/x?y=1" }));
    expect(kept.alerted).toBe(1);
    expect((await rowsOf(t, a))[0]?.href).toBe("/app/x?y=1");
  });

  it("refuses an unknown kind by name, and the rest of the call goes on", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    const report = await w.alerts.notify([draft(a, "estimator.leed"), draft(a, "estimator.lead")]);
    expect(report.problems).toEqual(["unknown alert kind estimator.leed"]);
    expect(report.alerted).toBe(1);
  });

  it("refuses a title over 200, a body over 2000 and an empty dedupe key", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    const report = await w.alerts.notify([
      draft(a, "estimator.lead", { title: "x".repeat(201) }),
      draft(a, "estimator.lead", { body: "x".repeat(2001) }),
      draft(a, "estimator.lead", { dedupeKey: "" }),
    ]);
    expect(report.problems).toHaveLength(3);
    expect(report.alerted).toBe(0);
  });

  it("stores what the draft says: title, body, subject, actor, the fact's key", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(
      draft(a, "tenancy.member.joined", {
        title: "Cam joined the team as Crew member",
        body: null,
        href: "/settings/team",
        dedupeKey: "tenancy.member.joined:evt-1",
        subject: { type: "tenancy.member", id: p.crew.userId },
        actorUserId: p.crew.userId,
      }),
    );
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({
      tenantId: a,
      kind: "tenancy.member.joined",
      title: "Cam joined the team as Crew member",
      body: null,
      href: "/settings/team",
      dedupeKey: "tenancy.member.joined:evt-1",
      subjectType: "tenancy.member",
      subjectId: p.crew.userId,
      actorId: p.crew.userId,
      reachedVia: "audience",
      readAt: null,
      emailStatus: "none", // the kind defaults to In the app
    });
  });
});

describe("dedupe (D7)", () => {
  it("the same draft twice, one after the other, is one row per person, and one email", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const once = draft(a, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:inv-1" });
    const first = await w.alerts.notify(once);
    const second = await w.alerts.notify(once);
    expect(first).toMatchObject({ alerted: 1, duplicates: 0, emailed: 1 });
    expect(second).toMatchObject({ alerted: 0, duplicates: 1, emailed: 0 });
    expect(await rowsFor(t, a, p.owner.userId)).toHaveLength(1);
    expect(w.mailbox.sent).toHaveLength(1);
  });

  it("the same draft twice in one call is one row per person", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const once = draft(a, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:inv-2" });
    const report = await w.alerts.notify([once, once]);
    expect(report).toMatchObject({ alerted: 1, duplicates: 1, emailed: 1 });
    expect(await rowsFor(t, a, p.owner.userId)).toHaveLength(1);
    expect(w.mailbox.sent).toHaveLength(1);
  });

  it("the same key in another company is another fact", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    greenAcres(directory, a);
    greenAcres(directory, b);
    const report = await w.alerts.notify([
      draft(a, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:inv-3" }),
      draft(b, "invoicing.invoice.paid", { dedupeKey: "invoicing.invoice.paid:inv-3" }),
    ]);
    expect(report).toMatchObject({ alerted: 2, duplicates: 0 });
  });

  it("is written in ONE insert for the whole call, with on conflict do nothing", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    t.queries.length = 0;
    await w.alerts.notify([draft(a, "tenancy.member.joined"), draft(a, "estimator.lead"), draft(a, "comms.message.failed")]);
    const inserts = t.queries.filter((q) => /^insert into/i.test(q.sql) && q.sql.includes("notifications"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toMatch(/on conflict \("tenant_id","recipient_id","dedupe_key"\) do nothing/);
  });
});

describe("never throws (4.5 step 5)", () => {
  it("a failed insert is a problem, reported, and the report says nothing was alerted", async () => {
    const directory = new Directory();
    const errors: string[] = [];
    const alerts = createNotifications({
      db: t.db,
      // Tables nobody created: every statement fails.
      tables: defineNotificationTables({ prefix: "missing_" }),
      registry: REGISTRY,
      people: directory.people,
      onError: (_e, context) => errors.push(context.step),
    });
    const a = tenant("a");
    greenAcres(directory, a);
    const report = await alerts.notify(draft(a, "tenancy.member.joined"));
    expect(report).toMatchObject({ alerted: 0, duplicates: 0, emailed: 0, problems: ["the alerts couldn't be written"] });
    expect(errors).toContain("write");
  });

  it("people failing alerts nobody for that draft, reported, and nothing throws", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    w.directory.failPeople = true;
    const report = await w.alerts.notify(draft(a, "estimator.lead"));
    expect(report.alerted).toBe(0);
    expect(report.problems[0]).toMatch(/people failed/);
    expect(w.errors.map((e) => e.context.step)).toContain("people");
  });

  it("a draft that isn't an object is a problem, not a crash", async () => {
    const w = world(t);
    const report = await w.alerts.notify([null as never, 42 as never]);
    expect(report.problems).toHaveLength(2);
  });
});
