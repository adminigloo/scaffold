// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySwitcher, shortName } from "../CompanySwitcher.js";
import { tenancyWidgetCss } from "../styles.js";
import { click, company, fail, fakeTenancy, key, mount, ok, onboardingSession, session, settle, spoken, text } from "./fakes.js";

/**
 * <CompanySwitcher> (contract 8.4): the header button names the company
 * you're in; its menu is a real ARIA menu (menuitemradio, checked on the
 * active one) driven by the keyboard; choosing another company is a
 * `setActive` then a full reload; a suspended company is labelled but still
 * choosable; someone with no company gets the way to set one up.
 */

let assign: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const trigger = (root: ParentNode) => root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const items = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')];

describe("<CompanySwitcher>", () => {
  it("names the active company, renders with no fetch from a server session, and opens a menu of them", async () => {
    const f = fakeTenancy({});
    const { container, unmount } = await mount(<CompanySwitcher transport={f.transport} session={session()} />);
    const btn = trigger(container);
    expect(btn.getAttribute("aria-label")).toBe("Summit Window Co., switch company");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("title")).toBe("Summit Window Co.");
    expect(f.calls).toHaveLength(0);
    await click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const menu = container.querySelector('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("Your companies");
    const radios = [...menu.querySelectorAll('[role="menuitemradio"]')];
    expect(radios.map((r) => [spoken(r), r.getAttribute("aria-checked")])).toEqual([
      ["Summit Window Co.", "true"],
      ["Sam's Side Gig Suspended", "false"],
    ]);
    expect(items(container).filter((i) => i.getAttribute("role") === "menuitem").map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["Create another company", "/onboarding?another=1"],
      ["Company settings", "/settings/company"],
      ["Team", "/settings/team"],
    ]);
    // Focus lands on the company you're in.
    expect(document.activeElement).toBe(radios[0]);
    await unmount();
  });

  it("keyboard: ArrowDown opens, arrows and Home/End move and wrap, Escape closes and returns focus", async () => {
    const { container, unmount } = await mount(<CompanySwitcher transport={fakeTenancy({}).transport} session={session()} />);
    const btn = trigger(container);
    btn.focus();
    await key(btn, "ArrowDown");
    const menu = container.querySelector('[role="menu"]')!;
    const list = items(container);
    expect(document.activeElement).toBe(list[0]);
    await key(menu, "ArrowDown");
    expect(document.activeElement).toBe(list[1]);
    await key(menu, "End");
    expect(document.activeElement).toBe(list[list.length - 1]);
    await key(menu, "ArrowDown");
    expect(document.activeElement).toBe(list[0]);
    await key(menu, "ArrowUp");
    expect(document.activeElement).toBe(list[list.length - 1]);
    await key(menu, "Home");
    expect(document.activeElement).toBe(list[0]);
    await key(menu, "Escape");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    await unmount();
  });

  it("Tab and a click outside both close the menu", async () => {
    const { container, unmount } = await mount(<CompanySwitcher transport={fakeTenancy({}).transport} session={session()} />);
    await click(trigger(container));
    await key(container.querySelector('[role="menu"]'), "Tab");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await click(trigger(container));
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await unmount();
  });

  it("choosing another company (a suspended one included) sets it active, then reloads", async () => {
    const f = fakeTenancy({ setActive: (id) => ok({ company: company({ id }) }) });
    const { container, unmount } = await mount(<CompanySwitcher transport={f.transport} session={session()} reloadHref="/home" />);
    await click(trigger(container));
    await click(container.querySelector('[data-company="t-gig"]'));
    expect(f.of("setActive").map((c) => c.args[0])).toEqual(["t-gig"]);
    expect(assign).toHaveBeenCalledWith("/home");
    await unmount();
  });

  it("a refused switch says why inside the menu and doesn't navigate", async () => {
    const f = fakeTenancy({ setActive: () => fail("not_found", "That isn't here any more.") });
    const { container, unmount } = await mount(<CompanySwitcher transport={f.transport} session={session()} />);
    await click(trigger(container));
    await click(container.querySelector('[data-company="t-gig"]'));
    expect(text(container.querySelector('[data-aitw-menu] [role="alert"]'))).toBe("That isn't here any more.");
    expect(assign).not.toHaveBeenCalled();
    await unmount();
  });

  it("no company yet: a link to set one up", async () => {
    const { container, unmount } = await mount(<CompanySwitcher transport={fakeTenancy({}).transport} session={onboardingSession()} noun={{ singular: "shop", plural: "shops" }} />);
    const a = container.querySelector("a")!;
    expect(text(a)).toBe("Set up your shop");
    expect(a.getAttribute("href")).toBe("/onboarding");
    await unmount();
  });

  it("single-business mode: nothing for one workspace; for two, the menu without Create or settings", async () => {
    const personal = session({
      mode: "personal",
      companies: [{ id: "ws-1", name: "Personal", slug: "ws-1", logoUrl: null, role: "owner", status: "active", active: true }],
      company: company({ id: "ws-1", name: "Personal", kind: "personal" }),
    });
    const one = await mount(<CompanySwitcher transport={fakeTenancy({}).transport} session={personal} createHref={null} settingsHref={null} />);
    expect(one.container.innerHTML).toBe("");
    await one.unmount();
    const two = await mount(
      <CompanySwitcher
        transport={fakeTenancy({}).transport}
        session={{ ...personal, companies: [...personal.companies, { id: "ws-2", name: "Pat's workspace", slug: "ws-2", logoUrl: null, role: "member", status: "active", active: false }] }}
        createHref={null}
        settingsHref={null}
      />,
    );
    await click(trigger(two.container));
    expect(items(two.container).map((i) => spoken(i))).toEqual(["Personal", "Pat's workspace", "Team"]);
    await two.unmount();
  });

  it("a long name is cut to 24 characters in the button, whole in the title; a logo replaces the initials", async () => {
    expect(shortName("The Very Long Window Washing Company of Utah")).toBe("The Very Long Window Wa…");
    expect([...shortName("The Very Long Window Washing Company of Utah")]).toHaveLength(24);
    const s = session({ company: company({ name: "The Very Long Window Washing Company of Utah", logoUrl: "https://cdn.test/logo.png" }) });
    const { container, unmount } = await mount(<CompanySwitcher transport={fakeTenancy({}).transport} session={s} />);
    const btn = trigger(container);
    expect(text(btn.querySelector(".aitw-switcher-name"))).toBe("The Very Long Window Wa…");
    expect(btn.getAttribute("title")).toBe("The Very Long Window Washing Company of Utah");
    expect(btn.querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/logo.png");
    await unmount();
  });

  it("without a session prop it asks for one; a failed session renders an empty slot, never an error in the header", async () => {
    const f = fakeTenancy({ session: () => ok(session()) });
    const a = await mount(<CompanySwitcher transport={f.transport} />);
    expect(f.of("session")).toHaveLength(1);
    expect(trigger(a.container)).not.toBeNull();
    await a.unmount();
    const b = await mount(<CompanySwitcher transport={fakeTenancy({ session: () => fail("internal", "boom") }).transport} />);
    expect(text(b.container)).toBe("");
    await b.unmount();
  });
});

