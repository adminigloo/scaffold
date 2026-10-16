import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  archiveTerminalTickets,
  archiveTicket,
  assignTicket,
  createCategory,
  createFeedbackAdminHandlers,
  createStaffTicket,
  createStatus,
  createTicket,
  deleteStatus,
  EMPTY_FILTERS,
  FILTER_ME,
  FILTER_NONE,
  filtersFromSearchParams,
  filtersToSearchParams,
  likePattern,
  listBoardData,
  listStatuses,
  listTicketEvents,
  moveTicket,
  moveTickets,
  reorderCategories,
  reorderStatuses,
  listCategories,
  submitPayloadSchema,
  TicketChangeError,
  unarchiveTicket,
  updateTicket,
  type BoardFilters,
} from "../index.js";
import { FeedbackAdminClient } from "../board-client.js";
import { feedbackTickets } from "../schema.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * 0.11.0, the complete board: the filters and search (every field, OR within,
 * AND across, escaping, counts), staff tickets (numbering shared with the
 * intake, race-safe), editing with its trail, the column delete that moves
 * tickets, the one-statement reorder — and, for each, that another company
 * gets nothing: its words find nothing, its ids match nothing, its columns,
 * categories and people are refused.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ADA = { id: "u-ada", name: "Ada" };
const at = (iso: string) => new Date(iso);

async function intake(tenantId: string, description: string, extra: Record<string, unknown> = {}, source?: "widget" | "page") {
  return createTicket(t.db, { tenantId, payload: submitPayloadSchema.parse(report(description, extra)), ...(source ? { source } : {}) });
}

async function setCreated(ticketId: string, iso: string) {
  await t.db.update(feedbackTickets).set({ createdAt: at(iso) }).where(sql`${feedbackTickets.id} = ${ticketId}`);
}

const f = (filters: Partial<BoardFilters>) => ({ filters });
const numbers = (data: { tickets: Array<{ ticketNumber: string }> }) => data.tickets.map((x) => x.ticketNumber).sort();

/** A board with one of everything to filter by. */
async function plantBoard(label: string) {
  const co = tenant(label);
  await createCategory(t.db, co, { key: "billing", label: "Billing" });
  const one = await intake(co, `The gate code 100% fails for ${label}`, { reporter: { name: "Pat Reporter", email: "pat@example.test" } });
  const two = await intake(co, "Invoices page shows a_b instead of totals", { priority: "high", category: "billing" }, "page");
  const three = await createStaffTicket(t.db, co, { title: "Call back about the C:\\drive export", priority: "critical", category: "billing", assignee: { id: "u-ben", name: "Ben" } }, ADA);
  const four = await createStaffTicket(t.db, co, { title: "Follow up with Ada's own customer", assignee: { id: ADA.id, name: "Ada" } }, ADA);
  await setCreated(one.id, "2026-10-01T12:00:00Z");
  await setCreated(two.id, "2026-10-03T12:00:00Z");
  await setCreated(three.id, "2026-10-05T12:00:00Z");
  await setCreated(four.id, "2026-10-07T12:00:00Z");
  await moveTicket(t.db, co, { ticketId: two.id, statusKey: "in_progress", actor: ADA });
  return { co, one, two, three, four };
}

