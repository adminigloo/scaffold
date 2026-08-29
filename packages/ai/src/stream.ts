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
  const startedAt = now();
  let chunks = 0;
  let settled = false;

  /**
   * Report at most once.
   *
   * The flag is set synchronously, before the first await, because cancel can
   * arrive while a pull is in flight: the consumer disconnects, `pull` then
   * observes the read rejecting, and both paths race to report. Two reports is
   * two `ai_usage` rows for one request, which double-counts spend — and a
   * billing number that is sometimes doubled is worse than one that is missing,
   * because nobody knows which rows to trust.
   */
  const settle = async (outcome: StreamOutcome, error?: unknown): Promise<void> => {
    if (settled) return;
    settled = true;
    const usage: StreamUsage = {
      outcome,
      chunks,
      durationMs: now() - startedAt,
      ...(outcome === "errored" ? { error } : {}),
    };
    await reportUsage(onUsage, usage);
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
        await settle("errored", error);
        controller.error(error);
        return;
      }

      if (result.done) {
        // Settle BEFORE closing. On a serverless platform the instance can be
        // frozen the moment the response completes, so a fire-and-forget usage
        // write is dropped exactly when traffic is highest. The consumer has
        // every byte already; all that is delayed is the close event.
        await settle("completed");
        controller.close();
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
