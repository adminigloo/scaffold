import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createProduct } from "../catalog.js";
import { createEstimate, createPublicEstimate } from "../estimates.js";
import { sha256Hex } from "../image.js";
import {
  attachStaffPhoto,
  keepPublicPhoto,
  listEstimatePhotos,
  purgeOrphanPhotos,
  removeEstimatePhoto,
  storePhoto,
} from "../photos.js";
import { estimatorPhotos } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { EstimatorInputError, type EstimatorDb } from "../types.js";
import { jpeg, memoryPhotoStore, photo } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Photos (6.9): kept with the estimate for the business, through the injected store. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const HOUR = 60 * 60 * 1000;

async function kept(tenantId: string, store = memoryPhotoStore(), tag = `p-${Math.random()}`, now = NOW) {
  const bytes = jpeg(768, 576, { tag });
  return keepPublicPhoto(t.db, store, tenantId, { bytes, mediaType: "image/jpeg", width: 768, height: 576 }, now);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A db whose insert into the photos table fails. */
function failingPhotoInsert(db: EstimatorDb): EstimatorDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === estimatorPhotos) throw new Error("the database is down");
          return target.insert(table as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as EstimatorDb;
}

describe("keeping photos", () => {
  it("bytes first, then the row; a row that can't be written deletes the bytes again", async () => {
    const tenantId = tenant();
    const store = memoryPhotoStore();
    const bytes = jpeg(768, 576, { tag: "order" });
    const sha256 = await sha256Hex(bytes);
    const row = await storePhoto(t.db, store, { tenantId, bytes, mediaType: "image/jpeg", width: 768, height: 576, sha256, source: "public", now: NOW });
    expect(row).toMatchObject({ tenantId, estimateId: null, sizeBytes: bytes.length, sha256, url: expect.stringMatching(/estimate-photo-[0-9a-f]{12}\.jpg$/) });
    expect(store.files.get(row.fileId)?.filename).toBe(`estimate-photo-${sha256.slice(0, 12)}.jpg`);

    await expect(
      storePhoto(failingPhotoInsert(t.db), store, { tenantId, bytes, mediaType: "image/jpeg", width: 768, height: 576, sha256, source: "public" }),
    ).rejects.toThrow("the database is down");
    expect(store.puts).toBe(2);
    expect(store.deletes).toBe(1);
    expect(store.files.size).toBe(1);
  });

  it("the same bytes from the same tenant within a day are kept once", async () => {
    const tenantId = tenant();
    const store = memoryPhotoStore();
    const first = await kept(tenantId, store, "same");
    const second = await kept(tenantId, store, "same", new Date(NOW.getTime() + 2 * HOUR));
    expect(second.id).toBe(first.id);
    const nextDay = await kept(tenantId, store, "same", new Date(NOW.getTime() + 25 * HOUR));
    expect(nextDay.id).not.toBe(first.id);
    expect((await kept(tenant(), store, "same")).id).not.toBe(first.id);
  });
});

describe("a lead links its photos", () => {
  it("only this tenant's, unlinked, recent ones — else photo_unavailable and nothing saved", async () => {
    const tenantId = tenant();
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    const product = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", basePrice: 1_000 });
    const store = memoryPhotoStore();
    const lead = (photoIds: string[], now = NOW) =>
      createPublicEstimate(t.db, { customerName: "Pat", customerEmail: "pat@x.test", items: [{ productId: product.id, inputs: { steps: 2 } }], photoIds }, { tenantId, now });

    const mine = await kept(tenantId, store);
    const created = await lead([mine.id]);
    const [linked] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.id, mine.id));
    expect(linked).toMatchObject({ estimateId: created.id });
    expect(linked!.linkedAt?.toISOString()).toBe(NOW.toISOString());

    const count = async () => (await t.client.query("select count(*)::int n from estimator_estimates where tenant_id = $1", [tenantId])).rows[0];
    const before = await count();
    expect(await refusal(lead([mine.id]))).toBe("photo_unavailable"); // already linked
    expect(await refusal(lead([(await kept(tenant(), store)).id]))).toBe("photo_unavailable"); // another tenant's
    const old = await kept(tenantId, store, "old", new Date(NOW.getTime() - 49 * HOUR));
    expect(await refusal(lead([old.id]))).toBe("photo_unavailable"); // older than 48 h
    expect(await count()).toEqual(before);
    await expect(lead(["a", "b", "c", "d"])).rejects.toBeInstanceOf(ZodError); // up to 3
  });
});

describe("staff photos", () => {
  it("staff add up to 12 to any estimate, and remove them: the row first, then the bytes", async () => {
    const tenantId = tenant();
    const store = memoryPhotoStore();
    const created = await createEstimate(t.db, { tenantId, items: [] });
    for (let i = 0; i < 12; i += 1) {
      expect(await attachStaffPhoto(t.db, store, tenantId, created.id, photo(`staff-${i}`), { now: NOW })).toMatchObject({ source: "staff", estimateId: created.id });
    }
    expect(await refusal(attachStaffPhoto(t.db, store, tenantId, created.id, photo("thirteenth")))).toBe("photo_limit");
    expect(await refusal(attachStaffPhoto(t.db, store, tenantId, created.id, { imageBase64: "AAAA", mediaType: "image/jpeg" }))).toBe("photo_invalid");
    expect(await attachStaffPhoto(t.db, store, tenant(), created.id, photo("x"))).toBeNull();

    const photos = await listEstimatePhotos(t.db, tenantId, created.id, store);
    expect(photos).toHaveLength(12);
    expect(photos[0]!.url).toMatch(/\?signed=1$/);
    expect(await removeEstimatePhoto(t.db, store, tenant(), created.id, photos[0]!.id)).toBe(false);
    store.failDelete = true;
    expect(await removeEstimatePhoto(t.db, store, tenantId, created.id, photos[0]!.id)).toBe(true); // the row is gone even if the bytes stay
    expect(await listEstimatePhotos(t.db, tenantId, created.id)).toHaveLength(11);
  });
});

describe("purgeOrphanPhotos", () => {
  it("deletes unlinked photos older than 48 h — row first; a failing store is counted, never thrown", async () => {
    const tenantId = tenant();
    const store = memoryPhotoStore();
    const stale = await kept(tenantId, store, "stale", new Date(NOW.getTime() - 50 * HOUR));
    const fresh = await kept(tenantId, store, "fresh", new Date(NOW.getTime() - 2 * HOUR));
    const created = await createEstimate(t.db, { tenantId, items: [] });
    const linked = await attachStaffPhoto(t.db, store, tenantId, created.id, photo("linked"), { now: new Date(NOW.getTime() - 100 * HOUR) });
    const purge = await purgeOrphanPhotos(t.db, store, { now: NOW });
    expect(purge.deleted).toBeGreaterThanOrEqual(1);
    expect(purge.failed).toBe(0);
    const remaining = (await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.tenantId, tenantId))).map((p) => p.id);
    expect(remaining).toEqual(expect.arrayContaining([fresh.id, linked!.id]));
    expect(remaining).not.toContain(stale.id);
    expect(store.files.has(stale.fileId)).toBe(false);

    const doomed = await kept(tenantId, store, "doomed", new Date(NOW.getTime() - 60 * HOUR));
    store.failDelete = true;
    const failing = await purgeOrphanPhotos(t.db, store, { now: NOW });
    expect(failing.failed).toBeGreaterThanOrEqual(1);
    expect((await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.id, doomed.id)))).toHaveLength(0);
  });
});
