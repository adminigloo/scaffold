// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EstimateEditor } from "../admin/EstimateEditor.js";
import { EstimatorSettings } from "../admin/EstimatorSettings.js";
import { RAMP_DEFAULTS } from "../admin/helpers.js";
import { PriceBook, SAMPLE_CONFIRM } from "../admin/PriceBook.js";
import { formFromProduct } from "../admin/ProductEditor.js";
import { estimatorAdminCss } from "../admin/styles.js";
import type { AdminProduct, SupplyPatch } from "../admin/types.js";
import { EstimateTool } from "../EstimateTool.js";
import { SparkIcon } from "../parts.js";
import { QuoteView } from "../QuoteView.js";
import { estimatorWidgetCss } from "../styles.js";
import type { CalculateResponse, PublicConfig, TakeoffResponse } from "../types.js";
import {
  adminRamp,
  button,
  checkbox,
  click,
  CONFIG,
  estimate,
  fail,
  fakeAdmin,
  fakePublic,
  labelled,
  line,
  mount,
  ok,
  pass,
  photoFile,
  pickFile,
  PRICE_ASSUMED,
  previewResponse,
  quote,
  RAMP,
  READING,
  settingsWire,
  submit,
  supply,
  text,
  type,
} from "./fakes.js";

/**
 * One test per finding of the 2026-10-12 review that lands in the widget
 * (EST-R01 … R14, ADV-2, ADV-3, RL-02, RL-05). Each failed before its fix.
 */

vi.mock("../photo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../photo.js")>();
  return {
    ...original,
    resizePhoto: vi.fn(async () => ({ blob: new Blob(["abc"], { type: "image/jpeg" }), base64: "QUJD", width: 768, height: 576, mediaType: "image/jpeg" as const })),
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const RAMP_ONLY: PublicConfig = { ...CONFIG, products: [RAMP] };
const priced = (): CalculateResponse => ({ status: "priced", missing: [], price: PRICE_ASSUMED, result: null });
const READ: TakeoffResponse = { status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null };
const stepsInput = (root: ParentNode) => labelled(root, "How many steps go up to the door?") as HTMLInputElement;

describe("EST-R03: 'More ways to measure' really hides", () => {
  it("the stylesheet hides [hidden] inside the widget, so the collapsed total height is not displayed", async () => {
    expect(estimatorWidgetCss()).toMatch(/\.aiew-root \[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    const fake = fakePublic({ config: () => ok(RAMP_ONLY) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    const more = container.querySelector<HTMLElement>("[data-aiew-more]")!;
    expect(more.hasAttribute("hidden")).toBe(true);
    // The cascade, not just the attribute: `.aiew-fields { display: grid }` used to win.
    expect(getComputedStyle(more).display).toBe("none");
    await click(button(container, "More ways to measure"));
    expect(getComputedStyle(more).display).toBe("grid");
    await unmount();
  });
});

describe("EST-R04: a lower count than the photo's asks about the porch step", () => {
  it("shows the server's check under the count when the customer lowers it, and drops it when they don't", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), takeoff: () => ok(READ) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    expect(stepsInput(container).value).toBe("3");
    expect(container.querySelector('[data-aiew-check="steps"]')).toBeNull();
    await click(button(container, "One fewer: How many steps"));
    expect(stepsInput(container).value).toBe("2");
    const check = container.querySelector('[data-aiew-check="steps"]');
    expect(text(check)).toBe("Did you count the step up onto the porch or landing? 2 steps and the porch is 3.");
    expect(stepsInput(container).getAttribute("aria-describedby") ?? "").toContain(check!.id);
    await click(button(container, "One more: How many steps"));
    await click(button(container, "One more: How many steps"));
    expect(stepsInput(container).value).toBe("4");
    expect(container.querySelector('[data-aiew-check="steps"]')).toBeNull();
    await unmount();
  });
});

describe("EST-R07: no directions that point the wrong way", () => {
  it("the reading card offers 'Change the count', which focuses the count; no customer copy says 'below'", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), takeoff: () => ok(READ) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container).toLowerCase()).not.toContain("below");
    await pickFile(container, photoFile());
    const card = container.querySelector("[data-aiew-reading-card]")!;
    await click(button(card as HTMLElement, "Change the count"));
    expect(document.activeElement).toBe(stepsInput(container));
    expect(text(container).toLowerCase()).not.toContain("below");
    await unmount();
  });

  it.each(["not_supported", "unavailable"] as const)("a '%s' answer with no message of its own says nothing about 'below'", async (status) => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      takeoff: () => ok<TakeoffResponse>({ status, reading: null, photoId: "ph_1", message: null, cached: false, available: false, result: null }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    const note = container.querySelector("[data-aiew-photo-note]");
    expect(text(note)).not.toBe("");
    expect(text(note).toLowerCase()).not.toContain("below");
    await unmount();
  });
});

