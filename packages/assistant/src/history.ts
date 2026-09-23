import type { ContentBlock } from "./provider.js";

/**
 * Keep a conversation's history from growing past the model's context window.
 *
 * WHY THIS EXISTS. A chat handler that rehydrates the ENTIRE stored transcript
 * every turn works fine until the thread is long — and then the assembled
 * request exceeds the model's context window and EVERY further turn on that
 * thread hard-fails. The conversation is bricked, permanently, with no way for
 * the user to recover it. Ported from the source's `truncateMessages`, which
 * runs before every model call for exactly this reason.
 *
 * WHY IT OPERATES ON STORED ROWS, not the replayed transcript. `replayMessages`
 * splits one stored assistant row into a `[assistant: text+tool_use]`,
 * `[user: tool_result]` pair. Truncating the FLATTENED list could drop a
 * tool_result while keeping its tool_use (or the reverse), which the provider
 * rejects outright. Dropping whole stored turns keeps every tool_use with its
 * tool_result, so what survives is always a valid transcript.
 */

const TOKENS_PER_CHAR = 0.25; // ~4 chars/token for English; matches the source.

function blockChars(block: ContentBlock): number {
  if (block.kind === "text") return block.text.length;
  if (block.kind === "tool-call") {
    return block.name.length + JSON.stringify(block.input ?? "").length;
  }
  return JSON.stringify(block.result ?? "").length;
}

/** Rough token estimate for one stored turn, from its blocks. */
export function estimateTurnTokens(blocks: readonly ContentBlock[]): number {
  let chars = 0;
  for (const b of blocks) chars += blockChars(b);
  return Math.ceil(chars * TOKENS_PER_CHAR);
}

export interface HistoryBudget {
  /**
   * Ceiling on estimated history tokens. Deliberately well under a model's real
   * window, to leave room for the system prompt, the tool schemas, the new turn
   * and the reply. Default 100k.
   */
  maxTokens?: number;
  /**
   * Always keep at least this many of the most recent stored turns, even past
   * the ceiling — on a thread of a few enormous turns, continuity of the last
   * exchange matters more than the cap. Default 12.
   */
  keepRecentTurns?: number;
}

/**
 * The suffix of `rows` (most recent turns) that fits the budget, in order.
 * Always keeps at least `keepRecentTurns`; beyond that, adds older turns until
 * the token ceiling is reached.
 */
export function budgetHistory<T extends { readonly blocks: ContentBlock[] }>(
  rows: readonly T[],
  budget: HistoryBudget = {},
): T[] {
  const maxTokens = budget.maxTokens ?? 100_000;
  const keepRecent = budget.keepRecentTurns ?? 12;
  if (rows.length <= keepRecent) return [...rows];

  const kept: T[] = [];
  let tokens = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    tokens += estimateTurnTokens(row.blocks);
    if (kept.length >= keepRecent && tokens > maxTokens) break;
    kept.push(row);
  }
  return kept.reverse();
}
