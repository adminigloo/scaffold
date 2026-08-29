import { bigint, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, logIdColumn } from "@adminigloo/db";

/**
 * How a request ended, mirroring `StreamOutcome`.
 *
 * text, not pgEnum: a value added to a Postgres enum can never be removed, and
 * the day a provider gives us a fourth ending — a refusal, a content filter, a
 * mid-stream model switch — that must be a deploy, not a one-way migration.
 */
export type AiUsageStatus = "completed" | "errored" | "cancelled";

/**
 * One row per authorized AI request, whatever became of it.
 *
 * An append-only log, so `logIdColumn()` (bigserial) rather than a UUID:
 * nothing references these rows, volume is the highest of any table here, and
 * the cost of a UUID per row is paid on every insert and every index page.
 *
 * There is no foreign key to `tenants` or `users`. This is the table you most
 * want intact when a tenant is deleted — it is the record of what they spent —
 * and a cascade would erase the evidence at the moment somebody is trying to
 * reconcile the final invoice.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: logIdColumn(),
    /**
     * Nullable, because not every call belongs to a tenant: internal
     * evaluations, background summarisation, and anything run before a
     * workspace exists. Writing a placeholder tenant would corrupt exactly the
     * per-tenant sums this table exists to produce.
     */
    tenantId: text("tenant_id"),
    /** Nullable for the same reason: scheduled work has no user. */
    userId: text("user_id"),
    /**
     * The model string as the provider named it, e.g. the full dated id.
     *
     * Never a family alias. Prices differ between snapshots of the "same"
     * model, so a row that records only the family cannot be re-priced later,
     * and re-pricing is what you always end up doing after a rate table
     * changes.
     */
    model: text("model").notNull(),
    /**
     * What the call was FOR — "chat", "title", "embed", "summarise". The one
     * dimension no provider reports and the first one anybody asks about when
     * spend jumps: the answer is almost never "chat got more expensive", it is
     * a background job nobody costed.
     */
    operation: text("operation").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /**
     * Cache reads, separate from `input_tokens` because they are priced
     * differently and because their ratio is the only way to tell whether
     * prompt caching is actually working. Folded into input, a caching
     * regression looks like organic growth.
     */
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /**
     * Cost in micros — millionths of a major unit — as an integer.
     *
     * NOT a float, and not `numeric`. A float cost column reconciles against an
     * invoice to the wrong number and nobody can say why: each row is off by
     * less than a cent, the error is invisible per row, and summing a million
     * of them produces a total that is confidently wrong. bigint also survives
     * `SUM()` over a busy month, which a 32-bit column does not.
     *
     * Nullable: a request that failed before the provider reported usage has an
     * unknown cost, and zero is a claim we cannot support.
     */
    costMicros: bigint("cost_micros", { mode: "bigint" }),
    /** Wall time to the end of the stream, including a cancellation. */
    latencyMs: integer("latency_ms"),
    status: text("status").$type<AiUsageStatus>().notNull(),
    /** The failure, when there was one. Null on every other row. */
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * The per-tenant spend query — "this tenant, this billing period" — which
     * runs on every invoice, every quota check and every usage page.
     */
    index("ai_usage_tenant_created_idx").on(t.tenantId, t.createdAt),
    /**
     * The re-pricing query: every row for a model over a window, which is what
     * you scan when a provider changes a rate or when the totals disagree with
     * the bill. Without it that is a sequential scan of the largest table.
     */
    index("ai_usage_model_created_idx").on(t.model, t.createdAt),
  ],
);

export type AiUsageRow = typeof aiUsage.$inferSelect;
export type NewAiUsageRow = typeof aiUsage.$inferInsert;

export const aiSchema = { aiUsage };
