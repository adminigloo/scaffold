import { describe, expect, it } from "vitest";
import {
  calculateEstimate,
  createEstimatorHandlers,
  ESTIMATOR_KEY_HEADER,
  issueClientKey,
  midpointOf,
  type EstimatorHandlersOptions,
} from "../index.js";
import {
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProducts,
} from "../schema.js";
import { createFakeDb, type FakeDb } from "./fake-db.js";

/**
 * The embed handler end to end over the fake database: the key resolves the
 * tenant, and the wire body cannot set a price, a tax rate or a discount.
 */

const A = "tenant-a";
const B = "tenant-b";

async function setup(options: Partial<EstimatorHandlersOptions> = {}) {
  const fake: FakeDb = createFakeDb();
  fake.seed(estimatorProducts, [
    { id: "ramp", tenantId: A, name: "Ramp", measurementMode: "linear", pricePerLinearFt: 12_000 },
    { id: "b-ramp", tenantId: B, name: "B ramp", measurementMode: "linear", pricePerLinearFt: 1 },
  ]);
  fake.seed(estimatorOptions, [
    { id: "rail", productId: "ramp", name: "Railing" },
    { id: "permit", productId: "ramp", name: "Permit handling", showInEstimator: false },
  ]);
  fake.seed(estimatorOptionValues, [
    { id: "rail-yes", optionId: "rail", label: "Both sides", priceModifier: 20_000 },
    { id: "permit-yes", optionId: "permit", label: "We pull it", priceModifier: 15_000 },
  ]);
  const { key } = await issueClientKey(fake.db, { tenantId: A, label: "Acme site" });
  const handlers = createEstimatorHandlers({ db: fake.db, ...options });
  const post = (path: string, body: unknown) =>
    handlers.handle(
      new Request(`https://host.example/api/estimator/embed${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [ESTIMATOR_KEY_HEADER]: key },
        body: JSON.stringify(body),
      }),
    );
  return { fake, post };
}

const submitBody = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  customerName: "Pat",
  customerEmail: "pat@example.com",
  source: "public_tool",
  items: [{ productId: "ramp", description: "Ramp", measurement: { linearFt: 24 }, quantity: 1, ...item }],
  ...extra,
});

describe("POST /v1/submit", () => {
  it("prices on the server whatever unitPrice, discount or taxRateBp the body carries", async () => {
    const { fake, post } = await setup({ taxRateBp: 700 });
    const res = await post(
      "/v1/submit",
      submitBody({ unitPrice: 1, laborPrice: 0 }, { discount: 50_000, taxRateBp: 0, photoUrl: "x" }),
    );
    expect(res.status).toBe(200);
    const shown = await calculateEstimate(fake.db, { productId: "ramp", measurement: { linearFt: 24 } }, { tenantId: A });
    const item = fake.rows(estimatorEstimateItems)[0]!;
    expect(item.total).toBe(midpointOf(shown!.estimateLow, shown!.estimateHigh));
    const estimate = fake.rows(estimatorEstimates)[0]!;
    expect(estimate).toMatchObject({ tenantId: A, discount: 0, taxRateBp: 700, photoUrl: null });
  });

  it("refuses another tenant's product with a 400 that names the refusal", async () => {
    const { fake, post } = await setup();
    const res = await post("/v1/submit", submitBody({ productId: "b-ramp" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "product_unavailable" });
    expect(fake.rows(estimatorEstimates)).toHaveLength(0);
  });

  it("answers 400 for a lead with no way to reach the customer, and saves nothing", async () => {
    const { fake, post } = await setup();
    const res = await post("/v1/submit", submitBody({}, { customerEmail: null, customerPhone: null }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid request" });
    expect(fake.rows(estimatorEstimates)).toHaveLength(0);
  });

  it("calls onLead after a save, and a throwing listener does not fail the submit", async () => {
    const leads: unknown[] = [];
    const { post } = await setup({ onLead: (lead) => void leads.push(lead) });
    const res = await post("/v1/submit", submitBody({}));
    const created = (await res.json()) as { id: string; estimateNumber: string };
    expect(leads).toEqual([{ tenantId: A, estimateId: created.id, estimateNumber: created.estimateNumber }]);

    const broken = await setup({
      onLead: () => {
        throw new Error("mailer down");
      },
    });
    expect((await broken.post("/v1/submit", submitBody({}))).status).toBe(200);
  });
});

describe("POST /v1/options and /v1/calculate", () => {
  it("never sends a staff-only option, and prices as if it were not chosen", async () => {
    const { post } = await setup();
    const options = (await (await post("/v1/options", { productId: "ramp" })).json()) as {
      options: Array<{ name: string }>;
    };
    expect(options.options.map((o) => o.name)).toEqual(["Railing"]);

    const calc = async (optionValueIds: string[]) =>
      ((await (await post("/v1/calculate", { productId: "ramp", measurement: { linearFt: 24 }, optionValueIds })).json()) as {
        result: { subtotal: number } | null;
      }).result;
    const bare = await calc([]);
    expect((await calc(["permit-yes"]))!.subtotal).toBe(bare!.subtotal);
    expect((await calc(["rail-yes"]))!.subtotal).toBe(bare!.subtotal + 20_000);
  });

  it("prices nothing for another tenant's product", async () => {
    const { post } = await setup();
    const res = await post("/v1/calculate", { productId: "b-ramp", measurement: { linearFt: 24 } });
    expect(await res.json()).toEqual({ result: null });
  });
});

describe("POST /v1/takeoff", () => {
  it("runs only for a live, public product of the key's tenant", async () => {
    const seen: string[] = [];
    const { fake, post } = await setup({
      runTakeoff: async (req) => {
        seen.push(req.productId);
        return { available: true, result: null };
      },
    });
    fake.seed(estimatorProducts, [
      { id: "hidden", tenantId: A, name: "Hidden", measurementMode: "unit", showInEstimator: false },
      { id: "gone", tenantId: A, name: "Gone", measurementMode: "unit", isActive: false },
    ]);
    const photo = { imageBase64: "aGVsbG8gd29ybGQgaGVsbG8=", mediaType: "image/png" };
    for (const productId of ["b-ramp", "hidden", "gone"]) {
      expect((await post("/v1/takeoff", { productId, ...photo })).status).toBe(404);
    }
    expect((await post("/v1/takeoff", { productId: "ramp", ...photo })).status).toBe(200);
    expect(seen).toEqual(["ramp"]);
  });
});
