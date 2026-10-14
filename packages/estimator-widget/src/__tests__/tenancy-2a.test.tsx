// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedKeys } from "../admin/EmbedKeys.js";
import { EstimateEditor } from "../admin/EstimateEditor.js";
import { EstimatesQueue, hrefFor } from "../admin/EstimatesQueue.js";
import { EstimatorSettings, NOT_SAVED_READ_ONLY, READ_ONLY_SETTINGS } from "../admin/EstimatorSettings.js";
import { PriceBook, READ_ONLY_PRICE_BOOK, SAMPLE_TRADES } from "../admin/PriceBook.js";
import type { EstimateListRow } from "../admin/types.js";
import { EstimateTool } from "../EstimateTool.js";
import { QuoteView } from "../QuoteView.js";
import { adminRamp, button, CONFIG, click, estimate, fail, fakeAdmin, fakePublic, keyWire, labelled, mount, ok, quote, RAMP, settingsWire, STATUS, submit, supply, text, type } from "./fakes.js";

/**
 * estimator-widget 0.3 (Tenancy 2a, 7.10): pattern hrefs a server page can
 * pass, the company-owned fields read-only, the site's ceiling on photo
 * reading, the business's own "closed" sentence, the logo, and the embed
 * deep link.
 */

afterEach(() => {
  document.body.innerHTML = "";
  window.location.hash = "";
  vi.restoreAllMocks();
});

const CLOSED = "Green Acres isn't taking requests online right now. Call (801) 555-0100.";

function row(extra: Partial<EstimateListRow> = {}): EstimateListRow {
  return {
    id: "est/1 x",
    number: "EST-0001",
    status: "draft",
    source: "web",
    customerName: "Pat Lee",
    customerEmail: "pat@example.com",
    jobAddress: null,
    total: 10_000,
    rangeLow: 10_000,
    rangeHigh: 10_000,
    currency: "USD",
    photoCount: 0,
    hasReading: false,
    validUntil: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  } as EstimateListRow;
}

describe("pattern hrefs", () => {
  it("hrefFor fills {id} encoded, or calls the function", () => {
    expect(hrefFor("/app/estimates/{id}", "a/b c")).toBe("/app/estimates/a%2Fb%20c");
    expect(hrefFor((id) => `/x/${id}`, "y")).toBe("/x/y");
  });

  it("<EstimatesQueue estimateHref='/app/estimates/{id}'> makes each row a link with the id filled in", async () => {
    const fake = fakeAdmin({
      listEstimates: () => ok({ estimates: [row()], nextCursor: null, counts: { leads: 1, drafts: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0, all: 1, archived: 0 } }),
    });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} estimateHref="/app/estimates/{id}" initialFilter="all" />);
    const link = container.querySelector<HTMLAnchorElement>("a[data-aiew-row]");
    expect(link?.getAttribute("href")).toBe("/app/estimates/est%2F1%20x");
    await unmount();
  });

  it("<EstimateEditor estimateHref> navigates to the copy a Duplicate made, when there is no onOpenEstimate", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const product = adminRamp();
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate() }),
      getProduct: () => ok({ product }),
      duplicate: () => ok({ estimate: estimate({ id: "est_copy", number: "EST-0002" }), warnings: [] }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" estimateHref="/app/estimates/{id}" />);
    await click(container.querySelector('[data-action="duplicate"]'));
    expect(assign).toHaveBeenCalledWith("/app/estimates/est_copy");
    await unmount();
  });
});

