import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "../catalog.js";
import { createEstimate, createPublicEstimate } from "../estimates.js";
import { createEstimatorAdminHandlers } from "../admin-handlers.js";
import { createEstimatorHandlers } from "../handlers.js";
import { attachStaffPhoto, keepPublicPhoto, PHOTO_CAP_MESSAGE, photoStoreRefusal, type EstimatorPhotoStore } from "../photos.js";
import { photoRefusalMessage } from "../image.js";
import { estimatorPhotos } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { runPhotoTakeoff } from "../takeoff-run.js";
import { EstimatorInputError } from "../types.js";
import { fakeModel, jpeg, memoryPhotoStore, photo, type MemoryPhotoStore } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, contract 10.5 and 15.3 (reviews G6, BO-13): the estimator's
 * photos on a company's private file storage.
 *
 *   - A storage refusal is the estimator's own sentence, wherever a photo is
 *     stored: the public `photo` route answers 4xx (never 500), staff adding
 *     a photo read theirs, a photo reading keeps going without the copy
 *     (a full store is not even reported), and the lead still goes in.
 *   - `attach` puts each photo on its estimate after the write commits; a
 *     store that refuses is reported and changes nothing.
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

/** Storage's error, structurally (6.6): its `name` and `code`, nothing imported. */
class StorageError extends Error {
  readonly name = "StorageError";
  constructor(
    readonly code: string,
    readonly share?: boolean,
  ) {
    super(`storage refused: ${code}`);
  }
}

const CODES = ["storage_full", "file_type", "file_too_big", "storage_off"] as const;
const MAPPED: Record<(typeof CODES)[number], { code: string; status: number; publicMessage: string }> = {
  storage_full: { code: "photo_limit", status: 400, publicMessage: PHOTO_CAP_MESSAGE },
  file_type: { code: "photo_invalid", status: 400, publicMessage: photoRefusalMessage("unsupported_type") },
  file_too_big: { code: "photo_invalid", status: 400, publicMessage: photoRefusalMessage("too_large") },
  storage_off: { code: "photos_disabled", status: 403, publicMessage: "This estimator doesn't take photos." },
};

function refusingStore(code: string, share?: boolean): MemoryPhotoStore {
  const store = memoryPhotoStore();
  store.put = async () => {
    throw new StorageError(code, share);
  };
  return store;
}

type Attached = Parameters<NonNullable<EstimatorPhotoStore["attach"]>>[0];
function attachingStore(options: { fail?: boolean } = {}) {
  const store = memoryPhotoStore() as MemoryPhotoStore & { attached: Attached[]; duringTransaction: boolean[] };
  store.attached = [];
  store.duringTransaction = [];
  store.attach = async (input) => {
    store.duringTransaction.push(t.inTransaction());
    if (options.fail) throw new Error("storage refused to file it");
    store.attached.push(input);
  };
  return store;
}

async function shop() {
  const tenantId = tenant("photos");
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
  const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", basePrice: 1_000 });
  return { tenantId, ramp: ramp.id };
}

