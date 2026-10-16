// @vitest-environment happy-dom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsBell } from "../admin/AlertsBell.js";
import { badgeText, bellLabel, EMPTY, NOT_ON_A_LIST } from "../admin/words.js";
import { safeHref } from "../href.js";
import { alert, button, click, fail, fakeTransport, FakeBroadcastChannel, key, listOf, mount, ok, settle, text } from "./dom.js";

/**
 * `<AlertsBell>` (Tenancy 2b-1, section 5; reviews G15, BO-12, BO-25): the
 * badge, the poll (visible only, with the idle backoff), hidden on a refusal,
 * the popover and the phone sheet, open-and-mark, the same-origin rule, the
 * reachable empty state and the second tab.
 */

const assign = vi.fn();
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  FakeBroadcastChannel.install();
  assign.mockReset();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "https://app.test", href: "https://app.test/app", assign },
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const bellButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(".ainw-bell");
const badge = (container: HTMLElement) => container.querySelector("[data-ainw-badge]");

describe("the badge", () => {
  it("is hidden at 0, the number up to 99, 99+ past it; the button's name says the count", async () => {
    expect([0, 7, 99, 100, 250].map(badgeText)).toEqual(["", "7", "99", "99+", "99+"]);
    expect(bellLabel(0)).toBe("Alerts");
    expect(bellLabel(3)).toBe("Alerts, 3 unread");
    for (const [unread, shown] of [
      [0, null],
      [7, "7"],
      [99, "99"],
      [120, "99+"],
    ] as const) {
      const f = fakeTransport({ count: () => ok({ unread, reachable: true }) });
      const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
      expect(badge(m.container)?.textContent ?? null, String(unread)).toBe(shown);
      expect(bellButton(m.container)?.getAttribute("aria-label")).toBe(bellLabel(unread));
      await m.unmount();
    }
  });

  it("a 403 or a 401 renders nothing and stops asking", async () => {
    for (const status of [401, 403]) {
      const f = fakeTransport({ count: () => fail("forbidden", "no", { status }) });
      const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
      expect(m.container.innerHTML).toBe("");
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle();
      expect(f.of("count")).toHaveLength(1);
      await m.unmount();
    }
  });

  it("a network failure keeps the last count", async () => {
    let answer = ok({ unread: 4, reachable: true });
    const f = fakeTransport({ count: () => answer });
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    expect(badge(m.container)?.textContent).toBe("4");
    answer = fail("network", "Couldn't reach the server.", { status: 0 }) as never;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(f.of("count")).toHaveLength(2);
    expect(badge(m.container)?.textContent).toBe("4");
    await m.unmount();
  });

  it("renders without a document (SSR): just the button", () => {
    const f = fakeTransport({});
    const html = renderToStaticMarkup(<AlertsBell transport={f.transport} />);
    expect(html).toContain('class="ainw-root ainw-bell-root"');
    expect(html).toContain('aria-label="Alerts"');
    expect(f.calls).toEqual([]);
  });
});

describe("the poll", () => {
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("polls every pollMs only while the page is visible, and fetches on becoming visible and on focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeTransport({ count: () => ok({ unread: 1, reachable: true }) });
    const m = await mount(<AlertsBell transport={f.transport} pollMs={60_000} />, { settled: false });
    await advance(0);
    expect(f.of("count")).toHaveLength(1);
    await advance(60_000);
    expect(f.of("count")).toHaveLength(2);
    visibility = "hidden";
    await advance(180_000);
    expect(f.of("count")).toHaveLength(2);
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(f.of("count")).toHaveLength(3);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(0);
    expect(f.of("count")).toHaveLength(4);
    await m.unmount();
  });

  it("after 15 minutes without input slows to every 10 minutes; one keypress fetches at once and restores 60 s (review BO-25)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeTransport({ count: () => ok({ unread: 0, reachable: true }) });
    const m = await mount(<AlertsBell transport={f.transport} pollMs={60_000} />, { settled: false });
    await advance(0);
    for (let minute = 1; minute <= 15; minute += 1) await advance(60_000);
    expect(f.of("count")).toHaveLength(16); // t = 0 … 15 min
    await advance(60_000);
    await advance(60_000);
    expect(f.of("count")).toHaveLength(16); // idle: nothing at 16 or 17 min
    await advance(8 * 60_000);
    expect(f.of("count")).toHaveLength(17); // 25 min: ten minutes after the last
    await advance(60_000);
    expect(f.of("count")).toHaveLength(17);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })));
    await advance(0);
    expect(f.of("count")).toHaveLength(18); // at once
    await advance(60_000);
    expect(f.of("count")).toHaveLength(19); // and back to every minute
    await advance(60_000);
    expect(f.of("count")).toHaveLength(20);
    await m.unmount();
  });

  it("stops when unmounted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = fakeTransport({ count: () => ok({ unread: 0, reachable: true }) });
    const m = await mount(<AlertsBell transport={f.transport} pollMs={60_000} />, { settled: false });
    await advance(0);
    await m.unmount();
    await advance(10 * 60_000);
    expect(f.of("count")).toHaveLength(1);
  });
});

