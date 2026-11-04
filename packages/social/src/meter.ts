import type { CompleteRequest } from "./writer.js";

/**
 * THE METER EVERY PROVIDER'S CALL USES (social 0.2.3): the app's ledger
 * holds a call's worst case before it's asked and settles what the provider
 * reported after. Shared by the ready-made calls, Claude (./anthropic.ts) and
 * OpenAI or any Chat Completions service (./openai.ts), and by an app's own.
 */

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
