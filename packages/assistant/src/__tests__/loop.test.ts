import { describe, expect, it } from "vitest";
import { runAssistantLoop, type ToolRun } from "../loop.js";
import type { AssistantStreamEvent } from "../events.js";
import type { NeutralMessage, ProviderAdapter, ProviderEvent, StepUsage } from "../provider.js";

/**
 * The loop tested against a scripted provider — no Postgres, no network, no
 * vendor SDK. Each fake "step" is a list of events; the provider yields the
 * next scripted step per call, which is exactly how the real loop consumes it.
 */
const usage = (over: Partial<StepUsage> = {}): StepUsage => ({
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reported: true,
  ...over,
});

function fakeProvider(steps: ProviderEvent[][]): ProviderAdapter {
  let call = 0;
  return {
    modelId: "fake-1",
    async *stream() {
      const script = steps[call] ?? [{ type: "step-end", stopReason: "end_turn", usage: usage() }];
      call += 1;
      for (const event of script) yield event;
    },
  };
}

const userMessage: NeutralMessage = { role: "user", blocks: [{ kind: "text", text: "hi" }] };

function collect() {
  const events: AssistantStreamEvent[] = [];
  return { events, emit: (e: AssistantStreamEvent) => events.push(e) };
}

const base = {
  system: "you are a test",
  history: [] as NeutralMessage[],
  userMessage,
  tools: [],
  resolveTool: () => null,
  maxSteps: 6,
  maxTokens: 1000,
};

