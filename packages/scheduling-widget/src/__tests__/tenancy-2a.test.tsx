// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import { ManageVisit } from "../ManageVisit.js";
import { brandTokens, CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, LIGHT_TOKENS, schedulingWidgetCss } from "../styles.js";
import { VisitPicker } from "../VisitPicker.js";
import { availability, button, CONFIG, fail, fakeAdmin, fakePublic, mount, ok, resource, settingsWire, slotsResponse, submit, text, type } from "./fakes.js";

/**
 * scheduling-widget 0.2 (Tenancy 2a, 6.10): the business's own colour as the
 * accent with every pair still AA, the business's own "closed" sentence
 * (no retry), company-owned settings read-only and never sent, the invite
 * hint, the checklist's deep links, and the SettingsWire field both sides
 * now carry.
 */

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
});

const CLOSED = "Green Acres isn't taking requests online right now. Call (801) 555-0100.";

describe("accentColor", () => {
  const colours = ["#1f7a3a", "#ffd400", "#ffffff", "#000000", "#c2410c", "#7c3aed", "#00b3b3", "#808080"];
  for (const colour of colours) {
    for (const theme of ["light", "dark"] as const) {
      it(`${colour} keeps every accent pair AA in ${theme}`, () => {
        const palette = { ...(theme === "dark" ? { ...LIGHT_TOKENS, ...DARK_TOKENS } : LIGHT_TOKENS), ...brandTokens(colour, theme) };
        // What a branded root prints in the brand: the accent as text
        // (accent-ink), the text on the accent, and the focus ring. The raw
        // accent is only ever a fill or a boundary there; the staff screens,
        // which still print it as text, are never branded.
        for (const [fg, bg, min] of CONTRAST_PAIRS) {
          if (!["accent-ink", "on-accent", "focus"].includes(fg)) continue;
          expect(contrastRatio(palette[fg]!, palette[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        }
      });
    }
  }

  it("brands the picker and the manage page; null or nothing keeps the stylesheet's", async () => {
    const pub = fakePublic({ config: () => ok(CONFIG), slots: () => ok(slotsResponse()) });
    const branded = await mount(<VisitPicker transport={pub.transport} accentColor="#1F7A3A" />);
    const root = branded.container.querySelector<HTMLElement>(".aisw-root")!;
    expect(root.hasAttribute("data-brand")).toBe(true);
    expect(root.getAttribute("style")).toContain("--aisw-bl-accent: #1f7a3a");
    await branded.unmount();
    for (const accent of [null, undefined, "teal"]) {
      const plain = await mount(<VisitPicker transport={pub.transport} accentColor={accent as string | null | undefined} />);
      expect(plain.container.querySelector(".aisw-root")!.hasAttribute("data-brand")).toBe(false);
      await plain.unmount();
    }
    const manage = await mount(<ManageVisit transport={fakePublic({ visit: () => new Promise(() => {}) }).transport} token="t" accentColor="#c2410c" />);
    expect(manage.container.querySelector(".aisw-root")!.getAttribute("style")).toContain("--aisw-bl-accent: #c2410c");
    await manage.unmount();
  });

  it("links and an unpicked time read in accent-ink, which the brand steps until AA", () => {
    const css = schedulingWidgetCss();
    expect(css).toContain(".aisw-root a:not(.aisw-btn) { color: var(--aisw-accent-ink);");
    expect(css).toMatch(/\.aisw-time \{[^}]*color: var\(--aisw-accent-ink\)/);
    expect(css).toContain(':where(.aisw-root[data-brand]) { --aisw-accent: var(--aisw-bl-accent);');
  });
});

describe("closed by the business (409 booking_closed)", () => {
  it("<VisitPicker> shows the server's sentence and offers no retry", async () => {
    const pub = fakePublic({ config: () => fail("booking_closed", CLOSED, { status: 409 }) });
    const { container, unmount } = await mount(<VisitPicker transport={pub.transport} />);
    expect(text(container)).toBe(CLOSED);
    expect(button(container, "Try again")).toBeNull();
    expect(container.querySelector("[data-aisw-picker]")?.getAttribute("data-aisw-picker")).toBe("closed");
    await unmount();
  });

  it("<ManageVisit> shows the server's sentence for its visit load", async () => {
    const pub = fakePublic({ visit: () => fail("booking_closed", CLOSED, { status: 409 }) });
    const { container, unmount } = await mount(<ManageVisit transport={pub.transport} token="tok" />);
    expect(text(container)).toBe(CLOSED);
    expect(button(container, "Try again")).toBeNull();
    await unmount();
  });

  it("a plain network failure still offers Try again", async () => {
    const pub = fakePublic({ config: () => fail("network", "offline") });
    const { container, unmount } = await mount(<VisitPicker transport={pub.transport} />);
    expect(button(container, "Try again")).not.toBeNull();
    await unmount();
  });
});

describe("<SchedulingSettings> in a company", () => {
  function admin(extra: Parameters<typeof fakeAdmin>[0] = {}, managed: { href: string | null } | null = { href: "/settings/company#details" }) {
    return fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ businessName: "Green Acres", managedByCompany: managed }) }),
      listResources: () => ok({ resources: [resource()] }),
      getAvailability: () => ok(availability()),
      people: () => ok({ people: [{ userId: "u1", name: "Cam Crew", email: "cam@greenacres.test" }] }),
      ...extra,
    });
  }

  it("shows the business name, zone and contact read-only with the link, and its Save sends none of them", async () => {
    const fake = admin({ updateSettings: (patch) => ok({ settings: settingsWire({ businessName: "Green Acres", managedByCompany: { href: "/settings/company#details" }, ...(patch as object) }) }) });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    const card = container.querySelector<HTMLElement>('[data-aisw-card="business"]')!;
    const managed = card.querySelector("[data-aisw-managed]")!;
    expect(text(managed)).toContain("These come from your company settings.");
    expect(managed.querySelector("a")?.getAttribute("href")).toBe("/settings/company#details");
    expect(text(managed.querySelector("a"))).toBe("Change them in company settings");
    expect(text(managed)).toContain("Green Acres");
    expect(text(managed)).toContain("office@acme.test");
    expect(text(managed)).toContain("(801) 555-0143");
    expect(card.querySelector("select")).toBeNull();
    expect([...card.querySelectorAll("label")].map((l) => text(l))).not.toContain("Business name");
    expect(card.querySelector("[data-aisw-zone-warning]")).toBeNull();
    await type(card.querySelector('input[aria-label="Alert email 1"]'), "crew-lead@greenacres.test");
    await submit(card.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toEqual({ staffNotifyEmails: ["crew-lead@greenacres.test"] });
    await unmount();
  });

  it("an empty alerts list says where the alerts go instead, and the hint goes once an address is typed (review T2A-BO-14)", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ staffNotifyEmails: [], managedByCompany: { href: "/settings/company#details" } }) }),
      listResources: () => ok({ resources: [resource()] }),
      getAvailability: () => ok(availability()),
    });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    const hint = container.querySelector("[data-aisw-alerts-default]");
    expect(text(hint)).toBe("Leave it empty and alerts go to office@acme.test, your company's contact email.");
    await type(container.querySelector('input[aria-label="Alert email 1"]'), "crew-lead@greenacres.test");
    expect(container.querySelector("[data-aisw-alerts-default]")).toBeNull();
    await unmount();
  });

  it("a notice's link is shown when the server gives one (T2A-BO-07)", async () => {
    const { AdminNotices } = await import("../admin/ui.js");
    const { container, unmount } = await mount(
      <AdminNotices
        notices={[
          { code: "setup_zone", tone: "warn", message: "Your company's time zone isn't set yet.", link: { href: "/settings/company#details", label: "Open company settings" } },
          { code: "booking_off", tone: "warn", message: "Online booking is off." },
        ]}
      />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Open company settings", "/settings/company#details"]]);
    await unmount();
  });

  it("with href null, says where they come from without a link", async () => {
    const fake = admin({}, { href: null });
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    const managed = container.querySelector("[data-aisw-managed]")!;
    expect(text(managed)).toContain("These come from your company settings.");
    expect(managed.querySelector("a")).toBeNull();
    await unmount();
  });

  it("not managed: 0.1's editable card", async () => {
    const fake = admin({}, null);
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    expect(container.querySelector("[data-aisw-managed]")).toBeNull();
    expect([...container.querySelectorAll("label")].map((l) => text(l))).toContain("Business name");
    await unmount();
  });

  it("inviteHref changes the crew picker's hint to the Team page", async () => {
    const fake = admin();
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["crews"]} inviteHref="/settings/team" />);
    await (async () => {
      const add = button(container, "Add a crew") ?? button(container, "+ Add a crew");
      if (add) add.click();
    })();
    const hint = [...container.querySelectorAll(".aisw-hint")].find((h) => text(h).includes("Not listed?"));
    expect(hint).toBeDefined();
    expect(text(hint)).toContain("Not listed? Invite them on the Team page.");
    expect(hint!.querySelector("a")?.getAttribute("href")).toBe("/settings/team");
    expect(text(container)).not.toContain("Ask them to sign in once");
    await unmount();
  });

  it("opening with #booking, #crews or #hours focuses that card's heading", async () => {
    for (const hash of ["booking", "crews", "hours"]) {
      window.location.hash = `#${hash}`;
      const fake = admin();
      const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} />);
      const heading = container.querySelector(`[data-aisw-card="${hash}"] .aisw-card-title`);
      expect(document.activeElement, hash).toBe(heading);
      expect(container.querySelector(`section#${hash}`), hash).not.toBeNull();
      await unmount();
    }
  });
});