describe("board-filters: the address and the request share one vocabulary", () => {
  it("round-trips every field, drops unknown names and words, and keeps other parameters", () => {
    const filters: BoardFilters = {
      ...EMPTY_FILTERS,
      q: "gate",
      status: ["open", "in_progress"],
      priority: ["critical"],
      category: [FILTER_NONE, "billing"],
      assignee: [FILTER_ME],
      source: ["staff"],
      from: "2026-10-01",
      to: "2026-10-05",
      archived: true,
    };
    const params = filtersToSearchParams(filters, new URLSearchParams("ticket=abc&status=stale"));
    expect(params.get("ticket")).toBe("abc");
    expect(filtersFromSearchParams(params)).toEqual(filters);
    const junk = filtersFromSearchParams(new URLSearchParams("priority=urgent&source=email&from=yesterday&nonsense=1&q=" + "x".repeat(500)));
    expect(junk.priority).toEqual([]);
    expect(junk.source).toEqual([]);
    expect(junk.from).toBeNull();
    expect(junk.q).toHaveLength(200);
  });

  it("caps a field at 50 values", () => {
    const params = new URLSearchParams();
    for (let i = 0; i < 80; i += 1) params.append("status", `s${i}`);
    expect(filtersFromSearchParams(params).status).toHaveLength(50);
  });

  it("escapes LIKE's own characters, so a search means what was typed", () => {
    expect(likePattern("100%")).toBe("%100\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("C:\\drive")).toBe("%C:\\\\drive%");
  });

  it("the client sends the filters under the same names", async () => {
    const asked: string[] = [];
    const client = new FeedbackAdminClient("/api/app/co/feedback", {
      fetch: async (input) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ statuses: [], tickets: [], archivableCount: 0 }), { status: 200 });
      },
    });
    await client.board({ filters: { q: "gate", assignee: [FILTER_NONE, FILTER_ME] } });
    await client.board({ archived: true });
    expect(asked).toEqual(["/api/app/co/feedback/v1/admin/board?q=gate&assignee=__none&assignee=__me", "/api/app/co/feedback/v1/admin/board?archived=1"]);
  });
});

