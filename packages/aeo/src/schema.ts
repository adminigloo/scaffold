import { bigint, boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * "AI MENTIONS" (0.2): for the questions a company's customers ask an AI
 * assistant, does the answer name the company? Every row is ONE company's
 * (`tenant_id`, plain text, no cross-package foreign key; "*" is the site's
 * own), and every read and write in this package names it.
 */

/**
 * Who the company is, as an answer would name it: its name, its website,
 * other names it goes by, and the competitors worth noticing in an answer.
 * One row per company (0.2: 0.1 kept these on every question).
 */
export const aeoProfiles = pgTable("aeo_profiles", {
  tenantId: text("tenant_id").primaryKey(),
  brand: text("brand").notNull(),
  domain: text("domain"),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  competitors: jsonb("competitors").$type<string[]>().notNull().default([]),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A question a customer might ask: "wheelchair ramp rental Raleigh". */
export const aeoQueries = pgTable(
  "aeo_queries",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    query: text("query").notNull(),
    /** 0.1 kept who the company is on each question; 0.2 reads aeo_profiles (these stay for 0.1's rows). */
    brand: text("brand"),
    domain: text("domain"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("aeo_queries_tenant_idx").on(t.tenantId, t.isActive)],
);

/**
 * One engine's answer to one question, at one moment — and what CODE found in
 * it: named or not, the company's own site cited or not, the competitors
 * named, the sentence that shows it, the sources. The model only answered.
 */
export const aeoChecks = pgTable(
  "aeo_checks",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    queryId: text("query_id").notNull(),
    /** Which engine answered: "claude" (0.1: also "gpt", "perplexity"). */
    engine: text("engine").notNull(),
    /** The exact model id that answered. */
    model: text("model"),
    /** "done", or "failed" (the engine didn't answer: timed out, refused, broke). */
    status: text("status").notNull().default("done"),
    /** "manual" (Check now) or "schedule" (the weekly job). */
    trigger: text("trigger").notNull().default("manual"),
    /** Named in the words, or its own website among the sources. */
    cited: boolean("cited").notNull(),
    /** Named in the words. */
    mentioned: boolean("mentioned").notNull().default(false),
    /** Its own website among the sources. */
    sourceCited: boolean("source_cited").notNull().default(false),
    matchedOn: text("matched_on"),
    matchedUrl: text("matched_url"),
    /** The answer's words around the mention — or its opening, when it wasn't named. Never the whole answer. */
    answerSnippet: text("answer_snippet"),
    citedUrls: jsonb("cited_urls").$type<string[]>().notNull().default([]),
    competitorsNamed: jsonb("competitors_named").$type<string[]>().notNull().default([]),
    /** What the call cost, in micros (priced in code from the provider's counts, web searches included). */
    costMicros: bigint("cost_micros", { mode: "bigint" }),
    /** Why it failed, in a few words (never shown to the owner as is). */
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("aeo_checks_query_idx").on(t.queryId, t.checkedAt),
    index("aeo_checks_tenant_idx").on(t.tenantId, t.checkedAt),
  ],
);

export const aeoSchema = { aeoProfiles, aeoQueries, aeoChecks };
