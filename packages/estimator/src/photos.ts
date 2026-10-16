import { and, asc, count, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { decodeBase64Strict, inspectImage, photoRefusalMessage, sha256Hex, type PhotoMediaTypeName } from "./image.js";
import { estimatorEstimates, estimatorPhotos, estimatorTakeoffs } from "./schema.js";
import { EstimatorInputError, type EstimatorDb, type PhotoRow } from "./types.js";
import type { EstimatePhoto } from "./wire.js";

/**
 * Photos (section 6.9 of the 0.3 contract): a customer's photo is KEPT with
 * their estimate, so the business sees the steps before anyone drives out.
 * 0.2 sent the photo to the model and threw it away.
 *
 * The bytes go to an injected `EstimatorPhotoStore`; the package never imports
 * @adminigloo/storage (create-app's adapter wraps its `storeFile` /
 * `deleteFile`). Without a store, no photo is kept — the public config says
 * `photos.attach: false` — and a reading still works: the photo goes to the
 * model and nowhere else.
 */

export interface EstimatorPhotoStore {
  put(input: { tenantId: string; bytes: Uint8Array; contentType: string; filename: string }): Promise<{ fileId: string; url: string }>;
  delete(input: { tenantId: string; fileId: string }): Promise<void>;
  /** A URL staff can open now (a signed URL, say). Default: the stored url. */
  urlFor?(input: { tenantId: string; fileId: string; url: string }): string | Promise<string>;
  /**
   * Puts the stored photo on its estimate (Tenancy 2b-1, review BO-13), so a
   * host's file storage files it under "Estimate 1042 · Pat Rivera" and the
   * estimate's own permissions decide who opens it. Called after the
   * estimate's write commits; a throw is reported (step "photo-attach") and
   * changes nothing else. @adminigloo/storage's
   * `purposeStore("estimator.photo")` has it; a 0.4 store without it is fine.
   */
  attach?(input: { tenantId: string; fileId: string; record: { type: "estimator.estimate"; id: string } }): Promise<void>;
}

/** Told about a photo step that failed after the estimate's write committed (the write stands). */
export type PhotoStepReporter = (error: unknown, context: { tenantId: string; estimateId: string; step: "photo-attach" }) => void;

/**
 * Put stored photos on their estimate (`attach`), one by one, each contained:
 * the estimate and its photo rows are already committed, so a store that
 * refuses changes nothing but where the Files screen lists the file (it
 * stays "not on a record" until the files cron or a retry puts it there).
 */
export async function attachPhotosToEstimate(
  store: EstimatorPhotoStore | null | undefined,
  input: { tenantId: string; estimateId: string; fileIds: readonly string[] },
  onError?: PhotoStepReporter,
): Promise<void> {
  if (!store?.attach || input.fileIds.length === 0) return;
  for (const fileId of [...new Set(input.fileIds)]) {
    try {
      await store.attach({ tenantId: input.tenantId, fileId, record: { type: "estimator.estimate", id: input.estimateId } });
    } catch (error) {
      try {
        if (onError) onError(error, { tenantId: input.tenantId, estimateId: input.estimateId, step: "photo-attach" });
        else console.error("[@adminigloo/estimator] a photo couldn't be put on its estimate", { estimateId: input.estimateId }, error);
      } catch {
        /* a broken reporter must not undo a saved estimate */
      }
    }
  }
}

/** Who a refused photo is answered to: the customer on the public form, or staff in the editor. */
type PhotoAudience = "public" | "staff";

/** Staff, when the share kept for estimate photos is full: the photos come off estimates, not the Files screen (review SEC-02). */
export const STAFF_SHARE_FULL_MESSAGE =
  "The room kept for estimate photos is full. Remove photos you don't need from your estimates, then try again.";
/** Staff, when the company's storage is full. */
export const STAFF_ROOM_FULL_MESSAGE =
  "There's no room left for photos. The owner can free some up on the Files screen, or remove photos from estimates, then try again.";

/**
 * A file store's refusal, as the estimator's own sentence (Tenancy 2b-1,
 * review G6), or null for anything else.
 *
 * CHECKED STRUCTURALLY: `name === "StorageError"` and its `code`, never
 * `instanceof`, so the estimator never imports @adminigloo/storage (2a D4).
 * The public `photo` route then answers 4xx (never 500), a photo reading
 * keeps going without the copy, and the lead still goes in without it.
 *
 *   storage_full (the company's room, or the share customers' photos may use)
 *                          → photo_limit
 *   file_type, file_too_big → photo_invalid, the existing sentence
 *   storage_off            → photos_disabled
 *
 * CONTRACT: 10.5 names PHOTO_CAP_MESSAGE for `storage_full`. That is the
 * customer's sentence ("send your estimate without more"); staff adding a
 * photo in the editor read their own, under the same code, and it names a
 * place that CAN make room (review SEC-02):
 *
 *   - the share kept for estimate photos is full (`share: true`, only when
 *     staff photos still go to the customers' store, a host without
 *     `staffPhotoStore`): the Files screen can't remove these photos, so
 *     staff are told to remove photos from their estimates;
 *   - the company itself is full: the owner can free room on the Files
 *     screen (other files can go there), or photos can come off estimates.
 */
export function photoStoreRefusal(error: unknown, audience: PhotoAudience): EstimatorInputError | null {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "StorageError") return null;
  switch ((error as { code?: unknown }).code) {
    case "storage_full":
      if (audience === "public") return new EstimatorInputError("photo_limit", PHOTO_CAP_MESSAGE);
      return new EstimatorInputError("photo_limit", (error as { share?: unknown }).share === true ? STAFF_SHARE_FULL_MESSAGE : STAFF_ROOM_FULL_MESSAGE);
    case "file_type":
      return new EstimatorInputError("photo_invalid", photoRefusalMessage("unsupported_type"));
    case "file_too_big":
      return new EstimatorInputError("photo_invalid", photoRefusalMessage("too_large"));
    case "storage_off":
      return new EstimatorInputError(
        "photos_disabled",
        audience === "public" ? "This estimator doesn't take photos." : "Photos can't be kept: no file storage is connected.",
      );
    default:
      return null;
  }
}