describe("<EstimatorSettings> in a company", () => {
  it("shows the business fields read-only, with the link to company settings", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ businessName: "Green Acres", brandColor: "#1f7a3a", managedByCompany: { href: "/settings/company#details" } }) }),
      status: () => ok(STATUS),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["business"]} />);
    const managed = container.querySelector("[data-aiew-managed]")!;
    expect(text(managed)).toContain("These come from your company settings.");
    expect(managed.querySelector("a")?.getAttribute("href")).toBe("/settings/company#details");
    expect(text(managed)).toContain("Green Acres");
    expect(text(managed)).toContain("#1f7a3a");
    // The zone by its name, as Schedule settings says it (review T2A-BO-14), never the database id.
    expect(text(managed)).toMatch(/Mountain (Standard )?Time/);
    expect(text(managed)).not.toContain("America/Denver");
    expect(labelled(container, "Business name")).toBeNull();
    await unmount();
  });

  it("an empty Lead alerts list says where alerts go instead (review T2A-BO-14)", async () => {
    const fake = fakeAdmin({
      getSettings: () =>
        ok({ settings: settingsWire({ leadNotifyEmails: [], contactEmail: "office@greenacres.test", managedByCompany: { href: "/settings/company#details" } }) }),
      status: () => ok(STATUS),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["alerts"]} />);
    expect(text(container.querySelector("[data-aiew-alerts-default]"))).toBe(
      "Leave it empty and alerts go to office@greenacres.test, your company's contact email.",
    );
    await unmount();
  });

  it("the first-run form asks only for the tax rate and labor rate, and sends only those", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ saved: false, businessName: "Green Acres", managedByCompany: { href: null } }) }),
      status: () => ok(STATUS),
      updateSettings: (patch) => ok({ settings: settingsWire({ ...(patch as object), saved: true, managedByCompany: { href: null } }) }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    expect(labelled(container, "Business name")).toBeNull();
    expect(labelled(container, "Contact phone")).toBeNull();
    expect(text(container)).toContain("These come from your company settings.");
    await type(labelled(container, "Sales tax (%)"), "7.25");
    await submit(container.querySelector("form"));
    const patch = fake.of("updateSettings")[0]!.args[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["defaultLaborRateCents", "taxRateBp"].filter((k) => k in patch).sort());
    expect(patch).toMatchObject({ taxRateBp: 725 });
    expect(patch).not.toHaveProperty("businessName");
    await unmount();
  });

  it("the ceiling: the budget's hint says it, the input's max is it, and a higher budget isn't sent", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ aiDailyBudgetCents: 100, aiBudgetCeilingCents: 100 }) }),
      status: () => ok({ ...STATUS, aiBudgetCeilingCents: 100 }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} sections={["photos"]} />);
    const budget = labelled(container, "Most photo reading may cost per day ($)") as HTMLInputElement;
    expect(budget.getAttribute("max")).toBe("1.00");
    expect(text(container)).toContain("Up to $1.00 a day on this site.");
    await type(budget, "5");
    await submit(budget.closest("form"));
    expect(fake.of("updateSettings")).toHaveLength(0);
    expect(text(container)).toContain("This site allows up to $1.00 a day of photo reading per business.");
    await unmount();
  });
});

