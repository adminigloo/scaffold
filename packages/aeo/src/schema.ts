import { boolean, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * Answer-engine citation tracking. A query is a real question a customer might
 * ask an assistant; a check records whether a given engine's answer mentioned
 * the brand. `tenantId` is plain text, no cross-package FK.
 */

export const aeoQueries = pgTable(
  "aeo_queries",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    query: text("query").notNull(),
    brand: text("brand").notNull(),
    domain: text("domain"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("aeo_queries_tenant_idx").on(t.tenantId, t.isActive)],
);

export const aeoChecks = pgTable(
  "aeo_checks",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    queryId: text("query_id").notNull(),
    /** Which engine answered: "claude", "gpt", "perplexity". */
    engine: text("engine").notNull(),
    cited: boolean("cited").notNull(),
    matchedOn: text("matched_on"),
    /** The opening of the engine's answer, for evidence — never the whole thing. */
    answerSnippet: text("answer_snippet"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("aeo_checks_query_idx").on(t.queryId, t.checkedAt)],
);
