import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorage, type StorageDb } from "../instance.js";
import { createMemoryBlobStore } from "../memory.js";
import { storageTables } from "../schema.js";
import { storageSql, storageUpgradeSql } from "../sql.js";

/**
 * A host's OWN table named `stored_files` (review G1, D14). Ridgeline has
 * one: `stored_files(id, tenant_id, pathname)`, its invoices' PDFs. Then:
 *   (a) the shipped SQL refuses to run over it, create and upgrade alike;
 *   (b) an instance mis-pointed at it (the default `storageTables`) THROWS
 *       from every statement that changes rows, because each names a column
 *       only the package's table has (`deleted_at`, `purge_attempts`);
 *   (c) the host's rows are exactly as they were.
 */

let client: PGlite;
let db: StorageDb;
const snapshot = async () => (await client.query("select * from stored_files order by id")).rows;
let before: unknown[];

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    create table stored_files (id text primary key, tenant_id text, pathname text);
    insert into stored_files values ('inv-1', 'acme', 'invoices/inv-1.pdf'), ('inv-2', 'acme', 'invoices/inv-2.pdf'), ('inv-3', 'zeta', 'invoices/inv-3.pdf');`);
  db = drizzle(client) as unknown as StorageDb;
  before = await snapshot();
});
afterAll(async () => {
  await client.close();
});

describe("a host's own stored_files", () => {
  it("(a) storageSql() raises the guard's sentence and creates nothing", async () => {
    await expect(client.exec(storageSql())).rejects.toThrow(
      "A table named stored_files already exists and isn't AdminIgloo's. Pass a prefix or a schema.",
    );
    const indexes = (await client.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'stored_files'")).rows;
    expect(indexes.map((i) => i.indexname)).toEqual(["stored_files_pkey"]);
  });

  it("(a) and so does the upgrade", async () => {
    await expect(client.exec(storageUpgradeSql())).rejects.toThrow(/isn't AdminIgloo's storage 0\.1 table/);
  });

  it("(b) an instance pointed at it throws from remove, purgeDeleted, attach and moveToPrivate", async () => {
    const storage = createStorage({
      db,
      tables: storageTables,
      stores: { private: createMemoryBlobStore({ access: "private" }), public: createMemoryBlobStore({ access: "public" }) },
      records: [{ type: "scheduling.visit", label: "Visit", pluralLabel: "Visits", view: ["v"], manage: ["m"], find: async () => new Map() }],
      urls: { content: (t, id) => `/c/${t}/${id}`, publicBase: "https://app.test/api/files" },
      onError: () => undefined,
    });
    await expect(storage.remove({ tenantId: "acme", fileId: "inv-1" })).rejects.toThrow();
    await expect(storage.purgeDeleted()).rejects.toThrow();
    await expect(storage.attach({ tenantId: "acme", fileId: "inv-1", record: { type: "scheduling.visit", id: "v1" } })).rejects.toThrow();
    await expect(storage.moveToPrivate({ purpose: "library" })).rejects.toThrow();
  });

  it("(c) the host's rows are unchanged", async () => {
    expect(await snapshot()).toEqual(before);
  });

  it("the cure: a prefix (or a schema) gives the package its own table beside the host's", async () => {
    await client.exec(storageSql({ prefix: "aig_" }));
    const tables = (await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows;
    expect(tables.map((r) => r.tablename)).toEqual(["aig_stored_files", "stored_files"]);
    expect(await snapshot()).toEqual(before);
  });
});
