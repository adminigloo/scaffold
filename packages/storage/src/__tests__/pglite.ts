import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { StorageDb } from "../instance.js";
import { defineStorageTables, type DefineStorageTablesOptions, type StorageTables } from "../schema.js";
import { storageSql } from "../sql.js";

/**
 * A REAL Postgres for every service and handler test (Tenancy 2b-1, 15):
 * PGlite is Postgres compiled to WASM, in-process, so `pnpm test` runs the
 * actual SQL (the tenant filters, the partial indexes, the advisory lock, the
 * transactions) with nothing configured. Each security claim is asserted
 * against SQL, never a fake (IF-21). COPIED in shape from
 * @adminigloo/scheduling (src/__tests__/pglite.ts).
 *
 * THE TABLES ARE BUILT FROM THE SHIPPED SQL (`storageSql(options)`), not from
 * a DDL generated off the drizzle table: so the whole suite also proves the
 * SQL a host without drizzle-kit pastes into its own migration (D14), under
 * the default names and under a schema and a prefix.
 *
 * What PGlite cannot prove: it is a single connection, so two transactions
 * never truly run at once. The race tests prove the re-check-under-lock
 * LOGIC with the two uploads interleaved by hand, in both orders; that the
 * lock is TAKEN (first, on the right key, in the transaction) is proved from
 * the query log below.
 */

export interface LoggedQuery {
  sql: string;
  params: unknown[];
  inTransaction: boolean;
}

export interface TestDb {
  db: StorageDb;
  client: PGlite;
  tables: StorageTables;
  queries: LoggedQuery[];
  close: () => Promise<void>;
}

export async function createTestDb(options: DefineStorageTablesOptions & { readonly before?: string } = {}): Promise<TestDb> {
  const client = new PGlite();
  if (options.before) await client.exec(options.before);
  const names: DefineStorageTablesOptions = {
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  };
  await client.exec(storageSql(names));
  const queries: LoggedQuery[] = [];
  let depth = 0;
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params, inTransaction: depth > 0 }) },
  }) as unknown as StorageDb;
  const transaction = db.transaction.bind(db);
  db.transaction = ((run, config) =>
    transaction(async (tx) => {
      depth += 1;
      try {
        return await run(tx);
      } finally {
        depth -= 1;
      }
    }, config)) as typeof db.transaction;
  return { db, client, tables: defineStorageTables(names), queries, close: () => client.close() };
}

let counter = 0;
/** A fresh company per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "co"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A 1×1 PNG (real bytes: sniffed as png, 1×1 from its header). */
export const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** A minimal JPEG header with a 640×480 SOF0 frame. */
export function jpeg(width = 640, height = 480, padTo = 0): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const tail = [0xff, 0xd9];
  const bytes = [...head, ...sof, ...tail];
  const out = new Uint8Array(Math.max(bytes.length, padTo));
  out.set(bytes);
  return out;
}

/** `%PDF-1.4` and a little body. */
export function pdf(size = 64): Uint8Array {
  const text = "%PDF-1.4\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n";
  const out = new Uint8Array(Math.max(size, text.length));
  out.set(new TextEncoder().encode(text));
  return out;
}

/** Bytes of a given size that sniff as PNG (the signature, then zeros). */
export function pngOfSize(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(PNG.subarray(0, Math.min(PNG.length, size)));
  return out;
}
