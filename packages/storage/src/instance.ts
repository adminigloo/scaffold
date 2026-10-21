import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { cleanFilename, withTypeExtension } from "./filenames.js";
import { grantFor, readerFor } from "./grant.js";
import { FILE_TYPES, formatBytes, imageSize, sniffFileType, typesInWords } from "./file-types.js";
import { isLegacyKey, newPrivateKey, newPublicKey, PUBLIC_SEGMENT_PATTERN, sha256Hex, base64url, fromBase64url } from "./keys.js";
import { runMoveToPrivate } from "./move.js";
import type { StoredObjectRef } from "./forget.js";
import { purposeMap, STORAGE_BUILT_IN_PURPOSES, type StoragePurpose } from "./purposes.js";
import { recordMap, type StorageRecordType } from "./records.js";
import type { StorageTables, StoredFilesTable } from "./schema.js";
import { createLinkSigner, LINK_MAX_TTL_SECONDS, LINK_MIN_TTL_SECONDS, type LinkSigner } from "./signing.js";
import {
  InvalidStoreError,
  StorageConfigError,
  StorageError,
  type BlobObject,
  type BlobStore,
  type StorageUsage,
  type StorageUsageEvent,
  type StoredFile,
  type StoreInput,
} from "./types.js";

/**
 * `createStorage` (section 6.6): a company's files, private by default.
 *
 * Three rules from 0.1 carry over, each the residue of a bug somebody else
 * ships:
 *
 * BYTES FIRST, RECEIPT SECOND, BYTES TAKEN BACK ON A FAILED RECEIPT. A blob
 * with a row is a file; a blob without one is a leak nobody can see, and a
 * row without bytes is a "file" that serves nothing. The one failure left (a
 * crash between the two writes) leaves an orphan blob, which is invisible to
 * the product and strictly better than the inverse.
 *
 * THE COMPANY IS IN THE WHERE OF EVERY READ, MARK AND DELETE. Every lookup is
 * by (tenant_id, id): a guessed id from another company finds no row, so it
 * reads nothing and deletes nothing. The key in the store never decides.
 *
 * THE STORE IS AN INTERFACE. The package imports no vendor SDK; the host
 * hands it `BlobStore`s (./vercel-blob, ./s3, ./local, ./testing).
 *
 * And 0.2's own:
 *
 * PRIVATE BY DEFAULT, TWO STORES (D10). A purpose says private or public;
 * private bytes go to a store that never hands out a URL, and are served only
 * through the company's signed-in route or a short-lived signed link.
 *
 * THE OBJECT IS DELETED FROM THE STORE IT IS IN (D13, review G11). `open`,
 * `remove` and the purge use `stores[row.access]`, never the purpose's
 * current store: 0.1's files and 2a's estimator photos are PUBLIC rows, and
 * choosing by purpose would delete nothing from the private store and leave
 * the bytes public forever.
 *
 * THE ALLOWANCE IS CHECKED UNDER A LOCK (D11). Before the bytes are stored,
 * and again inside a transaction whose first statement is
 * `pg_advisory_xact_lock(hashtext('storage-usage:' || tenant_id))`, so two
 * uploads can't both take the last of the room; the loser's bytes are deleted.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StorageDb = PgDatabase<any, any, any>; // 0.1's name

/** What `signing.stillValid` is asked with, on every open of a link. */
export interface StorageLinkCheck {
  readonly tenantId: string;
  /** The person who made the link. */
  readonly userId: string;
  readonly issuedAt: Date;
  /** The file the link opens (review SEC-03): its id, its purpose and the record it is on. */
  readonly file: { readonly id: string; readonly purpose: string; readonly record: { readonly type: string; readonly id: string } | null };
  /**
   * Runs the file's own rule (D12: `files.manage`, the record's manage, view
   * or assigned permission and the assignment, the purpose's view list) again
   * for the MAKER, with `holds` answering whether they hold a permission in
   * this company NOW (review SEC-03). true: they may still open it. So a maker
   * demoted to crew, or a crew member taken off the visit, stops opening the
   * file through the link they copied too, not only through the screens.
   */
  readonly mayView: (holds: (permission: string) => boolean | Promise<boolean>) => Promise<boolean>;
}

export interface StorageSigningOptions {
  /** At least 32 characters. */
  readonly secret: string;
  /** Default 3600; 60–3600 ("short-lived", review G2). */
  readonly ttlSeconds?: number;
  /**
   * Asked on every open, after the MAC and expiry checks, with the company,
   * the person who made the link, when, and the file (review SEC-03). false
   * (or a throw, reported) answers the same 404 as a bad link. create-app:
   * the company is active, the person is still an active member, AND
   * `mayView` with their permissions now says they may still open the file.
   */
  readonly stillValid: (input: StorageLinkCheck) => Promise<boolean>;
}

