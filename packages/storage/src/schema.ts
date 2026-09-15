import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * One row per stored file — the receipt, in the app's own database. The bytes
 * live in whatever blob store the app wired up; the row is what the app can
 * list, authorize, bill and delete by. A file whose only record is the blob
 * store's dashboard is a file the product cannot reason about.
 *
 * `tenantId` and `ownerId` are plain text naming a tenant and a principal in
 * the CONSUMING app (the cross-package no-FK rule: this schema must not force
 * the tenancy or auth package on anyone). `'*'` is the firm-wide sentinel,
 * same convention the permissions tables use, for files staff store outside
 * any tenant.
 *
 * `pathname` is the store's deletion handle and is deliberately separate from
 * `url`: a CDN-fronted store serves at one address and deletes by another,
 * and conflating them is how "deleted" files keep serving.
 */
export const storedFiles = pgTable(
  "stored_files",
  {
    id: idColumn(),
    /** A tenant id in the consuming app, or '*' for firm-wide files. */
    tenantId: text("tenant_id").notNull(),
    /** The principal who stored it. Who to ask before deleting. */
    ownerId: text("owner_id").notNull(),
    /** Stable machine kind, e.g. "feedback.attachment" — what listings filter on. */
    kind: text("kind").notNull(),
    /** Display name, already sanitized by storeFile. */
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** The store's key for these bytes — the deletion handle. */
    pathname: text("pathname").notNull(),
    /** Where the bytes are served from. */
    url: text("url").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // The library listing: newest files in a tenant, optionally by kind.
    index("stored_files_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("stored_files_tenant_kind_idx").on(table.tenantId, table.kind),
  ],
);
