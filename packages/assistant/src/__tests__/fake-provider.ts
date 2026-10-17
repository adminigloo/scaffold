import type { ProviderAdapter, ProviderEvent, ProviderRequest, StepUsage } from "../provider.js";

/**
 * A scripted model: each call to `stream` plays the next script, and every
 * request is kept so a test can read what the model was SENT (the system
 * prompt, the tools it was offered, the tool results). No network, no SDK —
 * the tests never call the real Anthropic API.
 */

export const usage = (over: Partial<StepUsage> = {}): StepUsage => ({
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reported: true,
  ...over,
});

export interface FakeProvider extends ProviderAdapter {
  readonly requests: ProviderRequest[];
  /** How many times the model was called. */
  calls(): number;
}

/** Text then end of turn. */
export function says(text: string, over: Partial<StepUsage> = {}): ProviderEvent[] {
  return [
    { type: "text-delta", delta: text },
    { type: "step-end", stopReason: "end_turn", usage: usage(over) },
  ];
}

/** A tool call (optionally after some preamble text) then tool_use. */
export function callsTool(name: string, input: unknown, id = `call_${name}`): ProviderEvent[] {
  return [
    { type: "text-delta", delta: "Let me check." },
    { type: "tool-call", toolCallId: id, name, input },
    { type: "step-end", stopReason: "tool_use", usage: usage() },
  ];
}

export function fakeProvider(scripts: ProviderEvent[][], modelId = "claude-haiku-4-5"): FakeProvider {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    modelId,
    requests,
    calls: () => call,
    async *stream(request) {
      // A deep copy: the loop re-uses its transcript between steps.
      requests.push(JSON.parse(JSON.stringify({ ...request, signal: undefined })) as ProviderRequest);
      const script = scripts[call] ?? says("Okay.");
      call += 1;
      for (const event of script) {
        if (request.signal?.aborted) {
          // Like a real adapter on a stop: the provider's final counts never
          // came, so nothing is reported — the loop must still price the step.
          yield { type: "step-end", stopReason: "aborted", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false } };
          return;
        }
        yield event;
      }
    },
  };
}