describe("closed by the business (409 estimates_closed)", () => {
  it("<EstimateTool> shows the server's sentence, no retry", async () => {
    const fake = fakePublic({ config: () => fail("estimates_closed", CLOSED, { status: 409 }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toBe(CLOSED);
    expect(button(container, "Retry")).toBeNull();
    await unmount();
  });

  it("<QuoteView> shows the server's sentence for the quote load", async () => {
    const fake = fakePublic({ quote: () => fail("estimates_closed", CLOSED, { status: 409 }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="t" />);
    expect(text(container)).toBe(CLOSED);
    expect(button(container, "Retry")).toBeNull();
    await unmount();
  });
});

describe("the logo", () => {
  it("<EstimateTool> shows it beside the business name, alt empty", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, products: [RAMP], logoUrl: "https://cdn.test/green.png", businessName: "Green Acres" }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    const brand = container.querySelector("[data-aiew-brand]")!;
    expect(brand.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/green.png");
    expect(brand.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(text(brand)).toBe("Green Acres");
    await unmount();
  });

  it("<QuoteView> shows it in the business heading", async () => {
    const fake = fakePublic({ quote: () => ok({ quote: quote({ logoUrl: "https://cdn.test/green.png" }) }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="t" />);
    const img = container.querySelector(".aiew-quote-business img");
    expect(img?.getAttribute("src")).toBe("https://cdn.test/green.png");
    expect(img?.getAttribute("alt")).toBe("");
    await unmount();
  });

  it("no logo, no image", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, products: [RAMP] }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(container.querySelector("[data-aiew-brand]")).toBeNull();
    await unmount();
  });
});

describe("read-only for someone who may look but not change (canManage={false})", () => {
  // A company's member quotes from the price book and reads the quote rules;
  // its owner and admins keep them (D9). The server refuses a member's change
  // either way: these only stop offering buttons that would fail.
  it("<PriceBook>: the products and supplies, and no control that changes them", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp(), adminRamp({ id: "p-old", name: "Wood ramp", isActive: false })] }),
      listSupplies: () => ok({ supplies: [supply(), supply({ id: "s-old", name: "Old rail", isActive: false })] }),
      status: () => ok(STATUS),
      getSettings: () => ok({ settings: settingsWire() }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} canManage={false} />);
    expect(text(container)).toContain(READ_ONLY_PRICE_BOOK);
    expect(text(container)).toContain(adminRamp().name);
    for (const label of ["Add a product", "Edit", "Retire", "Restore", "Move"]) expect(button(container, label), label).toBeNull();
    await click([...container.querySelectorAll('[role="tab"]')].find((tab) => text(tab) === "Supplies"));
    expect(text(container)).toContain(supply().name);
    for (const label of ["Add supply", "Edit", "Retire", "Restore"]) expect(button(container, label), label).toBeNull();
    expect(container.querySelector("[data-aiew-supply-form]")).toBeNull();
    await unmount();
  });

  it("<PriceBook>, empty: no sample to load, and who fills it", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [] }), listSupplies: () => ok({ supplies: [] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} canManage={false} />);
    expect(text(container)).toContain("No products yet.");
    expect(text(container)).toContain("The owner or an admin adds what you sell here.");
    expect(button(container, "Load a sample catalog")).toBeNull();
    expect(button(container, "Add a product")).toBeNull();
    await unmount();
  });

  it("<EstimatorSettings>: every field shows its value and none can be changed or sent", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire({ taxRateBp: 725 }) }), status: () => ok(STATUS) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} canManage={false} />);
    expect(text(container)).toContain(READ_ONLY_SETTINGS);
    const fields = container.querySelector<HTMLFieldSetElement>("[data-aiew-settings-fields]")!;
    expect(fields.disabled).toBe(true);
    const tax = labelled(container, "Sales tax (%)") as HTMLInputElement;
    expect(tax.value).toBe("7.25");
    expect(tax.closest("fieldset[disabled]")).not.toBeNull();
    for (const save of container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) expect(save.closest("fieldset[disabled]"), text(save)).not.toBeNull();
    await unmount();
  });

  it("<EstimatorSettings>, never saved: no first-run form, and who has to save it", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire({ saved: false, managedByCompany: { href: null } }) }), status: () => ok(STATUS) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} canManage={false} />);
    expect(text(container)).toContain(NOT_SAVED_READ_ONLY);
    expect(labelled(container, "Sales tax (%)")).toBeNull();
    expect(button(container, "Save and open my estimate page")).toBeNull();
    await unmount();
  });

  it("<EmbedKeys>: the keys, and no way to make, edit or revoke one", async () => {
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [keyWire()] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} canManage={false} />);
    expect(text(container)).toContain(keyWire().label);
    for (const label of ["Make the key", "Edit websites", "Revoke"]) expect(button(container, label), label).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    await unmount();
  });

  it("the default (no prop) still offers everything", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [adminRamp()] }), listSupplies: () => ok({ supplies: [] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    expect(button(container, "Add a product")).not.toBeNull();
    expect(button(container, "Edit")).not.toBeNull();
    expect(text(container)).not.toContain(READ_ONLY_PRICE_BOOK);
    await unmount();
  });

  // A company's VIEWER reads estimates (estimator.view) but doesn't work them
  // (no estimator.estimates.manage): the queue and the estimate are shown in
  // full, with nothing offered that the server would refuse.
  const COUNTS = { leads: 1, drafts: 0, sent: 0, accepted: 0, declined: 0, expired: 0, converted: 0, all: 1, archived: 0 };

  it("<EstimatesQueue>: the estimates, and no New estimate; the default still offers it", async () => {
    const fake = fakeAdmin({ listEstimates: () => ok({ estimates: [row()], nextCursor: null, counts: COUNTS }) });
    const readOnly = await mount(<EstimatesQueue transport={fake.transport} canManage={false} initialFilter="all" />);
    expect(text(readOnly.container)).toContain("Pat Lee");
    expect(button(readOnly.container, "New estimate")).toBeNull();
    await readOnly.unmount();
    const full = await mount(<EstimatesQueue transport={fake.transport} initialFilter="all" />);
    expect(button(full.container, "New estimate")).not.toBeNull();
    await full.unmount();
  });

  it("<EstimateEditor>: the whole estimate — customer, photos, lines, notes — and nothing offered to change it", async () => {
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate({ internalNotes: "Gate code 1234" }) }),
      getProduct: () => ok({ product: adminRamp() }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" canManage={false} />);
    expect(text(container)).toContain("You can see this estimate. Your role can't change it.");
    expect(container.querySelector("[data-aiew-actions]")).toBeNull();
    for (const label of ["Send quote", "Duplicate", "Archive", "Remove", "Add a line from the price book", "Add line"]) {
      expect(button(container, label), label).toBeNull();
    }
    expect(text(container)).not.toContain("Add photo");
    expect(container.querySelector('input[type="file"]')).toBeNull();
    // Shown, as text: the customer, their photo, the office's notes.
    expect((labelled(container, "Name") as HTMLInputElement).value).toBe("Pat Lee");
    expect((labelled(container, "Name") as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector("[data-aiew-photo]")).not.toBeNull();
    expect(text(container.querySelector("[data-aiew-office-notes]"))).toContain("Gate code 1234");
    expect(labelled(container, "Notes for the office")).toBeNull();
    await unmount();
  });

  it("<EstimateEditor>, the default: the actions the estimate's state allows, the notes and Add photo", async () => {
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: estimate() }), getProduct: () => ok({ product: adminRamp() }) });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    expect(container.querySelector("[data-aiew-actions]")).not.toBeNull();
    expect(button(container, "Send quote")).not.toBeNull();
    expect(text(container)).toContain("Add photo");
    expect(labelled(container, "Notes for the office")).not.toBeNull();
    expect(text(container)).not.toContain("Your role can't change it.");
    await unmount();
  });
});