describe("filters and search, on the server", () => {
  it("narrows by each field, OR within a field and AND across fields", async () => {
    const { co } = await plantBoard("filters");
    const all = await listBoardData(t.db, co);
    expect(all.totalCount).toBe(4);
    expect(all.matchCount).toBe(4);
    expect(numbers(await listBoardData(t.db, co, f({ status: ["in_progress"] })))).toEqual(["FB-00002"]);
    expect(numbers(await listBoardData(t.db, co, f({ status: ["open", "in_progress"] })))).toHaveLength(4);
    expect(numbers(await listBoardData(t.db, co, f({ priority: ["critical", "high"] })))).toEqual(["FB-00002", "FB-00003"]);
    expect(numbers(await listBoardData(t.db, co, f({ category: ["billing"] })))).toEqual(["FB-00002", "FB-00003"]);
    expect(numbers(await listBoardData(t.db, co, f({ category: [FILTER_NONE] })))).toEqual(["FB-00001", "FB-00004"]);
    expect(numbers(await listBoardData(t.db, co, f({ source: ["staff"] })))).toEqual(["FB-00003", "FB-00004"]);
    expect(numbers(await listBoardData(t.db, co, f({ source: ["page"] })))).toEqual(["FB-00002"]);
    expect(numbers(await listBoardData(t.db, co, f({ source: ["widget"] })))).toEqual(["FB-00001"]);
    // AND across fields.
    expect(numbers(await listBoardData(t.db, co, f({ category: ["billing"], source: ["staff"] })))).toEqual(["FB-00003"]);
    const narrowed = await listBoardData(t.db, co, f({ category: ["billing"], priority: ["low"] }));
    expect([narrowed.tickets.length, narrowed.matchCount, narrowed.totalCount]).toEqual([0, 0, 4]);
  });

  it("assignee: a person, Unassigned (nobody at all), and Mine — whoever is asking", async () => {
    const { co, one } = await plantBoard("people");
    expect(numbers(await listBoardData(t.db, co, f({ assignee: ["u-ben"] })))).toEqual(["FB-00003"]);
    expect(numbers(await listBoardData(t.db, co, f({ assignee: [FILTER_NONE] })))).toEqual(["FB-00001", "FB-00002"]);
    expect(numbers(await listBoardData(t.db, co, { filters: { assignee: [FILTER_ME] }, viewerId: ADA.id }))).toEqual(["FB-00004"]);
    expect(numbers(await listBoardData(t.db, co, { filters: { assignee: [FILTER_ME] }, viewerId: "u-ben" }))).toEqual(["FB-00003"]);
    // Nobody signed in: "Mine" is nobody's, never everyone's.
    expect(numbers(await listBoardData(t.db, co, f({ assignee: [FILTER_ME] })))).toEqual([]);
    expect(numbers(await listBoardData(t.db, co, { filters: { assignee: [FILTER_ME, FILTER_NONE] }, viewerId: ADA.id }))).toEqual([
      "FB-00001",
      "FB-00002",
      "FB-00004",
    ]);
    // A name typed the 0.10 way is somebody: not "Unassigned".
    await assignTicket(t.db, co, { ticketId: one.id, assignee: "Typed Name", actorName: "Ada" });
    expect(numbers(await listBoardData(t.db, co, f({ assignee: [FILTER_NONE] })))).toEqual(["FB-00002"]);
  });

  it("dates: from the first day to the last, both whole days", async () => {
    const { co } = await plantBoard("dates");
    expect(numbers(await listBoardData(t.db, co, f({ from: "2026-10-03", to: "2026-10-05" })))).toEqual(["FB-00002", "FB-00003"]);
    expect(numbers(await listBoardData(t.db, co, f({ from: "2026-10-06T00:00:00.000Z" })))).toEqual(["FB-00004"]);
    expect(numbers(await listBoardData(t.db, co, f({ to: "2026-10-01T23:00:00.000Z" })))).toEqual(["FB-00001"]);
  });

  it("searches the number, title, report and the reporter's name and email, in any case", async () => {
    const { co } = await plantBoard("search");
    const q = async (text: string) => numbers(await listBoardData(t.db, co, f({ q: text })));
    expect(await q("GATE CODE")).toEqual(["FB-00001"]);
    expect(await q("totals")).toEqual(["FB-00002"]);
    expect(await q("pat reporter")).toEqual(["FB-00001"]);
    expect(await q("PAT@EXAMPLE")).toEqual(["FB-00001"]);
    expect(await q("FB-00003")).toEqual(["FB-00003"]);
    for (const typed of ["3", "#3", "fb3", "fb-3", "FB-003"]) expect(await q(typed), typed).toEqual(["FB-00003"]);
    // And it ANDs with the filters (Ask Lou's search silently dropped them).
    expect(numbers(await listBoardData(t.db, co, f({ q: "invoices", source: ["staff"] })))).toEqual([]);
  });

  it("escapes % _ and \\ — they are what was typed, never wildcards", async () => {
    const { co } = await plantBoard("escape");
    const q = async (text: string) => numbers(await listBoardData(t.db, co, f({ q: text })));
    expect(await q("100%")).toEqual(["FB-00001"]);
    expect(await q("%")).toEqual(["FB-00001"]);
    expect(await q("a_b")).toEqual(["FB-00002"]);
    expect(await q("_")).toEqual(["FB-00002"]);
    expect(await q("C:\\drive")).toEqual(["FB-00003"]);
    expect(await q("\\")).toEqual(["FB-00003"]);
    expect(await q("g%e")).toEqual([]);
  });

  it("counts each option with the other filters on, and says how many match beyond what's shown", async () => {
    const { co } = await plantBoard("facets");
    const board = await listBoardData(t.db, co, { filters: { source: ["staff"] }, viewerId: ADA.id });
    // Status counts are among the staff tickets only…
    expect(board.facets.status).toEqual({ open: 2 });
    // …while the source counts ignore the source filter itself.
    expect(board.facets.source).toEqual({ widget: 1, page: 1, staff: 2 });
    expect(board.facets.assignee).toEqual({ "u-ben": 1, [ADA.id]: 1 });
    expect(board.facets.category).toEqual({ billing: 1, [FILTER_NONE]: 1 });
    expect([board.matchCount, board.totalCount, board.truncated]).toEqual([2, 4, false]);
  });

  it("reads finished columns separately, so a busy Done never pushes open work off", async () => {
    const co = tenant("caps");
    const open = await intake(co, "Still open from long ago, read me");
    await setCreated(open.id, "2020-01-01T00:00:00Z");
    for (let i = 0; i < 305; i += 1) {
      const done = await createStaffTicket(t.db, co, { title: `Done ${i}` }, ADA);
      await moveTicket(t.db, co, { ticketId: done.id, statusKey: "closed" });
    }
    const board = await listBoardData(t.db, co);
    expect(board.tickets.some((x) => x.id === open.id)).toBe(true);
    expect(board.tickets.filter((x) => x.status === "closed")).toHaveLength(100);
    expect([board.matchCount, board.totalCount, board.truncated]).toEqual([306, 306, true]);
    // A search reaches past the cap: Done 3, Done 30–39, Done 300–304.
    expect(numbers(await listBoardData(t.db, co, f({ q: "Done 3", status: ["closed"] })))).toHaveLength(16);
  }, 60_000);

  it("ANOTHER COMPANY: its words, ids, people and keys find nothing — and its counts show nothing", async () => {
    const a = await plantBoard("alpha");
    const b = await plantBoard("bravo");
    const ask = (filters: Partial<BoardFilters>, viewerId: string | null = null) => listBoardData(t.db, b.co, { filters, viewerId });
    // Words only A's tickets carry.
    expect((await ask({ q: "for alpha" })).tickets).toEqual([]);
    // A's ticket numbers name B's own tickets, never A's.
    const byNumber = await ask({ q: a.one.ticketNumber });
    expect(byNumber.tickets.map((x) => x.id)).toEqual([b.one.id]);
    // A's people match nothing on B's board (the assignee ids are per company here).
    await updateTicket(t.db, a.co, { ticketId: a.one.id, assignee: { id: "alpha-only", name: "Alpha Only" } }, ADA);
    const theirs = await ask({ assignee: ["alpha-only"] });
    expect([theirs.tickets, theirs.matchCount]).toEqual([[], 0]);
    expect(JSON.stringify(await ask({}))).not.toContain("alpha-only");
    expect(JSON.stringify(await ask({}))).not.toContain("Alpha Only");
    // A category only A has.
    await createCategory(t.db, a.co, { key: "alpha_only", label: "Alpha only" });
    await updateTicket(t.db, a.co, { ticketId: a.two.id, category: "alpha_only" }, ADA);
    expect((await ask({ category: ["alpha_only"] })).tickets).toEqual([]);
    expect(Object.keys((await ask({})).facets.category)).not.toContain("alpha_only");
    // B's whole board, filters or not, holds only B's tickets.
    const ids = new Set([a.one.id, a.two.id, a.three.id, a.four.id]);
    for (const filters of [{}, { q: "a" }, { priority: ["critical" as const] }, { source: ["staff" as const] }, { assignee: [FILTER_NONE] }]) {
      expect((await ask(filters, ADA.id)).tickets.filter((x) => ids.has(x.id)), JSON.stringify(filters)).toEqual([]);
    }
  });
});

