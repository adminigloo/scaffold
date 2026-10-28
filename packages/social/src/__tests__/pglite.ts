import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SocialDb } from "../store.js";

/**
 * A REAL Postgres for the queue's suites: PGlite, in-process. Built from the
 * SHIPPED DDL (sql/social-0.1.0.sql), so every suite that writes a draft also
 * proves the file an app without drizzle-kit runs makes the table the store
 * needs. Another prefix: the same file with "social_" replaced, as its header
 * tells an app to do.
 */
// __dirname, not import.meta.url: under happy-dom (the screens suite) the module URL isn't a file.
export const SHIPPED_SQL = readFileSync(join(__dirname, "..", "..", "sql", "social-0.1.0.sql"), "utf8");

export interface TestDb {
  readonly db: SocialDb;
  readonly client: PGlite;
  readonly close: () => Promise<void>;
}

export async function createTestDb(options: { readonly prefix?: string } = {}): Promise<TestDb> {
  const client = new PGlite();
  const ddl = options.prefix ? SHIPPED_SQL.replace(/"social_/g, `"${options.prefix}`) : SHIPPED_SQL;
  await client.exec(ddl);
  const db = drizzle(client) as unknown as SocialDb;
  return { db, client, close: () => client.close() };
}

let counter = 0;
/** A fresh company per test. */
export function tenant(prefix = "co"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
