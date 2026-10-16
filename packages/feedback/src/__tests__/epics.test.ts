import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  archiveTicket,
  canMoveEpic,
  createEpic,
  createFeedbackAdminHandlers,
  createStaffTicket,
  createStatus,
  createTicket,
  deleteEpic,
  deleteStatus,
  ensureFeedbackBoard,
  EPIC_STATUSES,
  EPIC_TRANSITIONS,
  EpicChangeError,
  epicBucketOf,
  epicDueWords,
  epicProgress,
  epicProgressFromCounts,
  FEEDBACK_PLATFORM_BOARD,
  FILTER_NONE,
  filtersFromSearchParams,
  findEpic,
  getEpic,
  listBoardData,
  listEpics,
  listStatuses,
  listTicketEvents,
  moveTicket,
  moveTickets,
  progressWords,
  reorderStatuses,
  setEpicStatus,
  setEpicTickets,
  submitPayloadSchema,
  updateEpic,
  updateStatus,
  updateTicket,
  type EpicStatus,
} from "../index.js";
import { createTestDb, report, schemaDdl, tenant, type TestDb } from "./pglite.js";

/**
 * 0.12.0, epics: the one progress rule (by the columns' flags, never their
 * names), the moves an epic may make and the stamps they leave, membership
 * (add and remove, all-or-nothing, never into a finished epic), delete (the
 * tickets stay, archived ones too), the automatic start (and that nothing
 * ever completes an epic by itself), the board's badge data, Epic filter and
 * counts — and, for every one, that another company's epic or ticket is "not
 * found" or refused, with nothing of either company changed.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ADA = { id: "u-ada", name: "Ada" };
const COLUMNS = [
  { key: "open", isTerminal: false },
  { key: "in_progress", isTerminal: false },
  { key: "waiting", isTerminal: false, isWaiting: true },
  { key: "resolved", isTerminal: true },
  { key: "closed", isTerminal: true },
];

async function intake(tenantId: string, description = "The export button does nothing at all today.") {
  return createTicket(t.db, { tenantId, payload: submitPayloadSchema.parse(report(description)) });
}

async function epicOf(tenantId: string, name = "New checkout", extra: Parameters<typeof createEpic>[2] = { name }) {
  return createEpic(t.db, tenantId, { ...extra, name }, ADA);
}

async function rowsOf(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

async function snapshot(tenantId: string): Promise<string> {
  return JSON.stringify([
    await rowsOf(sql`select * from feedback_tickets where tenant_id = ${tenantId} order by id`),
    await rowsOf(sql`select * from feedback_epics where tenant_id = ${tenantId} order by id`),
    await rowsOf(sql`select * from feedback_ticket_events where tenant_id = ${tenantId} order by id`),
  ]);
}

describe("progress: one rule, by the columns' flags", () => {
  it("counts done, waiting, not started and in progress, and rounds the percent down", () => {
    const tickets = ["open", "in_progress", "in_progress", "waiting", "resolved", "closed", "resolved"].map((status) => ({ status }));
    const progress = epicProgress(tickets, COLUMNS);
    expect(progress).toEqual({ total: 7, done: 3, inProgress: 2, waiting: 1, open: 1, percent: 42, allDone: false });
    expect(progressWords(progress)).toBe("3 of 7 done (42%)");
    // 199 of 200 is 99%, never "100%": 100 means every ticket.
    expect(epicProgressFromCounts({ resolved: 199, open: 1 }, COLUMNS).percent).toBe(99);
    expect(epicProgressFromCounts({ resolved: 2, closed: 1 }, COLUMNS)).toMatchObject({ percent: 100, allDone: true });
    expect(epicProgress([], COLUMNS)).toMatchObject({ total: 0, percent: 0, allDone: false });
    expect(progressWords(epicProgress([], COLUMNS))).toBe("No tickets yet");
  });

  it("never reads a name: a renamed landing column is 'not started', a custom finished column is done, an unknown status is in progress", () => {
    const custom = [
      { key: "new", isTerminal: false },
      { key: "shipped", isTerminal: true },
      { key: "doing", isTerminal: false },
    ];
    expect(epicBucketOf("new", custom)).toBe("open");
    expect(epicBucketOf("shipped", custom)).toBe("done");
    expect(epicBucketOf("doing", custom)).toBe("in_progress");
    // "open" and "resolved" mean nothing on this board: no column has them.
    expect(epicBucketOf("open", custom)).toBe("in_progress");
    expect(epicBucketOf("resolved", custom)).toBe("in_progress");
    expect(epicProgress([{ status: "shipped" }, { status: "gone" }], custom)).toMatchObject({ done: 1, inProgress: 1, total: 2 });
  });

  it("says how a target date stands, and never calls a finished epic late", () => {
    const today = new Date(2026, 9, 16);
    expect(epicDueWords("2026-10-16", "open", today)).toBe("Due today");
    expect(epicDueWords("2026-10-17", "open", today)).toBe("Due tomorrow");
    expect(epicDueWords("2026-10-20", "in_progress", today)).toBe("Due in 4 days");
    expect(epicDueWords("2026-10-15", "in_progress", today)).toBe("1 day late");
    expect(epicDueWords("2026-10-01", "open", today)).toBe("15 days late");
    expect(epicDueWords("2026-10-01", "completed", today)).toBeNull();
    expect(epicDueWords(null, "open", today)).toBeNull();
  });
});

describe("making and editing an epic", () => {
  it("needs only a name; no owner unless one is chosen; refuses a name in use, a colour off the palette and a date that isn't one", async () => {
    const co = tenant();
    const plain = await epicOf(co, "Spring price list");
    expect(plain).toMatchObject({ status: "open", ownerId: null, ownerName: null, color: "blue", targetDate: null, createdBy: "u-ada" });
    await expect(epicOf(co, "  spring   PRICE list ")).rejects.toThrow(/already an epic with that name/);
    await expect(createEpic(t.db, co, { name: "x", color: "chartreuse" as never }, ADA)).rejects.toThrow();
    await expect(createEpic(t.db, co, { name: "y", targetDate: "2026-02-30" }, ADA)).rejects.toThrow(/Pick a date/);
    await expect(createEpic(t.db, co, { name: "" }, ADA)).rejects.toThrow(/Give the epic a name/);
    const led = await createEpic(t.db, co, { name: "Led", owner: { id: "u-bo", name: "Bo" }, targetDate: "2026-11-30", color: "teal" }, ADA);
    expect(led).toMatchObject({ ownerId: "u-bo", ownerName: "Bo", targetDate: "2026-11-30", color: "teal" });
    // Another company may use the same name.
    expect((await epicOf(tenant(), "Spring price list")).name).toBe("Spring price list");
  });

  it("edits its name, words, date, colour and owner; null clears; another company's id is not found", async () => {
    const co = tenant();
    const epic = await createEpic(t.db, co, { name: "Q4", owner: { id: "u-bo", name: "Bo" }, targetDate: "2026-12-01" }, ADA);
    const edited = await updateEpic(t.db, co, epic.id, { name: "Q4 push", description: "Everything before the holidays", color: "red", targetDate: null, owner: null });
    expect(edited).toMatchObject({ name: "Q4 push", description: "Everything before the holidays", color: "red", targetDate: null, ownerId: null, ownerName: null });
    await epicOf(co, "Taken");
    await expect(updateEpic(t.db, co, epic.id, { name: "taken" })).rejects.toThrow(/already an epic/);
    expect(await updateEpic(t.db, tenant(), epic.id, { name: "Hijack" })).toBeNull();
    expect((await findEpic(t.db, co, epic.id))?.name).toBe("Q4 push");
  });
});

describe("an epic's life: Ask Lou's moves, and their stamps", () => {
  it("allows exactly the table's moves and refuses the rest with a sentence", async () => {
    for (const from of EPIC_STATUSES) {
      for (const to of EPIC_STATUSES) {
        expect(canMoveEpic(from, to), `${from} → ${to}`).toBe(from === to || EPIC_TRANSITIONS[from].includes(to));
      }
    }
    expect(EPIC_TRANSITIONS.archived).toEqual(["open"]);
    const co = tenant();
    const epic = await epicOf(co);
    await setEpicStatus(t.db, co, epic.id, "archived");
    const refused = setEpicStatus(t.db, co, epic.id, "in_progress");
    await expect(refused).rejects.toBeInstanceOf(EpicChangeError);
    await expect(setEpicStatus(t.db, co, epic.id, "in_progress")).rejects.toThrow("An archived epic can only be restored (to Not started) first.");
    await expect(setEpicStatus(t.db, co, epic.id, "launched")).rejects.toThrow();
  });

  it("stamps completed and archived, and clears both on the way back to work", async () => {
    const co = tenant();
    const epic = await epicOf(co);
    const at = (iso: string) => new Date(iso);
    const done = await setEpicStatus(t.db, co, epic.id, "completed", at("2026-10-01T10:00:00Z"));
    expect(done?.epic).toMatchObject({ status: "completed", completedAt: at("2026-10-01T10:00:00Z"), archivedAt: null });
    const shelved = await setEpicStatus(t.db, co, epic.id, "archived", at("2026-10-02T10:00:00Z"));
    expect(shelved?.epic).toMatchObject({ status: "archived", archivedAt: at("2026-10-02T10:00:00Z") });
    const back = await setEpicStatus(t.db, co, epic.id, "open", at("2026-10-03T10:00:00Z"));
    expect(back?.epic).toMatchObject({ status: "open", completedAt: null, archivedAt: null });
    expect(await setEpicStatus(t.db, co, epic.id, "open")).toMatchObject({ changed: false });
    expect(await setEpicStatus(t.db, tenant(), epic.id, "completed")).toBeNull();
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("open");
  });
});

describe("an epic's tickets", () => {
  it("adds and removes in one change, with a line on each ticket's trail, and says how many came from another epic", async () => {
    const co = tenant();
    const [one, two, three] = [await intake(co), await intake(co), await intake(co)];
    const checkout = await epicOf(co, "Checkout");
    const pricing = await epicOf(co, "Pricing");
    expect(await setEpicTickets(t.db, co, pricing.id, { add: [three.id] }, ADA)).toEqual({ added: 1, movedFromOther: 0, removed: 0 });
    expect(await setEpicTickets(t.db, co, checkout.id, { add: [one.id, two.id, three.id] }, ADA)).toEqual({ added: 3, movedFromOther: 1, removed: 0 });
    expect(await setEpicTickets(t.db, co, checkout.id, { add: [one.id], remove: [two.id] }, ADA)).toEqual({ added: 0, movedFromOther: 0, removed: 1 });
    const detail = await getEpic(t.db, co, checkout.id);
    expect(detail?.tickets.map((x) => x.id).sort()).toEqual([one.id, three.id].sort());
    expect((await listTicketEvents(t.db, co, three.id)).filter((e) => e.kind === "epic").map((e) => [e.fromValue, e.toValue, e.actorName])).toEqual([
      [null, "Pricing", "Ada"],
      ["Pricing", "Checkout", "Ada"],
    ]);
    expect((await listTicketEvents(t.db, co, two.id)).filter((e) => e.kind === "epic").map((e) => [e.fromValue, e.toValue])).toEqual([
      [null, "Checkout"],
      ["Checkout", null],
    ]);
    await expect(setEpicTickets(t.db, co, checkout.id, { add: [one.id], remove: [one.id] }, ADA)).rejects.toThrow(/added and taken out/);
  });

  it("refuses the WHOLE change when any ticket is another company's, and writes nothing on either side", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const aTicket = await intake(a, "Alpha's own ticket, never Bravo's to move.");
    const bTicket = await intake(b);
    const bEpic = await epicOf(b, "Bravo epic");
    const aEpic = await epicOf(a, "Alpha epic");
    const before = [await snapshot(a), await snapshot(b)];
    await expect(setEpicTickets(t.db, b, bEpic.id, { add: [bTicket.id, aTicket.id] }, ADA)).rejects.toThrow(/aren't on this board/);
    await expect(setEpicTickets(t.db, b, bEpic.id, { remove: [aTicket.id] }, ADA)).rejects.toThrow(/aren't on this board/);
    // A's epic from B is not found, even with B's own tickets.
    expect(await setEpicTickets(t.db, b, aEpic.id, { add: [bTicket.id] }, ADA)).toBeNull();
    expect([await snapshot(a), await snapshot(b)]).toEqual(before);
  });

  it("never adds to a completed or archived epic (Ask Lou did), and still lets tickets out of one", async () => {
    const co = tenant();
    const ticket = await intake(co);
    const extra = await intake(co);
    const epic = await epicOf(co);
    await setEpicTickets(t.db, co, epic.id, { add: [ticket.id] }, ADA);
    await setEpicStatus(t.db, co, epic.id, "completed");
    await expect(setEpicTickets(t.db, co, epic.id, { add: [extra.id] }, ADA)).rejects.toThrow("This epic is completed. Reopen it before adding tickets.");
    await setEpicStatus(t.db, co, epic.id, "archived");
    await expect(setEpicTickets(t.db, co, epic.id, { add: [extra.id] }, ADA)).rejects.toThrow("This epic is archived. Restore it before adding tickets.");
    expect(await setEpicTickets(t.db, co, epic.id, { remove: [ticket.id] }, ADA)).toMatchObject({ removed: 1 });
  });

  it("groups a ticket on the epic's page in the bucket its progress counts it in, archived tickets included", async () => {
    const co = tenant();
    await createStatus(t.db, co, { label: "Waiting on customer", isWaiting: true });
    await createStatus(t.db, co, { label: "Shipped", isTerminal: true });
    const epic = await epicOf(co);
    const tickets = [await intake(co), await intake(co), await intake(co), await intake(co), await intake(co)];
    await setEpicTickets(t.db, co, epic.id, { add: tickets.map((x) => x.id) }, ADA);
    await moveTicket(t.db, co, { ticketId: tickets[1]!.id, statusKey: "in_progress" });
    await moveTicket(t.db, co, { ticketId: tickets[2]!.id, statusKey: "waiting_on_customer" });
    await moveTicket(t.db, co, { ticketId: tickets[3]!.id, statusKey: "shipped" });
    await moveTicket(t.db, co, { ticketId: tickets[4]!.id, statusKey: "resolved" });
    await archiveTicket(t.db, co, { ticketId: tickets[4]!.id, archivedBy: "Ada" });
    const detail = (await getEpic(t.db, co, epic.id))!;
    expect(detail.progress).toEqual({ total: 5, done: 2, inProgress: 1, waiting: 1, open: 1, percent: 40, allDone: false });
    const bucketOf = (id: string) => detail.tickets.find((x) => x.id === id)?.bucket;
    expect(tickets.map((x) => bucketOf(x.id))).toEqual(["open", "in_progress", "waiting", "done", "done"]);
    // The list and the page are the same numbers.
    expect((await listEpics(t.db, co)).find((x) => x.id === epic.id)?.progress).toEqual(detail.progress);
    expect(detail.tickets.find((x) => x.id === tickets[3]!.id)?.statusLabel).toBe("Shipped");
    expect(detail.tickets.find((x) => x.id === tickets[4]!.id)?.archivedAt).not.toBeNull();
  });
});

describe("deleting an epic", () => {
  it("is never refused for holding tickets: they stay, archived ones too, out of the epic, each with a trail line", async () => {
    const co = tenant();
    const epic = await epicOf(co, "Old idea");
    const live = await intake(co);
    const shelved = await intake(co);
    await setEpicTickets(t.db, co, epic.id, { add: [live.id, shelved.id] }, ADA);
    await archiveTicket(t.db, co, { ticketId: shelved.id, archivedBy: "Ada" });
    expect(await deleteEpic(t.db, tenant(), epic.id, ADA)).toBeNull();
    expect(await deleteEpic(t.db, co, epic.id, { id: "u-bo", name: "Bo" })).toEqual({ deleted: true, detached: 2 });
    expect(await findEpic(t.db, co, epic.id)).toBeNull();
    const rows = await rowsOf(sql`select id, epic_id, archived_at from feedback_tickets where tenant_id = ${co} order by id`);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.epic_id === null)).toBe(true);
    for (const id of [live.id, shelved.id]) {
      expect((await listTicketEvents(t.db, co, id)).filter((e) => e.kind === "epic").at(-1)).toMatchObject({ fromValue: "Old idea", toValue: null, actorName: "Bo" });
    }
  });
});

describe("the automatic start, and no automatic finish", () => {
  it("starts an epic the moment one of its tickets leaves the landing column, whatever that column is called", async () => {
    const co = tenant();
    await ensureFeedbackBoard(t.db, co);
    // A "Triage" column put first: new tickets land THERE now, and "open" is
    // just another column. Ask Lou compared against the words "open" and
    // "submitted", so moving a ticket into "open" never started its epic.
    const triage = await createStatus(t.db, co, { label: "Triage" });
    await reorderStatuses(t.db, co, [triage.id, ...(await listStatuses(t.db, co)).filter((s) => s.id !== triage.id).map((s) => s.id)]);
    const epic = await epicOf(co);
    const ticket = await intake(co);
    expect((await listBoardData(t.db, co)).tickets[0]?.status).toBe("triage");
    await setEpicTickets(t.db, co, epic.id, { add: [ticket.id] }, ADA);
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("open");
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: "open" });
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("in_progress");
  });

  it("starts from a bulk move, from a ticket filed straight into a later column, and from an under-way ticket put in", async () => {
    const co = tenant();
    const bulk = await epicOf(co, "Bulk");
    const tickets = [await intake(co), await intake(co)];
    await setEpicTickets(t.db, co, bulk.id, { add: tickets.map((x) => x.id) }, ADA);
    await moveTickets(t.db, co, { ticketIds: tickets.map((x) => x.id), statusKey: "in_progress" });
    expect((await findEpic(t.db, co, bulk.id))?.status).toBe("in_progress");

    const filed = await epicOf(co, "Filed");
    await createStaffTicket(t.db, co, { title: "Already under way", status: "in_progress", epicId: filed.id }, ADA);
    expect((await findEpic(t.db, co, filed.id))?.status).toBe("in_progress");

    const joined = await epicOf(co, "Joined");
    const moving = await intake(co);
    await moveTicket(t.db, co, { ticketId: moving.id, statusKey: "in_progress" });
    await updateTicket(t.db, co, { ticketId: moving.id, epicId: joined.id }, ADA);
    expect((await findEpic(t.db, co, joined.id))?.status).toBe("in_progress");

    const viaDelete = await epicOf(co, "Via a column delete");
    const doomed = await createStatus(t.db, co, { label: "Doomed" });
    const inDoomed = await createStaffTicket(t.db, co, { title: "In a column about to go", status: doomed.key }, ADA);
    // Put in while sitting in a later column: started already. Reopen it, then delete the column to move it.
    await updateTicket(t.db, co, { ticketId: inDoomed.id, epicId: viaDelete.id }, ADA);
    await setEpicStatus(t.db, co, viaDelete.id, "open");
    await deleteStatus(t.db, co, doomed.id, { moveTo: "in_progress" });
    expect((await findEpic(t.db, co, viaDelete.id))?.status).toBe("in_progress");
  });

  it("doesn't start for a ticket still in the landing column, nor for an archived one; never completes; never touches a finished epic", async () => {
    const co = tenant();
    const epic = await epicOf(co);
    const waiting = await intake(co);
    const shelved = await intake(co);
    await moveTicket(t.db, co, { ticketId: shelved.id, statusKey: "resolved" });
    await archiveTicket(t.db, co, { ticketId: shelved.id, archivedBy: "Ada" });
    await setEpicTickets(t.db, co, epic.id, { add: [waiting.id, shelved.id] }, ADA);
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("open");
    // Every ticket finished: the epic says so, and stays in progress.
    await moveTicket(t.db, co, { ticketId: waiting.id, statusKey: "resolved" });
    const detail = (await getEpic(t.db, co, epic.id))!;
    expect(detail.status).toBe("in_progress");
    expect(detail.progress.allDone).toBe(true);
    // A completed epic stays completed when its ticket moves again.
    await setEpicStatus(t.db, co, epic.id, "completed");
    await moveTicket(t.db, co, { ticketId: waiting.id, statusKey: "in_progress" });
    expect((await findEpic(t.db, co, epic.id))?.status).toBe("completed");
  });
});

describe("a ticket's own epic", () => {
  it("is set and cleared from the editor, with the trail; refused for another company's epic or a finished one, unless it's already there", async () => {
    const co = tenant();
    const other = tenant();
    const ticket = await intake(co);
    const epic = await epicOf(co, "Mine");
    const theirs = await epicOf(other, "Theirs");
    const before = await snapshot(co);
    await expect(updateTicket(t.db, co, { ticketId: ticket.id, epicId: theirs.id, priority: "high" }, ADA)).rejects.toThrow(/isn't on this board/);
    // Refused before anything was written: the priority didn't change either.
    expect(await snapshot(co)).toBe(before);
    expect(await updateTicket(t.db, co, { ticketId: ticket.id, epicId: epic.id }, ADA)).toEqual({ updated: true, changed: ["epic"] });
    await setEpicStatus(t.db, co, epic.id, "completed");
    // Staying in a completed epic is fine; joining one isn't.
    expect(await updateTicket(t.db, co, { ticketId: ticket.id, epicId: epic.id, priority: "low" }, ADA)).toEqual({ updated: true, changed: ["priority"] });
    const second = await intake(co);
    await expect(updateTicket(t.db, co, { ticketId: second.id, epicId: epic.id }, ADA)).rejects.toThrow(/completed/);
    await expect(createStaffTicket(t.db, co, { title: "Into a finished epic", epicId: epic.id }, ADA)).rejects.toThrow(/completed/);
    await expect(createStaffTicket(t.db, co, { title: "Into another company's epic", epicId: theirs.id }, ADA)).rejects.toThrow(/isn't on this board/);
    expect(await updateTicket(t.db, co, { ticketId: ticket.id, epicId: null }, ADA)).toEqual({ updated: true, changed: ["epic"] });
    expect((await listTicketEvents(t.db, co, ticket.id)).filter((e) => e.kind === "epic").map((e) => [e.fromValue, e.toValue])).toEqual([
      [null, "Mine"],
      ["Mine", null],
    ]);
  });
});

describe("the board: the badge's data, the Epic filter and its counts", () => {
  it("carries each card's epic and the company's epics; filters by epic and by No epic, AND-ed with the rest; counts with the other filters on", async () => {
    const co = tenant();
    const other = tenant();
    const epic = await epicOf(co, "Badge me");
    const otherEpic = await epicOf(other, "Somebody else's");
    const inEpic = await intake(co, "In the epic and urgent enough to matter.");
    const loose = await intake(co, "Not in any epic but still a real report.");
    await setEpicTickets(t.db, co, epic.id, { add: [inEpic.id] }, ADA);
    await updateTicket(t.db, co, { ticketId: inEpic.id, priority: "critical" }, ADA);

    const board = await listBoardData(t.db, co);
    expect(board.epics).toEqual([{ id: epic.id, name: "Badge me", color: "blue", status: "open" }]);
    expect(board.tickets.find((x) => x.id === inEpic.id)?.epicId).toBe(epic.id);
    expect(board.tickets.find((x) => x.id === loose.id)?.epicId).toBeNull();
    expect(board.facets.epic).toEqual({ [epic.id]: 1, [FILTER_NONE]: 1 });

    expect((await listBoardData(t.db, co, { filters: { epic: [epic.id] } })).tickets.map((x) => x.id)).toEqual([inEpic.id]);
    expect((await listBoardData(t.db, co, { filters: { epic: [FILTER_NONE] } })).tickets.map((x) => x.id)).toEqual([loose.id]);
    expect((await listBoardData(t.db, co, { filters: { epic: [epic.id, FILTER_NONE] } })).tickets).toHaveLength(2);
    expect((await listBoardData(t.db, co, { filters: { epic: [epic.id], priority: ["low"] } })).tickets).toEqual([]);
    // Counts: each epic's number with every OTHER filter on.
    expect((await listBoardData(t.db, co, { filters: { priority: ["critical"] } })).facets.epic).toEqual({ [epic.id]: 1 });
    // Another company's epic id matches nothing here, and its epics aren't listed.
    expect((await listBoardData(t.db, co, { filters: { epic: [otherEpic.id] } })).tickets).toEqual([]);
    expect((await listBoardData(t.db, other)).epics.map((x) => x.name)).toEqual(["Somebody else's"]);
    // The address bar carries it under the same name.
    expect(filtersFromSearchParams(new URLSearchParams(`epic=${epic.id}&epic=${FILTER_NONE}`)).epic).toEqual([epic.id, FILTER_NONE]);
  });
});

describe("company B gets nothing of A's epics", () => {
  it("every read and write of A's epic id from B is not found, and A's rows don't move", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const aEpic = await epicOf(a, "Alpha secret plan");
    const aTicket = await intake(a);
    await setEpicTickets(t.db, a, aEpic.id, { add: [aTicket.id] }, ADA);
    const before = await snapshot(a);
    expect(await findEpic(t.db, b, aEpic.id)).toBeNull();
    expect(await getEpic(t.db, b, aEpic.id)).toBeNull();
    expect(await listEpics(t.db, b)).toEqual([]);
    expect(await updateEpic(t.db, b, aEpic.id, { name: "Mine now" })).toBeNull();
    expect(await setEpicStatus(t.db, b, aEpic.id, "archived")).toBeNull();
    expect(await setEpicTickets(t.db, b, aEpic.id, { remove: [aTicket.id] }, ADA)).toBeNull();
    expect(await deleteEpic(t.db, b, aEpic.id, ADA)).toBeNull();
    expect(await snapshot(a)).toBe(before);
  });
});

describe("the epic routes", () => {
  const people = (tenantId: string) => [{ id: `person-of-${tenantId}`, name: `Person of ${tenantId}` }];
  function handlers(asked: string[] = [], refuse: (permission: string) => boolean = () => false) {
    return createFeedbackAdminHandlers({
      db: t.db,
      resolveTenant: (req) => /\/api\/app\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname)?.[1] ?? null,
      authorize: (_req, permission, tenantId) => {
        asked.push(permission);
        if (refuse(permission)) return false;
        return { userId: `user-of-${tenantId}` };
      },
      staffName: () => "Ada",
      listPeople: (tenantId) => people(tenantId),
    });
  }
  const call = (handle: (req: Request) => Promise<Response>, tenantId: string, path: string, body?: unknown) =>
    handle(
      new Request(`http://localhost/api/app/${tenantId}/feedback/v1/admin/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it("make, read, edit, move along, fill and delete an epic — each asking the board's own key", async () => {
    const co = tenant();
    const asked: string[] = [];
    const { handle } = handlers(asked);
    const ticket = await intake(co);
    const made = await call(handle, co, "epics", { name: "From the routes", ownerId: `person-of-${co}`, targetDate: "2026-12-24", color: "green" });
    expect(made.status).toBe(201);
    const epic = ((await made.json()) as { epic: { id: string; ownerName: string } }).epic;
    expect(epic.ownerName).toBe(`Person of ${co}`);
    expect((await call(handle, co, `epics/${epic.id}/tickets`, { add: [ticket.id] })).status).toBe(200);
    const listed = (await (await call(handle, co, "epics")).json()) as { epics: Array<{ id: string; progress: { total: number } }> };
    expect(listed.epics.map((x) => [x.id, x.progress.total])).toEqual([[epic.id, 1]]);
    const got = (await (await call(handle, co, `epics/${epic.id}`)).json()) as { epic: { tickets: Array<{ id: string }> } };
    expect(got.epic.tickets.map((x) => x.id)).toEqual([ticket.id]);
    expect((await call(handle, co, `epics/${epic.id}`, { description: "Notes", ownerId: null })).status).toBe(200);
    const refused = await call(handle, co, `epics/${epic.id}/status`, { status: "completed" });
    expect(refused.status).toBe(200);
    const back = await call(handle, co, `epics/${epic.id}/status`, { status: "archived" });
    expect(back.status).toBe(200);
    const notAllowed = await call(handle, co, `epics/${epic.id}/status`, { status: "in_progress" });
    expect(notAllowed.status).toBe(409);
    expect(((await notAllowed.json()) as { error: { message: string } }).error.message).toMatch(/only be restored/);
    const gone = await call(handle, co, `epics/${epic.id}/delete`, {});
    expect(await gone.json()).toEqual({ deleted: true, detached: 1 });
    expect(asked).toEqual([
      "feedback.manage",
      "feedback.manage",
      "feedback.view",
      "feedback.view",
      "feedback.manage",
      "feedback.manage",
      "feedback.manage",
      "feedback.manage",
      "feedback.manage",
    ]);
  });

  it("refuses, in plain words and before writing, A's ticket into B's epic, A's person as B's owner, A's epic on B's ticket", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const { handle } = handlers();
    const aTicket = await intake(a, "Alpha's ticket that Bravo must never move.");
    const aEpic = await epicOf(a, "Alpha epic");
    await setEpicTickets(t.db, a, aEpic.id, { add: [aTicket.id] }, ADA);
    const bTicket = await intake(b);
    const bEpic = await epicOf(b, "Bravo epic");
    const before = [await snapshot(a), await snapshot(b)];

    const intoMine = await call(handle, b, `epics/${bEpic.id}/tickets`, { add: [aTicket.id] });
    expect(intoMine.status).toBe(400);
    expect(await intoMine.text()).not.toContain(aTicket.id);
    const owner = await call(handle, b, `epics/${bEpic.id}`, { ownerId: `person-of-${a}` });
    expect(owner.status).toBe(400);
    const made = await call(handle, b, "epics", { name: "With A's person", ownerId: `person-of-${a}` });
    expect(made.status).toBe(400);
    const onTicket = await call(handle, b, `tickets/${bTicket.id}`, { epicId: aEpic.id });
    expect(onTicket.status).toBe(400);
    const filed = await call(handle, b, "tickets", { title: "Into A's epic", epicId: aEpic.id });
    expect(filed.status).toBe(400);
    // A's epic in B's path: not found, whatever the body says.
    for (const [path, body] of [
      [`epics/${aEpic.id}`, undefined],
      [`epics/${aEpic.id}`, { name: "x", ownerId: `person-of-${a}` }],
      [`epics/${aEpic.id}/status`, { status: "completed" }],
      [`epics/${aEpic.id}/tickets`, { remove: [aTicket.id] }],
      [`epics/${aEpic.id}/delete`, {}],
    ] as const) {
      const res = await call(handle, b, path, body);
      expect([res.status, ((await res.json()) as { error?: { code?: string } }).error?.code], path).toEqual([404, "not_found"]);
    }
    expect([await snapshot(a), await snapshot(b)]).toEqual(before);
  });

  it("a company whose plan ended keeps reading its epics and can't change them (the seam refuses feedback.manage)", async () => {
    const co = tenant();
    const epic = await epicOf(co, "Read only now");
    const { handle } = handlers([], (permission) => permission !== "feedback.view");
    expect((await call(handle, co, "epics")).status).toBe(200);
    expect((await call(handle, co, `epics/${epic.id}`)).status).toBe(200);
    for (const [path, body] of [
      ["epics", { name: "New" }],
      [`epics/${epic.id}`, { name: "Renamed" }],
      [`epics/${epic.id}/status`, { status: "completed" }],
      [`epics/${epic.id}/tickets`, { add: [] }],
      [`epics/${epic.id}/delete`, {}],
    ] as const) {
      expect((await call(handle, co, path, body)).status, path).toBe(403);
    }
    expect((await findEpic(t.db, co, epic.id))?.name).toBe("Read only now");
  });

  it("works on the platform's own board ('*') too", async () => {
    const asked: string[] = [];
    const { handle } = createFeedbackAdminHandlers({
      db: t.db,
      tenantId: FEEDBACK_PLATFORM_BOARD,
      authorize: (_req, permission) => {
        asked.push(permission);
        return { userId: "staff-1" };
      },
      listPeople: () => [{ id: "staff-1", name: "Sam Staff" }],
    });
    const ticket = await intake(FEEDBACK_PLATFORM_BOARD);
    const made = await handle(
      new Request("http://localhost/api/admin/feedback/v1/admin/epics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Site epic ${tenant()}`, ownerId: "staff-1" }),
      }),
    );
    expect(made.status).toBe(201);
    const epic = ((await made.json()) as { epic: { id: string } }).epic;
    const filled = await handle(
      new Request(`http://localhost/api/admin/feedback/v1/admin/epics/${epic.id}/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ add: [ticket.id] }),
      }),
    );
    expect(await filled.json()).toEqual({ added: 1, movedFromOther: 0, removed: 0 });
    expect((await findEpic(t.db, FEEDBACK_PLATFORM_BOARD, epic.id))?.ownerName).toBe("Sam Staff");
  });
});

describe("waiting columns", () => {
  it("are a column flag: off by default, set on create and edit, and what progress counts as waiting", async () => {
    const co = tenant();
    const column = await createStatus(t.db, co, { label: "With the supplier" });
    expect(column.isWaiting).toBe(false);
    await updateStatus(t.db, co, { id: column.id, isWaiting: true });
    expect((await listStatuses(t.db, co)).find((s) => s.id === column.id)?.isWaiting).toBe(true);
    const epic = await epicOf(co);
    const ticket = await intake(co);
    await setEpicTickets(t.db, co, epic.id, { add: [ticket.id] }, ADA);
    await moveTicket(t.db, co, { ticketId: ticket.id, statusKey: column.key });
    expect((await getEpic(t.db, co, epic.id))?.progress).toMatchObject({ waiting: 1, total: 1 });
  });
});

describe("sql/upgrade-0.11-to-0.12.sql", () => {
  const read = (name: string) => readFileSync(join(__dirname, "..", "..", "sql", name), "utf8");
  async function columnsOf(client: { query: (q: string) => Promise<{ rows: unknown[] }> }, table: string): Promise<string[]> {
    const result = await client.query(`select column_name from information_schema.columns where table_name = '${table}' order by column_name`);
    return (result.rows as Array<{ column_name: string }>).map((row) => row.column_name);
  }
  async function indexesOf(client: { query: (q: string) => Promise<{ rows: unknown[] }> }, table: string): Promise<string[]> {
    const result = await client.query(`select indexname from pg_indexes where tablename = '${table}' order by indexname`);
    return (result.rows as Array<{ indexname: string }>).map((row) => row.indexname);
  }

  it("brings a 0.11 install to the schema, keeps every ticket and column as it was, runs twice, and 0.12 works on it", async () => {
    const fromSchema = await createTestDb();
    const old = await createTestDb({ sql: [read("feedback-0.11.0.sql")] });
    await old.client.exec(`insert into feedback_statuses (id, tenant_id, key, label, sort_order) values ('s1', 'co-a', 'open', 'Open', 10), ('s2', 'co-a', 'done', 'Done', 20)`);
    await old.client.exec(`update feedback_statuses set is_terminal = true where id = 's2'`);
    await old.client.exec(`insert into feedback_boards (tenant_id) values ('co-a')`);
    await old.client.exec(
      `insert into feedback_tickets (id, tenant_id, ticket_number, title, description, status) values ('t1', 'co-a', 'FB-00001', 'Old one', 'Old one, long enough', 'open')`,
    );
    const upgrade = read("upgrade-0.11-to-0.12.sql");
    await old.client.exec(upgrade);
    await old.client.exec(upgrade);
    for (const table of ["feedback_statuses", "feedback_tickets", "feedback_epics"]) {
      expect(await columnsOf(old.client, table), table).toEqual(await columnsOf(fromSchema.client, table));
      expect((await indexesOf(old.client, table)).filter((n) => !n.endsWith("_pkey")), table).toEqual(
        (await indexesOf(fromSchema.client, table)).filter((n) => !n.endsWith("_pkey")),
      );
    }
    // A ticket's epic is a foreign key, cleared when the epic goes (review L2), as the schema has it.
    const epicKey = async (client: { query: (q: string) => Promise<{ rows: unknown[] }> }) =>
      (await client.query(`select conname, confdeltype from pg_constraint where conname = 'feedback_tickets_epic_id_feedback_epics_id_fk'`)).rows;
    expect(await epicKey(old.client)).toEqual([{ conname: "feedback_tickets_epic_id_feedback_epics_id_fk", confdeltype: "n" }]);
    expect(await epicKey(fromSchema.client)).toEqual(await epicKey(old.client));
    const board = await listBoardData(old.db, "co-a");
    expect(board.tickets.map((x) => [x.ticketNumber, x.epicId])).toEqual([["FB-00001", null]]);
    expect(board.statuses.map((s) => [s.key, s.isWaiting])).toEqual([
      ["open", false],
      ["done", false],
    ]);
    const epic = await createEpic(old.db, "co-a", { name: "After the upgrade" }, ADA);
    await setEpicTickets(old.db, "co-a", epic.id, { add: ["t1"] }, ADA);
    await moveTicket(old.db, "co-a", { ticketId: "t1", statusKey: "done" });
    expect((await getEpic(old.db, "co-a", epic.id))?.progress).toMatchObject({ allDone: true, percent: 100 });
    expect((await findEpic(old.db, "co-a", epic.id))?.status).toBe("in_progress" satisfies EpicStatus);
    await fromSchema.close();
    await old.close();
  });

  it("stops with a sentence on a 0.10 database (its upgrade comes first) and on an empty one", async () => {
    const v010 = await createTestDb({ sql: [read("feedback-0.10.0.sql")] });
    await expect(v010.client.exec(read("upgrade-0.11-to-0.12.sql"))).rejects.toThrow(/0\.10 database/);
    await v010.close();
    const empty = await createTestDb({ sql: [] });
    await expect(empty.client.exec(read("upgrade-0.11-to-0.12.sql"))).rejects.toThrow(/no feedback tables to upgrade/);
    await empty.close();
    expect(schemaDdl().some((statement) => statement.includes('"feedback_epics"'))).toBe(true);
  });
});
