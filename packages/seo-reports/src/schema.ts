import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * One row per search check — the receipt, not just the grade (0.2: per
 * company).
 *
 * Reports live in the APP's database rather than a third-party dashboard for
 * the same reason the error log does: "how did search engines see us in
 * March" is a question about your own history. The jsonb columns hold the
 * full evidence (every check, every page, every reason), so the screen can
 * show an old report exactly as it was scored.
 *
 * EVERY ROW IS ONE COMPANY'S (`tenant_id`; "*" is the site's own checks).
 * Every read and write in this package names it, and another company's
 * report id is "not found", like one that never existed. Plain text, no
 * foreign key: the package installs without tenancy.
 *
 * A check is written BEFORE it runs ("running"), inside one lock per company
 * with the month's count: two "Check now" presses at once can't both slip
 * under the plan's limit, and a second press while one runs is refused.
 */
export const seoReports = pgTable(
  "seo_reports",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** "running" while it reads, then "done"; "failed" when the check itself broke (not the site). */
    status: text("status").notNull().default("done"),
    /** "manual" (someone pressed Check now) or "schedule" (the weekly job). */
    trigger: text("trigger").notNull().default("manual"),
    /** Who pressed it; null for the weekly job. */
    requestedBy: text("requested_by"),
    /** The first address checked. */
    baseUrl: text("base_url").notNull(),
    /** Every address checked, as "label — address". */
    addresses: jsonb("addresses").$type<string[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    /** 0–100. The mean of the two below — the headline, never the argument. */
    score: integer("score").notNull(),
    /** How a search engine reads the site: titles, summaries, main addresses… */
    seoScore: integer("seo_score").notNull(),
    /** How an AI assistant reads it: llms.txt, structured data, AI crawler access. */
    aeoScore: integer("aeo_score").notNull(),
    pageCount: integer("page_count").notNull(),
    passCount: integer("pass_count").notNull().default(0),
    warnCount: integer("warn_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    /** Why it stopped early ("pages", "time"); null when it read everything it found. */
    stopped: text("stopped"),
    /** What broke, for a failed check (never shown to the owner as is). */
    error: text("error"),
    /** Site-level checks (robots.txt, llms.txt, sitemap, AI crawler rules, broken links). */
    siteChecks: jsonb("site_checks").notNull(),
    /** Per-page results, capped at the crawl limit recorded in each run. */
    pages: jsonb("pages").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("seo_reports_tenant_started_idx").on(t.tenantId, t.startedAt)],
);

export const seoReportsSchema = { seoReports };
