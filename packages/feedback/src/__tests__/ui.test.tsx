// @vitest-environment happy-dom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CategoryEditor, ColumnEditor, KeysPanel, shortNameOf } from "../admin.js";
import {
  BoardToolbar,
  boardFilterFields,
  boardQuickFilters,
  EMPTY_FILTERS,
  FeedbackAdminError,
  FeedbackBoard,
  FeedbackWorkspace,
  FILTER_ME,
  FILTER_NONE,
  NewTicketDialog,
  replyAudience,
  TicketPanel,
  useBoardFilters,
  type BoardFilters,
  type BoardFilterUrl,
  type FeedbackColumnWire,
  type FeedbackSettingsTransport,
} from "../board.js";
import { button, choose, click, fake, field, key, mount, settle, submit, text, type } from "./dom.js";

/**
 * The 0.11.0 package screens, in a DOM: the toolbar (menus with counts, quick
 * filters, chips, Clear, the search box that doesn't go stale, "Showing X of
 * Y"), the filters kept in the address and remembered, New ticket (and the
 * column "+"), the panel's editor and trail, and the ./admin editors over a
 * fake transport — the column delete that asks where tickets go, the key
 * shown once.
 */

afterEach(() => {
  document.body.innerHTML = "";
  try {
    window.localStorage.clear();
  } catch {
    /* none */
  }
});

const COLUMNS: FeedbackColumnWire[] = [
  { id: "c1", key: "open", label: "Open", color: "#1f6fff", sortOrder: 10, isTerminal: false, wipLimit: null, agingWarnHours: null, agingStaleHours: null, allowAiTransition: false, ticketCount: 2 },
  { id: "c2", key: "doing", label: "Doing", color: null, sortOrder: 20, isTerminal: false, wipLimit: null, agingWarnHours: null, agingStaleHours: null, allowAiTransition: false, ticketCount: 0 },
  { id: "c3", key: "done", label: "Done", color: null, sortOrder: 30, isTerminal: true, wipLimit: null, agingWarnHours: null, agingStaleHours: null, allowAiTransition: false, ticketCount: 3 },
];

function memoryUrl(initial = ""): BoardFilterUrl & { current: () => string } {
  let params = new URLSearchParams(initial);
  return {
    read: () => new URLSearchParams(params),
    write: (next) => {
      params = new URLSearchParams(next);
    },
    current: () => params.toString(),
  };
}