describe("New ticket, by the team", () => {
  it("lands where asked, numbered in the company after the intake's, marked as the team's", async () => {
    const co = tenant("staff");
    await intake(co, "A report from the button first");
    const made = await createStaffTicket(t.db, co, { title: "  Phone call: gate stuck  ", description: "Rang at 9", status: "in_progress", priority: "high" }, ADA);
    expect(made).toMatchObject({ ticketNumber: "FB-00002", title: "Phone call: gate stuck", status: "in_progress" });
    const [card] = (await listBoardData(t.db, co, f({ source: ["staff"] }))).tickets;
    expect(card).toMatchObject({ source: "staff", priority: "high", assignee: null });
    const raw = (await t.db.execute(sql`select created_by, description from feedback_tickets where id = ${made.id}`)) as unknown as {
      rows: Array<{ created_by: string; description: string }>;
    };
    expect(raw.rows[0]).toEqual({ created_by: ADA.id, description: "Rang at 9" });
    expect((await listTicketEvents(t.db, co, made.id)).map((e) => [e.kind, e.actorName, e.actorId])).toEqual([["created", "Ada", ADA.id]]);
    // Default column: the first unfinished one, as the intake does.
    const plain = await createStaffTicket(t.db, co, { title: "Just a title" }, ADA);
    expect(plain.status).toBe("open");
  });

  it("refuses a column or category that isn't this company's (another company's included), writing nothing", async () => {
    const a = tenant("own");
    const b = tenant("other");
    await createStatus(t.db, a, { key: "alpha_waiting", label: "Waiting" });
    await createCategory(t.db, a, { key: "alpha_billing", label: "Billing" });
    await expect(createStaffTicket(t.db, b, { title: "x", status: "alpha_waiting" }, ADA)).rejects.toThrow(TicketChangeError);
    await expect(createStaffTicket(t.db, b, { title: "x", category: "alpha_billing" }, ADA)).rejects.toThrow(TicketChangeError);
    expect((await listBoardData(t.db, b)).totalCount).toBe(0);
    await expect(createStaffTicket(t.db, b, { title: "   " }, ADA)).rejects.toThrow();
  });

  it("NUMBERING RACE: ten team tickets and ten reports at once get twenty different numbers, per company", async () => {
    const a = tenant("race-a");
    const b = tenant("race-b");
    const made = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => createStaffTicket(t.db, a, { title: `Staff ${i}` }, ADA)),
      ...Array.from({ length: 10 }, (_, i) => intake(a, `Report number ${i} with words`)),
      ...Array.from({ length: 5 }, (_, i) => createStaffTicket(t.db, b, { title: `Bravo ${i}` }, ADA)),
    ]);
    const inA = made.slice(0, 20).map((x) => x.ticketNumber).sort();
    expect(new Set(inA).size).toBe(20);
    expect(inA[0]).toBe("FB-00001");
    expect(inA[19]).toBe("FB-00020");
    expect(made.slice(20).map((x) => x.ticketNumber).sort()).toEqual(["FB-00001", "FB-00002", "FB-00003", "FB-00004", "FB-00005"]);
  });
});