describe("wire", () => {
  it("both copies of SettingsWire carry managedByCompany, and the patch can't send it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const widget = readFileSync(resolve(here, "../admin/types.ts"), "utf8");
    const server = readFileSync(resolve(here, "../../../scheduling/src/wire.ts"), "utf8");
    for (const source of [widget, server]) {
      expect(source).toContain("managedByCompany: { href: string | null } | null;");
      expect(source).toContain('Omit<SettingsWire, "saved" | "updatedAt" | "managedByCompany">');
    }
  });
});

describe("notice links from the server (T2A-BO-04 / T2A-BO-07)", () => {
  it("keeps a path or an http(s) link and the new crew code; drops a script URL", async () => {
    const { parseAdminStatus } = await import("../admin/client.js");
    const status = parseAdminStatus({
      customerEmails: true,
      reminders: true,
      upcomingVisits: 0,
      notices: [
        { code: "crew_unlinked", tone: "warn", message: "Cam joined.", link: { href: "/app/schedule/settings#crews", label: "Pick their crew" } },
        { code: "setup_zone", tone: "warn", message: "Zone.", link: { href: "javascript:alert(1)", label: "Bad" } },
        { code: "setup_contact", tone: "warn", message: "Phone.", link: { href: "//evil.example/x", label: "Bad" } },
      ],
    });
    expect(status!.notices[0]).toEqual({ code: "crew_unlinked", tone: "warn", message: "Cam joined.", link: { href: "/app/schedule/settings#crews", label: "Pick their crew" } });
    expect(status!.notices[1]!.link).toBeUndefined();
    expect(status!.notices[2]!.link).toBeUndefined();
  });
});
