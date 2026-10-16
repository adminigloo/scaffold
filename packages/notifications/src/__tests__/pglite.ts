import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { defineNotificationTables, notificationsSql, notificationTables, type NotificationTables } from "../schema.js";
import type { NotificationsDb } from "../types.js";

/**
 * A REAL Postgres for every service and handler suite (Tenancy 2b-1, 15;
 * IF-21: each security claim is asserted against SQL, never a fake). PGlite
 * is Postgres compiled to WASM, in-process, so `pnpm test` runs the actual
 * SQL with nothing configured. COPIED in spirit from @adminigloo/scheduling's
 * src/__tests__/pglite.ts.
 *
 * THE TABLES ARE BUILT FROM THE SHIPPED SQL (`notificationsSql`), not from a
 * second DDL generator, so the SQL a host without drizzle-kit pastes is the
 * SQL every suite runs on.
 *
 * TWO LAYOUTS (15.1, review G1). vitest.config.ts runs the service suites
 * twice:
 *   - "default": the 0.1 names (`notifications`, …), as create-app installs;
 *   - "foreign": a host (Ridgeline) that already has its OWN `public.notifications(id,
 *     user_id, read_at, created_at)` with rows, and puts the package's tables
 *     under `{ schema: "adminigloo", prefix: "aig_" }`. `close()` then checks
 *     the host's table and rows are exactly as they were: the whole suite ran
 *     next to it without touching it.
 *
 * What PGlite cannot prove: it is a single connection, so two statements
 * never truly run at once. The claim races are proved as interleavings (two
 * runs started together on one connection take turns statement by
 * statement), and the guard is proved from the query log.
 */

export type Layout = "default" | "foreign";

export const LAYOUT: Layout = process.env.NOTIFICATIONS_TEST_LAYOUT === "foreign" ? "foreign" : "default";

export const FOREIGN_OPTIONS = { schema: "adminigloo", prefix: "aig_" } as const;

/** The host's own table of the same name, and its rows (review G1). */
export const HOST_TABLE_SQL = `
create table public.notifications (id text primary key, user_id text, read_at timestamptz, created_at timestamptz);
insert into public.notifications (id, user_id, read_at, created_at) values
  ('host-1', 'u-42', null, '2026-01-02T03:04:05Z'),
  ('host-2', 'u-43', '2026-01-03T00:00:00Z', '2025-06-01T00:00:00Z');
`;

export interface LoggedQuery {
  sql: string;
  params: unknown[];
}

export interface TestDb {
  db: NotificationsDb;
  client: PGlite;
  tables: NotificationTables;
  layout: Layout;
  /** Every statement sent through `db`, in order. Clear it (`length = 0`) before the call under test. */
  queries: LoggedQuery[];
  /** The host's rows, read now (foreign layout), for a before/after comparison. */
  hostRows: () => Promise<unknown[]>;
  close: () => Promise<void>;
}

export async function hostRowsOf(client: PGlite): Promise<unknown[]> {
  const result = await client.query("select id, user_id, read_at, created_at from public.notifications order by id");
  return result.rows;
}

export async function createTestDb(layout: Layout = LAYOUT): Promise<TestDb> {
  const client = new PGlite();
  let tables: NotificationTables = notificationTables;
  let before: unknown[] = [];
  if (layout === "foreign") {
    await client.exec(HOST_TABLE_SQL);
    before = await hostRowsOf(client);
    await client.exec(notificationsSql(FOREIGN_OPTIONS));
    tables = defineNotificationTables(FOREIGN_OPTIONS);
  } else {
    await client.exec(notificationsSql());
  }
  const queries: LoggedQuery[] = [];
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params }) },
  }) as unknown as NotificationsDb;
  return {
    db,
    client,
    tables,
    layout,
    queries,
    hostRows: () => (layout === "foreign" ? hostRowsOf(client) : Promise.resolve([])),
    close: async () => {
      if (layout === "foreign") {
        // The whole suite ran next to the host's own `notifications`: it must
        // be exactly as it was.
        const after = await hostRowsOf(client);
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          await client.close();
          throw new Error(`The host's own notifications table changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
        }
      }
      await client.close();
    },
  };
}

let counter = 0;
/** A fresh company per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
