import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  allowedNextStatuses,
  calculateEstimate,
  createEstimate,
  createOptionValue,
  createProduct,
  createPublicEstimate,
  deactivateProduct,
  EstimatorInputError,
  getEstimate,
  getProductDetail,
  listPublicOptions,
  markEstimateConverted,
  midpointOf,
  nextEstimateNumber,
  QUOTE_REQUEST_NOTE,
  setDefaultOptionValue,
  setEstimateStatus,
  updateProduct,
  type PublicSubmitInput,
} from "../index.js";
import {
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
} from "../schema.js";
import { createFakeDb, type FakeDb, type FakeDbOptions } from "./fake-db.js";

const A = "tenant-a";
const B = "tenant-b";
const YEAR = new Date().getUTCFullYear();

/**
 * Tenant A's price book, plus one product of tenant B's to reach for.
 *
 *   door    — area, $150 base + $25/sqft + $75 labor, two $15 hinges (per_unit)
 *   posts   — unit, $50 each, $200 minimum
 *   ramp    — linear, $120/ft
 *   custom  — quote-only (isEstimatable: false)
 *   retired — inactive
 *   backroom — staff-only (showInEstimator: false)
 */
function catalog(options: FakeDbOptions = {}): FakeDb {
  const fake = createFakeDb(options);
  fake.seed(estimatorProducts, [
    {
      id: "door",
      tenantId: A,
      name: "Shower door",
      measurementMode: "area",
      basePrice: 15_000,
      pricePerSqFt: 2_500,
      laborCost: 7_500,
    },
    { id: "posts", tenantId: A, name: "Railing post", measurementMode: "unit", basePrice: 5_000, minimumCharge: 20_000 },
    { id: "ramp", tenantId: A, name: "Ramp", measurementMode: "linear", pricePerLinearFt: 12_000 },
    { id: "custom", tenantId: A, name: "Custom work", measurementMode: "unit", isEstimatable: false },
    { id: "retired", tenantId: A, name: "Retired", measurementMode: "unit", basePrice: 1_000, isActive: false },
    { id: "backroom", tenantId: A, name: "Staff only", measurementMode: "unit", basePrice: 1_000, showInEstimator: false },
    { id: "b-door", tenantId: B, name: "B's door", measurementMode: "unit", basePrice: 99_900 },
  ]);
  fake.seed(estimatorComponents, [
    { id: "hinge", tenantId: A, name: "Hinge", unitType: "per_unit", unitCost: 1_500 },
  ]);
  fake.seed(estimatorProductComponents, [
    { id: "door-hinge", productId: "door", componentId: "hinge", quantityMilli: 2000 },
  ]);
  fake.seed(estimatorOptions, [
    { id: "finish", productId: "door", name: "Finish", sortOrder: 10 },
    { id: "rush", productId: "door", name: "Rush fee", showInEstimator: false, sortOrder: 20 },
    { id: "b-opt", productId: "b-door", name: "B option" },
  ]);
  fake.seed(estimatorOptionValues, [
    { id: "std", optionId: "finish", label: "Standard", isDefault: true, sortOrder: 10 },
    { id: "premium", optionId: "finish", label: "Premium", priceModifier: 6_000, sortOrder: 20 },
    { id: "rush-yes", optionId: "rush", label: "Rush", priceModifier: 10_000 },
    { id: "b-val", optionId: "b-opt", label: "B value", priceModifier: 77_700 },
  ]);
  return fake;
}

const DOOR = { widthIn: 72, heightIn: 36 }; // 18 sq ft

const lead = (items: PublicSubmitInput["items"], extra: Partial<PublicSubmitInput> = {}): PublicSubmitInput => ({
  customerName: "Pat Customer",
  customerEmail: "pat@example.com",
  items,
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return error.code;
    throw error;
  }
  throw new Error("expected an EstimatorInputError");
}

