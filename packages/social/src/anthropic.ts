import type Anthropic from "@anthropic-ai/sdk";
import type { Complete, CompleteRequest } from "./writer.js";

/**
 * @adminigloo/social/anthropic — ONE POST'S WORDS ON CLAUDE, METERED
 * (social 0.1).
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { createAnthropicComplete } from "@adminigloo/social/anthropic";
 *   const complete = createAnthropicComplete({ client: new Anthropic(), rate, spend, tenantId, userId });
 *   await writePost(source, { complete, honesty, mode: "aside" });
 *
 * CHEAPEST CAPABLE MODEL BY DEFAULT: Claude Haiku 4.5 ($1 in, $5 out per
 * million tokens). One call per post, its answer a small JSON object (the
 * hook and two asides in "aside" mode: about 350 tokens at most), no
 * thinking, no tools, no retries, 20 seconds at most. About a third of a
 * cent a post at worst.
 *
 * EVERY CALL IS HELD, THEN SETTLED. `spend.reserve` holds the call's worst
 * case against the company's allowance before it's asked (the app's ledger:
 * create-app wires @adminigloo/ai's reserveAiAllowance), and `spend.settle`
 * records what the PROVIDER reported (never the model's word). A refused
 * reservation is thrown with its sentence, so the writer puts the app's own
 * words on every platform and the card says why ("This month's AI posts are
 * used up…").
 *
 * TYPE-ONLY SDK IMPORT: @anthropic-ai/sdk is an OPTIONAL peer; the app
 * builds the client and owns the key, and this module never reads a key.
 */

/** Claude Haiku 4.5: the founder's default for every AI feature — the cheapest model that does the job. */
export const DEFAULT_SOCIAL_MODEL = "claude-haiku-4-5";
/** What each call is counted as on the app's ledger. */
export const SOCIAL_POST_OPERATION = "social_post";
/** How long one call may take before it's given up (no retry): the writer then uses the app's own words. */
export const DEFAULT_SOCIAL_TIMEOUT_MS = 20_000;

/** A model's price, as @adminigloo/ai's rate table holds it: micros per million tokens. */
export interface SocialModelRate {
  readonly inputMicrosPerMTok: number;
  readonly outputMicrosPerMTok: number;
}

/** What one call used, as the provider reported it. */
export interface PostSpendUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cachedWriteTokens: number;
  readonly reported: boolean;
}

/** The app's meter: hold the worst case before the call, settle what it cost after. */
export interface PostSpend {
  reserve(input: { readonly tenantId: string; readonly userId: string | null; readonly model: string; readonly reserveMicros: bigint }): Promise<{ readonly ok: true; readonly reservationId: string } | { readonly ok: false; readonly message: string }>;
  settle(reservationId: string, outcome: { readonly usage: PostSpendUsage | null; readonly status: "completed" | "errored"; readonly latencyMs: number; readonly error?: unknown }): Promise<void>;
}

export interface AnthropicCompleteOptions {
  /** The app's `new Anthropic()`. */
  readonly client: Pick<Anthropic, "messages">;
  /** Default DEFAULT_SOCIAL_MODEL. */
  readonly model?: string;
  /** The model's price (the app's MODEL_RATES row): what the worst case is held at. */
  readonly rate: SocialModelRate;
  /** The meter. Left out, the call isn't held or recorded anywhere: only for an app that meters its own way. */
  readonly spend?: PostSpend;
  /** Whose allowance the call is held against, and who asked. */
  readonly tenantId: string;
  readonly userId?: string | null;
  readonly timeoutMs?: number;
}

/**
 * THE MOST ONE CALL CAN COST, in micros, before it's asked: every character
 * of the instructions and the facts counted as a token (English runs about
 * four characters a token, so this is a ceiling for any language), 64 more
 * for the message's framing, and the whole answer bound. Rounded up.
 */
export function worstCaseMicros(request: Pick<CompleteRequest, "system" | "prompt" | "maxTokens">, rate: SocialModelRate): bigint {
  const inputTokens = request.system.length + request.prompt.length + 64;
  const perMillion = (tokens: number, micros: number) => (BigInt(Math.ceil(tokens)) * BigInt(Math.ceil(micros)) + 999_999n) / 1_000_000n;
  return perMillion(inputTokens, rate.inputMicrosPerMTok) + perMillion(Math.max(0, request.maxTokens), rate.outputMicrosPerMTok);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")).join("");
}

/** A writer's `complete` over the Anthropic Messages API: JSON out (the writer's schema), held and settled on the app's meter. */
export function createAnthropicComplete(options: AnthropicCompleteOptions): Complete {
  const model = options.model ?? DEFAULT_SOCIAL_MODEL;
  const timeout = options.timeoutMs ?? DEFAULT_SOCIAL_TIMEOUT_MS;
  const userId = options.userId ?? null;
  return async (request) => {
    const reservation = options.spend ? await options.spend.reserve({ tenantId: options.tenantId, userId, model, reserveMicros: worstCaseMicros(request, options.rate) }) : null;
    if (reservation && !reservation.ok) throw new Error(reservation.message);
    const reservationId = reservation?.reservationId ?? null;
    const started = Date.now();
    let response: Awaited<ReturnType<AnthropicCompleteOptions["client"]["messages"]["create"]>>;
    try {
      response = await options.client.messages.create(
        {
          model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          output_config: { format: { type: "json_schema", schema: request.schema as Record<string, unknown> } },
        },
        { timeout, maxRetries: 0 },
      );
    } catch (error) {
      // Not known whether the provider billed it: the hold stays at its worst case (over, never under).
      if (reservationId && options.spend) await options.spend.settle(reservationId, { usage: null, status: "errored", latencyMs: Date.now() - started, error });
      throw error;
    }
    const message = response as unknown as {
      readonly content?: unknown;
      readonly stop_reason?: string | null;
      readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly cache_read_input_tokens?: number | null; readonly cache_creation_input_tokens?: number | null };
    };
    const usage: PostSpendUsage = {
      model,
      inputTokens: Math.max(0, Math.trunc(message.usage?.input_tokens ?? 0)),
      outputTokens: Math.max(0, Math.trunc(message.usage?.output_tokens ?? 0)),
      cachedInputTokens: Math.max(0, Math.trunc(message.usage?.cache_read_input_tokens ?? 0)),
      cachedWriteTokens: Math.max(0, Math.trunc(message.usage?.cache_creation_input_tokens ?? 0)),
      reported: message.usage !== undefined,
    };
    const ranOut = message.stop_reason === "max_tokens";
    if (reservationId && options.spend) await options.spend.settle(reservationId, { usage, status: ranOut ? "errored" : "completed", latencyMs: Date.now() - started });
    if (ranOut) throw new Error("the answer ran out of room");
    return textOf(message.content);
  };
}
