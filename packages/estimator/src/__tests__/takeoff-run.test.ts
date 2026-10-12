import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "../catalog.js";
import { estimatorPhotos, estimatorTakeoffs } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { runPhotoTakeoff } from "../takeoff-run.js";
import type { TakeoffUsage } from "../takeoff.js";
import { EstimatorInputError, type EstimatorDb } from "../types.js";
import { fakeModel, jpeg, memoryPhotoStore, photo, toBase64 } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The reading pipeline (5.7), step by step: every reason not to call the
 * model comes before the call, every limit fails closed, and every call is
 * one ledger row with its tokens and cost.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const READ = { seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" };

async function setup() {
  const tenantId = tenant("read");
  // The public side is open only once the business is set up (review EST-R02).
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
  const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
  const area = await createProduct(t.db, { tenantId, name: "Pad", recipe: "area" });
  const counted = await createProduct(t.db, {
    tenantId,
    name: "Grab bars",
    recipe: "count",
    recipeConfig: { photoSubject: "the grab bars", noun: { one: "grab bar", many: "grab bars" } },
  });
  return { tenantId, ramp: ramp.id, area: area.id, counted: counted.id };
}

const input = (tenantId: string, productId: string, image = photo("porch"), extra: Record<string, unknown> = {}) => ({
  tenantId,
  productId,
  ...image,
  requesterKey: "ip:203.0.113.10",
  now: NOW,
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

/**
 * A db whose select with a field named `field` fails (the limit queries) —
 * inside a transaction too: the count, the budget and the claim run in one.
 */
function failingSelect(db: EstimatorDb, field: string): EstimatorDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (run: (tx: EstimatorDb) => Promise<unknown>, config?: unknown) =>
          target.transaction((tx) => run(failingSelect(tx as EstimatorDb, field)), config as never);
      }
      if (prop === "select") {
        return (fields?: Record<string, unknown>) =>
          fields && field in fields
            ? { from: () => ({ where: () => Promise.reject(new Error("the database is down")) }) }
            : target.select(fields as never);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as EstimatorDb;
}

describe("runPhotoTakeoff, in order", () => {
  it("1. a bad photo is refused before any query", async () => {
    const { tenantId, ramp } = await setup();
    const model = fakeModel();
    t.queries.length = 0;
    expect(await refusal(runPhotoTakeoff(t.db, { ...input(tenantId, ramp), imageBase64: "not base64!" }, { model }))).toBe("photo_invalid");
    expect(
      await refusal(runPhotoTakeoff(t.db, { ...input(tenantId, ramp), imageBase64: toBase64(jpeg(2000, 1500)) }, { model })),
    ).toBe("photo_invalid");
    expect(await refusal(runPhotoTakeoff(t.db, { ...input(tenantId, ramp), mediaType: "image/png" }, { model }))).toBe("photo_invalid");
    expect(t.queries).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("2–3. the product, then the settings", async () => {
    const { tenantId, ramp } = await setup();
    const other = await setup();
    const model = fakeModel();
    expect(await refusal(runPhotoTakeoff(t.db, input(tenantId, other.ramp), { model }))).toBe("product_unavailable");
    await updateEstimatorSettings(t.db, tenantId, { photosEnabled: false });
    expect(await refusal(runPhotoTakeoff(t.db, input(tenantId, ramp), { model }))).toBe("photos_disabled");
    await updateEstimatorSettings(t.db, tenantId, { photosEnabled: true, instantEstimatesEnabled: false });
    expect(await refusal(runPhotoTakeoff(t.db, input(tenantId, ramp), { model }))).toBe("estimates_closed");
    expect(model.calls).toHaveLength(0);
  });

  it("5. a copy is kept for the business (and reused by hash); a failing store never stops the reading", async () => {
    const { tenantId, ramp } = await setup();
    const store = memoryPhotoStore();
    const image = photo("kept");
    const model = fakeModel({ [image.imageBase64]: READ });
    const first = await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model, photoStore: store });
    expect(first.photoId).toEqual(expect.any(String));
    const second = await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model, photoStore: store });
    expect(second.photoId).toBe(first.photoId);
    expect(store.puts).toBe(1);
    const [row] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.id, first.photoId!));
    expect(row).toMatchObject({ tenantId, estimateId: null, contentType: "image/jpeg", width: 768, height: 576, source: "public" });

    store.failPut = true;
    const errors: string[] = [];
    const other = photo("store-down");
    const readAnyway = await runPhotoTakeoff(t.db, input(tenantId, ramp, other), {
      model: fakeModel({ [other.imageBase64]: READ }),
      photoStore: store,
      onError: (_error, context) => void errors.push(context.step),
    });
    expect(readAnyway).toMatchObject({ status: "read", photoId: null });
    expect(errors).toEqual(["store"]);
  });

  it("6–8. measured already, a recipe that reads no photos, reading switched off: no model call", async () => {
    const { tenantId, ramp, area } = await setup();
    const model = fakeModel();
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("m"), { inputs: { steps: 3, stepHeightIn: 7.5 } }), { model })).status).toBe("not_needed");
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("m2"), { inputs: { totalRiseIn: 30 } }), { model })).status).toBe("not_needed");
    const typedCount = await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("m3"), { inputs: { steps: 3 } }), { model });
    // Steps alone are not a measurement: the photo is still read, for the height.
    expect(typedCount.status).toBe("unreadable");
    expect(model.calls).toHaveLength(1);
    const callsAfterRead = model.calls.length;
    const pad = await runPhotoTakeoff(t.db, input(tenantId, area), { model });
    expect(pad).toMatchObject({ status: "not_supported", available: false, message: "Thanks for the photo. This one is priced from your measurements, so please fill those in." });
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("nomodel")), {})).status).toBe("unavailable");
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 0 });
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("off")), { model })).status).toBe("unavailable");
    expect(model.calls).toHaveLength(callsAfterRead);
  });

  it("9. the cache: an identical photo for this tenant and product is read once, free the second time", async () => {
    const { tenantId, ramp } = await setup();
    const image = photo("cache");
    const model = fakeModel({ [image.imageBase64]: READ });
    const usage: TakeoffUsage[] = [];
    const first = await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model, recordUsage: (u) => void usage.push(u) });
    const again = await runPhotoTakeoff(t.db, input(tenantId, ramp, image, { requesterKey: "ip:other" }), { model, recordUsage: (u) => void usage.push(u) });
    expect(again).toMatchObject({ status: "read", cached: true });
    expect(again.reading).toEqual(first.reading);
    expect(model.calls).toHaveLength(1);
    expect(usage).toHaveLength(1);
    // Another tenant's identical photo is its own reading.
    const other = await setup();
    await runPhotoTakeoff(t.db, input(other.tenantId, other.ramp, image), { model });
    expect(model.calls).toHaveLength(2);
  });

  it("10. per requester, today: limited at the cap, and when the count fails", async () => {
    const { tenantId, ramp } = await setup();
    await updateEstimatorSettings(t.db, tenantId, { aiPerRequesterDaily: 2 });
    const model = fakeModel();
    await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("a1")), { model });
    await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("a2")), { model });
    const third = await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("a3")), { model });
    expect(third).toMatchObject({ status: "limited", message: "You've used today's photo readings, so please count the steps and enter the number." });
    // A null requester is its own bucket; tomorrow (UTC) is a new day.
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("a4"), { requesterKey: null }), { model })).status).not.toBe("limited");
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("a5"), { now: new Date(NOW.getTime() + 24 * 3600_000) }), { model })).status).not.toBe("limited");
    expect(model.calls).toHaveLength(4);
    const failing = await runPhotoTakeoff(failingSelect(t.db, "n"), input(tenantId, ramp, photo("a6"), { requesterKey: "ip:fresh" }), { model, onError: () => undefined });
    expect(failing.status).toBe("limited");
    expect(model.calls).toHaveLength(4);
  });

  it("11. the day's budget: paused before a call that could pass it, and when the sum fails", async () => {
    const { tenantId, ramp } = await setup();
    // 1 cent = 10 000 micro-dollars; each fake reading is 4 250; the ceiling of a call is 2 750.
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 1 });
    const model = fakeModel();
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("b1")), { model })).status).toBe("unreadable");
    // 4 250 spent + 2 750 ceiling = 7 000 ≤ 10 000: one more.
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("b2")), { model })).status).toBe("unreadable");
    const paused = await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("b3")), { model });
    expect(paused).toMatchObject({ status: "paused", message: "Photo reading is paused for today, so please count the steps and enter the number." });
    expect(model.calls).toHaveLength(2);
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 100 });
    const failing = await runPhotoTakeoff(failingSelect(t.db, "micros"), input(tenantId, ramp, photo("b4")), { model, onError: () => undefined });
    expect(failing.status).toBe("paused");
    expect(model.calls).toHaveLength(2);
  });

  it("12. the claim: a fresh pending row is busy; a failed or stale one is reclaimed", async () => {
    const { tenantId, ramp } = await setup();
    const image = photo("claimed");
    const model = fakeModel({ [image.imageBase64]: READ });
    const { sha256Hex, decodeBase64Strict } = await import("../image.js");
    const hash = await sha256Hex(decodeBase64Strict(image.imageBase64)!);
    await t.db.insert(estimatorTakeoffs).values({ tenantId, productId: ramp, recipe: "ramp_over_steps", photoHash: hash, status: "pending", createdAt: new Date(NOW.getTime() - 30_000) });
    expect(await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model })).toMatchObject({
      status: "busy",
      message: "We're already reading this photo. Give it a moment and try again.",
    });
    expect(model.calls).toHaveLength(0);
    // Ninety seconds later the claim is stale: this request takes it over.
    const later = await runPhotoTakeoff(t.db, input(tenantId, ramp, image, { now: new Date(NOW.getTime() + 60_000) }), { model });
    expect(later.status).toBe("read");
    expect(model.calls).toHaveLength(1);
    const rows = await t.db.select().from(estimatorTakeoffs).where(eq(estimatorTakeoffs.photoHash, hash));
    expect(rows).toHaveLength(1);
  });

  it("13. a model that throws: the row fails at the cost ceiling, usage says errored, the customer types it", async () => {
    const { tenantId, ramp } = await setup();
    const image = photo("timeout");
    const model = fakeModel({ [image.imageBase64]: "throw" });
    const usage: TakeoffUsage[] = [];
    const answer = await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model, recordUsage: (u) => void usage.push(u), onError: () => undefined });
    expect(answer).toMatchObject({ status: "unavailable", message: "We can't read photos right now, so please count the steps and enter the number." });
    const [row] = await t.db.select().from(estimatorTakeoffs).where(eq(estimatorTakeoffs.tenantId, tenantId));
    expect(row).toMatchObject({ status: "failed", error: "timeout", costMicros: 2_750, costEstimated: true });
    expect(JSON.stringify(row)).not.toContain(image.imageBase64.slice(0, 40));
    expect(usage).toEqual([expect.objectContaining({ outcome: "errored", costEstimated: true, costMicros: 2_750 })]);
    // The failed row is reclaimed by the next try.
    const fixed = fakeModel({ [image.imageBase64]: READ });
    expect((await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model: fixed })).status).toBe("read");
  });

  it("14. a read stores the normalized observation, tokens, cost and model; the recorder hears every field", async () => {
    const { tenantId, ramp } = await setup();
    const image = photo("full");
    const model = fakeModel({ [image.imageBase64]: { ...READ, summary: "a 24 ft ramp", lengthFt: 24 } }, { inputTokens: 690, outputTokens: 38 });
    const usage: TakeoffUsage[] = [];
    const answer = await runPhotoTakeoff(t.db, input(tenantId, ramp, image), { model, recordUsage: (u) => void usage.push(u) });
    expect(answer.reading).toMatchObject({ status: "read", confidence: "medium", seen: true, suggested: { steps: 3 }, heightRangeIn: { low: 7.5, high: 8.5 }, usable: true });
    const [row] = await t.db.select().from(estimatorTakeoffs).where(eq(estimatorTakeoffs.id, answer.reading!.takeoffId));
    expect(row).toMatchObject({
      status: "read",
      observation: { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" },
      inputTokens: 690,
      outputTokens: 38,
      costMicros: 880,
      model: "claude-haiku-4-5",
      costEstimated: false,
    });
    expect(row!.requesterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(usage).toEqual([
      {
        tenantId,
        takeoffId: answer.reading!.takeoffId,
        operation: "estimator_takeoff",
        model: "claude-haiku-4-5",
        inputTokens: 690,
        outputTokens: 38,
        costMicros: 880,
        costEstimated: false,
        outcome: "read",
        durationMs: expect.any(Number),
      },
    ]);
    // The request the model saw: the system line, the recipe's prompt, the strict schema, 150 tokens.
    expect(model.calls[0]).toMatchObject({ maxTokens: 150, image: { mediaType: "image/jpeg", base64: image.imageBase64 } });
    expect(model.calls[0]!.prompt).toContain("Count the risers");

    // A throwing recorder is contained.
    const errors: string[] = [];
    const contained = await runPhotoTakeoff(t.db, input(tenantId, ramp, photo("recorder")), {
      model,
      recordUsage: () => {
        throw new Error("ai_usage table missing");
      },
      onError: (_e, c) => void errors.push(c.step),
    });
    expect(contained.status).toBe("unreadable");
    expect(errors).toEqual(["usage"]);
  });

  it("a count product with a photo subject reads its noun", async () => {
    const { tenantId, counted } = await setup();
    const image = photo("bars");
    const model = fakeModel({ [image.imageBase64]: { seen: true, count: 2, confidence: "high" } });
    const answer = await runPhotoTakeoff(t.db, input(tenantId, counted, image), { model });
    expect(answer.reading?.lines).toEqual(["We counted 2 grab bars.", "You can change the count if it's wrong."]);
    expect(model.calls[0]!.prompt).toBe("Photo of: the grab bars.\nCount the grab bars you can see.\nSet seen to false if there are none.");
  });
});
