/**
 * How the stream ended.
 *
 *   completed  the source closed on its own
 *   errored    the source threw part-way through
 *   cancelled  the consumer went away
 *
 * Three values rather than a boolean because the three cost the same and mean
 * completely different things: a spike in `cancelled` is a UI that re-mounts
 * mid-stream, a spike in `errored` is the provider. Collapsing them into
 * "success" hides both.
 */
export type StreamOutcome = "completed" | "errored" | "cancelled";

export interface StreamUsage {
  readonly outcome: StreamOutcome;
  /**
   * Chunks handed to the consumer before the stream ended.
   *
   * Not tokens. This helper cannot know a provider's tokenisation, and guessing
   * would produce a number that looks authoritative and reconciles against
   * nothing. The caller closes over its own token counts and combines them with
   * this report; what the stream contributes is the outcome and the latency,
   * which the caller cannot observe from outside.
   */
  readonly chunks: number;
  readonly durationMs: number;
  /** Set only when `outcome` is "errored". */
  readonly error?: unknown;
}

export type UsageReporter = (usage: StreamUsage) => void | Promise<void>;

export interface MeterStreamOptions {
  readonly onUsage: UsageReporter;
  /**
   * When the request started, if that is earlier than the wrap.
   *
   * `createStreamRoute` passes the moment authorization finished, so
   * `durationMs` covers time-to-first-token as well as the stream. Measured
   * from the wrap instead, a request that spent nine seconds waiting on the
   * provider and one streaming reports as a one-second request, and the metric
   * disagrees with every user describing it as slow.
   */
  readonly startedAt?: number;
  /** Injected so latency assertions do not depend on the wall clock. */
  readonly now?: () => number;
}

/**
 * Wrap a response stream so usage is recorded however it ends.
 *
 * CANCELLATION IS THE CASE THIS EXISTS FOR. A user who closes the tab, hits
 * stop, or navigates away has already spent the tokens — the provider generated
 * them and will bill for them — but the request never reaches whatever line of
 * code sits after the loop. Record usage only on clean completion and every
 * abandoned request is invisible, which under-reports precisely the traffic
 * that spikes when the model is slow, i.e. when spend is highest and the
 * dashboard is being looked at hardest.
 *
 * Implemented by pulling from a reader rather than `pipeThrough(new
 * TransformStream(...))`, because a transformer's cancel hook is not carried by
 * every runtime this ships to, and a silently-missing cancel path would
 * reintroduce the exact hole above.
 */
export function meterStream<T>(
  source: ReadableStream<T>,
  options: MeterStreamOptions,
): ReadableStream<T> {
  const { onUsage, now = () => Date.now() } = options;
  const reader = source.getReader();
  const startedAt = options.startedAt ?? now();
  let chunks = 0;
  let settled = false;

  /**
   * Report at most once; returns whether THIS call was the one that reported.
   *
   * The flag is set synchronously, before the first await, because cancel
   * genuinely races a pull: the consumer disconnects while a read is in flight,
   * cancelling the source resolves that read as done, and the pull path then
   * arrives at "completed" a tick after the cancel path reported. Two reports
   * is two `ai_usage` rows for one request, which double-counts spend — and a
   * billing number that is sometimes doubled is worse than one that is missing,
   * because nobody can tell which rows to trust.
   *
   * The return value carries that race into the controller calls below. Whoever
   * settled owns the stream's ending; the loser must not also close or error a
   * stream that is already finished, which throws.
   */
  const settle = async (outcome: StreamOutcome, error?: unknown): Promise<boolean> => {
    if (settled) return false;
    settled = true;
    const usage: StreamUsage = {
      outcome,
      chunks,
      durationMs: now() - startedAt,
      ...(outcome === "errored" ? { error } : {}),
    };
    await reportUsage(onUsage, usage);
    return true;
  };

  return new ReadableStream<T>({
    async pull(controller) {
      // Spelled through the reader rather than as `ReadableStreamReadResult<T>`:
      // that name lives inside the `node:stream/web` module and is not a global
      // under `types: ["node"]` with no DOM lib, so naming it breaks the build.
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (await settle("errored", error)) controller.error(error);
        return;
      }

      if (result.done) {
        // Settle BEFORE closing. On a serverless platform the instance can be
        // frozen the moment the response completes, so a fire-and-forget usage
        // write is dropped exactly when traffic is highest. The consumer has
        // every byte already; all that is delayed is the close event.
        //
        // `done` here can also mean "the consumer cancelled and that resolved
        // our pending read", which is why the close is conditional: closing an
        // already-cancelled stream throws.
        if (await settle("completed")) controller.close();
        return;
      }

      chunks += 1;
      controller.enqueue(result.value);
    },

    async cancel(reason) {
      // Settle before tearing the source down: if the provider's own cancel
      // rejects, the tokens were still spent and the row still has to exist.
      await settle("cancelled");
      await reader.cancel(reason);
    },
  });
}

/**
 * Hand a usage report to the app, swallowing anything it throws.
 *
 * Shared with `createStreamRoute` so the rule lives in one place. A metrics
 * write that can reject the stream turns an observability outage — a full
 * connection pool, a slow insert — into a product outage, and the user sees a
 * truncated answer because we failed to write down what it cost. The report is
 * the less important half of the request; it never gets to break the response.
 */
export async function reportUsage(
  onUsage: UsageReporter,
  usage: StreamUsage,
): Promise<void> {
  try {
    await onUsage(usage);
  } catch {
    // Intentionally swallowed. See above.
  }
}
