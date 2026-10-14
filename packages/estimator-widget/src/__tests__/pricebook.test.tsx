// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { PriceBook, SAMPLE_CONFIRM } from "../admin/PriceBook.js";
import type { AdminProduct, PreviewBody, ProductInput, ProductPatch, SupplyPatch } from "../admin/types.js";
import { AREA_DEFAULTS } from "../admin/helpers.js";
import { adminRamp, blur, button, checkbox, choose, click, fail, fakeAdmin, labelled, mount, ok, pass, previewResponse, supply, text, type } from "./fakes.js";

/**
 * <PriceBook> driven like an owner (contract 9.7, rule D): load the sample
 * on purpose, open the ramp, watch the live preview while changing how it's
 * measured, change a supply's cost and hear which prices it moves — and see
 * costs only with access to them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const threshold: AdminProduct = adminRamp({
  id: "p-threshold",
  name: "Threshold ramp",
  recipe: "count",
  recipeInfo: { key: "count", label: "A count", description: "Customers say how many.", primaryKey: "item", bases: [{ key: "item", label: "per doorway" }, { key: "job", label: "once per job" }], photoReading: false },
  recipeConfig: { countLabel: "How many doorways need one?", help: null, noun: { one: "doorway", many: "doorways" }, maxCount: 10, photoSubject: null, photoTip: null },
  sortOrder: 10,
  supplies: [],
  options: [],
});

describe("<PriceBook>: the sample catalog", () => {
  it("an empty price book offers the sample, and loads it only after the owner confirms", async () => {
    let loaded = false;
    const fake = fakeAdmin({
      listProducts: () => ok({ products: loaded ? [adminRamp(), threshold] : [] }),
      listSupplies: () => ok({ supplies: loaded ? [supply()] : [] }),
      loadSampleCatalog: () => {
        loaded = true;
        return ok({ products: 5, supplies: 10 });
      },
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    expect(text(container)).toContain("No products yet.");
    await click(container.querySelector("[data-aiew-load-sample]"));
    const dialog = container.querySelector("[data-aiew-sample-confirm]")!;
    expect(text(dialog)).toContain(SAMPLE_CONFIRM);
    // The trade is asked, never assumed (review T2A-BO-10): nothing loads until one is picked.
    expect(text(dialog)).toContain("What kind of work do you do?");
    expect((button(dialog as HTMLElement, "Load the sample") as HTMLButtonElement).disabled).toBe(true);
    await click(checkbox(dialog as HTMLElement, "Wheelchair ramps and accessibility"));
    expect(text(dialog)).toContain("This adds 5 sample products and 10 supplies with sample prices.");
    expect(fake.of("loadSampleCatalog")).toHaveLength(0);
    await click(button(dialog as HTMLElement, "Load the sample"));
    expect(fake.of("loadSampleCatalog")).toHaveLength(1);
    expect(fake.of("loadSampleCatalog")[0]!.args).toEqual(["ramps"]);
    expect(text(container)).toContain("Loaded 5 products and 10 supplies, off your website. Change the prices to yours, then turn each one on.");
    expect(fake.of("listProducts")).toHaveLength(2);
    expect(text(container)).toContain("Modular aluminum ramp");
    await unmount();
  });

  it("a second load is refused in the server's words", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [] }),
      listSupplies: () => ok({ supplies: [] }),
      loadSampleCatalog: () => fail("sample_already_loaded", "The sample catalog is already loaded."),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(container.querySelector("[data-aiew-load-sample]"));
    await click(checkbox(container, "Lawn care and landscaping"));
    await click(button(container, "Load the sample"));
    expect(fake.of("loadSampleCatalog")[0]!.args).toEqual(["lawn"]);
    expect(text(container)).toContain("The sample catalog is already loaded.");
    await unmount();
  });
});

describe("<PriceBook>: the products", () => {
  it("lists each product with how it's measured and where it shows; reorders with buttons", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp(), threshold, adminRamp({ id: "p-old", name: "Wood ramp", isActive: false })] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      reorderProducts: (ids) => ok({ products: [threshold, adminRamp()].map((p, i) => ({ ...p, sortOrder: ids.indexOf(p.id) * 10 + i * 0 })) }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    const ramp = container.querySelector('[data-aiew-product="p-ramp"]')!;
    expect(text(ramp)).toContain("How it's measured: Steps up to a door (ramp)");
    expect(text(ramp)).toContain("On your website");
    expect(text(container.querySelector("details"))).toContain("Retired products (1)");
    await click(button(ramp as HTMLElement, "Move Modular aluminum ramp down"));
    expect(fake.of("reorderProducts")[0]!.args[0]).toEqual(["p-threshold", "p-ramp"]);
    await unmount();
  });

  it("the editor previews live — what the customer is asked, the price they see, and the cost breakdown", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await pass(450);
    expect(fake.of("preview")[0]!.args[0]).toEqual({ productId: "p-ramp", draft: {}, inputs: {} } satisfies PreviewBody);
    const side = container.querySelector('aside[aria-label="Test a quote"]')!;
    expect(text(side)).toContain("How many steps go up to the door?");
    // The owner answers as a customer would.
    await type(labelled(side, "How many steps go up to the door?"), "3");
    await pass(450);
    expect((fake.of("preview").at(-1)!.args[0] as PreviewBody).inputs).toEqual({ steps: 3 });
    expect(text(side.querySelector("[data-aiew-amount]"))).toBe("$6,444 – $7,164");
    expect(text(side)).toContain("Based on an estimated step height of 7–8 in.");
    const breakdown = side.querySelector("[data-aiew-breakdown]")!;
    expect(text(breakdown)).toContain("Aluminum ramp section");
    expect(text(breakdown.querySelector("[data-aiew-cost]"))).toBe("$4,602.83");
    expect(text(breakdown.querySelector("[data-aiew-point]"))).toBe("$6,443.96");
    expect(text(breakdown.querySelector("[data-aiew-margin]"))).toBe("28.57%");
    // Each supply row shows its amount at the test measurement.
    expect(text(container.querySelector('[data-aiew-supply-amount="a-section"]'))).toBe("$1,995.00");
    await unmount();
  });

  it("changing how it's measured previews the draft before saving, then saves just the change", async () => {
    let saved: ProductPatch | null = null;
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse({ status: "needs_inputs", customerView: null, breakdown: null })),
      updateProduct: (_id, patch) => {
        saved = patch;
        return ok({ product: adminRamp({ recipe: "area" }) });
      },
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await pass(450);
    await choose(labelled(container, "Measured as"), "area");
    expect(text(container)).toContain("has to come off the product first. If one does, saving will say which.");
    expect(container.querySelector('[data-aiew-recipe-settings="area"]')).not.toBeNull();
    await pass(450);
    const draft = (fake.of("preview").at(-1)!.args[0] as PreviewBody).draft!;
    expect(draft.recipe).toBe("area");
    expect(draft.recipeConfig).toEqual(AREA_DEFAULTS);
    expect(fake.of("updateProduct")).toHaveLength(0);
    await click(container.querySelector("[data-aiew-save-product]"));
    expect(saved).toEqual({ recipe: "area", recipeConfig: AREA_DEFAULTS });
    await unmount();
  });

  it("the owner words the ramp's questions and sets the assumed step height", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
      updateProduct: (_id, patch) => ok({ product: adminRamp(patch as Partial<AdminProduct>) }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await type(labelled(container, "Steps question"), "How many steps up to your door?");
    await type(labelled(container, "To (in)"), "8.5");
    await pass(450);
    const draft = (fake.of("preview").at(-1)!.args[0] as PreviewBody).draft!;
    expect(draft.recipeConfig).toMatchObject({ stepsLabel: "How many steps up to your door?", stepHeightIn: { typical: 7.5, low: 7, high: 8.5 } });
    await click(container.querySelector("[data-aiew-save-product]"));
    expect(fake.of("updateProduct")[0]!.args[1]).toMatchObject({ recipeConfig: { stepsLabel: "How many steps up to your door?" } });
    expect(text(container)).toContain("Saved");
    await unmount();
  });

  it("a new product is created with what the owner typed", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse({ status: "needs_inputs", customerView: null, breakdown: null })),
      createProduct: (body) => ok({ product: adminRamp({ id: "p-new", name: body.name }) }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Add a product"));
    expect(text(container)).toContain("Save the product first, then add what goes into it from your supplies.");
    await type(labelled(container, "Name"), "Porch ramp");
    await type(labelled(container, "Markup (%)"), "45");
    await click(container.querySelector("[data-aiew-save-product]"));
    const body = fake.of("createProduct")[0]!.args[0] as ProductInput;
    // A new product starts as "a count" (review T2A-BO-10), not a ramp over steps.
    expect(body).toMatchObject({ name: "Porch ramp", recipe: "count", markupBp: 4500, rangeMode: "measured", allowMultiple: false });
    // Now it's a saved product: its supplies can be added.
    expect(container.querySelector("[data-aiew-add-supply]")).not.toBeNull();
    await unmount();
  });

  it("a supply's quantity and basis save as you go", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
      updateAttachment: () => ok({ product: adminRamp() }),
      attachSupply: () => ok({ product: adminRamp() }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    const row = container.querySelector('[data-aiew-attachment="a-rail"]')!;
    const qty = labelled(row, "How many") as HTMLInputElement;
    await type(qty, "2.5");
    await blur(qty);
    expect(fake.of("updateAttachment")[0]!.args).toEqual(["p-ramp", "a-rail", { quantityMilli: 2500 }]);
    await choose(labelled(row, "Per"), "job");
    expect(fake.of("updateAttachment")[1]!.args).toEqual(["p-ramp", "a-rail", { per: "job" }]);
    const add = container.querySelector("[data-aiew-add-supply]")!;
    await choose(labelled(add, "Supply"), "s-handrail");
    await type(labelled(add, "How many"), "0.25");
    await choose(labelled(add, "Per"), "landings");
    await click(button(add as HTMLElement, "Add supply"));
    // Handrail is bought by the foot: "Bought whole" starts off for it.
    expect(fake.of("attachSupply")[0]!.args).toEqual(["p-ramp", { supplyId: "s-handrail", quantityMilli: 250, per: "landings", roundUp: false }]);
    await unmount();
  });

  it("options: add a value with its price, pick the default", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      preview: () => ok(previewResponse()),
      createOptionValue: () => ok({ product: adminRamp() }),
      setDefaultOptionValue: () => ok({ product: adminRamp() }),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    const option = container.querySelector('[data-aiew-option="o-surface"]')!;
    await type(option.querySelector('input[placeholder^="New value"]'), "Textured");
    await type(option.querySelector('input[placeholder="+$"]'), "60");
    await click(button(option as HTMLElement, "Add value"));
    expect(fake.of("createOptionValue")[0]!.args).toEqual(["o-surface", { label: "Textured", priceModifier: 6000, isDefault: false }]);
    await click(option.querySelector('[data-aiew-value="v-hd"] input[type="radio"]'));
    expect(fake.of("setDefaultOptionValue")[0]!.args).toEqual(["v-hd"]);
    await unmount();
  });

  it("without access to costs: prices, never costs", async () => {
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp({ labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: null, effectiveRateCents: null }, lumpCosts: null })] }),
      listSupplies: () => fail("forbidden", "You don't have permission to do that."),
      preview: () => ok(previewResponse({ breakdown: null })),
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    await click(button(container, "Edit"));
    await type(labelled(container.querySelector("aside")!, "How many steps go up to the door?"), "3");
    await pass(450);
    expect(text(container.querySelector("aside"))).toContain("$6,444 – $7,164");
    expect(container.querySelector("[data-aiew-breakdown]")).toBeNull();
    expect(text(container)).toContain("You can see prices here, not costs.");
    expect(text(container.querySelector('[data-aiew-notice="no-library"]'))).toContain("You don't have permission to do that.");
    await unmount();
  });

  it("a refusal to list products is shown in the server's words, not a blank panel", async () => {
    const fake = fakeAdmin({ listProducts: () => fail("forbidden", "You don't have permission to do that."), listSupplies: () => ok({ supplies: [] }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} />);
    expect(text(container.querySelector('[data-aiew-notice="forbidden"]'))).toContain("You don't have permission to do that.");
    await unmount();
  });
});

describe("<PriceBook>: the supplies library", () => {
  it("changing a cost says which prices it moves", async () => {
    let patch: SupplyPatch | null = null;
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply()] }),
      updateSupply: (_id, p) => {
        patch = p;
        return ok({ supply: supply({ unitCost: 1900 }), affectedProducts: [{ id: "p-ramp", name: "Modular aluminum ramp" }, { id: "p-rail", name: "Handrail only" }] });
      },
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} initialTab="supplies" />);
    const row = container.querySelector('[data-aiew-supply="s-handrail"]')!;
    expect(text(row)).toContain("$18.00");
    expect(text(row)).toContain("Used by 2");
    await click(button(row as HTMLElement, "Edit"));
    const form = container.querySelector('[data-aiew-supply="s-handrail"] form')!;
    await type(labelled(form, "It costs you"), "19.00");
    await click(button(form as HTMLElement, "Save"));
    expect(patch).toMatchObject({ unitCost: 1900 });
    expect(text(container)).toContain("Updated. This changes the price of: Modular aluminum ramp, Handrail only.");
    await unmount();
  });

  it("retiring asks first and names the products it comes out of", async () => {
    let retired = false;
    const fake = fakeAdmin({
      listProducts: () => ok({ products: [adminRamp()] }),
      listSupplies: () => ok({ supplies: [supply({ isActive: !retired })] }),
      deactivateSupply: () => {
        retired = true;
        return ok({ supply: supply({ isActive: false }), affectedProducts: [{ id: "p-ramp", name: "Modular aluminum ramp" }] });
      },
    });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} initialTab="supplies" />);
    await click(button(container.querySelector('[data-aiew-supply="s-handrail"]') as HTMLElement, "Retire"));
    const dialog = container.querySelector('[data-aiew-retire="s-handrail"]')!;
    expect(text(dialog)).toContain("Retiring this takes it out of 2 products' prices: Modular aluminum ramp, Handrail only.");
    expect(fake.of("deactivateSupply")).toHaveLength(0);
    await click(button(dialog as HTMLElement, "Retire it"));
    expect(fake.of("deactivateSupply")[0]!.args).toEqual(["s-handrail"]);
    expect(text(container)).toContain("Retired Handrail. This changes the price of: Modular aluminum ramp.");
    expect(text(container)).toContain("Retired supplies (1)");
    await unmount();
  });

  it("without access to costs, the library says so and shows no amounts", async () => {
    const fake = fakeAdmin({ listProducts: () => ok({ products: [] }), listSupplies: () => ok({ supplies: [supply({ unitCost: null })] }) });
    const { container, unmount } = await mount(<PriceBook transport={fake.transport} initialTab="supplies" />);
    expect(text(container)).toContain("You can see what's used, not what it costs.");
    expect(text(container.querySelector('[data-aiew-supply="s-handrail"]'))).not.toContain("$");
    await unmount();
  });
});
