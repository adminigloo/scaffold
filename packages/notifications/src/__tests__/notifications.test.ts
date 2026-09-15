import { describe, expect, it } from "vitest";
import {
  listNotifications,
  markAllRead,
  markNotificationRead,
  notify,
  unreadCount,
} from "../index.js";

/** The narrowest fake for the chains this module runs — the house pattern. */
function fakeDb(state: { rows?: Array<Record<string, unknown>>; updatedIds?: string[] }) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        inserted.push(...rows);
        return { then: (resolve: (v: unknown) => void) => resolve(undefined) };
      },
    }),
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ("count" in fields) {
            return { then: (resolve: (v: unknown) => void) => resolve([{ count: state.rows?.length ?? 0 }]) };
          }
          return {
            orderBy: () => ({ limit: async () => state.rows ?? [] }),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => (state.updatedIds ?? []).map((id) => ({ id })),
        }),
      }),
    }),
  };
  return { db: db as never, inserted };
}

describe("notify", () => {
  it("fans out one row per recipient at write time, deduplicated", async () => {
    const { db, inserted } = fakeDb({});
    const count = await notify(db, {
      recipientIds: ["u1", "u2", "u1"],
      kind: "feedback.ticket-created",
      title: "FB-00007: Export crashes",
      href: "/admin/feedback/board",
    });
    expect(count).toBe(2);
    expect(inserted.map((r) => r.recipientId)).toEqual(["u1", "u2"]);
    expect(inserted[0]).toMatchObject({
      kind: "feedback.ticket-created",
      title: "FB-00007: Export crashes",
      href: "/admin/feedback/board",
      body: null,
    });
  });

  it("refuses an empty recipient list at the schema", async () => {
    const { db } = fakeDb({});
    await expect(
      notify(db, { recipientIds: [], kind: "x", title: "y" }),
    ).rejects.toThrow();
  });
});

describe("reads and read-marking", () => {
  it("lists newest first through the recipient-scoped chain", async () => {
    const { db } = fakeDb({ rows: [{ id: "n2" }, { id: "n1" }] });
    const rows = await listNotifications(db, "u1");
    expect(rows.map((r) => r.id)).toEqual(["n2", "n1"]);
  });

  it("counts unread through the badge query", async () => {
    const { db } = fakeDb({ rows: [{}, {}, {}] });
    expect(await unreadCount(db, "u1")).toBe(3);
  });

  it("reports false when a mark-read matched nothing — somebody else's id", async () => {
    // The recipient is IN the where clause; a guessed id belonging to another
    // recipient updates zero rows, and the caller is told so.
    const { db } = fakeDb({ updatedIds: [] });
    expect(await markNotificationRead(db, { id: "n1", recipientId: "u2" })).toBe(false);
    const { db: db2 } = fakeDb({ updatedIds: ["n1"] });
    expect(await markNotificationRead(db2, { id: "n1", recipientId: "u1" })).toBe(true);
  });

  it("markAllRead reports how many rows it settled", async () => {
    const { db } = fakeDb({ updatedIds: ["a", "b"] });
    expect(await markAllRead(db, "u1")).toBe(2);
  });
});
