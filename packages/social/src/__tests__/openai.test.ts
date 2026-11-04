import { describe, expect, it } from "vitest";
import { createOpenAIComplete, worstCaseMicros, type ChatCompletionsClient, type PostSpend, type PostSpendUsage } from "../openai.js";
import { launchSource } from "../sources.js";
import { writePost } from "../writer.js";

/**
 * THE METERED OPENAI CALL (../openai.ts, social 0.2.3) against a fake client
 * and a fake meter, the same rules as Claude's (./anthropic.test.ts): the
 * worst case held first and a refused hold never reaching the model, what
 * the provider reported settled after, a failure keeping its hold; plus
 * what's OpenAI's own: the model the app names, Structured Outputs, cached
 * tokens held apart, a refusal, and a service that copies the API.
 */
const MINI = { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 2_000_000 };

function meter(refuse: string | null = null) {
  const held: { tenantId: string; userId: string | null; model: string; reserveMicros: bigint }[] = [];
  const settled: { id: string; usage: PostSpendUsage | null; status: string }[] = [];
  const spend: PostSpend = {
    async reserve(input) {
      held.push(input);
      return refuse ? { ok: false, message: refuse } : { ok: true, reservationId: `r${held.length}` };
    },
    async settle(id, outcome) {
      settled.push({ id, usage: outcome.usage, status: outcome.status });
    },
  };
  return { spend, held, settled };
}

function client(answer: { text?: string | null; finish?: string; refusal?: string; fail?: Error; cached?: number }) {
  const asked: { body: Record<string, unknown>; options: unknown }[] = [];
  const fake: ChatCompletionsClient = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>, options: unknown) => {
          asked.push({ body, options });
          if (answer.fail) throw answer.fail;
          return {
            choices: [{ message: { content: answer.text === undefined ? "{}" : answer.text, refusal: answer.refusal ?? null }, finish_reason: answer.finish ?? "stop" }],
            usage: { prompt_tokens: 412, completion_tokens: 61, prompt_tokens_details: { cached_tokens: answer.cached ?? 0 } },
          };
        },
      },
    },
  };
  return { fake, asked };
}

const schema = { type: "object", properties: { hook: { type: "string" } }, required: ["hook"], additionalProperties: false };
const request = { system: "You write for a bakery.", prompt: "Facts: open Saturdays.", maxTokens: 350, schema };

