/**
 * @adminigloo/estimator/anthropic — the photo reading on Claude (section 5.6
 * of the 0.3 contract).
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { createAnthropicTakeoffRunner } from "@adminigloo/estimator/anthropic";
 *   const takeoff = { model: createAnthropicTakeoffRunner({ client: new Anthropic() }) };
 *   createEstimatorHandlers({ …, takeoff });
 *
 * ONE SMALL CALL PER PHOTO, and nothing else. Claude Haiku 4.5 by default — the
 * founder's choice, the cheapest capable model ($1 / $5 per million tokens) —
 * with the photo the browser already shrank to ≤ 768 px, a few short prompt
 * lines, a strict JSON schema as the structured output, 150 output tokens at
 * most, temperature 0, no thinking, no tools, no streaming, no retry, and 12
 * seconds at most. About a tenth of a
 * cent a photo; the eval (`eval/takeoff/`) measures the real figure.
 *
 * NO PROMPT CACHING, ON PURPOSE. Haiku 4.5 caches only a prefix of 4096 tokens
 * or more; this request's fixed part is a few hundred and the image differs
 * every call, so a cache marker would save nothing.
 *
 * TYPE-ONLY SDK IMPORT. @anthropic-ai/sdk is an OPTIONAL peer and this is the
 * only module that names it: the app constructs the client (and owns the key),
 * so this package never instantiates the SDK or reads a key. No error, log
 * line or ledger row ever contains the key or the image.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_TAKEOFF_MODEL,
  TAKEOFF_MODEL_RATES,
  type TakeoffModel,
  type TakeoffModelRequest,
  type TakeoffModelResponse,
  type TakeoffRates,
} from "./takeoff.js";

export {
  DEFAULT_TAKEOFF_MODEL,
  TAKEOFF_MODEL_RATES,
  type TakeoffModel,
  type TakeoffModelRequest,
  type TakeoffModelResponse,
  type TakeoffRates,
} from "./takeoff.js";

/** How long one reading may take before it is abandoned (no retry). Well inside a 30-second route. */
export const DEFAULT_TAKEOFF_TIMEOUT_MS = 12_000;

/** The slice of the Anthropic client the runner uses: `messages.create`. */
export type AnthropicMessagesClient = Pick<Anthropic, "messages">;

export interface AnthropicTakeoffOptions {
  /** The app's `new Anthropic()`; this package never reads a key. */
  client: AnthropicMessagesClient;
  /** Default `DEFAULT_TAKEOFF_MODEL` ("claude-haiku-4-5"). */
  model?: string;
  /** Required when `model` isn't in `TAKEOFF_MODEL_RATES` (the runner throws at construction). */
  rates?: TakeoffRates;
  /**
   * Default 12000, and NO retry: the reading is one bounded call inside a
   * route that has 30 seconds (create-app's `maxDuration`). 20 s with one
   * retry could run 40 s and be killed mid-call — the customer got a 504
   * instead of "count the steps", and a billed call never reached the budget
   * (review ADV-6). A failed reading is cheap to replace: the customer types
   * the count.
   */
  timeoutMs?: number;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

/**
 * A `TakeoffModel` over the Anthropic Messages API. The SDK's typed errors
 * propagate (network, timeout, 5xx): the pipeline catches them, marks the
 * reading failed and answers "enter it by hand".
 */
export function createAnthropicTakeoffRunner(options: AnthropicTakeoffOptions): TakeoffModel {
  const model = options.model ?? DEFAULT_TAKEOFF_MODEL;
  const rates = options.rates ?? TAKEOFF_MODEL_RATES[model];
  if (!rates) {
    throw new Error(
      `createAnthropicTakeoffRunner: no price for model "${model}". Pass \`rates\` (micro-dollars per million input and output tokens) so every reading's cost is recorded.`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TAKEOFF_TIMEOUT_MS;
  const { client } = options;

  return {
    model,
    rates,
    async read(request: TakeoffModelRequest): Promise<TakeoffModelResponse> {
      // The one call (do not add parameters: the eval measures exactly this).
      const response = await client.messages.create(
        {
          model,
          max_tokens: request.maxTokens,
          temperature: 0,
          system: request.system,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: request.image.mediaType, data: request.image.base64 },
                },
                { type: "text", text: request.prompt },
              ],
            },
          ],
          output_config: { format: { type: "json_schema", schema: request.schema } },
        },
        { timeout: timeoutMs, maxRetries: 0 },
      );
      const stopReason = (response as { stop_reason?: string | null }).stop_reason ?? null;
      const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      let output: unknown = null;
      if (stopReason === "end_turn") {
        const text = firstText((response as { content?: unknown }).content);
        if (text !== null) {
          try {
            output = JSON.parse(text);
          } catch {
            output = null;
          }
        }
      }
      return {
        output,
        inputTokens: Math.max(0, Math.trunc(usage?.input_tokens ?? 0)),
        outputTokens: Math.max(0, Math.trunc(usage?.output_tokens ?? 0)),
        stopReason,
      };
    },
  };
}