export interface CreateStorageOptions {
  readonly db: StorageDb;
  /** REQUIRED (D14, review G1): `storageTables` for the 0.1 name, or `defineStorageTables({ prefix, schema })`. */
  readonly tables: StorageTables;
  /** D10. A missing store switches that access off with a sentence. A store whose `access` doesn't match its slot throws InvalidStoreError here. */
  readonly stores: { readonly private?: BlobStore; readonly public?: BlobStore };
  /** Default STORAGE_BUILT_IN_PURPOSES. A duplicate key throws. */
  readonly purposes?: readonly StoragePurpose[];
  readonly records?: readonly StorageRecordType[];
  /** D11. null = no allowance. Default: no allowance. The billing chunk passes the plan's here. */
  readonly allowanceBytes?: (tenantId: string) => number | null | Promise<number | null>;
  /** Signed links (D10). Absent: none are minted. */
  readonly signing?: StorageSigningOptions;
  /**
   * Told after every `store` (`stored`), every refusal for the company's
   * allowance (`refused`) and every refusal for a purpose's share
   * (`share_full`, review SEC-02: the company itself isn't full, but its
   * customers' photos are being turned away), awaited and contained (a throw
   * is reported, never fails the upload). The host turns it into the "Files"
   * alerts with `storageUsageAlert` (6.15).
   */
  readonly onUsage?: (event: StorageUsageEvent) => void | Promise<void>;
  readonly urls: {
    /** The signed-in content route of a file, e.g. (t, id) => `/api/app/${t}/files/v1/admin/files/${id}/content`. */
    readonly content: (tenantId: string, fileId: string) => string;
    /** Where the public handler (6.8) is mounted, absolute: "https://app.example.com/api/files". */
    readonly publicBase: string;
  };
  /** Default 4 MiB (D11). */
  readonly maxUploadBytes?: number;
  readonly now?: () => Date;
  /** Told about every step that failed. Default console.error. */
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly step: string }) => void;
}

/** Structurally tenancy 0.6's LogoStore (8.3). */
export interface StorageLogoStore {
  /** `pathname` is ignored: storage picks an unguessable key (D10). `tenantId` is required. */
  put(input: { readonly pathname: string; readonly bytes: Uint8Array; readonly contentType: string; readonly tenantId?: string }): Promise<{
    readonly url: string;
    readonly key: string;
  }>;
  /**
   * `key` is the file's id, or (review G11) a 2a logo's blob pathname, which
   * starts with exactly `tenancy/logos/{context.tenantId}/`: that object is
   * deleted from the PUBLIC store (it has no row). Any other key that isn't a
   * file id of this company: reported, nothing deleted. Without `context`,
   * nothing can be scoped: reported, nothing deleted.
   */
  delete(key: string, context?: { readonly tenantId: string }): Promise<void>;
}

/** Structurally the estimator's EstimatorPhotoStore (10.5). */
export interface StoragePurposeStore {
  /**
   * `addedBy` (review SEC-02): the signed-in person adding it (staff adding a
   * photo to an estimate), or absent/null for a customer's. A person's upload
   * of a purpose with a share is an ordinary file: never refused by the
   * share, not counted in it, and refused like any file when the company is
   * full. Shown as "Added by".
   */
  put(input: {
    readonly tenantId: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly filename: string;
    readonly addedBy?: string | null;
  }): Promise<{
    readonly fileId: string;
    readonly url: string;
  }>;
  /** `storage.remove`: deletes from the store the file is IN (D13, review G11), so a 2a photo still in the public store is deleted there. */
  delete(input: { readonly tenantId: string; readonly fileId: string }): Promise<void>;
  /** The signed-in content route (private) or the public address. */
  urlFor(input: { readonly tenantId: string; readonly fileId: string; readonly url: string }): string;
  /** Review BO-13: puts the file on its record (`storage.attach`), so the Files screen says "Estimate 1042 · Pat Rivera" and the record's permissions decide. */
  attach(input: { readonly tenantId: string; readonly fileId: string; readonly record: { readonly type: string; readonly id: string } }): Promise<void>;
}

