import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { costMinorUnits, estimateCostMicros, type TokenRate } from "./cost.js";
import { aiUsage, type AiUsageStatus } from "./schema.js";

/**
 * @adminigloo/ai/server — the ledger, read and written (0.2.0).
 *
 * Until 0.2 every project carried its own copy of `recordAiUsage` and
 * `tenantSpendSince` in src/server/ai.ts, so a fix to how a call is costed had
 * to be typed into every project by hand. They live here now, beside the table
 * they read and write, with the one thing 0.1 never had: an ALLOWANCE — how
 * much AI a company may use in a month, and how much the whole site may spend
 * in a day — checked before a call and failing closed.
 *
 * THE MODEL NEVER REPORTS ITS OWN COST. Token counts come from the provider's
 * usage report and the price from the app's rate table; this module does the
 * arithmetic, in integer micros, once.
 *
 * Server-only: it imports the pgTable, which the root entry deliberately does
 * not (see ./index.ts).
 */

/** The loosest handle that runs these queries: the app's db, a transaction, a test's PGlite. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AiDb = PgDatabase<any, any, any>;

/** The app's rate table: micros per million tokens, keyed by the exact model id. */
export type AiRates = Readonly<Record<string, TokenRate>>;

export { DEFAULT_AI_MODEL } from "./model.js";

/** What one call used, as the PROVIDER reported it. */
export interface AiCallUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cachedWriteTokens?: number;
  /**
   * False until the provider reported usage. A cancelled stream leaves every
   * count at zero, and writing that as a measurement would say the call was
   * free: the cost is recorded as unknown (null) instead.
   */
  readonly reported: boolean;
  /**
   * What the provider bills per call BEYOND tokens (0.3.0), in micros: web
   * searches, priced by the caller from the provider's own count (Anthropic's
   * `usage.server_tool_use.web_search_requests` × $10 per 1,000). Added to
   * the token cost; never a number the model reported.
   */
  readonly feesMicros?: bigint;
}

/**
 * The cost of one call in micros, or null when it can't be known: usage never
 * reported, or a model the rate table doesn't price. Never zero for "unknown".
 */
export function aiCallCostMicros(rates: AiRates, usage: AiCallUsage): bigint | null {
  if (!usage.reported) return null;
  const rate = rates[usage.model];
  if (rate === undefined) return null;
  const fees = usage.feesMicros ?? 0n;
  return (
    estimateCostMicros({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      cachedWriteTokens: usage.cachedWriteTokens ?? 0,
      rate,
    }) + (fees > 0n ? fees : 0n)
  );
}

export interface RecordAiUsageInput {
  /** The company the call was for; null for work that belongs to no company. */
  readonly tenantId: string | null;
  /** Who asked; null for scheduled work, or a customer on a public page. */
  readonly userId: string | null;
  /** What the call was FOR: "assistant_chat", "chat", "estimator_takeoff". */
  readonly operation: string;
  readonly usage: AiCallUsage;
  readonly status: AiUsageStatus;
  readonly latencyMs?: number | null;
  readonly error?: unknown;
}

export interface RecordAiUsageOptions {
  /** Told when the row couldn't be written (the call itself already happened). */
  readonly onError?: (error: unknown, context: { tenantId: string | null; operation: string }) => void;
}

/** The failure, bounded: a provider error can carry a whole HTML page. Null when there was none. */
export function describeAiError(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2_000);
}

/**
 * One row per call, whatever became of it. NEVER THROWS: it runs after the
 * answer reached the person, and a ledger write that fails must not turn a
 * delivered answer into an error. A failure is handed to `onError`.
 */
export async function recordAiUsage(
  db: AiDb,
  rates: AiRates,
  input: RecordAiUsageInput,
  options: RecordAiUsageOptions = {},
): Promise<{ readonly recorded: boolean; readonly costMicros: bigint | null }> {
  let costMicros: bigint | null = null;
  try {
    costMicros = aiCallCostMicros(rates, input.usage);
    await db.insert(aiUsage).values({
      tenantId: input.tenantId,
      userId: input.userId,
      model: input.usage.model,
      operation: input.operation,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: input.usage.cachedInputTokens ?? 0,
      cachedWriteTokens: input.usage.cachedWriteTokens ?? 0,
      costMicros,
      latencyMs: input.latencyMs ?? null,
      status: input.status,
      error: describeAiError(input.error),
    });
    return { recorded: true, costMicros };
  } catch (error) {
    try {
      options.onError?.(error, { tenantId: input.tenantId, operation: input.operation });
    } catch {
      /* the reporter failing is not the caller's problem either */
    }
    return { recorded: false, costMicros };
  }
}