describe("BoardToolbar", () => {
  function Harness({ initial = EMPTY_FILTERS, onFilters }: { initial?: BoardFilters; onFilters?: (f: BoardFilters) => void }) {
    const [filters, setFilters] = useState(initial);
    const fields = boardFilterFields({
      statuses: COLUMNS,
      categories: [{ key: "billing", label: "Billing" }],
      people: [
        { id: "u1", name: "Ada" },
        { id: "u2", name: "Ben" },
      ],
      me: "u1",
      facets: { status: { open: 2, doing: 1 }, priority: { critical: 1 }, category: { billing: 2, [FILTER_NONE]: 1 }, assignee: { u1: 1, [FILTER_NONE]: 2 }, source: { widget: 3 } },
    });
    return (
      <BoardToolbar
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          onFilters?.(next);
        }}
        fields={fields}
        quickFilters={boardQuickFilters({ me: "u1", facets: { assignee: { u1: 1, [FILTER_NONE]: 2 }, priority: { critical: 1 } } })}
        totalCount={4}
        matchCount={2}
        shownCount={2}
        searchDebounceMs={20}
        onCreate={() => undefined}
      />
    );
  }

  it("offers each field as a menu with counts, and ORs the choices within it", async () => {
    let last = EMPTY_FILTERS;
    const { container } = await mount(<Harness onFilters={(f) => (last = f)} />);
    await click(button(container, "Status"));
    const menu = container.querySelector(".aib-menu")!;
    expect(text(menu)).toContain("Open2");
    expect(text(menu)).toContain("Doing1");
    const boxes = [...menu.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    await click(boxes[0]);
    await click(boxes[1]);
    expect(last.status).toEqual(["open", "doing"]);
    expect(text(container.querySelector(".aib-menu-btn"))).toBe("Status: 2 chosen");
    // Escape closes the menu and goes back to its button.
    await key(container.querySelector(".aib-menu"), "Escape");
    expect(container.querySelector(".aib-menu")).toBeNull();
  });

  it("puts Unassigned and Me in the Assigned-to field, so the quick filters and the menu agree", async () => {
    let last = EMPTY_FILTERS;
    const { container } = await mount(<Harness onFilters={(f) => (last = f)} />);
    await click(button(container, "Mine"));
    expect(last.assignee).toEqual([FILTER_ME]);
    expect(button(container, "Mine")?.getAttribute("aria-pressed")).toBe("true");
    expect(text(container.querySelector(".aib-chips"))).toContain("Assigned to: Me");
    await click(button(container, "Unassigned"));
    expect(last.assignee).toEqual([FILTER_NONE]);
    expect(button(container, "Mine")?.getAttribute("aria-pressed")).toBe("false");
    await click(button(container, "Assigned to"));
    const labels = [...container.querySelectorAll(".aib-menu .aib-option-label")].map((el) => text(el));
    expect(labels).toEqual(["Unassigned", "Me", "Ben"]);
  });

  it("shows every filter as a removable chip, Clear clears all of it (archived too), and says Showing X of Y", async () => {
    let last = EMPTY_FILTERS;
    const start: BoardFilters = { ...EMPTY_FILTERS, q: "gate", priority: ["critical"], archived: true, from: "2026-10-01" };
    const { container } = await mount(<Harness initial={start} onFilters={(f) => (last = f)} />);
    const chips = [...container.querySelectorAll(".aib-fchip-text")].map((el) => text(el));
    expect(chips[0]).toBe("Search: “gate”");
    expect(chips).toContain("Priority: Critical");
    expect(chips).toContain("Showing archived");
    expect(chips.some((chip) => chip.startsWith("Sent:"))).toBe(true);
    expect(text(container.querySelector(".aib-count-line"))).toBe("Showing 2 of 4 tickets");
    await click(button(container, "Remove Priority: Critical"));
    expect(last.priority).toEqual([]);
    await click(button(container, "Clear all"));
    expect(last).toEqual(EMPTY_FILTERS);
    expect(container.querySelector(".aib-chips")).toBeNull();
  });

  it("searches after a pause or on Enter, and the box follows a search changed from outside", async () => {
    let last = EMPTY_FILTERS;
    function Outer() {
      const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
      return (
        <>
          <button type="button" onClick={() => setFilters({ ...EMPTY_FILTERS, q: "from a link" })}>
            follow link
          </button>
          <BoardToolbar
            filters={filters}
            onChange={(next) => {
              last = next;
              setFilters(next);
            }}
            fields={[]}
            searchDebounceMs={20}
          />
        </>
      );
    }
    const { container } = await mount(<Outer />);
    const box = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await type(box, "gate");
    expect(last.q).toBe("");
    await settle(4, 30);
    expect(last.q).toBe("gate");
    await type(box, "gate code");
    await key(box, "Enter");
    expect(last.q).toBe("gate code");
    // Ask Lou's stale box: a search set from outside must show in the box.
    await click(button(container, "follow link"));
    expect(container.querySelector<HTMLInputElement>("input[type=search]")!.value).toBe("from a link");
  });
});

describe("useBoardFilters: the address first, then what this browser remembered", () => {
  function Probe({ url, persistKey, onReady }: { url: BoardFilterUrl; persistKey: string; onReady: (f: BoardFilters, set: (f: BoardFilters) => void) => void }) {
    const { filters, setFilters, isReady } = useBoardFilters({ url, persistKey });
    if (isReady) onReady(filters, setFilters);
    return <span data-ready={isReady}>{JSON.stringify(filters)}</span>;
  }

  it("reads the address, writes changes back to it (keeping its other parameters), and remembers them", async () => {
    const url = memoryUrl("ticket=t1&status=open");
    let seen: BoardFilters = EMPTY_FILTERS;
    let set: (f: BoardFilters) => void = () => undefined;
    await mount(<Probe url={url} persistKey="k1" onReady={(f, s) => ((seen = f), (set = s))} />);
    expect(seen.status).toEqual(["open"]);
    set({ ...seen, priority: ["high"] });
    await settle();
    expect(url.current()).toBe("ticket=t1&status=open&priority=high");
    expect(window.localStorage.getItem("k1")).toBe("status=open&priority=high");
  });

  it("brings the remembered filters back on a bare address — but a link with filters wins", async () => {
    window.localStorage.setItem("k2", "assignee=__me");
    const bare = memoryUrl("");
    let seen: BoardFilters = EMPTY_FILTERS;
    await mount(<Probe url={bare} persistKey="k2" onReady={(f) => (seen = f)} />);
    expect(seen.assignee).toEqual([FILTER_ME]);
    expect(bare.current()).toBe("assignee=__me");
    document.body.innerHTML = "";
    const linked = memoryUrl("priority=low");
    await mount(<Probe url={linked} persistKey="k2" onReady={(f) => (seen = f)} />);
    expect(seen.assignee).toEqual([]);
    expect(seen.priority).toEqual(["low"]);
  });
});

