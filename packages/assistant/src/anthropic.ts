/**
 * @adminigloo/assistant/anthropic — the assistant on Claude (0.9.0).
 *
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { createAnthropicProvider } from "@adminigloo/assistant/anthropic";
 *   const provider = createAnthropicProvider({ client: new Anthropic() });
 *   createAssistantHandlers({ …, provider });
 *
 * The package's loop speaks a neutral vocabulary (./provider.ts); THIS is the
 * only module that knows Anthropic's wire shape. It maps the raw stream to the
 * loop's events — text deltas live, tool calls assembled at block stop, one
 * step-end carrying the usage the PROVIDER reported (the model never reports
 * its own) — and turns an abort into step-end{aborted} rather than a throw.
 *
 * CHEAPEST CAPABLE MODEL BY DEFAULT: Claude Haiku 4.5 ($1 in, $5 out per
 * million tokens), configurable with `model`.
 *
 * PROMPT CACHING, two breakpoints (Anthropic allows four), the way Ben cut Ask
 * Lou's chat from about 25 cents a turn to 5 or 6:
 *
 *   1. the end of `system`: a company's sections only, the same for every
 *      conversation in that company (house rules, glossary and knowledge ride
 *      in the user message precisely so this prefix never changes);
 *   2. the end of the last message: the loop only appends, so step N reads
 *      steps 1 to N-1 from cache, and a follow-up reads the conversation so far.
 *
 * A prefix shorter than the model's minimum cacheable length (on Haiku 4.5,
 * 4,096 tokens) is simply not cached — not an error, and not billed as a
 * write. A long conversation or a large business profile crosses it.
 *
 * TYPE-ONLY SDK IMPORT, apart from the error classes read off the client's
 * constructor: @anthropic-ai/sdk is an OPTIONAL peer, the app constructs the
 * client and owns the key, and this module never reads a key.
 *
 * Copied from the AdminIgloo site's own assistant (src/server/assistant-
 * provider.ts), where it was measured: 5.03¢ → 2.26¢ a warm two-turn chat.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { NeutralMessage, ProviderAdapter, ProviderErrorClass, ProviderEvent } from "./provider.js";

/** Claude Haiku 4.5: the founder's default for every AI feature — the cheapest model that does the job. */
export const DEFAULT_ASSISTANT_MODEL = "claude-haiku-4-5";

/** The slice of the Anthropic client the adapter uses: `messages.stream`. */
export type AnthropicStreamingClient = Pick<Anthropic, "messages">;

export interface AnthropicProviderOptions {
  /** The app's `new Anthropic()`; this package never reads a key. */
  client: AnthropicStreamingClient;
  /** Default `DEFAULT_ASSISTANT_MODEL` ("claude-haiku-4-5"). */
  model?: string;
  /** Default on. Off only to measure what caching saves. */
  promptCache?: boolean;
}

function mapStopReason(reason: string | null | undefined): "end_turn" | "tool_use" | "max_tokens" | "aborted" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function statusOf(cause: unknown): number | undefined {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * An abort, by the signal and the error's shape — not `.name` alone: the SDK's
 * error classes don't always set it, and a name match misfiled every
 * cancellation as a crash, losing the partial answer and its tokens.
 */
function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const name = (cause as { name?: string; constructor?: { name?: string } } | null)?.constructor?.name;
  if (name === "APIUserAbortError") return true;
  return (cause as { name?: string } | null)?.name === "AbortError";
}

/** A vendor failure → the loop's neutral classes, so the widget's per-class sentences fire. */
export function classifyAnthropicError(cause: unknown): { errorClass: ProviderErrorClass; message: string } {
  const ctor = (cause as { constructor?: { name?: string } } | null)?.constructor?.name ?? "";
  if (ctor === "APIConnectionError" || ctor === "APIConnectionTimeoutError") {
    return { errorClass: "provider_unreachable", message: "Couldn't reach the assistant's model. Please try again." };
  }
  const status = statusOf(cause);
  if (status === 429) return { errorClass: "rate_limited", message: "The assistant is busy right now. Try again in a moment." };
  if (status === 413) return { errorClass: "input_too_large", message: "This conversation is too long. Start a new one." };
  if (status !== undefined && status >= 500) {
    return { errorClass: "provider_overloaded", message: "The assistant's model is overloaded. Please try again shortly." };
  }
  return { errorClass: "internal", message: "Something went wrong. Please try again." };
}

