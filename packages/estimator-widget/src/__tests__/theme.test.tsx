// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EstimatorSettings } from "../admin/EstimatorSettings.js";
import { EstimateTool } from "../EstimateTool.js";
import { WidgetRoot } from "../parts.js";
import { injectEstimatorStyles } from "../styles.js";
import { resolveHostTheme } from "../theme.js";
import { CONFIG, fakeAdmin, fakePublic, mount, ok, settle } from "./fakes.js";

/**
 * The theme contract (9.2): "auto" asks the host page first — data-theme on an
 * ancestor, body or html; then a dark/light class; then color-scheme; then
 * what the widget sits on; then the OS — and follows it live. Styles go in
 * once, with the nonce.
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

  it("with nothing to go on: the browser's light canvas — the OS only where the page lets the browser go dark", () => {
    expect(resolveHostTheme(widget(), osDark)).toBe("light");
    const spy = vi.spyOn(window, "getComputedStyle");
    spy.mockReturnValue({ colorScheme: "light dark", backgroundColor: "rgba(0, 0, 0, 0)" } as CSSStyleDeclaration);
    expect(resolveHostTheme(widget(), osDark)).toBe("dark");
    expect(resolveHostTheme(widget(), osLight)).toBe("light");
  });

  it("what the widget sits on: a dark section under a page with no theme gives dark", () => {
    const spy = vi.spyOn(window, "getComputedStyle");
    spy.mockImplementation(((el: Element) => ({ colorScheme: "normal", backgroundColor: el.tagName === "SECTION" ? "rgb(17, 24, 39)" : "rgba(0, 0, 0, 0)" })) as never);
    expect(resolveHostTheme(widget(), osLight)).toBe("dark");
  });
});

describe("the theme on a mounted widget", () => {
  const transport = () => fakePublic({ config: () => ok(CONFIG) }).transport;

  it("writes data-theme once mounted, and re-resolves live when the host's class changes (under StrictMode)", async () => {
    const { container, unmount } = await mount(
      <StrictMode>
        <EstimateTool transport={transport()} />
      </StrictMode>,
    );
    const root = container.querySelector(".aiew-root")!;
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

  it("follows the OS live through matchMedia, and lets go of the listener on unmount", async () => {
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
    const { container, unmount } = await mount(<EstimateTool transport={transport()} />);
    const root = container.querySelector(".aiew-root")!;
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
    const { container, unmount } = await mount(<EstimateTool transport={transport()} theme="light" />);
    expect(container.querySelector(".aiew-root")!.getAttribute("data-theme")).toBe("light");
    await unmount();
  });
});

describe("style injection", () => {
  it("puts the nonce on the style tag and never duplicates it", async () => {
    const a = await mount(<WidgetRoot nonce="n0nce">a</WidgetRoot>);
    const b = await mount(<WidgetRoot nonce="n0nce">b</WidgetRoot>);
    injectEstimatorStyles({ nonce: "other" });
    const tags = document.querySelectorAll("style#aiew-styles");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute("nonce")).toBe("n0nce");
    await a.unmount();
    await b.unmount();
  });

  it("the admin entry adds its own sheet once, beside the widget's", async () => {
    const admin = fakeAdmin({});
    const one = await mount(<EstimatorSettings transport={admin.transport} nonce="abc" />);
    const two = await mount(<EstimatorSettings transport={admin.transport} nonce="abc" />);
    expect(document.querySelectorAll("style#aiew-styles")).toHaveLength(1);
    expect(document.querySelectorAll("style#aiew-admin-styles")).toHaveLength(1);
    expect(document.querySelector("style#aiew-admin-styles")!.getAttribute("nonce")).toBe("abc");
    await one.unmount();
    await two.unmount();
  });
});