async function staffEstimate(fake: FakeDb, tenantId = A): Promise<string> {
  const created = await createEstimate(fake.db, {
    tenantId,
    items: [{ description: "Labor", unitPrice: 10_000 }],
  });
  return created.id;
}

// --- 1. The public submit prices on the server -------------------------------

describe("createPublicEstimate — the browser names the job, the server prices it", () => {
  it("ignores a client-set unitPrice, laborPrice, discount, taxRateBp and photoUrl", async () => {
    const fake = catalog();
    const tampered = lead(
      [{ productId: "door", description: "Shower door", measurement: DOOR, quantity: 1, unitPrice: 1, laborPrice: 0 } as never],
      { discount: 99_999, taxRateBp: 0, photoUrl: "https://evil.example/x.png" } as never,
    );
    const created = await createPublicEstimate(fake.db, tampered, { tenantId: A, taxRateBp: 600 });

    const shown = await calculateEstimate(fake.db, { productId: "door", measurement: DOOR, quantity: 1 }, { tenantId: A, audience: "public" });
    const item = fake.rows(estimatorEstimateItems)[0]!;
    expect(item.total).toBe(midpointOf(shown!.estimateLow, shown!.estimateHigh));
    expect(item.unitPrice).not.toBe(1);
    expect(item.laborPrice).toBe(0);

    const estimate = fake.rows(estimatorEstimates)[0]!;
    expect(estimate.discount).toBe(0);
    expect(estimate.taxRateBp).toBe(600); // the tenant's, not the body's 0
    expect(estimate.photoUrl).toBeNull();
    expect(estimate.source).toBe("public_tool");
    expect(created.taxAmount).toBe(Math.round((item.total as number) * 0.06));
  });

  it("uses the documented default tax rate when the host configures none", async () => {
    const fake = catalog();
    await createPublicEstimate(fake.db, lead([{ productId: "posts" }]), { tenantId: A });
    expect(fake.rows(estimatorEstimates)[0]!.taxRateBp).toBe(825);
  });

  it("requires a name and an email or a phone — a lead nobody can call back is not a lead", async () => {
    const fake = catalog();
    const items = [{ productId: "posts" }];
    await expect(
      createPublicEstimate(fake.db, lead(items, { customerName: "  " }), { tenantId: A }),
    ).rejects.toThrow();
    await expect(
      createPublicEstimate(fake.db, lead(items, { customerEmail: "", customerPhone: null }), { tenantId: A }),
    ).rejects.toThrow(/email or a phone/);
    // A phone alone is enough.
    await createPublicEstimate(fake.db, lead(items, { customerEmail: null, customerPhone: "555-0100" }), { tenantId: A });
    expect(fake.rows(estimatorEstimates)).toHaveLength(1);
  });

  it("keeps a quote-only product as a $0 'quote requested' line (the tool's request-a-quote path)", async () => {
    const fake = catalog();
    const created = await createPublicEstimate(fake.db, lead([{ productId: "custom" }]), { tenantId: A });
    const item = fake.rows(estimatorEstimateItems)[0]!;
    expect(item.total).toBe(0);
    expect(item.notes).toBe(QUOTE_REQUEST_NOTE);
    expect(item.description).toBe("Custom work");
    expect(created.total).toBe(0);
  });

  it("refuses another tenant's, an inactive, and a staff-only product — nothing is saved", async () => {
    for (const productId of ["b-door", "retired", "backroom", "nope"]) {
      const fake = catalog();
      expect(await refusal(createPublicEstimate(fake.db, lead([{ productId }]), { tenantId: A }))).toBe(
        "product_unavailable",
      );
      expect(fake.rows(estimatorEstimates)).toHaveLength(0);
    }
  });

  it("refuses an unpriceable measurement instead of saving the base price", async () => {
    const fake = catalog();
    expect(
      await refusal(
        createPublicEstimate(fake.db, lead([{ productId: "door", measurement: { widthIn: 72 } }]), { tenantId: A }),
      ),
    ).toBe("invalid_measurement");
  });
});

