// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSettingsWire } from "../admin/client.js";
import { EstimatorSettings } from "../admin/EstimatorSettings.js";
import type { EstimatorSettingsPatch } from "../admin/types.js";
import { fakeAdmin, labelled, mount, ok, settingsWire, STATUS, submit, text, type } from "./fakes.js";

/**
 * estimator-widget 0.4 (Tenancy 2b-1, contract 10.7): with alerts installed,
 * who gets lead alerts is chosen in Alert settings. The "Lead alerts" panel
 * shows a sentence and the way there instead of the address list, and no
 * form of the estimator's ever sends `leadNotifyEmails`.
 */

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
});

describe("<EstimatorSettings> Lead alerts, chosen in Alert settings (10.7)", () => {
  it("the list becomes a sentence and a link to Alert settings", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire({ alertRecipients: { href: "/app/alerts/settings" } }) }), status: () => ok(STATUS) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["alerts"]} />);
    const managed = container.querySelector("[data-aiew-alerts-managed]")!;
    expect(text(managed)).toContain("Who gets lead alerts is chosen in Alert settings.");
    const link = managed.querySelector("a")!;
    expect(text(link)).toBe("Open Alert settings");
    expect(link.getAttribute("href")).toBe("/app/alerts/settings");
    expect(labelled(container, "Alert email 1")).toBeNull();
    expect(container.querySelector('#alerts form, [id$="alerts"] form')).toBeNull();
    await unmount();
  });

  it("no link when the server names no place", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire({ alertRecipients: { href: null } }) }), status: () => ok(STATUS) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["alerts"]} />);
    const managed = container.querySelector("[data-aiew-alerts-managed]")!;
    expect(text(managed)).toContain("Who gets lead alerts is chosen in Alert settings.");
    expect(managed.querySelector("a")).toBeNull();
    await unmount();
  });

  it("no save on the page sends leadNotifyEmails while alerts are routed", async () => {
    const settings = settingsWire({ alertRecipients: { href: "/app/alerts/settings" } });
    const fake = fakeAdmin({
      getSettings: () => ok({ settings }),
      status: () => ok(STATUS),
      updateSettings: (patch) => ok({ settings: { ...settings, ...(patch as Partial<typeof settings>) } }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const forms = [...container.querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    // Touch a field on the business panel and save every form there is.
    await type(labelled(container, "Business name"), "Summit Ramps & Rails");
    for (const form of forms) await submit(form);
    const patches = fake.of("updateSettings").map((c) => c.args[0] as EstimatorSettingsPatch);
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect("leadNotifyEmails" in patch).toBe(false);
    await unmount();
  });

  it("without alertRecipients, the 0.3 address list as before", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire() }), status: () => ok(STATUS) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["alerts"]} />);
    expect(container.querySelector("[data-aiew-alerts-managed]")).toBeNull();
    expect(labelled(container, "Alert email 1")).not.toBeNull();
    await unmount();
  });
});

describe("parseSettingsWire: alertRecipients", () => {
  it("absent (an older server) is null; a path is kept; a script URL never is", () => {
    const base = { ...settingsWire() } as Record<string, unknown>;
    delete base.alertRecipients;
    expect(parseSettingsWire(base)!.alertRecipients).toBeNull();
    expect(parseSettingsWire({ ...base, alertRecipients: { href: "/app/alerts/settings" } })!.alertRecipients).toEqual({ href: "/app/alerts/settings" });
    expect(parseSettingsWire({ ...base, alertRecipients: { href: null } })!.alertRecipients).toEqual({ href: null });
    expect(parseSettingsWire({ ...base, alertRecipients: { href: "javascript:alert(1)" } })!.alertRecipients).toEqual({ href: null });
  });
});

describe("wire (10.6)", () => {
  it("both copies of EstimatorSettingsWire carry alertRecipients, and the patch can't send it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const widget = readFileSync(resolve(here, "../admin/types.ts"), "utf8").replace(/\r\n/g, "\n");
    const server = readFileSync(resolve(here, "../../../estimator/src/wire.ts"), "utf8").replace(/\r\n/g, "\n");
    const line =
      "  /** Who gets the lead alerts is chosen in Alert settings (Tenancy 2b-1): show this link instead of the address list. null = the list is edited here. */\n  alertRecipients: { href: string | null } | null;\n}";
    const omit = '"managedByCompany" | "aiBudgetCeilingCents" | "alertRecipients">>';
    for (const source of [widget, server]) {
      expect(source).toContain(line);
      expect(source).toContain(omit);
    }
  });
});
