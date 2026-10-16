import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotifications } from "../instance.js";
import { defineAlertRegistry } from "../registry.js";
import { AlertsInputError } from "../types.js";
import { commsKinds, Directory, draft, estimatorKinds, greenAcres, readerOf, rowsFor, schedulingKinds, tenancyKinds, world } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Reads (Tenancy 2b-1, 4.5 Reads; D2, review G4): the company AND the person
 * in every WHERE, and only what the reader may get NOW, so the badge and the
 * list never disagree and a demotion hides the old rows at once.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

describe("the company and the person", () => {
  it("B's id, or another member's alert id, marks nothing (not_found); a second mark is `already`", async () => {
    const directory = new Directory();
    const w = world(t, {}, directory);
    const a = tenant("a");
    const b = tenant("b");
    const p = greenAcres(directory, a);
    const q = greenAcres(directory, b);
    await w.alerts.notify([draft(a, "tenancy.member.joined"), draft(b, "tenancy.member.joined")]);
    const [ownerA] = await rowsFor(t, a, p.owner.userId);
    const [adminA] = await rowsFor(t, a, p.admin.userId);
    // B's owner, with A's alert id, in B; and in A (where they aren't the recipient).
    expect(await w.alerts.markRead({ ...readerOf(directory, b, q.owner.userId), alertId: ownerA!.id })).toBe("not_found");
    expect(await w.alerts.markRead({ tenantId: a, userId: q.owner.userId, permissions: directory.permissionsOf(b, q.owner.userId), alertId: ownerA!.id })).toBe(
      "not_found",
    );
    // A's admin with A's owner's alert id.
    expect(await w.alerts.markRead({ ...readerOf(directory, a, p.admin.userId), alertId: ownerA!.id })).toBe("not_found");
    expect((await rowsFor(t, a, p.owner.userId))[0]?.readAt).toBeNull();
    // The owner, twice (two tabs).
    expect(await w.alerts.markRead({ ...readerOf(directory, a, p.owner.userId), alertId: ownerA!.id })).toBe("marked");
    expect(await w.alerts.markRead({ ...readerOf(directory, a, p.owner.userId), alertId: ownerA!.id })).toBe("already");
    expect((await rowsFor(t, a, p.admin.userId))[0]?.readAt).toBeNull();
    expect(adminA).toBeDefined();
  });

  it("every read statement names the company and the person", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "tenancy.member.joined"));
    const reader = readerOf(w.directory, a, p.owner.userId);
    t.queries.length = 0;
    await w.alerts.list(reader);
    await w.alerts.unreadCount(reader);
    await w.alerts.markAllRead(reader);
    await w.alerts.markRead({ ...reader, alertId: "nope" });
    const reads = t.queries.filter((q) => q.sql.includes("notifications"));
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const query of reads) {
      expect(query.sql).toMatch(/"tenant_id" = \$\d+/);
      expect(query.sql).toMatch(/"recipient_id" = \$\d+/);
      expect(query.params).toContain(a);
      expect(query.params).toContain(p.owner.userId);
    }
  });
});