// --- 2. The saved line is the line the customer was shown ------------------

describe("a server-priced line equals the midpoint of the range quoted at its real quantity", () => {
  it("with a per_unit component (staff and public paths)", async () => {
    const fake = catalog();
    const shown = await calculateEstimate(fake.db, { productId: "door", measurement: DOOR, quantity: 3 }, { tenantId: A });
    const mid = midpointOf(shown!.estimateLow, shown!.estimateHigh);

    const staff = await createEstimate(fake.db, {
      tenantId: A,
      taxRateBp: 0,
      items: [{ productId: "door", description: "Doors", measurement: DOOR, quantity: 3 }],
    });
    expect(staff.subtotal).toBe(mid);
    const staffLine = fake.rows(estimatorEstimateItems)[0]!;
    expect(staffLine.total).toBe(mid);
    expect(staffLine.unitPrice).toBe(Math.round(mid / 3));

    const pub = await createPublicEstimate(
      fake.db,
      lead([{ productId: "door", measurement: DOOR, quantity: 3 }]),
      { tenantId: A, taxRateBp: 0 },
    );
    expect(pub.subtotal).toBe(mid);
  });

  it("with a minimum charge — three $50 posts under a $200 minimum are $205, not $615", async () => {
    const fake = catalog();
    const shown = await calculateEstimate(fake.db, { productId: "posts", measurement: {}, quantity: 3 }, { tenantId: A });
    expect(shown!.subtotal).toBe(20_000);
    const created = await createEstimate(fake.db, {
      tenantId: A,
      taxRateBp: 0,
      items: [{ productId: "posts", description: "Posts", quantity: 3 }],
    });
    expect(created.subtotal).toBe(midpointOf(shown!.estimateLow, shown!.estimateHigh));
    expect(created.subtotal).toBe(20_500);
  });

  it("adds a staff laborPrice per unit on top of the engine's price", async () => {
    const fake = catalog();
    const created = await createEstimate(fake.db, {
      tenantId: A,
      taxRateBp: 0,
      items: [{ productId: "posts", description: "Posts", quantity: 3, laborPrice: 1_000 }],
    });
    expect(created.subtotal).toBe(20_500 + 3_000);
  });
});

// --- 3. The chosen options are recorded as resolved ---------------------------

describe("option selections are resolved and snapshotted on the line", () => {
  it("stores optionId→valueId and what the value was called and cost", async () => {
    const fake = catalog();
    await createPublicEstimate(
      fake.db,
      lead([{ productId: "door", measurement: DOOR, optionValueIds: ["premium", "b-val"] }]),
      { tenantId: A },
    );
    const item = fake.rows(estimatorEstimateItems)[0]!;
    expect(item.selectedOptions).toEqual({ finish: "premium" }); // B's value is not this product's
    expect(item.optionSnapshot).toEqual([
      { optionId: "finish", optionName: "Finish", valueId: "premium", valueLabel: "Premium", priceModifier: 6_000 },
    ]);
  });

  it("ignores a staff caller's selectedOptions map and records what optionValueIds resolved to", async () => {
    const fake = catalog();
    await createEstimate(fake.db, {
      tenantId: A,
      items: [
        {
          productId: "door",
          description: "Door",
          measurement: DOOR,
          optionValueIds: ["std"],
          selectedOptions: { finish: "premium", made: "up" },
        },
      ],
    });
    expect(fake.rows(estimatorEstimateItems)[0]!.selectedOptions).toEqual({ finish: "std" });
  });

  it("refuses two values of the same option (both modifiers priced, one recorded)", async () => {
    const fake = catalog();
    expect(
      await calculateEstimate(fake.db, { productId: "door", measurement: DOOR, optionValueIds: ["std", "premium"] }, { tenantId: A }),
    ).toBeNull();
    expect(
      await refusal(
        createPublicEstimate(fake.db, lead([{ productId: "door", measurement: DOOR, optionValueIds: ["std", "premium"] }]), {
          tenantId: A,
        }),
      ),
    ).toBe("invalid_options");
  });
});