describe("editing, with the trail", () => {
  it("changes title, priority, category and assignee, one trail line per change, in words", async () => {
    const co = tenant("edit");
    const ticket = await intake(co, "Crashes when saving the form", { reporter: { name: "Pat" } });
    expect(await updateTicket(t.db, co, { ticketId: ticket.id, title: "Saving crashes", priority: "critical", category: "bug", assignee: { id: "u-ben", name: "Ben" } }, ADA)).toEqual({
      updated: true,
      changed: ["title", "priority", "category", "assignee"],
    });
    const [card] = (await listBoardData(t.db, co)).tickets;
    expect(card).toMatchObject({ title: "Saving crashes", priority: "critical", category: "bug", assignee: "Ben", assigneeId: "u-ben" });
    // The same values again: nothing changes, nothing is written.
    expect(await updateTicket(t.db, co, { ticketId: ticket.id, priority: "critical", assignee: { id: "u-ben", name: "Ben" } }, ADA)).toEqual({ updated: true, changed: [] });
    await updateTicket(t.db, co, { ticketId: ticket.id, category: null, assignee: null }, { id: "u-ben", name: "Ben" });
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: "resolved", actor: ADA });
    await archiveTicket(t.db, co, { ticketId: ticket.id, archivedBy: "Ada", actorId: ADA.id });
    await unarchiveTicket(t.db, co, ticket.id, ADA);
    const trail = (await listTicketEvents(t.db, co, ticket.id)).map((e) => [e.kind, e.fromValue, e.toValue, e.actorName]);
    expect(trail).toEqual([
      ["created", null, null, "Pat"],
      ["title", "Crashes when saving the form", "Saving crashes", "Ada"],
      ["priority", "Medium", "Critical", "Ada"],
      ["category", null, "Bug report", "Ada"],
      ["assignee", null, "Ben", "Ada"],
      ["category", "Bug report", null, "Ben"],
      ["assignee", "Ben", null, "Ben"],
      ["status", "Open", "Resolved", "Ada"],
      ["archived", null, null, "Ada"],
      ["unarchived", null, null, "Ada"],
    ]);
  });

  it("checks everything before writing anything: a refused category leaves the title as it was", async () => {
    const co = tenant("atomic");
    const ticket = await intake(co, "Original title stays put");
    await expect(updateTicket(t.db, co, { ticketId: ticket.id, title: "Changed", category: "not_here" }, ADA)).rejects.toThrow(TicketChangeError);
    expect((await listBoardData(t.db, co)).tickets[0]?.title).toBe("Original title stays put");
    expect((await listTicketEvents(t.db, co, ticket.id)).map((e) => e.kind)).toEqual(["created"]);
  });

  it("bulk moves and the finished sweep write a line per ticket", async () => {
    const co = tenant("bulk");
    const one = await intake(co, "First of two to move");
    const two = await intake(co, "Second of two to move");
    await moveTickets(t.db, co, { ticketIds: [one.id, two.id], statusKey: "closed", actor: ADA });
    await archiveTerminalTickets(t.db, co, { archivedBy: "Ada", actorId: ADA.id });
    for (const ticket of [one, two]) {
      expect((await listTicketEvents(t.db, co, ticket.id)).map((e) => [e.kind, e.toValue])).toEqual([
        ["created", null],
        ["status", "Closed"],
        ["archived", null],
      ]);
    }
  });

  it("ANOTHER COMPANY: can't edit, can't read the trail, and its ids change nothing", async () => {
    const a = tenant("ea");
    const b = tenant("eb");
    const ticket = await intake(a, "Alpha's ticket, not Bravo's");
    expect(await updateTicket(t.db, b, { ticketId: ticket.id, title: "Hijacked" }, ADA)).toBeNull();
    expect(await listTicketEvents(t.db, b, ticket.id)).toEqual([]);
    expect((await moveTicket(t.db, b, { ticketId: ticket.id, statusKey: "closed", actor: ADA })).moved).toBe(false);
    expect(await archiveTicket(t.db, b, { ticketId: ticket.id, archivedBy: "x" })).toBe(false);
    expect(await unarchiveTicket(t.db, b, ticket.id)).toBe(false);
    expect((await listBoardData(t.db, a)).tickets[0]).toMatchObject({ title: "Alpha's ticket, not Bravo's", status: "open" });
    expect((await listTicketEvents(t.db, a, ticket.id)).map((e) => e.kind)).toEqual(["created"]);
  });
});

