import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * One row per audit run — the receipt, not just the grade.
 *
 * Reports live in the APP's database rather than a third-party dashboard for
 * the same reason the error log does: "how did search engines see us in
 * March" is a question about your own history, and history rented from a
 * vendor disappears with the subscription. The jsonb columns hold the full
 * evidence (every check, every page, every reason), so the admin page can
 * re-render an old report exactly as it was scored — re-crawling the past is
 * not a thing.
 *
 * No tenant column: an audit is of THIS deployment's own site. The moment
 * this is sold as a hosted service auditing client sites, tenant scoping
 * arrives with that schema change — not speculatively before it.
 */
export const seoReports = pgTable("seo_reports", {
  id: idColumn(),
  /** The origin that was crawled, as configured at run time. */
  baseUrl: text("base_url").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  /** 0–100. The mean of the two below — the headline, never the argument. */
  score: integer("score").notNull(),
  /** How a search engine reads the site: titles, descriptions, canonicals… */
  seoScore: integer("seo_score").notNull(),
  /** How an answer engine reads it: llms.txt, structured data, AI crawler access. */
  aeoScore: integer("aeo_score").notNull(),
  pageCount: integer("page_count").notNull(),
  /** Site-level checks (robots.txt, llms.txt, sitemap, AI crawler rules). */
  siteChecks: jsonb("site_checks").notNull(),
  /** Per-page results, capped at the crawl limit recorded in each run. */
  pages: jsonb("pages").notNull(),
  createdAt: createdAt(),
});
