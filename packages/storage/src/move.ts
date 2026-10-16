import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { FILE_TYPES, fileTypeOfContentType, imageSize, sniffFileType } from "./file-types.js";
import { newPrivateKey, sha256Hex } from "./keys.js";
import type { StoragePurpose } from "./purposes.js";
import type { StoredFilesTable } from "./schema.js";
import type { BlobObject, BlobStore } from "./types.js";

/**
 * `moveToPrivate` (review G11, D13): 0.1's library files and 2a's estimator
 * photos were stored PUBLIC (0.1 had no other kind), so a customer's photo of
 * their house sits at a public address until it is moved. The upgrade can't
 * move bytes (SQL can't reach a bucket), so the files cron does, a batch at a
 * time:
 *
 *   1. read the object from the PUBLIC store;
 *   2. put it in the PRIVATE store under a new private key (no company id);
 *   3. rewrite the row (`pathname`, `access: 'private'`, `url: null`) — the
 *      id, and so every link and every estimate pointing at it, unchanged;
 *   4. delete the public object.
 *
 * A copy that fails leaves the row exactly as it was (the file still opens
 * from the public store, because every read uses `stores[row.access]`). A
 * row that changed while it was being copied (removed, moved by another run)
 * keeps its change and the copy is deleted. Oldest first, within the budget.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

export interface MoveContext {
  readonly db: Db;
  readonly files: StoredFilesTable;
  readonly stores: { readonly private?: BlobStore; readonly public?: BlobStore };
  readonly purposes: ReadonlyMap<string, StoragePurpose>;
  readonly now: () => Date;
  readonly report: (error: unknown, tenantId: string | null, step: string) => void;
}

/** The whole object as bytes: a store may answer a stream. */
export async function readAll(object: BlobObject): Promise<Uint8Array> {
  if (object.body instanceof Uint8Array) return object.body;
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

export async function runMoveToPrivate(
  ctx: MoveContext,
  options: { readonly purpose: string; readonly tenantIds?: readonly string[]; readonly limit?: number; readonly timeBudgetMs?: number },
): Promise<{ readonly moved: number; readonly failed: number; readonly stoppedEarly: boolean }> {
  const privateStore = ctx.stores.private;
  const publicStore = ctx.stores.public;
  if (!privateStore || typeof options?.purpose !== "string") return { moved: 0, failed: 0, stoppedEarly: false };
  if (options.tenantIds && options.tenantIds.length === 0) return { moved: 0, failed: 0, stoppedEarly: false };
  const f = ctx.files;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000);
  const budget = options.timeBudgetMs ?? 20_000;
  const started = Date.now();
  const where = [eq(f.kind, options.purpose), eq(f.access, "public"), isNull(f.deletedAt)];
  if (options.tenantIds) where.push(inArray(f.tenantId, [...options.tenantIds]));
  const rows = (await ctx.db
    .select({ id: f.id, tenantId: f.tenantId, pathname: f.pathname, contentType: f.contentType })
    .from(f)
    .where(and(...where))
    .orderBy(asc(f.createdAt), asc(f.id))
    .limit(limit + 1)) as { id: string; tenantId: string; pathname: string; contentType: string }[];

  let moved = 0;
  let failed = 0;
  let stoppedEarly = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    if (Date.now() - started > budget) {
      stoppedEarly = true;
      break;
    }
    if (!publicStore) {
      failed += 1;
      ctx.report(new Error("No public store is configured, so old public files can't be read to move them."), row.tenantId, "move-no-public-store");
      continue;
    }
    let newKey: string | null = null;
    try {
      const object = await publicStore.get(row.pathname);
      if (!object) throw new Error(`An old public file's bytes are missing (file ${row.id}).`);
      const bytes = await readAll(object);
      const type = sniffFileType(bytes) ?? fileTypeOfContentType(row.contentType);
      const ext = type ? FILE_TYPES[type].ext : "bin";
      const key = await newPrivateKey(row.tenantId, ext, ctx.now());
      newKey = key;
      await privateStore.put(key, bytes, { contentType: row.contentType, cacheControl: "private, no-store" });
      const size = type ? imageSize(bytes, type) : null;
      const updated = (await ctx.db
        .update(f)
        .set({ pathname: key, access: "private", url: null, sha256: await sha256Hex(bytes), width: size?.width ?? null, height: size?.height ?? null })
        // The row as it was read, still live (`deleted_at is null` also keeps
        // a mis-pointed instance from changing a host's table, D14).
        .where(and(eq(f.tenantId, row.tenantId), eq(f.id, row.id), eq(f.pathname, row.pathname), eq(f.access, "public"), isNull(f.deletedAt)))
        .returning({ id: f.id })) as { id: string }[];
      if (updated.length === 0) {
        // Removed or moved meanwhile: the row's change wins; take the copy back.
        await privateStore.delete(key).catch((error: unknown) => ctx.report(error, row.tenantId, "move-cleanup"));
        failed += 1;
        continue;
      }
      moved += 1;
      try {
        await publicStore.delete(row.pathname);
      } catch (error) {
        // The file is private now (every read follows the row); the old
        // public copy is reported so a person can delete it by hand.
        ctx.report(error, row.tenantId, "move-delete-public");
      }
    } catch (error) {
      failed += 1;
      if (newKey) await privateStore.delete(newKey).catch(() => undefined);
      ctx.report(error, row.tenantId, "move-to-private");
    }
  }
  return { moved, failed, stoppedEarly };
}