describe("a storage refusal is the estimator's own sentence (review G6)", () => {
  it("photoStoreRefusal maps each code, structurally; anything else is not a refusal", () => {
    for (const code of CODES) {
      const mapped = photoStoreRefusal(new StorageError(code), "public");
      expect(mapped, code).toBeInstanceOf(EstimatorInputError);
      expect(mapped!.code, code).toBe(MAPPED[code].code);
      expect(mapped!.message, code).toBe(MAPPED[code].publicMessage);
    }
    // The share customers' photos may use is "full" too.
    expect(photoStoreRefusal(new StorageError("storage_full", true), "public")!.message).toBe(PHOTO_CAP_MESSAGE);
    // Staff read their own sentence for a full store, under the same code.
    const staff = photoStoreRefusal(new StorageError("storage_full"), "staff")!;
    expect(staff.code).toBe("photo_limit");
    expect(staff.message).not.toBe(PHOTO_CAP_MESSAGE);
    expect(staff.message).toContain("Files screen");
    expect(photoStoreRefusal(new StorageError("not_removable"), "public")).toBeNull();
    expect(photoStoreRefusal(new Error("storage is down"), "public")).toBeNull();
    expect(photoStoreRefusal(Object.assign(new Error("x"), { code: "storage_full" }), "public")).toBeNull();
    expect(photoStoreRefusal(null, "public")).toBeNull();
  });

  it("the public photo route answers 4xx with the sentence, never a 500", async () => {
    const { tenantId } = await shop();
    for (const code of CODES) {
      const errors: unknown[] = [];
      const { handle } = createEstimatorHandlers({ db: t.db, tenantId, photoStore: refusingStore(code), onError: (error) => void errors.push(error) });
      const response = await handle(
        new Request("https://summit.test/api/estimator/v1/photo", {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify(photo(`refused-${code}`)),
        }),
      );
      expect(response.status, code).toBe(MAPPED[code].status);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error, code).toEqual({ code: MAPPED[code].code, message: MAPPED[code].publicMessage });
      // A refusal is an answer, not an unexpected error.
      expect(errors, code).toEqual([]);
    }
  });

  it("a store that fails some other way is still a 500 (only storage's refusals are mapped)", async () => {
    const { tenantId } = await shop();
    const store = memoryPhotoStore();
    store.failPut = true;
    const { handle } = createEstimatorHandlers({ db: t.db, tenantId, photoStore: store, onError: () => undefined });
    const response = await handle(
      new Request("https://summit.test/api/estimator/v1/photo", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(photo("down")),
      }),
    );
    expect(response.status).toBe(500);
  });

  it("attachStaffPhoto, and the staff photo route, answer with the mapped refusal", async () => {
    const { tenantId } = await shop();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    for (const code of CODES) {
      const caught = await attachStaffPhoto(t.db, refusingStore(code), tenantId, estimate.id, photo(`staff-${code}`)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(caught, code).toBeInstanceOf(EstimatorInputError);
      expect((caught as EstimatorInputError).code, code).toBe(MAPPED[code].code);
    }
    const admin = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }), photoStore: refusingStore("storage_full"), onError: () => undefined });
    const response = await admin.handle(
      new Request(`https://summit.test/api/admin/estimator/v1/admin/estimates/${estimate.id}/photos`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(photo("staff-full")),
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("photo_limit");
    expect(await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.estimateId, estimate.id))).toEqual([]);
  });

  it("a photo reading keeps going without the copy: a full store isn't reported, other refusals are", async () => {
    const { tenantId, ramp } = await shop();
    for (const code of CODES) {
      const image = photo(`read-${code}`);
      const steps: string[] = [];
      const answer = await runPhotoTakeoff(
        t.db,
        { tenantId, productId: ramp, ...image, requesterKey: "ip:203.0.113.10", now: NOW },
        { model: fakeModel({ [image.imageBase64]: READ }), photoStore: refusingStore(code), onError: (_error, context) => void steps.push(context.step) },
      );
      expect(answer, code).toMatchObject({ status: "read", photoId: null });
      expect(steps, code).toEqual(code === "storage_full" ? [] : ["store"]);
    }
  });

  it("the lead still submits without the photo", async () => {
    const { tenantId, ramp } = await shop();
    const refused = await keepPublicPhoto(t.db, refusingStore("storage_full", true), tenantId, { bytes: jpeg(768, 576, { tag: "full" }), mediaType: "image/jpeg", width: 768, height: 576 }, NOW).then(
      () => null,
      (error: unknown) => (error as EstimatorInputError).code,
    );
    expect(refused).toBe("photo_limit");
    const created = await createPublicEstimate(
      t.db,
      { customerName: "Pat Rivera", customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [] },
      { tenantId, now: NOW },
    );
    expect(created.id).toEqual(expect.any(String));
  });
});

