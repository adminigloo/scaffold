import { describe, expect, it } from "vitest";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import * as schemaModule from "../schema.js";
import { analyticsTables, defineAnalyticsTables, type AnalyticsTables } from "../schema.js";

/**
 * THE MIGRATION CONTRACT. The founder's site created the 0.1 tables with
 * migration 0025 (drizzle/0025_sad_prism.sql). The default prefix must
 * reproduce every name in it — table, column, type, default, primary key,
 * foreign key (with ON DELETE / ON UPDATE) and index — or drizzle-kit would
 * generate drops and re-creates on upgrade. The expectation below is 0025,
 * transcribed; the only difference 0.2 may add is the three nullable session
 * columns at the end.
 */

const dialect = new PgDialect();
const show = (value: unknown) => (is(value, SQL) ? dialect.sqlToQuery(value).sql : typeof value === "string" ? `'${value}'` : String(value));

function describeTable(table: PgTable) {
  const config = getTableConfig(table);
  return {
    name: config.name,
    columns: config.columns.map(
      (c) =>
        `${c.name} ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}${c.notNull && !c.primary ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${show(c.default)}` : ""}`,
    ),
    primaryKeys: config.primaryKeys.map((pk) => `${pk.getName()} (${pk.columns.map((c) => c.name).join(", ")})`),
    foreignKeys: config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return `${fk.getName()} (${ref.columns.map((c) => c.name).join(", ")}) -> ${getTableConfig(ref.foreignTable).name} (${ref.foreignColumns.map((c) => c.name).join(", ")}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
    }),
    indexes: config.indexes.map(
      (index) =>
        `${index.config.unique ? "UNIQUE " : ""}${index.config.name} (${index.config.columns.map((c) => (is(c, SQL) ? show(c) : (c as { name: string }).name)).join(", ")})${index.config.where ? ` WHERE ${show(index.config.where)}` : ""}`,
    ),
  };
}

const TABLE_KEYS = ["annotations", "crawlerHits", "events", "pageViews", "rate", "salts", "sessions", "sites"] as const;

function describeAll(tables: AnalyticsTables) {
  return TABLE_KEYS.map((key) => describeTable(tables[key]));
}

/** Every name the set puts in the database: tables, primary keys, foreign keys, indexes. */
function allNames(tables: AnalyticsTables): string[] {
  return TABLE_KEYS.flatMap((key) => {
    const config = getTableConfig(tables[key]);
    return [
      config.name,
      ...config.primaryKeys.map((pk) => pk.getName()),
      ...config.foreignKeys.map((fk) => fk.getName()),
      ...config.indexes.map((index) => index.config.name as string),
    ];
  });
}

const TS = "timestamp with time zone";