// --- 4. Numbers are unique, and an estimate is saved whole or not at all -------

describe("estimate numbering and atomic insert", () => {
  it("declares a unique (tenant, number) index", () => {
    const unique = getTableConfig(estimatorEstimates).indexes.filter((i) => i.config.unique);
    expect(unique.map((i) => i.config.columns.map((c) => (c as { name: string }).name))).toContainEqual([
      "tenant_id",
      "estimate_number",
    ]);
  });

  it("numbers per tenant per year, and continues past a gap instead of colliding", async () => {
    const fake = catalog();
    expect(await nextEstimateNumber(fake.db, A)).toBe(`EST-${YEAR}-0001`);
    await staffEstimate(fake);
    await staffEstimate(fake, B);
    expect(await nextEstimateNumber(fake.db, A)).toBe(`EST-${YEAR}-0002`);
    // A row count of 2 would re-issue 0003 forever once 0003 exists and a row
    // before it is gone; the highest number is what counts.
    fake.seed(estimatorEstimates, [{ tenantId: A, estimateNumber: `EST-${YEAR}-0007` }]);
    fake.seed(estimatorEstimates, [{ tenantId: A, estimateNumber: `EST-${YEAR - 1}-0099` }]);
    expect(await nextEstimateNumber(fake.db, A)).toBe(`EST-${YEAR}-0008`);
    expect(await nextEstimateNumber(fake.db, B)).toBe(`EST-${YEAR}-0002`);
  });

  it("retries with a fresh number when a concurrent submit took the same one", async () => {
    let planted = false;
    const fake = catalog({
      beforeInsert: (table, row, db) => {
        if (table !== "estimator_estimates" || planted) return;
        planted = true;
        // Another request committed this number between our read and our insert.
        db.tables.estimator_estimates!.push({ ...row, id: "the-winner" });
      },
    });
    const created = await createEstimate(fake.db, { tenantId: A, items: [{ description: "x", unitPrice: 100 }] });
    expect(created.estimateNumber).toBe(`EST-${YEAR}-0002`);
    const numbers = fake.rows(estimatorEstimates).map((r) => r.estimateNumber);
    expect(numbers.sort()).toEqual([`EST-${YEAR}-0001`, `EST-${YEAR}-0002`]);
    expect(fake.log).toContain("tx:rollback");
    // Exactly one set of lines, attached to the estimate that won.
    expect(fake.rows(estimatorEstimateItems).map((i) => i.estimateId)).toEqual([created.id]);
  });

  it("gives up after a bounded number of collisions and surfaces the 23505", async () => {
    const fake = catalog({
      beforeInsert: (table, row, db) => {
        if (table === "estimator_estimates") db.tables.estimator_estimates!.push({ ...row, id: `c-${Math.random()}` });
      },
    });
    const error = await createEstimate(fake.db, { tenantId: A, items: [{ description: "x", unitPrice: 100 }] }).catch(
      (e: unknown) => e,
    );
    expect((error as { cause?: { code?: string } }).cause?.code).toBe("23505");
  });

  it("rolls the estimate back when its lines fail to insert", async () => {
    const fake = catalog({
      beforeInsert: (table) => {
        if (table === "estimator_estimate_items") throw new Error("disk full");
      },
    });
    await expect(
      createEstimate(fake.db, { tenantId: A, items: [{ description: "x", unitPrice: 100 }] }),
    ).rejects.toThrow("disk full");
    expect(fake.rows(estimatorEstimates)).toHaveLength(0);
  });
});

// --- 5 & 6. Unpriceable input is refused, not saved at $0 ---------------------