describe("runAssistantLoop", () => {
  it("streams text and completes a no-tool turn", async () => {
    const { events, emit } = collect();
    const provider = fakeProvider([
      [
        { type: "text-delta", delta: "Hello" },
        { type: "text-delta", delta: " there" },
        { type: "step-end", stopReason: "end_turn", usage: usage() },
      ],
    ]);
    const result = await runAssistantLoop({ ...base, provider, emit });

    expect(result.status).toBe("complete");
    expect(result.steps).toBe(1);
    expect(result.blocks).toEqual([{ kind: "text", text: "Hello there" }]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "Hello",
      " there",
    ]);
  });

  it("runs a tool then answers, emitting a step event that clears preamble", async () => {
    const { events, emit } = collect();
    const provider = fakeProvider([
      [
        { type: "text-delta", delta: "Let me check…" },
        { type: "tool-call", toolCallId: "t1", name: "lookup", input: { q: 1 } },
        { type: "step-end", stopReason: "tool_use", usage: usage() },
      ],
      [
        { type: "text-delta", delta: "You have 3 open." },
        { type: "step-end", stopReason: "end_turn", usage: usage() },
      ],
    ]);
    const run: ToolRun = {
      toolCallId: "t1",
      name: "lookup",
      input: { q: 1 },
      label: "Ticket lookup",
      execute: async () => ({ result: { open: 3 } }),
    };
    const result = await runAssistantLoop({
      ...base,
      provider,
      emit,
      resolveTool: (c) => (c.name === "lookup" ? { ...run, toolCallId: c.toolCallId } : null),
    });

    expect(result.status).toBe("complete");
    expect(result.steps).toBe(2);
    // The step event fires so the widget drops the "Let me check…" bubble.
    const step = events.find((e) => e.type === "step");
    expect(step).toMatchObject({ type: "step", tools: [{ label: "Ticket lookup" }] });
    // The tool result is in the persisted transcript, in provider-replay order.
    expect(result.blocks.some((b) => b.kind === "tool-result" && !b.isError)).toBe(true);
    // Usage summed across both steps.
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.complete).toBe(true);
  });

  it("answers every parallel tool call id, and never throws when one fails", async () => {
    const { emit } = collect();
    const provider = fakeProvider([
      [
        { type: "tool-call", toolCallId: "a", name: "ok", input: {} },
        { type: "tool-call", toolCallId: "b", name: "boom", input: {} },
        { type: "step-end", stopReason: "tool_use", usage: usage() },
      ],
      [{ type: "step-end", stopReason: "end_turn", usage: usage() }],
    ]);
    const result = await runAssistantLoop({
      ...base,
      provider,
      emit,
      resolveTool: (c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        input: c.input,
        label: c.name,
        execute:
          c.name === "boom"
            ? async () => {
                throw new Error("kaboom");
              }
            : async () => ({ result: { ok: true } }),
      }),
    });

    const results = result.blocks.filter((b) => b.kind === "tool-result");
    expect(results.map((b) => (b as { toolCallId: string }).toolCallId).sort()).toEqual(["a", "b"]);
    expect(results.find((b) => (b as { toolCallId: string }).toolCallId === "b")).toMatchObject({
      isError: true,
    });
  });

  it("refuses an unresolved tool with an error result rather than a crash", async () => {
    const { emit } = collect();
    const provider = fakeProvider([
      [
        { type: "tool-call", toolCallId: "x", name: "forbidden", input: {} },
        { type: "step-end", stopReason: "tool_use", usage: usage() },
      ],
      [{ type: "step-end", stopReason: "end_turn", usage: usage() }],
    ]);
    const result = await runAssistantLoop({ ...base, provider, emit, resolveTool: () => null });
    expect(result.blocks.find((b) => b.kind === "tool-result")).toMatchObject({
      isError: true,
      result: { error: "unknown or not permitted", tool: "forbidden" },
    });
  });

  it("marks a mid-tool abort as truncated and keeps the partial text", async () => {
    const { emit } = collect();
    const provider = fakeProvider([
      [
        { type: "text-delta", delta: "partial" },
        { type: "step-end", stopReason: "aborted", usage: usage({ reported: false }) },
      ],
    ]);
    const result = await runAssistantLoop({ ...base, provider, emit });
    expect(result.status).toBe("truncated");
    expect(result.blocks).toEqual([{ kind: "text", text: "partial" }]);
    // An unreported step makes the whole turn's usage a declared lower bound.
    expect(result.usage.complete).toBe(false);
  });

  it("stops at maxSteps when the model keeps asking for tools, and says truncated", async () => {
    const { emit } = collect();
    const alwaysTool: ProviderEvent[] = [
      { type: "tool-call", toolCallId: "loop", name: "again", input: {} },
      { type: "step-end", stopReason: "tool_use", usage: usage() },
    ];
    const provider = fakeProvider([alwaysTool, alwaysTool, alwaysTool]);
    const result = await runAssistantLoop({
      ...base,
      provider,
      emit,
      maxSteps: 2,
      resolveTool: (c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        input: c.input,
        label: c.name,
        execute: async () => ({ result: {} }),
      }),
    });
    expect(result.status).toBe("truncated");
    expect(result.steps).toBe(2);
  });

  it("returns status errored (never throws) on a provider-error, keeping partial text and the step's usage", async () => {
    const { events, emit } = collect();
    const provider = fakeProvider([
      [
        { type: "text-delta", delta: "Let me" },
        { type: "provider-error", errorClass: "provider_overloaded", message: "overloaded" },
        { type: "step-end", stopReason: "end_turn", usage: usage() },
      ],
    ]);
    const result = await runAssistantLoop({ ...base, provider, emit });
    expect(result.status).toBe("errored");
    expect(result.error).toEqual({ errorClass: "provider_overloaded", message: "overloaded" });
    // Partial text is salvaged so a refetch shows something…
    expect(result.blocks).toEqual([{ kind: "text", text: "Let me" }]);
    // …and the tokens the failed step already spent still reach the ledger.
    expect(result.usage.inputTokens).toBe(10);
  });

  it("counts cache write tokens so the ledger can see the premium", async () => {
    const { emit } = collect();
    const provider = fakeProvider([
      [{ type: "step-end", stopReason: "end_turn", usage: usage({ cacheWriteTokens: 400, cacheReadTokens: 100 }) }],
    ]);
    const result = await runAssistantLoop({ ...base, provider, emit });
    expect(result.usage.cacheWriteTokens).toBe(400);
    expect(result.usage.cacheReadTokens).toBe(100);
  });

  it("a proposed write emits an action event and never runs inline, when onPropose is wired", async () => {
    const { events, emit } = collect();
    const provider = fakeProvider([
      [
        { type: "tool-call", toolCallId: "w1", name: "set_status", input: { status: "resolved" } },
        { type: "step-end", stopReason: "tool_use", usage: usage() },
      ],
      [
        { type: "text-delta", delta: "Confirm to proceed." },
        { type: "step-end", stopReason: "end_turn", usage: usage() },
      ],
    ]);
    const proposed: unknown[] = [];
    const result = await runAssistantLoop({
      ...base,
      provider,
      emit,
      onPropose: async (p) => {
        proposed.push(p);
        return "action-1";
      },
      resolveTool: (c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        input: c.input,
        label: c.name,
        execute: async () => ({
          result: { proposed: true },
          propose: { toolName: c.name, params: { status: "resolved" }, summary: "Set status to resolved" },
        }),
      }),
    });
    expect(proposed).toHaveLength(1);
    expect(events.find((e) => e.type === "action")).toMatchObject({
      type: "action",
      actionId: "action-1",
      summary: "Set status to resolved",
    });
    // The model is told it's awaiting confirmation, not that it's done.
    const tr = result.blocks.find((b) => b.kind === "tool-result");
    expect(tr).toMatchObject({ result: { proposed: true, actionId: "action-1" } });
  });

  it("refuses a proposed write when onPropose is NOT wired — never silently runs it", async () => {
    const { emit } = collect();
    const provider = fakeProvider([
      [
        { type: "tool-call", toolCallId: "w1", name: "set_status", input: {} },
        { type: "step-end", stopReason: "tool_use", usage: usage() },
      ],
      [{ type: "step-end", stopReason: "end_turn", usage: usage() }],
    ]);
    const result = await runAssistantLoop({
      ...base,
      provider,
      emit,
      resolveTool: (c) => ({
        toolCallId: c.toolCallId,
        name: c.name,
        input: c.input,
        label: c.name,
        execute: async () => ({ result: {}, propose: { toolName: c.name, params: {}, summary: "x" } }),
      }),
    });
    expect(result.blocks.find((b) => b.kind === "tool-result")).toMatchObject({ isError: true });
  });
});