describe("<CompanySwitcher> on a phone (review T1-05)", () => {
  it("hangs the menu from the right edge when it would run off the screen", async () => {
    const { container, unmount } = await mount(<CompanySwitcher session={session()} transport={fakeTenancy({}).transport} />);
    const btn = container.querySelector<HTMLButtonElement>(".aitw-switcher-btn")!;
    btn.getBoundingClientRect = () => ({ left: window.innerWidth - 120, right: window.innerWidth - 20, top: 0, bottom: 44, width: 100, height: 44, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await click(btn);
    expect(container.querySelector("[data-aitw-menu]")!.getAttribute("data-align")).toBe("end");
    await unmount();
  });

  it("lets the root shrink in a header row, caps the name on a phone, and keeps only the mark at 320px", () => {
    const css = tenancyWidgetCss();
    expect(css).toContain(".aitw-root[data-aitw-switcher] { display: inline-block; flex: 0 1 auto; min-width: 0; max-width: 100%;");
    expect(css).toMatch(/@media \(max-width: 420px\) \{ \.aitw-switcher-btn \{ max-width: min\(100%, 42vw\); \} \}/);
    expect(css).toMatch(/@media \(max-width: 340px\) \{\s*\.aitw-switcher-name \{ position: absolute;/);
    expect(css).toContain('.aitw-menu[data-align="end"] { left: auto; right: 0; }');
  });
});
