import { describe, expect, it } from "vitest";
import {
  archiveTerminalTickets,
  archiveTicket,
  customerCategoryOptions,
  DEFAULT_BOARD_STATUSES,
  deleteCategory,
  listBoardData,
  moveTicket,
  moveTickets,
  unarchiveTicket,
} from "../index.js";

/**
 * Same philosophy as handlers.test.ts: the narrowest fake that satisfies the
 * drizzle chains the board functions actually run, so a new query shows up
 * here as a test change.
 */
function fakeDb(state: {
  statusRows?: Array<Record<string, unknown>>;
  knownKeys?: string[];
  ticketRows?: Array<Record<string, unknown>>;
  /** Latest reporter message per ticket, as the grouped query returns it. */
  replyRows?: Array<{ ticketId: string; latest: Date }>;
  /** Rows the awaited-where selects answer with (archivable count, occupancy checks). */
  whereRows?: Array<Record<string, unknown>>;
  /** Rows update(...).returning() answers with — what the WHERE "matched". */
  updatedRows?: Array<Record<string, unknown>>;
  /** Keys feedback_statuses holds with is_terminal = true. */
  terminalKeys?: string[];
  categoryRows?: Array<Record<string, unknown>>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const whereArgs: unknown[] = [];
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: () => {
        // Single-column selects, told apart by the one field they ask for.
        if (Object.keys(fields).length === 1 && "key" in fields) {
          return {
            // moveTicket(s)' existence check chains .limit; the terminal-keys
            // read for archiveTerminalTickets awaits the where directly.
            where: () => {
              const terminal = (state.terminalKeys ?? []).map((key) => ({ key }));
              return Object.assign(Promise.resolve(terminal), {
                limit: async () =>
                  (state.knownKeys ?? []).length > 0 ? [{ key: state.knownKeys![0] }] : [],
              });
            },
          };
        }
        if (Object.keys(fields).length === 1 && "id" in fields) {
          // The archivable count and the category-occupancy check: awaited
          // straight off the where.
          return { where: async () => state.whereRows ?? [] };
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
        // Category reads: id+key lookup (deleteCategory) or the full column
        // set ordered by sortOrder.
        if ("showToCustomer" in fields) {
          const rows = state.categoryRows ?? [];
          return {
            where: () => ({ orderBy: async () => rows }),
            orderBy: async () => rows,
          };
        }
        if (Object.keys(fields).length === 2 && "key" in fields && "id" in fields) {
          return {
            where: () => ({ limit: async () => state.categoryRows ?? [] }),
          };
        }
        const isStatusSelect = "sortOrder" in fields && "isTerminal" in fields;
        if (isStatusSelect) {
          return {
            orderBy: () => {
              // After seeding, answer with the defaults.
              const seeded = inserted.length > 0;
              const rows = seeded
                ? DEFAULT_BOARD_STATUSES.map((s, i) => ({
                    id: `s${i}`,
                    isTerminal: false,
                    wipLimit: null,
                    agingWarnHours: null,
                    agingStaleHours: null,
                    allowAiTransition: false,
                    ...s,
                  }))
                : (state.statusRows ?? []);
              return Object.assign(Promise.resolve(rows), { limit: async () => [] });
            },
          };
        }
        // The board's ticket page: where(archived predicate or undefined),
        // then orderBy, then limit.
        return {
          where: (condition: unknown) => {
            whereArgs.push(condition);
            return {
              orderBy: () => ({ limit: async () => state.ticketRows ?? [] }),
            };
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
        where: () => {
          updates.push(patch);
          const rows = state.updatedRows ?? [];
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => rows,
          });
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return { db: db as never, inserted, updates, whereArgs };
}

const STATUS_DEFAULTS = {
  color: null,
  isTerminal: false,
  wipLimit: null,
  agingWarnHours: null,
  agingStaleHours: null,
  allowAiTransition: false,
};

describe("listBoardData", () => {
  it("seeds the four default columns into an empty table", async () => {
    const { db, inserted } = fakeDb({ statusRows: [] });
    const board = await listBoardData(db);
    expect(inserted.map((row) => row.key)).toEqual(["open", "in_progress", "resolved", "closed"]);
    expect(board.statuses.map((s) => s.key)).toEqual(["open", "in_progress", "resolved", "closed"]);
    // Resolved and Closed seed terminal: they are what "Archive Done" sweeps.
    expect(inserted.filter((row) => row.isTerminal).map((row) => row.key)).toEqual([
      "resolved",
      "closed",
    ]);
  });

  it("does not seed when statuses already exist", async () => {
    const { db, inserted } = fakeDb({
      statusRows: [{ id: "s1", key: "triage", label: "Triage", sortOrder: 1, ...STATUS_DEFAULTS }],
    });
    const board = await listBoardData(db);
    expect(inserted).toHaveLength(0);
    expect(board.statuses[0]?.key).toBe("triage");
  });

  it("excludes archived tickets unless asked, and says so in the predicate", async () => {
    const make = () =>
      fakeDb({
        statusRows: [{ id: "s1", key: "open", label: "Open", sortOrder: 1, ...STATUS_DEFAULTS }],
      });
    const byDefault = make();
    await listBoardData(byDefault.db);
    // The default read carries a real WHERE; the eye-toggle read carries none.
    expect(byDefault.whereArgs[0]).toBeDefined();

    const withArchived = make();
    await listBoardData(withArchived.db, { includeArchived: true });
    expect(withArchived.whereArgs[0]).toBeUndefined();
  });

  it("counts archivable tickets from terminal columns only", async () => {
    const { db } = fakeDb({
      statusRows: [
        { id: "s1", key: "open", label: "Open", sortOrder: 1, ...STATUS_DEFAULTS },
        { id: "s2", key: "done", label: "Done", sortOrder: 2, ...STATUS_DEFAULTS, isTerminal: true },
      ],
      whereRows: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
    });
    expect((await listBoardData(db)).archivableCount).toBe(3);
  });

  it("reports zero archivable when no column is terminal, without querying", async () => {
    const { db } = fakeDb({
      statusRows: [{ id: "s1", key: "open", label: "Open", sortOrder: 1, ...STATUS_DEFAULTS }],
      whereRows: [{ id: "would-be-wrong" }],
    });
    expect((await listBoardData(db)).archivableCount).toBe(0);
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
      statusChangedAt: null,
      archivedAt: null,
      archivedBy: null,
      lastStaffReadAt,
    });
    const { db } = fakeDb({
      statusRows: [{ id: "s1", key: "open", label: "Open", sortOrder: 1, ...STATUS_DEFAULTS }],
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

  it("writes the new status and restarts the aging clock", async () => {
    const { db, updates } = fakeDb({ knownKeys: ["resolved"] });
    expect(await moveTicket(db, { ticketId: "t1", statusKey: "resolved" })).toBe(true);
    expect(updates[0]?.status).toBe("resolved");
    expect(updates[0]?.statusChangedAt).toBeInstanceOf(Date);
  });
});

describe("moveTickets", () => {
  it("refuses an unknown status key without writing", async () => {
    const { db, updates } = fakeDb({ knownKeys: [] });
    expect(await moveTickets(db, { ticketIds: ["a", "b"], statusKey: "nope" })).toEqual({
      moved: 0,
      reason: "unknown-status",
    });
    expect(updates).toHaveLength(0);
  });

  it("moves the selection in one statement and reports what changed", async () => {
    const { db, updates } = fakeDb({
      knownKeys: ["done"],
      updatedRows: [{ id: "a" }, { id: "b" }],
    });
    expect(await moveTickets(db, { ticketIds: ["a", "b", "ghost"], statusKey: "done" })).toEqual({
      moved: 2,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.statusChangedAt).toBeInstanceOf(Date);
  });

  it("refuses more ids than one board event should carry", async () => {
    const { db } = fakeDb({ knownKeys: ["done"] });
    await expect(
      moveTickets(db, { ticketIds: Array.from({ length: 201 }, (_, i) => `t${i}`), statusKey: "done" }),
    ).rejects.toThrow(/200/);
  });
});

describe("archive", () => {
  it("archives once: the second click matches no row and reports false", async () => {
    const first = fakeDb({ updatedRows: [{ id: "t1" }] });
    expect(await archiveTicket(first.db, { ticketId: "t1", archivedBy: "dallin" })).toBe(true);
    expect(first.updates[0]?.archivedBy).toBe("dallin");
    expect(first.updates[0]?.archivedAt).toBeInstanceOf(Date);

    const second = fakeDb({ updatedRows: [] });
    expect(await archiveTicket(second.db, { ticketId: "t1", archivedBy: "sam" })).toBe(false);
  });

  it("unarchive clears both columns", async () => {
    const { db, updates } = fakeDb({ updatedRows: [{ id: "t1" }] });
    expect(await unarchiveTicket(db, "t1")).toBe(true);
    expect(updates[0]).toEqual({ archivedAt: null, archivedBy: null });
  });

  it("sweeps terminal columns, and does nothing when none exist", async () => {
    const sweep = fakeDb({
      terminalKeys: ["resolved", "closed"],
      updatedRows: [{ id: "a" }, { id: "b" }],
    });
    expect(await archiveTerminalTickets(sweep.db, { archivedBy: "dallin" })).toEqual({
      archived: 2,
    });

    const none = fakeDb({ terminalKeys: [] });
    expect(await archiveTerminalTickets(none.db, { archivedBy: "dallin" })).toEqual({
      archived: 0,
    });
    expect(none.updates).toHaveLength(0);
  });
});

describe("categories", () => {
  it("maps rows to widget options, dropping null descriptions", async () => {
    const { db } = fakeDb({
      categoryRows: [
        { id: "c1", key: "bug", label: "Bug", description: "Broken", sortOrder: 10, showToCustomer: true },
        { id: "c2", key: "other", label: "Other", description: null, sortOrder: 20, showToCustomer: true },
      ],
    });
    expect(await customerCategoryOptions(db)).toEqual([
      { key: "bug", label: "Bug", description: "Broken" },
      { key: "other", label: "Other" },
    ]);
  });

  it("refuses to delete a category tickets still carry, and says how many", async () => {
    const { db } = fakeDb({
      categoryRows: [{ id: "c1", key: "bug" }],
      whereRows: [{ id: "t1" }, { id: "t2" }],
    });
    expect(await deleteCategory(db, "c1")).toEqual({
      deleted: false,
      reason: "occupied",
      ticketCount: 2,
    });
  });

  it("reports an unknown id as unknown, not as deleted", async () => {
    const { db } = fakeDb({ categoryRows: [] });
    expect(await deleteCategory(db, "nope")).toEqual({ deleted: false, reason: "unknown" });
  });
});
