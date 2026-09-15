import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { storedFiles } from "./schema.js";

/**
 * Tenant-scoped file storage as a primitive: rows in your database, bytes
 * behind an adapter.
 *
 * Three design rules, each the residue of a bug somebody else ships:
 *
 * THE STORE IS AN INTERFACE, NOT A DEPENDENCY. This package never imports a
 * vendor SDK. The consuming app hands `storeFile` a two-method adapter —
 * Vercel Blob, S3, a directory on disk in tests — and the package's promise
 * (a row for every blob, a blob for every row) holds across all of them.
 * Hard-wiring one vendor here would make "switch storage" mean "re-audit
 * every caller".
 *
 * READS AND DELETES ARE TENANT-SCOPED IN THE WHERE CLAUSE, not by trusting
 * the caller to have checked. `deleteFile` takes the tenant alongside the id,
 * so a guessed id belonging to another tenant deletes zero rows — and the
 * blob is only touched after the row proves the file was theirs to delete.
 *
 * NO ORPHANED ROWS. The blob is written first and the row second; when the
 * row insert fails the blob is best-effort removed. The failure mode that
 * remains — a blob with no row, from a crash between the two writes — is
 * invisible to the product and cleaned by store lifecycle rules, which is
 * strictly better than the inverse: a row whose URL serves nothing, shown to
 * a user as their file.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StorageDb = PgDatabase<any, any, any>;

/** What storeFile accepts as bytes — the union the common stores all take. */
export type BlobBody =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | ReadableStream<Uint8Array>
  | string;

/**
 * The two verbs this package needs from a blob store. Adapters are one-liners:
 *
 *   // Vercel Blob
 *   import { put, del } from "@vercel/blob";
 *   const store: BlobStore = {
 *     put: async (pathname, body, opts) => {
 *       const blob = await put(pathname, body, {
 *         access: "public",
 *         contentType: opts.contentType,
 *         addRandomSuffix: false,
 *       });
 *       return { url: blob.url, pathname: blob.pathname };
 *     },
 *     delete: (pathname) => del(pathname),
 *   };
 */
export interface BlobStore {
  put(
    pathname: string,
    body: BlobBody,
    options: { contentType: string },
  ): Promise<{ url: string; pathname: string }>;
  delete(pathname: string): Promise<void>;
}

/** 10 MB unless the caller says otherwise — a widget screenshot is ~200 KB. */
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

/**
 * A filename a browser typed, made safe to store and echo: separators,
 * control characters and whitespace become underscores, the extension's dot
 * survives, and an all-junk name degrades to "file" rather than to an empty
 * string.
 */
export function sanitizeFilename(raw: string): string {
  // Character codes rather than a regex character class: the class would be
  // mostly escape sequences, and an escape dropped here fails silently as
  // "some filenames aren't cleaned". 92 is the backslash itself.
  const specials = new Set(['"', "*", "/", ":", "<", ">", "?", "|", String.fromCharCode(92)]);
  const chars = [...raw.trim().slice(0, 200)].map((ch) => {
    const code = ch.charCodeAt(0);
    if (code < 33) return "_"; // control characters and the space
    return specials.has(ch) ? "_" : ch;
  });
  let name = chars.join("");
  while (name.startsWith(".")) name = "_" + name.slice(1);
  return name.length > 0 ? name : "file";
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

/**
 * Write the bytes, then the receipt. The pathname namespaces by tenant —
 * `t/{tenantId}/{random}-{filename}` — so a store browsed by hand still
 * reads as a filing cabinet, and a random segment keeps two "report.pdf"s
 * from colliding without renaming either.
 */
export async function storeFile(
  db: StorageDb,
  store: BlobStore,
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
    const rows: StoredFileRow[] = await db
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
      })
      .returning(ROW_COLUMNS);
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return row;
  } catch (error) {
    // A blob with a row is a file; a blob without one is a leak. Try to take
    // the bytes back out, but the original failure is the one that matters.
    await store.delete(stored.pathname).catch(() => undefined);
    throw error;
  }
}

export async function listFiles(
  db: StorageDb,
  input: { tenantId: string; kind?: string; limit?: number },
): Promise<StoredFileRow[]> {
  const where = input.kind
    ? and(eq(storedFiles.tenantId, input.tenantId), eq(storedFiles.kind, input.kind))
    : eq(storedFiles.tenantId, input.tenantId);
  return db
    .select(ROW_COLUMNS)
    .from(storedFiles)
    .where(where)
    .orderBy(desc(storedFiles.createdAt), desc(storedFiles.id))
    .limit(input.limit ?? 50);
}

export async function getFile(
  db: StorageDb,
  input: { id: string; tenantId: string },
): Promise<StoredFileRow | null> {
  const rows = await db
    .select(ROW_COLUMNS)
    .from(storedFiles)
    .where(and(eq(storedFiles.id, input.id), eq(storedFiles.tenantId, input.tenantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Row first, then blob: the row's WHERE proves the file belonged to this
 * tenant before any bytes are touched. `blobRemoved: false` with
 * `deleted: true` means the receipt is gone but the store kept the bytes —
 * report it rather than throwing, because from the product's side the file
 * IS deleted and a retry loop against a flaky store helps nobody.
 */
export async function deleteFile(
  db: StorageDb,
  store: BlobStore,
  input: { id: string; tenantId: string },
): Promise<{ deleted: boolean; blobRemoved: boolean }> {
  const rows: Array<{ pathname: string }> = await db
    .delete(storedFiles)
    .where(and(eq(storedFiles.id, input.id), eq(storedFiles.tenantId, input.tenantId)))
    .returning({ pathname: storedFiles.pathname });
  const row = rows[0];
  if (!row) return { deleted: false, blobRemoved: false };

  const blobRemoved = await store
    .delete(row.pathname)
    .then(() => true)
    .catch(() => false);
  return { deleted: true, blobRemoved };
}