describe("New ticket", () => {
  it("lands in the column its + was pressed on, sends what was typed, and shows the number", async () => {
    const made: unknown[] = [];
    const { container } = await mount(
      <NewTicketDialog
        statuses={COLUMNS}
        categories={[{ key: "billing", label: "Billing" }]}
        people={[{ id: "u2", name: "Ben" }]}
        defaultStatus="doing"
        onCreate={async (input) => {
          made.push(input);
          return { id: "t9", ticketNumber: "FB-00009" };
        }}
        onClose={() => undefined}
      />,
    );
    expect(field<HTMLSelectElement>(container, "Column")!.value).toBe("doing");
    await type(field(container, "Title"), "  Call Pat back  ");
    await choose(field(container, "Priority"), "high");
    await choose(field(container, "Category"), "billing");
    await choose(field(container, "Assigned to"), "u2");
    await submit(container.querySelector("form"));
    expect(made).toEqual([{ title: "Call Pat back", status: "doing", priority: "high", category: "billing", assigneeId: "u2" }]);
    expect(text(container.querySelector(".aib-done"))).toContain("FB-00009 is on the board.");
  });

  it("keeps what was typed and shows the server's sentence when it's refused", async () => {
    const { container } = await mount(
      <NewTicketDialog
        statuses={COLUMNS}
        onCreate={async () => {
          throw new FeedbackAdminError("That column isn't on this board any more.", 400, "invalid");
        }}
        onClose={() => undefined}
      />,
    );
    expect(field<HTMLSelectElement>(container, "Column")!.value).toBe("open");
    await type(field(container, "Title"), "Something");
    await submit(container.querySelector("form"));
    expect(text(container.querySelector("[role=alert]"))).toBe("That column isn't on this board any more.");
    expect(field<HTMLInputElement>(container, "Title")!.value).toBe("Something");
  });

  it("each column's + asks for a ticket in that column", async () => {
    const asked: string[] = [];
    const { container } = await mount(
      <FeedbackBoard statuses={COLUMNS} tickets={[]} onMove={() => undefined} onCreateInColumn={(key) => asked.push(key)} />,
    );
    await click(button(container, "New ticket in Doing"));
    expect(asked).toEqual(["doing"]);
  });
});

describe("TicketPanel's editor and trail", () => {
  const ticket = {
    id: "t1",
    ticketNumber: "FB-00001",
    title: "Gate stuck",
    priority: "medium",
    category: null,
    status: "open",
    assignee: null,
    assigneeId: null,
    source: "page",
    createdAt: new Date().toISOString(),
  };

  it("edits priority, category, assignee and title through onUpdate, and reads the trail in words", async () => {
    const patches: unknown[] = [];
    const { container } = await mount(
      <TicketPanel
        ticket={ticket}
        messages={[]}
        statuses={COLUMNS}
        currentUser="Ada"
        categories={[{ key: "billing", label: "Billing" }]}
        people={[{ id: "u2", name: "Ben" }]}
        events={[
          { id: "e1", kind: "created", fromValue: null, toValue: null, actorName: "Pat", createdAt: new Date().toISOString() },
          { id: "e2", kind: "status", fromValue: "Open", toValue: "Doing", actorName: "Ada", createdAt: new Date().toISOString() },
        ]}
        onClose={() => undefined}
        onSend={() => undefined}
        onAssign={() => undefined}
        onMove={() => undefined}
        onUpdate={(patch) => void patches.push(patch)}
      />,
    );
    expect(text(container.querySelector(".aib-panel-sub"))).toContain("Feedback page");
    await choose(field(container, "Priority"), "critical");
    await choose(field(container, "Category"), "billing");
    await choose(field(container, "Assigned to"), "u2");
    await click(button(container, "Edit the title"));
    await type(container.querySelector("input[aria-label=Title]"), "Gate stuck open");
    await click(button(container, "Save"));
    expect(patches).toEqual([{ priority: "critical" }, { category: "billing" }, { assigneeId: "u2" }, { title: "Gate stuck open" }]);
    const trail = [...container.querySelectorAll(".aib-activity li")].map((li) => text(li).replace(/\s*\d.*$/, ""));
    expect(trail[0]).toContain("Pat filed it");
    expect(trail[1]).toContain("Ada moved it from Open to Doing");
  });

  it("puts a refused edit back and says why", async () => {
    const errors: unknown[] = [];
    const { container } = await mount(
      <TicketPanel
        ticket={ticket}
        messages={[]}
        statuses={COLUMNS}
        currentUser="Ada"
        onClose={() => undefined}
        onSend={() => undefined}
        onAssign={() => undefined}
        onMove={() => undefined}
        onUpdate={() => {
          throw new FeedbackAdminError("No.", 400, "invalid");
        }}
        onError={(error) => errors.push(error)}
      />,
    );
    await choose(field(container, "Priority"), "low");
    expect(field<HTMLSelectElement>(container, "Priority")!.value).toBe("medium");
    expect(errors).toHaveLength(1);
  });
});