describe("RL-05: the photo preview works under a strict CSP", () => {
  it("the preview is a data: URL even where object URLs exist (img-src 'self' data: is enough)", async () => {
    const created = vi.fn(() => "blob:http://x.test/1");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), takeoff: () => ok(READ), calculate: () => ok(priced()) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    const src = container.querySelector("img.aiew-thumb")!.getAttribute("src")!;
    expect(src.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(created).not.toHaveBeenCalled();
    await unmount();
  });
});

describe("ADV-2: an answer names the version the customer saw", () => {
  it("accept and decline send the quote's version", async () => {
    const fake = fakePublic({ quote: () => ok({ quote: quote({ version: 2 }) }), acceptQuote: () => ok({ quote: quote({ version: 2, status: "accepted", canRespond: false }) }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    await click(button(container, "Accept this quote"));
    await submit(container.querySelector('[data-aiew-confirm="accept"]'));
    expect(fake.of("acceptQuote")[0]!.args[1]).toMatchObject({ version: 2 });
    await unmount();

    const fake2 = fakePublic({ quote: () => ok({ quote: quote({ version: 3 }) }), declineQuote: () => ok({ quote: quote({ version: 3, status: "declined", canRespond: false }) }) });
    const second = await mount(<QuoteView transport={fake2.transport} token="tok_1" />);
    await click(button(second.container, "Decline"));
    await submit(second.container.querySelector('[data-aiew-confirm="decline"]'));
    expect(fake2.of("declineQuote")[0]!.args[1]).toMatchObject({ version: 3 });
    await second.unmount();
  });

  it("quote_changed: the new version is read and shown, with the server's words, and nothing was accepted", async () => {
    let reads = 0;
    const changed = quote({ version: 2, total: 2_223_663 });
    const fake = fakePublic({
      quote: () => ok({ quote: ++reads === 1 ? quote() : changed }),
      acceptQuote: () => fail("quote_changed", "This quote changed since you opened it. Here's the new one; check it before you accept."),
    });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    await click(button(container, "Accept this quote"));
    await submit(container.querySelector('[data-aiew-confirm="accept"]'));
    expect(fake.of("quote")).toHaveLength(2);
    expect(text(container)).toContain("This quote changed since you opened it. Here's the new one; check it before you accept.");
    expect(text(container)).toContain("$22,236.63");
    // Still open: they can accept the version they now see.
    expect(button(container, "Accept this quote")).not.toBeNull();
    await unmount();
  });
});

describe("EST-R05: the send dialog says what an unmeasured line is priced at, before sending", () => {
  it("shows the server's sendWarnings in the dialog", async () => {
    const warning = "Line 1 (Modular aluminum ramp) is priced at 3 steps, 7.5 in each (estimated), 23 ft of ramp. The range was $6,473 – $7,146 (Step height 7–8 in (estimated)): measure first, or send it as is.";
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: estimate({ sendWarnings: [warning] }) }), getProduct: () => fail("not_found") });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(container.querySelector('[data-action="send"]'));
    const dialog = container.querySelector("[data-aiew-send]")!;
    expect(text(dialog.querySelector('[data-aiew-notice="send-warnings"]'))).toContain(warning);
    expect(fake.of("sendQuote")).toHaveLength(0);
    await unmount();
  });
});

