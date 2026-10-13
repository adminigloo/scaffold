// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompaniesConsole } from "../admin/CompaniesConsole.js";
import { injectTenancyAdminStyles } from "../admin/styles.js";
import { WidgetRoot } from "../parts.js";
import { SetupChecklist } from "../SetupChecklist.js";
import { injectTenancyStyles } from "../styles.js";
import { resolveHostTheme } from "../theme.js";
import { checklist, fakeAdmin, fakeTenancy, mount, ok, settle } from "./fakes.js";

/**
 * The theme contract (8.2): "auto" asks the host page first (data-theme on
 * an ancestor, body or html; then a dark/light class; then color-scheme;
 * then what the widget sits on; then the OS) and follows it live. Styles go
 * in once, with the nonce, for both entries.
 */

const osDark = () => ({ matches: true });
const osLight = () => ({ matches: false });

afterEach(() => {
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
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

  it("with nothing to go on, the browser's light canvas: a dark OS alone doesn't paint a dark card on a white page", () => {
    expect(resolveHostTheme(widget(), osDark)).toBe("light");
  });
});

describe("the theme on a mounted component", () => {
  it("writes data-theme once mounted, and follows the host's class live", async () => {
    const f = fakeTenancy({ checklist: () => ok(checklist()) });
    const { container, unmount } = await mount(
      <StrictMode>
        <SetupChecklist transport={f.transport} tenantId="t" initial={checklist()} />
      </StrictMode>,
    );
    const root = container.querySelector(".aitw-root")!;
    expect(root.getAttribute("data-theme")).toBe("light");
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    await settle();
    expect(root.getAttribute("data-theme")).toBe("dark");
    await unmount();
  });

  it("a pinned theme is written as given", async () => {
    document.documentElement.classList.add("dark");
    const { container, unmount } = await mount(<SetupChecklist transport={fakeTenancy({}).transport} tenantId="t" initial={checklist()} theme="light" />);
    expect(container.querySelector(".aitw-root")!.getAttribute("data-theme")).toBe("light");
    await unmount();
  });
});

describe("style injection", () => {
  it("puts the nonce on the style tag and never duplicates it", async () => {
    const a = await mount(<WidgetRoot nonce="n0nce">a</WidgetRoot>);
    const b = await mount(<WidgetRoot nonce="n0nce">b</WidgetRoot>);
    injectTenancyStyles({ nonce: "other" });
    const tags = document.querySelectorAll("style#aitw-styles");
    expect(tags).toHaveLength(1);
    expect(tags[0]!.getAttribute("nonce")).toBe("n0nce");
    await a.unmount();
    await b.unmount();
  });

  it("the admin entry adds its own sheet once, beside the widget's", async () => {
    const f = fakeAdmin({ companies: () => ok({ companies: [], total: 0, page: 1, pageSize: 25 }) });
    const one = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} nonce="abc" />);
    const two = await mount(<CompaniesConsole transport={f.transport} detailHref={(id) => id} nonce="abc" />);
    injectTenancyAdminStyles({ nonce: "zzz" });
    expect(document.querySelectorAll("style#aitw-styles")).toHaveLength(1);
    expect(document.querySelectorAll("style#aitw-admin-styles")).toHaveLength(1);
    expect(document.querySelector("style#aitw-admin-styles")!.getAttribute("nonce")).toBe("abc");
    expect(one.container.querySelector(".aitw-root")!.className).toContain("aitw-admin");
    await one.unmount();
    await two.unmount();
  });
});