describe("./admin: the settings screens over a transport", () => {
  function columnsTransport(extra: Partial<Record<keyof FeedbackSettingsTransport, (...args: never[]) => unknown>> = {}) {
    return fake<FeedbackSettingsTransport>({ columns: () => COLUMNS, ...extra });
  }

  it("ColumnEditor adds (the short name made from the name), renames, recolours and reorders", async () => {
    const t = columnsTransport();
    const { container } = await mount(<ColumnEditor transport={t.target} />);
    await type(field(container, "New column"), "Waiting on customer");
    await click(button(container, "Colour #e11d48"));
    await submit(container.querySelector("form"));
    expect(t.of("createColumn")[0]?.args[0]).toEqual({ key: "waiting_on_customer", label: "Waiting on customer", color: null, isTerminal: false });
    const rows = container.querySelectorAll(".aib-admin-row");
    const first = rows[0]!;
    await type(first.querySelector("input.aib-input"), "New");
    await click(button(first, "Colour #12b23b"));
    await click(button(first, "Save"));
    expect(t.of("updateColumn")[0]?.args).toEqual(["c1", { label: "New", color: "#12b23b", isTerminal: false, wipLimit: null, agingWarnHours: null, agingStaleHours: null }]);
    await click(button(container, "Move Doing left"));
    expect(t.of("reorderColumns")[0]?.args[0]).toEqual(["c2", "c1", "c3"]);
    expect(shortNameOf("1st line!")).toBe("c_1st_line");
  });

  it("deleting a column with tickets asks where they go, and sends that column", async () => {
    const t = columnsTransport();
    const { container } = await mount(<ColumnEditor transport={t.target} />);
    const done = [...container.querySelectorAll(".aib-admin-row")][2]!;
    await click(button(done, "Delete"));
    expect(text(done)).toContain("Its 3 tickets will move to");
    await choose(done.querySelector("select[aria-label='Move its tickets to']"), "doing");
    await click(button(done, "Move them and delete"));
    expect(t.of("deleteColumn")[0]?.args).toEqual(["c3", "doing"]);
    // An empty one just asks to confirm.
    const doing = [...container.querySelectorAll(".aib-admin-row")][1]!;
    await click(button(doing, "Delete"));
    await click(button(doing, "Delete it"));
    expect(t.of("deleteColumn")[1]?.args).toEqual(["c2", null]);
  });

  it("offers nothing to change without the permission, and shows the server's sentence when refused", async () => {
    const readOnly = await mount(<ColumnEditor transport={columnsTransport().target} canManage={false} />);
    expect(button(readOnly.container, "Save")).toBeNull();
    expect(button(readOnly.container, "Add column")).toBeNull();
    await readOnly.unmount();
    const refusing = columnsTransport({
      createColumn: () => {
        throw new FeedbackAdminError("This board already has a column with that name.", 409, "conflict");
      },
    });
    const { container } = await mount(<ColumnEditor transport={refusing.target} />);
    await type(field(container, "New column"), "Open");
    await submit(container.querySelector("form"));
    expect(text(container.querySelector(".aib-notice"))).toContain("This board already has a column with that name.");
  });

  it("CategoryEditor adds, hides from customers, and shows why a used category can't go", async () => {
    const t = fake<FeedbackSettingsTransport>({
      categories: () => [{ id: "k1", key: "bug", label: "Bug report", description: null, sortOrder: 10, showToCustomer: true }],
      deleteCategory: () => {
        throw new FeedbackAdminError("2 tickets are filed under this category. Hide it from customers instead, so it stays on those tickets.", 409, "conflict");
      },
    });
    const { container } = await mount(<CategoryEditor transport={t.target} />);
    await type(field(container, "New category"), "Billing question");
    await submit(container.querySelector("form"));
    expect(t.of("createCategory")[0]?.args[0]).toEqual({ key: "billing_question", label: "Billing question", description: null });
    const row = container.querySelector(".aib-admin-row")!;
    await click(row.querySelector("input[type=checkbox]"));
    await click(button(row, "Save"));
    expect(t.of("updateCategory")[0]?.args).toEqual(["k1", { label: "Bug report", description: null, showToCustomer: false }]);
    await click(button(container.querySelector(".aib-admin-row")!, "Delete"));
    await click(button(container, "Delete it"));
    expect(text(container.querySelector(".aib-notice"))).toContain("Hide it from customers instead");
  });

  it("KeysPanel makes a key and shows it once with the snippet, and switches one off after asking", async () => {
    const t = fake<FeedbackSettingsTransport>({
      keys: () => [{ id: "key1", label: "Main site", createdAt: "2026-10-01T00:00:00Z", revokedAt: null }],
      issueKey: (label: never) => ({ id: "key2", label, createdAt: "2026-10-16T00:00:00Z", revokedAt: null, secret: "aik_secret" }),
    });
    const { container } = await mount(<KeysPanel transport={t.target} intakeUrl="https://app.test/api/igloo" publicPageUrl="https://app.test/t/acme/feedback" />);
    expect(text(container)).toContain("Your feedback page is https://app.test/t/acme/feedback");
    await type(field(container, "Which website is it for?"), "Shop");
    await submit(container.querySelector("form"));
    expect(t.of("issueKey")[0]?.args).toEqual(["Shop"]);
    expect([...container.querySelectorAll("pre.aib-code")].map((pre) => text(pre)).join(" ")).toContain('clientKey: "aik_secret"');
    await click(button(container, "Switch off"));
    expect(t.of("revokeKey")).toHaveLength(0);
    await click(button(container, "Switch it off"));
    expect(t.of("revokeKey")[0]?.args).toEqual(["key1"]);
  });
});

