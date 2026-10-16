// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsBell } from "../admin/AlertsBell.js";
import { AlertsInbox } from "../admin/AlertsInbox.js";
import { dayHeading, EMPTY, EMPTY_UNREAD, NOT_ON_A_LIST } from "../admin/words.js";
import { alert, button, click, fakeTransport, FakeBroadcastChannel, listOf, mount, ok, text } from "./dom.js";

/**
 * `<AlertsInbox>` (Tenancy 2b-1, section 5): All / Unread, day groups, Load
 * more, Mark all as read, the settings link, the bell's open-and-mark rule,
 * and the shared channel so the header's badge follows.
 */

const assign = vi.fn();
beforeEach(() => {
  FakeBroadcastChannel.install();
  assign.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { origin: "https://app.test", href: "https://app.test/app/alerts", assign } });
});
afterEach(() => {
  document.body.innerHTML = "";
});

const now = new Date();
const daysAgo = (days: number, hour = 10) => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

describe("<AlertsInbox>", () => {
  it("hideTitle leaves the title and the Alert settings link to the page around it, and keeps Mark all as read (review BO-11)", async () => {
    const f = fakeTransport({ list: () => ok(listOf([alert()])) });
    const m = await mount(<AlertsInbox transport={f.transport} hideTitle />);
    expect(m.container.querySelector(".ainw-title")).toBeNull();
    expect(m.container.querySelector('a[href="/app/alerts/settings"]')).toBeNull();
    expect(button(m.container, "Mark all as read")).not.toBeNull();
    await m.unmount();
    const n = await mount(<AlertsInbox transport={f.transport} />);
    expect(text(n.container.querySelector(".ainw-title"))).toBe("Alerts");
    expect(n.container.querySelector('a[href="/app/alerts/settings"]')).not.toBeNull();
    await n.unmount();
  });

  it("groups by day: Today, Yesterday, then the date", async () => {
    const alerts = [
      alert({ at: new Date(now.getTime() - 60_000).toISOString(), title: "today one" }),
      alert({ at: daysAgo(1), title: "yesterday one", read: true }),
      alert({ at: daysAgo(5), title: "older one", read: true }),
    ];
    const f = fakeTransport({ list: () => ok(listOf(alerts)) });
    const m = await mount(<AlertsInbox transport={f.transport} />);
    const headings = [...m.container.querySelectorAll(".ainw-day")].map((h) => text(h));
    expect(headings).toEqual(["Today", "Yesterday", dayHeading(daysAgo(5), now)]);
    expect(headings[2]).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    expect(f.of("list")[0]?.args).toEqual([{ unread: false, limit: 20 }]);
    await m.unmount();
  });

  it("All / Unread asks the server for unread only", async () => {
    const f = fakeTransport({ list: (q) => ok(listOf(q?.unread ? [alert()] : [alert(), alert({ read: true })])) });
    const m = await mount(<AlertsInbox transport={f.transport} />);
    expect(m.container.querySelectorAll(".ainw-item")).toHaveLength(2);
    await click(button(m.container, "Unread"));
    expect(f.of("list").at(-1)?.args).toEqual([{ unread: true, limit: 20 }]);
    expect(m.container.querySelectorAll(".ainw-item")).toHaveLength(1);
    expect(button(m.container, "Unread")?.getAttribute("aria-pressed")).toBe("true");
    await m.unmount();
  });

  it("Load more appends the next page", async () => {
    const first = [alert({ title: "one" }), alert({ title: "two" })];
    const second = [alert({ title: "three" })];
    const f = fakeTransport({ list: (q) => ok(q?.cursor === "next-1" ? listOf(second) : listOf(first, { nextCursor: "next-1" })) });
    const m = await mount(<AlertsInbox transport={f.transport} />);
    await click(button(m.container, "Load more"));
    expect(f.of("list").at(-1)?.args).toEqual([{ unread: false, limit: 20, cursor: "next-1" }]);
    expect([...m.container.querySelectorAll(".ainw-item-title")].map((t) => text(t).replace("Unread: ", ""))).toEqual(["one", "two", "three"]);
    expect(button(m.container, "Load more")).toBeNull();
    await m.unmount();
  });

  it("Mark all as read marks every alert and tells the other tabs; the settings link is there", async () => {
    const f = fakeTransport({ list: () => ok(listOf([alert(), alert()])), markAllRead: () => ok({ unread: 0, reachable: true }) });
    const m = await mount(<AlertsInbox baseUrl="/api/app/c1/alerts" transport={f.transport} />);
    expect(m.container.querySelector("a")?.getAttribute("href")).toBe("/app/alerts/settings");
    await click(button(m.container, "Mark all as read"));
    expect(m.container.querySelectorAll(".ainw-unread")).toHaveLength(0);
    expect(FakeBroadcastChannel.posts).toEqual([{ name: "ainw:/api/app/c1/alerts", data: { unread: 0 } }]);
    expect(text(m.container.querySelector(".ainw-status"))).toBe("All caught up.");
    await m.unmount();
  });

  it("choosing an alert marks it read and goes to its page, on this site only", async () => {
    const good = alert({ href: "/app/invoices/i1" });
    const bad = alert({ href: "//evil.com" });
    const f = fakeTransport({ list: () => ok(listOf([good, bad])), markRead: () => ok({ unread: 1, reachable: true }) });
    const m = await mount(<AlertsInbox transport={f.transport} />);
    const buttons = [...m.container.querySelectorAll<HTMLButtonElement>(".ainw-item-btn")];
    await click(buttons[0]);
    expect(f.of("markRead")[0]?.args).toEqual([good.id]);
    expect(assign).toHaveBeenCalledWith("https://app.test/app/invoices/i1");
    assign.mockReset();
    await click(buttons[1]);
    expect(f.of("markRead")[1]?.args).toEqual([bad.id]);
    expect(assign).not.toHaveBeenCalled();
    await m.unmount();
  });

  it("the header's bell follows what is read here (the shared channel)", async () => {
    let unread = 2;
    const bellT = fakeTransport({ count: () => ok({ unread, reachable: true }) });
    const inboxT = fakeTransport({ list: () => ok(listOf([alert(), alert()])), markAllRead: () => ((unread = 0), ok({ unread: 0, reachable: true })) });
    const bell = await mount(<AlertsBell baseUrl="/api/app/c1/alerts" transport={bellT.transport} pollMs={0} />);
    expect(bell.container.querySelector("[data-ainw-badge]")?.textContent).toBe("2");
    const inbox = await mount(<AlertsInbox baseUrl="/api/app/c1/alerts" transport={inboxT.transport} />);
    await click(button(inbox.container, "Mark all as read"));
    expect(bell.container.querySelector("[data-ainw-badge]")).toBeNull();
    await bell.unmount();
    await inbox.unmount();
  });

  it("a mark in another tab reloads the list", async () => {
    const f = fakeTransport({ list: () => ok(listOf([alert()])) });
    const m = await mount(<AlertsInbox baseUrl="/api/app/c1/alerts" transport={f.transport} />);
    expect(f.of("list")).toHaveLength(1);
    new FakeBroadcastChannel("ainw:/api/app/c1/alerts").postMessage({ unread: 0 });
    await click(m.container); // let the reload land
    expect(f.of("list")).toHaveLength(2);
    await m.unmount();
  });

  it("says what an empty list means", async () => {
    for (const [extra, filter, sentence] of [
      [{}, "All", EMPTY],
      [{}, "Unread", EMPTY_UNREAD],
      [{ reachable: false }, "All", NOT_ON_A_LIST],
    ] as const) {
      const f = fakeTransport({ list: () => ok(listOf([], extra)) });
      const m = await mount(<AlertsInbox transport={f.transport} />);
      if (filter === "Unread") await click(button(m.container, "Unread"));
      expect(text(m.container.querySelector(".ainw-empty"))).toBe(sentence);
      await m.unmount();
    }
  });

  it("a failure says why, with Try again", async () => {
    let fails = true;
    const f = fakeTransport({
      list: () => (fails ? { ok: false, error: { code: "network", message: "Couldn't reach the server.", status: 0 } } : ok(listOf([alert()]))),
    });
    const m = await mount(<AlertsInbox transport={f.transport} />);
    expect(text(m.container.querySelector(".ainw-notice-error"))).toContain("Couldn't reach the server.");
    fails = false;
    await click(button(m.container, "Try again"));
    expect(m.container.querySelectorAll(".ainw-item")).toHaveLength(1);
    await m.unmount();
  });

  it("renders on the server", () => {
    const f = fakeTransport({});
    const html = renderToStaticMarkup(<AlertsInbox transport={f.transport} />);
    expect(html).toContain('class="ainw-root"');
    expect(html).toContain("Loading your alerts");
    expect(f.calls).toEqual([]);
  });
});
