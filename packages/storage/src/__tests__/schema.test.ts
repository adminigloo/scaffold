import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorage, type CreateStorageOptions } from "../instance.js";
import { createMemoryBlobStore } from "../memory.js";
import { defineStorageTables, InvalidTableNameError, storageTables, storedFiles } from "../schema.js";
import { storageSql } from "../sql.js";
import { InvalidStoreError, StorageConfigError } from "../types.js";
import { createTestDb, PNG, tenant, type TestDb } from "./pglite.js";

/**
 * The table set (6.1, D14): the default reproduces 0.1's names exactly; a
 * prefix and a Postgres schema build a second, independent set in the same
 * database; the drizzle table and the shipped SQL agree column for column
 * and index for index; and `createStorage` refuses to start without `tables`
 * or with a store in the wrong slot.
 */

const URLS = { content: (t: string, id: string) => `/c/${t}/${id}`, publicBase: "https://app.test/api/files" };

describe("the default names (a 0.1 install upgrades with ALTERs)", () => {
  it("pins every default name", () => {
    const config = getTableConfig(storageTables.files);
    expect(config.name).toBe("stored_files");
    expect(config.schema).toBeUndefined();
    expect(config.columns.map((c) => c.name)).toEqual([
      "id",
      "tenant_id",
      "owner_id",
      "kind",
      "filename",
      "content_type",
      "size_bytes",
      "pathname",
      "url",
      "access",
      "record_type",
      "record_id",
      "width",
      "height",
      "sha256",
      "deleted_at",
      "purge_attempts",
      "created_at",
    ]);
    expect(config.indexes.map((i) => i.config.name)).toEqual([
      // 0.1's two, kept exactly.
      "stored_files_tenant_created_idx",
      "stored_files_tenant_kind_idx",
      "stored_files_pathname_uidx",
      "stored_files_record_idx",
      "stored_files_live_idx",
      "stored_files_purge_idx",
    ]);
    expect(storedFiles).toBe(storageTables.files);
    expect(storageTables.prefix).toBe("");
    expect(storageTables.schema).toBeNull();
  });

  it("0.2 makes owner_id and url nullable and keeps 0.1's not-nulls", () => {
    const byName = new Map(getTableConfig(storageTables.files).columns.map((c) => [c.name, c.notNull]));
    expect(byName.get("owner_id")).toBe(false);
    expect(byName.get("url")).toBe(false);
    for (const name of ["tenant_id", "kind", "filename", "content_type", "size_bytes", "pathname", "access", "purge_attempts", "created_at"]) {
      expect(byName.get(name), name).toBe(true);
    }
  });
});

describe("prefix and schema", () => {
  it("names everything from the prefix, under the schema", () => {
    const set = defineStorageTables({ prefix: "aig_", schema: "adminigloo" });
    const config = getTableConfig(set.files);
    expect(config.name).toBe("aig_stored_files");
    expect(config.schema).toBe("adminigloo");
    expect(config.indexes.map((i) => i.config.name)).toEqual([
      "aig_stored_files_tenant_created_idx",
      "aig_stored_files_tenant_kind_idx",
      "aig_stored_files_pathname_uidx",
      "aig_stored_files_record_idx",
      "aig_stored_files_live_idx",
      "aig_stored_files_purge_idx",
    ]);
  });

  it("every name stays within Postgres' 63 characters under the longest prefix", () => {
    const longest = `a${"b".repeat(30)}_`;
    expect(longest.length).toBe(32);
    const config = getTableConfig(defineStorageTables({ prefix: longest }).files);
    for (const name of [config.name, ...config.indexes.map((i) => i.config.name as string)]) expect(name.length, name).toBeLessThanOrEqual(63);
  });

  it("refuses a prefix or schema that isn't safe in DDL", () => {
    for (const prefix of ["AIG_", "aig", "_aig_", "a-b_", `a${"b".repeat(31)}_`, "x'; drop table y; --_"]) {
      expect(() => defineStorageTables({ prefix }), prefix).toThrow(InvalidTableNameError);
    }
    for (const schema of ["Admin", "a-b", "x\"y", ""]) expect(() => defineStorageTables({ schema }), schema).toThrow(InvalidTableNameError);
    expect(() => storageSql({ prefix: "bad prefix_" })).toThrow(InvalidTableNameError);
  });
});

