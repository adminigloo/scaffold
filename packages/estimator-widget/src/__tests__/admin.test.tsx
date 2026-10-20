// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedKeys, embedSnippets } from "../admin/EmbedKeys.js";
import { EstimatorAdmin } from "../admin/EstimatorAdmin.js";
import { EstimatorSettings } from "../admin/EstimatorSettings.js";
import type { EstimatorSettingsPatch } from "../admin/types.js";
import { button, checkbox, click, CONFIG, fail, fakeAdmin, keyWire, labelled, mount, ok, settingsWire, STATUS, submit, text, type } from "./fakes.js";

/**
 * The owner's setup screens (contract 9.7): settings that save section by
 * section with the server's words on the right field, the brand colour shown
 * in both themes, embed keys with a snippet for THIS deployment, and the
 * four-tab shell that shows the notices once.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<EmbedKeys>", () => {
  it("a new key is shown once, with a snippet for this deployment — never adminigloo.com — and a working test", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://summitramps.test/api/estimator/v1/config");
      expect((init?.headers as Record<string, string>)["x-adminigloo-key"]).toBe("esk_live_secret");
      return new Response(JSON.stringify(CONFIG), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const fake = fakeAdmin({
      listKeys: () => ok({ keys: [] }),
      issueKey: (body) => ok({ key: keyWire({ label: body.label, allowedOrigins: body.allowedOrigins ?? [] }), plaintext: "esk_live_secret" }),
    });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} />);
    expect(text(container)).toContain("No keys yet.");
    await type(labelled(container, "Name"), "Main website");
    await type(labelled(container, "Websites it works on"), "https://summitramps.com\nhttps://www.summitramps.com");
    await submit(container.querySelector('[data-aiew-panel="new-key"] form'));
    expect(fake.of("issueKey")[0]!.args[0]).toEqual({ label: "Main website", allowedOrigins: ["https://summitramps.com", "https://www.summitramps.com"] });
    const issued = container.querySelector('[data-aiew-panel="issued"]')!;
    expect((issued.querySelector("[data-aiew-copy] input") as HTMLInputElement).value).toBe("esk_live_secret");
    const modal = text(issued.querySelector('[data-aiew-snippet="modal"]'));
    // The deployment's own address (from the status), never adminigloo.com (ES-15).
    expect(modal).toContain('<EstimatorProvider config={{ baseUrl: "https://summitramps.test/api/estimator", clientKey: "esk_live_secret" }}>');
    expect(modal).toContain("<EstimatorButton />");
    expect(modal).toContain("<EstimatorModal />");
    expect(text(issued.querySelector('[data-aiew-snippet="inline"]'))).toContain('<EstimateTool baseUrl="https://summitramps.test/api/estimator" clientKey="esk_live_secret" />');
    // Each snippet scrolls sideways on a phone, so each takes keyboard focus
    // and is named by the line above it (axe: scrollable-region-focusable).
    for (const kind of ["modal", "inline"]) {
      const pre = issued.querySelector(`[data-aiew-snippet="${kind}"]`)!;
      expect(pre.getAttribute("tabindex"), kind).toBe("0");
      const label = issued.querySelector(`[id="${pre.getAttribute("aria-labelledby")}"]`);
      expect(text(label), kind).toMatch(kind === "modal" ? /^Paste this into the other site/ : /^Or show it in the page/);
    }
    expect(text(container)).not.toContain("adminigloo.com");
    await click(button(issued as HTMLElement, "Test this key"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(text(issued.querySelector("[data-aiew-test]"))).toBe("Works: 3 products on your estimator.");
    await unmount();
  });

  it("the embedBaseUrl prop wins; a failing test says why in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "origin_not_allowed", message: "This estimator isn't set up for this website." } }), { status: 403 })));
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [] }), issueKey: () => ok({ key: keyWire({ allowedOrigins: [] }), plaintext: "esk_x" }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} embedBaseUrl="https://ramps.example/api/estimator/" />);
    await type(labelled(container, "Name"), "Blog");
    await submit(container.querySelector('[data-aiew-panel="new-key"] form'));
    expect(text(container.querySelector('[data-aiew-snippet="modal"]'))).toContain('baseUrl: "https://ramps.example/api/estimator"');
    expect(text(container)).toContain("Works on any website. Add yours.");
    await click(button(container, "Test this key"));
    expect(text(container.querySelector("[data-aiew-test]"))).toBe("This estimator isn't set up for this website yet.");
    await unmount();
  });

  it("the server's issue about a website lands on that field", async () => {
    const fake = fakeAdmin({
      listKeys: () => ok({ keys: [] }),
      issueKey: () => fail("invalid", "invalid", { status: 400, issues: [{ path: ["allowedOrigins", 0], message: "Use the site's address, like https://summitramps.com" }] }),
    });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} />);
    await type(labelled(container, "Name"), "Main website");
    await type(labelled(container, "Websites it works on"), "summitramps.com/estimate");
    await submit(container.querySelector('[data-aiew-panel="new-key"] form'));
    expect(text(container)).toContain("Use the site's address, like https://summitramps.com");
    expect(labelled(container, "Websites it works on")!.getAttribute("aria-invalid")).toBe("true");
    await unmount();
  });

  it("existing keys: their websites (or a warning), edit them, and revoke after a confirmation", async () => {
    const fake = fakeAdmin({
      listKeys: () => ok({ keys: [keyWire(), keyWire({ id: "k_2", label: "Old site", allowedOrigins: [] })] }),
      updateKey: (_id, body) => ok({ key: keyWire({ allowedOrigins: body.allowedOrigins ?? [] }) }),
      revokeKey: () => ok({ key: keyWire({ id: "k_2", label: "Old site", allowedOrigins: [], revokedAt: "2026-11-02T00:00:00.000Z" }) }),
    });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} />);
    const main = container.querySelector('[data-aiew-key="k_1"]')!;
    expect(text(main)).toContain("Works on: https://summitramps.com");
    expect(container.querySelector('[data-aiew-key="k_2"] [data-aiew-any-site]')).not.toBeNull();
    await click(button(main as HTMLElement, "Edit websites"));
    await type(labelled(main, "Websites it works on"), "https://summitramps.com\nhttps://shop.summitramps.com");
    await submit(main.querySelector("form"));
    expect(fake.of("updateKey")[0]!.args).toEqual(["k_1", { allowedOrigins: ["https://summitramps.com", "https://shop.summitramps.com"] }]);
    await click(button(container.querySelector('[data-aiew-key="k_2"]') as HTMLElement, "Revoke"));
    expect(fake.of("revokeKey")).toHaveLength(0);
    await click(button(container, "Revoke the key"));
    expect(fake.of("revokeKey")[0]!.args).toEqual(["k_2"]);
    expect(text(container)).toContain("Revoked keys (1)");
    await unmount();
  });

  it("the snippet helper builds both variants from any base", () => {
    const s = embedSnippets("https://x.test/api/estimator", "esk_1");
    expect(s.modal).toContain('baseUrl: "https://x.test/api/estimator", clientKey: "esk_1"');
    expect(s.inline).toContain('<EstimateTool baseUrl="https://x.test/api/estimator" clientKey="esk_1" />');
  });
});

describe("<EstimatorSettings>", () => {
  it("a section saves only its own fields, says 'Saved', and refreshes the notices", async () => {
    let saved: EstimatorSettingsPatch | null = null;
    const fake = fakeAdmin({
      updateSettings: (patch) => {
        saved = patch;
        return ok({ settings: settingsWire({ quoteValidDays: 21 }) });
      },
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const quotes = container.querySelector('[data-aiew-panel="quotes"]')!;
    await type(labelled(quotes, "Quotes are good for"), "21");
    expect(text(quotes)).toContain("Unsaved changes");
    await submit(quotes.querySelector("form"));
    expect(saved).toEqual({ quoteValidDays: 21, followUpDays: 3, quoteFooter: null });
    expect(text(quotes)).toContain("Saved");
    expect(fake.of("status").length).toBeGreaterThanOrEqual(2);
    await unmount();
  });

  it("the server's issue lands on the field it names", async () => {
    const fake = fakeAdmin({
      updateSettings: () => fail("invalid", "invalid", { status: 400, issues: [{ path: ["contactPhone"], message: "Keep the phone number under 40 characters." }] }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const business = container.querySelector('[data-aiew-panel="business"]')!;
    await type(labelled(business, "Contact phone"), "(801) 555-0143 ext 99999999999999999999");
    await submit(business.querySelector("form"));
    expect(text(business)).toContain("Keep the phone number under 40 characters.");
    expect(labelled(business, "Contact phone")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(business)).toContain("Check the highlighted fields.");
    await unmount();
  });

  it("checks what it can before sending: a tax rate over 30% never leaves the page", async () => {
    const fake = fakeAdmin({ updateSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const pricing = container.querySelector('[data-aiew-panel="pricing"]')!;
    await type(labelled(pricing, "Sales tax"), "45");
    expect(text(pricing)).toContain("Enter a tax rate from 0% to 30%.");
    expect((button(pricing as HTMLElement, "Save") as HTMLButtonElement).disabled).toBe(true);
    await type(labelled(pricing, "Sales tax"), "7.25");
    await type(labelled(pricing, "Default hourly labor rate"), "70");
    await submit(pricing.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toEqual({ taxRateBp: 725, currency: "USD", defaultLaborRateCents: 7000, contingencyBp: 0 });
    await unmount();
  });

  it("the brand colour shows a live sample on a light and a dark page", async () => {
    const fake = fakeAdmin({ updateSettings: (patch) => ok({ settings: settingsWire({ brandColor: patch.brandColor ?? null }) }) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const business = container.querySelector('[data-aiew-panel="business"]')!;
    await type(labelled(business, "Brand colour"), "#7C3AED");
    const light = business.querySelector<HTMLElement>('[data-aiew-sample="light"]')!;
    const dark = business.querySelector<HTMLElement>('[data-aiew-sample="dark"]')!;
    expect(light.getAttribute("data-theme")).toBe("light");
    expect(dark.getAttribute("data-theme")).toBe("dark");
    expect(light.style.getPropertyValue("--aiew-bl-accent")).toBe("#7c3aed");
    expect(dark.style.getPropertyValue("--aiew-bd-accent")).toBe("#7c3aed");
    await submit(business.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toMatchObject({ brandColor: "#7c3aed" });
    await unmount();
  });

  it("lead alerts: up to five addresses; photos and AI: the switches, the daily limit and what reading has cost", async () => {
    const fake = fakeAdmin({
      updateSettings: (patch) => ok({ settings: settingsWire(patch as never) }),
      usage: () => ok({ model: "claude-haiku-4-5", days: [], totals: { readings: 214, costMicros: 240_000, averageCostMicros: 1100 } }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const alerts = container.querySelector('[data-aiew-panel="alerts"]')!;
    await click(button(alerts as HTMLElement, "Add an address"));
    await type(labelled(alerts, "Alert email 2"), "pat@summit.test");
    await submit(alerts.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toEqual({ leadNotifyEmails: ["office@summit.test", "pat@summit.test"] });

    const photos = container.querySelector('[data-aiew-panel="photos"]')!;
    expect(text(photos.querySelector("[data-aiew-spend]"))).toBe("Photo readings: 12 today, $0.01; 214 this month, $0.24. About $0.0011 a photo.");
    await type(labelled(photos, "Most photo reading may cost per day"), "2.50");
    await click(checkbox(photos, "Take photos"));
    await submit(photos.querySelector("form"));
    expect(fake.of("updateSettings")[1]!.args[0]).toEqual({ photosEnabled: false, aiDailyBudgetCents: 250, aiPerRequesterDaily: 5 });
    await unmount();
  });

  it("someone who can't see the settings is told so in place of them", async () => {
    const fake = fakeAdmin({ getSettings: () => fail("forbidden", "You don't have permission to do that.") });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    expect(text(container.querySelector('[data-aiew-notice="forbidden"]'))).toBe("You don't have permission to do that.");
    expect(container.querySelector('[data-aiew-panel="business"]')).toBeNull();
    await unmount();
  });
});

describe("<EstimatorAdmin>", () => {
  it("four tabs; the notices show once at the top; the queue opens an estimate in place and comes back", async () => {
    const fake = fakeAdmin({
      status: () => ok({ ...STATUS, notices: [{ code: "settings_not_saved", message: "Set your business details, tax rate and quote rules in Settings." }] }),
      listEstimates: () => ok({ estimates: [], nextCursor: null, counts: { leads: 0, drafts: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0, all: 0, archived: 0 } }),
      createEstimate: async () => ok({ estimate: (await import("./fakes.js")).estimate({ id: "est_new", lines: [] }), warnings: [] }),
      getEstimate: async () => ok({ estimate: (await import("./fakes.js")).estimate({ id: "est_new", lines: [] }) }),
      listProducts: () => ok({ products: [] }),
      listSupplies: () => ok({ supplies: [] }),
      listKeys: () => ok({ keys: [] }),
    });
    const { container, unmount } = await mount(<EstimatorAdmin transport={fake.transport} />);
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => text(t))).toEqual(["Estimates", "Price book", "Settings", "Website embed"]);
    expect(container.querySelectorAll("[data-notice]")).toHaveLength(1);
    expect(fake.of("status")).toHaveLength(1);
    await click(button(container, "New estimate"));
    expect(text(container)).toContain("EST-0001");
    await click(button(container, "Back to estimates"));
    expect(text(container)).toContain("No estimate requests yet");
    // Arrow keys move between tabs.
    const first = container.querySelector<HTMLButtonElement>('[data-tab="estimates"]')!;
    first.focus();
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(container.querySelector('[data-tab="pricebook"]')!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(container.querySelector('[data-tab="pricebook"]'));
    expect(text(container)).toContain("No products yet.");
    await click(container.querySelector('[data-tab="settings"]'));
    expect(text(container)).toContain("Estimate settings");
    await click(container.querySelector('[data-tab="keys"]'));
    expect(text(container)).toContain("Website embed");
    // Still one notice, still one status read.
    expect(container.querySelectorAll("[data-notice]")).toHaveLength(1);
    expect(fake.of("status")).toHaveLength(1);
    await unmount();
  });

  it("takes the business's brand colour from its settings", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ brandColor: "#1d4ed8" }) }),
      listEstimates: () => ok({ estimates: [], nextCursor: null, counts: { leads: 0, drafts: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0, all: 0, archived: 0 } }),
    });
    const { container, unmount } = await mount(<EstimatorAdmin transport={fake.transport} sections={["estimates"]} />);
    const root = container.querySelector<HTMLElement>(".aiew-root.aiew-admin")!;
    expect(root.style.getPropertyValue("--aiew-bl-accent")).toBe("#1d4ed8");
    await unmount();
  });
});

describe("noCodeSnippets (review T2A-BO-02)", () => {
  it("a one-line button in the business's colour with readable text, and a page frame; the address is escaped", async () => {
    const { noCodeSnippets } = await import("../admin/EmbedKeys.js");
    const dark = noCodeSnippets("https://app.example/t/green-acres/estimate", "#1F7A3A");
    expect(dark.button).not.toContain("\n");
    expect(dark.button).toContain("background:#1f7a3a;color:#ffffff");
    const light = noCodeSnippets("https://app.example/t/x/estimate", "#f5e663");
    expect(light.button).toContain("color:#111111");
    expect(noCodeSnippets("https://app.example/e", "not a colour").button).toContain("background:#1f2937");
    const odd = noCodeSnippets('https://app.example/t/a"b/estimate?x=1&y=2', null);
    expect(odd.button).toContain('href="https://app.example/t/a&quot;b/estimate?x=1&amp;y=2"');
    expect(odd.frame).toContain('src="https://app.example/t/a&quot;b/estimate?x=1&amp;y=2"');
    expect(odd.frame).toContain('title="Instant estimate"');
  });
});