describe("what the reader may get NOW", () => {
  it("a reader without the kind's permission neither sees, counts nor marks its rows", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "estimator.lead"), draft(a, "tenancy.member.joined")]);
    const full = readerOf(w.directory, a, p.owner.userId);
    expect((await w.alerts.list(full)).alerts).toHaveLength(2);
    // The same person, holding only alerts.view and members.invite now.
    const narrow = { ...full, permissions: ["alerts.view", "members.invite"] };
    const listed = await w.alerts.list(narrow);
    expect(listed.alerts.map((r) => r.kind)).toEqual(["tenancy.member.joined"]);
    expect(await w.alerts.unreadCount(narrow)).toBe(1);
    expect(await w.alerts.markAllRead(narrow)).toBe(1);
    const lead = (await rowsFor(t, a, p.owner.userId)).find((r) => r.kind === "estimator.lead")!;
    expect(lead.readAt).toBeNull();
    expect(await w.alerts.markRead({ ...narrow, alertId: lead.id })).toBe("not_found");
  });

  it("a row reached through assignment needs the assigned permission", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify(draft(a, "scheduling.visit.moved", { assignedUserIds: [p.crew.userId] }));
    const crew = readerOf(w.directory, a, p.crew.userId);
    expect(await w.alerts.unreadCount(crew)).toBe(1);
    expect(await w.alerts.unreadCount({ ...crew, permissions: ["alerts.view"] })).toBe(0);
    // schedule.view alone doesn't show an `assigned` row (it is the audience's permission).
    expect(await w.alerts.unreadCount({ ...crew, permissions: ["alerts.view", "schedule.view"] })).toBe(0);
  });

  it("the count and the list agree when a kind is no longer registered (an uninstalled feature)", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "invoicing.invoice.paid"), draft(a, "estimator.lead"), draft(a, "tenancy.member.joined")]);
    const without = createNotifications({
      db: t.db,
      tables: t.tables,
      registry: defineAlertRegistry([tenancyKinds, schedulingKinds, estimatorKinds, commsKinds]),
      people: w.directory.people,
      onError: () => {},
    });
    const reader = readerOf(w.directory, a, p.owner.userId);
    const listed = await without.list(reader);
    expect(listed.alerts.map((r) => r.kind).sort()).toEqual(["estimator.lead", "tenancy.member.joined"]);
    expect(await without.unreadCount(reader)).toBe(listed.alerts.length);
    expect(await without.markAllRead(reader)).toBe(2);
    expect((await rowsFor(t, a, p.owner.userId)).find((r) => r.kind === "invoicing.invoice.paid")?.readAt).toBeNull();
  });

  it("email-only address rows are never shown, whatever the reader holds", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.setRouting({ tenantId: a, routing: "estimates", mode: "chosen", userIds: [p.admin.userId], extraEmails: ["office@greenacres.test"], by: p.owner.userId });
    await w.alerts.notify(draft(a, "estimator.lead"));
    const spoof = { tenantId: a, userId: "email:office@greenacres.test", permissions: ["estimates.view"] };
    expect((await w.alerts.list(spoof)).alerts).toEqual([]);
    expect(await w.alerts.unreadCount(spoof)).toBe(0);
  });
});

describe("the list", () => {
  it("orders newest first and pages with a cursor", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    for (let i = 0; i < 5; i += 1) {
      w.clock.now = new Date(Date.UTC(2026, 9, 15, 15, 0, i));
      await w.alerts.notify(draft(a, "tenancy.member.joined", { title: `Joined ${i}` }));
    }
    // Two in the same millisecond: the id breaks the tie.
    await w.alerts.notify([draft(a, "tenancy.member.joined", { title: "Joined 5" }), draft(a, "tenancy.member.joined", { title: "Joined 6" })]);
    const reader = readerOf(w.directory, a, p.owner.userId);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof w.alerts.list>> = await w.alerts.list({ ...reader, limit: 2, cursor });
      seen.push(...page.alerts.map((r) => r.title));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(2)).toEqual(["Joined 4", "Joined 3", "Joined 2", "Joined 1", "Joined 0"]);
    expect(seen.slice(0, 2).sort()).toEqual(["Joined 5", "Joined 6"]);
  });

  it("unread only", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    await w.alerts.notify([draft(a, "tenancy.member.joined"), draft(a, "tenancy.member.joined")]);
    const reader = readerOf(w.directory, a, p.owner.userId);
    const [first] = (await w.alerts.list(reader)).alerts;
    await w.alerts.markRead({ ...reader, alertId: first!.id });
    expect((await w.alerts.list({ ...reader, unreadOnly: true })).alerts).toHaveLength(1);
  });

  it("caps the page at 50 and refuses a bad cursor as an input error", async () => {
    const w = world(t);
    const a = tenant("a");
    const p = greenAcres(w.directory, a);
    const reader = readerOf(w.directory, a, p.owner.userId);
    t.queries.length = 0;
    await w.alerts.list({ ...reader, limit: 500 });
    expect(t.queries.at(-1)?.params.at(-1)).toBe(51);
    for (const cursor of ["not a cursor!", "eyJjIjoxfQ", btoa("[]")]) {
      await expect(w.alerts.list({ ...reader, cursor })).rejects.toBeInstanceOf(AlertsInputError);
    }
  });
});