/** A customer may attach this many photos to a lead; staff this many to an estimate. */
export const PUBLIC_PHOTO_LIMIT = 3;
export const STAFF_PHOTO_LIMIT = 12;

const EXTENSIONS: Record<PhotoMediaTypeName, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Decode and check one uploaded photo (image.ts), or refuse `photo_invalid`
 * with the plain sentence the widget shows. Nothing is stored or read before
 * this passes.
 */
export function decodePhoto(
  imageBase64: unknown,
  mediaType: unknown,
): { bytes: Uint8Array; mediaType: PhotoMediaTypeName; width: number; height: number } {
  const bytes = decodeBase64Strict(imageBase64);
  if (!bytes) throw new EstimatorInputError("photo_invalid", photoRefusalMessage("bad_base64"));
  const inspected = inspectImage(bytes, typeof mediaType === "string" ? mediaType : "");
  if (!inspected.ok) throw new EstimatorInputError("photo_invalid", photoRefusalMessage(inspected.reason));
  return { bytes, mediaType: inspected.mediaType, width: inspected.width, height: inspected.height };
}

/**
 * Keep a photo: the bytes in the store FIRST, then the row. If the row can't
 * be written, the bytes are deleted again (storage's rule: no file the
 * database doesn't know about), and the insert's error is thrown.
 */
export async function storePhoto(
  db: EstimatorDb,
  store: EstimatorPhotoStore,
  input: {
    tenantId: string;
    bytes: Uint8Array;
    mediaType: PhotoMediaTypeName;
    width: number;
    height: number;
    sha256: string;
    source: "public" | "staff";
    estimateId?: string | null;
    now?: Date;
    /** Who left it (public photos), for the per-visitor cap. */
    requesterHash?: string | null;
  },
): Promise<PhotoRow> {
  const now = input.now ?? new Date();
  // A NAME A PERSON READS on the Files screen (review BO-12), never a hash:
  // "estimate-photo-b058938721a7.jpg" was an id on a screen. Next to it the
  // screen says which estimate and customer it is on. Not unique: a store
  // keeps the bytes under its own key (storage's are random).
  const filename = `${input.source === "staff" ? "Estimate photo" : "Customer photo"}.${EXTENSIONS[input.mediaType]}`;
  let stored: { fileId: string; url: string };
  try {
    stored = await store.put({ tenantId: input.tenantId, bytes: input.bytes, contentType: input.mediaType, filename });
  } catch (error) {
    // THE ONE PLACE that calls `store.put`: a file store's refusal (full,
    // wrong type, too big, switched off) becomes the estimator's own
    // sentence here, for every caller (review G6). Anything else is thrown
    // as it was.
    throw photoStoreRefusal(error, input.source) ?? error;
  }
  try {
    const [row] = (await db
      .insert(estimatorPhotos)
      .values({
        tenantId: input.tenantId,
        estimateId: input.estimateId ?? null,
        fileId: stored.fileId,
        url: stored.url,
        contentType: input.mediaType,
        sizeBytes: input.bytes.length,
        width: input.width,
        height: input.height,
        sha256: input.sha256,
        source: input.source,
        requesterHash: input.requesterHash ?? null,
        createdAt: now,
        linkedAt: input.estimateId ? now : null,
      })
      .returning()) as PhotoRow[];
    return row as PhotoRow;
  } catch (error) {
    try {
      await store.delete({ tenantId: input.tenantId, fileId: stored.fileId });
    } catch {
      /* the insert's error is the one to report */
    }
    throw error;
  }
}