export interface StorageListInput {
  readonly tenantId: string;
  readonly purpose?: string;
  /** One record's files; or every file on any record of `recordType`; or `recordType: null` for files on no record. */
  readonly record?: { readonly type: string; readonly id: string };
  readonly recordType?: string | null;
  /** Newest first (default) or largest first (review BO-22). */
  readonly sort?: "newest" | "largest";
  /** Default false: purposes with `hiddenUntilAttached` are left out while on no record (review BO-13). */
  readonly includeHidden?: boolean;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface Storage {
  readonly tables: StorageTables;
  readonly purposes: ReadonlyMap<string, StoragePurpose>;
  readonly records: ReadonlyMap<string, StorageRecordType>;
  readonly maxUploadBytes: number;
  /** Signed links are on (a secret was given). */
  readonly linksEnabled: boolean;
  /** The signed-in content route of a file (`urls.content`): where a private file opens. */
  contentUrl(tenantId: string, fileId: string): string;
  /** The purposes this company has live files of, for the Files screen's filter. */
  purposesPresent(tenantId: string): Promise<readonly string[]>;
  /** Can files of this purpose be kept right now? */
  available(purpose: string): { readonly available: true } | { readonly available: false; readonly reason: string };
  /** The upload pipeline (6.6). Throws StorageError. */
  store(input: StoreInput): Promise<StoredFile>;
  get(input: { readonly tenantId: string; readonly fileId: string }): Promise<StoredFile | null>;
  list(input: StorageListInput): Promise<{ readonly files: readonly StoredFile[]; readonly nextCursor: string | null }>;
  /** The bytes, from `stores[row.access]` (D13, review G11); null when the row or the object is gone (a missing object is reported). */
  open(input: { readonly tenantId: string; readonly fileId: string }): Promise<{ readonly file: StoredFile; readonly object: BlobObject } | null>;
  /** D13: the object is deleted from `stores[row.access]`. */
  remove(input: { readonly tenantId: string; readonly fileId: string }): Promise<{ readonly removed: boolean; readonly objectRemoved: boolean }>;
  /** Sets (or moves) a file's record (review BO-13). An unknown record type is `unknown_record`; a file that isn't this company's: nothing, false. */
  attach(input: { readonly tenantId: string; readonly fileId: string; readonly record: { readonly type: string; readonly id: string } }): Promise<boolean>;
  usage(tenantId: string): Promise<StorageUsage>;
  /** null without `signing`, or for a file that isn't this company's. `userId` is the person making it (review G2): the link stops working when they leave. */
  signedLink(input: { readonly tenantId: string; readonly fileId: string; readonly userId: string; readonly ttlSeconds?: number }): Promise<{
    readonly url: string;
    readonly expiresAt: Date;
  } | null>;
  /** The public handler's two lookups (6.8). */
  resolveLink(token: string): Promise<StoredFile | null>;
  publicFile(randomPart: string): Promise<StoredFile | null>;
  /**
   * A forgotten company's bytes (create-app's "delete a company"): deletes
   * each object from the store it is in, once the deletion's transaction has
   * committed and no row points at them (`listTenantObjects` read them on
   * that transaction). Never throws: a delete that fails is reported (step
   * "forget-object") and counted, and the object stays in a store nothing
   * reads (its key is unguessable and no row names it).
   */
  deleteObjects(objects: readonly StoredObjectRef[]): Promise<{ readonly deleted: number; readonly failed: number }>;
  /** The files cron (D13). */
  purgeDeleted(options?: { readonly limit?: number; readonly timeBudgetMs?: number }): Promise<{ readonly purged: number; readonly failed: number; readonly gaveUp: number }>;
  /**
   * Review G11: copies each live `access = 'public'` file of `purpose` into the
   * private store under a new private key, rewrites its row (`pathname`,
   * `access: 'private'`, `url: null`; the id, and so every link to it,
   * unchanged) and deletes the public object. A copy that fails leaves the
   * row as it was. Oldest first, within the budget. Without a private store:
   * nothing moves.
   */
  moveToPrivate(options: {
    readonly purpose: string;
    readonly tenantIds?: readonly string[];
    readonly limit?: number;
    readonly timeBudgetMs?: number;
  }): Promise<{ readonly moved: number; readonly failed: number; readonly stoppedEarly: boolean }>;
  /**
   * Review G9: the private store's `checkPrivate`, or ok when it has none;
   * `{ ok: false, reason: "File storage isn't switched on yet." }` without a
   * private store. `note` (reviews FH-8, SEC-05): ok, but with something the
   * check couldn't see, in plain words, for /setup to show (an R2 bucket's
   * r2.dev address).
   */
  checkPrivateStore(): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly note?: string }>;
  /** Tenancy's LogoStore, structurally (6.9). undefined without a public store. */
  logoStore(): StorageLogoStore | undefined;
  /** A store for one purpose, in the estimator's EstimatorPhotoStore shape (6.9). undefined without its store. */
  purposeStore(purpose: string): StoragePurposeStore | undefined;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** D13: after this many failed deletes the files cron stops and reports the key for a person to look at. */
export const MAX_PURGE_ATTEMPTS = 10;
const LIST_DEFAULT = 30;
const LIST_MAX = 100;

export const STORAGE_OFF_SENTENCE = "File storage isn't switched on yet, so files can't be kept.";

type Row = StoredFilesTable["$inferSelect"];

/** A refusal found while checking the room (6.6 steps 5 and 8). Thrown inside the transaction to roll it back. */
class RoomRefusal extends Error {
  readonly name = "RoomRefusal";
  constructor(
    readonly share: boolean,
    readonly usage: StorageUsage,
    /** The share's own numbers, for a share refusal. */
    readonly shareUsage: { readonly usedBytes: number; readonly limitBytes: number } | null = null,
  ) {
    super(share ? "share" : "full");
  }
}

const storeSchema = z.object({
  tenantId: z.string().min(1).max(200),
  purpose: z.string().min(1).max(64),
  bytes: z.instanceof(Uint8Array).refine((b) => b.length > 0, "That file is empty."),
  declaredType: z.string().max(200).nullable().optional(),
  filename: z.string().max(200, "Give the file a shorter name (200 characters at most).").nullable().optional(),
  addedBy: z.string().min(1).max(200).nullable().optional(),
  record: z.object({ type: z.string().min(1).max(64), id: z.string().min(1).max(200) }).nullable().optional(),
});

const idSchema = z.string().min(1).max(200);

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The sentence for a full company, worded for someone who can make room (the handlers re-word it for anyone else, 6.7). */
export function storageFullSentence(usage: StorageUsage, locale?: string): string {
  const allowance = usage.allowanceBytes ?? usage.usedBytes;
  return `Your storage is full: ${formatBytes(usage.usedBytes, locale)} of ${formatBytes(allowance, locale)} used. Delete files you no longer need to make room.`;
}

export const SHARE_FULL_SENTENCE = "There's no more room for these right now.";

export function createStorage(options: CreateStorageOptions): Storage {
  if (!options || typeof options !== "object") throw new StorageConfigError("createStorage: pass the options.");
  if (!options.tables || !options.tables.files) {
    // D14, review G1: the type requires it; this is for a JavaScript host.
    throw new StorageConfigError("createStorage: pass `tables` (storageTables for the 0.1 name, or defineStorageTables({ prefix, schema })).");
  }
  if (!options.urls || typeof options.urls.content !== "function" || !options.urls.publicBase) {
    throw new StorageConfigError("createStorage: pass `urls` ({ content(tenantId, fileId), publicBase }).");
  }
  const stores = options.stores ?? {};
  // D10: a private file is NEVER stored publicly instead. A public store in
  // the private slot is a configuration mistake that would publish every
  // photo; refused here, once, loudly.
  if (stores.private && stores.private.access !== "private") {
    throw new InvalidStoreError("stores.private must be a private store (its `access` is \"public\"). Private photos and files would be readable by anyone.");
  }
  if (stores.public && stores.public.access !== "public") {
    throw new InvalidStoreError("stores.public must be a public store (its `access` is \"private\").");
  }
  const purposes = purposeMap(options.purposes ?? STORAGE_BUILT_IN_PURPOSES);
  const records = recordMap(options.records ?? []);
  let signer: LinkSigner | null = null;
  let linkTtl = LINK_MAX_TTL_SECONDS;
  if (options.signing) {
    const signing = options.signing;
    if (typeof signing.secret !== "string" || signing.secret.length < 32) {
      throw new StorageConfigError("signing.secret must be at least 32 characters.");
    }
    if (typeof signing.stillValid !== "function") {
      throw new StorageConfigError("signing.stillValid is required: every open of a link asks whether its maker and the company still qualify (review G2).");
    }
    linkTtl = signing.ttlSeconds ?? LINK_MAX_TTL_SECONDS;
    if (!Number.isInteger(linkTtl) || linkTtl < LINK_MIN_TTL_SECONDS || linkTtl > LINK_MAX_TTL_SECONDS) {
      throw new StorageConfigError(`signing.ttlSeconds must be a whole number from ${LINK_MIN_TTL_SECONDS} to ${LINK_MAX_TTL_SECONDS} (links are short-lived).`);
    }
    signer = createLinkSigner(signing.secret);
  }
  const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes < 1) throw new StorageConfigError("maxUploadBytes must be a positive whole number.");

