import {
  bigserial,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * First-party traffic analytics, in the app's own database. Every table is
 * tenant-scoped (plain text tenant_id, no FK — the tenants table lives in
 * @adminigloo/tenancy and an install may not have it).
 *
 * WHAT IS NEVER STORED: an IP address, a User-Agent string, a cookie or device
 * id, a referrer path or query, a URL query string, a capability token in a
 * path (normalizePath redacts them), or an email/phone/token-shaped label or
 * UTM value (scrubbed at ingest). The visitor key is an HMAC under a random
 * salt that exists for one day and is then deleted — after which no key can
 * be linked back to anyone, by anyone, including the site owner. The one
 * exception is `actor_key`, written only when the app's `onSession` hook
 * returns one (see its column note).
 *
 * High-volume rows use bigserial ids; sessions use uuidv7 so rows can point at one.
 *
 * TABLE NAMES come from a prefix (`defineAnalyticsTables({ prefix })`). The
 * default, `analytics_`, reproduces 0.1's names EXACTLY — every table, index,
 * primary-key and foreign-key name — so an app that migrated 0.1 sees only
 * the three new nullable session columns when it regenerates. A snapshot test
 * pins every one of those names. Another prefix (`aig_analytics_` for an app
 * that already has an `analytics_sessions` of its own) gives a second,
 * independent set that can live in the same database.
 */

/** The 0.1 names. */
export const DEFAULT_ANALYTICS_PREFIX = "analytics_";

/** Postgres truncates identifiers past 63 bytes, which makes drizzle-kit see a rename on every push. */
const PG_MAX_IDENTIFIER = 63;

export interface DefineAnalyticsTablesOptions {
  /**
   * Default `"analytics_"` (the 0.1 names). Lower-case letters, digits and
   * underscores, at most 32 characters; end it with `_`.
   */
  prefix?: string;
}

/**
 * The analytics tables under `prefix`. Every name is built from it; where
 * Drizzle's own derived name (a foreign key's `<table>_<col>_<table>_<col>_fk`)
 * would pass Postgres' 63-character limit under a long prefix, a shorter
 * `<prefix><table>_<what>_fk` is used instead — never for the default prefix.
 */
export function defineAnalyticsTables(options: DefineAnalyticsTablesOptions = {}) {
  const prefix = options.prefix ?? DEFAULT_ANALYTICS_PREFIX;
  if (typeof prefix !== "string" || !/^[a-z_][a-z0-9_]*$/.test(prefix) || prefix.length > 32) {
    throw new Error(
      `@adminigloo/analytics: table prefix must be lower-case letters, digits and underscores, at most 32 characters (got ${JSON.stringify(prefix)}).`,
    );
  }
  const name = (suffix: string) => `${prefix}${suffix}`;
  /** Drizzle's own derived name when it fits, else the short one. */
  const fitted = (derived: string, short: string) => (derived.length <= PG_MAX_IDENTIFIER ? derived : short);

  const sessions = pgTable(
    name("sessions"),
    {
      id: idColumn(),
      tenantId: text("tenant_id").notNull(),
      /** HMAC(daily salt, ip ‖ ua ‖ tenant), 32 hex. Unlinkable once that day's salt is purged. */
      visitorKey: text("visitor_key").notNull(),
      /**
       * The beacon's per-document id — held only in a JS variable, never stored
       * on the device. Resolving by it first keeps a visit whole across the salt
       * rollover and IP changes (Wi-Fi to cellular) inside one document.
       */
      lastDocId: text("last_doc_id"),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
      /** Last page view, event or leave; a session ends after 30 minutes without one. */
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
      landingPath: text("landing_path").notNull(),
      /** Host only (`google.com`, `android-app:com.linkedin.android`), null for direct or self. */
      referrerHost: text("referrer_host"),
      utmSource: text("utm_source"),
      utmMedium: text("utm_medium"),
      utmCampaign: text("utm_campaign"),
      utmContent: text("utm_content"),
      utmTerm: text("utm_term"),
      /** Which ad click id the landing URL carried (`gclid`) — never its value. */
      clickIdKind: text("click_id_kind"),
      /** First-touch bucket: offline | paid | email | aiAssistant | organic | social | referral | direct. */
      sourceBucket: text("source_bucket").notNull(),
      country: text("country"),
      device: text("device"),
      browser: text("browser"),
      os: text("os"),
      pageViewCount: integer("page_view_count").notNull().default(0),
      /** Interaction events — clicks, outbound links, conversions; web vitals are not counted. */
      eventCount: integer("event_count").notNull().default(0),
      /** Foreground time only, summed from the beacon's visible-time deltas (GA4's engagement time). */
      durationMs: integer("duration_ms").notNull().default(0),
      isEngaged: boolean("is_engaged").notNull().default(false),
      converted: boolean("converted").notNull().default(false),
      // ---- 0.2: additive and nullable, so a 0.1 table takes them with three ALTERs.
      /**
       * What the app's `onSession` hook said about this visit at intake (the
       * reason `audience.observe` returned: "role", "automation", …); the first
       * non-null answer wins. A RECORD, never a filter: what counts is decided
       * by the audience marks at read time, so a mark cleared later (a customer
       * restored) counts this session again even though this column still says
       * why it was once left out.
       */
      internalReason: text("internal_reason"),
      /**
       * A pseudonymous key for the signed-in person behind the visit — written
       * ONLY when the app's `onSession` hook returns one (e.g. the audience's
       * `userKey(userId)`, an HMAC). The package never derives it and no 0.2
       * report reads it. Setting it makes a person's signed-in visits linkable
       * for as long as sessions are kept: leave it unset to stay fully
       * cookieless.
       */
      actorKey: text("actor_key"),
      /**
       * Which source classifier wrote `source_bucket` (`SOURCE_CLASSIFIER_VERSION`).
       * Null: a 0.1 row. `reclassifySources` re-runs the classifier over rows
       * below the current version.
       */
      classifierVersion: integer("classifier_version"),
    },
    (table) => [
      index(name("sessions_tenant_started_idx")).on(table.tenantId, table.startedAt),
      index(name("sessions_tenant_visitor_idx")).on(table.tenantId, table.visitorKey, table.lastSeenAt),
      index(name("sessions_tenant_doc_idx")).on(table.tenantId, table.lastDocId),
      index(name("sessions_tenant_source_idx")).on(table.tenantId, table.sourceBucket, table.startedAt),
      // The retention purge runs across tenants by age.
      index(name("sessions_started_idx")).on(table.startedAt),
    ],
  );

  const pageViews = pgTable(
    name("page_views"),
    {
      id: bigserial("id", { mode: "number" }).primaryKey(),
      sessionId: text("session_id").notNull(),
      tenantId: text("tenant_id").notNull(),
      path: text("path").notNull(),
      /** A content dimension read from the path by the app's rules (`feature` / `feedback`). */
      contentType: text("content_type"),
      contentKey: text("content_key"),
      /** 1 for the landing page, 2 for the next… */
      sequence: integer("sequence").notNull().default(1),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: fitted(`${name("page_views")}_session_id_${name("sessions")}_id_fk`, name("page_views_session_fk")),
        columns: [table.sessionId],
        foreignColumns: [sessions.id],
      }).onDelete("cascade"),
      index(name("page_views_tenant_time_idx")).on(table.tenantId, table.occurredAt),
      index(name("page_views_session_idx")).on(table.sessionId),
      index(name("page_views_tenant_path_idx")).on(table.tenantId, table.path, table.occurredAt),
    ],
  );

  const events = pgTable(
    name("events"),
    {
      id: bigserial("id", { mode: "number" }).primaryKey(),
      sessionId: text("session_id").notNull(),
      tenantId: text("tenant_id").notNull(),
      /** `click`, `outbound`, `web_vital`, `conversion`, or an app's own name. */
      name: text("name").notNull(),
      path: text("path").notNull(),
      /** What was clicked (a `data-track` label, or a button's own words on public pages), the outbound host, or the vital (LCP/INP/CLS). */
      label: text("label"),
      value: doublePrecision("value"),
      /**
       * web-vitals' per-page-load metric id. CLS and INP report more than once
       * per load (every time the page is hidden); p75 takes the max per id so
       * one load is one sample.
       */
      metricId: text("metric_id"),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      foreignKey({
        name: fitted(`${name("events")}_session_id_${name("sessions")}_id_fk`, name("events_session_fk")),
        columns: [table.sessionId],
        foreignColumns: [sessions.id],
      }).onDelete("cascade"),
      index(name("events_tenant_name_time_idx")).on(table.tenantId, table.name, table.occurredAt),
      index(name("events_session_idx")).on(table.sessionId),
    ],
  );

  /**
   * Requests from crawlers, logged server-side from the request's own
   * User-Agent — they never run the beacon. No cookies, no IP stored. One row
   * per (bot, path, 10-minute bucket) with a hit counter, so a flood of forged
   * "GPTBot" requests cannot grow the table or the public numbers without bound.
   * `verified`: the request IP was in the operator's published ranges.
   */
  const crawlerHits = pgTable(
    name("crawler_hits"),
    {
      id: bigserial("id", { mode: "number" }).primaryKey(),
      tenantId: text("tenant_id").notNull(),
      botName: text("bot_name").notNull(),
      /** ai-assistant | ai-search | ai-training | search | social | seo-tool | other */
      botKind: text("bot_kind").notNull(),
      operator: text("operator"),
      path: text("path").notNull(),
      country: text("country"),
      verified: boolean("verified").notNull().default(false),
      bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
      hits: integer("hits").notNull().default(1),
      lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex(name("crawler_hits_bucket_idx")).on(table.tenantId, table.botName, table.path, table.bucketStart, table.verified),
      index(name("crawler_hits_tenant_time_idx")).on(table.tenantId, table.bucketStart),
      index(name("crawler_hits_bucket_time_idx")).on(table.bucketStart),
    ],
  );

  /**
   * One random salt per day, shared by every server instance (so a visitor is
   * one visitor wherever their requests land) and deleted the day after next —
   * the moment a stored key becomes unlinkable for good.
   */
  const salts = pgTable(name("salts"), {
    day: text("day").primaryKey(),
    salt: text("salt").notNull(),
    createdAt: createdAt(),
  });

  /**
   * The ingest's own throttle, in Postgres so it holds across instances with no
   * Redis: hourly counters per network key (an HMAC of the IP under the day's
   * salt). Emptied by the daily maintenance.
   */
  const rate = pgTable(
    name("rate"),
    {
      tenantId: text("tenant_id").notNull(),
      netKey: text("net_key").notNull(),
      windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
      sessions: integer("sessions").notNull().default(0),
      hits: integer("hits").notNull().default(0),
    },
    (table) => [
      primaryKey({
        name: fitted(`${name("rate")}_tenant_id_net_key_window_start_pk`, name("rate_pk")),
        columns: [table.tenantId, table.netKey, table.windowStart],
      }),
    ],
  );

  /** Per-tenant facts that outlive the retention window — when tracking began. */
  const sites = pgTable(name("sites"), {
    tenantId: text("tenant_id").primaryKey(),
    trackingSince: timestamp("tracking_since", { withTimezone: true }).notNull().defaultNow(),
  });

  /**
   * Notes pinned to a date — a deploy, a launch, a campaign — drawn on the trend
   * chart so a spike has its reason next to it.
   */
  const annotations = pgTable(
    name("annotations"),
    {
      id: idColumn(),
      tenantId: text("tenant_id").notNull(),
      /** YYYY-MM-DD in the report zone. */
      day: text("day").notNull(),
      label: text("label").notNull(),
      /** deploy | content | campaign | note */
      kind: text("kind").notNull().default("note"),
      createdBy: text("created_by"),
      createdAt: createdAt(),
    },
    (table) => [index(name("annotations_tenant_day_idx")).on(table.tenantId, table.day)],
  );

  return { prefix, sessions, pageViews, events, crawlerHits, salts, rate, sites, annotations };
}

export type AnalyticsTables = ReturnType<typeof defineAnalyticsTables>;

/** The default set — the 0.1 names. Spread the named exports below into your Drizzle schema. */
export const analyticsTables: AnalyticsTables = defineAnalyticsTables();

export const analyticsSessions = analyticsTables.sessions;
export const analyticsPageViews = analyticsTables.pageViews;
export const analyticsEvents = analyticsTables.events;
export const analyticsCrawlerHits = analyticsTables.crawlerHits;
export const analyticsSalts = analyticsTables.salts;
export const analyticsRate = analyticsTables.rate;
export const analyticsSites = analyticsTables.sites;
export const analyticsAnnotations = analyticsTables.annotations;