describe("unavailable products and bad measurements", () => {
  it("calculateEstimate answers null for a measurement the mode cannot price", async () => {
    const fake = catalog();
    const calc = (productId: string, measurement: object) =>
      calculateEstimate(fake.db, { productId, measurement }, { tenantId: A });
    expect(await calc("door", { widthIn: 72 })).toBeNull();
    expect(await calc("door", { widthIn: 0, heightIn: 36 })).toBeNull();
    expect(await calc("ramp", { linearFt: 0 })).toBeNull();
    expect(await calc("posts", { units: 0 })).toBeNull();
    expect(await calc("door", { sqFt: 18 })).not.toBeNull();
    expect(await calc("ramp", { linearFt: 24 })).not.toBeNull();
  });

  it("rejects a measurement past the sane upper bounds", async () => {
    const fake = catalog();
    await expect(
      calculateEstimate(fake.db, { productId: "ramp", measurement: { linearFt: 1e12 } }, { tenantId: A }),
    ).rejects.toThrow();
  });

  it("refuses a staff line on an inactive, another tenant's, or quote-only product", async () => {
    const fake = catalog();
    const line = (productId: string) =>
      createEstimate(fake.db, { tenantId: A, items: [{ productId, description: "x", measurement: { units: 1 } }] });
    expect(await refusal(line("retired"))).toBe("product_unavailable");
    expect(await refusal(line("b-door"))).toBe("product_unavailable");
    expect(await refusal(line("custom"))).toBe("product_not_estimatable");
    expect(
      await refusal(createEstimate(fake.db, { tenantId: A, items: [{ productId: "door", description: "x" }] })),
    ).toBe("invalid_measurement");
    expect(fake.rows(estimatorEstimates)).toHaveLength(0);
  });

  it("lets staff price a quote-only product by hand, but not reference another tenant's", async () => {
    const fake = catalog();
    const ok = await createEstimate(fake.db, {
      tenantId: A,
      taxRateBp: 0,
      items: [{ productId: "custom", description: "Custom", unitPrice: 42_000 }],
    });
    expect(ok.subtotal).toBe(42_000);
    expect(
      await refusal(
        createEstimate(fake.db, { tenantId: A, items: [{ productId: "b-door", description: "x", unitPrice: 1 }] }),
      ),
    ).toBe("product_unavailable");
  });
});

// --- 7. Every by-id call is tenant-scoped -------------------------------------

describe("tenant scoping", () => {
  it("getEstimate reads only the tenant's own estimate", async () => {
    const fake = catalog();
    const id = await staffEstimate(fake);
    expect((await getEstimate(fake.db, A, id))?.estimate.id).toBe(id);
    expect(await getEstimate(fake.db, B, id)).toBeNull();
  });

  it("getProductDetail reads only the tenant's own product", async () => {
    const fake = catalog();
    const detail = await getProductDetail(fake.db, A, "door");
    expect(detail?.product.id).toBe("door");
    expect(detail?.options.map((o) => o.option.id)).toEqual(["finish", "rush"]); // staff see staff-only options
    expect(detail?.components.map((c) => c.component.id)).toEqual(["hinge"]);
    expect(await getProductDetail(fake.db, B, "door")).toBeNull();
  });

  it("updateProduct and deactivateProduct cannot touch another tenant's product", async () => {
    const fake = catalog();
    expect(await updateProduct(fake.db, B, "door", { name: "Hijacked" })).toBeNull();
    expect(await deactivateProduct(fake.db, B, "door")).toBe(false);
    const door = fake.rows(estimatorProducts).find((p) => p.id === "door")!;
    expect(door.name).toBe("Shower door");
    expect(door.isActive).toBe(true);

    expect((await updateProduct(fake.db, A, "door", { name: "Frameless door" }))?.name).toBe("Frameless door");
    expect(await deactivateProduct(fake.db, A, "door")).toBe(true);
    expect(door.isActive).toBe(false);
  });

  it("setEstimateStatus cannot move another tenant's estimate", async () => {
    const fake = catalog();
    const id = await staffEstimate(fake);
    expect(await setEstimateStatus(fake.db, B, { id, status: "sent" })).toBe(false);
    expect(fake.rows(estimatorEstimates)[0]!.status).toBe("draft");
    expect(await setEstimateStatus(fake.db, A, { id, status: "sent" })).toBe(true);
  });

  it("calculateEstimate with a tenant scope will not price another tenant's product", async () => {
    const fake = catalog();
    expect(await calculateEstimate(fake.db, { productId: "b-door", measurement: {} }, { tenantId: A })).toBeNull();
    expect(await calculateEstimate(fake.db, { productId: "b-door", measurement: {} }, { tenantId: B })).not.toBeNull();
  });
});

