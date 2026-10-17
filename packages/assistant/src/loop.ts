import type { AssistantStreamEvent, LoopUsage } from "./events.js";
import { estimateTokens } from "./tokens.js";
import type {
  ContentBlock,
  NeutralMessage,
  ProviderAdapter,
  ProviderErrorClass,
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

/** A write a tool wants to make, held for a human to confirm. */
export interface ProposedWrite {
  toolName: string;
  params: Record<string, unknown>;
  summary: string;
  /** What it will save, shown in full on the card (0.9.0). */
  fields?: Array<{ key: string; label: string; value: string; multiline: boolean }>;
}

export interface ToolRun {
  toolCallId: string;
  name: string;
  input: unknown;
  /**
   * Structured envelope; the executor never throws into the loop. A WRITE tool
   * returns `propose` instead of running: the loop persists it (via onPropose),
   * emits an `action` event, and tells the model it's awaiting confirmation.
   */
  execute: () => Promise<{ result: unknown; isError?: boolean; propose?: ProposedWrite }>;
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
  /**
   * Persist a proposed write and return its actionId. Required for write tools
   * to work; without it a write is refused (never silently run) so a caller that
   * hasn't wired confirmation can't have the model commit anything.
   */
  onPropose?: (proposal: ProposedWrite) => Promise<string>;
  emit: (event: AssistantStreamEvent) => void;
}

export interface LoopResult {
  /** The assistant turn's blocks, in provider-replayable order, to persist. */
  blocks: ContentBlock[];
  status: "complete" | "truncated" | "errored";
  steps: number;
  usage: LoopUsage;
  /** Set when status is "errored": the neutral class + message to surface. */
  error?: { errorClass: ProviderErrorClass; message: string };
}

const zeroUsage = (): LoopUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  complete: true,
  estimated: false,
});

function addUsage(into: LoopUsage, step: StepUsage): void {
  into.inputTokens += step.inputTokens;
  into.outputTokens += step.outputTokens;
  into.cacheReadTokens += step.cacheReadTokens;
  into.cacheWriteTokens += step.cacheWriteTokens;
  if (step.estimated) into.estimated = true;
  // A step with no counts at all (and no estimate) makes the turn's usage a
  // lower bound; the loop estimates before it gets here, so this is rare.
  if (!step.reported) into.complete = false;
}

/**
 * A STEP CUT SHORT IS NEVER FREE (0.9.0). When a step ends without the
 * provider's final counts — Stop, a dropped connection, an adapter that
 * reports nothing on abort — charge what was really sent and streamed: the
 * input the provider reported (else the request's estimated size) plus the
 * output streamed so far (else, when nothing at all came back from a call
 * that was cut off, the step's whole `maxTokens`, the worst case). A provider
 * that REFUSED the call (an error before anything streamed) charged nothing,
 * and nothing is charged. Before this, a stopped question wrote a null cost
 * that SUM() skipped: free against every cap.
 */
export function estimateStepUsage(
  step: StepUsage,
  input: { requestTokens: number; streamedTokens: number; maxTokens: number; refused: boolean; aborted: boolean },
): StepUsage {
  if (step.reported) return step;
  if (input.refused && input.streamedTokens === 0 && step.inputTokens === 0) return { ...step, reported: true, estimated: true };
  const inputTokens = step.inputTokens > 0 || step.cacheReadTokens > 0 ? step.inputTokens : input.requestTokens;
  const outputTokens =
    input.streamedTokens > 0
      ? Math.max(step.outputTokens, input.streamedTokens)
      : input.aborted && step.outputTokens === 0
        ? input.maxTokens
        : step.outputTokens;
  return { ...step, inputTokens, outputTokens, reported: true, estimated: true };
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
    let stepUsage: StepUsage | null = null;
    let errorInfo: { errorClass: ProviderErrorClass; message: string } | null = null;
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
      } else if (event.type === "provider-error") {
        // The adapter salvaged what it could and told us how it failed. Record
        // it; the trailing step-end still flushes whatever usage was reported.
        errorInfo = { errorClass: event.errorClass, message: event.message };
      } else {
        stopReason = event.stopReason;
        stepUsage = event.usage;
      }
    }
    // Every step is priced, cut short or not.
    addUsage(
      usage,
      estimateStepUsage(stepUsage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false }, {
        requestTokens: estimateTokens(JSON.stringify({ s: options.system, m: messages, t: options.tools })),
        streamedTokens: estimateTokens(textInStep + toolCalls.map((c) => c.name + JSON.stringify(c.input ?? {})).join("")),
        maxTokens: options.maxTokens,
        refused: errorInfo !== null,
        aborted: stopReason === "aborted" || options.signal?.aborted === true,
      }),
    );

    if (textInStep.length > 0) stepBlocks.push({ kind: "text", text: textInStep });
    for (const call of toolCalls) {
      stepBlocks.push({
        kind: "tool-call",
        toolCallId: call.toolCallId,
        name: call.name,
        input: call.input,
      });
    }

    if (errorInfo) {
      // The step failed. Keep any partial text so a refetch shows something,
      // and RETURN rather than throw — the caller must still persist the turn
      // and record the tokens this step already burned.
      assistantBlocks.push(...stepBlocks);
      return {
        blocks: assistantBlocks,
        status: "errored",
        steps: step + 1,
        usage,
        error: errorInfo,
      };
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
        .then<ContentBlock>(async (r) => {
          if (r.propose) {
            // A write. Persist it, tell the widget to show a confirm prompt, and
            // hand the model a result that says it's waiting — never run it here.
            if (!options.onPropose) {
              return {
                kind: "tool-result",
                toolCallId: call.toolCallId,
                result: { error: "writes are not enabled here", tool: call.name },
                isError: true,
              };
            }
            const actionId = await options.onPropose(r.propose);
            emit({ v: 1, type: "action", actionId, summary: r.propose.summary, ...(r.propose.fields ? { fields: r.propose.fields } : {}) });
            return {
              kind: "tool-result",
              toolCallId: call.toolCallId,
              result: {
                proposed: true,
                actionId,
                note: "Prepared and awaiting the user's confirmation. Do not claim it is done; tell them to confirm.",
              },
              isError: false,
            };
          }
          return {
            kind: "tool-result",
            toolCallId: call.toolCallId,
            result: r.result,
            ...(r.isError ? { isError: true } : {}),
          };
        })
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
