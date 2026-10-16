import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Directory, draft, greenAcres, rowsFor, rowsOf, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Who gets an alert (Tenancy 2b-1, 4.4; D4), on a real Postgres: the
 * permission, the routing group (the owner by default), chosen people, extra
 * addresses, the never-nobody fallbacks, the business email, crew through
 * assignment, never the actor, nobody in a suspended company, and no email
 * copy for a kind switched off in Messages.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const recipients = async (tenantId: string) => (await rowsOf(t, tenantId)).map((row) => row.recipientId).sort();

describe("the audience", () => {
  it("only members holding the kind's permission get an unrouted kind", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "tenancy.member.joined"));
    expect(await recipients(a)).toEqual([p.admin.userId, p.owner.userId].sort());
  });

  it("a routed kind goes to the owner by default (nothing saved)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "estimator.lead"));
    expect(await recipients(a)).toEqual([p.owner.userId]);
  });

  it("a chosen list replaces the owner", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.member.userId, p.admin.userId], extraEmails: [], by: p.owner.userId });
    await w.alerts.notify(draft(a, "estimator.lead"));
    expect(await recipients(a)).toEqual([p.admin.userId, p.member.userId].sort());
  });

  it("extra addresses get a born-read row each, deduplicated against the people's own addresses", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({
      tenantId: a,
      routing: "estimates",
      mode: "chosen",
      userIds: [p.member.userId],
      extraEmails: ["office@greenacres.test", p.member.email!.toUpperCase(), "OFFICE@greenacres.test"],
      by: p.owner.userId,
    });
    const report = await w.alerts.notify(draft(a, "estimator.lead"));
    expect(report.alerted).toBe(1); // extra addresses aren't counted
    expect(await recipients(a)).toEqual(["email:office@greenacres.test", p.member.userId].sort());
    const [address] = await rowsFor(t, a, "email:office@greenacres.test");
    expect(address).toMatchObject({ reachedVia: "address", emailTo: "office@greenacres.test", emailStatus: "owed" });
    expect(address!.readAt).not.toBeNull();
  });

  it("the business email counts as the owner's address when deduplicating (review BO-01)", async () => {
    const w = world(t, { ownerEmail: () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    // Everyone on the list left: the owner fallback, at the business email.
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.member.userId], extraEmails: ["Office@GreenAcres.test"], by: p.owner.userId });
    w.directory.remove(a, p.member.userId);
    await w.alerts.notify(draft(a, "estimator.lead"));
    const rows = await rowsOf(t, a);
    expect(rows.map((r) => r.recipientId)).toEqual([p.owner.userId]);
    expect(rows[0]?.emailTo).toBe("office@greenacres.test");
  });

  it("a chosen list with no person left is the owner in the app, and its addresses still get the email (review BO-20)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.member.userId], extraEmails: ["office@greenacres.test"], by: p.owner.userId });
    w.directory.remove(a, p.member.userId);
    await w.alerts.notify(draft(a, "estimator.lead"));
    const rows = await rowsOf(t, a);
    const owner = rows.find((r) => r.recipientId === p.owner.userId);
    const address = rows.find((r) => r.recipientId === "email:office@greenacres.test");
    expect(owner).toMatchObject({ reachedVia: "audience", readAt: null });
    expect(address).toMatchObject({ reachedVia: "address", emailStatus: "owed", emailTo: "office@greenacres.test" });
  });

  it("with no owner among the people permitted, everyone permitted gets it, reported once (review G13)", async () => {
    const w = world(t);
    const a = tenant("a");
    const short = a.slice(-6);
    for (const [key, role] of [["ada", "admin"], ["mo", "member"]] as const) {
      w.directory.add(a, { userId: `${key}-${short}`, name: key, email: `${key}-${short}@x.test`, role });
    }
    await w.alerts.notify([draft(a, "estimator.lead")]);
    expect(await recipients(a)).toEqual([`ada-${short}`, `mo-${short}`]);
    expect(w.errors.filter((e) => e.context.step === "no-owner")).toHaveLength(1);
  });

  it("ownerEmail answering an address sends the owner's copy there; a throw uses the owner's own, reported (review BO-01)", async () => {
    const w1 = world(t, { ownerEmail: async () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w1.directory, a);
    await w1.alerts.notify(draft(a, "estimator.lead"));
    expect((await rowsFor(t, a, p.owner.userId))[0]?.emailTo).toBe("office@greenacres.test");

    const w2 = world(t, {
      ownerEmail: () => {
        throw new Error("company settings are down");
      },
    });
    const b = tenant("b");
    const q = greenAcres(w2.directory, b);
    await w2.alerts.notify(draft(b, "estimator.lead"));
    expect((await rowsFor(t, b, q.owner.userId))[0]?.emailTo).toBe(q.owner.email);
    expect(w2.errors.map((e) => e.context.step)).toContain("owner-email");
  });

  it("the business email is only for the owner's ROUTED copies on the owner fallback", async () => {
    const w = world(t, { ownerEmail: () => "office@greenacres.test" });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.owner.userId], extraEmails: [], by: p.owner.userId });
    await w.alerts.notify(draft(a, "estimator.lead"));
    expect((await rowsFor(t, a, p.owner.userId))[0]?.emailTo).toBe(p.owner.email);
  });

  it("asks emailDelivery and ownerEmail at most once per company per call", async () => {
    let delivery = 0;
    let owner = 0;
    const w = world(t, {
      emailDelivery: () => (delivery++, { available: true, offReason: null }),
      ownerEmail: () => (owner++, null),
    });
    const a = tenant("a");
    greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "estimator.lead"), draft(a, "estimator.quote.accepted"), draft(a, "invoicing.invoice.paid")]);
    expect(delivery).toBe(1);
    expect(owner).toBe(1);
  });
});

