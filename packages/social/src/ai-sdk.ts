import { DEFAULT_SOCIAL_TIMEOUT_MS, worstCaseMicros, type PostSpend, type PostSpendUsage, type SocialModelRate } from "./meter.js";
import type { Complete } from "./writer.js";

export { DEFAULT_SOCIAL_TIMEOUT_MS, SOCIAL_POST_OPERATION, worstCaseMicros, type PostSpend, type PostSpendUsage, type SocialModelRate } from "./meter.js";

/**
 * @adminigloo/social/ai-sdk — ONE POST'S WORDS THROUGH THE VERCEL AI SDK,
 * METERED (social 0.3): any provider it has a model for (Anthropic, OpenAI,
 * Google, Mistral, a gateway).
 *
 *   import { generateText } from "ai";
 *   import { openai } from "@ai-sdk/openai";        // or anthropic("claude-haiku-4-5"), …
 *   import { createAiSdkComplete } from "@adminigloo/social/ai-sdk";
 *   const complete = createAiSdkComplete({ generateText, model: openai("<the app's model>"), rate, spend, tenantId, userId });
 *
 * The same rules as the other ready-made calls (./anthropic.ts, ./openai.ts):
 * one call per post, no retries, 20 seconds at most, the worst case held
 * before the call and settled at what the provider reported, a cut-off
 * answer thrown with its sentence. The writer asks for JSON in its
 * instructions and reads the first JSON object in the answer, so no schema
 * mode is needed here.
 *
 * NO SDK IMPORT: the app hands in its own `generateText` and model, so this
 * works with the AI SDK version the app already has.
 */

/** What this reads of `generateText`'s result (AI SDK 5 and 6 name these the same). */
interface GenerateTextAnswer {
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cachedInputTokens?: number } | null;
}

export interface AiSdkCompleteOptions {
  /** The app's `generateText`, from "ai". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly generateText: (args: any) => Promise<unknown>;
  /** The app's model: `anthropic("claude-haiku-4-5")`, `openai("…")`, a gateway's. */
  readonly model: unknown;
  /** The model's name for the meter. Default: the model's own `modelId`. */
  readonly modelName?: string;
  /** The model's price (micros per million tokens): what the worst case is held at. */
  readonly rate: SocialModelRate;
  /** The meter. Left out, the call isn't held or recorded anywhere: only for an app that meters its own way. */
  readonly spend?: PostSpend;
  readonly tenantId: string;
  readonly userId?: string | null;
  readonly timeoutMs?: number;
  /** A provider's own settings (`{ openai: { reasoningEffort: "minimal" } }`). */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
  /** Room for a reasoning model's thinking, on top of the writer's bound (default 0). Held too. */
  readonly reasoningTokens?: number;
}

const count = (n: number | null | undefined) => Math.max(0, Math.trunc(n ?? 0));

/** The model's name, as the meter records it. */
function nameOf(options: AiSdkCompleteOptions): string {
  const id = (options.model as { readonly modelId?: unknown } | null)?.modelId;
  const name = options.modelName ?? (typeof id === "string" ? id : "");
  if (!name.trim()) throw new Error("createAiSdkComplete needs the model's name: pass modelName, or a model with a modelId.");
  return name;
}

/** A writer's `complete` over the Vercel AI SDK's `generateText`, held and settled on the app's meter. */
export function createAiSdkComplete(options: AiSdkCompleteOptions): Complete {
  const model = nameOf(options);
  const timeout = options.timeoutMs ?? DEFAULT_SOCIAL_TIMEOUT_MS;
  const userId = options.userId ?? null;
  const extra = Math.max(0, Math.trunc(options.reasoningTokens ?? 0));
  return async (request) => {
    const bound = request.maxTokens + extra;
    const reservation = options.spend ? await options.spend.reserve({ tenantId: options.tenantId, userId, model, reserveMicros: worstCaseMicros({ ...request, maxTokens: bound }, options.rate) }) : null;
    if (reservation && !reservation.ok) throw new Error(reservation.message);
    const reservationId = reservation?.reservationId ?? null;
    const started = Date.now();
    let answer: GenerateTextAnswer;
    try {
      answer = (await options.generateText({
        model: options.model,
        system: request.system,
        prompt: request.prompt,
        maxOutputTokens: bound,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeout),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      })) as GenerateTextAnswer;
    } catch (error) {
      // Not known whether the provider billed it: the hold stays at its worst case (over, never under).
      if (reservationId && options.spend) await options.spend.settle(reservationId, { usage: null, status: "errored", latencyMs: Date.now() - started, error });
      throw error;
    }
    const cached = count(answer.usage?.cachedInputTokens);
    const usage: PostSpendUsage = {
      model,
      inputTokens: Math.max(0, count(answer.usage?.inputTokens) - cached),
      outputTokens: count(answer.usage?.outputTokens),
      cachedInputTokens: cached,
      cachedWriteTokens: 0,
      reported: answer.usage !== undefined && answer.usage !== null,
    };
    const ranOut = answer.finishReason === "length";
    if (reservationId && options.spend) await options.spend.settle(reservationId, { usage, status: ranOut ? "errored" : "completed", latencyMs: Date.now() - started });
    if (ranOut) throw new Error("the answer ran out of room");
    return answer.text ?? "";
  };
}
