import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  addTicketMessage,
  archiveTerminalTickets,
  archiveTicket,
  assignTicket,
  createCategory,
  createStatus,
  createTicket,
  customerCategoryOptions,
  DEFAULT_BOARD_STATUSES,
  DEFAULT_CATEGORIES,
  deleteCategory,
  deleteStatus,
  DuplicateKeyError,
  ensureFeedbackBoard,
  findReporterTicket,
  getTicket,
  issueClientKey,
  listBoardData,
  listCategories,
  listClientKeys,
  listColumnsWithCounts,
  listStatuses,
  listTicketMessages,
  markTicketRead,
  moveTicket,
  moveTickets,
  reorderCategories,
  reorderStatuses,
  revokeClientKey,
  submitPayloadSchema,
  unarchiveTicket,
  updateCategory,
  updateStatus,
  verifyClientKey,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * EVERY STAFF FUNCTION TAKES THE COMPANY AND ONLY TOUCHES ITS ROWS (0.10.0).
 * Company A gets one of everything; company B then calls every function with
 * A's ids and must get "not found" (or nothing) — and A's rows must be exactly
 * as they were. Then the per-company rules: the first-use board, per-company
 * numbering, per-company keys.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const payload = (text?: string) => submitPayloadSchema.parse(report(text));

async function snapshot(tenantId: string): Promise<string> {
  const rows = async (q: ReturnType<typeof sql>) => {
    const result = (await t.db.execute(q)) as unknown as { rows: unknown[] };
    return result.rows;
  };
  return JSON.stringify({
    tickets: await rows(sql`select * from feedback_tickets where tenant_id = ${tenantId} order by id`),
    statuses: await rows(sql`select * from feedback_statuses where tenant_id = ${tenantId} order by id`),
    categories: await rows(sql`select * from feedback_categories where tenant_id = ${tenantId} order by id`),
    keys: await rows(sql`select * from feedback_client_keys where tenant_id = ${tenantId} order by id`),
    messages: await rows(
      sql`select m.* from feedback_messages m join feedback_tickets t on t.id = m.ticket_id where t.tenant_id = ${tenantId} order by m.id`,
    ),
  });
}

describe("company B gets nothing of company A's, through every function", () => {
  it("answers not found (or nothing) for each of A's ids, and leaves A as it was", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const ticket = await createTicket(t.db, { tenantId: a, payload: payload() });
    await addTicketMessage(t.db, a, { ticketId: ticket.id, senderType: "staff", senderName: "Ada", body: "On it." });
    const column = await createStatus(t.db, a, { key: "waiting", label: "Waiting on customer" });
    const category = await createCategory(t.db, a, { key: "billing", label: "Billing" });
    const key = await issueClientKey(t.db, { tenantId: a, label: "Alpha website" });
    // B has a board of its own, so its answers are real, not empty by accident.
    const own = await createTicket(t.db, { tenantId: b, payload: payload("B's own report, about its own thing.") });
    const before = await snapshot(a);

    // Reads.
    expect(await getTicket(t.db, b, ticket.id)).toBeNull();
    expect(await listTicketMessages(t.db, b, ticket.id)).toEqual([]);
    const board = await listBoardData(t.db, b, { includeArchived: true });
    expect(board.tickets.map((row) => row.id)).toEqual([own.id]);
    expect(board.statuses.map((row) => row.id)).not.toContain(column.id);
    expect((await listStatuses(t.db, b)).map((row) => row.id)).not.toContain(column.id);
    expect((await listColumnsWithCounts(t.db, b)).map((row) => row.id)).not.toContain(column.id);
    expect((await listCategories(t.db, b)).map((row) => row.id)).not.toContain(category.id);
    expect((await customerCategoryOptions(t.db, b)).map((row) => row.key)).not.toContain("billing");
    expect((await listClientKeys(t.db, b)).map((row) => row.id)).not.toContain(key.id);
    expect(await findReporterTicket(t.db, b, { ticketNumber: ticket.ticketNumber, ticketToken: ticket.ticketToken })).toBeNull();

    // Writes, each by A's id.
    expect(await addTicketMessage(t.db, b, { ticketId: ticket.id, senderType: "staff", senderName: "Ben", body: "Mine now" })).toBeNull();
    expect(await assignTicket(t.db, b, { ticketId: ticket.id, assignee: "Ben", actorName: "Ben" })).toBe(false);
    expect(await markTicketRead(t.db, b, ticket.id)).toBe(false);
    expect(await moveTicket(t.db, b, { ticketId: ticket.id, statusKey: "in_progress" })).toEqual({ moved: false, reason: "not-found" });
    const many = await moveTickets(t.db, b, { ticketIds: [ticket.id], statusKey: "in_progress" });
    expect("found" in many ? many.found : []).toEqual([]);
    expect(await archiveTicket(t.db, b, { ticketId: ticket.id, archivedBy: "Ben" })).toBe(false);
    expect(await unarchiveTicket(t.db, b, ticket.id)).toBe(false);
    expect(await updateStatus(t.db, b, { id: column.id, label: "Taken" })).toBe(false);
    expect(await deleteStatus(t.db, b, column.id)).toEqual({ deleted: false, reason: "unknown" });
    await reorderStatuses(t.db, b, [column.id]);
    expect(await updateCategory(t.db, b, { id: category.id, label: "Taken" })).toBe(false);
    expect(await deleteCategory(t.db, b, category.id)).toEqual({ deleted: false, reason: "unknown" });
    await reorderCategories(t.db, b, [category.id]);
    expect(await revokeClientKey(t.db, b, key.id)).toBe(false);
    // A sweep of B's finished columns never reaches A's tickets.
    await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "resolved" });
    const afterMove = await snapshot(a);
    expect(await archiveTerminalTickets(t.db, b, { archivedBy: "Ben" })).toEqual({ archived: 0 });

    expect(await snapshot(a)).toBe(afterMove);
    expect(afterMove).not.toBe(before); // the one change A made itself
    // And A's key still names A.
    expect(await verifyClientKey(t.db, key.key)).toEqual({ keyId: key.id, tenantId: a });
  });
});