/** drizzle/0025_sad_prism.sql, transcribed — plus 0.2's three additive, nullable session columns, marked. */
const MIGRATION_0025_PLUS_0_2 = [
  {
    name: "analytics_annotations",
    columns: [
      "id text PRIMARY KEY",
      "tenant_id text NOT NULL",
      "day text NOT NULL",
      "label text NOT NULL",
      "kind text NOT NULL DEFAULT 'note'",
      "created_by text",
      `created_at ${TS} NOT NULL DEFAULT now()`,
    ],
    primaryKeys: [],
    foreignKeys: [],
    indexes: ["analytics_annotations_tenant_day_idx (tenant_id, day)"],
  },
  {
    name: "analytics_crawler_hits",
    columns: [
      "id bigserial PRIMARY KEY",
      "tenant_id text NOT NULL",
      "bot_name text NOT NULL",
      "bot_kind text NOT NULL",
      "operator text",
      "path text NOT NULL",
      "country text",
      "verified boolean NOT NULL DEFAULT false",
      `bucket_start ${TS} NOT NULL`,
      "hits integer NOT NULL DEFAULT 1",
      `last_at ${TS} NOT NULL DEFAULT now()`,
    ],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [
      "UNIQUE analytics_crawler_hits_bucket_idx (tenant_id, bot_name, path, bucket_start, verified)",
      "analytics_crawler_hits_tenant_time_idx (tenant_id, bucket_start)",
      "analytics_crawler_hits_bucket_time_idx (bucket_start)",
    ],
  },
  {
    name: "analytics_events",
    columns: [
      "id bigserial PRIMARY KEY",
      "session_id text NOT NULL",
      "tenant_id text NOT NULL",
      "name text NOT NULL",
      "path text NOT NULL",
      "label text",
      "value double precision",
      "metric_id text",
      `occurred_at ${TS} NOT NULL DEFAULT now()`,
    ],
    primaryKeys: [],
    foreignKeys: ["analytics_events_session_id_analytics_sessions_id_fk (session_id) -> analytics_sessions (id) ON DELETE cascade ON UPDATE no action"],
    indexes: ["analytics_events_tenant_name_time_idx (tenant_id, name, occurred_at)", "analytics_events_session_idx (session_id)"],
  },
  {
    name: "analytics_page_views",
    columns: [
      "id bigserial PRIMARY KEY",
      "session_id text NOT NULL",
      "tenant_id text NOT NULL",
      "path text NOT NULL",
      "content_type text",
      "content_key text",
      "sequence integer NOT NULL DEFAULT 1",
      `occurred_at ${TS} NOT NULL DEFAULT now()`,
    ],
    primaryKeys: [],
    foreignKeys: ["analytics_page_views_session_id_analytics_sessions_id_fk (session_id) -> analytics_sessions (id) ON DELETE cascade ON UPDATE no action"],
    indexes: [
      "analytics_page_views_tenant_time_idx (tenant_id, occurred_at)",
      "analytics_page_views_session_idx (session_id)",
      "analytics_page_views_tenant_path_idx (tenant_id, path, occurred_at)",
    ],
  },
  {
    name: "analytics_rate",
    columns: ["tenant_id text NOT NULL", "net_key text NOT NULL", `window_start ${TS} NOT NULL`, "sessions integer NOT NULL DEFAULT 0", "hits integer NOT NULL DEFAULT 0"],
    primaryKeys: ["analytics_rate_tenant_id_net_key_window_start_pk (tenant_id, net_key, window_start)"],
    foreignKeys: [],
    indexes: [],
  },
  {
    name: "analytics_salts",
    columns: ["day text PRIMARY KEY", "salt text NOT NULL", `created_at ${TS} NOT NULL DEFAULT now()`],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [],
  },
  {
    name: "analytics_sessions",
    columns: [
      "id text PRIMARY KEY",
      "tenant_id text NOT NULL",
      "visitor_key text NOT NULL",
      "last_doc_id text",
      `started_at ${TS} NOT NULL DEFAULT now()`,
      `last_seen_at ${TS} NOT NULL DEFAULT now()`,
      "landing_path text NOT NULL",
      "referrer_host text",
      "utm_source text",
      "utm_medium text",
      "utm_campaign text",
      "utm_content text",
      "utm_term text",
      "click_id_kind text",
      "source_bucket text NOT NULL",
      "country text",
      "device text",
      "browser text",
      "os text",
      "page_view_count integer NOT NULL DEFAULT 0",
      "event_count integer NOT NULL DEFAULT 0",
      "duration_ms integer NOT NULL DEFAULT 0",
      "is_engaged boolean NOT NULL DEFAULT false",
      "converted boolean NOT NULL DEFAULT false",
      // ---- 0.2, additive and nullable (three ALTER TABLE … ADD COLUMN):
      "internal_reason text",
      "actor_key text",
      "classifier_version integer",
    ],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [
      "analytics_sessions_tenant_started_idx (tenant_id, started_at)",
      "analytics_sessions_tenant_visitor_idx (tenant_id, visitor_key, last_seen_at)",
      "analytics_sessions_tenant_doc_idx (tenant_id, last_doc_id)",
      "analytics_sessions_tenant_source_idx (tenant_id, source_bucket, started_at)",
      "analytics_sessions_started_idx (started_at)",
    ],
  },
  {
    name: "analytics_sites",
    columns: ["tenant_id text PRIMARY KEY", `tracking_since ${TS} NOT NULL DEFAULT now()`],
    primaryKeys: [],
    foreignKeys: [],
    indexes: [],
  },
];

