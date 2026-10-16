/**
 * The shapes every part of @adminigloo/storage 0.2 shares (Tenancy 2b-1,
 * sections 6.2 and 6.6): the store interface the adapters implement, the
 * file the instance hands back, and the errors it throws.
 *
 * Kept in one module with no imports of its own, so the adapters (`./s3`,
 * `./vercel-blob`, `./local`, `./testing`) can name `StorageError` and
 * `BlobStore` without pulling the instance, drizzle or zod into a bundle that
 * only wants to talk to a bucket.
 */

/** What `get` answers: the bytes (streamed, or in memory), and what the store knows about them. */
export interface BlobObject {
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
  readonly contentType: string | null;
  readonly size: number | null;
}

/**
 * The store interface (D10). A NEW shape under 0.1's name: 0.1's two-method
 * adapter is `BlobStoreV1`, which the deprecated 0.1 functions still take.
 *
 * Every adapter checks every key it is handed before any I/O (review G7):
 * `STORAGE_KEY_PATTERN` for `put`, that or the legacy shapes for `get` and
 * `delete` (see keys.ts). A key that fails throws `InvalidKeyError` and
 * touches nothing.
 */
export interface BlobStore {
  /** "private" never hands out a URL. "public": `put` answers the address anyone may open, or null when the host serves it (6.8). */
  readonly access: "private" | "public";
  put(key: string, bytes: Uint8Array, options: { readonly contentType: string; readonly cacheControl?: string }): Promise<{ readonly url: string | null }>;
  /** null when there is no such object. */
  get(key: string): Promise<BlobObject | null>;
  /** Resolves once the object is gone (or was never there). */
  delete(key: string): Promise<void>;
  /**
   * Private stores only, optional (review G9): is this store really private?
   * S3-compatible: puts a probe object, fetches it with an UNSIGNED GET (which
   * must be refused), deletes the probe. Vercel Blob: the store's URL host.
   * Memory and local disk: always ok. Never throws ({ ok: false, reason }).
   * `note` (reviews FH-8, SEC-05): ok, but with something the check couldn't
   * see, in plain words (an R2 bucket's r2.dev address), for /setup to show.
   */
  checkPrivate?(): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly note?: string | null }>;
}

/** What 0.1's storeFile accepts as bytes: the union the common stores all take. */
export type BlobBody = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string;

/** 0.1's two-method adapter, for the deprecated 0.1 functions only. */
export interface BlobStoreV1 {
  put(pathname: string, body: BlobBody, options: { contentType: string }): Promise<{ url: string; pathname: string }>;
  delete(pathname: string): Promise<void>;
}

/** One stored file, as the instance answers it. Instants are Dates. */
export interface StoredFile {
  readonly id: string;
  readonly tenantId: string;
  /** The purpose key (`attachment`, `library`, `company.logo`, `estimator.photo`, …). */
  readonly purpose: string;
  /** Which store the bytes are IN (D13): `stores[access]` reads and deletes them. */
  readonly access: "private" | "public";
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Hex; the content route's ETag. "" for a 0.1 row stored before it was kept. */
  readonly sha256: string;
  readonly record: { readonly type: string; readonly id: string } | null;
  /** Who added it; null for the customer or the system. */
  readonly addedBy: string | null;
  /** Public files only. */
  readonly publicUrl: string | null;
  readonly createdAt: Date;
  /** The store's key. SERVER ONLY: no wire type has a field for it (D10). */
  readonly key: string;
}

export interface StoreInput {
  readonly tenantId: string;
  readonly purpose: string;
  readonly bytes: Uint8Array;
  /** What the browser said: a hint for the file name's extension only. */
  readonly declaredType?: string | null;
  readonly filename?: string | null;
  readonly addedBy?: string | null;
  readonly record?: { readonly type: string; readonly id: string } | null;
}

/** A company's usage: live files only (a file being deleted has already left it, D13). */
export interface StorageUsage {
  readonly usedBytes: number;
  readonly fileCount: number;
  /** null = no allowance. */
  readonly allowanceBytes: number | null;
}

/** What `onUsage` is told (6.6): after every store, every refusal for the company's allowance, and every refusal for a purpose's share. */
export interface StorageUsageEvent {
  readonly tenantId: string;
  /** The company's whole usage. */
  readonly usage: StorageUsage;
  /**
   * "refused": a file was refused for the company's allowance (it is full).
   * "share_full" (review SEC-02): refused for its purpose's share (the
   * customers' estimate photos have used their fifth), while the company
   * itself still has room; `share` says how much.
   */
  readonly outcome: "stored" | "refused" | "share_full";
  readonly purpose: string;
  /** With "share_full": the purpose's label, what of it counts toward the share, and the share. */
  readonly share?: { readonly purposeLabel: string; readonly usedBytes: number; readonly limitBytes: number };
}

export type StorageErrorCode =
  | "storage_off"
  | "file_type"
  | "file_too_big"
  | "storage_full"
  | "not_removable"
  | "unknown_purpose"
  | "unknown_record"
  | "invalid";

/**
 * Every refusal the instance makes, with the sentence a person reads.
 *
 * `name` is checked STRUCTURALLY by other packages (the estimator, 10.5):
 * `error.name === "StorageError"` and `error.code`, never `instanceof` — two
 * copies of this package in one bundle must still be understood. A
 * `storage_full` from a purpose's share carries `share: true`.
 */
export class StorageError extends Error {
  readonly name = "StorageError";
  readonly share?: boolean;
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options: { readonly share?: boolean } = {},
  ) {
    super(message);
    if (options.share) this.share = true;
  }
}

/** A store handed to the wrong slot (a public store as `stores.private`): thrown by `createStorage`, D10. */
export class InvalidStoreError extends Error {
  readonly name = "InvalidStoreError";
}

/** A configuration `createStorage` can't run with (a short secret, a duplicate purpose). Thrown at construction, never per request. */
export class StorageConfigError extends Error {
  readonly name = "StorageConfigError";
}

/**
 * A key no adapter accepts (D10, review G7): not one this package makes, nor
 * (for get and delete) a legacy shape. Thrown BEFORE any I/O. The message
 * never repeats the key: keys are server-only.
 */
export class InvalidKeyError extends Error {
  readonly name = "InvalidKeyError";
  constructor(message = "That isn't a storage key this package makes, so nothing was read, written or deleted.") {
    super(message);
  }
}
