import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct } from "../catalog.js";
import { createEstimate, createPublicEstimate } from "../estimates.js";
import { createEstimatorAdminHandlers } from "../admin-handlers.js";
import { estimatorPhotoPurpose, estimatorStaffPhotoPurpose } from "../index.js";
import { attachStaffPhoto, keepPublicPhoto, PHOTO_CAP_MESSAGE, photoStoreRefusal } from "../photos.js";
import { estimatorPhotos } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { EstimatorInputError } from "../types.js";
import { jpeg, memoryPhotoStore, photo, type MemoryPhotoStore } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1 review SEC-02 (the estimator's half) and BO-12.
 *
 * Strangers could fill the share of storage kept for customers' photos for
 * good: linked photos counted toward no daily cap and are never purged. Then
 * staff couldn't add photos to their own estimates either (same purpose,
 * same share), and were sent to a Files screen that can't remove these
 * photos. Now:
 *
 *   - staff's photos have their own purpose and store
 *     (`estimatorStaffPhotoPurpose`, the admin handlers' `staffPhotoStore`),
 *     outside the customers' share, counted like the crew's job photos;
 *   - a customer's photo counts toward the day's caps whether or not its
 *     lead was sent;
 *   - a full share is told to staff as what they can do: remove photos from
 *     estimates, never "free some up on the Files screen".
 *
 * And a photo is named in plain words, never "estimate-photo-b058938721a7".
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const ADMIN = "https://summit.test/api/admin/estimator/v1/admin";

/** Storage's error, structurally (6.6): its `name`, `code` and `share`, nothing imported. */
class StorageError extends Error {
  readonly name = "StorageError";
  constructor(
    readonly code: string,
    readonly share?: boolean,
  ) {
    super(`storage refused: ${code}`);
  }
}

/** The customers' store with its share used up: every put is refused as storage refuses it. */
function shareFullStore(): MemoryPhotoStore {
  const store = memoryPhotoStore();
  store.put = async () => {
    throw new StorageError("storage_full", true);
  };
  return store;
}

async function shop() {
  const tenantId = tenant("share");
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
  const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", basePrice: 1_000 });
  return { tenantId, ramp: ramp.id };
}

function post(handle: (req: Request) => Promise<Response>, path: string, body: unknown = {}) {
  return handle(new Request(`${ADMIN}${path}`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) }));
}

describe("staff's photos are kept apart from the customers' share (review SEC-02)", () => {
  it("estimatorStaffPhotoPurpose: private, its own key, counted like the crew's photos (no exemption, no share)", () => {
    expect(estimatorStaffPhotoPurpose.key).not.toBe(estimatorPhotoPurpose.key);
    expect(estimatorStaffPhotoPurpose).toMatchObject({
      key: "estimator.staff-photo",
      access: "private",
      types: ["jpeg", "png", "webp"],
      maxBytes: estimatorPhotoPurpose.maxBytes,
      view: ["estimator.view"],
      removableFromFiles: false,
      hiddenUntilAttached: true,
    });
    expect("exemptFromAllowance" in estimatorStaffPhotoPurpose).toBe(false);
    expect("maxShareOfAllowance" in estimatorStaffPhotoPurpose).toBe(false);
    expect(estimatorStaffPhotoPurpose.label).not.toBe(estimatorPhotoPurpose.label);
    expect(Object.isFrozen(estimatorStaffPhotoPurpose)).toBe(true);
  });

  it("with the customers' share full, staff still add, see and remove their own photos (through staffPhotoStore)", async () => {
    const { tenantId } = await shop();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const customers = shareFullStore();
    const staff = memoryPhotoStore();
    const admin = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }), photoStore: customers, staffPhotoStore: staff, now: () => NOW });
    const added = await post(admin.handle, `/estimates/${estimate.id}/photos`, photo("staff-own"));
    expect(added.status).toBe(200);
    expect(staff.puts).toBe(1);
    const [row] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.estimateId, estimate.id));
    expect(row).toMatchObject({ source: "staff" });
    expect(staff.files.has(row!.fileId)).toBe(true);
    // The editor opens it through the store that holds it.
    const detail = (await (await admin.handle(new Request(`${ADMIN}/estimates/${estimate.id}`))).json()) as { estimate: { photos: Array<{ id: string; url: string }> } };
    expect(detail.estimate.photos.map((p) => p.url)).toEqual([`https://files.test/${row!.fileId}/Estimate photo.jpg?signed=1`]);
    // And removing it takes it out of that store.
    expect((await post(admin.handle, `/estimates/${estimate.id}/photos/${row!.id}/remove`)).status).toBe(200);
    expect(staff.deletes).toBe(1);
    expect(staff.files.size).toBe(0);
  });

  it("without staffPhotoStore (a 0.4 host), staff photos use photoStore as before", async () => {
    const { tenantId } = await shop();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const store = memoryPhotoStore();
    const admin = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }), photoStore: store, now: () => NOW });
    expect((await post(admin.handle, `/estimates/${estimate.id}/photos`, photo("shared-store"))).status).toBe(200);
    expect(store.puts).toBe(1);
  });

  it("a full share is told to staff as what helps: remove photos from estimates, not the Files screen", async () => {
    const share = photoStoreRefusal(new StorageError("storage_full", true), "staff")!;
    expect(share.code).toBe("photo_limit");
    expect(share.message).not.toContain("Files screen");
    expect(share.message).toBe("The room kept for estimate photos is full. Remove photos you don't need from your estimates, then try again.");
    // The whole company full: the Files screen does help (other files can go), and so do estimates.
    const full = photoStoreRefusal(new StorageError("storage_full"), "staff")!;
    expect(full.message).toBe("There's no room left for photos. The owner can free some up on the Files screen, or remove photos from estimates, then try again.");
    // The customer's sentence is unchanged either way.
    expect(photoStoreRefusal(new StorageError("storage_full", true), "public")!.message).toBe(PHOTO_CAP_MESSAGE);
    // And the route says the same.
    const { tenantId } = await shop();
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const caught = await attachStaffPhoto(t.db, shareFullStore(), tenantId, estimate.id, photo("share-full")).catch((error: unknown) => error);
    expect((caught as EstimatorInputError).message).toBe(share.message);
  });
});