export interface AiSpend {
  /** Micros, as a decimal string: JSON has no bigint. Reserved calls count at their worst case. */
  readonly micros: string;
  /** The same total in cents, rounded once, on the total. */
  readonly minorUnits: string;
  /** How many calls, whatever became of them. */
  readonly requests: number;
  /**
   * How many calls ANSWERED or are still being answered (0.2.0): every call
   * but a failed one. A question the provider refused, or that broke before it
   * answered, never uses up one of a company's monthly messages — its tokens
   * (if any) still count in `micros`.
   */
  readonly answered: number;
  readonly since: Date;
}

/**
 * What was spent since a moment: one company's (`tenantId`), or the whole
 * site's (`tenantId` omitted), optionally for some operations only. Summed in
 * Postgres over the (tenant_id, created_at) index; micros become cents once,
 * on the total. Calls still in flight (reserved) count at their worst case.
 */
export async function aiSpendSince(
  db: AiDb,
  input: { readonly tenantId?: string; readonly since: Date; readonly operations?: readonly string[] },
): Promise<AiSpend> {
  const where = [
    gte(aiUsage.createdAt, input.since),
    ...(input.tenantId !== undefined ? [eq(aiUsage.tenantId, input.tenantId)] : []),
    ...(input.operations && input.operations.length > 0 ? [inArray(aiUsage.operation, [...input.operations])] : []),
  ];
  const [row] = (await db
    .select({
      // coalesce: SUM over no rows is NULL, which is every company's first day.
      micros: sql<string>`coalesce(sum(${aiUsage.costMicros}), 0)::text`,
      requests: count(),
      answered: sql<number>`count(*) filter (where ${aiUsage.status} <> 'errored')::int`,
    })
    .from(aiUsage)
    .where(and(...where))) as Array<{ micros: string; requests: number | string; answered: number | string }>;
  const micros = row?.micros ?? "0";
  return {
    micros,
    minorUnits: costMinorUnits(BigInt(micros)).toString(),
    requests: Number(row?.requests ?? 0),
    answered: Number(row?.answered ?? 0),
    since: input.since,
  };
}

/** 00:00 UTC on the first of `now`'s month. Allowances count by calendar month, in UTC. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** 00:00 UTC on the first of the NEXT month: when a monthly allowance starts again. */
export function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** 00:00 UTC today. The site-wide ceiling counts by UTC day. */
export function startOfDayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * A company's monthly allowance. Each limit is a number, or null for "no limit
 * of this kind". Both may apply: the first one reached closes the month.
 */
export interface AiAllowance {
  /** Answered messages (calls of the counted operations) a month. */
  readonly monthlyMessages: number | null;
  /** Cents of AI a month, priced from the rate table. */
  readonly monthlyCents: number | null;
  /**
   * Cents of AI ONE company may use in one UTC day (0.2.0), whatever its
   * month allows — its share of the site's day, so no single company (an
   * unlimited plan included) can spend the whole site's ceiling and close AI
   * for everyone else. Omitted: no daily share.
   */
  readonly dailyCents?: number | null;
}

/** What closed it: the company's messages, the company's cents, or the whole site's day. */
export type AiAllowanceLimit = "messages" | "cents" | "day" | "feature" | "site";

/** Where a company stands this month, in numbers code worked out. */
export interface AiAllowanceUsage {
  /** Answered messages this month (reserved, in-flight ones included). */
  readonly messages: number;
  readonly messageLimit: number | null;
  /** Cents spent this month (a decimal string, rounded once). */
  readonly cents: string;
  readonly centLimit: number | null;
  /** When the month's count began, and when it starts again. */
  readonly monthStart: Date;
  readonly resetsAt: Date;
  /** Set on a refusal: which limit was reached. */
  readonly limitedBy?: AiAllowanceLimit;
  /** On a site refusal: when the site's day starts again (00:00 UTC tomorrow). */
  readonly siteResetsAt?: Date;
}

export type AiAllowanceRefusal = "company_messages" | "company_spend" | "company_day" | "feature_day" | "site_ceiling" | "unavailable";

