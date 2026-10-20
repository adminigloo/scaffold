import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts, updateProduct } from "../catalog.js";
import { priceProduct } from "../price-product.js";
import { loadSampleCatalog } from "../sample.js";
import { getEstimatorSettings, updateEstimatorSettings } from "../settings.js";
import { startingPrices } from "../starting-prices.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * "From $X" on a business's public page (create-app 0.36): the services the
 * owner put on the website, each priced for its smallest job by the estimate
 * page's own pricing — never a number from anywhere else.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function business(tenantId: string) {
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, {
    businessName: "Summit Ramps",
    contactPhone: "(801) 555-0143",
    contactEmail: "hello@summit.test",
    timeZone: "America/Denver",
    taxRateBp: 725,
  });
}

describe("startingPrices", () => {
  it("lists the website's products in the price book's order, each with the low end of its smallest job", async () => {
    await business("from-1");
    const services = await startingPrices(t.db, "from-1");
    const products = await listProducts(t.db, "from-1", { publicOnly: true });
    expect(services.map((s) => s.productId)).toEqual(products.map((p) => p.id));
    const priced = services.filter((s) => s.fromCents !== null);
    expect(priced.length).toBeGreaterThan(0);
    for (const service of priced) {
      expect(service.fromCents).toBeGreaterThan(0);
      expect(service.from).toMatch(/^\$[\d,]+$/);
    }
    // The ramp's "from" IS the estimate page's price for one step.
    const ramp = products.find((p) => p.name === "Modular aluminum ramp")!;
    const own = await priceProduct(t.db, "from-1", { productId: ramp.id, inputs: { steps: 1 }, quantity: 1 }, { audience: "public" });
    expect(own.status).toBe("priced");
    const listed = services.find((s) => s.productId === ramp.id)!;
    expect(listed.fromCents).toBe(own.status === "priced" ? own.build.estimateLow : -1);
    // Rounded down to whole dollars, never above the real floor.
    expect(Number(listed.from!.replace(/[$,]/g, "")) * 100).toBeLessThanOrEqual(listed.fromCents!);
  });

  it("leaves out what isn't on the website, and gives no price while instant estimates are closed", async () => {
    await business("from-2");
    const [first, ...rest] = await listProducts(t.db, "from-2", { publicOnly: true });
    await updateProduct(t.db, "from-2", first!.id, { showInEstimator: false });
    const shown = await startingPrices(t.db, "from-2");
    expect(shown.map((s) => s.productId)).toEqual(rest.map((p) => p.id));
    // Negative control: the same catalog with instant estimates switched off shows names, no prices.
    await updateEstimatorSettings(t.db, "from-2", { instantEstimatesEnabled: false });
    const closed = await startingPrices(t.db, "from-2", { settings: await getEstimatorSettings(t.db, "from-2") });
    expect(closed.length).toBe(rest.length);
    expect(closed.every((s) => s.fromCents === null && s.from === null)).toBe(true);
  });
});