describe("the metered OpenAI call", () => {
  it("holds the worst case, asks the app's model once for the writer's JSON, and settles what the provider reported", async () => {
    const { spend, held, settled } = meter();
    const { fake, asked } = client({ text: '{"hook":"Saturdays now."}' });
    const complete = createOpenAIComplete({ client: fake, model: "gpt-mini-test", rate: MINI, spend, tenantId: "company-a", userId: "user-1" });
    expect(await complete(request)).toBe('{"hook":"Saturdays now."}');
    expect(held).toEqual([{ tenantId: "company-a", userId: "user-1", model: "gpt-mini-test", reserveMicros: worstCaseMicros(request, MINI) }]);
    expect(settled).toEqual([{ id: "r1", status: "completed", usage: { model: "gpt-mini-test", inputTokens: 412, outputTokens: 61, cachedInputTokens: 0, cachedWriteTokens: 0, reported: true } }]);
    const { body, options } = asked[0]!;
    expect(body).toEqual({
      model: "gpt-mini-test",
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      max_completion_tokens: 350,
      response_format: { type: "json_schema", json_schema: { name: "social_post", schema, strict: true } },
    });
    expect(options).toEqual({ timeout: 20_000, maxRetries: 0 });
  });

  it("needs the app to name the model: there's no default to guess", () => {
    expect(() => createOpenAIComplete({ client: client({}).fake, model: "", rate: MINI, tenantId: "company-a" })).toThrow("needs the model's name");
  });

  it("never asks the model when the allowance refuses, and says why", async () => {
    const { spend, settled } = meter("This month's AI posts are used up.");
    const { fake, asked } = client({});
    const complete = createOpenAIComplete({ client: fake, model: "gpt-mini-test", rate: MINI, spend, tenantId: "company-a" });
    await expect(complete(request)).rejects.toThrow("This month's AI posts are used up.");
    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("keeps the hold on a failed call, and settles a cut-off answer and a refusal as errored", async () => {
    const failing = meter();
    const down = createOpenAIComplete({ client: client({ fail: new Error("rate limited") }).fake, model: "gpt-mini-test", rate: MINI, spend: failing.spend, tenantId: "company-a" });
    await expect(down(request)).rejects.toThrow("rate limited");
    expect(failing.settled).toEqual([{ id: "r1", usage: null, status: "errored" }]);

    const cut = meter();
    const long = createOpenAIComplete({ client: client({ text: '{"hook":"Satur', finish: "length" }).fake, model: "gpt-mini-test", rate: MINI, spend: cut.spend, tenantId: "company-a" });
    await expect(long(request)).rejects.toThrow("ran out of room");
    expect(cut.settled[0]).toMatchObject({ status: "errored", usage: { outputTokens: 61 } });

    const no = meter();
    const refusing = createOpenAIComplete({ client: client({ text: null, refusal: "I can't help with that." }).fake, model: "gpt-mini-test", rate: MINI, spend: no.spend, tenantId: "company-a" });
    await expect(refusing(request)).rejects.toThrow("the model refused: I can't help with that.");
    expect(no.settled[0]).toMatchObject({ status: "errored" });
  });

  it("holds cached prompt tokens apart, as the meter counts them for Claude", async () => {
    const { spend, settled } = meter();
    const complete = createOpenAIComplete({ client: client({ cached: 256 }).fake, model: "gpt-mini-test", rate: MINI, spend, tenantId: "company-a" });
    await complete(request);
    expect(settled[0]!.usage).toMatchObject({ inputTokens: 412 - 256, cachedInputTokens: 256 });
  });

  it("works with a service that copies the API: the older token bound, plain JSON, and its own fields", async () => {
    const { fake, asked } = client({});
    const complete = createOpenAIComplete({ client: fake, model: "llama-test", rate: MINI, tenantId: "company-a", tokenLimit: "max_tokens", format: "json_object", extraBody: { reasoning_effort: "minimal" } });
    await complete(request);
    const { body } = asked[0]!;
    expect(body).toMatchObject({ model: "llama-test", max_tokens: 350, response_format: { type: "json_object" }, reasoning_effort: "minimal" });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("turns a refused hold into the app's own words on every platform, with the reason on the card", async () => {
    const { spend } = meter("This month's AI posts are used up. They start again on November 1.");
    const complete = createOpenAIComplete({ client: client({}).fake, model: "gpt-mini-test", rate: MINI, spend, tenantId: "company-a" });
    const source = launchSource({ key: "launch:1", facts: "Open on Saturdays from Nov 1.", author: "Maple & Rye", voice: "Plain.", day: "2026-10-27", link: null, platforms: ["x", "linkedin"], images: () => [] });
    const written = await writePost(source, { complete, mode: "aside" });
    expect(written.map((w) => [w.writtenBy, w.note])).toEqual([
      ["template", "Code's hook, no aside: the AI call failed: This month's AI posts are used up. They start again on November 1."],
      ["template", "Code's hook, no aside: the AI call failed: This month's AI posts are used up. They start again on November 1."],
    ]);
  });

  it("writes a post end to end through the writer: the model's hook in, every fact still code's", async () => {
    const answer = JSON.stringify({ hook: "Saturdays are on now.", asides: [{ text: "The flour has won again.", probability: 0.1 }] });
    const complete = createOpenAIComplete({ client: client({ text: answer }).fake, model: "gpt-mini-test", rate: MINI, tenantId: "company-a" });
    const source = launchSource({ key: "launch:2", facts: "We're open Saturdays now, 9 to 1.", author: "Maple & Rye", voice: "Plain.", day: "2026-10-27", link: null, platforms: ["x"], images: () => [] });
    const [x] = await writePost(source, { complete, mode: "aside" });
    expect(x).toMatchObject({ writtenBy: "ai-aside", hook: "Saturdays are on now.", note: null });
    expect(x!.text).toBe("We're open Saturdays now, 9 to 1.\n\nThe flour has won again.");
  });
});
