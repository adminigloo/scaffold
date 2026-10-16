// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  boardFilterFields,
  FeedbackBoard,
  FeedbackWorkspace,
  FILTER_NONE,
  NewTicketDialog,
  TicketPanel,
  type FeedbackColumnWire,
} from "../board.js";
import {
  AddTicketsDialog,
  EpicDialog,
  EpicList,
  epicStatusChoices,
  FeedbackEpic,
  FeedbackEpics,
  type FeedbackEpicDetailWire,
  type FeedbackEpicsTransport,
  type FeedbackEpicWire,
} from "../epics.js";
import { FeedbackAdminError, type FeedbackBoardWire } from "../board-client.js";
import { button, choose, click, fake, field, mount, settle, submit, text, type } from "./dom.js";

/**
 * 0.12.0's screens, in a DOM: the card shows its epic (Ask Lou's never did),
 * the panel's and New ticket's epic pickers (the ticket's own epic always
 * shown, finished or not; only live epics offered), the Epic filter with "No
 * epic", and the ./epics screens over a fake transport — the list, an epic's
 * page with its groups, the status picker that offers only allowed moves, the
 * "every ticket is done" question, taking tickets out, Delete that waits for
 * the answer, and "Add tickets" that says when a ticket moves from another
 * epic.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const COLUMNS: FeedbackColumnWire[] = [
  { id: "c1", key: "open", label: "Open", color: null, sortOrder: 10, isTerminal: false, wipLimit: null, agingWarnHours: null, agingStaleHours: null, allowAiTransition: false },
  { id: "c2", key: "done", label: "Done", color: null, sortOrder: 20, isTerminal: true, wipLimit: null, agingWarnHours: null, agingStaleHours: null, allowAiTransition: false },
];
const EPICS = [
  { id: "e1", name: "Checkout", color: "teal", status: "in_progress" as const },
  { id: "e2", name: "Old pricing", color: "red", status: "completed" as const },
  { id: "e3", name: "Spring list", color: "blue", status: "open" as const },
];
const ticket = (id: string, epicId: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  ticketNumber: `FB-0000${id.slice(1)}`,
  title: `Ticket ${id}`,
  priority: "medium",
  status: "open",
  epicId,
  createdAt: new Date().toISOString(),
  ...extra,
});
const PROGRESS = { total: 0, done: 0, inProgress: 0, waiting: 0, open: 0, percent: 0, allDone: false };

describe("the board shows each card's epic", () => {
  it("draws the epic's badge on its cards, and nothing on a card in no epic", async () => {
    const { container } = await mount(
      <FeedbackBoard statuses={COLUMNS} tickets={[ticket("t1", "e1"), ticket("t2", null)]} epics={EPICS} onMove={() => undefined} />,
    );
    const cards = [...container.querySelectorAll(".aib-card")];
    expect(text(cards[0]!.querySelector(".aib-epic-badge"))).toBe("Epic: Checkout");
    expect(cards[1]!.querySelector(".aib-epic-badge")).toBeNull();
  });

  it("names a finished epic as finished", async () => {
    const { container } = await mount(<FeedbackBoard statuses={COLUMNS} tickets={[ticket("t1", "e2")]} epics={EPICS} onMove={() => undefined} />);
    expect(text(container.querySelector(".aib-epic-badge"))).toBe("Epic: Old pricing · completed");
  });
});

describe("the ticket panel's epic", () => {
  const base = {
    messages: [],
    statuses: COLUMNS,
    currentUser: "Ada",
    onClose: () => undefined,
    onSend: () => undefined,
    onAssign: () => undefined,
    onMove: () => undefined,
  };

  it("offers the live epics, always shows the ticket's own (finished or not), and sends the choice", async () => {
    const patches: unknown[] = [];
    const { container } = await mount(
      <TicketPanel {...base} ticket={ticket("t1", "e2")} epics={EPICS} epicHref={(id) => `/epics/${id}`} onUpdate={(patch) => void patches.push(patch)} />,
    );
    const select = field<HTMLSelectElement>(container, "Epic")!;
    expect(select.value).toBe("e2");
    expect([...select.options].map((o) => o.textContent)).toEqual(["No epic", "Checkout", "Old pricing (completed)", "Spring list"]);
    // The badge links to the epic's page.
    expect(container.querySelector<HTMLAnchorElement>(".aib-panel-sub a")?.getAttribute("href")).toBe("/epics/e2");
    await choose(select, "e1");
    await choose(field(container, "Epic"), "");
    expect(patches).toEqual([{ epicId: "e1" }, { epicId: null }]);
  });

  it("doesn't offer a finished epic to a ticket that isn't in it, and reads the epic lines of the trail", async () => {
    const { container } = await mount(
      <TicketPanel
        {...base}
        ticket={ticket("t1", null)}
        epics={EPICS}
        onUpdate={() => undefined}
        events={[
          { id: "v1", kind: "epic", fromValue: null, toValue: "Checkout", actorName: "Ada", createdAt: new Date().toISOString() },
          { id: "v2", kind: "epic", fromValue: "Checkout", toValue: "Spring list", actorName: "Ben", createdAt: new Date().toISOString() },
          { id: "v3", kind: "epic", fromValue: "Spring list", toValue: null, actorName: "Cy", createdAt: new Date().toISOString() },
        ]}
      />,
    );
    expect([...field<HTMLSelectElement>(container, "Epic")!.options].map((o) => o.textContent)).toEqual(["No epic", "Checkout", "Spring list"]);
    const trail = [...container.querySelectorAll(".aib-activity li")].map((li) => text(li));
    expect(trail[0]).toContain("Ada put it in the epic Checkout");
    expect(trail[1]).toContain("Ben put it in the epic Spring list (was Checkout)");
    expect(trail[2]).toContain("Cy took it out of the epic Spring list");
  });
});

describe("New ticket's epic", () => {
  it("offers only epics still being worked on, and sends the one chosen", async () => {
    const sent: unknown[] = [];
    const { container } = await mount(
      <NewTicketDialog
        statuses={COLUMNS}
        epics={EPICS}
        onClose={() => undefined}
        onCreate={async (input) => {
          sent.push(input);
          return { id: "t9", ticketNumber: "FB-00009" };
        }}
      />,
    );
    const select = field<HTMLSelectElement>(container, "Epic")!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["No epic", "Checkout", "Spring list"]);
    await type(field(container, "Title"), "Card reader is slow");
    await choose(select, "e3");
    await submit(container.querySelector("form"));
    expect(sent).toEqual([expect.objectContaining({ title: "Card reader is slow", epicId: "e3" })]);
  });
});

describe("the Epic filter", () => {
  it("lists the live epics (and a finished one that still has tickets showing), then No epic, with counts", () => {
    const fields = boardFilterFields({
      statuses: COLUMNS,
      epics: [...EPICS, { id: "e4", name: "Shelved", status: "archived" }],
      facets: { epic: { e1: 3, e2: 1, [FILTER_NONE]: 5 } },
    });
    const epic = fields.find((f) => f.field === "epic")!;
    expect(epic.label).toBe("Epic");
    expect(epic.options).toEqual([
      { value: "e1", label: "Checkout", count: 3 },
      { value: "e2", label: "Old pricing (completed)", count: 1 },
      { value: "e3", label: "Spring list", count: 0 },
      { value: FILTER_NONE, label: "No epic", count: 5 },
    ]);
    // A board that has never had an epic has no Epic filter.
    expect(boardFilterFields({ statuses: COLUMNS }).some((f) => f.field === "epic")).toBe(false);
  });

  it("the workspace passes the board's epics to the cards, the filter and the panel, and links to the epics page", async () => {
    const board = {
      statuses: COLUMNS,
      tickets: [ticket("t1", "e1")],
      epics: EPICS,
      archivableCount: 0,
      totalCount: 1,
      matchCount: 1,
      truncated: false,
      facets: { status: {}, priority: {}, category: {}, assignee: {}, epic: { e1: 1 }, source: {} },
    };
    const client = fake<import("../board.js").FeedbackAdminClient>({
      board: () => board,
      categories: () => [],
      people: () => ({ people: [], me: null }),
    });
    const { container } = await mount(
      <FeedbackWorkspace baseUrl="/x" client={client.target} filterUrl={false} rememberFiltersAs={false} epicsHref="/app/feedback/epics" />,
    );
    expect(text(container.querySelector(".aib-card .aib-epic-badge"))).toBe("Epic: Checkout");
    expect([...container.querySelectorAll("a")].find((a) => text(a) === "Epics")?.getAttribute("href")).toBe("/app/feedback/epics");
    expect(button(container, "Epic")).not.toBeNull();
  });
});

function epicWire(extra: Partial<FeedbackEpicWire> = {}): FeedbackEpicWire {
  return {
    id: "e1",
    name: "Checkout",
    description: null,
    status: "in_progress",
    ownerId: "u1",
    ownerName: "Ada",
    targetDate: null,
    color: "teal",
    completedAt: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: PROGRESS,
    ...extra,
  };
}

function detailWire(extra: Partial<FeedbackEpicDetailWire> = {}): FeedbackEpicDetailWire {
  const tickets: FeedbackEpicDetailWire["tickets"] = [
    { id: "t1", ticketNumber: "FB-00001", title: "Card declined", status: "done", statusLabel: "Done", priority: "high", assignee: null, archivedAt: null, createdAt: "", bucket: "done" },
    { id: "t2", ticketNumber: "FB-00002", title: "Old receipt", status: "done", statusLabel: "Done", priority: "low", assignee: null, archivedAt: new Date().toISOString(), createdAt: "", bucket: "done" },
  ];
  return {
    ...epicWire(),
    progress: { total: 2, done: 2, inProgress: 0, waiting: 0, open: 0, percent: 100, allDone: true },
    tickets,
    truncated: false,
    ...extra,
  };
}

describe("./epics: the list", () => {
  it("shows each epic's name, status, owner, date and progress; the views count and filter", async () => {
    const today = new Date(2026, 9, 16);
    const epics = [
      epicWire({ targetDate: "2026-10-10", progress: { total: 8, done: 3, inProgress: 2, waiting: 1, open: 2, percent: 37, allDone: false } }),
      epicWire({ id: "e2", name: "Old pricing", status: "completed", ownerId: null, ownerName: null }),
    ];
    let view: "active" | "completed" | "archived" | "all" = "active";
    const { container, rerender } = await mount(
      <EpicList epics={epics} today={today} view={view} onViewChange={(next) => (view = next)} epicHref={(e) => `/epics/${e.id}`} />,
    );
    const rows = [...container.querySelectorAll(".aib-epic-row")];
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toContain("Checkout");
    expect(text(rows[0])).toContain("In progress");
    expect(text(rows[0])).toContain("Led by Ada");
    expect(text(rows[0])).toContain("6 days late");
    expect(text(rows[0])).toContain("3 of 8 done (37%)");
    expect(rows[0]!.querySelector(".aib-progress-bar")?.getAttribute("aria-label")).toBe("3 of 8 done (37%): 3 done, 2 in progress, 1 waiting, 2 not started");
    expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe("/epics/e1");
    expect(text(button(container, "Completed"))).toBe("Completed (1)");
    await click(button(container, "Completed"));
    expect(view).toBe("completed");
    await rerender(<EpicList epics={epics} today={today} view="completed" epicHref={(e) => `/epics/${e.id}`} />);
    expect(text(container.querySelector(".aib-epic-row"))).toContain("Led by nobody yet");
  });

  it("FeedbackEpics makes an epic, its owner the viewer unless they choose nobody", async () => {
    const transport = fake<FeedbackEpicsTransport>({
      epics: () => [],
      people: () => ({ people: [{ id: "u1", name: "Ada" }, { id: "u2", name: "Ben" }], me: "u1" }),
      createEpic: (input: { name: string }) => epicWire({ name: input.name }),
    });
    const { container } = await mount(<FeedbackEpics transport={transport.target} epicsHref="/app/feedback/epics" boardHref="/app/feedback" />);
    expect(text(container)).toContain("No epics yet");
    await click(button(container, "New epic"));
    const owner = field<HTMLSelectElement>(container, "Who leads it")!;
    expect(owner.value).toBe("u1");
    expect([...owner.options].map((o) => o.textContent)).toEqual(["Nobody yet", "Ada (you)", "Ben"]);
    await type(field(container, "Name"), "Gift cards");
    await click(button(container, "teal"));
    await submit(container.querySelector(".aib-dialog form"));
    expect(transport.of("createEpic")[0]?.args[0]).toEqual({ name: "Gift cards", description: null, targetDate: null, color: "teal", ownerId: "u1" });
    expect(text(container.querySelector(".aib-notice"))).toContain("“Gift cards” is made");
  });

  it("the dialog keeps what was typed and shows the server's sentence when refused; Nobody yet sends no owner", async () => {
    const saved: unknown[] = [];
    const { container } = await mount(
      <EpicDialog
        people={[{ id: "u1", name: "Ada" }]}
        me="u1"
        onClose={() => undefined}
        onSave={async (input) => {
          saved.push(input);
          throw new FeedbackAdminError("There's already an epic with that name. Pick another, or open that one.", 409, "conflict");
        }}
      />,
    );
    await type(field(container, "Name"), "Checkout");
    await choose(field(container, "Who leads it"), "");
    await submit(container.querySelector("form"));
    expect(saved).toEqual([expect.objectContaining({ name: "Checkout", ownerId: null })]);
    expect(text(container.querySelector("[role=alert]"))).toBe("There's already an epic with that name. Pick another, or open that one.");
    expect(field<HTMLInputElement>(container, "Name")!.value).toBe("Checkout");
  });
});

describe("./epics: an epic's page", () => {
  it("groups its tickets as its progress counts them, archived ones marked; asks 'mark it completed?' when all are done", async () => {
    let epic = detailWire();
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => epic,
      people: () => ({ people: [], me: null }),
      setEpicStatus: (_id: string, status: string) => {
        epic = { ...epic, status: status as never };
      },
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/app/feedback/epics" boardHref="/app/feedback" />);
    expect(text(container.querySelector(".aib-epic-title"))).toContain("Checkout");
    const groups = [...container.querySelectorAll(".aib-group")];
    expect(groups.map((g) => text(g.querySelector(".aib-group-h")))).toEqual(["Done 2"]);
    expect(container.querySelector(".aib-epic-ticket.aib-archived")).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>(".aib-epic-ticket a")?.getAttribute("href")).toBe("/app/feedback?ticket=t1");
    expect([...container.querySelectorAll("a")].find((a) => text(a) === "Show on the board")?.getAttribute("href")).toBe("/app/feedback?epic=e1");
    expect(text(container.querySelector(".aib-all-done"))).toContain("Every ticket in this epic is done. Mark the epic completed?");
    await click(button(container, "Mark it completed"));
    expect(transport.of("setEpicStatus")[0]?.args).toEqual(["e1", "completed"]);
    expect(container.querySelector(".aib-all-done")).toBeNull();
    // Completed: no Add tickets, and it says how to add again.
    expect(button(container, "Add tickets")).toBeNull();
    expect(text(container)).toContain("This epic is completed. Reopen it to add tickets.");
  });

  it("'Not yet' puts the question away; nothing completes the epic by itself", async () => {
    const transport = fake<FeedbackEpicsTransport>({ epic: () => detailWire() });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" />);
    await click(button(container, "Not yet"));
    expect(container.querySelector(".aib-all-done")).toBeNull();
    expect(transport.of("setEpicStatus")).toEqual([]);
  });

  it("offers only the moves the server allows, and says why when one is refused", async () => {
    expect(epicStatusChoices("archived").map((c) => c.label)).toEqual(["Archived", "Restore it (not started)"]);
    expect(epicStatusChoices("open").map((c) => c.value)).toEqual(["open", "in_progress", "completed", "archived"]);
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => detailWire({ status: "archived", progress: PROGRESS, tickets: [] }),
      setEpicStatus: () => {
        throw new FeedbackAdminError("Someone else just changed this epic. Refresh to see it as it is.", 409, "conflict");
      },
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" />);
    const select = field<HTMLSelectElement>(container, "Status")!;
    expect([...select.options].map((o) => o.value)).toEqual(["archived", "open"]);
    await choose(select, "open");
    expect(text(container.querySelector(".aib-notice"))).toContain("Someone else just changed this epic.");
  });

  it("takes tickets out (one, or the chosen ones) — they stay on the board", async () => {
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => detailWire({ status: "in_progress", progress: { ...PROGRESS, total: 2, done: 1, open: 1, percent: 50 } }),
      setEpicTickets: () => ({ added: 0, movedFromOther: 0, removed: 1 }),
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" />);
    await click(button(container, "Take FB-00001 out of the epic"));
    expect(transport.of("setEpicTickets")[0]?.args).toEqual(["e1", { remove: ["t1"] }]);
    expect(text(container.querySelector(".aib-notice"))).toContain("1 ticket taken out of the epic. It's still on the board.");
    await click(container.querySelector("input[aria-label='Choose FB-00001']"));
    await click(container.querySelector("input[aria-label='Choose FB-00002']"));
    await click(button(container, "Take them out of the epic"));
    expect(transport.of("setEpicTickets")[1]?.args).toEqual(["e1", { remove: ["t1", "t2"] }]);
  });

  it("Delete says the tickets stay, waits for the answer, and only then leaves; a refusal keeps the page", async () => {
    let refuse = true;
    let left = 0;
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => detailWire(),
      deleteEpic: () => {
        if (refuse) throw new FeedbackAdminError("You don't have permission to do that.", 403, "forbidden");
        return { deleted: true, detached: 2 };
      },
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" onDeleted={() => (left += 1)} />);
    await click(button(container, "Delete"));
    expect(text(container.querySelector("[aria-label='Delete Checkout']"))).toContain("Its 2 tickets stay on the board — they just leave the epic.");
    await click(button(container, "Delete it"));
    expect(left).toBe(0);
    expect(text(container.querySelector(".aib-notice[role=status]"))).toContain("You don't have permission to do that.");
    refuse = false;
    await click(button(container, "Delete"));
    await click(button(container, "Delete it"));
    expect(left).toBe(1);
  });

  it("offers nothing to change without the permission", async () => {
    const transport = fake<FeedbackEpicsTransport>({ epic: () => detailWire() });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="e1" epicsHref="/e" canManage={false} />);
    for (const label of ["Edit", "Add tickets", "Delete", "Mark it completed", "Take FB-00001 out of the epic"]) expect(button(container, label), label).toBeNull();
    expect(field(container, "Status")).toBeNull();
    expect(text(container.querySelector(".aib-epic-title"))).toContain("Checkout");
  });

  it("says plainly when the epic isn't there (another board's id, or deleted)", async () => {
    const transport = fake<FeedbackEpicsTransport>({
      epic: () => {
        throw new FeedbackAdminError("Not found.", 404, "not_found");
      },
    });
    const { container } = await mount(<FeedbackEpic transport={transport.target} epicId="nope" epicsHref="/e" />);
    expect(text(container)).toContain("This epic isn’t here.");
  });
});

describe("./epics: Add tickets", () => {
  it("starts on tickets in no epic, says which epic a ticket would move from, and sends the ticked ones", async () => {
    const searches: unknown[] = [];
    const added: string[][] = [];
    const board = {
      statuses: COLUMNS,
      tickets: [ticket("t1", null), ticket("t2", "e3"), ticket("t3", "e1")],
      epics: EPICS,
      archivableCount: 0,
    };
    const { container } = await mount(
      <AddTicketsDialog
        epic={{ id: "e1", name: "Checkout" }}
        search={async (input) => {
          searches.push(input);
          // The fields the dialog reads; the rest of a board answer isn't needed here.
          return board as unknown as FeedbackBoardWire;
        }}
        onClose={() => undefined}
        onAdd={async (ids) => void added.push(ids)}
      />,
    );
    await settle(4, 300);
    expect(searches[0]).toEqual({ q: "", onlyWithoutEpic: true });
    const rows = [...container.querySelectorAll(".aib-pick-list li")];
    // The epic's own ticket isn't offered again.
    expect(rows.map((r) => text(r))).toEqual(["FB-00001 Ticket t1", "FB-00002 Ticket t2 — in Spring list now; it moves here"]);
    await click(rows[0]!.querySelector("input"));
    await click(rows[1]!.querySelector("input"));
    expect(text(button(container, "Add 2 tickets"))).toBe("Add 2 tickets (1 from another epic)");
    await click(button(container, "Add 2 tickets"));
    expect(added).toEqual([["t1", "t2"]]);
    await click(field(container, "Only tickets that aren"));
    await settle(4, 300);
    expect(searches.at(-1)).toEqual({ q: "", onlyWithoutEpic: false });
  });
});
