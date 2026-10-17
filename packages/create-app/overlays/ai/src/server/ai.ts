import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_AI_MODEL, isAiConfigured, type StreamUsage, type TokenRate } from "__SCOPE__/ai";
import {
  aiSpendSince,
  checkAiAllowance,
  describeAiError,
  recordAiUsage as recordAiCall,
  type AiAllowanceVerdict,
  type AiSpend,
} from "__SCOPE__/ai/server";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "./error-reporter";
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
 *
 * Claude Haiku 4.5 by default (ai 0.2.0): the founder's rule for every AI
 * feature is the cheapest model that does the job. Name a bigger one only
 * where it earns its price.
 */
export const AI_MODEL: string = DEFAULT_AI_MODEL;

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
    // A five-minute cache write bills at 1.25x fresh input.
    cachedWriteMicrosPerMTok: 6_250_000,
  },
  // $1.00 in, $5.00 out, per million tokens. The model the estimator's photo
  // reading calls by default (src/server/estimator-services.ts, when this
  // project has the estimator): one small call per photo, recorded here as
  // "estimator_takeoff". Harmless in a project without it — a row nothing
  // calls costs nothing.
  "claude-haiku-4-5": {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 5_000_000,
    cachedInputMicrosPerMTok: 100_000,
    cachedWriteMicrosPerMTok: 1_250_000,
  },
};

/**
 * The per-request output ceiling.
 *
 * THIS NUMBER TIMES THE REQUESTS ALLOWED IS THE WORST-CASE BILL. At Haiku
 * 4.5's $5 per million output tokens, 2,000 tokens is a cent; a few short
 * paragraphs is all a chat answer needs, and a smaller ceiling is a smaller
 * bill on every request that runs long.
 */
export const AI_MAX_TOKENS = 2_000;

/**
 * THE SITE'S DAILY CEILING (ai 0.2.0), in cents, across every company and
 * every AI feature: every company spends this site's key, so this bounds the
 * site owner's bill on the worst day. Checked before every call, and failing
 * closed. Raise it as the site grows.
 */
export const AI_SITE_DAILY_CENTS = 500;

/**
 * TELL THE SITE OWNER when the site's daily ceiling closes AI for everyone:
 * one entry in /admin/errors (and the server log) per UTC day per server —
 * the day's spend, the ceiling, and that it opens again at midnight UTC.
 * Every AI feature's check passes it (`onSiteCeiling`).
 */
let ceilingAlertedOn: string | null = null;
export function alertSiteCeiling(info: { readonly tenantId: string; readonly spentMicros: string; readonly ceilingCents: number; readonly resetsAt: Date }): void {
  const day = info.resetsAt.toISOString().slice(0, 10);
  if (ceilingAlertedOn === day) return;
  ceilingAlertedOn = day;
  const spentCents = Number(BigInt(info.spentMicros) / 10_000n);
  log.error({ ...info, spentCents }, "AI is paused for the whole site until midnight UTC: today's spend reached AI_SITE_DAILY_CENTS");
  void reportError({
    error: new Error(
      `AI is paused for the whole site until midnight UTC: today's AI spend (${spentCents} cents) reached AI_SITE_DAILY_CENTS (${info.ceilingCents}). Raise it in src/server/ai.ts if this is expected.`,
    ),
    source: "route",
    tenantId: info.tenantId,
    context: { feature: "ai", ceilingCents: info.ceilingCents, spentCents },
  });
}

/**
 * Is the SITE's day still open? For an AI feature that has no allowance of
 * its own to check (the estimator's photo reading, which adds to the same
 * ledger): the same ceiling, failing closed.
 */
export async function siteCeilingOpen(): Promise<boolean> {
  if (!isDbConfigured(db)) return true;
  const verdict = await checkAiAllowance(db, {
    // No company's month is checked here (no limits of its own): the site's day only.
    tenantId: "*",
    operations: [],
    allowance: { monthlyMessages: null, monthlyCents: null },
    siteDailyCents: AI_SITE_DAILY_CENTS,
    onSiteCeiling: alertSiteCeiling,
  });
  return verdict.ok;
}

/**
 * What one company's people may spend on /api/ai/chat in a month, in cents
 * (ai 0.2.0) — per COMPANY, not only per person, so a company of fifty can't
 * spend fifty people's worth. The assistant has its own allowance
 * (src/server/assistant.ts, when installed).
 */
export const AI_CHAT_MONTHLY_CENTS = 500;

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
  /**
   * Null for a call no signed-in person made: a customer's photo read on the
   * public estimate page is spent on the business's behalf, by nobody.
   */
  readonly userId: string | null;
  /** What the call was FOR — "chat", "title", "summarise". */
  readonly operation: string;
  readonly spend: ModelSpend;
  readonly usage: StreamUsage;
}

/**
 * One row per authorized request, whatever became of it — through
 * __SCOPE__/ai/server's `recordAiUsage` (ai 0.2.0), priced in code from
 * MODEL_RATES with the provider's counts. NEVER THROWS: it runs after the
 * answer reached the customer. COST IS NULL WHEN IT IS UNKNOWN (no usage
 * reported, or a model missing from MODEL_RATES), never zero.
 */
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  // No DATABASE_URL yet: the request worked, there is nowhere to write it down.
  if (!isDbConfigured(db)) return;
  const { spend, usage } = input;
  await recordAiCall(
    db,
    MODEL_RATES,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      operation: input.operation,
      usage: {
        model: spend.model,
        inputTokens: spend.inputTokens,
        outputTokens: spend.outputTokens,
        cachedInputTokens: spend.cachedInputTokens,
        reported: spend.reported,
      },
      latencyMs: usage.durationMs,
      status: usage.outcome,
      error: usage.error,
    },
    {
      onError: (cause, context) =>
        log.error(
          { err: cause instanceof Error ? cause.message : String(cause), ...context, outcome: usage.outcome },
          "could not write the ai_usage row; this request's spend is unrecorded",
        ),
    },
  );
}

/** The failure, as a bounded string, or null on every other row. */
export function describeStreamError(error: unknown): string | null {
  return describeAiError(error);
}

/**
 * May this company make one more /api/ai/chat call this month? Its people
 * together, against AI_CHAT_MONTHLY_CENTS, and the whole site against
 * AI_SITE_DAILY_CENTS — counted from ai_usage, failing closed.
 */
export async function chatAllowance(tenantId: string): Promise<AiAllowanceVerdict> {
  return checkAiAllowance(db, {
    tenantId,
    operations: ["chat"],
    allowance: { monthlyMessages: null, monthlyCents: AI_CHAT_MONTHLY_CENTS },
    siteDailyCents: AI_SITE_DAILY_CENTS,
    onSiteCeiling: alertSiteCeiling,
    words: {
      company_spend: "This month's AI allowance for your account is used up. It starts again on the 1st.",
      site_ceiling: "This site's AI has reached its limit for today — that's the whole site, not just your account. It starts again at midnight UTC.",
      unavailable: "AI can't check its allowance right now, so it isn't answering. Try again in a minute.",
    },
  });
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
 * What one tenant has spent since a moment, summed in Postgres over the
 * (tenant_id, created_at) index — __SCOPE__/ai/server's `aiSpendSince`, with
 * micros becoming minor units once, on the total.
 */
export async function tenantSpendSince(tenantId: string, since: Date): Promise<TenantSpend> {
  if (!isDbConfigured(db)) return { micros: "0", minorUnits: "0", requests: 0, since };
  const spend: AiSpend = await aiSpendSince(db, { tenantId, since });
  return spend;
}