describe("attach: photos go on their estimate (review BO-13)", () => {
  it("after a lead with photos commits, each photo is attached to { type: 'estimator.estimate', id }", async () => {
    const { tenantId, ramp } = await shop();
    const store = attachingStore();
    const keep = (tag: string) =>
      keepPublicPhoto(t.db, store, tenantId, { bytes: jpeg(768, 576, { tag }), mediaType: "image/jpeg", width: 768, height: 576 }, NOW);
    const first = await keep("one");
    const second = await keep("two");
    expect(store.attached).toEqual([]); // a customer's photo on no estimate yet is on no record
    const created = await createPublicEstimate(
      t.db,
      { customerName: "Pat Rivera", customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [first.id, second.id] },
      { tenantId, now: NOW, photoStore: store },
    );
    expect(store.attached.map((a) => a.fileId).sort()).toEqual([first.fileId, second.fileId].sort());
    for (const attached of store.attached) {
      expect(attached).toEqual({ tenantId, fileId: attached.fileId, record: { type: "estimator.estimate", id: created.id } });
    }
    // After commit, never inside the lead's transaction.
    expect(store.duringTransaction).toEqual([false, false]);
  });

  it("a lead that is refused attaches nothing", async () => {
    const { tenantId, ramp } = await shop();
    const store = attachingStore();
    const kept = await keepPublicPhoto(t.db, store, tenantId, { bytes: jpeg(768, 576, { tag: "x" }), mediaType: "image/jpeg", width: 768, height: 576 }, NOW);
    await createPublicEstimate(
      t.db,
      { customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [kept.id] },
      { tenantId, now: NOW, photoStore: store },
    );
    store.attached.length = 0;
    // The same photo again: already linked, so the second lead is refused.
    const refusal = await createPublicEstimate(
      t.db,
      { customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [kept.id] },
      { tenantId, now: NOW, photoStore: store },
    ).then(
      () => null,
      (error: unknown) => (error as EstimatorInputError).code,
    );
    expect(refusal).toBe("photo_unavailable");
    expect(store.attached).toEqual([]);
  });

  it("the submit route hands its photo store over, so a lead from the website attaches its photos", async () => {
    const { tenantId, ramp } = await shop();
    const store = attachingStore();
    const { handle } = createEstimatorHandlers({ db: t.db, tenantId, photoStore: store });
    const post = (path: string, body: unknown) =>
      handle(
        new Request(`https://summit.test/api/estimator${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify(body),
        }),
      );
    const { photoId } = (await (await post("/v1/photo", photo("site"))).json()) as { photoId: string };
    const submitted = await post("/v1/submit", { name: "Pat Rivera", email: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [photoId], website: "", fillMs: 5000 });
    expect(submitted.status).toBe(201);
    const { estimateId } = (await submitted.json()) as { estimateId: string };
    expect(store.attached.map((a) => a.record)).toEqual([{ type: "estimator.estimate", id: estimateId }]);
  });

  it("after a staff photo, attached to its estimate", async () => {
    const { tenantId } = await shop();
    const store = attachingStore();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const row = await attachStaffPhoto(t.db, store, tenantId, estimate.id, photo("staff"));
    expect(store.attached).toEqual([{ tenantId, fileId: row!.fileId, record: { type: "estimator.estimate", id: estimate.id } }]);
  });

  it("a throwing attach is reported (step 'photo-attach') and changes nothing: the lead and the staff photo stand", async () => {
    const { tenantId, ramp } = await shop();
    const store = attachingStore({ fail: true });
    const reported: Array<{ step: string; estimateId: string }> = [];
    const onError = (_error: unknown, context: { tenantId: string; estimateId: string; step: string }) => void reported.push({ step: context.step, estimateId: context.estimateId });
    const kept = await keepPublicPhoto(t.db, store, tenantId, { bytes: jpeg(768, 576, { tag: "fail" }), mediaType: "image/jpeg", width: 768, height: 576 }, NOW);
    const created = await createPublicEstimate(
      t.db,
      { customerName: "Pat Rivera", customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [kept.id] },
      { tenantId, now: NOW, photoStore: store, onError },
    );
    const [linked] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.id, kept.id));
    expect(linked!.estimateId).toBe(created.id);
    expect(store.files.has(kept.fileId)).toBe(true);
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Sam Lee", items: [] });
    const row = await attachStaffPhoto(t.db, store, tenantId, estimate.id, photo("staff-fail"), { onError });
    expect(row).not.toBeNull();
    expect(reported).toEqual([
      { step: "photo-attach", estimateId: created.id },
      { step: "photo-attach", estimateId: estimate.id },
    ]);

    // Through the staff route, the reporter is the handler's onError.
    const routeErrors: Array<{ route: string }> = [];
    const admin = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }), photoStore: store, onError: (_e, context) => void routeErrors.push({ route: context.route }) });
    const response = await admin.handle(
      new Request(`https://summit.test/api/admin/estimator/v1/admin/estimates/${estimate.id}/photos`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(photo("staff-route")),
      }),
    );
    expect(response.status).toBe(200);
    expect(routeErrors).toEqual([{ route: "photo-attach" }]);
  });

  it("a 0.4 store with no attach works as before", async () => {
    const { tenantId } = await shop();
    const store = memoryPhotoStore();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    expect(await attachStaffPhoto(t.db, store, tenantId, estimate.id, photo("old-store"))).not.toBeNull();
  });
});
