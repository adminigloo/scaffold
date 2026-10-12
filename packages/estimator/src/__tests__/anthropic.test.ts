import { describe, expect, it } from "vitest";
import { createAnthropicTakeoffRunner, DEFAULT_TAKEOFF_MODEL, type AnthropicMessagesClient } from "../anthropic.js";
import { observationJsonSchema, TAKEOFF_SYSTEM_PROMPT } from "../takeoff.js";

/**
 * The one model call, against a fake client: the request must be EXACTLY
 * section 5.6's — the cheapest model, 150 tokens, temperature 0, structured
 * output, the image before the text, and nothing else (no thinking, no tools,
 * no cache marker).
 */

function fakeClient(reply: { stop_reason: string; text?: string; usage?: { input_tokens: number; output_tokens: number } } | Error) {
  const calls: Array<{ body: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const client = {
    messages: {
      async create(body: Record<string, unknown>, options: Record<string, unknown>) {
        calls.push({ body, options });
        if (reply instanceof Error) throw reply;
        return {
          stop_reason: reply.stop_reason,
          content: reply.text === undefined ? [] : [{ type: "text", text: reply.text }],
          usage: reply.usage ?? { input_tokens: 690, output_tokens: 38 },
        };
      },
    },
  } as unknown as AnthropicMessagesClient;
  return { client, calls };
}

const request = {
  system: TAKEOFF_SYSTEM_PROMPT,
  prompt: "Photo of: the steps up to the door.",
  schema: observationJsonSchema("ramp_over_steps"),
  image: { base64: "AAAA", mediaType: "image/jpeg" as const },
  maxTokens: 150,
};

describe("createAnthropicTakeoffRunner", () => {
  it("sends exactly the contract's request", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", text: '{"seen":true,"risers":3,"riserHeightIn":null,"confidence":"high"}' });
    const runner = createAnthropicTakeoffRunner({ client });
    expect(runner.model).toBe("claude-haiku-4-5");
    expect(DEFAULT_TAKEOFF_MODEL).toBe("claude-haiku-4-5");
    await runner.read(request);
    expect(calls).toHaveLength(1);
    const { body, options } = calls[0]!;
    expect(body).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 150,
      temperature: 0,
      system: TAKEOFF_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
            { type: "text", text: "Photo of: the steps up to the door." },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: request.schema } },
    });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(options).toEqual({ timeout: 12_000, maxRetries: 0 }); // one bounded call, no retry (review ADV-6)
  });

  it("parses end_turn JSON and passes the usage through", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", text: '{"seen":true,"risers":3}', usage: { input_tokens: 701, output_tokens: 41 } });
    expect(await createAnthropicTakeoffRunner({ client }).read(request)).toEqual({
      output: { seen: true, risers: 3 },
      inputTokens: 701,
      outputTokens: 41,
      stopReason: "end_turn",
    });
  });

  it("refusal, max_tokens and text that isn't JSON are output: null", async () => {
    for (const reply of [
      { stop_reason: "refusal", text: "I can't help with that." },
      { stop_reason: "max_tokens", text: '{"seen":tr' },
      { stop_reason: "end_turn", text: "about 3 steps" },
    ]) {
      const { client } = fakeClient(reply);
      expect((await createAnthropicTakeoffRunner({ client }).read(request)).output).toBeNull();
    }
  });

  it("an unknown model needs its rates, at construction; the timeout option is passed", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", text: "{}" });
    expect(() => createAnthropicTakeoffRunner({ client, model: "claude-opus-5" })).toThrow(/no price for model "claude-opus-5"/);
    const custom = createAnthropicTakeoffRunner({
      client,
      model: "claude-opus-5",
      rates: { inputMicrosPerMTok: 5_000_000, outputMicrosPerMTok: 25_000_000 },
      timeoutMs: 5_000,
    });
    await custom.read(request);
    expect(calls[0]!.body["model"]).toBe("claude-opus-5");
    expect(calls[0]!.options).toEqual({ timeout: 5_000, maxRetries: 0 });
  });

  it("the SDK's errors propagate (the pipeline catches them)", async () => {
    const { client } = fakeClient(Object.assign(new Error("Overloaded"), { status: 529 }));
    await expect(createAnthropicTakeoffRunner({ client }).read(request)).rejects.toThrow("Overloaded");
  });
});
