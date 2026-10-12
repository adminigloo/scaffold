// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import { WidgetRoot } from "../parts.js";
import { injectSchedulingStyles } from "../styles.js";
import { resolveHostTheme } from "../theme.js";
import { VisitPicker } from "../VisitPicker.js";
import { CONFIG, fakeAdmin, fakePublic, mount, ok, resource, settingsWire, settle, slotsResponse } from "./fakes.js";

/**
 * The theme contract (8.2): "auto" asks the host page first — data-theme on an
 * ancestor, body or html; then a dark/light class; then color-scheme; then
 * the OS — and follows it live. Styles go in once, with the nonce.
 */

const osDark = () => ({ matches: true });
const osLight = () => ({ matches: false });

afterEach(() => {
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("class");
  document.body.removeAttribute("data-theme");
  document.body.innerHTML = "";
  for (const style of document.head.querySelectorAll("style")) style.remove();
  vi.restoreAllMocks();
});

function widget(): HTMLElement {
  const host = document.createElement("section");
  const root = document.createElement("div");
  host.appendChild(root);
  document.body.appendChild(host);
  return root;
}

describe("resolveHostTheme", () => {
  it("html.dark gives dark, whatever the OS says", () => {
    document.documentElement.classList.add("dark");
    expect(resolveHostTheme(widget(), osLight)).toBe("dark");
  });

  it("html[data-theme=light] with the OS dark gives light", () => {
    document.documentElement.setAttribute("data-theme", "light");
    expect(resolveHostTheme(widget(), osDark)).toBe("light");
  });

  it("the nearest ancestor's data-theme beats body and html", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const root = widget();
    root.parentElement!.setAttribute("data-theme", "dark");
    expect(resolveHostTheme(root, osLight)).toBe("dark");
  });

  it("data-theme beats a class", () => {
    document.documentElement.classList.add("dark");
    document.body.setAttribute("data-theme", "light");
    expect(resolveHostTheme(widget(), osDark)).toBe("light");
  });

  it("color-scheme counts only when it names exactly one scheme", () => {
    const spy = vi.spyOn(window, "getComputedStyle");
    spy.mockReturnValue({ colorScheme: "dark" } as CSSStyleDeclaration);
    expect(resolveHostTheme(widget(), osLight)).toBe("dark");
    spy.mockReturnValue({ colorScheme: "light dark" } as CSSStyleDeclaration);
    expect(resolveHostTheme(widget(), osDark)).toBe("dark");
    expect(resolveHostTheme(widget(), osLight)).toBe("light");
  });

  it("with nothing to go on, the browser's light canvas — the OS only where the page lets the browser go dark (color-scheme: light dark)", () => {
    expect(resolveHostTheme(widget(), osDark)).toBe("light");
    expect(resolveHostTheme(widget(), osLight)).toBe("light");
    const spy = vi.spyOn(window, "getComputedStyle");
    spy.mockReturnValue({ colorScheme: "light dark", backgroundColor: "rgba(0, 0, 0, 0)" } as CSSStyleDeclaration);
    expect(resolveHostTheme(widget(), osDark)).toBe("dark");
    expect(resolveHostTheme(widget(), osLight)).toBe("light");
  });
});

describe("the theme on a mounted widget", () => {
  const transport = () =>
    fakePublic({ config: () => ok(CONFIG), slots: () => ok(slotsResponse()) }).transport;

  it("writes data-theme once mounted, and re-resolves live when the host's class changes", async () => {
    const { container, unmount } = await mount(
      <StrictMode>
        <VisitPicker transport={transport()} />
      </StrictMode>,
    );
    const root = container.querySelector(".aisw-root")!;
    expect(root.getAttribute("data-theme")).toBe("light");
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    await settle();
    expect(root.getAttribute("data-theme")).toBe("dark");
    await act(async () => {
      document.documentElement.classList.remove("dark");
      document.documentElement.setAttribute("data-theme", "light");
    });
    await settle();
    expect(root.getAttribute("data-theme")).toBe("light");
    await unmount();
  });

  it("follows the OS setting live through matchMedia (on a page whose color-scheme allows dark)", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ colorScheme: "light dark", backgroundColor: "rgba(0, 0, 0, 0)" } as CSSStyleDeclaration);
    const listeners = new Set<() => void>();
    let dark = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          get matches() {
            return dark;
          },
          addEventListener: (_: string, fn: () => void) => listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        }) as unknown as MediaQueryList,
    );
    const { container, unmount } = await mount(<VisitPicker transport={transport()} />);
    const root = container.querySelector(".aisw-root")!;
    expect(root.getAttribute("data-theme")).toBe("light");
    dark = true;
    await act(async () => {
      for (const fn of listeners) fn();
    });
    expect(root.getAttribute("data-theme")).toBe("dark");
    await unmount();
    expect(listeners.size).toBe(0);
  });

  it("a pinned theme is written as given", async () => {
    document.documentElement.classList.add("dark");
    const { container, unmount } = await mount(<VisitPicker transport={transport()} theme="light" />);
    expect(container.querySelector(".aisw-root")!.getAttribute("data-theme")).toBe("light");
    await unmount();
  });
});

describe("style injection", () => {
  it("puts the nonce on the style tag and never duplicates it", async () => {
    const a = await mount(<WidgetRoot nonce="n0nce">a</WidgetRoot>);
    const b = await mount(<WidgetRoot nonce="n0nce">b</WidgetRoot>);
    injectSchedulingStyles({ nonce: "other" });
    const tags = document.querySelectorAll("style#aisw-styles");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute("nonce")).toBe("n0nce");
    await a.unmount();
    await b.unmount();
  });

  it("the admin entry adds its own sheet once, beside the widget's", async () => {
    const admin = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire() }),
      listResources: () => ok({ resources: [resource()] }),
      getAvailability: () => ok({ resourceId: "crew-a", hoursConfigured: false, weekly: [], effectiveWeekly: [], timeOff: [], specialHours: [] }),
    });
    const one = await mount(<SchedulingSettings transport={admin.transport} nonce="abc" />);
    const two = await mount(<SchedulingSettings transport={admin.transport} nonce="abc" />);
    expect(document.querySelectorAll("style#aisw-styles")).toHaveLength(1);
    expect(document.querySelectorAll("style#aisw-admin-styles")).toHaveLength(1);
    expect(document.querySelector("style#aisw-admin-styles")!.getAttribute("nonce")).toBe("abc");
    await one.unmount();
    await two.unmount();
  });
});
