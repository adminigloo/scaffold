import { bigserial, boolean, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
 * be linked back to anyone, by anyone, including the site owner.
 *
 * High-volume rows use bigserial ids; sessions use uuidv7 so rows can point at one.
 */

export const analyticsSessions = pgTable(
  "analytics_sessions",
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
  },
  (table) => [
    index("analytics_sessions_tenant_started_idx").on(table.tenantId, table.startedAt),
    index("analytics_sessions_tenant_visitor_idx").on(table.tenantId, table.visitorKey, table.lastSeenAt),
    index("analytics_sessions_tenant_doc_idx").on(table.tenantId, table.lastDocId),
    index("analytics_sessions_tenant_source_idx").on(table.tenantId, table.sourceBucket, table.startedAt),
    // The retention purge runs across tenants by age.
    index("analytics_sessions_started_idx").on(table.startedAt),
  ],
);

export const analyticsPageViews = pgTable(
  "analytics_page_views",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
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
    index("analytics_page_views_tenant_time_idx").on(table.tenantId, table.occurredAt),
    index("analytics_page_views_session_idx").on(table.sessionId),
    index("analytics_page_views_tenant_path_idx").on(table.tenantId, table.path, table.occurredAt),
  ],
);

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
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
    index("analytics_events_tenant_name_time_idx").on(table.tenantId, table.name, table.occurredAt),
    index("analytics_events_session_idx").on(table.sessionId),
  ],
);

/**
 * Requests from crawlers, logged server-side from the request's own
 * User-Agent — they never run the beacon. No cookies, no IP stored. One row
 * per (bot, path, 10-minute bucket) with a hit counter, so a flood of forged
 * "GPTBot" requests cannot grow the table or the public numbers without bound.
 * `verified`: the request IP was in the operator's published ranges.
 */
export const analyticsCrawlerHits = pgTable(
  "analytics_crawler_hits",
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
    uniqueIndex("analytics_crawler_hits_bucket_idx").on(table.tenantId, table.botName, table.path, table.bucketStart, table.verified),
    index("analytics_crawler_hits_tenant_time_idx").on(table.tenantId, table.bucketStart),
    index("analytics_crawler_hits_bucket_time_idx").on(table.bucketStart),
  ],
);

/**
 * One random salt per day, shared by every server instance (so a visitor is
 * one visitor wherever their requests land) and deleted the day after next —
 * the moment a stored key becomes unlinkable for good.
 */
export const analyticsSalts = pgTable("analytics_salts", {
  day: text("day").primaryKey(),
  salt: text("salt").notNull(),
  createdAt: createdAt(),
});

/**
 * The ingest's own throttle, in Postgres so it holds across instances with no
 * Redis: hourly counters per network key (an HMAC of the IP under the day's
 * salt). Emptied by the daily maintenance.
 */
export const analyticsRate = pgTable(
  "analytics_rate",
  {
    tenantId: text("tenant_id").notNull(),
    netKey: text("net_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    sessions: integer("sessions").notNull().default(0),
    hits: integer("hits").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.netKey, table.windowStart] })],
);

/** Per-tenant facts that outlive the retention window — when tracking began. */
export const analyticsSites = pgTable("analytics_sites", {
  tenantId: text("tenant_id").primaryKey(),
  trackingSince: timestamp("tracking_since", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Notes pinned to a date — a deploy, a launch, a campaign — drawn on the trend
 * chart so a spike has its reason next to it.
 */
export const analyticsAnnotations = pgTable(
  "analytics_annotations",
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
  (table) => [index("analytics_annotations_tenant_day_idx").on(table.tenantId, table.day)],
);
