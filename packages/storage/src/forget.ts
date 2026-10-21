import { eq, getTableName, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { storageTables, type StorageTables } from "./schema.js";

/** Where one stored file's bytes are: which store, and the key in it. */
export interface StoredObjectRef {
  readonly access: "private" | "public";
  readonly pathname: string;
}

function checkTenant(tenantId: string): void {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
}

/**
 * Every object a company's files keep in the stores, removed ones still
 * waiting for the files cron included. Read it on the deletion's transaction
 * BEFORE `forgetTenant`, and hand it to `storage.deleteObjects` once that
 * transaction has committed: the rows go with everything else, all or
 * nothing, and the bytes only once nothing points at them.
 */
export async function listTenantObjects(
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: StorageTables } = {},
): Promise<readonly StoredObjectRef[]> {
  checkTenant(tenantId);
  const f = (options.tables ?? storageTables).files;
  const rows = (await db.select({ access: f.access, pathname: f.pathname }).from(f).where(eq(f.tenantId, tenantId))) as {
    access: string;
    pathname: string;
  }[];
  return rows.map((r) => ({ access: r.access === "public" ? "public" : "private", pathname: r.pathname }));
}

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every file record the
 * company has — live ones and removed ones still waiting for the files cron —
 * filtered by the company's id. Run it on the deletion's transaction, after
 * `listTenantObjects`; the bytes themselves are `storage.deleteObjects`'s,
 * after the commit. `tables`: the set the project defined
 * (`defineStorageTables`), default `stored_files`.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: StorageTables } = {},
): Promise<Readonly<Record<string, number>>> {
  checkTenant(tenantId);
  const f = (options.tables ?? storageTables).files;
  const one = { one: sql<number>`1` };
  return { [getTableName(f)]: (await db.delete(f).where(eq(f.tenantId, tenantId)).returning(one)).length };
}