export type AiAllowanceVerdict =
  | { readonly ok: true; readonly usage: AiAllowanceUsage }
  | {
      readonly ok: false;
      readonly reason: AiAllowanceRefusal;
      /** A plain sentence for the person asking. */
      readonly message: string;
      readonly usage: AiAllowanceUsage | null;
    };

export interface CheckAiAllowanceInput {
  readonly tenantId: string;
  /** The operations that count against this allowance, e.g. ["assistant_chat"]. */
  readonly operations: readonly string[];
  readonly allowance: AiAllowance;
  /**
   * The SITE's ceiling: cents of AI per UTC day across every company and every
   * operation. Every company spends the site owner's key, so this is what
   * bounds the owner's bill on the worst day. null: no ceiling (not advised).
   */
  readonly siteDailyCents: number | null;
  /**
   * THIS FEATURE'S share of the site's day (0.3.0): cents per UTC day across
   * every company, for the counted `operations` only — so one feature (AI
   * mentions, say) can never spend the whole site's ceiling and switch off
   * the assistant or the estimator's photo reading. Omitted: no feature share.
   */
  readonly operationsDailyCents?: number | null;
  readonly now?: Date;
  /** Override the sentences (e.g. to name the product). */
  readonly words?: Partial<Record<AiAllowanceRefusal, string | ((usage: AiAllowanceUsage | null) => string)>>;
  /**
   * Told when the SITE's daily ceiling refuses a call — the site owner's
   * alert (create-app writes it to the error log, once a day). Never throws
   * into the check.
   */
  readonly onSiteCeiling?: (info: { readonly tenantId: string; readonly spentMicros: string; readonly ceilingCents: number; readonly resetsAt: Date }) => void;
}

