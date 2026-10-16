// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSettingsWire } from "../admin/client.js";
import { CrewDay } from "../admin/CrewDay.js";
import { fillIdPattern } from "../admin/helpers.js";
import { ScheduleCalendar } from "../admin/ScheduleCalendar.js";
import { SchedulingSettings } from "../admin/SchedulingSettings.js";
import type { SettingsPatch } from "../admin/types.js";
import { availability, calendar, crewDay, fail, fakeAdmin, labelled, mount, ok, resource, settingsWire, settle, snapshot, submit, text, type } from "./fakes.js";

/**
 * scheduling-widget 0.3 (Tenancy 2b-1, contract 9.8): the new-request alert
 * list managed in Alert settings (shown as a link, never sent), the calendar
 * opening on one visit (in range, or fetched from another week, or a plain
 * notice when it's gone), and the "Photos and files" links from a visit and
 * from today's route.
 */

afterEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

function settingsAdmin(settings = settingsWire({ alertRecipients: { href: "/app/alerts/settings" } })) {
  return fakeAdmin({
    getSettings: () => ok({ settings }),
    updateSettings: (patch) => ok({ settings: { ...settings, ...(patch as Partial<typeof settings>) } }),
    listResources: () => ok({ resources: [resource()] }),
    getAvailability: () => ok(availability()),
  });
}

