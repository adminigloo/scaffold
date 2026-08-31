import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  costMinorUnits,
  estimateCostMicros,
  isAiConfigured,
  type StreamUsage,
  type TokenRate,
} from "__SCOPE__/ai";
import { aiUsage } from "__SCOPE__/ai/schema";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { env } from "@/env";
import { log } from "./logger";

/**
 * Everything about calling a model that is not the route's own control flow.
 *
 * Kept beside the route rather than inside it because three of these are things
 * a client edits on their first afternoon — which model, what it costs, how
 * much one answer may run to — and one of them is a thing nobody should edit
 * casually: the rate table is what the invoice gets reconciled against.
 */

/**
 * The model this project calls, as the provider names it.
 *
 * AN EXACT ID, NEVER A FAMILY ALIAS, for the same reason `ai_usage` stores the
 * exact one: prices differ between snapshots of the "same" model, so a row
 * recording only the family cannot be re-priced later — and re-pricing is what
 * you always end up doing the week after a rate changes.
 *
 * Change this and `MODEL_RATES` in the same commit. Changing one alone produces
 * rows with a null cost, and a spend dashboard that is quietly missing a model
 * looks exactly like a quiet month.
 */
export const AI_MODEL = "claude-opus-5";

/**
 * What each model costs, in micros per MILLION tokens.
 *
 * Owned by this application and never by the package: a price compiled into a
 * library is wrong the week after it ships, and the way you find out is a
 * reconciliation meeting where our number and the invoice differ by a rounding
 * error nobody can attribute. `estimateCostMicros` is handed the row for the
 * model that was actually called.
 *
 * Cache reads are priced at a tenth of fresh input, which is the published
 * ratio. Leaving the field out would fall back to the FULL input rate rather
 * than to zero — deliberate, because "unpriced therefore free" turns every
 * cached token into silent under-reporting that only surfaces at the invoice,
 * whereas over-reporting shows up in the dashboard the same day.
 *
 * A model absent from this table is priced as UNKNOWN, not as zero. The usage
 * row is still written, with a null cost. See `recordAiUsage`.
 */
export const MODEL_RATES: Readonly<Record<string, TokenRate>> = {
  // $5.00 in, $25.00 out, per million tokens.
  "claude-opus-5": {
    inputMicrosPerMTok: 5_000_000,
    outputMicrosPerMTok: 25_000_000,
    cachedInputMicrosPerMTok: 500_000,
  },
};

/**
 * The per-request output ceiling.
 *
 * THIS NUMBER TIMES THE DAILY REQUEST LIMIT IS THE WORST-CASE BILL, and that
 * multiplication is the only honest way to describe an AI budget. At $25 per
 * million output tokens 16,000 tokens is forty cents; `RATE_LIMIT_POLICIES.aiDaily`
 * allows 200 requests per person per day; so one determined account can spend
 * about eighty dollars a day and not more. A limiter without a ceiling bounds
 * the number of requests and nothing about their size.
 *
 * It bounds thinking AND response text together, so a ceiling sized to the
 * answer alone truncates the reply on a model that thinks before it writes.
 */
export const AI_MAX_TOKENS = 16_000;

/**
 * The provider client, or null when this deployment has no key.
 *
 * Null is a real state rather than a failure. `aiServer()` declares every
 * provider key optional precisely so that a preview branch, a CI run and a
 * laptop working on billing all boot without paying for inference; the route
 * answers 503 and names the configured providers instead of throwing.
 */
export const anthropic: Anthropic | null = isAiConfigured(env)
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

/** What the route managed to learn from the provider, if it got that far. */
export interface ModelSpend {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /**
   * False until the provider has reported usage.
   *
   * The flag is what keeps "we do not know" out of "zero". A cancelled stream
   * leaves every count at 0, and writing that as a real measurement would say
   * the request was free — which is the opposite of true, because the provider
   * generated those tokens and will bill for them.
   */
  reported: boolean;
}

export function newSpend(): ModelSpend {
  return {
    model: AI_MODEL,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reported: false,
  };
}

