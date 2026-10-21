// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PX_PER_MINUTE } from "../admin/layout.js";
import { ScheduleCalendar, ScheduleCalendarActions } from "../admin/ScheduleCalendar.js";
import type { AdminHandlers } from "./fakes.js";
import { button, calendar, choose, click, fail, fakeAdmin, key, mount, ok, settingsWire, settle, snapshot, submit, text } from "./fakes.js";

/**
 * <ScheduleCalendar> (contract 8.5): a real pointer drag sends `reschedule`
 * with the snapped time; a sideways drag sends `assign`; a refusal puts the
 * visit back and says why in plain words; every drag has a keyboard path
 * (the panel's Move…); requests are answered from the panel and the inbox;
 * and staff are asked before a customer is emailed.
 */

const REQUEST = snapshot({
  id: "p1",
  status: "pending",
  nextStatuses: ["confirmed", "declined", "cancelled"],
  startTime: "13:00",
  endTime: "14:00",
  startsAt: "2026-11-02T20:00:00.000Z",
  customerName: "Rita Ortiz",
  customerEmail: "rita@example.com",
  resourceId: "crew-b",
  resourceName: "Crew B",
  pendingExpiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
});

function admin(extra: AdminHandlers = {}) {
  return fakeAdmin({
    calendar: () => ok(calendar({ visits: [snapshot(), REQUEST], pending: [REQUEST] })),
    getSettings: () => ok({ settings: settingsWire() }),
    reschedule: (id, body) => ok({ visit: snapshot({ id, date: body.date, startTime: body.startTime, endTime: body.endTime ?? "11:00", resourceId: body.resourceId ?? "crew-a" }), warnings: [] }),
    assign: (id, body) => ok({ visit: snapshot({ id, resourceId: body.resourceId, resourceName: "Crew B" }), warnings: [] }),
    accept: (id) => ok({ visit: { ...REQUEST, id, status: "confirmed" as const, nextStatuses: ["in_progress" as const] } }),
    decline: (id) => ok({ visit: { ...REQUEST, id, status: "declined" as const, nextStatuses: ["confirmed" as const] } }),
    ...extra,
  });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

const block = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-visit-id="${id}"]`);

function pointer(type: string, x: number, y: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: "mouse", button: 0, ...extra });
}

/** A pointer drag from (x, y) by (dx, dy): down on the element, moves and up on the window. */
async function drag(element: HTMLElement | null, dx: number, dy: number, start = { x: 100, y: 300 }, pointerType = "mouse") {
  if (!element) throw new Error("drag: no element");
  await act(async () => {
    element.dispatchEvent(pointer("pointerdown", start.x, start.y, { pointerType }));
  });
  await act(async () => {
    window.dispatchEvent(pointer("pointermove", start.x + dx / 2, start.y + dy / 2, { pointerType }));
    window.dispatchEvent(pointer("pointermove", start.x + dx, start.y + dy, { pointerType }));
  });
  await act(async () => {
    window.dispatchEvent(pointer("pointerup", start.x + dx, start.y + dy, { pointerType }));
    // The click a browser fires after a drag must not open the panel.
    element.click();
  });
  await settle();
}

/** Give the day columns real positions (happy-dom has no layout): crew A at x 64–264, crew B at 264–464. */
function layOutColumns(container: HTMLElement) {
  const columns = [...container.querySelectorAll<HTMLElement>("[data-drop]")];
  columns.forEach((column, index) => {
    column.getBoundingClientRect = () => ({ left: 64 + index * 200, right: 264 + index * 200, top: 0, bottom: 2000, width: 200, height: 2000, x: 64 + index * 200, y: 0, toJSON() {} }) as DOMRect;
  });
}

describe("<ScheduleCalendar> day view", () => {
  it("lays out crews as columns, visits at their wall-clock time, requests marked in words", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    expect(fake.of("calendar")[0]!.args[0]).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect([...container.querySelectorAll("[data-col-head]")].map((h) => text(h))).toEqual(["Crew A", "Crew B"]);
    expect(text(block(container, "v1"))).toContain("9:00 – 10:00 AM");
    expect(text(block(container, "p1"))).toContain("Request");
    expect(block(container, "p1")!.getAttribute("data-status")).toBe("pending");
    // Crew B works a split shift: two windows painted, the lunch hour shaded.
    expect(container.querySelectorAll('[data-resource="crew-b"] .aisw-col-window')).toHaveLength(2);
    expect(text(container)).toContain("Times are Mountain Time (MST).");
    expect(text(button(container, "Requests"))).toContain("1");
    await unmount();
  });

  it("a pointer drag sends reschedule with the start snapped to the grid", async () => {
    sessionStorage.setItem("aisw-notify-choice", "yes");
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    // 70 minutes of travel snaps to the 30-minute grid: 9:00 → 10:00.
    await drag(block(container, "v1"), 0, 70 * PX_PER_MINUTE);
    expect(fake.of("reschedule")).toHaveLength(1);
    expect(fake.of("reschedule")[0]!.args).toEqual(["v1", { date: "2026-11-02", startTime: "10:00", notify: true }]);
    expect(container.querySelector("[data-aisw-panel]")).toBeNull();
    expect(text(container.querySelector("[data-aisw-toasts]"))).toContain("Jane Doe moved to Mon, Nov 2, 10:00 AM.");
    await unmount();
  });

  it("works for a touch drag too (pointer events)", async () => {
    sessionStorage.setItem("aisw-notify-choice", "no");
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await drag(block(container, "v1"), 0, -60 * PX_PER_MINUTE, { x: 100, y: 300 }, "touch");
    expect(fake.of("reschedule")[0]!.args).toEqual(["v1", { date: "2026-11-02", startTime: "08:00", notify: false }]);
    await unmount();
  });

  it("a sideways drag to another crew's column sends assign", async () => {
    sessionStorage.setItem("aisw-notify-choice", "yes");
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    layOutColumns(container);
    await drag(block(container, "v1"), 200, 0, { x: 120, y: 300 });
    expect(fake.of("reschedule")).toHaveLength(0);
    expect(fake.of("assign")[0]!.args).toEqual(["v1", { resourceId: "crew-b", notify: true }]);
    await unmount();
  });

  it("a refusal puts the visit back and says why, in the server's words", async () => {
    sessionStorage.setItem("aisw-notify-choice", "yes");
    const fake = admin({ reschedule: () => fail("slot_unavailable", "Overlaps 10:00–12:00") });
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    const before = block(container, "v1")!.style.top;
    await drag(block(container, "v1"), 0, 60 * PX_PER_MINUTE);
    expect(fake.of("reschedule")).toHaveLength(1);
    expect(block(container, "v1")!.style.top).toBe(before);
    expect(text(block(container, "v1"))).toContain("9:00 – 10:00 AM");
    const toast = container.querySelector('[data-aisw-toasts] [role="alert"]');
    expect(text(toast)).toBe("Jane Doe wasn't moved. Overlaps 10:00–12:00");
    await unmount();
  });

  it("asks before emailing the customer, and remembers 'don't ask again'", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await drag(block(container, "v1"), 0, 60 * PX_PER_MINUTE);
    const prompt = container.querySelector("[data-aisw-notify-prompt]")!;
    expect(prompt.getAttribute("role")).toBe("dialog");
    expect(text(prompt)).toContain("Email the customer about this change?");
    expect(text(prompt)).toContain("moves from Mon, Nov 2, 9:00 AM to Mon, Nov 2, 10:00 AM");
    expect(document.activeElement?.textContent).toBe("Yes, email them");
    expect(fake.of("reschedule")).toHaveLength(0);
    await click([...prompt.querySelectorAll("input")].find((i) => i.type === "checkbox"));
    await click(button(prompt, "No, just move it"));
    expect(fake.of("reschedule")[0]!.args[1]).toMatchObject({ notify: false });
    // Ticked "don't ask again": the next drag goes straight through with the same answer.
    await drag(block(container, "v1"), 0, 60 * PX_PER_MINUTE);
    expect(container.querySelector("[data-aisw-notify-prompt]")).toBeNull();
    expect(fake.of("reschedule")).toHaveLength(2);
    expect(fake.of("reschedule")[1]!.args[1]).toMatchObject({ notify: false });
    await unmount();
  });

  it("'Don't move it' in the prompt puts the visit back and sends nothing", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    const before = block(container, "v1")!.style.top;
    await drag(block(container, "v1"), 0, 60 * PX_PER_MINUTE);
    await click(button(container.querySelector("[data-aisw-notify-prompt]")!, "Don't move it"));
    expect(fake.of("reschedule")).toHaveLength(0);
    expect(block(container, "v1")!.style.top).toBe(before);
    await unmount();
  });

  it("the keyboard path: open the visit, Move…, pick a time, and Escape returns focus to the block", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    const visitBlock = block(container, "v1")!;
    visitBlock.focus();
    await click(visitBlock);
    const panel = container.querySelector<HTMLElement>("[data-aisw-panel]")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(text(panel)).toContain("Booked online");

    await click(button(panel, "Move…"));
    const form = panel.querySelector("[data-aisw-move]")!;
    expect(document.activeElement?.getAttribute("type")).toBe("date");
    const selects = form.querySelectorAll("select");
    await choose(selects[0], "10:30");
    expect((selects[1] as HTMLSelectElement).value).toBe("11:30");
    await submit(form);
    expect(fake.of("reschedule")[0]!.args).toEqual(["v1", { date: "2026-11-02", startTime: "10:30", endTime: "11:30", notify: true }]);

    await key(panel, "Escape");
    expect(container.querySelector("[data-aisw-panel]")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement).toBe(block(container, "v1"));
    await unmount();
  });

  it("Tab stays inside the open panel", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await click(block(container, "v1"));
    const panel = container.querySelector<HTMLElement>("[data-aisw-panel]")!;
    const close = panel.querySelector<HTMLElement>(".aisw-dialog-close")!;
    const focusables = [...panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea")];
    focusables[focusables.length - 1]!.focus();
    await key(panel, "Tab");
    expect(document.activeElement).toBe(close);
    await key(panel, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    await unmount();
  });

  it("accepts a request from its panel, emailing the customer by default", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await click(block(container, "p1"));
    const panel = container.querySelector<HTMLElement>("[data-aisw-panel]")!;
    expect(text(panel)).toContain("expires in 5 h");
    expect(text(panel)).toContain("Email Rita about this");
    await click(panel.querySelector('[data-action="confirmed"]'));
    expect(fake.of("accept")[0]!.args).toEqual(["p1", { notify: true }]);
    expect(text(container.querySelector("[data-aisw-toasts]"))).toContain("Rita Ortiz: confirmed.");
    await unmount();
  });

  it("declines a request from the inbox, with a note for the customer", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await click(container.querySelector("[data-aisw-requests-button]"));
    const inbox = container.querySelector<HTMLElement>("[data-aisw-requests]")!;
    expect(text(inbox)).toContain("Rita Ortiz · Free estimate · Crew B");
    expect(text(inbox)).toContain("Expires in 5 h if nobody answers.");
    await click(button(inbox, "Decline Rita Ortiz"));
    const note = inbox.querySelector("textarea")!;
    const proto = Object.getPrototypeOf(note) as object;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(note, "Fully booked that day");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(inbox, "Decline request"));
    expect(fake.of("decline")[0]!.args).toEqual(["p1", { notify: true, reason: "Fully booked that day" }]);
    expect(text(inbox)).toContain("Nothing waiting.");
    await unmount();
  });

  it("accepts from the inbox too", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} />);
    await click(container.querySelector("[data-aisw-requests-button]"));
    await click(button(container.querySelector("[data-aisw-requests]")!, "Accept Rita Ortiz"));
    expect(fake.of("accept")[0]!.args).toEqual(["p1", { notify: true }]);
    await unmount();
  });

  it("read-only: no New visit, nothing draggable, no status buttons", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} canManage={false} />);
    expect(button(container, "New visit")).toBeNull();
    expect(block(container, "v1")!.hasAttribute("data-fixed")).toBe(true);
    await drag(block(container, "v1"), 0, 100);
    expect(fake.of("reschedule")).toHaveLength(0);
    await click(block(container, "v1"));
    expect(container.querySelector("[data-aisw-panel] [data-action]")).toBeNull();
    await unmount();
  });

  it("actionsInHeader: New visit leaves the toolbar for the page header's <ScheduleCalendarActions>, which opens it (polish 3)", async () => {
    const fake = admin();
    const { container, unmount } = await mount(
      <>
        <header data-host="">
          <ScheduleCalendarActions className="host-primary" />
        </header>
        <ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" pollMs={0} actionsInHeader />
      </>,
    );
    expect(button(container.querySelector<HTMLElement>(".aisw-toolbar")!, "New visit")).toBeNull();
    const header = container.querySelector<HTMLElement>("[data-host]")!;
    await click(button(header, "New visit"));
    expect(container.querySelector("[data-aisw-new-visit]")).not.toBeNull();
    expect(button(header, "New visit")!.disabled).toBe(true);
    await unmount();
  });

  it("opens on the server's today and shows the empty state with the booking page", async () => {
    const fake = admin({ calendar: (q) => ok(calendar({ from: q.from, to: q.to, today: "2026-11-02", visits: [], pending: [] })) });
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" pollMs={0} bookingPageUrl="https://acme.test/book" />);
    const asked = fake.of("calendar").map((c) => c.args[0] as { from: string; to: string });
    expect(asked[asked.length - 1]).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    const empty = container.querySelector("[data-aisw-empty]");
    expect(text(empty)).toContain("No visits this week yet");
    expect(text(empty)).toContain("every crew's day lives here");
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe("https://acme.test/book");
    await unmount();
  });
});

describe("<ScheduleCalendar> week view", () => {
  it("drags a visit to another day and crew, keeping its start time", async () => {
    sessionStorage.setItem("aisw-notify-choice", "yes");
    const fake = admin({ calendar: () => ok(calendar({ from: "2026-11-02", to: "2026-11-08", visits: [snapshot()], pending: [] })) });
    const { container, unmount } = await mount(<ScheduleCalendar transport={fake.transport} initialView="week" initialDate="2026-11-02" pollMs={0} />);
    expect(container.querySelector('[data-aisw-view="week"]')).not.toBeNull();
    const cells = [...container.querySelectorAll<HTMLElement>("[data-drop]")];
    // 2 crews × 7 days; give each cell a 100×80 box, rows of seven.
    cells.forEach((cell, index) => {
      const col = index % 7;
      const row = Math.floor(index / 7);
      cell.getBoundingClientRect = () => ({ left: 140 + col * 100, right: 240 + col * 100, top: 50 + row * 80, bottom: 130 + row * 80, width: 100, height: 80, x: 0, y: 0, toJSON() {} }) as DOMRect;
    });
    // Off days are shaded and say so: Crew A has no windows on Tuesday in this fixture.
    expect(container.querySelector('[data-resource="crew-a"][data-date="2026-11-03"]')!.hasAttribute("data-off")).toBe(true);
    // From Mon / Crew A (190, 90) to Wed / Crew B (390, 170).
    await drag(block(container, "v1"), 200, 80, { x: 190, y: 90 });
    expect(fake.of("reschedule")[0]!.args).toEqual(["v1", { date: "2026-11-04", startTime: "09:00", resourceId: "crew-b", notify: true }]);
    await unmount();
  });
});