describe("a company's board on first use", () => {
  it("gets the default columns and categories, once", async () => {
    const a = tenant();
    expect(await listStatuses(t.db, a)).toEqual([]);
    const first = await ensureFeedbackBoard(t.db, a);
    expect(first).toEqual({ statuses: DEFAULT_BOARD_STATUSES.length, categories: DEFAULT_CATEGORIES.length });
    expect(await ensureFeedbackBoard(t.db, a)).toEqual({ statuses: 0, categories: 0 });
    expect((await listStatuses(t.db, a)).map((s) => s.key)).toEqual(DEFAULT_BOARD_STATUSES.map((s) => s.key));
    expect((await listCategories(t.db, a)).map((c) => c.key)).toEqual(DEFAULT_CATEGORIES.map((c) => c.key));
  });

  it("is race-safe: ten first requests at once make one set", async () => {
    const a = tenant();
    await Promise.all(Array.from({ length: 10 }, () => ensureFeedbackBoard(t.db, a)));
    expect((await listStatuses(t.db, a)).length).toBe(DEFAULT_BOARD_STATUSES.length);
    expect((await listCategories(t.db, a)).length).toBe(DEFAULT_CATEGORIES.length);
  });

  it("never brings back a column the owner deleted", async () => {
    const a = tenant();
    await ensureFeedbackBoard(t.db, a);
    const closed = (await listStatuses(t.db, a)).find((s) => s.key === "closed");
    expect(await deleteStatus(t.db, a, closed!.id)).toEqual({ deleted: true });
    await ensureFeedbackBoard(t.db, a);
    expect((await listStatuses(t.db, a)).map((s) => s.key)).not.toContain("closed");
  });

  it("is each company's own: renaming A's column leaves B's alone", async () => {
    const a = tenant();
    const b = tenant();
    await ensureFeedbackBoard(t.db, a);
    await ensureFeedbackBoard(t.db, b);
    const open = (await listStatuses(t.db, a)).find((s) => s.key === "open")!;
    expect(await updateStatus(t.db, a, { id: open.id, label: "New" })).toBe(true);
    expect((await listStatuses(t.db, b)).find((s) => s.key === "open")?.label).toBe("Open");
  });

  it("lets two companies have the same column key; inside one, a taken short name gets a number and only a taken NAME is refused", async () => {
    const a = tenant();
    const b = tenant();
    await createStatus(t.db, a, { key: "waiting", label: "Waiting" });
    await createStatus(t.db, b, { key: "waiting", label: "Waiting" });
    // 0.11.0 review: the short name is never shown, so a new name whose short
    // name is taken gets the next number — only the same NAME is refused.
    expect((await createStatus(t.db, a, { key: "waiting", label: "Again" })).key).toBe("waiting_2");
    expect((await createStatus(t.db, a, { label: "Waiting!" })).key).toBe("waiting_3");
    await expect(createStatus(t.db, a, { label: "  waiting " })).rejects.toBeInstanceOf(DuplicateKeyError);
    expect((await createCategory(t.db, a, { key: "bug", label: "Bug" })).key).toBe("bug_2");
    await expect(createCategory(t.db, a, { label: "bug REPORT" })).rejects.toBeInstanceOf(DuplicateKeyError);
  });
});

