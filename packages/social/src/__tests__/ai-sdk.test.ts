import { describe, expect, it } from "vitest";
import { createAiSdkComplete, worstCaseMicros, type PostSpend, type PostSpendUsage } from "../ai-sdk.js";
import { createOpenAIComplete, openAIFetchClient } from "../openai.js";

/**
 * THE OTHER WAYS IN (social 0.3): the Vercel AI SDK (any provider it has a
 * model for: Trail Deck and Ask Lou already use it), and OpenAI over plain
 * fetch with no SDK (Riddler Go's way), a reasoning model's room included.
 */
const RATE = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 };
const request = { system: "You write for a bakery.", prompt: "Facts: open Saturdays.", maxTokens: 350, schema: { type: "object" } };

function meter() {
  const held: bigint[] = [];
  const settled: { usage: PostSpendUsage | null; status: string }[] = [];
  const spend: PostSpend = {
    async reserve(input) {
      held.push(input.reserveMicros);
      return { ok: true, reservationId: `r${held.length}` };
    },
    async settle(_id, outcome) {
      settled.push({ usage: outcome.usage, status: outcome.status });
    },
  };
  return { spend, held, settled };
}

describe("the Vercel AI SDK call", () => {
  it("asks generateText once with the app's model, no retries and a time limit, and settles its usage", async () => {
    const calls: Record<string, unknown>[] = [];
    const generateText = async (args: Record<string, unknown>) => {
      calls.push(args);
      return { text: '{"hook":"Saturdays now."}', finishReason: "stop", usage: { inputTokens: 400, outputTokens: 60, cachedInputTokens: 100 } };
    };
    const model = { modelId: "claude-haiku-4-5", provider: "anthropic" };
    const { spend, held, settled } = meter();
    const complete = createAiSdkComplete({ generateText, model, rate: RATE, spend, tenantId: "company-a", providerOptions: { anthropic: { cacheControl: true } } });
    expect(await complete(request)).toBe('{"hook":"Saturdays now."}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model, system: request.system, prompt: request.prompt, maxOutputTokens: 350, maxRetries: 0, providerOptions: { anthropic: { cacheControl: true } } });
    expect(calls[0]!.abortSignal).toBeInstanceOf(AbortSignal);
    expect(held).toEqual([worstCaseMicros(request, RATE)]);
    expect(settled).toEqual([{ status: "completed", usage: { model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 60, cachedInputTokens: 100, cachedWriteTokens: 0, reported: true } }]);
  });

  it("gives a reasoning model its room, held too; settles a cut-off answer as errored; needs a model name", async () => {
    let asked = 0;
    const generateText = async (args: { maxOutputTokens: number }) => {
      asked = args.maxOutputTokens;
      return { text: '{"hook":"Satur', finishReason: "length", usage: { inputTokens: 400, outputTokens: 1350 } };
    };
    const { spend, held, settled } = meter();
    const complete = createAiSdkComplete({ generateText, model: { modelId: "gpt-reasoning-test" }, rate: RATE, spend, tenantId: "company-a", reasoningTokens: 1000 });
    await expect(complete(request)).rejects.toThrow("ran out of room");
    expect(asked).toBe(1350);
    expect(held).toEqual([worstCaseMicros({ ...request, maxTokens: 1350 }, RATE)]);
    expect(settled[0]).toMatchObject({ status: "errored" });
    expect(() => createAiSdkComplete({ generateText, model: {}, rate: RATE, tenantId: "company-a" })).toThrow("needs the model's name");
    expect(createAiSdkComplete({ generateText, model: {}, modelName: "named", rate: RATE, tenantId: "company-a" })).toBeTypeOf("function");
  });
});

describe("OpenAI over plain fetch", () => {
  it("posts to the service's /chat/completions with the key in the header, and never puts the key in an error", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"hook":"Hi."}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = openAIFetchClient({ apiKey: "sk-test-secret", baseURL: "https://gateway.example/v1/", fetchFn: ok, headers: { "x-project": "riddler" } });
    const complete = createOpenAIComplete({ client, model: "gpt-mini-test", rate: RATE, tenantId: "company-a", reasoningTokens: 500, extraBody: { reasoning_effort: "minimal" } });
    expect(await complete(request)).toBe('{"hook":"Hi."}');
    expect(seen[0]!.url).toBe("https://gateway.example/v1/chat/completions");
    expect(seen[0]!.init.headers).toMatchObject({ authorization: "Bearer sk-test-secret", "x-project": "riddler" });
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ model: "gpt-mini-test", max_completion_tokens: 850, reasoning_effort: "minimal" });

    const denied = (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 })) as unknown as typeof fetch;
    const bad = createOpenAIComplete({ client: openAIFetchClient({ apiKey: "sk-test-secret", fetchFn: denied }), model: "gpt-mini-test", rate: RATE, tenantId: "company-a" });
    const error = await bad(request).catch((e: Error) => e);
    expect(String(error)).toContain("the AI service said 401: Incorrect API key provided");
    expect(String(error)).not.toContain("sk-test-secret");
  });
});