describe("EST-R11: the staff reading box", () => {
  it("SparkIcon is text-sized", async () => {
    const { container, unmount } = await mount(<SparkIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("1em");
    expect(svg.getAttribute("height")).toBe("1em");
    await unmount();
  });

  it("'Customer was shown' only on a customer's own estimate", async () => {
    const product = adminRamp();
    const staffMade = estimate({ source: "staff", lines: [line({ reading: null, corrections: [] })] });
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: staffMade }), getProduct: () => ok({ product }) });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    expect(text(container)).not.toContain("Customer was shown");
    expect(text(container.querySelector("[data-aiew-shown]"))).toContain("Range $8,602.65 – $10,458.07");
    await unmount();

    const fromWebsite = fakeAdmin({ getEstimate: () => ok({ estimate: estimate() }), getProduct: () => ok({ product }) });
    const second = await mount(<EstimateEditor transport={fromWebsite.transport} estimateId="est_1" />);
    expect(text(second.container.querySelector("[data-aiew-shown]"))).toContain("Customer was shown $8,602.65 – $10,458.07");
    await second.unmount();
  });
});

describe("EST-R01: a new product and the sample start off the website", () => {
  it("a new product's 'Show on your website' starts off; the sample's dialog says it arrives off the website", () => {
    expect(formFromProduct(null).showInEstimator).toBe(false);
    expect(SAMPLE_CONFIRM).toContain("off your website");
  });
});

describe("EST-R06: labor at $0 is called out", () => {
  it("hours with no rate anywhere: a warning in the Labor panel and under the breakdown", async () => {
    const zeroRate = adminRamp({ labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: null, effectiveRateCents: 0 } });
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ defaultLaborRateCents: 0 }) }),
      listProducts: () => ok({ products: [zeroRate] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () =>
        ok(
          previewResponse({
            breakdown: {
              ...previewResponse().breakdown!,
              lines: [{ kind: "labor", label: "Labor 7.35 h × $0.00", quantity: 7.35, unit: "h", unitCost: 0, amount: 0 }],
            },
          }),
        ),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await pass(450);
    const labor = container.querySelector('[data-aiew-panel="labor"]')!;
    expect(text(labor.querySelector('[data-aiew-notice="labor-zero"]'))).toContain("Your labor rate is $0");
    expect(text(container.querySelector('[data-aiew-notice="breakdown-labor-zero"]'))).toContain("Labor is priced at $0");
    await unmount();
  });
});

describe("EST-R08: the price book on a phone", () => {
  it("supplies render as stacked cards under 600 px: every cell is labelled and the table turns into blocks", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [adminRamp()] }), listSupplies: () => ok({ supplies: [supply()] }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} initialTab="supplies" />);
    const table = container.querySelector("table.aiew-supply-table")!;
    expect(table).not.toBeNull();
    const cells = [...table.querySelectorAll('[data-aiew-supply="s-handrail"] td')];
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual(["Supply", "Unit", "Cost", "Supplier", "Used by", "Actions"]);
    expect(estimatorAdminCss()).toMatch(/@media \(max-width: 600px\)\s*\{[^@]*\.aiew-supply-table thead\s*\{\s*display:\s*none/);
    await unmount();
  });

  it("the product editor carries a price-and-margin bar for phones", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [adminRamp()] }), listSupplies: () => ok({ supplies: [supply()] }), preview: () => ok(previewResponse()) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await pass(450);
    expect(text(container.querySelector("[data-aiew-sticky-price]"))).toContain("Price $6,443.96 · Margin 28.57%");
    expect(estimatorAdminCss()).toMatch(/\.aiew-sticky-price\s*\{[^}]*position:\s*sticky/);
    await unmount();
  });
});

describe("EST-R09: supplies bought whole", () => {
  it("each attachment has 'Bought whole'; adding an 'each' supply ticks it by default", async () => {
    const post = supply({ id: "s-post", name: "Support post", unitType: "per_unit", unitCost: 4200, usedBy: [] });
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply(), post] }),
      preview: () => ok(previewResponse()),
      updateAttachment: () => ok({ product: adminRamp() }),
      attachSupply: () => ok({ product: adminRamp() }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    const row = container.querySelector('[data-aiew-attachment="a-rail"]')!;
    await click(checkbox(row, "Bought whole"));
    expect(fake.of("updateAttachment")[0]!.args).toEqual(["p-ramp", "a-rail", { roundUp: true }]);
    const add = container.querySelector("[data-aiew-add-supply]")!;
    const { choose } = await import("./fakes.js");
    await choose(labelled(add, "Supply"), "s-post");
    expect(checkbox(add, "Bought whole")!.checked).toBe(true);
    await click(button(add as HTMLElement, "Add supply"));
    expect(fake.of("attachSupply")[0]!.args[1]).toMatchObject({ supplyId: "s-post", roundUp: true });
    await unmount();
  });
});