describe("crew, through assignment", () => {
  it("the people assigned to the record who hold the assigned permission get it as `assigned`, at their own page", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(
      draft(a, "scheduling.visit.moved", {
        href: "/app/schedule?visit=v1",
        assignedHref: "/app/schedule/today",
        // The member holds no schedule.route; a stranger isn't in the company.
        assignedUserIds: [p.crew.userId, p.member.userId, "stranger"],
      }),
    );
    const rows = await rowsOf(t, a);
    expect(rows.map((r) => [r.recipientId, r.reachedVia, r.href]).sort()).toEqual(
      [
        [p.crew.userId, "assigned", "/app/schedule/today"],
        [p.owner.userId, "audience", "/app/schedule?visit=v1"],
      ].sort(),
    );
  });

  it("someone step 3 already chose stays `audience`", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "scheduling.visit.moved", { assignedUserIds: [p.owner.userId] }));
    expect((await rowsOf(t, a)).map((r) => [r.recipientId, r.reachedVia])).toEqual([[p.owner.userId, "audience"]]);
  });

  it("assignedHref null leaves the crew row with nothing to open", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "scheduling.visit.moved", { href: "/app/schedule", assignedHref: null, assignedUserIds: [p.crew.userId] }));
    expect((await rowsFor(t, a, p.crew.userId))[0]?.href).toBeNull();
  });
});

describe("never", () => {
  it("the actor, about their own action", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "tenancy.member.joined", { actorUserId: p.admin.userId }));
    expect(await recipients(a)).toEqual([p.owner.userId]);
  });

  it("anyone in a suspended company (people answers [])", async () => {
    const w = world(t);
    const a = tenant("a");
    greenAcres(w.directory, a);
    w.directory.suspended.add(a);
    const report = await w.alerts.notify([draft(a, "estimator.lead"), draft(a, "tenancy.member.joined")]);
    expect(report.alerted).toBe(0);
    expect(await rowsOf(t, a)).toEqual([]);
    expect(w.mailbox.sent).toEqual([]);
  });

  it("another company's people", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    greenAcres(directory, a);
    const q = greenAcres(directory, b);
    await w.alerts.notify(draft(a, "estimator.lead"));
    for (const person of Object.values(q)) expect(await rowsFor(t, a, person.userId)).toEqual([]);
    expect(await rowsOf(t, b)).toEqual([]);
  });

  it("an email copy of a kind switched off in Messages (review BO-11)", async () => {
    const w = world(t, { emailDelivery: () => ({ available: true, offReason: null, offKinds: { "invoicing.invoice.paid": "Team alert" } }) });
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "invoicing.invoice.paid"));
    const [row] = await rowsFor(t, a, p.owner.userId);
    expect(row).toMatchObject({ emailStatus: "none", emailTo: null });
    expect(w.mailbox.sent).toEqual([]);
  });
});