const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-aisw-card="${id}"]`)!;

describe("<SchedulingSettings>: alerts chosen in Alert settings (9.8)", () => {
  it("the address list becomes a sentence and a link; a save never sends the list", async () => {
    const fake = settingsAdmin();
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} />);
    const business = card(container, "business");
    const managed = business.querySelector("[data-aisw-alerts-managed]")!;
    expect(text(managed)).toContain("Who gets new-request alerts is chosen in Alert settings.");
    const link = managed.querySelector("a")!;
    expect(text(link)).toBe("Open Alert settings");
    expect(link.getAttribute("href")).toBe("/app/alerts/settings");
    expect(text(business)).not.toContain("Send new-request alerts to");
    expect(business.querySelector('[aria-label="Alert email 1"]')).toBeNull();

    await type(labelled(business, "Business name"), "Acme Window Co.");
    await submit(business.querySelector("form"));
    const patch = fake.of("updateSettings")[0]!.args[0] as SettingsPatch;
    expect(patch.businessName).toBe("Acme Window Co.");
    expect("staffNotifyEmails" in patch).toBe(false);
    expect(text(business)).toContain("Saved");
    await unmount();
  });

  it("no link when the server names no place; and 2a's list when alerts aren't routed", async () => {
    const quiet = settingsAdmin(settingsWire({ alertRecipients: { href: null } }));
    const a = await mount(<SchedulingSettings transport={quiet.transport} sections={["business"]} />);
    const managed = a.container.querySelector("[data-aisw-alerts-managed]")!;
    expect(text(managed)).toContain("Who gets new-request alerts is chosen in Alert settings.");
    expect(managed.querySelector("a")).toBeNull();
    await a.unmount();

    const plain = settingsAdmin(settingsWire());
    const b = await mount(<SchedulingSettings transport={plain.transport} sections={["business"]} />);
    expect(b.container.querySelector("[data-aisw-alerts-managed]")).toBeNull();
    expect(text(b.container)).toContain("Send new-request alerts to");
    await b.unmount();
  });

  it("with the company's details AND the alerts managed elsewhere, the card has nothing to save", async () => {
    const fake = settingsAdmin(settingsWire({ managedByCompany: { href: "/settings/company#details" }, alertRecipients: { href: "/app/alerts/settings" } }));
    const { container, unmount } = await mount(<SchedulingSettings transport={fake.transport} sections={["business"]} />);
    const business = card(container, "business");
    expect(text(business)).toContain("These come from your company settings.");
    expect(text(business)).toContain("Who gets new-request alerts is chosen in Alert settings.");
    expect([...business.querySelectorAll("button")].map((b) => text(b))).not.toContain("Save");
    expect(business.querySelector("input")).toBeNull();
    await unmount();
  });
});

describe("parseSettingsWire: alertRecipients", () => {
  it("absent (an older server) is null; a path or http(s) is kept; a script URL never is", () => {
    const base = { ...settingsWire() } as Record<string, unknown>;
    delete base.alertRecipients;
    expect(parseSettingsWire(base)!.alertRecipients).toBeNull();
    expect(parseSettingsWire({ ...base, alertRecipients: { href: "/app/alerts/settings" } })!.alertRecipients).toEqual({ href: "/app/alerts/settings" });
    expect(parseSettingsWire({ ...base, alertRecipients: { href: null } })!.alertRecipients).toEqual({ href: null });
    expect(parseSettingsWire({ ...base, alertRecipients: { href: "javascript:alert(1)" } })!.alertRecipients).toEqual({ href: null });
    expect(parseSettingsWire({ ...base, alertRecipients: { href: "//evil.example" } })!.alertRecipients).toEqual({ href: null });
  });
});

describe("<ScheduleCalendar initialVisitId> (9.8)", () => {
  const panel = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-aisw-panel]");

  it("opens a visit that is on screen, without a click", async () => {
    const fake = fakeAdmin({
      calendar: () => ok(calendar()),
      getSettings: () => ok({ settings: settingsWire() }),
    });
    const { container, unmount } = await mount(
      <ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" initialVisitId="v1" pollMs={0} />,
    );
    expect(panel(container)).not.toBeNull();
    expect(text(panel(container))).toContain("Booked online");
    expect(fake.of("getVisit")).toHaveLength(0);
    await unmount();
  });

  it("a visit from another week is fetched, and the calendar moves to its day", async () => {
    const away = snapshot({ id: "far", date: "2026-12-14", startsAt: "2026-12-14T16:00:00.000Z", endsAt: "2026-12-14T17:00:00.000Z", customerName: "Lee Park" });
    const fake = fakeAdmin({
      calendar: (q) => ok(q.from <= "2026-12-14" && q.to >= "2026-12-14" ? calendar({ from: q.from, to: q.to, visits: [away] }) : calendar({ from: q.from, to: q.to })),
      getSettings: () => ok({ settings: settingsWire() }),
      getVisit: (id) => (id === "far" ? ok({ visit: away }) : fail("not_found", "Not found", { status: 404 })),
    });
    const { container, unmount } = await mount(
      <ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" initialVisitId="far" pollMs={0} />,
    );
    await settle();
    expect(fake.of("getVisit").map((c) => c.args[0])).toEqual(["far"]);
    expect(panel(container)).not.toBeNull();
    expect(text(panel(container))).toContain("Lee Park");
    // The calendar asked for the visit's own day.
    expect(fake.of("calendar").some((c) => (c.args[0] as { from: string }).from === "2026-12-14")).toBe(true);
    await unmount();
  });

  it("a visit that isn't found: a notice, no panel", async () => {
    const fake = fakeAdmin({
      calendar: () => ok(calendar()),
      getSettings: () => ok({ settings: settingsWire() }),
      getVisit: () => fail("not_found", "Not found", { status: 404 }),
    });
    const { container, unmount } = await mount(
      <ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" initialVisitId="gone" pollMs={0} />,
    );
    await settle();
    expect(panel(container)).toBeNull();
    expect(text(container.querySelector("[data-aisw-visit-missing]"))).toContain("That visit couldn't be found.");
    await unmount();
  });
});

describe("photos and files links (9.8)", () => {
  it("fillIdPattern encodes the id", () => {
    expect(fillIdPattern("/app/schedule/visits/{id}/files", "a b/c?d")).toBe("/app/schedule/visits/a%20b%2Fc%3Fd/files");
  });

  it("the visit panel links 'Photos and files' to the visit's page; none without the pattern", async () => {
    const fake = fakeAdmin({ calendar: () => ok(calendar({ visits: [snapshot({ id: "v 1" })] })), getSettings: () => ok({ settings: settingsWire() }) });
    const withFiles = await mount(
      <ScheduleCalendar
        transport={fake.transport}
        initialView="day"
        initialDate="2026-11-02"
        initialVisitId="v 1"
        visitFilesHref="/app/schedule/visits/{id}/files"
        pollMs={0}
      />,
    );
    const link = withFiles.container.querySelector("[data-aisw-visit-files] a")!;
    expect(text(link)).toBe("Photos and files");
    expect(link.getAttribute("href")).toBe("/app/schedule/visits/v%201/files");
    await withFiles.unmount();

    const without = await mount(<ScheduleCalendar transport={fake.transport} initialView="day" initialDate="2026-11-02" initialVisitId="v 1" pollMs={0} />);
    expect(without.container.querySelector("[data-aisw-panel]")).not.toBeNull();
    expect(without.container.querySelector("[data-aisw-visit-files]")).toBeNull();
    await without.unmount();
  });

  it("today's route shows 'Photos' on each stop, linking to that visit's page", async () => {
    const fake = fakeAdmin({ crewDay: () => ok(crewDay()) });
    const { container, unmount } = await mount(<CrewDay transport={fake.transport} filesHref="/app/schedule/visits/{id}/files" />);
    const links = [...container.querySelectorAll<HTMLAnchorElement>("[data-aisw-stop-files]")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/app/schedule/visits/v1/files", "/app/schedule/visits/v2/files"]);
    expect(links.every((a) => a.className.includes("aisw-btn"))).toBe(true);
    expect(text(links[0])).toBe("Photos for Jane Doe");
    await unmount();
    const plain = await mount(<CrewDay transport={fakeAdmin({ crewDay: () => ok(crewDay()) }).transport} />);
    expect(plain.container.querySelector("[data-aisw-stop-files]")).toBeNull();
    await plain.unmount();
  });
});

describe("wire (9.7)", () => {
  it("both copies of SettingsWire carry alertRecipients, and the patch can't send it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const widget = readFileSync(resolve(here, "../admin/types.ts"), "utf8");
    const server = readFileSync(resolve(here, "../../../scheduling/src/wire.ts"), "utf8");
    const line =
      "  /** Who gets the new-request alerts is chosen in Alert settings (Tenancy 2b-1): show this link instead of the address list. null = the list is edited here. */\n  alertRecipients: { href: string | null } | null;\n}";
    for (const source of [widget, server]) {
      expect(source.replace(/\r\n/g, "\n")).toContain(line);
      expect(source).toContain('Omit<SettingsWire, "saved" | "updatedAt" | "managedByCompany" | "alertRecipients">');
    }
  });
});
