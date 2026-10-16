import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotifications } from "../instance.js";
import { listNotifications, markAllRead, markNotificationRead, notify, unreadCount } from "../legacy.js";
import { notificationTables } from "../schema.js";
import { Directory, draft, greenAcres, REGISTRY } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * 0.1's suite, on 0.2, on PGlite (Tenancy 2b-1, 4.10). The six cases of 0.1's
 * fake-db test, kept, now against real SQL on the default tables, where 0.1's
 * functions write and read `tenant_id = '*'` (the firm-wide staff inbox) and
 * never a company's alerts.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb("default");
});
afterAll(async () => {
  await t.close();
});

let n = 0;
const staff = () => `staff-${++n}`;

describe("notify", () => {
  it("fans out one row per recipient at write time, deduplicated", async () => {
    const [u1, u2] = [staff(), staff()];
    const count = await notify(t.db, {
      recipientIds: [u1, u2, u1],
      kind: "feedback.ticket-created",
      title: "FB-00007: Export crashes",
      href: "/admin/feedback/board",
    });
    expect(count).toBe(2);
    const rows = [...(await listNotifications(t.db, u1)), ...(await listNotifications(t.db, u2))];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "feedback.ticket-created", title: "FB-00007: Export crashes", href: "/admin/feedback/board", body: null, readAt: null });
    const raw = (await t.client.query<{ tenant_id: string }>(`select tenant_id from notifications where recipient_id = $1`, [u1])).rows;
    expect(raw).toEqual([{ tenant_id: "*" }]);
  });

  it("refuses an empty recipient list at the schema", async () => {
    await expect(notify(t.db, { recipientIds: [], kind: "x", title: "y" })).rejects.toThrow();
  });
});

describe("reads and read-marking", () => {
  it("lists newest first through the recipient-scoped query", async () => {
    const u = staff();
    await t.client.query(
      `insert into notifications (id, tenant_id, recipient_id, kind, title, created_at) values ($1, '*', $2, 'k', 'one', '2026-01-01T00:00:00Z'), ($3, '*', $2, 'k', 'two', '2026-01-02T00:00:00Z')`,
      [`n1-${u}`, u, `n2-${u}`],
    );
    const rows = await listNotifications(t.db, u);
    expect(rows.map((r) => r.id)).toEqual([`n2-${u}`, `n1-${u}`]);
  });

  it("counts unread through the badge query", async () => {
    const u = staff();
    await notify(t.db, { recipientIds: [u], kind: "k", title: "a" });
    await notify(t.db, { recipientIds: [u], kind: "k", title: "b" });
    await notify(t.db, { recipientIds: [u], kind: "k", title: "c" });
    expect(await unreadCount(t.db, u)).toBe(3);
  });

  it("reports false when a mark-read matched nothing — somebody else's id", async () => {
    // The recipient is IN the where clause; a guessed id belonging to another
    // recipient updates zero rows, and the caller is told so.
    const [u1, u2] = [staff(), staff()];
    await notify(t.db, { recipientIds: [u1], kind: "k", title: "mine" });
    const [row] = await listNotifications(t.db, u1);
    expect(await markNotificationRead(t.db, { id: row!.id, recipientId: u2 })).toBe(false);
    expect(await markNotificationRead(t.db, { id: row!.id, recipientId: u1 })).toBe(true);
  });

  it("markAllRead reports how many rows it settled", async () => {
    const u = staff();
    await notify(t.db, { recipientIds: [u], kind: "k", title: "a" });
    await notify(t.db, { recipientIds: [u], kind: "k", title: "b" });
    expect(await markAllRead(t.db, u)).toBe(2);
    expect(await unreadCount(t.db, u)).toBe(0);
  });
});

describe("0.1's inbox and the companies' alerts never mix", () => {
  it("a company alert is not in 0.1's inbox, and 0.1's calls never mark it", async () => {
    const directory = new Directory();
    const a = tenant("a");
    const people = greenAcres(directory, a);
    const alerts = createNotifications({ db: t.db, tables: notificationTables, registry: REGISTRY, people: directory.people, onError: () => {} });
    await alerts.notify(draft(a, "tenancy.member.joined"));
    const owner = people.owner.userId;
    expect(await listNotifications(t.db, owner)).toEqual([]);
    expect(await unreadCount(t.db, owner)).toBe(0);
    expect(await markAllRead(t.db, owner)).toBe(0);
    expect(await alerts.unreadCount({ tenantId: a, userId: owner, permissions: directory.permissionsOf(a, owner) })).toBe(1);
  });
});