export interface RecordAiUsageInput {
  readonly tenantId: string;
  readonly userId: string;
  /** What the call was FOR — "chat", "title", "summarise". */
  readonly operation: string;
  readonly spend: ModelSpend;
  readonly usage: StreamUsage;
}

/**
 * One row per authorized request, whatever became of it.
 *
 * NEVER THROWS, and for the reason `createErrorReporter` never throws: this
 * runs from the stream's settle path, after the last byte has already reached
 * the customer. A metrics write that can reject there converts a full
 * connection pool or a slow insert into a truncated answer, and the person
 * reading it pays for an outage in the machinery that was only watching.
 *
 * COST IS NULL WHEN IT IS UNKNOWN. A cancelled request never gets a usage
 * report from the provider, and a model missing from `MODEL_RATES` cannot be
 * priced. Writing zero in either case would claim the call was free, and a
 * spend total that silently omits every abandoned request under-reports
 * precisely the traffic that spikes when the model is slow — which is when
 * spend is highest and the dashboard is being looked at hardest.
 */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  const { spend, usage } = input;

  // No DATABASE_URL yet. The request itself worked; there is simply nowhere to
  // write it down, and the stand-in handle would throw on the first insert.
  if (!isDbConfigured(db)) return;

  const rate = MODEL_RATES[spend.model];
  const costMicros =
    spend.reported && rate !== undefined
      ? estimateCostMicros({
          inputTokens: spend.inputTokens,
          outputTokens: spend.outputTokens,
          cachedInputTokens: spend.cachedInputTokens,
          rate,
        })
      : null;

  try {
    await db.insert(aiUsage).values({
      tenantId: input.tenantId,
      userId: input.userId,
      model: spend.model,
      operation: input.operation,
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      cachedInputTokens: spend.cachedInputTokens,
      costMicros,
      latencyMs: usage.durationMs,
      status: usage.outcome,
      error: describeStreamError(usage.error),
    });
  } catch (cause) {
    log.error(
      {
        err: cause instanceof Error ? cause.message : String(cause),
        tenantId: input.tenantId,
        operation: input.operation,
        outcome: usage.outcome,
      },
      "could not write the ai_usage row; this request's spend is unrecorded",
    );
  }
}

/**
 * The failure, as a bounded string, or null on every other row.
 *
 * Truncated because a provider error can carry an entire HTML page, and this
 * column sits in the table with the highest row count in the schema.
 */
export function describeStreamError(error: unknown): string | null {
  if (error === undefined) return null;
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2_000);
}

export interface TenantSpend {
  /** Micros, as a decimal string: JSON has no bigint and no exact decimal. */
  readonly micros: string;
  /** The same total in minor units — cents — for anything that charges it. */
  readonly minorUnits: string;
  readonly requests: number;
  readonly since: Date;
}

/**
 * What one tenant has spent since a moment.
 *
 * Summed in Postgres rather than in this process. `ai_usage` is the highest
 * volume table in the schema and a month of it is not something to pull across
 * the wire and add up; the `(tenant_id, created_at)` index exists for this
 * query and no other.
 *
 * Micros become minor units ONCE, at the very end, on the total. Rounding each
 * row to cents first is how a thousand sub-cent calls sum to the wrong number,
 * which is the entire reason the column is micros.
 */
export async function tenantSpendSince(
  tenantId: string,
  since: Date,
): Promise<TenantSpend> {
  const empty: TenantSpend = {
    micros: "0",
    minorUnits: "0",
    requests: 0,
    since,
  };
  if (!isDbConfigured(db)) return empty;

  const [row] = await db
    .select({
      // `coalesce`, because SUM over no rows is NULL rather than 0 — which is
      // the state every tenant is in on their first day, and the one nobody
      // writes a test for.
      micros: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)::text`,
      requests: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.createdAt, since)));

  if (!row) return empty;
  return {
    micros: row.micros,
    minorUnits: costMinorUnits(BigInt(row.micros)).toString(),
    requests: row.requests,
    since,
  };
}