describe("the default prefix reproduces 0.1's migration exactly", () => {
  it("every table, column, default, key and index name matches 0025 (plus 0.2's three nullable columns)", () => {
    expect(describeAll(analyticsTables)).toEqual(MIGRATION_0025_PLUS_0_2);
    expect(describeAll(defineAnalyticsTables())).toEqual(MIGRATION_0025_PLUS_0_2);
    expect(describeAll(defineAnalyticsTables({ prefix: "analytics_" }))).toEqual(MIGRATION_0025_PLUS_0_2);
  });

  it("the 0.2 columns are nullable with no default, so the upgrade is three ADD COLUMNs and touches no row", () => {
    const columns = getTableConfig(analyticsTables.sessions).columns.filter((c) => ["internal_reason", "actor_key", "classifier_version"].includes(c.name));
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.notNull).toBe(false);
      expect(column.default).toBeUndefined();
    }
  });

  it("keeps the 0.1 named exports, pointing at the default set", () => {
    expect(schemaModule.analyticsSessions).toBe(analyticsTables.sessions);
    expect(schemaModule.analyticsPageViews).toBe(analyticsTables.pageViews);
    expect(schemaModule.analyticsEvents).toBe(analyticsTables.events);
    expect(schemaModule.analyticsCrawlerHits).toBe(analyticsTables.crawlerHits);
    expect(schemaModule.analyticsSalts).toBe(analyticsTables.salts);
    expect(schemaModule.analyticsRate).toBe(analyticsTables.rate);
    expect(schemaModule.analyticsSites).toBe(analyticsTables.sites);
    expect(schemaModule.analyticsAnnotations).toBe(analyticsTables.annotations);
    // A drizzle-kit schema spread with `export * from "@adminigloo/analytics/schema"`
    // sees exactly the eight tables: the set object and the factory are not tables.
    const tableExports = Object.entries(schemaModule).filter(([, value]) => {
      try {
        getTableConfig(value as PgTable);
        return typeof getTableConfig(value as PgTable).name === "string";
      } catch {
        return false;
      }
    });
    expect(tableExports.map(([key]) => key).sort()).toEqual([
      "analyticsAnnotations",
      "analyticsCrawlerHits",
      "analyticsEvents",
      "analyticsPageViews",
      "analyticsRate",
      "analyticsSalts",
      "analyticsSessions",
      "analyticsSites",
    ]);
  });
});

describe("another prefix", () => {
  it("renames every table, index and constraint, all within Postgres' 63-character limit", () => {
    const riddler = defineAnalyticsTables({ prefix: "aig_analytics_" });
    const names = allNames(riddler);
    expect(names).toHaveLength(allNames(analyticsTables).length);
    for (const name of names) {
      expect(name.startsWith("aig_analytics_")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(63);
    }
    // Disjoint from the default set: both can live in one database.
    const defaults = new Set(allNames(analyticsTables));
    expect(names.filter((name) => defaults.has(name))).toEqual([]);
    // Drizzle's derived FK name would be 64 characters here; the short form stands in.
    expect(getTableConfig(riddler.pageViews).foreignKeys[0]!.getName()).toBe("aig_analytics_page_views_session_fk");
    expect(getTableConfig(riddler.events).foreignKeys[0]!.getName()).toBe("aig_analytics_events_session_id_aig_analytics_sessions_id_fk");
    expect(getTableConfig(riddler.crawlerHits).name).toBe("aig_analytics_crawler_hits");
  });

  it("refuses a prefix that is not a plain identifier", () => {
    expect(() => defineAnalyticsTables({ prefix: "Analytics_" })).toThrow(/prefix/);
    expect(() => defineAnalyticsTables({ prefix: "a-b_" })).toThrow(/prefix/);
    expect(() => defineAnalyticsTables({ prefix: 'x"; drop table y; --' })).toThrow(/prefix/);
    expect(() => defineAnalyticsTables({ prefix: "a".repeat(33) })).toThrow(/prefix/);
  });
});