  const db = options.db;
  const f = options.tables.files;
  // CONTRACT: typed as a string (6.6); a URL object (13.5 writes
  // `new URL("/api/files", appUrl)`) is taken too, as its href.
  const publicBase = String(options.urls.publicBase).replace(/\/+$/, "");
  const clock = () => options.now?.() ?? new Date();
  const report = (error: unknown, tenantId: string | null, step: string) => {
    try {
      if (options.onError) options.onError(error, { tenantId, step });
      else console.error(`[@adminigloo/storage] ${step}`, error);
    } catch {
      /* a broken reporter must not turn a handled failure into a crash */
    }
  };

  function toFile(row: Row): StoredFile {
    const access = row.access === "private" ? "private" : "public";
    const publicUrl =
      access === "public" ? (row.url ?? (row.pathname.startsWith("p/") ? `${publicBase}/v1/p/${row.pathname.slice(2)}` : null)) : null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      purpose: row.kind,
      access,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      width: row.width ?? null,
      height: row.height ?? null,
      sha256: row.sha256 ?? "",
      record: row.recordType && row.recordId ? { type: row.recordType, id: row.recordId } : null,
      addedBy: row.ownerId ?? null,
      publicUrl,
      createdAt: row.createdAt,
      key: row.pathname,
    };
  }

  async function allowanceFor(tenantId: string): Promise<number | null> {
    if (!options.allowanceBytes) return null;
    const value = await options.allowanceBytes(tenantId);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }

  // The live rows of one company: what the usage and every list count.
  const live = (tenantId: string) => and(eq(f.tenantId, tenantId), isNull(f.deletedAt));

  async function usageWith(executor: StorageDb, tenantId: string, allowance: number | null): Promise<StorageUsage> {
    const [row] = (await executor
      .select({ used: sql<string>`coalesce(sum(${f.sizeBytes}), 0)::text`, count: sql<string>`count(*)::text` })
      .from(f)
      .where(live(tenantId))) as { used: string; count: string }[];
    return { usedBytes: Number(row?.used ?? 0), fileCount: Number(row?.count ?? 0), allowanceBytes: allowance };
  }

  /** The live bytes of `purpose` in this company that no person added (`owner_id` null): what its share holds (review SEC-02). */
  async function shareUsedWith(executor: StorageDb, tenantId: string, purpose: string): Promise<number> {
    const [row] = (await executor
      .select({ used: sql<string>`coalesce(sum(${f.sizeBytes}), 0)::text` })
      .from(f)
      .where(and(live(tenantId), eq(f.kind, purpose), isNull(f.ownerId)))) as { used: string }[];
    return Number(row?.used ?? 0);
  }

  /**
   * 6.6 steps 5 and 8: is there room for `size` more bytes of `purpose`? A
   * RoomRefusal, or null.
   *
   * WHO A SHARE IS FOR (review SEC-02). A purpose's share exists so strangers
   * can't fill the room (the estimator's customers' photos stop at a fifth),
   * and its exemption so a stranger's lead is never turned away. Both hold
   * for uploads by NO signed-in person (`addedBy` null). An upload a person
   * makes of such a purpose (staff adding a photo to their estimate) is an
   * ordinary file: refused when the company is full, never by the share, and
   * not counted in it, so customers filling their share can't stop the crew.
   * A purpose with no share keeps its exemption for everyone (the logo: a
   * full company's owner can still fix it).
   */
  async function roomRefusal(
    executor: StorageDb,
    tenantId: string,
    purpose: StoragePurpose,
    size: number,
    allowance: number,
    byPerson: boolean,
  ): Promise<RoomRefusal | null> {
    const shared = purpose.maxShareOfAllowance !== undefined;
    const ordinary = shared && byPerson;
    const usage = await usageWith(executor, tenantId, allowance);
    if ((!purpose.exemptFromAllowance || ordinary) && usage.usedBytes + size > allowance) return new RoomRefusal(false, usage);
    if (shared && !ordinary) {
      const limit = Math.floor((purpose.maxShareOfAllowance as number) * allowance);
      const used = await shareUsedWith(executor, tenantId, purpose.key);
      if (used + size > limit) return new RoomRefusal(true, usage, { usedBytes: used, limitBytes: limit });
    }
    return null;
  }

  /** What onUsage hears for a refusal: "refused" for the company's room, "share_full" for a purpose's share (review SEC-02). */
  function refusalEvent(tenantId: string, purpose: StoragePurpose, refusal: RoomRefusal): StorageUsageEvent {
    if (refusal.share && refusal.shareUsage) {
      return {
        tenantId,
        usage: refusal.usage,
        outcome: "share_full",
        purpose: purpose.key,
        share: { purposeLabel: purpose.label, usedBytes: refusal.shareUsage.usedBytes, limitBytes: refusal.shareUsage.limitBytes },
      };
    }
    return { tenantId, usage: refusal.usage, outcome: "refused", purpose: purpose.key };
  }

  async function tellUsage(event: StorageUsageEvent): Promise<void> {
    if (!options.onUsage) return;
    try {
      await options.onUsage(event);
    } catch (error) {
      report(error, event.tenantId, "on-usage");
    }
  }

  function refusalError(refusal: RoomRefusal): StorageError {
    return refusal.share
      ? new StorageError("storage_full", SHARE_FULL_SENTENCE, { share: true })
      : new StorageError("storage_full", storageFullSentence(refusal.usage));
  }

  function available(purposeKey: string): { readonly available: true } | { readonly available: false; readonly reason: string } {
    const purpose = purposes.get(purposeKey);
    if (!purpose) return { available: false, reason: "Files like this can't be kept here." };
    if (!stores[purpose.access]) return { available: false, reason: STORAGE_OFF_SENTENCE };
    return { available: true };
  }

  async function store(input: StoreInput): Promise<StoredFile> {
    const parsed = storeSchema.safeParse(input);
    if (!parsed.success) {
      throw new StorageError("invalid", parsed.error.issues[0]?.message ?? "Some details need another look.");
    }
    const value = parsed.data;
    const purpose = purposes.get(value.purpose);
    if (!purpose) throw new StorageError("unknown_purpose", `There's no kind of file called ${JSON.stringify(value.purpose)} here.`);
    if (value.record && !records.has(value.record.type)) throw new StorageError("unknown_record", "That isn't here.");
    const target = stores[purpose.access];
    if (!target) throw new StorageError("storage_off", STORAGE_OFF_SENTENCE);
    const bytes = value.bytes;
    if (bytes.length > purpose.maxBytes) {
      throw new StorageError("file_too_big", `That file is too big. Files can be up to ${formatBytes(purpose.maxBytes)}.`);
    }
    const type = sniffFileType(bytes);
    if (!type || !purpose.types.includes(type)) {
      throw new StorageError("file_type", `That kind of file can't be kept here. Use ${typesInWords(purpose.types)}.`);
    }
    const tenantId = value.tenantId;
    const byPerson = typeof value.addedBy === "string" && value.addedBy !== "";

    // Step 5, before any bytes are stored: a full company is told at once,
    // without an upload it would only have to delete again.
    const allowance = await allowanceFor(tenantId);
    if (allowance !== null) {
      const refusal = await roomRefusal(db, tenantId, purpose, bytes.length, allowance, byPerson);
      if (refusal) {
        await tellUsage(refusalEvent(tenantId, purpose, refusal));
        throw refusalError(refusal);
      }
    }

    const now = clock();
    const info = FILE_TYPES[type];
    const key = purpose.access === "private" ? await newPrivateKey(tenantId, info.ext, now) : newPublicKey(info.ext);
    const sha = await sha256Hex(bytes);
    const size = imageSize(bytes, type);
    const filename = withTypeExtension(value.filename ? cleanFilename(value.filename) : cleanFilename(`${purpose.label} ${isoDay(now)}`), type);
    // Step 7: the bytes first.
    const put = await target.put(key, bytes, {
      contentType: info.contentType,
      cacheControl: purpose.access === "private" ? "private, no-store" : "public, max-age=31536000, immutable",
    });

    let row: Row;
    try {
      row = await db.transaction(async (tx) => {
        // Step 8. The lock is the FIRST statement: two uploads of one company
        // queue here, so the second re-checks the room with the first's row in it.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('storage-usage:' || ${tenantId}::text))`);
        if (allowance !== null) {
          const refusal = await roomRefusal(tx as unknown as StorageDb, tenantId, purpose, bytes.length, allowance, byPerson);
          if (refusal) throw refusal;
        }
        const [inserted] = (await tx
          .insert(f)
          .values({
            tenantId,
            ownerId: value.addedBy ?? null,
            kind: purpose.key,
            filename,
            contentType: info.contentType,
            sizeBytes: bytes.length,
            pathname: key,
            url: purpose.access === "public" ? put.url : null,
            access: purpose.access,
            recordType: value.record?.type ?? null,
            recordId: value.record?.id ?? null,
            width: size?.width ?? null,
            height: size?.height ?? null,
            sha256: sha,
            // Millisecond precision, from the instance's clock, so the
            // Files screen's cursor (a JS Date) can name a row exactly.
            createdAt: now,
          })
          .returning()) as Row[];
        if (!inserted) throw new Error("the insert returned no row");
        return inserted;
      });
    } catch (error) {
      // A blob with a row is a file; a blob without one is a leak. Take the
      // bytes back out; the original failure is the one that matters.
      try {
        await target.delete(key);
      } catch (cleanup) {
        report(cleanup, tenantId, "store-cleanup");
      }
      if (error instanceof RoomRefusal) {
        await tellUsage(refusalEvent(tenantId, purpose, error));
        throw refusalError(error);
      }
      throw error;
    }

    const file = toFile(row);
    await tellUsage({ tenantId, usage: await usageWith(db, tenantId, allowance), outcome: "stored", purpose: purpose.key });
    return file;
  }

  async function get(input: { readonly tenantId: string; readonly fileId: string }): Promise<StoredFile | null> {
    if (!idSchema.safeParse(input?.fileId).success || !idSchema.safeParse(input?.tenantId).success) return null;
    const [row] = (await db
      .select()
      .from(f)
      .where(and(eq(f.tenantId, input.tenantId), eq(f.id, input.fileId), isNull(f.deletedAt)))
      .limit(1)) as Row[];
    return row ? toFile(row) : null;
  }

  function encodeCursor(sort: "newest" | "largest", row: Row): string {
    const payload = sort === "largest" ? { k: "s", s: row.sizeBytes, i: row.id } : { k: "n", c: row.createdAt.toISOString(), i: row.id };
    return base64url(new TextEncoder().encode(JSON.stringify(payload)));
  }

  const cursorSchema = z.union([
    z.object({ k: z.literal("n"), c: z.string().datetime(), i: z.string().min(1).max(200) }),
    z.object({ k: z.literal("s"), s: z.number().int().nonnegative(), i: z.string().min(1).max(200) }),
  ]);

  function decodeCursor(cursor: string, sort: "newest" | "largest"): SQL {
    const bad = () => new StorageError("invalid", "That page of files couldn't be found. Start from the first page.");
    const raw = fromBase64url(cursor);
    if (!raw || cursor.length > 600) throw bad();
    let parsed: z.infer<typeof cursorSchema>;
    try {
      const result = cursorSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      if (!result.success) throw bad();
      parsed = result.data;
    } catch {
      throw bad();
    }
    if (sort === "largest") {
      if (parsed.k !== "s") throw bad();
      return sql`(${f.sizeBytes}, ${f.id}) < (${parsed.s}, ${parsed.i})`;
    }
    if (parsed.k !== "n") throw bad();
    return sql`(${f.createdAt}, ${f.id}) < (${parsed.c}::timestamptz, ${parsed.i})`;
  }

  async function list(input: StorageListInput): Promise<{ readonly files: readonly StoredFile[]; readonly nextCursor: string | null }> {
    if (!idSchema.safeParse(input?.tenantId).success) throw new StorageError("invalid", "Some details need another look.");
    const sort = input.sort === "largest" ? "largest" : "newest";
    const limit = Math.min(Math.max(Math.floor(input.limit ?? LIST_DEFAULT), 1), LIST_MAX);
    const where: SQL[] = [live(input.tenantId) as SQL];
    if (input.purpose !== undefined) where.push(eq(f.kind, input.purpose));
    if (input.record) where.push(eq(f.recordType, input.record.type), eq(f.recordId, input.record.id));
    else if (input.recordType === null) where.push(isNull(f.recordType));
    else if (typeof input.recordType === "string") where.push(eq(f.recordType, input.recordType));
    if (!input.includeHidden) {
      const hidden = [...purposes.values()].filter((p) => p.hiddenUntilAttached).map((p) => p.key);
      // Review BO-13: a customer's photo before its lead is sent is counted
      // but not listed; once it is on its estimate it shows like any other.
      if (hidden.length > 0) where.push(sql`not (${inArray(f.kind, hidden)} and ${f.recordType} is null)`);
    }
    if (input.cursor) where.push(decodeCursor(input.cursor, sort));
    const order = sort === "largest" ? [desc(f.sizeBytes), desc(f.id)] : [desc(f.createdAt), desc(f.id)];
    const rows = (await db
      .select()
      .from(f)
      .where(and(...where))
      .orderBy(...order)
      .limit(limit + 1)) as Row[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { files: page.map(toFile), nextCursor: rows.length > limit && last ? encodeCursor(sort, last) : null };
  }

  async function open(input: { readonly tenantId: string; readonly fileId: string }) {
    const file = await get(input);
    if (!file) return null;
    const source = stores[file.access];
    if (!source) {
      report(new Error(`No ${file.access} store is configured, so this file can't be read.`), file.tenantId, "open-no-store");
      return null;
    }
    const object = await source.get(file.key);
    if (!object) {
      report(new Error(`A file's bytes are missing from the ${file.access} store (file ${file.id}).`), file.tenantId, "missing-object");
      return null;
    }
    return { file, object };
  }

  async function addPurgeAttempt(row: { id: string; tenantId: string; pathname: string }): Promise<number> {
    const [updated] = (await db
      .update(f)
      .set({ purgeAttempts: sql`${f.purgeAttempts} + 1` })
      .where(and(eq(f.tenantId, row.tenantId), eq(f.id, row.id), isNotNull(f.deletedAt)))
      .returning({ attempts: f.purgeAttempts })) as { attempts: number }[];
    return updated?.attempts ?? 0;
  }

  async function deleteObjectThenRow(row: { id: string; tenantId: string; pathname: string; access: string }): Promise<boolean> {
    const source = stores[row.access === "private" ? "private" : "public"];
    if (!source) throw new Error(`No ${row.access} store is configured, so the bytes of a removed file can't be deleted.`);
    await source.delete(row.pathname);
    // The row goes only after the bytes have. `deleted_at is not null` in the
    // WHERE (D14, review G1): an instance pointed at a host's own table errors.
    await db.delete(f).where(and(eq(f.tenantId, row.tenantId), eq(f.id, row.id), isNotNull(f.deletedAt)));
    return true;
  }

  async function remove(input: { readonly tenantId: string; readonly fileId: string }) {
    if (!idSchema.safeParse(input?.fileId).success || !idSchema.safeParse(input?.tenantId).success) return { removed: false, objectRemoved: false };
    const [row] = (await db
      .update(f)
      .set({ deletedAt: clock() })
      .where(and(eq(f.tenantId, input.tenantId), eq(f.id, input.fileId), isNull(f.deletedAt)))
      .returning({ id: f.id, tenantId: f.tenantId, pathname: f.pathname, access: f.access })) as {
      id: string;
      tenantId: string;
      pathname: string;
      access: string;
    }[];
    if (!row) return { removed: false, objectRemoved: false };
    try {
      await deleteObjectThenRow(row);
      return { removed: true, objectRemoved: true };
    } catch (error) {
      // "Deleted" means the bytes go (D13): the row stays marked, out of every
      // list and the usage, and the files cron tries again.
      report(error, row.tenantId, "remove-object");
      try {
        await addPurgeAttempt(row);
      } catch (mark) {
        report(mark, row.tenantId, "remove-mark");
      }
      return { removed: true, objectRemoved: false };
    }
  }

  async function attach(input: { readonly tenantId: string; readonly fileId: string; readonly record: { readonly type: string; readonly id: string } }): Promise<boolean> {
    if (!input?.record || !records.has(input.record.type)) throw new StorageError("unknown_record", "That isn't here.");
    if (!idSchema.safeParse(input.record.id).success) throw new StorageError("invalid", "Some details need another look.");
    if (!idSchema.safeParse(input.fileId).success || !idSchema.safeParse(input.tenantId).success) return false;
    const rows = (await db
      .update(f)
      .set({ recordType: input.record.type, recordId: input.record.id })
      .where(and(eq(f.tenantId, input.tenantId), eq(f.id, input.fileId), isNull(f.deletedAt)))
      .returning({ id: f.id })) as { id: string }[];
    return rows.length > 0;
  }

  async function usage(tenantId: string): Promise<StorageUsage> {
    return usageWith(db, tenantId, await allowanceFor(tenantId));
  }

  async function signedLink(input: { readonly tenantId: string; readonly fileId: string; readonly userId: string; readonly ttlSeconds?: number }) {
    if (!signer) return null;
    if (!idSchema.safeParse(input?.userId).success) throw new StorageError("invalid", "A link needs the person making it.");
    const ttl = input.ttlSeconds ?? linkTtl;
    if (!Number.isInteger(ttl) || ttl < LINK_MIN_TTL_SECONDS || ttl > LINK_MAX_TTL_SECONDS) {
      throw new StorageError("invalid", "A link lasts between a minute and an hour.");
    }
    const file = await get(input);
    if (!file) return null;
    const now = clock();
    const token = await signer.sign({ tenantId: file.tenantId, fileId: file.id, userId: input.userId, now, ttlSeconds: ttl });
    return { url: `${publicBase}/v1/f/${token}`, expiresAt: new Date((Math.floor(now.getTime() / 1000) + ttl) * 1000) };
  }

  async function resolveLink(token: string): Promise<StoredFile | null> {
    if (!signer || !options.signing) return null;
    const payload = await signer.verify(token, clock());
    if (!payload) return null;
    // By BOTH the company and the file (review G2, G14): a token correctly
    // signed for {company B, A's file} finds no row.
    const file = await get({ tenantId: payload.tenantId, fileId: payload.fileId });
    if (!file) return null;
    try {
      const ok = await options.signing.stillValid({
        tenantId: payload.tenantId,
        userId: payload.userId,
        issuedAt: payload.issuedAt,
        file: { id: file.id, purpose: file.purpose, record: file.record },
        // D12 again, for the MAKER (review SEC-03): the host answers what they hold now.
        mayView: async (holds) => (await grantFor({ purposes, records, now: clock }, readerFor(payload.userId, holds), file)).view,
      });
      return ok === true ? file : null;
    } catch (error) {
      report(error, payload.tenantId, "link-still-valid");
      return null;
    }
  }

  async function publicFile(randomPart: string): Promise<StoredFile | null> {
    if (typeof randomPart !== "string" || !PUBLIC_SEGMENT_PATTERN.test(randomPart)) return null;
    // Only a PUBLIC row, live, whose key is exactly `p/{segment}`: a private
    // file is never served here, whatever is asked for.
    const [row] = (await db
      .select()
      .from(f)
      .where(and(eq(f.pathname, `p/${randomPart}`), eq(f.access, "public"), isNull(f.deletedAt)))
      .limit(1)) as Row[];
    return row ? toFile(row) : null;
  }

  async function purgeDeleted(purgeOptions: { readonly limit?: number; readonly timeBudgetMs?: number } = {}) {
    const limit = Math.min(Math.max(Math.floor(purgeOptions.limit ?? 200), 1), 1000);
    const budget = purgeOptions.timeBudgetMs ?? 20_000;
    const started = Date.now();
    const rows = (await db
      .select({ id: f.id, tenantId: f.tenantId, pathname: f.pathname, access: f.access, attempts: f.purgeAttempts })
      .from(f)
      .where(and(isNotNull(f.deletedAt), lt(f.purgeAttempts, MAX_PURGE_ATTEMPTS)))
      .orderBy(asc(f.deletedAt), asc(f.id))
      .limit(limit)) as { id: string; tenantId: string; pathname: string; access: string; attempts: number }[];
    let purged = 0;
    let failed = 0;
    let gaveUp = 0;
    for (const row of rows) {
      if (Date.now() - started > budget) break;
      try {
        await deleteObjectThenRow(row);
        purged += 1;
      } catch (error) {
        failed += 1;
        let attempts = row.attempts + 1;
        try {
          attempts = await addPurgeAttempt(row);
        } catch (mark) {
          report(mark, row.tenantId, "purge-mark");
        }
        if (attempts >= MAX_PURGE_ATTEMPTS) {
          gaveUp += 1;
          // The tenth: a person looks at it. The key is named (this goes to
          // the host's error log, never to a screen).
          report(
            new Error(`Gave up deleting a removed file's bytes after ${MAX_PURGE_ATTEMPTS} tries (key ${row.pathname}, ${row.access} store).`, { cause: error }),
            row.tenantId,
            "purge-gave-up",
          );
        } else {
          report(error, row.tenantId, "purge");
        }
      }
    }
    return { purged, failed, gaveUp };
  }

  async function checkPrivateStore(): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly note?: string }> {
    const target = stores.private;
    if (!target) return { ok: false, reason: "File storage isn't switched on yet." };
    if (typeof target.checkPrivate !== "function") return { ok: true, reason: null };
    try {
      const result = await target.checkPrivate();
      if (result?.ok === true) return typeof result.note === "string" && result.note !== "" ? { ok: true, reason: null, note: result.note } : { ok: true, reason: null };
      return { ok: false, reason: result?.reason ?? "The private file store couldn't be checked." };
    } catch (error) {
      report(error, null, "check-private");
      return { ok: false, reason: "The private file store couldn't be checked." };
    }
  }

  const instance: Storage = {
    tables: options.tables,
    purposes,
    records,
    maxUploadBytes,
    linksEnabled: signer !== null,
    contentUrl: (tenantId, fileId) => options.urls.content(tenantId, fileId),
    async purposesPresent(tenantId) {
      if (!idSchema.safeParse(tenantId).success) return [];
      const rows = (await db.selectDistinct({ kind: f.kind }).from(f).where(live(tenantId)).orderBy(asc(f.kind))) as { kind: string }[];
      return rows.map((row) => row.kind);
    },
    available,
    store,
    get,
    list,
    open,
    remove,
    attach,
    usage,
    signedLink,
    resolveLink,
    publicFile,
    purgeDeleted,
    async deleteObjects(objects) {
      let deleted = 0;
      let failed = 0;
      for (const object of objects ?? []) {
        const source = stores[object?.access === "public" ? "public" : "private"];
        try {
          if (!source) throw new Error(`No ${object?.access === "public" ? "public" : "private"} store is configured, so a forgotten company's file can't be deleted.`);
          await source.delete(object.pathname);
          deleted += 1;
        } catch (error) {
          failed += 1;
          report(error, null, "forget-object");
        }
      }
      return { deleted, failed };
    },
    moveToPrivate: (moveOptions) =>
      runMoveToPrivate(
        { db, files: f, stores, purposes, now: clock, report },
        moveOptions,
      ),
    checkPrivateStore,
    logoStore() {
      const logo = purposes.get("company.logo");
      if (!stores.public || !logo) return undefined;
      return {
        async put(input) {
          // Tenancy 0.6 passes the company (8.3); an older tenancy doesn't,
          // and a logo with no company can't be stored per company.
          if (!input || typeof input.tenantId !== "string" || input.tenantId === "") {
            throw new StorageConfigError("The logo store needs the company (tenancy 0.6 or later passes tenantId).");
          }
          const file = await store({
            tenantId: input.tenantId,
            purpose: logo.key,
            bytes: input.bytes,
            declaredType: input.contentType,
            filename: "Company logo",
            addedBy: null,
          });
          return { url: file.publicUrl ?? "", key: file.id };
        },
        async delete(key, context) {
          if (!context || typeof context.tenantId !== "string" || context.tenantId === "") {
            report(new Error("A logo delete came without its company, so nothing was deleted."), null, "logo-delete");
            return;
          }
          const tenantId = context.tenantId;
          // A 2a logo (review G11): a blob with no row, under tenancy's own
          // pathname. Only one under exactly THIS company's folder is deleted.
          if (key.startsWith(`tenancy/logos/${tenantId}/`) && isLegacyKey(key) && key.split("/").length === 4) {
            const target = stores.public;
            if (!target) return;
            try {
              await target.delete(key);
            } catch (error) {
              report(error, tenantId, "logo-delete");
            }
            return;
          }
          const file = await get({ tenantId, fileId: key });
          // CONTRACT: 6.9 says a file id of this company is removed. Only a
          // LOGO file is: the logo store is tenancy's, and a stale or wrong
          // key must never take a visit's photo with it.
          if (!file || file.purpose !== logo.key) {
            report(new Error("A logo delete named something that isn't this company's logo, so nothing was deleted."), tenantId, "logo-delete");
            return;
          }
          await remove({ tenantId, fileId: file.id });
        },
      } satisfies StorageLogoStore;
    },
    purposeStore(purposeKey) {
      const purpose = purposes.get(purposeKey);
      if (!purpose || !stores[purpose.access]) return undefined;
      return {
        async put(input) {
          const file = await store({
            tenantId: input.tenantId,
            purpose: purpose.key,
            bytes: input.bytes,
            declaredType: input.contentType,
            filename: input.filename,
            // Review SEC-02: a person's upload is theirs, and an ordinary file.
            addedBy: typeof input.addedBy === "string" && input.addedBy !== "" ? input.addedBy : null,
          });
          return { fileId: file.id, url: purpose.access === "public" && file.publicUrl ? file.publicUrl : options.urls.content(file.tenantId, file.id) };
        },
        async delete(input) {
          await remove(input);
        },
        urlFor(input) {
          // A private purpose always opens through the signed-in route, which
          // reads from the store the row is IN: a 2a photo still public is
          // served from there until moveToPrivate moves it.
          return purpose.access === "private" ? options.urls.content(input.tenantId, input.fileId) : input.url;
        },
        async attach(input) {
          await attach(input);
        },
      } satisfies StoragePurposeStore;
    },
  };
  return instance;
}