// ---------------------------------------------------------------------------
// The 0.11.0 review's findings, on screen
// ---------------------------------------------------------------------------

describe("review fixes, on screen", () => {
  it("HIGH 1: a name typed before 0.11 is its own Assigned-to choice, '(not linked)', with its count", async () => {
    const fields = boardFilterFields({
      statuses: COLUMNS,
      people: [{ id: "u1", name: "Ada" }],
      me: "u1",
      facets: { assignee: { u1: 1, [FILTER_NONE]: 2, "__name:Old Typed Name": 1 } },
    });
    const assignee = fields.find((def) => def.field === "assignee")!;
    expect(assignee.options.map((o) => [o.label, o.count])).toEqual([
      ["Unassigned", 2],
      ["Me", 1],
      ["Old Typed Name (not linked)", 1],
    ]);
  });

  it("LOW 11: the source filter reads 'Came in through', and each menu names its filter", async () => {
    const fields = boardFilterFields({ statuses: COLUMNS });
    expect(fields.find((def) => def.field === "source")?.label).toBe("Came in through");
    const { container } = await mount(<BoardToolbar filters={EMPTY_FILTERS} onChange={() => undefined} fields={fields} />);
    await click(button(container, "Came in through"));
    expect(text(container.querySelector(".aib-menu .aib-menu-title"))).toBe("Came in through");
    expect(container.querySelector(".aib-menu")?.getAttribute("aria-labelledby")).toBe(container.querySelector(".aib-menu-title")?.id);
  });

  it("MEDIUM 2: the reply box says who reads a reply, and New ticket only emails the customer when asked", async () => {
    expect(replyAudience({ source: "staff", reporterName: "Mrs Jones", reporterEmail: "j@example.test", notifyReporter: false })).toEqual({
      label: "Note for your team",
      note: "Only your team sees what you write here: the customer isn't told about this ticket.",
    });
    expect(replyAudience({ source: "staff", reporterName: "Mrs Jones", reporterEmail: "j@example.test", notifyReporter: true }).note).toBe(
      "Your reply is emailed to Mrs Jones (j@example.test).",
    );
    expect(replyAudience({ source: "widget", reporterName: "Pat", reporterEmail: "pat@example.test", notifyReporter: true }).note).toContain("is emailed to Pat (pat@example.test)");
    expect(replyAudience({ source: "widget", reporterName: "Pat", reporterEmail: "pat@example.test", notifyReporter: true }, false).note).toBe(
      'Pat sees your reply under "My reports", on the device they sent this from. It isn\'t emailed.',
    );
    const { container } = await mount(
      <TicketPanel
        ticket={{ id: "t1", ticketNumber: "FB-00001", title: "x", priority: "medium", status: "open", source: "staff", notifyReporter: false, createdAt: new Date().toISOString() }}
        messages={[]}
        statuses={COLUMNS}
        currentUser="You"
        onClose={() => undefined}
        onSend={() => undefined}
        onAssign={() => undefined}
        onMove={() => undefined}
      />,
    );
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("Note for your team");
    expect(text(container.querySelector(".aib-compose-note"))).toContain("the customer isn't told");
    // LOW 11: a staff ticket with no details doesn't speak of "the report above".
    expect(text(container.querySelector(".aib-thread-empty"))).toBe("No notes yet.");
    document.body.innerHTML = "";

    const sent: unknown[] = [];
    const dialog = await mount(
      <NewTicketDialog statuses={COLUMNS} onCreate={async (input) => (sent.push(input), { id: "t2", ticketNumber: "FB-00002" })} onClose={() => undefined} />,
    );
    await type(field(dialog.container, "Title"), "Call Mrs Jones");
    await click(dialog.container.querySelector("input[type=checkbox]"));
    await type(field(dialog.container, "Their name"), "Mrs Jones");
    await type(field(dialog.container, "Their email"), "j@example.test");
    await submit(dialog.container.querySelector("form"));
    expect(sent[0]).toMatchObject({ reporterName: "Mrs Jones", reporterEmail: "j@example.test" });
    expect((sent[0] as { tellReporter?: boolean }).tellReporter).toBeUndefined();
  });

  it("MEDIUM 5: a new ticket the filters hide is said to be hidden, with Clear filters and Open it", async () => {
    const board = { statuses: COLUMNS, tickets: [], archivableCount: 0, totalCount: 1, matchCount: 0, truncated: false, facets: { status: {}, priority: {}, category: {}, assignee: {}, source: {} } };
    const client = fake<import("../board.js").FeedbackAdminClient>({
      board: () => board,
      categories: () => [],
      people: () => ({ people: [], me: null }),
      createTicket: () => ({ id: "t9", ticketNumber: "FB-00009", title: "x", status: "open" }),
    });
    const url = memoryUrl("priority=critical");
    const { container } = await mount(<FeedbackWorkspace baseUrl="/x" client={client.target} filterUrl={url} rememberFiltersAs={false} />);
    await click(button(container, "New ticket"));
    await type(field(container, "Title"), "Hidden by the Critical filter");
    await submit(container.querySelector(".aib-dialog form"));
    expect(text(container.querySelector(".aib-done"))).toContain("FB-00009 is made, but the filters on the board are hiding it.");
    expect(button(container, "Open it")).not.toBeNull();
    await click(button(container, "Clear filters"));
    expect(url.current()).toBe("");
    expect(text(container.querySelector(".aib-done"))).toContain("FB-00009 is on the board.");
  });

  it("MEDIUM 4 and LOW 7: inputs in a stacked field never take the row's grow as their height; a disabled primary button stays readable", async () => {
    const { CSS_TEXT } = await import("../board-styles.js");
    // The rule that made 180px-tall inputs: any input under a row, stacked field or not.
    expect(CSS_TEXT).not.toMatch(/\.aib-admin-line \.aib-input\s*\{/);
    expect(CSS_TEXT).toMatch(/\.aib-admin-line > \.aib-input \{[^}]*flex: 1 1 180px/);
    expect(CSS_TEXT).toMatch(/\.aib-field > \.aib-input[^{]*\{[^}]*flex: none/);
    // Disabled primary: the measured on-accent-on-ink-faint pair, declared after the generic disabled rule.
    const generic = CSS_TEXT.indexOf(".aib-tool-btn:disabled {");
    const primary = CSS_TEXT.indexOf(".aib-tool-primary:disabled {");
    expect(generic).toBeGreaterThan(-1);
    expect(primary).toBeGreaterThan(generic);
    expect(CSS_TEXT.slice(primary, CSS_TEXT.indexOf("}", primary))).toContain("background: var(--aib-ink-faint); color: var(--aib-on-accent)");
  });
});
