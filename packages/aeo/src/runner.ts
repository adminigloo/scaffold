import { analyzeAnswer } from "./detect.js";
import type { AnswerEngine, EngineUsage } from "./engines.js";
import { AeoError, getProfile, listQueries, recordCheck, recordFailedCheck, type AeoDb, type QueryRow } from "./store.js";

/**
 * RUNNING THE CHECKS (0.2): ask the engine each question, METERED, inside a
 * deadline.
 *
 *   1. HOLD before every call: `spend.reserve` holds the question's worst case
 *      (tokens and web searches) against the company's month, its share of
 *      the site's day and the site's daily ceiling (@adminigloo/ai's ledger).
 *      Refused → nothing is asked, and the run stops with the sentence.
 *   2. ASK, with a time limit per call.
 *   3. SETTLE with what the provider reported — tokens priced from the app's
 *      rate table, web searches at the engine's fee. An answer that FAILED
 *      keeps its hold (over-counts, never under-counts). A call we ABORTED at
 *      its time limit, and a hold whose question was never asked (the
 *      deadline came first), are RELEASED: not charged. A hold a dead process
 *      left behind is swept later (@adminigloo/ai's sweepStaleReservations).
 *   4. CODE reads the answer (analyzeAnswer) and the result is kept.
 *
 * DEADLINE-AWARE: a call isn't started unless it can finish inside the run's
 * budget (one server function's minute); what's left waits for the next run,
 * and the result says how many.
 */

/** What @adminigloo/ai's ledger says about one hold. */
export type SpendReservation = { readonly ok: true; readonly reservationId: string } | { readonly ok: false; readonly message: string };

/** The app's metering: the company's allowance in @adminigloo/ai (create-app wires it). */
export interface MentionSpend {
  reserve(input: { readonly tenantId: string; readonly userId: string | null; readonly model: string; readonly reserveMicros: bigint }): Promise<SpendReservation>;
  settle(
    reservationId: string,
    outcome: { readonly usage: (EngineUsage & { readonly feesMicros: bigint }) | null; readonly status: "completed" | "errored" | "cancelled"; readonly latencyMs: number },
  ): Promise<{ readonly costMicros: bigint | null }>;
  release(reservationId: string): Promise<void>;
}

export interface RunMentionChecksInput {
  readonly db: AeoDb;
  readonly tenantId: string;
  readonly engine: AnswerEngine;
  readonly spend: MentionSpend;
  /** Only these questions (one "Check"); every active question when left out. */
  readonly queryIds?: readonly string[];
  /** Skip questions answered since this moment (the weekly job: answered this week). */
  readonly skipCheckedSince?: Date | null;
  readonly lastCheckedAt?: ReadonlyMap<string, Date>;
  readonly trigger: "manual" | "schedule";
  readonly userId: string | null;
  /** The whole run, ms. Default 45 seconds. */
  readonly budgetMs?: number;
  /** One call, ms. Default 25 seconds; never more than the run has left. */
  readonly callTimeoutMs?: number;
  /** Room kept after the last call for writing its result, ms. Default 2 seconds. */
  readonly marginMs?: number;
  /** Calls at once. Default 2. */
  readonly concurrency?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context: { tenantId: string; queryId: string }) => void;
}

export interface RunMentionChecksResult {
  /** Answers that came and were read. */
  readonly checked: number;
  /** Of those, how many named the business. */
  readonly cited: number;
  /** Answers that didn't come (timed out, refused). */
  readonly failed: number;
  /** Questions not asked this time: out of time, or the allowance ran out. */
  readonly waiting: number;
  /** Why the run stopped early, in words; null when every question was asked. */
  readonly stopped: string | null;
}

export async function runMentionChecks(input: RunMentionChecksInput): Promise<RunMentionChecksResult> {
  const now = input.now ?? (() => new Date());
  const started = now().getTime();
  const budget = input.budgetMs ?? 45_000;
  const margin = Math.max(0, input.marginMs ?? 2_000);
  const callTimeout = Math.max(1_000, Math.min(input.callTimeoutMs ?? 25_000, budget - margin));
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 2, 4));

  const profile = await getProfile(input.db, input.tenantId);
  if (!profile) throw new AeoError("no_profile", "Tell us your business's name first, so the answers can be checked for it.");
  const target = { brand: profile.brand, domain: profile.domain, aliases: profile.aliases ?? [] };
  const competitors = profile.competitors ?? [];

  let queue: QueryRow[] = await listQueries(input.db, input.tenantId);
  if (input.queryIds) {
    const wanted = new Set(input.queryIds);
    queue = queue.filter((q) => wanted.has(q.id));
  }
  if (input.skipCheckedSince && input.lastCheckedAt) {
    const since = input.skipCheckedSince.getTime();
    queue = queue.filter((q) => (input.lastCheckedAt!.get(q.id)?.getTime() ?? 0) < since);
  }

  let checked = 0;
  let cited = 0;
  let failed = 0;
  let stopped: string | null = null;
  const timeLeft = () => budget - (now().getTime() - started);

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped !== null) return;
      const question = queue.shift();
      if (!question) return;
      // A call starts only when its whole time limit fits before the deadline.
      if (timeLeft() < callTimeout + margin) {
        queue.unshift(question);
        stopped ??= "Out of time for this run; the rest are checked next time.";
        return;
      }
      const hold = await input.spend.reserve({ tenantId: input.tenantId, userId: input.userId, model: input.engine.model, reserveMicros: input.engine.worstCaseMicros });
      if (!hold.ok) {
        queue.unshift(question);
        stopped ??= hold.message;
        return;
      }
      if (timeLeft() < callTimeout + margin) {
        // The deadline came while holding: nothing was asked, so nothing is owed.
        await input.spend.release(hold.reservationId);
        queue.unshift(question);
        stopped ??= "Out of time for this run; the rest are checked next time.";
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timed out")), callTimeout);
      const askedAt = now().getTime();
      try {
        const answer = await input.engine.ask(question.query, { signal: controller.signal });
        clearTimeout(timer);
        const settled = await input.spend.settle(hold.reservationId, {
          usage: { ...answer.usage, feesMicros: input.engine.feesMicros(answer.usage) },
          status: "completed",
          latencyMs: now().getTime() - askedAt,
        });
        const analysis = analyzeAnswer(answer, target, competitors);
        await recordCheck(input.db, {
          tenantId: input.tenantId,
          queryId: question.id,
          engine: input.engine.key,
          model: input.engine.model,
          trigger: input.trigger,
          analysis,
          answer: answer.text,
          citedUrls: answer.citedUrls,
          costMicros: settled.costMicros,
        });
        checked += 1;
        if (analysis.cited) cited += 1;
      } catch (error) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        let costMicros: bigint | null = null;
        if (aborted) {
          // We stopped it at its time limit: released, not charged.
          await input.spend.release(hold.reservationId);
        } else {
          // It failed on the provider's side, usage unknown: the hold's worst case stays (never free by accident).
          costMicros = (await input.spend.settle(hold.reservationId, { usage: null, status: "errored", latencyMs: now().getTime() - askedAt })).costMicros;
        }
        await recordFailedCheck(input.db, {
          tenantId: input.tenantId,
          queryId: question.id,
          engine: input.engine.key,
          model: input.engine.model,
          trigger: input.trigger,
          error: aborted ? new Error("The answer took too long.") : error,
          costMicros,
        });
        failed += 1;
        try {
          input.onError?.(error, { tenantId: input.tenantId, queryId: question.id });
        } catch {
          /* a broken reporter must not stop the run */
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { checked, cited, failed, waiting: queue.length, stopped };
}