describe("columns: delete with a move, one-statement reorder", () => {
  it("moves a column's tickets to the chosen column, then deletes it — each move on the ticket's trail", async () => {
    const co = tenant("del");
    const waiting = await createStatus(t.db, co, { key: "waiting", label: "Waiting" });
    const ticket = await intake(co, "Sits in the waiting column");
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: "waiting" });
    expect(await deleteStatus(t.db, co, waiting.id)).toEqual({ deleted: false, reason: "occupied", ticketCount: 1 });
    expect(await deleteStatus(t.db, co, waiting.id, { moveTo: "waiting" })).toEqual({ deleted: false, reason: "unknown-target" });
    expect(await deleteStatus(t.db, co, waiting.id, { moveTo: "in_progress", actor: ADA })).toMatchObject({ deleted: true, moved: 1, to: { key: "in_progress" }, tickets: [{ id: ticket.id, from: "waiting" }] });
    expect((await listBoardData(t.db, co)).tickets[0]?.status).toBe("in_progress");
    expect((await listStatuses(t.db, co)).map((s) => s.key)).not.toContain("waiting");
    expect((await listTicketEvents(t.db, co, ticket.id)).at(-1)).toMatchObject({ kind: "status", fromValue: "Waiting", toValue: "In progress", actorName: "Ada" });
  });

  it("ANOTHER COMPANY's column is no place to move tickets to, and its column can't be deleted", async () => {
    const a = tenant("da");
    const b = tenant("db");
    await createStatus(t.db, a, { key: "alpha_only", label: "Alpha only" });
    const bWaiting = await createStatus(t.db, b, { key: "waiting", label: "Waiting" });
    const ticket = await intake(b, "Bravo's waiting ticket");
    await moveTicket(t.db, b, { ticketId: ticket.id, statusKey: "waiting" });
    // Empty or not, an unknown target refuses (a stale editor never deletes on its word).
    expect(await deleteStatus(t.db, b, bWaiting.id, { moveTo: "alpha_only" })).toEqual({ deleted: false, reason: "unknown-target" });
    expect((await listBoardData(t.db, b)).tickets[0]?.status).toBe("waiting");
    const aColumns = await listStatuses(t.db, a);
    expect(await deleteStatus(t.db, b, aColumns[0]!.id, { moveTo: "open" })).toEqual({ deleted: false, reason: "unknown" });
    expect(await listStatuses(t.db, a)).toEqual(aColumns);
  });

  it("reorders in one statement, renumbering in tens, skipping another company's ids", async () => {
    const a = tenant("ra");
    const b = tenant("rb");
    await listBoardData(t.db, a);
    await listBoardData(t.db, b);
    const mine = await listStatuses(t.db, a);
    const theirs = await listStatuses(t.db, b);
    await reorderStatuses(t.db, a, [...mine].reverse().map((s) => s.id).concat(theirs[0]!.id));
    expect((await listStatuses(t.db, a)).map((s) => [s.key, s.sortOrder])).toEqual([
      ["closed", 10],
      ["resolved", 20],
      ["in_progress", 30],
      ["open", 40],
    ]);
    expect(await listStatuses(t.db, b)).toEqual(theirs);
    const cats = await listCategories(t.db, a);
    await reorderCategories(t.db, a, [cats[1]!.id, cats[0]!.id]);
    expect((await listCategories(t.db, a)).slice(0, 2).map((c) => c.key)).toEqual([cats[1]!.key, cats[0]!.key]);
  });
});

