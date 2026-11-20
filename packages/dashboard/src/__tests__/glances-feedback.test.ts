import { afterEach, describe, expect, it } from "vitest";
import * as feedbackSchema from "@adminigloo/feedback/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { feedbackGlance } from "../glances/feedback.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...feedbackSchema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

type Db = Awaited<ReturnType<typeof setup>>;

async function seedStatuses(db: Db, tenantId: string) {
  await db.insert(feedbackSchema.feedbackStatuses).values([
    { tenantId, key: "open", label: "Open", isTerminal: false },
    { tenantId, key: "resolved", label: "Resolved", isTerminal: true },
  ]);
}

async function addTicket(
  db: Db,
  tenantId: string,
  input: {
    ticketNumber: string;
    title: string;
    status?: string;
    createdAt: Date;
    archivedAt?: Date | null;
    assigneeId?: string | null;
    lastStaffReadAt?: Date | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(feedbackSchema.feedbackTickets)
    .values({
      tenantId,
      ticketNumber: input.ticketNumber,
      title: input.title,
      description: "test description",
      status: input.status ?? "open",
      createdAt: input.createdAt,
      archivedAt: input.archivedAt ?? null,
      assigneeId: input.assigneeId ?? null,
      lastStaffReadAt: input.lastStaffReadAt ?? null,
    })
    .returning({ id: feedbackSchema.feedbackTickets.id });
  return row!.id;
}

async function addReporterMessage(db: Db, ticketId: string, createdAt: Date) {
  await db.insert(feedbackSchema.feedbackMessages).values({ ticketId, senderType: "reporter", senderName: "Customer", body: "Still broken", createdAt });
}

describe("feedbackGlance", () => {
  it("shows no open tickets when the board is empty", async () => {
    const db = await setup();
    const glance = await feedbackGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glance.status).toEqual({ text: "No open tickets.", tone: "good" });
    expect(glance.attention).toBe(0);
    expect(glance.tiles?.map((t) => t.value)).toEqual([0, 0, 0]);
    expect(glance.tiles).toHaveLength(3);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.spark?.points).toHaveLength(14);
    expect(glance.spark?.points.every((p) => p === 0)).toBe(true);
  });

  it("counts open, waiting and new tickets, orders the list waiting-first then newest, and links to each ticket", async () => {
    const db = await setup();
    await seedStatuses(db, "tenant-a");

    // Waiting on the team: a reporter reply with no read mark at all.
    const t1 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00001", title: "Cannot log in", createdAt: hoursAgo(1) });
    await addReporterMessage(db, t1, hoursAgo(0.5));

    // Not waiting: the team read it after the reporter's message.
    const t2 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00002", title: "Billing question", createdAt: daysAgo(2), lastStaffReadAt: daysAgo(1) });
    await addReporterMessage(db, t2, daysAgo(2));

    // Terminal (resolved): never counted as open.
    const t3 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00003", title: "Old resolved", status: "resolved", createdAt: daysAgo(10) });
    void t3;

    // Archived: never counted as open OR waiting, even with an unread reply.
    const t4 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00004", title: "Archived ticket", createdAt: daysAgo(3), archivedAt: daysAgo(1) });
    await addReporterMessage(db, t4, daysAgo(3));

    // Assigned to the viewer.
    const t5 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00005", title: "Assigned to Ada", createdAt: hoursAgo(4), assigneeId: "user-ada" });

    // Open, but older than 7 days: counts as open, not as "new this week".
    const t6 = await addTicket(db, "tenant-a", { ticketNumber: "FB-00006", title: "Older ticket", createdAt: daysAgo(8) });

    const glance = await feedbackGlance({ db, tenantId: "tenant-a", now: NOW, userId: "user-ada" });

    expect(glance.tiles?.map((t) => ({ label: t.label, value: t.value }))).toEqual([
      { label: "Open", value: 4 },
      { label: "Waiting on team", value: 1 },
      { label: "New this week", value: 4 },
      { label: "Assigned to you", value: 1 },
    ]);
    expect(glance.tiles?.every((t) => t.href === "/admin/feedback")).toBe(true);
    expect(glance.attention).toBe(1);
    expect(glance.status).toEqual({ text: "1 ticket waiting on a reply from the team.", tone: "warn" });

    expect(glance.list?.rows.map((r) => r.title)).toEqual([
      "FB-00001: Cannot log in",
      "FB-00005: Assigned to Ada",
      "FB-00002: Billing question",
      "FB-00006: Older ticket",
    ]);
    expect(glance.list?.rows[0]).toMatchObject({ badge: "Waiting", tone: "warn", href: `/admin/feedback?ticket=${t1}` });
    expect(glance.list?.rows[1]).toMatchObject({ badge: undefined, href: `/admin/feedback?ticket=${t5}` });

    expect(glance.spark?.points).toHaveLength(14);
    expect(glance.spark?.points.at(-1)).toBe(2);
    expect(glance.spark?.points.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("never counts or lists another tenant's tickets", async () => {
    const db = await setup();
    await seedStatuses(db, "tenant-a");
    await seedStatuses(db, "tenant-b");

    await addTicket(db, "tenant-a", { ticketNumber: "FB-00001", title: "Tenant A's own ticket", createdAt: hoursAgo(1) });

    const b1 = await addTicket(db, "tenant-b", { ticketNumber: "FB-00001", title: "Tenant B's ticket, waiting", createdAt: hoursAgo(1) });
    await addReporterMessage(db, b1, hoursAgo(0.5));

    const glanceA = await feedbackGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glanceA.tiles?.map((t) => t.value)).toEqual([1, 0, 1]);
    expect(glanceA.list?.rows.map((r) => r.title)).toEqual(["FB-00001: Tenant A's own ticket"]);

    const glanceB = await feedbackGlance({ db, tenantId: "tenant-b", now: NOW });
    expect(glanceB.tiles?.map((t) => t.value)).toEqual([1, 1, 1]);
    expect(glanceB.list?.rows.map((r) => r.title)).toEqual(["FB-00001: Tenant B's ticket, waiting"]);
  });
});
