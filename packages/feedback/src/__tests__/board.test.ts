import { describe, expect, it } from "vitest";
import { DEFAULT_BOARD_STATUSES, listBoardData, moveTicket } from "../index.js";

/**
 * Same philosophy as handlers.test.ts: the narrowest fake that satisfies the
 * drizzle chains the board functions actually run, so a new query shows up
 * here as a test change.
 */
function fakeDb(state: {
  statusRows?: Array<{ id: string; key: string; label: string; color: string | null; sortOrder: number }>;
  knownKeys?: string[];
  ticketRows?: Array<Record<string, unknown>>;
  /** Latest reporter message per ticket, as the grouped query returns it. */
  replyRows?: Array<{ ticketId: string; latest: Date }>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let selectCount = 0;
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        // Status-key existence check selects only { key }.
        if (Object.keys(fields).length === 1 && "key" in fields) {
          return {
            where: () => ({
              limit: async () => {
                // moveTicket's where is on the requested key; the fake honours
                // the knownKeys list rather than parsing the condition.
                return (state.knownKeys ?? []).length > 0 ? [{ key: state.knownKeys![0] }] : [];
              },
            }),
          };
        }
        // The unread computation: latest reporter message per ticket,
        // where(senderType).groupBy(ticketId), awaited directly.
        if ("latest" in fields) {
          return {
            where: () => ({
              groupBy: () => Promise.resolve(state.replyRows ?? []),
            }),
          };
        }
        return {
          orderBy: () => {
            selectCount += 1;
            const isStatusSelect = "sortOrder" in fields;
            if (isStatusSelect) {
              // After seeding, answer with the defaults.
              const seeded = inserted.length > 0;
              const rows = seeded
                ? DEFAULT_BOARD_STATUSES.map((s, i) => ({ id: `s${i}`, ...s }))
                : (state.statusRows ?? []);
              return Object.assign(Promise.resolve(rows), { limit: async () => [] });
            }
            return { limit: async () => state.ticketRows ?? [] };
          },
        };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { then: (resolve: (v: unknown) => void) => resolve(undefined) };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push(patch);
        },
      }),
    }),
  };
  return { db: db as never, inserted, updates, getSelectCount: () => selectCount };
}

describe("listBoardData", () => {
  it("seeds the four default columns into an empty table", async () => {
    const { db, inserted } = fakeDb({ statusRows: [] });
    const board = await listBoardData(db);
    expect(inserted.map((row) => row.key)).toEqual(["open", "in_progress", "resolved", "closed"]);
    expect(board.statuses.map((s) => s.key)).toEqual(["open", "in_progress", "resolved", "closed"]);
  });

  it("does not seed when statuses already exist", async () => {
    const { db, inserted } = fakeDb({
      statusRows: [{ id: "s1", key: "triage", label: "Triage", color: null, sortOrder: 1 }],
    });
    const board = await listBoardData(db);
    expect(inserted).toHaveLength(0);
    expect(board.statuses[0]?.key).toBe("triage");
  });

  it("marks unread exactly when the reporter replied after the last staff read", async () => {
    const ticket = (id: string, lastStaffReadAt: Date | null) => ({
      id,
      ticketNumber: `FB-0000${id}`,
      title: "t",
      priority: "medium",
      category: null,
      status: "open",
      tenantId: "t1",
      assignee: null,
      reporterName: null,
      reporterEmail: null,
      pagePathname: null,
      screenshotUrl: null,
      annotatedScreenshotUrl: null,
      createdAt: new Date("2026-09-14T10:00:00Z"),
      lastStaffReadAt,
    });
    const { db } = fakeDb({
      statusRows: [{ id: "s1", key: "open", label: "Open", color: null, sortOrder: 1 }],
      ticketRows: [
        // Replied after the team last looked — the one that must light up.
        ticket("1", new Date("2026-09-14T11:00:00Z")),
        // Replied, but the team opened it afterwards.
        ticket("2", new Date("2026-09-14T13:00:00Z")),
        // Never read, never replied to: nothing to announce.
        ticket("3", null),
      ],
      replyRows: [
        { ticketId: "1", latest: new Date("2026-09-14T12:00:00Z") },
        { ticketId: "2", latest: new Date("2026-09-14T12:00:00Z") },
      ],
    });
    const board = await listBoardData(db);
    expect(
      board.tickets.map((t) => [t.id, t.hasUnreadReporterReply]),
    ).toEqual([
      ["1", true],
      ["2", false],
      ["3", false],
    ]);
    // The raw read-timestamp stays server-side; the flag is the contract.
    expect(board.tickets[0]).not.toHaveProperty("lastStaffReadAt");
  });
});

describe("moveTicket", () => {
  it("refuses an unknown status key without writing", async () => {
    const { db, updates } = fakeDb({ knownKeys: [] });
    expect(await moveTicket(db, { ticketId: "t1", statusKey: "nope" })).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("writes the new status for a known key", async () => {
    const { db, updates } = fakeDb({ knownKeys: ["resolved"] });
    expect(await moveTicket(db, { ticketId: "t1", statusKey: "resolved" })).toBe(true);
    expect(updates[0]).toEqual({ status: "resolved" });
  });
});