describe("ticket numbers count per company", () => {
  it("starts each company at FB-00001", async () => {
    const a = tenant();
    const b = tenant();
    expect((await createTicket(t.db, { tenantId: a, payload: payload() })).ticketNumber).toBe("FB-00001");
    expect((await createTicket(t.db, { tenantId: a, payload: payload() })).ticketNumber).toBe("FB-00002");
    expect((await createTicket(t.db, { tenantId: b, payload: payload() })).ticketNumber).toBe("FB-00001");
  });

  it("is race-safe: twelve submits at once get twelve different numbers", async () => {
    const a = tenant();
    const created = await Promise.all(Array.from({ length: 12 }, () => createTicket(t.db, { tenantId: a, payload: payload() })));
    const numbers = created.map((c) => c.ticketNumber).sort();
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[0]).toBe("FB-00001");
    expect(numbers[11]).toBe("FB-00012");
  });

  it("counts past FB-99999 (0.9 compared the text, and would have reused FB-100000)", async () => {
    const a = tenant();
    const first = await createTicket(t.db, { tenantId: a, payload: payload() });
    await t.db.execute(sql`update feedback_tickets set ticket_number = 'FB-99999' where id = ${first.id}`);
    const next = await createTicket(t.db, { tenantId: a, payload: payload() });
    expect(next.ticketNumber).toBe("FB-100000");
    expect((await createTicket(t.db, { tenantId: a, payload: payload() })).ticketNumber).toBe("FB-100001");
  });

  it("finds a reporter's ticket by number and token only inside its company", async () => {
    const a = tenant();
    const b = tenant();
    const mine = await createTicket(t.db, { tenantId: a, payload: payload() });
    await createTicket(t.db, { tenantId: b, payload: payload() }); // B's FB-00001 too
    expect((await findReporterTicket(t.db, a, mine))?.id).toBe(mine.id);
    expect(await findReporterTicket(t.db, b, mine)).toBeNull();
    expect(await findReporterTicket(t.db, a, { ticketNumber: mine.ticketNumber, ticketToken: "aft_wrong" })).toBeNull();
  });
});

describe("the board's own rules, per company", () => {
  it("refuses an unknown column, ignores a move to the same column, and stamps the aging clock", async () => {
    const a = tenant();
    const ticket = await createTicket(t.db, { tenantId: a, payload: payload() });
    expect(await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "nowhere" })).toEqual({ moved: false, reason: "unknown-status" });
    expect(await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "open" })).toEqual({ moved: false, reason: "unchanged" });
    const at = new Date("2030-01-02T03:04:05Z");
    const moved = await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "in_progress" }, at);
    expect(moved.moved).toBe(true);
    expect((await getTicket(t.db, a, ticket.id))?.statusChangedAt?.toISOString()).toBe(at.toISOString());
  });

  it("refuses to delete an occupied column or a used category, and says how many", async () => {
    const a = tenant();
    await createTicket(t.db, { tenantId: a, payload: submitPayloadSchema.parse(report(undefined, { category: "bug" })) });
    const open = (await listStatuses(t.db, a)).find((s) => s.key === "open")!;
    expect(await deleteStatus(t.db, a, open.id)).toEqual({ deleted: false, reason: "occupied", ticketCount: 1 });
    const bug = (await listCategories(t.db, a)).find((c) => c.key === "bug")!;
    expect(await deleteCategory(t.db, a, bug.id)).toEqual({ deleted: false, reason: "occupied", ticketCount: 1 });
  });

  it("archives once, sweeps finished columns, and the unread mark clears on read", async () => {
    const a = tenant();
    const ticket = await createTicket(t.db, { tenantId: a, payload: payload() });
    let board = await listBoardData(t.db, a);
    expect(board.tickets[0]?.hasUnreadReporterReply).toBe(true);
    expect(await markTicketRead(t.db, a, ticket.id)).toBe(true);
    board = await listBoardData(t.db, a);
    expect(board.tickets[0]?.hasUnreadReporterReply).toBe(false);
    await moveTicket(t.db, a, { ticketId: ticket.id, statusKey: "resolved" });
    expect((await listBoardData(t.db, a)).archivableCount).toBe(1);
    expect(await archiveTerminalTickets(t.db, a, { archivedBy: "Ada" })).toEqual({ archived: 1 });
    expect(await archiveTicket(t.db, a, { ticketId: ticket.id, archivedBy: "Someone else" })).toBe(false);
    expect((await getTicket(t.db, a, ticket.id))?.archivedBy).toBe("Ada");
    expect((await listBoardData(t.db, a)).tickets).toEqual([]);
    expect((await listBoardData(t.db, a, { includeArchived: true })).tickets.length).toBe(1);
  });

  it("revokes a key only once and only its own company's", async () => {
    const a = tenant();
    const key = await issueClientKey(t.db, { tenantId: a, label: "Site" });
    expect(await revokeClientKey(t.db, a, key.id)).toBe(true);
    expect(await verifyClientKey(t.db, key.key)).toBeNull();
    const listed = await listClientKeys(t.db, a);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(key.key);
  });
});
