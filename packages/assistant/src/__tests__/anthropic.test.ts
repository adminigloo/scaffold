import { describe, expect, it } from "vitest";
import {
  classifyAnthropicError,
  createAnthropicProvider,
  DEFAULT_ASSISTANT_MODEL,
  withPromptCache,
  type AnthropicStreamingClient,
} from "../anthropic.js";
import type { ProviderEvent } from "../provider.js";

/**
 * The Anthropic adapter against a FAKE client — the tests never call the real
 * API. What matters: the cheapest model by default, the two cache
 * breakpoints, the stream mapped to the loop's events, the usage taken from
 * the provider's own report, an abort that is a stop (not a crash), and a
 * failure that becomes a plain class instead of a throw.
 */

type RawEvent = Record<string, unknown>;

function fakeClient(events: RawEvent[], options: { throwAfter?: number; error?: unknown } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      stream(body: Record<string, unknown>) {
        sent.push(body);
        return {
          async *[Symbol.asyncIterator]() {
            let i = 0;
            for (const event of events) {
              if (options.throwAfter !== undefined && i === options.throwAfter) throw options.error;
              i += 1;
              yield event;
            }
            if (options.throwAfter !== undefined && i >= options.throwAfter) throw options.error;
          },
        };
      },
    },
  } as unknown as AnthropicStreamingClient;
  return { client, sent };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const request = {
  system: "You are the assistant.",
  messages: [{ role: "user" as const, blocks: [{ kind: "text" as const, text: "hi" }] }],
  tools: [{ name: "jobs_on_day", description: "Jobs", inputSchema: { type: "object", properties: {} } }],
  maxTokens: 1024,
};

describe("the Anthropic adapter", () => {
  it("calls Claude Haiku 4.5 by default, and the model is configurable", () => {
    expect(DEFAULT_ASSISTANT_MODEL).toBe("claude-haiku-4-5");
    expect(createAnthropicProvider({ client: fakeClient([]).client }).modelId).toBe("claude-haiku-4-5");
    expect(createAnthropicProvider({ client: fakeClient([]).client, model: "claude-sonnet-4-6" }).modelId).toBe("claude-sonnet-4-6");
  });

  it("marks two cache breakpoints: the end of the system prompt and the end of the newest message", () => {
    const out = withPromptCache("System.", [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] },
    ]);
    expect(out.system).toEqual([{ type: "text", text: "System.", cache_control: { type: "ephemeral" } }]);
    const marked = JSON.stringify(out.messages).match(/cache_control/g) ?? [];
    expect(marked).toHaveLength(1);
    expect(out.messages.at(-1)?.content).toEqual([
      { type: "text", text: "b" },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
    ]);
    expect(withPromptCache("", []).system).toEqual([]);
  });

  it("streams text, assembles a tool call, and reports the PROVIDER's token counts", async () => {
    const { client, sent } = fakeClient([
      { type: "message_start", message: { usage: { input_tokens: 812, cache_read_input_tokens: 4_200, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "jobs_on_day" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"day":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"2026-10-17"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 37 } },
    ]);
    const events = await collect(createAnthropicProvider({ client }).stream(request));
    expect(events).toEqual([
      { type: "text-delta", delta: "Checking" },
      { type: "tool-call", toolCallId: "tu_1", name: "jobs_on_day", input: { day: "2026-10-17" } },
      {
        type: "step-end",
        stopReason: "tool_use",
        usage: { inputTokens: 812, outputTokens: 37, cacheReadTokens: 4_200, cacheWriteTokens: 0, reported: true },
      },
    ]);
    expect(sent[0]).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 1024 });
    expect((sent[0]?.system as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("turns a stop into step-end{aborted} — keeping what it had, never a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    const { client } = fakeClient([{ type: "message_start", message: { usage: { input_tokens: 5 } } }], { throwAfter: 1, error: abortError });
    const events = await collect(createAnthropicProvider({ client }).stream({ ...request, signal: controller.signal }));
    // CUT SHORT, NOT FREE: the input Anthropic reported at message_start, the
    // output streamed so far, marked an estimate — never "unreported".
    expect(events.at(-1)).toMatchObject({ type: "step-end", stopReason: "aborted", usage: { inputTokens: 5, reported: true, estimated: true } });
  });

  it("charges the text streamed before a stop as output", async () => {
    const abortError = Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    const { client } = fakeClient(
      [
        { type: "message_start", message: { usage: { input_tokens: 9_000 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(370) } },
      ],
      { throwAfter: 3, error: abortError },
    );
    const events = await collect(createAnthropicProvider({ client }).stream(request));
    expect(events.at(-1)).toMatchObject({ stopReason: "aborted", usage: { inputTokens: 9_000, outputTokens: 100, reported: true } });
  });

  it("turns a failure into a plain class and still ends the step (so its tokens are metered)", async () => {
    const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
    const { client } = fakeClient([{ type: "message_start", message: { usage: { input_tokens: 9 } } }], { throwAfter: 1, error: overloaded });
    const events = await collect(createAnthropicProvider({ client }).stream(request));
    expect(events).toEqual([
      { type: "provider-error", errorClass: "provider_overloaded", message: "The assistant's model is overloaded. Please try again shortly." },
      { type: "step-end", stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false } },
    ]);
    expect(classifyAnthropicError(Object.assign(new Error("x"), { status: 429 })).errorClass).toBe("rate_limited");
    expect(classifyAnthropicError(new Error("weird")).message).toBe("Something went wrong. Please try again.");
  });
});
