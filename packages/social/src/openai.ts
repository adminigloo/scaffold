import { DEFAULT_SOCIAL_TIMEOUT_MS, worstCaseMicros, type PostSpend, type PostSpendUsage, type SocialModelRate } from "./meter.js";
import type { Complete } from "./writer.js";

export { DEFAULT_SOCIAL_TIMEOUT_MS, SOCIAL_POST_OPERATION, worstCaseMicros, type PostSpend, type PostSpendUsage, type SocialModelRate } from "./meter.js";

/**
 * @adminigloo/social/openai — ONE POST'S WORDS ON OPENAI, OR ANY SERVICE
 * THAT SPEAKS ITS CHAT COMPLETIONS API, METERED (social 0.2.3).
 *
 *   import OpenAI from "openai";
 *   import { createOpenAIComplete } from "@adminigloo/social/openai";
 *   const complete = createOpenAIComplete({ client: new OpenAI(), model: "<the app's model>", rate, spend, tenantId, userId });
 *   await writePost(source, { complete, honesty, mode: "aside" });
 *
 * ANY AI PROVIDER. The writer only ever calls a `complete(request) => text`:
 * Claude (./anthropic.ts) and this one are two ready-made ones, and an app
 * can hand in its own (the Vercel AI SDK, a gateway, a test double). This one
 * speaks the Chat Completions shape, so it also works with the services that
 * copy it (Azure OpenAI, OpenRouter, Groq, Together, a local server): give it
 * any client with `chat.completions.create`.
 *
 * THE APP NAMES THE MODEL, AND ITS PRICE. There's no default here: the app
 * picks the cheapest model that does the job and passes its `rate`, which is
 * what each call's worst case is held at.
 *
 * THE SAME RULES AS CLAUDE'S. One call per post, JSON in the writer's schema
 * (Structured Outputs, strict: every schema the writer sends allows nothing
 * extra), no retries, 20 seconds at most. Every call is held before it's
 * asked and settled at what the PROVIDER reported. A refused reservation, a
 * refusal from the model or an answer that ran out of room is thrown with its
 * sentence, so the writer puts the app's own words on every platform and the
 * card says why.
 *
 * NO SDK NEEDED: the client is any object of the shape below, the `openai`
 * package's or `openAIFetchClient`'s (plain fetch, an injected key: no
 * package to install). This module never reads a key from the environment.
 *
 * A REASONING MODEL (the gpt-5 family) thinks out of the same bound as its
 * answer: give it `reasoningTokens` of room and `extraBody: { reasoning_effort:
 * "minimal" }`, and the hold covers both.
 */

/** The one method this needs, as the `openai` package's client has it (and the services that copy it). */
export interface ChatCompletionsClient {
  readonly chat: {
    readonly completions: {
      // `any` on purpose: the SDK's own parameter types differ by version and by service.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create(body: any, options?: any): Promise<unknown>;
    };
  };
}

export interface OpenAICompleteOptions {
  /** The app's `new OpenAI()`, or any client of the same shape. */
  readonly client: ChatCompletionsClient;
  /** The model's name, as the service knows it. Required: the app chooses. */
  readonly model: string;
  /** The model's price (micros per million tokens): what the worst case is held at. */
  readonly rate: SocialModelRate;
  /** The meter. Left out, the call isn't held or recorded anywhere: only for an app that meters its own way. */
  readonly spend?: PostSpend;
  /** Whose allowance the call is held against, and who asked. */
  readonly tenantId: string;
  readonly userId?: string | null;
  readonly timeoutMs?: number;
  /**
   * How the answer's length is bound. "max_completion_tokens" (the default)
   * is OpenAI's current name; a service that only knows the older one takes
   * "max_tokens".
   */
  readonly tokenLimit?: "max_completion_tokens" | "max_tokens";
  /**
   * Structured Outputs (the writer's JSON schema, strict) or "json_object"
   * (JSON, unchecked) for a service without them. The writer checks the
   * answer either way.
   */
  readonly format?: "json_schema" | "json_object";
  /**
   * Anything else the service wants in the body: a reasoning model's
   * `reasoning_effort: "minimal"` (a reasoning model spends its thinking from
   * the same small bound, so keep it low), a gateway's own fields.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** Room for a reasoning model's thinking, on top of the writer's bound (default 0). Held too. */
  readonly reasoningTokens?: number;
}