describe("EST-R10: the photo's step height is the owner's call", () => {
  it("the ramp settings have 'Use the step height from the photo', and the defaults match the server's", async () => {
    expect(RAMP_DEFAULTS.stepHeightIn).toEqual({ typical: 7.5, low: 7, high: 8 });
    expect(RAMP_DEFAULTS.usePhotoStepHeight).toBe(true);
    expect(RAMP_DEFAULTS.stepsHelp).toBe("Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.");
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
      updateProduct: (_id, patch) => ok({ product: adminRamp(patch as Partial<AdminProduct>) }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    const box = checkbox(container, "Use the step height from the photo")!;
    expect(box.checked).toBe(true);
    await click(box);
    await click(container.querySelector("[data-aiew-save-product]"));
    expect(fake.of("updateProduct")[0]!.args[1]).toMatchObject({ recipeConfig: { usePhotoStepHeight: false } });
    await unmount();
  });
});

describe("EST-R14: the editor and the list", () => {
  it("after 'Create the product' the editor stays open with the owner's test answers, and says 'Created'", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
      createProduct: (body) => ok({ product: adminRamp({ id: "p-new", name: body.name, showInEstimator: false }) }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Add a product"));
    await type(labelled(container, "Name"), "Porch ramp");
    await pass(450);
    const side = container.querySelector("aside")!;
    await type(stepsInput(side), "3");
    await click(container.querySelector("[data-aiew-save-product]"));
    expect(text(container)).toContain("Created");
    expect(stepsInput(container.querySelector("aside")!).value).toBe("3");
    expect(container.querySelector("[data-aiew-add-supply]")).not.toBeNull();
    await unmount();
  });

  it("the product list shows each product's everyday price and margin", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [adminRamp()] }), listSupplies: () => ok({ supplies: [supply()] }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    expect(text(container.querySelector('[data-aiew-product="p-ramp"] [data-aiew-example]'))).toBe("3 steps: $6,921.46, margin 28.57%");
    await unmount();
  });

  it("OffscreenCanvas paints white before drawing, so a transparent PNG isn't black", async () => {
    const calls: string[] = [];
    class FakeCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          set fillStyle(v: string) {
            calls.push(`fillStyle ${v}`);
          },
          fillRect: () => calls.push("fillRect"),
          drawImage: () => calls.push("drawImage"),
        };
      }
      convertToBlob() {
        return Promise.resolve(new Blob(["jpeg"], { type: "image/jpeg" }));
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1000, height: 500, close: () => {} }));
    const { resizePhoto } = await vi.importActual<typeof import("../photo.js")>("../photo.js");
    await resizePhoto(new Blob(["png"], { type: "image/png" }), { maxEdgePx: 768, quality: 0.8 });
    expect(calls).toEqual(["fillStyle #ffffff", "fillRect", "drawImage"]);
  });
});