describe("the drizzle table and the shipped SQL agree", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb({ schema: "adminigloo", prefix: "aig_" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("column for column, null for null, index for index", async () => {
    const config = getTableConfig(t.tables.files);
    const columns = await t.client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns where table_schema = 'adminigloo' and table_name = 'aig_stored_files' order by ordinal_position`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual(config.columns.map((c) => c.name));
    expect(columns.rows.map((r) => r.is_nullable === "NO")).toEqual(config.columns.map((c) => c.notNull));
    const indexes = await t.client.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'adminigloo' and tablename = 'aig_stored_files' and indexname <> 'aig_stored_files_pkey' order by indexname`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(config.indexes.map((i) => i.config.name as string).sort());
  });

  it("a second, independent set lives beside the default one in the same database", async () => {
    await t.client.exec(storageSql());
    const a = tenant();
    const make = (tables: CreateStorageOptions["tables"]) =>
      createStorage({ db: t.db, tables, stores: { private: createMemoryBlobStore({ access: "private" }) }, urls: URLS });
    const prefixed = make(t.tables);
    const plain = make(storageTables);
    const one = await prefixed.store({ tenantId: a, purpose: "library", bytes: PNG });
    const two = await plain.store({ tenantId: a, purpose: "library", bytes: PNG });
    expect((await prefixed.list({ tenantId: a })).files.map((f) => f.id)).toEqual([one.id]);
    expect((await plain.list({ tenantId: a })).files.map((f) => f.id)).toEqual([two.id]);
  });
});

describe("createStorage refuses to start wrong", () => {
  it("requires `tables` (D14, review G1): a compile error, and a throw for JavaScript", () => {
    const store = createMemoryBlobStore({ access: "private" });
    expect(() =>
      // @ts-expect-error `tables` is required: no default could point at a host's own stored_files.
      createStorage({ db: {} as never, stores: { private: store }, urls: URLS }),
    ).toThrow(StorageConfigError);
  });

  it("refuses a public store in the private slot, and a private one in the public slot (D10)", () => {
    expect(() =>
      createStorage({ db: {} as never, tables: storageTables, stores: { private: createMemoryBlobStore({ access: "public" }) }, urls: URLS }),
    ).toThrow(InvalidStoreError);
    expect(() =>
      createStorage({ db: {} as never, tables: storageTables, stores: { public: createMemoryBlobStore({ access: "private" }) }, urls: URLS }),
    ).toThrow(InvalidStoreError);
  });

  it("refuses a short secret, a missing stillValid and a link life over an hour (review G2)", () => {
    const base = { db: {} as never, tables: storageTables, stores: {}, urls: URLS };
    expect(() => createStorage({ ...base, signing: { secret: "short", stillValid: async () => true } })).toThrow(StorageConfigError);
    expect(() =>
      createStorage({ ...base, signing: { secret: "x".repeat(32), stillValid: undefined as never } }),
    ).toThrow(/stillValid/);
    expect(() => createStorage({ ...base, signing: { secret: "x".repeat(32), ttlSeconds: 3601, stillValid: async () => true } })).toThrow(/ttlSeconds/);
    expect(() => createStorage({ ...base, signing: { secret: "x".repeat(32), ttlSeconds: 30, stillValid: async () => true } })).toThrow(/ttlSeconds/);
    expect(() => createStorage({ ...base, signing: { secret: "x".repeat(32), ttlSeconds: 3600, stillValid: async () => true } })).not.toThrow();
  });

  it("refuses a duplicate purpose or record type, and a malformed one", () => {
    const base = { db: {} as never, tables: storageTables, stores: {}, urls: URLS };
    const purpose = { key: "library", label: "Twice", access: "private", types: ["png"], maxBytes: 10 } as const;
    expect(() => createStorage({ ...base, purposes: [purpose, purpose] })).toThrow(/Two storage purposes/);
    expect(() => createStorage({ ...base, purposes: [{ ...purpose, key: "Bad Key" }] })).toThrow(StorageConfigError);
    expect(() => createStorage({ ...base, purposes: [{ ...purpose, types: ["svg" as never] }] })).toThrow(StorageConfigError);
    expect(() => createStorage({ ...base, purposes: [{ ...purpose, maxShareOfAllowance: 1.5 }] })).toThrow(StorageConfigError);
    const record = { type: "scheduling.visit", label: "Visit", pluralLabel: "Visits", view: ["a"], manage: ["b"], find: async () => new Map() };
    expect(() => createStorage({ ...base, records: [record, record] })).toThrow(/Two record types/);
    expect(() => createStorage({ ...base, records: [{ ...record, type: "visit" }] })).toThrow(StorageConfigError);
  });
});