describe("the routes: New ticket, editing, the trail, people, filters", () => {
  const PEOPLE: Record<string, Array<{ id: string; name: string }>> = {};
  function handlers() {
    return createFeedbackAdminHandlers({
      db: t.db,
      resolveTenant: (req) => /\/api\/app\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname)?.[1] ?? null,
      authorize: () => ({ userId: ADA.id }),
      staffName: () => "Ada",
      listPeople: (tenantId) => PEOPLE[tenantId] ?? [],
    });
  }
  const post = (co: string, path: string, body: unknown) =>
    handlers().handle(
      new Request(`http://localhost/api/app/${co}/feedback/v1/admin/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
      }),
    );
  const get = (co: string, path: string) => handlers().handle(new Request(`http://localhost/api/app/${co}/feedback/v1/admin/${path}`));

  it("files, edits and reads the trail through the routes, with the people the host lists", async () => {
    const co = tenant("routes");
    PEOPLE[co] = [ADA, { id: "u-ben", name: "Ben" }];
    const created = await post(co, "tickets", { title: "From the board", priority: "high", assigneeId: "u-ben" });
    expect(created.status).toBe(201);
    const { ticket } = (await created.json()) as { ticket: { id: string; ticketNumber: string } };
    expect(ticket.ticketNumber).toBe("FB-00001");
    const people = (await (await get(co, "people")).json()) as { people: unknown; me: string };
    expect(people).toEqual({ people: PEOPLE[co], me: ADA.id });
    expect((await post(co, `tickets/${ticket.id}`, { priority: "low", assigneeId: ADA.id })).status).toBe(200);
    const mine = (await (await get(co, `board?assignee=${FILTER_ME}`)).json()) as { tickets: Array<{ id: string; priority: string }> };
    expect(mine.tickets.map((x) => [x.id, x.priority])).toEqual([[ticket.id, "low"]]);
    const trail = (await (await get(co, `tickets/${ticket.id}/events`)).json()) as { events: Array<{ kind: string; toValue: string | null }> };
    expect(trail.events.map((e) => [e.kind, e.toValue])).toEqual([
      ["created", null],
      ["priority", "Low"],
      ["assignee", "Ada"],
    ]);
    // Unassign with null.
    expect((await post(co, `tickets/${ticket.id}`, { assigneeId: null })).status).toBe(200);
    expect((await listBoardData(t.db, co)).tickets[0]).toMatchObject({ assignee: null, assigneeId: null });
  });

  it("refuses another company's person, column and category with a sentence, and its ticket as not found", async () => {
    const a = tenant("ra2");
    const b = tenant("rb2");
    PEOPLE[a] = [{ id: "alpha-person", name: "Alpha Person" }];
    PEOPLE[b] = [ADA];
    await createStatus(t.db, a, { key: "alpha_col", label: "Alpha col" });
    await createCategory(t.db, a, { key: "alpha_cat", label: "Alpha cat" });
    const aTicket = await intake(a, "Alpha's own ticket, keep out");
    const bTicket = await intake(b, "Bravo's own ticket for the mix");
    for (const body of [{ title: "x", assigneeId: "alpha-person" }, { title: "x", status: "alpha_col" }, { title: "x", category: "alpha_cat" }]) {
      const res = await post(b, "tickets", body);
      const text = await res.text();
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(text).not.toMatch(/alpha/i);
    }
    expect((await post(b, `tickets/${bTicket.id}`, { assigneeId: "alpha-person" })).status).toBe(400);
    expect((await post(b, `tickets/${bTicket.id}`, { category: "alpha_cat" })).status).toBe(400);
    expect((await post(b, `tickets/${aTicket.id}`, { title: "Hijack" })).status).toBe(404);
    expect((await get(b, `tickets/${aTicket.id}/events`)).status).toBe(404);
    const board = await (await get(b, `board?q=${encodeURIComponent("keep out")}&assignee=alpha-person`)).text();
    expect(board).not.toMatch(/alpha/i);
    expect((await listBoardData(t.db, b)).totalCount).toBe(1);
    expect((await listBoardData(t.db, a)).tickets[0]?.title).toBe("Alpha's own ticket, keep out");
  });

  it("deletes a column with tickets by moving them, through the route", async () => {
    const co = tenant("routedel");
    const column = await createStatus(t.db, co, { key: "later", label: "Later" });
    const ticket = await intake(co, "Parked for later on");
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: "later" });
    expect((await post(co, `columns/${column.id}/delete`, {})).status).toBe(409);
    expect((await post(co, `columns/${column.id}/delete`, { moveTo: "nope" })).status).toBe(400);
    const ok = await post(co, `columns/${column.id}/delete`, { moveTo: "open" });
    expect([ok.status, await ok.json()]).toEqual([200, { deleted: true, moved: 1 }]);
  });

  it("without a people seam the board still works: no people, and an assignee id is refused", async () => {
    const co = tenant("noseam");
    const plain = createFeedbackAdminHandlers({ db: t.db, tenantId: co, authorize: () => ({ userId: "u1" }) });
    expect(await (await plain.handle(new Request("http://localhost/x/v1/admin/people"))).json()).toEqual({ people: [], me: "u1" });
    const res = await plain.handle(
      new Request("http://localhost/x/v1/admin/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No people here", assigneeId: "u1" }),
      }),
    );
    expect(res.status).toBe(400);
    const made = await plain.handle(
      new Request("http://localhost/x/v1/admin/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No people here" }),
      }),
    );
    expect(made.status).toBe(201);
  });

  it("the platform's own board ('*') files and filters like any company's", async () => {
    const platform = createFeedbackAdminHandlers({ db: t.db, tenantId: "*", authorize: () => ({ userId: "staff-1" }), listPeople: () => [{ id: "staff-1", name: "Sam" }] });
    const made = await platform.handle(
      new Request("http://localhost/api/admin/feedback/v1/admin/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Site-wide: the footer link is broken", assigneeId: "staff-1" }),
      }),
    );
    expect(made.status).toBe(201);
    const mine = (await (await platform.handle(new Request(`http://localhost/api/admin/feedback/v1/admin/board?assignee=${FILTER_ME}&q=footer`))).json()) as {
      tickets: Array<{ title: string; source: string }>;
    };
    expect(mine.tickets.map((x) => [x.title, x.source])).toEqual([["Site-wide: the footer link is broken", "staff"]]);
  });
});