describe("a customer's photo counts toward the day's caps once its lead is sent (review SEC-02)", () => {
  const image = (tag: string) => ({ bytes: jpeg(768, 576, { tag }), mediaType: "image/jpeg" as const, width: 768, height: 576 });

  it("the business's cap: photos on sent leads still count, so junk leads can't refill the store every day", async () => {
    const { tenantId, ramp } = await shop();
    const store = memoryPhotoStore();
    const limits = { perTenantDaily: 2, perRequesterDaily: 100 };
    const first = await keepPublicPhoto(t.db, store, tenantId, image("t1"), NOW, { requesterHash: "a", limits });
    const second = await keepPublicPhoto(t.db, store, tenantId, image("t2"), NOW, { requesterHash: "b", limits });
    await createPublicEstimate(
      t.db,
      { customerName: "Junk Lead", customerEmail: "junk@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [first.id, second.id] },
      { tenantId, now: NOW },
    );
    const third = await keepPublicPhoto(t.db, store, tenantId, image("t3"), NOW, { requesterHash: "c", limits }).catch((error: unknown) => error);
    expect(third).toBeInstanceOf(EstimatorInputError);
    expect((third as EstimatorInputError).code).toBe("photo_limit");
    expect(store.puts).toBe(2);
    // A day later the count starts again.
    const tomorrow = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect((await keepPublicPhoto(t.db, store, tenantId, image("t4"), tomorrow, { requesterHash: "c", limits })).id).toEqual(expect.any(String));
  });

  it("the visitor's cap: the same, per visitor", async () => {
    const { tenantId, ramp } = await shop();
    const store = memoryPhotoStore();
    const limits = { perTenantDaily: 100, perRequesterDaily: 1 };
    const sent = await keepPublicPhoto(t.db, store, tenantId, image("r1"), NOW, { requesterHash: "visitor", limits });
    await createPublicEstimate(
      t.db,
      { customerName: "Junk Lead", customerEmail: "junk@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }], photoIds: [sent.id] },
      { tenantId, now: NOW },
    );
    const again = await keepPublicPhoto(t.db, store, tenantId, image("r2"), NOW, { requesterHash: "visitor", limits }).catch((error: unknown) => error);
    expect((again as EstimatorInputError).code).toBe("photo_limit");
    // Another visitor isn't held back by this one.
    expect((await keepPublicPhoto(t.db, store, tenantId, image("r3"), NOW, { requesterHash: "someone-else", limits })).id).toEqual(expect.any(String));
  });
});

describe("a photo is named in plain words (review BO-12)", () => {
  it("a customer's photo is 'Customer photo', a staff photo 'Estimate photo': never a hash", async () => {
    const { tenantId } = await shop();
    const store = memoryPhotoStore();
    const kept = await keepPublicPhoto(t.db, store, tenantId, { bytes: jpeg(768, 576, { tag: "named" }), mediaType: "image/jpeg", width: 768, height: 576 }, NOW);
    expect(store.files.get(kept.fileId)?.filename).toBe("Customer photo.jpg");
    const estimate = await createEstimate(t.db, { tenantId, customerName: "Pat Rivera", items: [] });
    const added = await attachStaffPhoto(t.db, store, tenantId, estimate.id, photo("named-staff"));
    expect(store.files.get(added!.fileId)?.filename).toBe("Estimate photo.jpg");
    for (const file of store.files.values()) expect(file.filename).not.toMatch(/[0-9a-f]{8}/);
  });
});
