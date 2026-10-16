import { sql } from "drizzle-orm";
import { index, integer, pgSchema, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./columns.js";
import { storageNames, type DefineStorageTablesOptions } from "./names.js";

/**
 * One row per stored file: the receipt, in the app's own database. The bytes
 * live in a blob store; the row is what the app can list, authorize, bill and
 * delete by. A file whose only record is the blob store's dashboard is a file
 * the product cannot reason about.
 *
 * `tenant_id` and `owner_id` are plain text naming a company and a person in
 * the CONSUMING app (no foreign keys: this schema must not force the tenancy
 * or auth package on anyone). `'*'` is 0.1's firm-wide sentinel.
 *
 * TABLE NAMES ARE THE HOST'S TO CHOOSE (D14, the analytics 0.2 pattern).
 * `defineStorageTables({ prefix, schema })` builds the table under a prefix
 * (`aig_` → `aig_stored_files`), a Postgres schema of the host's own
 * (Ridgeline keeps package tables in `adminigloo` so its `prisma migrate`
 * drift check stays clean), or both. The default reproduces 0.1's names
 * EXACTLY (the table and its two index names), so a 0.1 install upgrades with
 * ALTERs (sql/upgrade-0.1-to-0.2.sql). A snapshot test pins every default name.
 *
 * NEVER A HOST'S TABLE BY DEFAULT (review G1). `createStorage` REQUIRES
 * `tables`: there is no default that could quietly point every statement at a
 * host's own `stored_files`. Only 0.1's deprecated functions keep the
 * default set.
 *
 * 0.1's column names are kept (`kind` is the PURPOSE, `owner_id` is WHO ADDED
 * IT, `pathname` is the store's key); 0.2 makes `owner_id` and `url`
 * nullable (a customer's photo has no person behind it; a private file has
 * no address) and adds the columns below.
 */

export { InvalidTableNameError, storageNames } from "./names.js";
export type { DefineStorageTablesOptions } from "./names.js";

function columns() {
  return {
    id: idColumn(),
    /** The company (`'*'`: 0.1's firm-wide rows). */
    tenantId: text("tenant_id").notNull(),
    /** WHO ADDED IT (0.1's name). 0.2: nullable; null = the customer or the system. */
    ownerId: text("owner_id"),
    /** The PURPOSE key (0.1's name): `attachment`, `library`, `company.logo`, `estimator.photo`, … */
    kind: text("kind").notNull(),
    /** The name shown, sanitized, with the sniffed type's extension (review G18). */
    filename: text("filename").notNull(),
    /** From the bytes (6.3), never the browser's word. */
    contentType: text("content_type").notNull(),
    /** Measured, never the caller's number. */
    sizeBytes: integer("size_bytes").notNull(),
    /** The store's key (0.1's name). Never on the wire (D10). */
    pathname: text("pathname").notNull(),
    /** A PUBLIC file's address; null for a private one (0.1: not null). */
    url: text("url"),
    /** Which store the bytes are IN: `private` · `public` (0.1's rows were public; 0.2 always writes it). D13 deletes from THIS store. */
    access: text("access").notNull().default("public"),
    /** The record it belongs to (D12): a record type (`scheduling.visit`) and that record's id. */
    recordType: text("record_type"),
    recordId: text("record_id"),
    /** An image's size, from its header. */
    width: integer("width"),
    height: integer("height"),
    /** Hex SHA-256 of the bytes; the content route's ETag. */
    sha256: text("sha256"),
    /** D13: set when it is removed (it leaves every list and the usage at once); the row goes once the bytes have. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** D13: how many times deleting the bytes failed; the files cron gives up (and reports the key) at 10. */
    purgeAttempts: integer("purge_attempts").notNull().default(0),
    createdAt: createdAt(),
  };
}

interface IndexedColumns {
  readonly id: AnyPgColumn;
  readonly tenantId: AnyPgColumn;
  readonly kind: AnyPgColumn;
  readonly pathname: AnyPgColumn;
  readonly recordType: AnyPgColumn;
  readonly recordId: AnyPgColumn;
  readonly deletedAt: AnyPgColumn;
  readonly createdAt: AnyPgColumn;
}

function indexes(names: ReturnType<typeof storageNames>) {
  return (c: IndexedColumns) => [
    // 0.1's two, names kept exactly: the library listing, and by purpose.
    index(names.indexes.tenantCreated).on(c.tenantId, c.createdAt),
    index(names.indexes.tenantKind).on(c.tenantId, c.kind),
    // One row per stored object: the public route looks a logo up by its key.
    uniqueIndex(names.indexes.pathname).on(c.pathname),
    // A record's "Photos and files", live rows only.
    index(names.indexes.record).on(c.tenantId, c.recordType, c.recordId).where(sql`deleted_at is null`),
    // The Files screen's pages, newest first, live rows only.
    index(names.indexes.live).on(c.tenantId, c.createdAt, c.id).where(sql`deleted_at is null`),
    // The files cron's purge: removed rows whose bytes are still to delete.
    index(names.indexes.purge).on(c.deletedAt).where(sql`deleted_at is not null`),
  ];
}

function buildPlain(names: ReturnType<typeof storageNames>) {
  return pgTable(names.table, columns(), (t) => indexes(names)(t as unknown as IndexedColumns));
}

/** The table type every set shares (a schema-qualified set has the same columns). */
export type StoredFilesTable = ReturnType<typeof buildPlain>;

export interface StorageTables {
  readonly prefix: string;
  readonly schema: string | null;
  /** "{prefix}stored_files" */
  readonly files: StoredFilesTable;
}

/**
 * The storage table under `options`. Under a prefix, export the prefixed
 * table by name from your drizzle schema and never `export * from
 * "@adminigloo/storage/schema"`: that line also exports the default set
 * (`storedFiles` → `stored_files`), which collides with a table of yours by
 * that name.
 */
export function defineStorageTables(options: DefineStorageTablesOptions = {}): StorageTables {
  const names = storageNames(options);
  const files = names.schema
    ? // Same columns, schema-qualified: drizzle writes "adminigloo"."stored_files".
      (pgSchema(names.schema).table(names.table, columns(), (t) => indexes(names)(t as unknown as IndexedColumns)) as unknown as StoredFilesTable)
    : buildPlain(names);
  return Object.freeze({ prefix: names.prefix, schema: names.schema, files });
}

/** The default set: 0.1's names. */
export const storageTables: StorageTables = defineStorageTables();

/** 0.1's export name: the same table as storageTables.files. */
export const storedFiles: StorageTables["files"] = storageTables.files;

export { storageSql } from "./sql.js";
