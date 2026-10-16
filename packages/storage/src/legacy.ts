import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { sanitizeFilename } from "./filenames.js";
import type { StorageDb } from "./instance.js";
import { storedFiles } from "./schema.js";
import type { BlobBody, BlobStoreV1 } from "./types.js";

/**
 * 0.1's API, kept (section 6.11): the same signatures, on the DEFAULT table
 * (the only place a default table is implicit, D14), so a 0.1 caller keeps
 * compiling and working after the upgrade. Each is `@deprecated`, naming the
 * instance method that replaces it.
 *
 * What changed underneath, and why:
 * - `storeFile` writes `access: 'public'`: a 0.1 adapter (`BlobStoreV1`) is a
 *   public store by construction (it answers a URL), and the row must say
 *   which store its bytes are in so 0.2 deletes them from THAT store (D13).
 * - `listFiles`, `getFile` and `deleteFile` see only LIVE PUBLIC rows: a 0.2
 *   private file has no URL to hand a 0.1 caller (its row type says `url:
 *   string`), and its bytes are in a store a `BlobStoreV1` isn't, so a 0.1
 *   delete would remove the receipt and leave the bytes behind.
 */

/** 10 MB unless the caller says otherwise: a widget screenshot is ~200 KB. */
export const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export const storeFileSchema = z.object({
  tenantId: z.string().min(1).max(200),
  ownerId: z.string().min(1).max(200),
  kind: z.string().min(1).max(80),
  filename: z.string().min(1).max(200),
  /** "type/subtype", the only shape a Content-Type header may take. */
  contentType: z
    .string()
    .max(120)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, "not a media type"),
  sizeBytes: z.number().int().positive(),
});

export type StoreFileInput = z.infer<typeof storeFileSchema> & {
  body: BlobBody;
};

export interface StoredFileRow {
  id: string;
  tenantId: string;
  ownerId: string;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  pathname: string;
  url: string;
  createdAt: Date;
}

const ROW_COLUMNS = {
  id: storedFiles.id,
  tenantId: storedFiles.tenantId,
  ownerId: storedFiles.ownerId,
  kind: storedFiles.kind,
  filename: storedFiles.filename,
  contentType: storedFiles.contentType,
  sizeBytes: storedFiles.sizeBytes,
  pathname: storedFiles.pathname,
  url: storedFiles.url,
  createdAt: storedFiles.createdAt,
} as const;

type RawRow = Omit<StoredFileRow, "ownerId" | "url"> & { ownerId: string | null; url: string | null };

function toRow(raw: RawRow): StoredFileRow {
  return { ...raw, ownerId: raw.ownerId ?? "", url: raw.url ?? "" };
}

const publicLive = and(eq(storedFiles.access, "public"), isNull(storedFiles.deletedAt));

/**
 * Write the bytes, then the receipt. The pathname namespaces by tenant —
 * `t/{tenantId}/{random}-{filename}` — 0.1's shape, kept so a 0.1 adapter
 * sees exactly what it always saw.
 *
 * @deprecated Use `createStorage({ db, tables, stores, … }).store({ tenantId, purpose, bytes, … })`:
 * private by default, the type read from the bytes, keys without company ids.
 */
export async function storeFile(
  db: StorageDb,
  store: BlobStoreV1,
  input: StoreFileInput,
  options: { maxSizeBytes?: number } = {},
): Promise<StoredFileRow> {
  const parsed = storeFileSchema.parse(input);
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  if (parsed.sizeBytes > maxSize) {
    throw new Error(`file is ${parsed.sizeBytes} bytes; the limit is ${maxSize}`);
  }

  const filename = sanitizeFilename(parsed.filename);
  const pathname = `t/${parsed.tenantId}/${crypto.randomUUID()}-${filename}`;
  const stored = await store.put(pathname, input.body, {
    contentType: parsed.contentType,
  });

  try {
    const rows = (await db
      .insert(storedFiles)
      .values({
        tenantId: parsed.tenantId,
        ownerId: parsed.ownerId,
        kind: parsed.kind,
        filename,
        contentType: parsed.contentType,
        sizeBytes: parsed.sizeBytes,
        pathname: stored.pathname,
        url: stored.url,
        access: "public",
      })
      .returning(ROW_COLUMNS)) as RawRow[];
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return toRow(row);
  } catch (error) {
    // A blob with a row is a file; a blob without one is a leak. Try to take
    // the bytes back out, but the original failure is the one that matters.
    await store.delete(stored.pathname).catch(() => undefined);
    throw error;
  }
}

/** @deprecated Use `storage.list({ tenantId, purpose })`. */
export async function listFiles(db: StorageDb, input: { tenantId: string; kind?: string; limit?: number }): Promise<StoredFileRow[]> {
  const where = input.kind
    ? and(eq(storedFiles.tenantId, input.tenantId), eq(storedFiles.kind, input.kind), publicLive)
    : and(eq(storedFiles.tenantId, input.tenantId), publicLive);
  const rows = (await db
    .select(ROW_COLUMNS)
    .from(storedFiles)
    .where(where)
    .orderBy(desc(storedFiles.createdAt), desc(storedFiles.id))
    .limit(input.limit ?? 50)) as RawRow[];
  return rows.map(toRow);
}

/** @deprecated Use `storage.get({ tenantId, fileId })`. */
export async function getFile(db: StorageDb, input: { id: string; tenantId: string }): Promise<StoredFileRow | null> {
  const rows = (await db
    .select(ROW_COLUMNS)
    .from(storedFiles)
    .where(and(eq(storedFiles.id, input.id), eq(storedFiles.tenantId, input.tenantId), publicLive))
    .limit(1)) as RawRow[];
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Row first, then blob: the row's WHERE proves the file belonged to this
 * tenant before any bytes are touched. `blobRemoved: false` with
 * `deleted: true` means the receipt is gone but the store kept the bytes —
 * reported rather than thrown, because from the product's side the file IS
 * deleted.
 *
 * @deprecated Use `storage.remove({ tenantId, fileId })`: it deletes the
 * bytes from the store they are in, and keeps retrying when the store fails.
 */
export async function deleteFile(
  db: StorageDb,
  store: BlobStoreV1,
  input: { id: string; tenantId: string },
): Promise<{ deleted: boolean; blobRemoved: boolean }> {
  const rows = (await db
    .delete(storedFiles)
    .where(and(eq(storedFiles.id, input.id), eq(storedFiles.tenantId, input.tenantId), publicLive))
    .returning({ pathname: storedFiles.pathname })) as Array<{ pathname: string }>;
  const row = rows[0];
  if (!row) return { deleted: false, blobRemoved: false };

  const blobRemoved = await store
    .delete(row.pathname)
    .then(() => true)
    .catch(() => false);
  return { deleted: true, blobRemoved };
}
