import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestDb } from "./pglite.js";

/**
 * The README's "Upgrading from 0.3" SQL, run for real: a database built from
 * 0.3's schema, upgraded with the README's statements, must end up with
 * exactly the 0.4 schema (columns, types, defaults, indexes), and the
 * README's backfill must give each visit the right instants in its business's
 * zone. The SQL is read from the README itself, so the docs can't drift from
 * the package.
 */

/** The 0.3.0 tables, as 0.3's README published them. */
const DDL_0_3 = `CREATE TABLE "scheduling_resources" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "user_id" text,
  "home_base_address" text,
  "home_base_lat" double precision,
  "home_base_lng" double precision,
  "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "work_start_time" text NOT NULL DEFAULT '08:00',
  "work_end_time" text NOT NULL DEFAULT '17:00',
  "max_jobs_per_day" integer NOT NULL DEFAULT 6,
  "hours_configured" boolean NOT NULL DEFAULT false,
  "accepts_public_bookings" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_resources_tenant_idx" ON "scheduling_resources" ("tenant_id", "is_active");

CREATE TABLE "scheduling_availability" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "resource_id" text NOT NULL,
  "day_of_week" integer,
  "specific_date" timestamp with time zone,
  "start_time" text NOT NULL DEFAULT '08:00',
  "end_time" text NOT NULL DEFAULT '17:00',
  "is_available" boolean NOT NULL DEFAULT true,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_availability_resource_idx" ON "scheduling_availability" ("resource_id");

CREATE TABLE "scheduling_bookings" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "resource_id" text,
  "service_type" text NOT NULL DEFAULT 'visit',
  "title" text,
  "customer_name" text,
  "customer_email" text,
  "customer_phone" text,
  "address" text,
  "lat" double precision,
  "lng" double precision,
  "scheduled_date" timestamp with time zone NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "duration_minutes" integer NOT NULL DEFAULT 120,
  "status" text NOT NULL DEFAULT 'pending',
  "estimate_id" text,
  "notes" text,
  "requester_key" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_bookings_tenant_date_idx" ON "scheduling_bookings" ("tenant_id", "scheduled_date");
CREATE INDEX "scheduling_bookings_resource_date_idx" ON "scheduling_bookings" ("resource_id", "scheduled_date");

CREATE TABLE "scheduling_drive_cache" (
  "id" text PRIMARY KEY,
  "origin_lat" double precision NOT NULL,
  "origin_lng" double precision NOT NULL,
  "dest_lat" double precision NOT NULL,
  "dest_lng" double precision NOT NULL,
  "duration_minutes" integer NOT NULL,
  "distance_miles" double precision NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "scheduling_drive_cache_key_idx" ON "scheduling_drive_cache" ("origin_lat", "origin_lng", "dest_lat", "dest_lng");
`;

const README = fileURLToPath(new URL("../../README.md", import.meta.url));

it("the README's 0.3 → 0.4 SQL upgrades a 0.3 database to the 0.4 schema and backfills it", async () => {
  const readme = readFileSync(README, "utf8").replace(/\r\n/g, "\n");
  const section = readme.slice(readme.indexOf("## Upgrading from 0.3"), readme.indexOf("## Upgrading from 0.2"));
  const blocks = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!.replace(/^ {3}/gm, ""));
  expect(blocks).toHaveLength(2);

  const pg = new PGlite();
  await pg.exec(DDL_0_3);
  await pg.exec(blocks[0]!);
  // A Denver business with a 0.3 visit and a 0.3 public request.
  await pg.exec(`insert into scheduling_settings (id, tenant_id, time_zone) values ('s1', 'acme', 'America/Denver')`);
  await pg.exec(`insert into scheduling_bookings (id, tenant_id, scheduled_date, start_time, end_time, status)
                 values ('v1', 'acme', '2026-11-02T00:00:00Z', '09:00', '24:00', 'confirmed')`);
  await pg.exec(`insert into scheduling_bookings (id, tenant_id, scheduled_date, start_time, end_time, status, requester_key, created_at)
                 values ('v2', 'acme', '2026-11-03T00:00:00Z', '10:00', '11:00', 'pending', 'ip:1', '2026-11-02T12:00:00Z')`);
  await pg.exec(`insert into scheduling_bookings (id, tenant_id, scheduled_date, start_time, end_time, status)
                 values ('v3', 'other', '2026-11-03T00:00:00Z', '10:00', '11:00', 'confirmed')`);
  await pg.exec(blocks[1]!);
  const rows = (await pg.query<Record<string, unknown>>(`select id, starts_at, ends_at, origin, pending_expires_at from scheduling_bookings order by id`)).rows;
  expect(rows.map((r) => [r.id, (r.starts_at as Date).toISOString(), (r.ends_at as Date).toISOString(), r.origin, (r.pending_expires_at as Date | null)?.toISOString() ?? null])).toEqual([
    ["v1", "2026-11-02T16:00:00.000Z", "2026-11-03T07:00:00.000Z", "staff", null],
    ["v2", "2026-11-03T17:00:00.000Z", "2026-11-03T18:00:00.000Z", "public", "2026-11-03T17:00:00.000Z"],
    ["v3", "2026-11-03T10:00:00.000Z", "2026-11-03T11:00:00.000Z", "staff", null],
  ]);

  // The upgraded schema is the 0.4 schema: the same columns, types, defaults and indexes.
  const fresh = await createTestDb();
  const shape = async (db: PGlite) => ({
    columns: (
      await db.query(
        `select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' order by table_name, column_name`,
      )
    ).rows,
    indexes: (await db.query(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and indexname not like '%_pkey' order by indexname`)).rows,
  });
  expect(await shape(pg)).toEqual(await shape(fresh.client));
  await pg.close();
  await fresh.close();
});