/** Anthropic's five-minute cache: written at 1.25x input, read back at 0.1x. */
const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Mark the two breakpoints (see the module comment). Pure; copies rather than
 * mutates, because the loop re-uses its transcript between steps.
 */
export function withPromptCache(
  system: string,
  messages: readonly Anthropic.MessageParam[],
): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  // Anthropic rejects an empty text block, so an empty prompt sends no block.
  const systemBlocks: Anthropic.TextBlockParam[] = system ? [{ type: "text", text: system, cache_control: EPHEMERAL }] : [];
  const out = messages.slice();
  const last = out.at(-1);
  if (last) {
    const content: Anthropic.ContentBlockParam[] =
      typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.slice();
    const tail = content.at(-1);
    if (tail) {
      content[content.length - 1] = { ...tail, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam;
      out[out.length - 1] = { ...last, content };
    }
  }
  return { system: systemBlocks, messages: out };
}

export function toAnthropicMessage(message: NeutralMessage): Anthropic.MessageParam {
  const content = message.blocks.map((block) => {
    if (block.kind === "text") return { type: "text", text: block.text };
    if (block.kind === "tool-call") return { type: "tool_use", id: block.toolCallId, name: block.name, input: block.input };
    return {
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: typeof block.result === "string" ? block.result : JSON.stringify(block.result),
      ...(block.isError ? { is_error: true } : {}),
    };
  });
  return { role: message.role, content: content as Anthropic.ContentBlockParam[] };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ProviderAdapter {
  const modelId = options.model ?? DEFAULT_ASSISTANT_MODEL;
  const promptCache = options.promptCache ?? true;
  const client = options.client;
  return {
    modelId,
    async *stream(request): AsyncIterable<ProviderEvent> {
      const plain = request.messages.map(toAnthropicMessage);
      const { system, messages } = promptCache
        ? withPromptCache(request.system, plain)
        : { system: request.system, messages: plain };
      const tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      }));

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let reported = false;
      let started = false;
      let streamedChars = 0;
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" = "end_turn";
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      try {
        const stream = client.messages.stream(
          {
            model: modelId,
            max_tokens: request.maxTokens,
            system,
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          },
          { signal: request.signal },
        );

        for await (const event of stream) {
          if (event.type === "message_start") {
            const usage = event.message.usage;
            inputTokens = usage.input_tokens ?? 0;
            cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
            started = true;
          } else if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              streamedChars += event.delta.text.length;
              yield { type: "text-delta", delta: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              const block = toolBlocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
              streamedChars += event.delta.partial_json.length;
            }
          } else if (event.type === "content_block_stop") {
            const block = toolBlocks.get(event.index);
            if (block) {
              let input: unknown = {};
              try {
                input = block.json ? JSON.parse(block.json) : {};
              } catch {
                input = {};
              }
              yield { type: "tool-call", toolCallId: block.id, name: block.name, input };
            }
          } else if (event.type === "message_delta") {
            if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
            if (event.usage.output_tokens != null) outputTokens = event.usage.output_tokens;
            reported = true;
          }
        }
      } catch (cause) {
        if (isAbort(cause, request.signal)) {
          stopReason = "aborted";
        } else {
          // Never throw across the seam: a neutral error, then step-end, so the
          // tokens this step spent still reach the ledger.
          const { errorClass, message } = classifyAnthropicError(cause);
          yield { type: "provider-error", errorClass, message };
        }
      }

      // CUT SHORT, NOT FREE (0.9.0): a stop after the call started has the
      // input Anthropic reported at message_start; the output is what was
      // streamed so far (≈ 3.7 characters a token), and is marked an estimate.
      // Before the call started there is nothing to report, and the loop
      // charges the request's size and the worst-case output.
      if (!reported && started && stopReason === "aborted") {
        outputTokens = Math.max(outputTokens, Math.ceil(streamedChars / 3.7));
        yield {
          type: "step-end",
          stopReason,
          usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reported: true, estimated: true },
        };
        return;
      }
      yield {
        type: "step-end",
        stopReason,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reported },
      };
    },
  };
}
