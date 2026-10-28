import { describe, expect, it } from "vitest";
import { createAnthropicComplete, DEFAULT_SOCIAL_MODEL, worstCaseMicros, type AnthropicCompleteOptions, type PostSpend, type PostSpendUsage } from "../anthropic.js";
import { writePost } from "../writer.js";
import { launchSource } from "../sources.js";

/**
 * THE METERED CLAUDE CALL (../anthropic.ts) against a fake client and a fake
 * meter: the worst case is held before the call and refused calls never
 * reach the model; what the provider reported is settled after; a failure
 * keeps the hold; and the writer turns a refusal into the app's own words
 * with the reason.
 */
const HAIKU = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 };

interface Held {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly model: string;
  readonly reserveMicros: bigint;
}

function meter(refuse: string | null = null) {
  const held: Held[] = [];
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

function client(answer: { text?: string; stop?: string; fail?: Error }) {
  const asked: unknown[] = [];
  const fake = {
    messages: {
      create: async (params: unknown, options: unknown) => {
        asked.push({ params, options });
        if (answer.fail) throw answer.fail;
        return {
          content: [{ type: "text", text: answer.text ?? "{}" }],
          stop_reason: answer.stop ?? "end_turn",
          usage: { input_tokens: 412, output_tokens: 61, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  } as unknown as AnthropicCompleteOptions["client"];
  return { fake, asked };
}

const request = { system: "You write for a bakery.", prompt: "Facts: open Saturdays.", maxTokens: 350, schema: { type: "object" } };

describe("the metered call", () => {
  it("holds the worst case, asks Haiku once for the JSON shape, and settles what the provider reported", async () => {
    const { spend, held, settled } = meter();
    const { fake, asked } = client({ text: '{"hook":"Saturdays now."}' });
    const complete = createAnthropicComplete({ client: fake, rate: HAIKU, spend, tenantId: "company-a", userId: "user-1" });
    expect(await complete(request)).toBe('{"hook":"Saturdays now."}');
    expect(held).toEqual([{ tenantId: "company-a", userId: "user-1", model: DEFAULT_SOCIAL_MODEL, reserveMicros: worstCaseMicros(request, HAIKU) }]);
    expect(settled).toEqual([{ id: "r1", status: "completed", usage: { model: "claude-haiku-4-5", inputTokens: 412, outputTokens: 61, cachedInputTokens: 0, cachedWriteTokens: 0, reported: true } }]);
    const [{ params, options }] = asked as [{ params: Record<string, unknown>; options: Record<string, unknown> }];
    expect(params).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 350, system: request.system, messages: [{ role: "user", content: request.prompt }], output_config: { format: { type: "json_schema", schema: request.schema } } });
    expect(options).toEqual({ timeout: 20_000, maxRetries: 0 });
  });

  it("never asks the model when the allowance refuses, and says why", async () => {
    const { spend, settled } = meter("This month's AI posts are used up.");
    const { fake, asked } = client({ text: "{}" });
    const complete = createAnthropicComplete({ client: fake, rate: HAIKU, spend, tenantId: "company-a" });
    await expect(complete(request)).rejects.toThrow("This month's AI posts are used up.");
    expect(asked).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("keeps the hold on a failed call (over, never under), and settles a cut-off answer as errored", async () => {
    const failing = meter();
    const down = createAnthropicComplete({ client: client({ fail: new Error("overloaded") }).fake, rate: HAIKU, spend: failing.spend, tenantId: "company-a" });
    await expect(down(request)).rejects.toThrow("overloaded");
    expect(failing.settled).toEqual([{ id: "r1", usage: null, status: "errored" }]);

    const cut = meter();
    const long = createAnthropicComplete({ client: client({ text: '{"hook":"Satur', stop: "max_tokens" }).fake, rate: HAIKU, spend: cut.spend, tenantId: "company-a" });
    await expect(long(request)).rejects.toThrow("ran out of room");
    expect(cut.settled[0]).toMatchObject({ status: "errored", usage: { outputTokens: 61 } });
  });

  it("prices the worst case from every character and the whole answer, rounded up", () => {
    // (23 + 22 + 64) characters as tokens at $1/M = 109 micros; 350 tokens at $5/M = 1,750 micros.
    expect(worstCaseMicros(request, HAIKU)).toBe(109n + 1_750n);
    expect(worstCaseMicros({ system: "", prompt: "", maxTokens: 0 }, { inputMicrosPerMTok: 3, outputMicrosPerMTok: 3 })).toBe(1n);
  });

  it("turns a refusal into the app's own words on every platform, with the reason on the card", async () => {
    const { spend } = meter("This month's AI posts are used up. They start again on November 1.");
    const complete = createAnthropicComplete({ client: client({ text: "{}" }).fake, rate: HAIKU, spend, tenantId: "company-a" });
    const source = launchSource({ key: "launch:1", facts: "Open on Saturdays from Nov 1.", author: "Maple & Rye", voice: "Plain.", day: "2026-10-27", link: null, platforms: ["x", "linkedin"], images: () => [] });
    const written = await writePost(source, { complete, mode: "aside" });
    expect(written.map((w) => [w.writtenBy, w.note])).toEqual([
      ["template", "Code's hook, no aside: the AI call failed: This month's AI posts are used up. They start again on November 1."],
      ["template", "Code's hook, no aside: the AI call failed: This month's AI posts are used up. They start again on November 1."],
    ]);
  });
});
