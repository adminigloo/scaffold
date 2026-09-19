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

/** What one model call streams back, in loop vocabulary. */
export type ProviderEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
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