// --- 8. Discount -------------------------------------------------------------

describe("discount larger than the subtotal", () => {
  it("is refused, not saved as a negative total", async () => {
    const fake = catalog();
    expect(
      await refusal(
        createEstimate(fake.db, { tenantId: A, discount: 20_000, items: [{ description: "x", unitPrice: 10_000 }] }),
      ),
    ).toBe("discount_exceeds_subtotal");
    expect(fake.rows(estimatorEstimates)).toHaveLength(0);
    const ok = await createEstimate(fake.db, {
      tenantId: A,
      taxRateBp: 0,
      discount: 10_000,
      items: [{ description: "x", unitPrice: 10_000 }],
    });
    expect(ok.total).toBe(0);
  });
});

// --- 9. updateProduct validates its patch ------------------------------------

describe("updateProduct", () => {
  it("changes only the fields in the patch (defaults never refill a partial patch)", async () => {
    const fake = catalog();
    fake.seed(estimatorProducts, [
      { id: "tuned", tenantId: A, name: "Tuned", measurementMode: "linear", basePrice: 9_900, wasteBp: 1_000, markupBp: 3_500, estimateLowBp: 9500, isEstimatable: false },
    ]);
    const row = await updateProduct(fake.db, A, "tuned", { name: "Renamed" });
    expect(row).toMatchObject({
      name: "Renamed",
      measurementMode: "linear",
      basePrice: 9_900,
      wasteBp: 1_000,
      markupBp: 3_500,
      estimateLowBp: 9500,
      isEstimatable: false,
    });
  });

  it("validates values and refuses an inverted range, even when only one end moves", async () => {
    const fake = catalog();
    await expect(updateProduct(fake.db, A, "door", { basePrice: -5 })).rejects.toThrow();
    await expect(updateProduct(fake.db, A, "door", { estimateLowBp: 12_000, estimateHighBp: 9_000 })).rejects.toThrow();
    expect(await refusal(updateProduct(fake.db, A, "door", { estimateLowBp: 12_000 }))).toBe("invalid_price_range");
    expect((await updateProduct(fake.db, A, "door", { estimateHighBp: 12_000 }))?.estimateHighBp).toBe(12_000);
  });

  it("drops a tenantId in the patch — a product cannot be moved to another workspace", async () => {
    const fake = catalog();
    await updateProduct(fake.db, A, "door", { name: "Still A's", tenantId: B } as never);
    expect(fake.rows(estimatorProducts).find((p) => p.id === "door")!.tenantId).toBe(A);
  });

  it("createProduct refuses an inverted range", async () => {
    const fake = catalog();
    expect(
      await refusal(createProduct(fake.db, { tenantId: A, name: "Bad", estimateLowBp: 13_000, estimateHighBp: 9_000 })),
    ).toBe("invalid_price_range");
  });
});

// --- 10. One default per option ---------------------------------------------

describe("a single default value per option", () => {
  const defaults = (fake: FakeDb) =>
    fake
      .rows(estimatorOptionValues)
      .filter((v) => v.optionId === "finish" && v.isDefault)
      .map((v) => v.label);

  it("a value created as the default takes it over, in one transaction", async () => {
    const fake = catalog();
    await createOptionValue(fake.db, { optionId: "finish", label: "Matte", isDefault: true });
    expect(defaults(fake)).toEqual(["Matte"]);
    expect(fake.log).toContain("tx:begin");
    await createOptionValue(fake.db, { optionId: "finish", label: "Gloss" });
    expect(defaults(fake)).toEqual(["Matte"]);
  });

  it("setDefaultOptionValue moves the default, scoped to the tenant", async () => {
    const fake = catalog();
    expect(await setDefaultOptionValue(fake.db, B, "premium")).toBe(false);
    expect(defaults(fake)).toEqual(["Standard"]);
    expect(await setDefaultOptionValue(fake.db, A, "premium")).toBe(true);
    expect(defaults(fake)).toEqual(["Premium"]);
  });
});

