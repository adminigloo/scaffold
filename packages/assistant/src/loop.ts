import type { AssistantStreamEvent, LoopUsage } from "./events.js";
import type {
  ContentBlock,
  NeutralMessage,
  ProviderAdapter,
  StepUsage,
} from "./provider.js";

/**
 * The tool loop we own, on the provider seam. ~200 lines instead of a
 * framework that holds two published packages hostage to its protocol churn.
 *
 * THE ORDER IS THE DESIGN:
 *   1. call the model, streaming text deltas out live
 *   2. if the step ends in tool use, run the tools, append results, loop
 *   3. if it ends the turn (or hits maxSteps), stop
 * Usage accumulates across EVERY step, aborted ones included — the source
 * system's ledger lost exactly the abandoned turns that spike when the model
 * is slow, which is when spend is highest.
 *
 * Persistence is the caller's job: the loop returns the assistant turn's
 * blocks and a status so the caller writes ONE awaited row. The loop itself
 * never touches a database — it is pure enough to test against a fake
 * provider with no Postgres and no network.
 */

export interface ToolRun {
  toolCallId: string;
  name: string;
  input: unknown;
  /** Structured envelope; the executor never throws into the loop. */
  execute: () => Promise<{ result: unknown; isError?: boolean }>;
  /** Shown on the `step` event so the widget can label activity. */
  label: string;
}

export interface RunLoopOptions {
  provider: ProviderAdapter;
  system: string;
  /** Prior turns, rehydrated from the database — never from the client. */
  history: NeutralMessage[];
  /** This turn's user message. */
  userMessage: NeutralMessage;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Resolve a model tool-call to something runnable, or null to refuse it. */
  resolveTool: (call: {
    toolCallId: string;
    name: string;
    input: unknown;
  }) => ToolRun | null;
  maxSteps: number;
  maxTokens: number;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
  emit: (event: AssistantStreamEvent) => void;
}

export interface LoopResult {
  /** The assistant turn's blocks, in provider-replayable order, to persist. */
  blocks: ContentBlock[];
  status: "complete" | "truncated" | "errored";
  steps: number;
  usage: LoopUsage;
}

const zeroUsage = (): LoopUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  complete: true,
});

function addUsage(into: LoopUsage, step: StepUsage): void {
  into.inputTokens += step.inputTokens;
  into.outputTokens += step.outputTokens;
  into.cacheReadTokens += step.cacheReadTokens;
  into.cacheWriteTokens += step.cacheWriteTokens;
  // One unreported step makes the whole turn's usage a lower bound, and the
  // ledger must say so rather than quietly under-billing.
  if (!step.reported) into.complete = false;
}

export async function runAssistantLoop(options: RunLoopOptions): Promise<LoopResult> {
  const { provider, resolveTool, emit } = options;
  const usage = zeroUsage();
  // The running transcript for the provider: prior turns + this user turn,
  // then each step's assistant blocks and the tool results we feed back.
  const messages: NeutralMessage[] = [...options.history, options.userMessage];
  const assistantBlocks: ContentBlock[] = [];

  for (let step = 0; step < options.maxSteps; step++) {
    const stepBlocks: ContentBlock[] = [];
    const toolCalls: Array<{ toolCallId: string; name: string; input: unknown }> = [];
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" = "end_turn";

    const stream = provider.stream({
      system: options.system,
      messages,
      tools: options.tools,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: options.signal,
    });

    let textInStep = "";
    for await (const event of stream) {
      if (event.type === "text-delta") {
        textInStep += event.delta;
        emit({ v: 1, type: "text", delta: event.delta });
      } else if (event.type === "tool-call") {
        toolCalls.push({
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        });
      } else {
        stopReason = event.stopReason;
        addUsage(usage, event.usage);
      }
    }

    if (textInStep.length > 0) stepBlocks.push({ kind: "text", text: textInStep });
    for (const call of toolCalls) {
      stepBlocks.push({
        kind: "tool-call",
        toolCallId: call.toolCallId,
        name: call.name,
        input: call.input,
      });
    }

    if (stopReason === "aborted") {
      // The user left. Keep the partial text so a refetch shows something,
      // mark the turn truncated, and stop — the provider already stopped.
      assistantBlocks.push(...stepBlocks);
      return { blocks: assistantBlocks, status: "truncated", steps: step + 1, usage };
    }

    if (toolCalls.length === 0) {
      // The turn's answer. This step's text is what the user keeps.
      assistantBlocks.push(...stepBlocks);
      const status = stopReason === "max_tokens" ? "truncated" : "complete";
      return { blocks: assistantBlocks, status, steps: step + 1, usage };
    }

    // Tool use: the text so far was preamble. Tell the widget to clear its
    // provisional bubble and show activity instead.
    emit({
      v: 1,
      type: "step",
      step,
      tools: toolCalls.map((c) => ({
        name: c.name,
        label: resolveTool(c)?.label ?? c.name,
      })),
    });

    // The assistant's turn (text + tool-calls) becomes history, then every
    // matching tool-result MUST follow or the provider rejects the next call.
    messages.push({ role: "assistant", blocks: stepBlocks });
    assistantBlocks.push(...stepBlocks);

    const resultBlocks: ContentBlock[] = [];
    // Parallel tool calls run concurrently; order of results doesn't matter
    // to the provider, only that every call id is answered.
    const runs = toolCalls.map((call) => {
      const run = resolveTool(call);
      if (!run) {
        return Promise.resolve<ContentBlock>({
          kind: "tool-result",
          toolCallId: call.toolCallId,
          result: { error: "unknown or not permitted", tool: call.name },
          isError: true,
        });
      }
      return run
        .execute()
        .then<ContentBlock>((r) => ({
          kind: "tool-result",
          toolCallId: call.toolCallId,
          result: r.result,
          ...(r.isError ? { isError: true } : {}),
        }))
        .catch<ContentBlock>((err: unknown) => ({
          // A thrown executor still owes the provider a result for this id.
          kind: "tool-result",
          toolCallId: call.toolCallId,
          result: { error: err instanceof Error ? err.message : String(err) },
          isError: true,
        }));
    });
    resultBlocks.push(...(await Promise.all(runs)));

    messages.push({ role: "user", blocks: resultBlocks });
    assistantBlocks.push(...resultBlocks);
  }

  // Ran out of steps with the model still wanting tools. Honest status: the
  // answer is incomplete, and the caller should not present it as final.
  return { blocks: assistantBlocks, status: "truncated", steps: options.maxSteps, usage };
}