describe("<EmbedKeys> deep link", () => {
  it("has id='embed' and focuses its heading on #embed", async () => {
    window.location.hash = "#embed";
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [keyWire()] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} />);
    const heading = container.querySelector("#embed");
    expect(heading).not.toBeNull();
    expect(document.activeElement).toBe(heading);
    await unmount();
  });
});

describe("wire", () => {
  it("both copies carry the 0.3 fields", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const widgetPublic = readFileSync(resolve(here, "../types.ts"), "utf8");
    const widgetAdmin = readFileSync(resolve(here, "../admin/types.ts"), "utf8");
    const server = readFileSync(resolve(here, "../../../estimator/src/wire.ts"), "utf8");
    for (const [name, source] of [["widget", widgetPublic + widgetAdmin], ["server", server]] as const) {
      expect(source.split("logoUrl: string | null;").length - 1, `${name} logoUrl on config and quote`).toBe(2);
      expect(source, name).toContain("managedByCompany: { href: string | null } | null;");
      expect(source, name).toContain("aiBudgetCeilingCents: number | null;");
      expect(source, name).toContain("aiBudgetCeilingCents: Cents | null;");
    }
  });
});

describe("<EmbedKeys> for a business with no developer (review T2A-BO-02 / TB-2, T2A-BO-06)", () => {
  const PAGE = "https://app.example/t/green-acres/estimate";

  it("leads with a button and a page frame any website takes; the React snippet is under 'For developers'", async () => {
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [keyWire()] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} publicPageUrl={PAGE} buttonColor="#1f7a3a" />);
    const intro = text(container.querySelector("[data-aiew-no-code]"));
    expect(intro).toContain("Wix, Squarespace, WordPress");
    expect(intro).toContain("No key and no developer needed.");
    expect(text(container)).not.toContain("paste the snippet into its React code");
    const values = [...container.querySelectorAll<HTMLInputElement>("[data-aiew-copy] input")].map((i) => i.value);
    const button = values.find((v) => v.startsWith("<a href="))!;
    expect(button).toContain(`href="${PAGE}"`);
    expect(button).toContain("background:#1f7a3a;color:#ffffff");
    expect(button).toContain(">Get an instant estimate</a>");
    expect(values).toContain(PAGE);
    expect(values.find((v) => v.startsWith("<iframe"))).toContain(`src="${PAGE}"`);
    // The keyed React component is folded away and says what it needs.
    const developer = container.querySelector("details[data-aiew-developer]")!;
    expect(developer).not.toBeNull();
    expect(developer.hasAttribute("open")).toBe(false);
    expect(text(developer)).toContain("For developers");
    expect(text(developer)).toContain("@adminigloo/estimator-widget package, which is private");
    expect(developer.querySelector("[data-aiew-key]")).not.toBeNull();
    await unmount();
  });

  it("a path is completed with the page's own address", async () => {
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} publicPageUrl="/estimate" />);
    const values = [...container.querySelectorAll<HTMLInputElement>("[data-aiew-copy] input")].map((i) => i.value);
    expect(values).toContain(`${window.location.origin}/estimate`);
    await unmount();
  });

  it("without a public page it still says plainly what the keyed snippet needs", async () => {
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [] }), status: () => ok(STATUS), getSettings: () => ok({ settings: settingsWire() }) });
    const { container, unmount } = await mount(<EmbedKeys transport={fake.transport} />);
    expect(text(container)).toContain("built with React");
    expect(text(container)).toContain("which is private");
    await unmount();
  });

  it("notices={false}: the second screen on the page shows no copy of the notices", async () => {
    const withNotices = { ...STATUS, notices: [{ code: "settings_not_saved" as const, message: "Your estimate page is closed." }] };
    const fake = fakeAdmin({ listKeys: () => ok({ keys: [] }), status: () => ok(withNotices), getSettings: () => ok({ settings: settingsWire() }) });
    const shown = await mount(<EmbedKeys transport={fake.transport} />);
    expect(text(shown.container)).toContain("Your estimate page is closed.");
    await shown.unmount();
    const hidden = await mount(<EmbedKeys transport={fake.transport} notices={false} />);
    expect(text(hidden.container)).not.toContain("Your estimate page is closed.");
    await hidden.unmount();
  });
});

describe("the sample's trade picker (review T2A-BO-10)", () => {
  it("offers lawn care, cleaning and ramps with the server's counts", () => {
    // @adminigloo/estimator's SAMPLE_CATALOGS has these; its companies test holds the same numbers.
    expect(SAMPLE_TRADES.map((trade) => [trade.key, trade.products, trade.supplies])).toEqual([
      ["lawn", 5, 8],
      ["cleaning", 5, 5],
      ["ramps", 5, 10],
    ]);
  });
});