function dayWords(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const DEFAULT_WORDS: Record<AiAllowanceRefusal, (usage: AiAllowanceUsage | null) => string> = {
  company_messages: (usage) =>
    `This month's assistant allowance is used up${usage?.messageLimit != null ? ` (${usage.messageLimit} messages)` : ""}. It starts again on ${dayWords(usage?.resetsAt ?? new Date())}.`,
  company_spend: (usage) =>
    `This month's assistant allowance is used up: it reached its ${usage?.centLimit != null ? dollars(usage.centLimit) : "monthly"} spending limit before its messages ran out. It starts again on ${dayWords(usage?.resetsAt ?? new Date())}.`,
  company_day: () => "Your account has used today's share of this site's AI. It starts again at midnight UTC.",
  feature_day: () => "This feature has used today's share of this site's AI. It starts again at midnight UTC.",
  site_ceiling: (usage) =>
    `This site's AI has reached its limit for today — that's the whole site, not just your account. It starts again at midnight UTC${usage?.siteResetsAt ? ` (${dayWords(usage.siteResetsAt)})` : ""}.`,
  unavailable: () => "The assistant can't check its allowance right now, so it isn't answering. Try again in a minute.",
};

function wordsFor(input: CheckAiAllowanceInput, reason: AiAllowanceRefusal, usage: AiAllowanceUsage | null): string {
  const custom = input.words?.[reason];
  if (typeof custom === "string") return custom;
  if (typeof custom === "function") return custom(usage);
  return DEFAULT_WORDS[reason](usage);
}

/** The checks, on one handle (the reservation runs them inside its lock). */
async function judge(db: AiDb, input: CheckAiAllowanceInput, now: Date): Promise<AiAllowanceVerdict> {
  const monthStart = startOfMonthUtc(now);
  const month = await aiSpendSince(db, { tenantId: input.tenantId, since: monthStart, operations: input.operations });
  const base: AiAllowanceUsage = {
    messages: month.answered,
    messageLimit: input.allowance.monthlyMessages,
    cents: month.minorUnits,
    centLimit: input.allowance.monthlyCents,
    monthStart,
    resetsAt: startOfNextMonthUtc(now),
  };
  if (base.messageLimit !== null && base.messages >= base.messageLimit) {
    const usage = { ...base, limitedBy: "messages" as const };
    return { ok: false, reason: "company_messages", message: wordsFor(input, "company_messages", usage), usage };
  }
  // Compared in micros, so a month that has spent 299.6 cents of a 300-cent
  // allowance is still inside it (cents are rounded only for display).
  if (base.centLimit !== null && BigInt(month.micros) >= BigInt(base.centLimit) * 10_000n) {
    const usage = { ...base, limitedBy: "cents" as const };
    return { ok: false, reason: "company_spend", message: wordsFor(input, "company_spend", usage), usage };
  }
  const dailyCents = input.allowance.dailyCents ?? null;
  if (dailyCents !== null) {
    const mine = await aiSpendSince(db, { tenantId: input.tenantId, since: startOfDayUtc(now) });
    if (BigInt(mine.micros) >= BigInt(dailyCents) * 10_000n) {
      const usage = { ...base, limitedBy: "day" as const, siteResetsAt: new Date(startOfDayUtc(now).getTime() + 86_400_000) };
      return { ok: false, reason: "company_day", message: wordsFor(input, "company_day", usage), usage };
    }
  }
  const featureCents = input.operationsDailyCents ?? null;
  if (featureCents !== null) {
    const feature = await aiSpendSince(db, { since: startOfDayUtc(now), operations: input.operations });
    if (BigInt(feature.micros) >= BigInt(featureCents) * 10_000n) {
      const usage = { ...base, limitedBy: "feature" as const, siteResetsAt: new Date(startOfDayUtc(now).getTime() + 86_400_000) };
      return { ok: false, reason: "feature_day", message: wordsFor(input, "feature_day", usage), usage };
    }
  }
  if (input.siteDailyCents !== null) {
    const today = await aiSpendSince(db, { since: startOfDayUtc(now) });
    if (BigInt(today.micros) >= BigInt(input.siteDailyCents) * 10_000n) {
      const siteResetsAt = new Date(startOfDayUtc(now).getTime() + 86_400_000);
      const usage = { ...base, limitedBy: "site" as const, siteResetsAt };
      try {
        input.onSiteCeiling?.({ tenantId: input.tenantId, spentMicros: today.micros, ceilingCents: input.siteDailyCents, resetsAt: siteResetsAt });
      } catch {
        /* an alert that fails must not change the answer */
      }
      return { ok: false, reason: "site_ceiling", message: wordsFor(input, "site_ceiling", usage), usage };
    }
  }
  return { ok: true, usage: base };
}

/**
 * May this company make one more call? A READ-ONLY check — for a status or a
 * settings screen. Before a model call, use `reserveAiAllowance`, which also
 * holds the call's place so calls in flight count.
 *
 * FAILS CLOSED. Anything that stops the check from reading the ledger — a
 * database that's down, a query that throws — refuses with a plain sentence.
 */
export async function checkAiAllowance(db: AiDb, input: CheckAiAllowanceInput): Promise<AiAllowanceVerdict> {
  try {
    return await judge(db, input, input.now ?? new Date());
  } catch {
    return { ok: false, reason: "unavailable", message: wordsFor(input, "unavailable", null), usage: null };
  }
}

export interface ReserveAiAllowanceInput extends CheckAiAllowanceInput {
  readonly userId: string | null;
  /** What the ledger row is for ("assistant_chat"); one of `operations`. */
  readonly operation: string;
  readonly model: string;
  /**
   * The most this call can cost, in micros — held against the allowance and
   * the site's day until it settles (price `maxTokens` and the prompt's size
   * with the rate table: `aiCallCostMicros`).
   */
  readonly reserveMicros: bigint;
}

export type AiReservation =
  | (AiAllowanceVerdict & { readonly ok: true; readonly reservationId: string })
  | (AiAllowanceVerdict & { readonly ok: false; readonly reservationId?: undefined });

/** One lock for every allowance on the site: the reservations are serialised, the calls are not. */
const ALLOWANCE_LOCK = "adminigloo:ai-allowance";

/**
 * CHECK AND HOLD, AS ONE STEP (0.2.0). Inside a transaction holding the site's
 * allowance lock: run the checks — counting every call still in flight at its
 * worst case — and, if allowed, write a "reserved" ai_usage row for this call
 * at `reserveMicros`. Forty questions sent at once on a three-question plan
 * are let through three at a time, never forty: each one after the third sees
 * the first three's reservations.
 *
 * Settle it after the call (`settleAiReservation`) with what it really cost.
 * A reservation that is never settled (the process died mid-call) keeps its
 * worst-case cost, which over-counts rather than under-counts. FAILS CLOSED.
 */
export async function reserveAiAllowance(db: AiDb, input: ReserveAiAllowanceInput): Promise<AiReservation> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx: AiDb) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ALLOWANCE_LOCK}))`);
      const verdict = await judge(tx, input, now);
      if (!verdict.ok) return verdict;
      const [row] = (await tx
        .insert(aiUsage)
        .values({
          tenantId: input.tenantId,
          userId: input.userId,
          model: input.model,
          operation: input.operation,
          costMicros: input.reserveMicros < 0n ? 0n : input.reserveMicros,
          status: "reserved",
        })
        .returning({ id: aiUsage.id })) as Array<{ id: bigint }>;
      if (!row) throw new Error("reservation insert returned no row");
      const usage = { ...verdict.usage, messages: verdict.usage.messages + 1 };
      return { ok: true as const, usage, reservationId: String(row.id) };
    });
  } catch {
    return { ok: false, reason: "unavailable", message: wordsFor(input, "unavailable", null), usage: null };
  }
}

export interface SettleAiReservationInput {
  /** What the provider reported (or the loop estimated); null when nothing is known. */
  readonly usage: AiCallUsage | null;
  readonly status: Exclude<AiUsageStatus, "reserved">;
  readonly latencyMs?: number | null;
  readonly error?: unknown;
}

/**
 * Write what a reserved call really cost. NEVER NULL, NEVER FREE BY ACCIDENT:
 * a call whose usage is known is priced from it; one whose usage isn't
 * (nothing reported, or a model missing from the rate table) KEEPS its
 * reserved worst case. A failed call ("errored") stops counting as a message
 * but its tokens still count as money. Never throws.
 */
export async function settleAiReservation(
  db: AiDb,
  rates: AiRates,
  reservationId: string,
  input: SettleAiReservationInput,
  options: RecordAiUsageOptions = {},
): Promise<{ readonly settled: boolean; readonly costMicros: bigint | null }> {
  try {
    const id = BigInt(reservationId);
    const priced = input.usage ? aiCallCostMicros(rates, input.usage) : null;
    const [row] = (await db
      .update(aiUsage)
      .set({
        ...(input.usage
          ? {
              model: input.usage.model,
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              cachedInputTokens: input.usage.cachedInputTokens ?? 0,
              cachedWriteTokens: input.usage.cachedWriteTokens ?? 0,
            }
          : {}),
        // Unknown cost: the reserved worst case stays.
        ...(priced !== null ? { costMicros: priced } : {}),
        latencyMs: input.latencyMs ?? null,
        status: input.status,
        error: describeAiError(input.error),
      })
      .where(and(eq(aiUsage.id, id), eq(aiUsage.status, "reserved")))
      .returning({ cost: aiUsage.costMicros })) as Array<{ cost: bigint | null }>;
    return { settled: row !== undefined, costMicros: row?.cost ?? null };
  } catch (error) {
    try {
      options.onError?.(error, { tenantId: null, operation: "settle" });
    } catch {
      /* the reporter failing is not the caller's problem either */
    }
    return { settled: false, costMicros: null };
  }
}

/** Free a reservation the call never used (the model was never asked): the row goes. Never throws. */
export async function releaseAiReservation(db: AiDb, reservationId: string): Promise<void> {
  try {
    await db.delete(aiUsage).where(and(eq(aiUsage.id, BigInt(reservationId)), eq(aiUsage.status, "reserved")));
  } catch {
    /* a reservation left behind over-counts; it never under-counts */
  }
}

/**
 * HOLDS NOBODY SETTLED (0.3.0): "reserved" rows older than `olderThanMs` — the
 * process that held them died mid-call — are deleted: released, not charged.
 * Only for the given operations (a feature that knows its calls can't run
 * that long). Returns how many were swept. Never throws.
 */
export async function sweepStaleReservations(
  db: AiDb,
  input: { readonly operations: readonly string[]; readonly olderThanMs: number; readonly now?: Date },
): Promise<number> {
  if (input.operations.length === 0) return 0;
  try {
    const cutoff = new Date((input.now ?? new Date()).getTime() - Math.max(60_000, input.olderThanMs));
    const rows = (await db
      .delete(aiUsage)
      .where(and(eq(aiUsage.status, "reserved"), inArray(aiUsage.operation, [...input.operations]), lt(aiUsage.createdAt, cutoff)))
      .returning({ id: aiUsage.id })) as unknown[];
    return rows.length;
  } catch {
    return 0;
  }
}