// --- 11. Status transitions ---------------------------------------------------

describe("estimate status transitions", () => {
  it("allows only the lifecycle's moves", async () => {
    const fake = catalog();
    const id = await staffEstimate(fake);
    const move = (status: "sent" | "viewed" | "approved" | "converted" | "draft" | "rejected") =>
      setEstimateStatus(fake.db, A, { id, status });
    expect(await move("approved")).toBe(false); // draft cannot skip to approved
    expect(await move("sent")).toBe(true);
    expect(await move("sent")).toBe(false); // not a move
    expect(await move("viewed")).toBe(true);
    expect(await move("approved")).toBe(true);
    expect(await move("converted")).toBe(true);
    expect(await move("approved")).toBe(false); // converted is terminal
    expect(await move("draft")).toBe(false);
    expect(fake.rows(estimatorEstimates)[0]!.status).toBe("converted");
  });

  it("describes the moves for a UI", () => {
    expect(allowedNextStatuses("draft")).toEqual(["sent"]);
    expect(allowedNextStatuses("rejected")).toEqual(["draft"]);
    expect(allowedNextStatuses("converted")).toEqual([]);
    expect(allowedNextStatuses("bogus")).toEqual([]);
  });

  it("markEstimateConverted claims an estimate exactly once", async () => {
    const fake = catalog();
    const id = await staffEstimate(fake);
    expect(await markEstimateConverted(fake.db, B, id)).toBeNull();
    const first = await markEstimateConverted(fake.db, A, id);
    expect(first?.status).toBe("converted");
    expect(await markEstimateConverted(fake.db, A, id)).toBeNull(); // the second invoice is refused
  });
});

// --- 12. Staff-only options ---------------------------------------------------

describe("showInEstimator on options", () => {
  it("defaults to shown, and the public option read leaves hidden ones out", async () => {
    const fake = catalog();
    expect(fake.rows(estimatorOptions).find((o) => o.id === "finish")!.showInEstimator).toBe(true);
    const options = await listPublicOptions(fake.db, A, "door");
    expect(options.map((o) => o.name)).toEqual(["Finish"]);
    expect(options[0]!.values.map((v) => v.label)).toEqual(["Standard", "Premium"]);
    expect(await listPublicOptions(fake.db, B, "door")).toEqual([]);
    expect(await listPublicOptions(fake.db, A, "backroom")).toEqual([]);
  });

  it("public pricing ignores a hidden option's value; staff pricing applies it", async () => {
    const fake = catalog();
    const input = { productId: "door", measurement: DOOR, optionValueIds: ["rush-yes"] };
    const bare = await calculateEstimate(fake.db, { productId: "door", measurement: DOOR }, { tenantId: A });
    const pub = await calculateEstimate(fake.db, input, { tenantId: A, audience: "public" });
    const staff = await calculateEstimate(fake.db, input, { tenantId: A, audience: "staff" });
    expect(pub!.subtotal).toBe(bare!.subtotal);
    expect(staff!.subtotal).toBe(bare!.subtotal + 10_000);
  });

  it("a staff-only product is not priced for the public", async () => {
    const fake = catalog();
    expect(
      await calculateEstimate(fake.db, { productId: "backroom", measurement: {} }, { tenantId: A, audience: "public" }),
    ).toBeNull();
    expect(await calculateEstimate(fake.db, { productId: "backroom", measurement: {} }, { tenantId: A })).not.toBeNull();
  });
});