describe("open", () => {
  function bell(alerts = [alert(), alert({ read: true, category: "Team", title: "Cam joined the team", body: null, kind: "tenancy.member.joined" })], extra = {}) {
    return fakeTransport({
      count: () => ok({ unread: alerts.filter((a) => !a.read).length, reachable: true }),
      list: () => ok(listOf(alerts, extra)),
      markRead: () => ok({ unread: 0, reachable: true }),
      markAllRead: () => ok({ unread: 0, reachable: true }),
    });
  }

  it("on a wide screen: a popover with the latest 10, unread in bold with a dot, and the links", async () => {
    const f = bell();
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    expect(f.of("list")[0]?.args).toEqual([{ limit: 10 }]);
    const panel = m.container.querySelector(".ainw-panel")!;
    expect(panel.getAttribute("data-ainw-mode")).toBe("popover");
    expect(panel.getAttribute("aria-modal")).toBeNull();
    const items = [...panel.querySelectorAll(".ainw-item")];
    expect(items).toHaveLength(2);
    expect(items[0]?.classList.contains("ainw-unread")).toBe(true);
    expect(items[0]?.querySelector(".ainw-dot")).not.toBeNull();
    expect(text(items[0]?.querySelector(".ainw-item-body"))).toBe("Front walk, 3 steps.");
    expect(text(items[0]?.querySelector(".ainw-item-when"))).toBe("3 min ago");
    expect(items[1]?.classList.contains("ainw-unread")).toBe(false);
    expect([...panel.querySelectorAll("a")].map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["See all alerts", "/app/alerts"],
      ["Alert settings", "/app/alerts/settings"],
    ]);
    expect(button(panel, "Mark all as read")).not.toBeNull();
    expect(bellButton(m.container)?.getAttribute("aria-expanded")).toBe("true");
    await m.unmount();
  });

  it("renders what a customer typed as text, never as markup", async () => {
    const f = bell([alert({ title: '<img src=x onerror="alert(1)">Pat', body: "<b>bold</b> https://evil.example" })]);
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    expect(m.container.querySelector(".ainw-panel img, .ainw-panel b")).toBeNull();
    expect(text(m.container.querySelector(".ainw-item-title"))).toContain('<img src=x onerror="alert(1)">Pat');
    expect(m.container.querySelectorAll(".ainw-item a")).toHaveLength(0);
    await m.unmount();
  });

  it("under 640 px: a sheet across the top, focus trapped, Escape and Close close it", async () => {
    window.innerWidth = 390;
    const f = bell();
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    const panel = m.container.querySelector<HTMLElement>(".ainw-panel")!;
    expect(panel.getAttribute("data-ainw-mode")).toBe("sheet");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(m.container.querySelector(".ainw-backdrop")).not.toBeNull();
    const focusable = [...panel.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
    expect(panel.contains(document.activeElement)).toBe(true);
    focusable[focusable.length - 1]!.focus();
    await key(panel, "Tab");
    expect(document.activeElement).toBe(focusable[0]);
    await key(panel, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    await key(document, "Escape");
    expect(m.container.querySelector(".ainw-panel")).toBeNull();
    await click(bellButton(m.container));
    await click(button(m.container, "Close"));
    expect(m.container.querySelector(".ainw-panel")).toBeNull();
    await m.unmount();
  });

  it("choosing an alert marks it read, then goes to its page", async () => {
    const order: string[] = [];
    const first = alert({ href: "/app/estimates/e9" });
    const f = fakeTransport({
      count: () => ok({ unread: 1, reachable: true }),
      list: () => ok(listOf([first])),
      markRead: (id: string) => (order.push(`markRead ${id}`), ok({ unread: 0, reachable: true })),
    });
    assign.mockImplementation((url: string) => order.push(`assign ${url}`));
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    await click(m.container.querySelector(".ainw-item-btn"));
    expect(order).toEqual([`markRead ${first.id}`, "assign https://app.test/app/estimates/e9"]);
    expect(badge(m.container)).toBeNull();
    await m.unmount();
  });

  it("never follows a link off this site: /\\evil.com, //evil.com, https://evil.com (review G15)", async () => {
    for (const href of ["/\\evil.com", "//evil.com", "https://evil.com", "javascript:alert(1)", "/a b"]) {
      expect(safeHref(href, "https://app.test"), href).toBeNull();
      const f = fakeTransport({
        count: () => ok({ unread: 1, reachable: true }),
        list: () => ok(listOf([alert({ href })])),
        markRead: () => ok({ unread: 0, reachable: true }),
      });
      const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
      await click(bellButton(m.container));
      await click(m.container.querySelector(".ainw-item-btn"));
      expect(f.of("markRead"), href).toHaveLength(1);
      expect(assign, href).not.toHaveBeenCalled();
      await m.unmount();
    }
    expect(safeHref("/app/x?y=1", "https://app.test")).toBe("https://app.test/app/x?y=1");
  });

  it("an alert with nothing to open is just marked read", async () => {
    const f = bell([alert({ href: null })]);
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    await click(m.container.querySelector(".ainw-item-btn"));
    expect(f.of("markRead")).toHaveLength(1);
    expect(assign).not.toHaveBeenCalled();
    expect(m.container.querySelector(".ainw-panel")).not.toBeNull();
    await m.unmount();
  });

  it("Mark all as read clears the badge and says so", async () => {
    const f = bell();
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    await click(button(m.container, "Mark all as read"));
    expect(f.of("markAllRead")).toHaveLength(1);
    expect(badge(m.container)).toBeNull();
    expect(text(m.container.querySelector("[role=status]"))).toBe("All caught up.");
    expect(m.container.querySelectorAll(".ainw-unread")).toHaveLength(0);
    await m.unmount();
  });

  it("empty: the plain sentence; reachable false: the not-on-a-list sentence (review BO-12)", async () => {
    for (const [reachable, sentence] of [
      [true, EMPTY],
      [false, NOT_ON_A_LIST],
    ] as const) {
      const f = fakeTransport({ count: () => ok({ unread: 0, reachable }), list: () => ok(listOf([], { reachable })) });
      const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
      await click(bellButton(m.container));
      expect(text(m.container.querySelector(".ainw-empty"))).toBe(sentence);
      await m.unmount();
    }
  });

  it("a failed list says why and offers Try again", async () => {
    const f = fakeTransport({ count: () => ok({ unread: 1, reachable: true }), list: () => fail("network", "Couldn't reach the server.", { status: 0 }) });
    const m = await mount(<AlertsBell transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    expect(text(m.container.querySelector(".ainw-empty"))).toContain("Couldn't reach the server.");
    await click(button(m.container, "Try again"));
    expect(f.of("list")).toHaveLength(2);
    await m.unmount();
  });
});

describe("two tabs", () => {
  it("a mark in one bell posts the count; another bell on the same channel follows and reloads its open list", async () => {
    const shared = { unread: 3 };
    const make = () =>
      fakeTransport({
        count: () => ok({ unread: shared.unread, reachable: true }),
        list: () => ok(listOf([alert(), alert(), alert()], { unread: shared.unread })),
        markAllRead: () => ((shared.unread = 0), ok({ unread: 0, reachable: true })),
      });
    const one = make();
    const two = make();
    const a = await mount(<AlertsBell baseUrl="/api/app/c1/alerts" transport={one.transport} pollMs={0} />);
    const b = await mount(<AlertsBell baseUrl="/api/app/c1/alerts" transport={two.transport} pollMs={0} />);
    await click(bellButton(b.container));
    expect(two.of("list")).toHaveLength(1);
    await click(bellButton(a.container));
    await click(button(a.container, "Mark all as read"));
    expect(FakeBroadcastChannel.posts).toEqual([{ name: "ainw:/api/app/c1/alerts", data: { unread: 0 } }]);
    await settle();
    expect(badge(b.container)).toBeNull();
    expect(two.of("list")).toHaveLength(2);
    await a.unmount();
    await b.unmount();
  });

  it("another company's bell (another base URL) is not touched", async () => {
    const one = fakeTransport({ count: () => ok({ unread: 2, reachable: true }), list: () => ok(listOf([alert()])), markAllRead: () => ok({ unread: 0, reachable: true }) });
    const two = fakeTransport({ count: () => ok({ unread: 5, reachable: true }) });
    const a = await mount(<AlertsBell baseUrl="/api/app/c1/alerts" transport={one.transport} pollMs={0} />);
    const b = await mount(<AlertsBell baseUrl="/api/app/c2/alerts" transport={two.transport} pollMs={0} />);
    await click(bellButton(a.container));
    await click(button(a.container, "Mark all as read"));
    expect(badge(b.container)?.textContent).toBe("5");
    await a.unmount();
    await b.unmount();
  });

  it("without BroadcastChannel, nothing breaks", async () => {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    const f = fakeTransport({ count: () => ok({ unread: 1, reachable: true }), list: () => ok(listOf([alert()])), markAllRead: () => ok({ unread: 0, reachable: true }) });
    const m = await mount(<AlertsBell baseUrl="/x" transport={f.transport} pollMs={0} />);
    await click(bellButton(m.container));
    await click(button(m.container, "Mark all as read"));
    expect(badge(m.container)).toBeNull();
    await m.unmount();
  });
});