export interface OpenAIFetchClientOptions {
  /** The app's key, from wherever it keeps keys. */
  readonly apiKey: string;
  /** Default https://api.openai.com/v1; any Chat Completions service's own. */
  readonly baseURL?: string;
  readonly fetchFn?: typeof fetch;
  /** More headers a service wants (an organization, a project, a gateway's). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A Chat Completions client over plain fetch: no SDK to install. Errors carry
 * the service's status and message, never the key.
 */
export function openAIFetchClient(options: OpenAIFetchClientOptions): ChatCompletionsClient {
  const base = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  return {
    chat: {
      completions: {
        async create(body: unknown, requestOptions?: { readonly timeout?: number }) {
          const res = await fetchFn(`${base}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}`, ...options.headers },
            body: JSON.stringify(body),
            ...(requestOptions?.timeout ? { signal: AbortSignal.timeout(requestOptions.timeout) } : {}),
          });
          const json = (await res.json().catch(() => null)) as { readonly error?: { readonly message?: string } } | null;
          if (!res.ok) throw new Error(`the AI service said ${res.status}: ${json?.error?.message ?? res.statusText}`.slice(0, 300));
          return json;
        },
      },
    },
  };
}

interface ChatCompletionAnswer {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null; readonly refusal?: string | null } | null;
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number | null } | null;
  } | null;
}

const count = (n: number | null | undefined) => Math.max(0, Math.trunc(n ?? 0));

/** A writer's `complete` over a Chat Completions API: JSON out (the writer's schema), held and settled on the app's meter. */
export function createOpenAIComplete(options: OpenAICompleteOptions): Complete {
  const model = options.model;
  if (typeof model !== "string" || !model.trim()) throw new Error("createOpenAIComplete needs the model's name: the app chooses it.");
  const timeout = options.timeoutMs ?? DEFAULT_SOCIAL_TIMEOUT_MS;
  const userId = options.userId ?? null;
  const tokenLimit = options.tokenLimit ?? "max_completion_tokens";
  const format = options.format ?? "json_schema";
  const extra = Math.max(0, Math.trunc(options.reasoningTokens ?? 0));
  return async (request) => {
    const bound = request.maxTokens + extra;
    const reservation = options.spend ? await options.spend.reserve({ tenantId: options.tenantId, userId, model, reserveMicros: worstCaseMicros({ ...request, maxTokens: bound }, options.rate) }) : null;
    if (reservation && !reservation.ok) throw new Error(reservation.message);
    const reservationId = reservation?.reservationId ?? null;
    const started = Date.now();
    let answer: ChatCompletionAnswer;
    try {
      answer = (await options.client.chat.completions.create(
        {
          ...options.extraBody,
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          [tokenLimit]: bound,
          response_format: format === "json_schema" ? { type: "json_schema", json_schema: { name: "social_post", schema: request.schema, strict: true } } : { type: "json_object" },
        },
        { timeout, maxRetries: 0 },
      )) as ChatCompletionAnswer;
    } catch (error) {
      // Not known whether the provider billed it: the hold stays at its worst case (over, never under).
      if (reservationId && options.spend) await options.spend.settle(reservationId, { usage: null, status: "errored", latencyMs: Date.now() - started, error });
      throw error;
    }
    const cached = count(answer.usage?.prompt_tokens_details?.cached_tokens);
    const usage: PostSpendUsage = {
      model,
      // The service counts cached tokens inside the prompt's; the meter holds them apart, as Claude's does.
      inputTokens: Math.max(0, count(answer.usage?.prompt_tokens) - cached),
      outputTokens: count(answer.usage?.completion_tokens),
      cachedInputTokens: cached,
      cachedWriteTokens: 0,
      reported: answer.usage !== undefined && answer.usage !== null,
    };
    const choice = answer.choices?.[0];
    const ranOut = choice?.finish_reason === "length";
    const refused = choice?.message?.refusal?.trim() || null;
    if (reservationId && options.spend) await options.spend.settle(reservationId, { usage, status: ranOut || refused ? "errored" : "completed", latencyMs: Date.now() - started });
    if (refused) throw new Error(`the model refused: ${refused.slice(0, 120)}`);
    if (ranOut) throw new Error("the answer ran out of room");
    return choice?.message?.content ?? "";
  };
}