describe("EST-R02: first run asks for what the business can't run without", () => {
  it("unsaved settings: one 'Get started' form with the name, contact, tax and labor rate, saved together", async () => {
    let settings = settingsWire({ saved: false, businessName: "", contactEmail: null, contactPhone: null, taxRateBp: 825, defaultLaborRateCents: 0 });
    const fake = fakeAdmin({
      getSettings: () => ok({ settings }),
      updateSettings: (patch) => {
        settings = { ...settings, ...patch, saved: true } as typeof settings;
        return ok({ settings });
      },
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const start = container.querySelector('[data-aiew-panel="get-started"]')!;
    expect(text(start)).toContain("Your estimate page is closed until you save these");
    await type(labelled(start, "Business name"), "Summit Ramps");
    await type(labelled(start, "Contact phone"), "(801) 555-0143");
    await type(labelled(start, "Contact email"), "office@summit.test");
    await type(labelled(start, "Sales tax"), "7.25");
    await type(labelled(start, "Hourly labor rate"), "65");
    await submit(start.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).toEqual({
      businessName: "Summit Ramps",
      contactPhone: "(801) 555-0143",
      contactEmail: "office@summit.test",
      taxRateBp: 725,
      defaultLaborRateCents: 6500,
    });
    expect(container.querySelector('[data-aiew-panel="get-started"]')).toBeNull();
    expect(container.querySelector('[data-aiew-panel="business"]')).not.toBeNull();
    await unmount();
  });

  it("asks for the name before it saves", async () => {
    const fake = fakeAdmin({ getSettings: () => ok({ settings: settingsWire({ saved: false, businessName: "" }) }) });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const start = container.querySelector('[data-aiew-panel="get-started"]')!;
    await submit(start.querySelector("form"));
    expect(fake.of("updateSettings")).toHaveLength(0);
    expect(text(start)).toContain("Add your business name.");
    await unmount();
  });
});

describe("ADV-3: without access to costs, nothing reads as a $0 cost", () => {
  it("the product's waste, markup, margin and labor rate are hidden, never shown as 0", async () => {
    const hidden = adminRamp({ wasteBp: null, markupBp: null, marginBp: null, labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: null, effectiveRateCents: null }, lumpCosts: null, example: { label: "3 steps", price: 692_146, marginBp: null } });
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ defaultLaborRateCents: null }) }),
      listProducts: () => ok({ products: [hidden] }),
      listSupplies: () => fail("forbidden", "You don't have permission to do that."),
      preview: () => ok(previewResponse({ breakdown: null })),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    expect(text(container.querySelector("[data-aiew-example]"))).toBe("3 steps: $6,921.46");
    await click(button(container, "Edit"));
    expect(labelled(container, "Markup (%)")).toBeNull();
    expect(labelled(container, "Waste (%)")).toBeNull();
    expect(labelled(container, "Hourly rate ($)")).toBeNull();
    expect(text(container.querySelector('[data-aiew-panel="price"]'))).toContain("Waste, markup and margin are hidden: you can see prices, not costs.");
    expect(text(container)).not.toContain("$0.00 an hour");
    await unmount();
  });

  it("a settings save by someone who can't see the labor rate never sends one", async () => {
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ defaultLaborRateCents: null }) }),
      updateSettings: () => ok({ settings: settingsWire({ defaultLaborRateCents: null, taxRateBp: 800 }) }),
    });
    const { container, unmount } = await mount(<EstimatorSettings transport={fake.transport} />);
    const pricing = container.querySelector('[data-aiew-panel="pricing"]')!;
    expect(labelled(pricing, "Default hourly labor rate")).toBeNull();
    await type(labelled(pricing, "Sales tax"), "8");
    await submit(pricing.querySelector("form"));
    expect(fake.of("updateSettings")[0]!.args[0]).not.toHaveProperty("defaultLaborRateCents");
    await unmount();
  });
});

describe("RL-02: a supply priced from the host's own list", () => {
  it("says where its cost comes from, shows it read-only, and never sends a cost or unit change", async () => {
    let patch: SupplyPatch | null = null;
    const synced = supply({ externalRef: "SVC-118", managedExternally: true });
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [synced] }),
      updateSupply: (_id, p) => {
        patch = p;
        return ok({ supply: synced, affectedProducts: [] });
      },
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} initialTab="supplies" />);
    const row = container.querySelector('[data-aiew-supply="s-handrail"]')!;
    expect(text(row)).toContain("Price from your list");
    expect(text(row)).toContain("SVC-118");
    await click(button(row as HTMLElement, "Edit"));
    const form = container.querySelector('[data-aiew-supply="s-handrail"] form')!;
    const cost = labelled(form, "It costs you") as HTMLInputElement;
    expect(cost.readOnly).toBe(true);
    expect((labelled(form, "You buy it") as HTMLSelectElement).disabled).toBe(true);
    expect(text(form)).toContain("Change it in your own price list");
    await type(labelled(form, "Note"), "From the services table");
    await click(button(form as HTMLElement, "Save"));
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty("unitCost");
    expect(patch).not.toHaveProperty("unitType");
    await unmount();
  });
});
