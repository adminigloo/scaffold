/**
 * The provider seam. The loop speaks THIS vocabulary; adapters translate it
 * to a vendor's wire format. The core package imports no vendor SDK — the
 * same rule storage's BlobStore set, for the same reason: "switch providers"
 * must never mean "re-audit the loop".
 *
 * Neutral message blocks are ALSO the persistence format. What the model saw
 * is what the database holds, so when the runtime persists and rehydrates from
 * these (0.2's answering engine), history replays byte-equivalent — the
 * property that makes conversations continuable, evals reproducible, and the
 * source system's client-authoritative-history flaw designed out. Until that
 * runtime ships, the 0.1 dogfood route still streams directly with
 * client-supplied messages; the block format is what 0.2 rehydrates against.
 */

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "tool-call"; toolCallId: string; name: string; input: unknown }
  | {
      kind: "tool-result";
      toolCallId: string;
      /** Structured envelope, never a bare string: errors travel as data. */
      result: unknown;
      isError?: boolean;
    };

export interface NeutralMessage {
  role: "user" | "assistant";
  blocks: ContentBlock[];
}

/**
 * Rehydrate ONE stored message row into provider-replayable messages.
 *
 * A stored assistant turn folds its text, tool-calls, AND tool-results into a
 * single row — one clean transcript entry. But a provider requires each
 * `tool-result` to live in a USER message that immediately follows the
 * assistant's `tool-call`; replaying the folded row verbatim as one assistant
 * message is an invalid transcript the vendor rejects (a 400 on the second turn
 * of any tool-using conversation). This splits the row on the tool-result
 * boundary, preserving order, so history always replays as a valid transcript.
 *
 * Pure and total: no DB, no network. `[text, tool-call, tool-result, text]`
 * becomes `[assistant[text,tool-call], user[tool-result], assistant[text]]`.
 */
export function replayMessages(
  role: "user" | "assistant",
  blocks: ContentBlock[],
): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  let current: ContentBlock[] = [];
  let currentRole: "user" | "assistant" = role;
  const flush = (): void => {
    if (current.length > 0) {
      out.push({ role: currentRole, blocks: current });
      current = [];
    }
  };
  for (const block of blocks) {
    // Tool results always belong to the user side; everything else keeps the
    // row's own role. A role change closes the current message.
    const wantRole: "user" | "assistant" = block.kind === "tool-result" ? "user" : role;
    if (wantRole !== currentRole) {
      flush();
      currentRole = wantRole;
    }
    current.push(block);
  }
  flush();
  return out;
}

/**
 * How a failed model call is classified, neutrally. Vendor error taxonomies
 * (Anthropic's 429 vs 529 vs a dropped socket) get mapped to THESE in the
 * adapter, so the loop and the widget never learn a vendor's status codes.
 */
export type ProviderErrorClass =
  | "rate_limited"
  | "provider_overloaded"
  | "provider_unreachable"
  | "input_too_large"
  | "internal";

/** What one model call streams back, in loop vocabulary. */
export type ProviderEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
  | {
      /**
       * The call failed mid-stream. The adapter yields THIS (never throws) so
       * the loop can salvage partial text and usage, then persist and meter the
       * turn — the ledger must not lose the tokens a failed step already spent.
       */
      type: "provider-error";
      errorClass: ProviderErrorClass;
      message: string;
    }
  | {
      type: "step-end";
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted";
      usage: StepUsage;
    };

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** False when the stream died before the provider reported final usage. */
  reported: boolean;
}

export interface ProviderRequest {
  system: string;
  messages: NeutralMessage[];
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  maxTokens: number;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * One model call = one async iterable of events ending in exactly one
 * step-end. Abort surfaces as step-end{aborted}, never as a throw — the loop
 * has bookkeeping to finish either way.
 */
export interface ProviderAdapter {
  readonly modelId: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
