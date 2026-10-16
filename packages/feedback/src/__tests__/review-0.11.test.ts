import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignTicket,
  createCategory,
  createFeedbackAdminHandlers,
  createFeedbackHandlers,
  createStaffTicket,
  createStatus,
  createTicket,
  deleteCategory,
  deleteStatus,
  ensureFeedbackBoard,
  feedbackReporterEmailFor,
  FEEDBACK_EMAIL_TEMPLATES,
  FILTER_NONE,
  issueClientKey,
  CLIENT_KEY_HEADER,
  linkTypedAssignees,
  listBoardData,
  listCategories,
  listStatuses,
  moveTicket,
  namedAssignee,
  submitPayloadSchema,
  updateStatus,
  updateCategory,
  DuplicateKeyError,
  type FeedbackEvent,
} from "../index.js";
import { createTestDb, report, tenant, type TestDb } from "./pglite.js";

/**
 * The independent review of 0.11.0, finding by finding. Each test fails on
 * the code before its fix.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ADA = { id: "u-ada", name: "Ada Tech" };
const intake = (tenantId: string, text: string, extra: Record<string, unknown> = {}) =>
  createTicket(t.db, { tenantId, payload: submitPayloadSchema.parse(report(text, extra)) });

function handlers(people: Record<string, Array<{ id: string; name: string }>>, events: FeedbackEvent[] = []) {
  return createFeedbackAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\/feedback\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: () => ({ userId: ADA.id }),
    staffName: () => ADA.name,
    listPeople: (tenantId) => people[tenantId] ?? [],
    onEvent: (event) => void events.push(event),
  });
}
const call = (h: ReturnType<typeof handlers>, co: string, method: "GET" | "POST", path: string, body?: unknown) =>
  h.handle(
    new Request(`http://localhost/api/app/${co}/feedback/v1/admin/${path}`, {
      method,
      headers: { "sec-fetch-site": "same-origin", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    }),
  );

describe("HIGH 1: the Assigned-to counts equal what ticking gives, typed names included", () => {
  it("every assignee choice's count is exactly its filter's result", async () => {
    const co = tenant("counts");
    await intake(co, "Nobody has this one yet");
    await intake(co, "Nobody has this one either");
    const typed = await intake(co, "Assigned by a typed name in 0.10");
    await assignTicket(t.db, co, { ticketId: typed.id, assignee: "Old Typed Name", actorName: "Ada" });
    await createStaffTicket(t.db, co, { title: "Ada's", assignee: ADA }, ADA);
    const board = await listBoardData(t.db, co);
    expect(board.facets.assignee).toEqual({ [FILTER_NONE]: 2, [namedAssignee("Old Typed Name")]: 1, [ADA.id]: 1 });
    for (const [value, n] of Object.entries(board.facets.assignee)) {
      const result = await listBoardData(t.db, co, { filters: { assignee: [value] } });
      expect([value, result.matchCount, result.tickets.length]).toEqual([value, n, n]);
    }
    // The counts add up to the board.
    expect(Object.values(board.facets.assignee).reduce((a, b) => a + b, 0)).toBe(board.totalCount);
  });

  it("links a typed name to the one person with that name; leaves a name nobody or two people have; touches no other company", async () => {
    const a = tenant("link-a");
    const b = tenant("link-b");
    const one = await intake(a, "Typed as Ada, who is on the team");
    const two = await intake(a, "Typed as Sam, and two people are Sam");
    const three = await intake(a, "Typed as a name nobody has");
    const theirs = await intake(b, "Company B's ticket, also typed as Ada");
    for (const [co, id, name] of [
      [a, one.id, "ada tech"],
      [a, two.id, "Sam"],
      [a, three.id, "Ghost"],
      [b, theirs.id, "Ada Tech"],
    ] as const) {
      await assignTicket(t.db, co, { ticketId: id, assignee: name, actorName: "x" });
    }
    const people = [ADA, { id: "u-sam1", name: "Sam" }, { id: "u-sam2", name: "Sam" }];
    expect(await linkTypedAssignees(t.db, a, people)).toEqual({ linked: 1 });
    const cards = new Map((await listBoardData(t.db, a)).tickets.map((x) => [x.id, x]));
    expect([cards.get(one.id)?.assigneeId, cards.get(one.id)?.assignee]).toEqual([ADA.id, "Ada Tech"]);
    expect(cards.get(two.id)?.assigneeId).toBeNull();
    expect(cards.get(three.id)?.assigneeId).toBeNull();
    // Company B's identical name was not linked to company A's person.
    expect((await listBoardData(t.db, b)).tickets[0]?.assigneeId).toBeNull();
    // "Mine" now finds the linked one.
    expect((await listBoardData(t.db, a, { filters: { assignee: ["__me"] }, viewerId: ADA.id })).tickets.map((x) => x.id)).toEqual([one.id]);
  });

  it("the board route links once, with the host's people for THAT company", async () => {
    const co = tenant("link-route");
    const typed = await intake(co, "Typed before 0.11 as Ada Tech");
    await assignTicket(t.db, co, { ticketId: typed.id, assignee: "Ada Tech", actorName: "x" });
    const h = handlers({ [co]: [ADA] });
    const board = (await (await call(h, co, "GET", "board")).json()) as { tickets: Array<{ assigneeId: string | null }>; facets: { assignee: Record<string, number> } };
    expect(board.tickets[0]?.assigneeId).toBe(ADA.id);
    expect(board.facets.assignee).toEqual({ [ADA.id]: 1 });
  });
});

describe("MEDIUM 2: a ticket the team filed for a customer", () => {
  const ctx = { businessName: "Green Acres", feedbackUrl: "https://green.test/t/green/feedback" };

  it("emails nobody unless the team chose to tell them", async () => {
    const co = tenant("tell-no");
    const events: FeedbackEvent[] = [];
    const h = handlers({}, events);
    const made = (await (await call(h, co, "POST", "tickets", { title: "Call Mrs Jones about the gutter quote", reporterName: "Mrs Jones", reporterEmail: "jones@example.test" })).json()) as {
      ticket: { id: string };
    };
    expect((await call(h, co, "POST", `tickets/${made.ticket.id}/move`, { status: "in_progress" })).status).toBe(200);
    expect((await call(h, co, "POST", `tickets/${made.ticket.id}/messages`, { body: "We'll come Tuesday." })).status).toBe(201);
    expect(events.map((e) => e.type)).toEqual(["ticket.moved", "staff.replied"]);
    for (const event of events) expect(feedbackReporterEmailFor(event, ctx)).toBeNull();
  });

  it("when told, words it for a request the team opened: no 'My reports', no 'your feedback', not the team's own title", async () => {
    const co = tenant("tell-yes");
    const events: FeedbackEvent[] = [];
    const h = handlers({}, events);
    const made = (await (
      await call(h, co, "POST", "tickets", {
        title: "Call Mrs Jones about the gutter quote",
        reporterName: "Mrs Jones",
        reporterEmail: "jones@example.test",
        tellReporter: true,
      })
    ).json()) as { ticket: { id: string } };
    await call(h, co, "POST", `tickets/${made.ticket.id}/move`, { status: "in_progress" });
    await call(h, co, "POST", `tickets/${made.ticket.id}/messages`, { body: "We'll come Tuesday." });
    const emails = events.map((e) => feedbackReporterEmailFor(e, ctx));
    expect(emails.map((e) => e?.templateKey)).toEqual(["feedback_team_ticket_status", "feedback_team_ticket_reply"]);
    for (const email of emails) {
      const template = FEEDBACK_EMAIL_TEMPLATES.find((x) => x.key === email!.templateKey)!;
      const text = `${template.subject}\n${template.body}`;
      expect(text).not.toMatch(/My reports|your feedback|\{\{title\}\}/i);
      expect(text.toLowerCase()).toContain("reply to this email");
      expect(email!.to).toBe("jones@example.test");
    }
    // A report from the feedback form still gets its usual emails.
    const reported = await intake(co, "From the form, with an address", { reporter: { name: "Pat", email: "pat@example.test" } });
    await call(h, co, "POST", `tickets/${reported.id}/move`, { status: "closed" });
    expect(feedbackReporterEmailFor(events.at(-1)!, ctx)?.templateKey).toBe("feedback_status_changed");
  });
});

describe("MEDIUM 3: a taken short name never refuses a new name", () => {
  it("renaming to another column's or category's name is refused; any other name is fine", async () => {
    const co = tenant("rename");
    await ensureFeedbackBoard(t.db, co);
    const open = (await listStatuses(t.db, co)).find((s) => s.key === "open")!;
    await updateStatus(t.db, co, { id: open.id, label: "New" });
    // The short name "open" is still taken by the column now called New.
    expect((await createStatus(t.db, co, { key: "open", label: "Open" })).key).toBe("open_2");
    await expect(updateStatus(t.db, co, { id: open.id, label: "in progress" })).rejects.toBeInstanceOf(DuplicateKeyError);
    const bug = (await listCategories(t.db, co)).find((c) => c.key === "bug")!;
    await expect(updateCategory(t.db, co, { id: bug.id, label: "Question" })).rejects.toBeInstanceOf(DuplicateKeyError);
    // And through the route: 201, not "already has a column with that name".
    const h = handlers({});
    const res = await call(h, co, "POST", "columns", { key: "new", label: "Brand new" });
    expect(res.status).toBe(201);
  });
});

describe("LOW 6: unstorable input is a plain 400, never a 500", () => {
  it("refuses NUL characters and dates the database can't hold, on the board, New ticket, editing and the intake", async () => {
    const co = tenant("nul");
    const h = handlers({});
    const ticket = await intake(co, "A ticket to try editing");
    const bad: Array<[string, Promise<Response>]> = [
      ["q", call(h, co, "GET", `board?q=${encodeURIComponent("a\u0000b")}`)],
      ["status", call(h, co, "GET", `board?status=${encodeURIComponent("op\u0000en")}`)],
      ["assignee", call(h, co, "GET", `board?assignee=${encodeURIComponent("x\u0000")}`)],
      ["to", call(h, co, "GET", "board?to=9999-12-31")],
      ["from", call(h, co, "GET", "board?from=0000-01-01")],
      ["create title", call(h, co, "POST", "tickets", { title: "bad\u0000title" })],
      ["update title", call(h, co, "POST", `tickets/${ticket.id}`, { title: "bad\u0000title" })],
      ["reply", call(h, co, "POST", `tickets/${ticket.id}/messages`, { body: "bad\u0000reply" })],
    ];
    for (const [name, pending] of bad) {
      const res = await pending;
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect([name, res.status, body.error.code], body.error.message).toEqual([name, 400, "invalid"]);
      expect(body.error.message).toMatch(/can't be saved|Pick a date between/);
    }
    const key = await issueClientKey(t.db, { tenantId: co, label: "site" });
    const intakeRes = await createFeedbackHandlers({ db: t.db }).handle(
      new Request("http://localhost/api/igloo/v1/submit", {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: key.key, "content-type": "application/json" },
        body: JSON.stringify(report("A report with a \u0000 in it, long enough")),
      }),
    );
    expect(intakeRes.status).toBe(400);
  });
});

describe("LOW 8: the default columns and categories come once", () => {
  it("deleting every category leaves none; the last column can't be deleted", async () => {
    const co = tenant("once");
    await ensureFeedbackBoard(t.db, co);
    for (const category of await listCategories(t.db, co)) expect(await deleteCategory(t.db, co, category.id)).toEqual({ deleted: true });
    await listBoardData(t.db, co);
    await ensureFeedbackBoard(t.db, co);
    expect(await listCategories(t.db, co)).toEqual([]);
    const columns = await listStatuses(t.db, co);
    for (const column of columns.slice(1)) expect((await deleteStatus(t.db, co, column.id)).deleted).toBe(true);
    expect(await deleteStatus(t.db, co, columns[0]!.id)).toEqual({ deleted: false, reason: "last" });
    await listBoardData(t.db, co);
    expect((await listStatuses(t.db, co)).map((s) => s.key)).toEqual([columns[0]!.key]);
    // Another company's first visit still gets its defaults.
    expect((await ensureFeedbackBoard(t.db, tenant("fresh"))).categories).toBeGreaterThan(0);
  });
});

describe("LOW 9: moving tickets by deleting their column is announced like a drag", () => {
  it("emits ticket.moved for each moved ticket", async () => {
    const co = tenant("del-events");
    const events: FeedbackEvent[] = [];
    const h = handlers({}, events);
    const column = await createStatus(t.db, co, { label: "Later" });
    const one = await intake(co, "First one parked for later", { reporter: { email: "one@example.test" } });
    const two = await intake(co, "Second one parked for later");
    await moveTicket(t.db, co, { ticketId: one.id, statusKey: column.key });
    await moveTicket(t.db, co, { ticketId: two.id, statusKey: column.key });
    expect((await call(h, co, "POST", `columns/${column.id}/delete`, { moveTo: "open" })).status).toBe(200);
    const moved = events.filter((e): e is Extract<FeedbackEvent, { type: "ticket.moved" }> => e.type === "ticket.moved");
    expect(moved.map((e) => [e.ticketId, e.fromStatus, e.toStatus]).sort()).toEqual(
      [
        [one.id, column.key, "open"],
        [two.id, column.key, "open"],
      ].sort(),
    );
    expect(moved.find((e) => e.ticketId === one.id)?.reporterEmail).toBe("one@example.test");
  });
});

describe("LOW 10: New ticket checks the customer's email address", () => {
  it("refuses one that can't be written to, with a sentence", async () => {
    const co = tenant("email");
    const h = handlers({});
    const res = await call(h, co, "POST", "tickets", { title: "For a customer", reporterEmail: "not an address" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("That email address doesn't look right. Check it, or leave it empty.");
    expect((await call(h, co, "POST", "tickets", { title: "For a customer", reporterEmail: "ok@example.test" })).status).toBe(201);
    expect((await call(h, co, "POST", "tickets", { title: "No address", reporterEmail: "" })).status).toBe(201);
  });
});

describe("the shipped upgrade marks only boards that are already set up", () => {
  it("a 0.10 board with columns and categories never gets defaults back; one missing a list gets it once", async () => {
    const read = (name: string) => readFileSync(join(__dirname, "..", "..", "sql", name), "utf8");
    const old = await createTestDb({ sql: [read("feedback-0.10.0.sql")] });
    await old.client.exec(`insert into feedback_statuses (id, tenant_id, key, label) values ('s1', 'full', 'open', 'Open'), ('s2', 'half', 'open', 'Open')`);
    await old.client.exec(`insert into feedback_categories (id, tenant_id, key, label) values ('c1', 'full', 'mine', 'Mine')`);
    await old.client.exec(read("upgrade-0.10-to-0.11.sql"));
    expect(await ensureFeedbackBoard(old.db, "full")).toEqual({ statuses: 0, categories: 0 });
    expect((await ensureFeedbackBoard(old.db, "half")).categories).toBeGreaterThan(0);
    await old.close();
  });
});