/** A photo this tenant already kept from the same bytes in the last 24 h and nobody has submitted yet — reused, not stored twice. */
export async function findReusablePhoto(db: EstimatorDb, tenantId: string, sha256: string, now: Date): Promise<PhotoRow | null> {
  const [row] = (await db
    .select()
    .from(estimatorPhotos)
    .where(
      and(
        eq(estimatorPhotos.tenantId, tenantId),
        eq(estimatorPhotos.sha256, sha256),
        isNull(estimatorPhotos.estimateId),
        gt(estimatorPhotos.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      ),
    )
    .limit(1)) as PhotoRow[];
  return row ?? null;
}

/**
 * How many photos visitors may leave in the business's storage in any 24
 * hours, sent with a lead or not: per visitor (by `requesterKey`, an IP by
 * default) and for the whole business.
 */
export interface PublicPhotoLimits {
  /** Default 12: four estimates' worth for one visitor. */
  perRequesterDaily?: number;
  /** Default 500. */
  perTenantDaily?: number;
}

export const DEFAULT_PUBLIC_PHOTO_LIMITS: Readonly<Required<PublicPhotoLimits>> = Object.freeze({
  perRequesterDaily: 12,
  perTenantDaily: 500,
});

export const PHOTO_CAP_MESSAGE =
  "You've added as many photos as we can take today. Send your estimate without more, and the business can ask for them.";

/**
 * Keep a customer's photo for their lead (the public `photo` route, and step 5
 * of a reading): reuse the tenant's unlinked copy of the same bytes from the
 * last 24 h, else store it — unless the visitor (or the business) is over the
 * cap of customers' photos kept in the last 24 hours (`photo_limit`).
 *
 * WHY A CAP (review ADV-5). The route took any photo from anyone, and the
 * daily clean-up deletes only what nobody sent: one address could fill the
 * business's storage with several hundred megabytes a day (changing a byte
 * defeats the duplicate check), and when storage was full real customers'
 * photos failed. Counted in the database, so it holds across serverless
 * instances. A visitor with no address (`requesterKey` null: no proxy headers)
 * shares ONE bucket with every other such visitor.
 *
 * SENT OR NOT (Tenancy 2b-1 review SEC-02). The cap once counted only the
 * photos nobody had sent, so a junk lead with three photos emptied the
 * count, and photos on a lead are never purged: a few addresses could fill
 * the share kept for customers' photos for good in hours. Every customer
 * photo kept in the last 24 hours counts now, on a lead or not.
 */
export async function keepPublicPhoto(
  db: EstimatorDb,
  store: EstimatorPhotoStore,
  tenantId: string,
  photo: { bytes: Uint8Array; mediaType: PhotoMediaTypeName; width: number; height: number; sha256?: string },
  now: Date,
  options: { requesterHash?: string | null; limits?: PublicPhotoLimits } = {},
): Promise<PhotoRow> {
  const sha256 = photo.sha256 ?? (await sha256Hex(photo.bytes));
  const existing = await findReusablePhoto(db, tenantId, sha256, now);
  if (existing) return existing;
  const limits = { ...DEFAULT_PUBLIC_PHOTO_LIMITS, ...(options.limits ?? {}) };
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Every customer photo of the last 24 h, on a lead or not (review SEC-02).
  const recent = and(eq(estimatorPhotos.tenantId, tenantId), eq(estimatorPhotos.source, "public"), gt(estimatorPhotos.createdAt, since));
  const [byTenant] = (await db.select({ n: count() }).from(estimatorPhotos).where(recent)) as Array<{ n: number | string }>;
  if (Number(byTenant?.n ?? 0) >= limits.perTenantDaily) throw new EstimatorInputError("photo_limit", PHOTO_CAP_MESSAGE);
  const requesterHash = options.requesterHash ?? null;
  if (requesterHash) {
    const [byRequester] = (await db
      .select({ n: count() })
      .from(estimatorPhotos)
      .where(and(recent, eq(estimatorPhotos.requesterHash, requesterHash)))) as Array<{ n: number | string }>;
    if (Number(byRequester?.n ?? 0) >= limits.perRequesterDaily) throw new EstimatorInputError("photo_limit", PHOTO_CAP_MESSAGE);
  }
  return storePhoto(db, store, { tenantId, ...photo, sha256, source: "public", now, requesterHash });
}

/**
 * Staff add a photo to an estimate (any status): checked like a customer's,
 * at most 12 per estimate (`photo_limit`). Null when the estimate isn't this
 * tenant's.
 *
 * Tenancy 2b-1: once the row is written, the store is told which estimate
 * the photo is on (`attach`, review BO-13); a refusal there is reported
 * (`onError`, step "photo-attach") and the photo stays added.
 */
export async function attachStaffPhoto(
  db: EstimatorDb,
  store: EstimatorPhotoStore,
  tenantId: string,
  estimateId: string,
  input: { imageBase64: string; mediaType: string },
  options: { now?: Date; onError?: PhotoStepReporter } = {},
): Promise<PhotoRow | null> {
  const photo = decodePhoto(input.imageBase64, input.mediaType);
  const [estimate] = (await db
    .select({ id: estimatorEstimates.id })
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.id, estimateId), eq(estimatorEstimates.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  if (!estimate) return null;
  const [counted] = (await db
    .select({ n: count() })
    .from(estimatorPhotos)
    .where(and(eq(estimatorPhotos.tenantId, tenantId), eq(estimatorPhotos.estimateId, estimateId)))) as Array<{ n: number | string }>;
  if (Number(counted?.n ?? 0) >= STAFF_PHOTO_LIMIT) {
    throw new EstimatorInputError("photo_limit", `An estimate can have up to ${STAFF_PHOTO_LIMIT} photos. Remove one first.`);
  }
  const row = await storePhoto(db, store, {
    tenantId,
    bytes: photo.bytes,
    mediaType: photo.mediaType,
    width: photo.width,
    height: photo.height,
    sha256: await sha256Hex(photo.bytes),
    source: "staff",
    estimateId,
    now: options.now ?? new Date(),
  });
  await attachPhotosToEstimate(store, { tenantId, estimateId, fileIds: [row.fileId] }, options.onError);
  return row;
}

/**
 * Remove a photo from an estimate: the row first, then the bytes (a store that
 * fails leaves a file nobody points at, which costs pennies; the other order
 * would leave a row pointing at nothing). False when it isn't this tenant's
 * estimate's photo. A staff photo is removed through `staffStore` when one is
 * given (review SEC-02), a customer's through `store`.
 */
export async function removeEstimatePhoto(
  db: EstimatorDb,
  store: EstimatorPhotoStore | null | undefined,
  tenantId: string,
  estimateId: string,
  photoId: string,
  staffStore?: EstimatorPhotoStore | null,
): Promise<boolean> {
  const [row] = (await db
    .delete(estimatorPhotos)
    .where(and(eq(estimatorPhotos.id, photoId), eq(estimatorPhotos.tenantId, tenantId), eq(estimatorPhotos.estimateId, estimateId)))
    .returning({ fileId: estimatorPhotos.fileId, source: estimatorPhotos.source })) as Array<{ fileId: string; source: string }>;
  if (!row) return false;
  const holder = storeFor(row.source, store, staffStore);
  if (holder) {
    try {
      await holder.delete({ tenantId, fileId: row.fileId });
    } catch {
      /* the row is gone; an orphaned file is harmless */
    }
  }
  return true;
}

/**
 * The store that holds a photo of this source: staff's own (`staffStore`,
 * review SEC-02) when given, else the one store. A staff photo added before
 * a host passed `staffStore` is in `store`: @adminigloo/storage's purpose
 * stores open and remove any of the company's files by id, so it still opens
 * and goes; a host with stores of its own keeps them able to do the same.
 */
function storeFor(
  source: string,
  store: EstimatorPhotoStore | null | undefined,
  staffStore: EstimatorPhotoStore | null | undefined,
): EstimatorPhotoStore | null | undefined {
  return source === "staff" && staffStore ? staffStore : store;
}

/** An estimate's photos, oldest first, with a URL staff can open now (from the store that holds each) and the reading made from each. */
export async function listEstimatePhotos(
  db: EstimatorDb,
  tenantId: string,
  estimateId: string,
  store?: EstimatorPhotoStore,
  staffStore?: EstimatorPhotoStore,
): Promise<EstimatePhoto[]> {
  const rows = (await db
    .select()
    .from(estimatorPhotos)
    .where(and(eq(estimatorPhotos.tenantId, tenantId), eq(estimatorPhotos.estimateId, estimateId)))
    .orderBy(asc(estimatorPhotos.createdAt), asc(estimatorPhotos.id))) as PhotoRow[];
  if (rows.length === 0) return [];
  const readings = (await db
    .select({ id: estimatorTakeoffs.id, photoId: estimatorTakeoffs.photoId })
    .from(estimatorTakeoffs)
    .where(
      and(
        eq(estimatorTakeoffs.tenantId, tenantId),
        inArray(
          estimatorTakeoffs.photoId,
          rows.map((r) => r.id),
        ),
      ),
    )) as Array<{ id: string; photoId: string | null }>;
  const out: EstimatePhoto[] = [];
  for (const row of rows) {
    let url = row.url;
    const holder = storeFor(row.source, store, staffStore);
    if (holder?.urlFor) {
      try {
        url = await holder.urlFor({ tenantId, fileId: row.fileId, url: row.url });
      } catch {
        /* the stored url is still a url */
      }
    }
    out.push({
      id: row.id,
      url,
      width: row.width,
      height: row.height,
      source: row.source === "staff" ? "staff" : "public",
      takeoffId: readings.find((r) => r.photoId === row.id)?.id ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * Delete the photos nobody submitted: unlinked and older than
 * `olderThanHours` (48), every tenant, in batches of `limit` (100). The row
 * first, then the bytes; a store failure is counted, never thrown, so the
 * cron that calls it always finishes.
 *
 * With `timeBudgetMs`, batches run until the orphans are gone or the time is
 * spent (review ADV-5: one batch of 100 a day fell behind a single busy
 * visitor, and storage kept growing). Without it, one batch — 0.3.0's
 * behaviour for a caller that times itself.
 */
export async function purgeOrphanPhotos(
  db: EstimatorDb,
  store: EstimatorPhotoStore | null | undefined,
  options: { now?: Date; olderThanHours?: number; limit?: number; timeBudgetMs?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanHours ?? 48) * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
  const started = Date.now();
  const budget = typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0 ? options.timeBudgetMs : 0;
  let deleted = 0;
  let failed = 0;
  for (;;) {
    const stale = (await db
      .select({ id: estimatorPhotos.id, tenantId: estimatorPhotos.tenantId, fileId: estimatorPhotos.fileId })
      .from(estimatorPhotos)
      .where(and(isNull(estimatorPhotos.estimateId), lt(estimatorPhotos.createdAt, cutoff)))
      .orderBy(asc(estimatorPhotos.createdAt))
      .limit(limit)) as Array<{ id: string; tenantId: string; fileId: string }>;
    let removed = 0;
    for (const photo of stale) {
      const [row] = (await db
        .delete(estimatorPhotos)
        .where(and(eq(estimatorPhotos.id, photo.id), isNull(estimatorPhotos.estimateId)))
        .returning({ id: estimatorPhotos.id })) as Array<{ id: string }>;
      if (!row) continue; // linked by a submit in the meantime
      deleted += 1;
      removed += 1;
      if (!store) continue;
      try {
        await store.delete({ tenantId: photo.tenantId, fileId: photo.fileId });
      } catch {
        failed += 1;
      }
    }
    // Another batch only when this one was full, made progress, and there is time.
    if (budget === 0 || stale.length < limit || removed === 0 || Date.now() - started >= budget) break;
  }
  return { deleted, failed };
}
