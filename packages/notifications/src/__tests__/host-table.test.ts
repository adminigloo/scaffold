import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotifications } from "../instance.js";
import { notificationsSql, notificationTables } from "../schema.js";
import { notificationsUpgradeSql } from "../sql.js";
import { AlertsUnavailableError, type NotificationsDb } from "../types.js";
import { Directory, REGISTRY } from "./fixtures.js";
import { HOST_TABLE_SQL, hostRowsOf } from "./pglite.js";

/**
 * A host's own `notifications` table (Tenancy 2b-1, 15.1; review G1).
 * Ridgeline has `public.notifications(id, user_id, read_at, created_at)` with
 * rows. Neither script may run over it, and an instance mis-pointed at it
 * (the default tables, which `createNotifications` never assumes) errors on
 * every statement that would change rows, instead of changing the host's.
 */

let client: PGlite;
let db: NotificationsDb;
let before: unknown[];
beforeAll(async () => {
  client = new PGlite();
  await client.exec(HOST_TABLE_SQL);
  before = await hostRowsOf(client);
  db = drizzle(client) as unknown as NotificationsDb;
});
afterAll(async () => {
  await client.close();
});

describe("the shipped SQL refuses to run over it", () => {
  it("notificationsSql() raises the guard's sentence", async () => {
    await expect(client.exec(notificationsSql())).rejects.toThrow(
      "A table named notifications already exists and isn't AdminIgloo's 0.2 table. If it is AdminIgloo's 0.1 table, run sql/upgrade-0.1-to-0.2.sql; otherwise pass a prefix or a schema.",
    );
  });

  it("the 0.1 → 0.2 upgrade raises its own sentence", async () => {
    await expect(client.exec(notificationsUpgradeSql())).rejects.toThrow(
      "The table named notifications isn't AdminIgloo's 0.1 table. Pass a prefix or a schema and run notificationsSql() instead.",
    );
  });

  it("created nothing", async () => {
    const found = (await client.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_name in ('notification_choices', 'notification_routing')`)).rows[0];
    expect(found?.n).toBe(0);
  });
});

describe("an instance mis-pointed at it errors and loses nothing", () => {
  const errors: { step: string }[] = [];
  const alerts = () =>
    createNotifications({
      db,
      tables: notificationTables,
      registry: REGISTRY,
      people: new Directory().people,
      onError: (_error, context) => errors.push({ step: context.step }),
    });
  const reader = { tenantId: "ridgeline", userId: "u-42", permissions: [...REGISTRY.permissions] };

  it("cleanup throws", async () => {
    await expect(alerts().cleanup({ readOlderThanDays: 0, anyOlderThanDays: 0 })).rejects.toThrow();
  });
  it("forget throws", async () => {
    await expect(alerts().forget({ tenantId: "ridgeline", userId: "u-42" })).rejects.toThrow();
  });
  it("markAllRead throws", async () => {
    await expect(alerts().markAllRead(reader)).rejects.toThrow();
  });
  it("deliverPendingEmails throws", async () => {
    await expect(alerts().deliverPendingEmails({ tenantIds: ["ridgeline"] })).rejects.toThrow();
  });
  it("prune never throws (4.3), so its failed statement is reported instead", async () => {
    errors.length = 0;
    // CONTRACT: 15.1(b) lists prune among the calls that "throw"; 4.3 says
    // prune never throws (zeros + onError). Both hold: its statement errors,
    // and the error is reported, not swallowed.
    expect(await alerts().prune({ tenantId: "ridgeline", userId: "u-42", permissions: [] })).toEqual({ alerts: 0, routings: 0 });
    expect(errors.map((e) => e.step)).toContain("prune");
  });
  it("claimEmails answers AlertsUnavailableError (the office falls back to the business address)", async () => {
    await expect(alerts().claimEmails({ tenantId: "ridgeline", kind: "estimator.lead", dedupeKey: "estimator.lead:e1" })).rejects.toBeInstanceOf(
      AlertsUnavailableError,
    );
  });
  it("the host's rows are exactly as they were", async () => {
    expect(await hostRowsOf(client)).toEqual(before);
  });
});

describe("tables are required", () => {
  it("createNotifications without tables doesn't compile, and refuses at run time", () => {
    const directory = new Directory();
    expect(() =>
      // @ts-expect-error tables is REQUIRED (D14, review G1): there is no default that could point at a host's own table.
      createNotifications({ db, registry: REGISTRY, people: directory.people }),
    ).toThrow(/pass tables/);
  });
});
