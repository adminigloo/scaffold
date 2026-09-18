/**
 * The ONE token estimator. The editor's budget meter, publish enforcement,
 * assembly's shedding ledger, and (later) chunk sizing all call this — so the
 * number the admin sees when editing is the number the server enforces. Ask
 * Lou's scar was two counters that disagreed; here there is one.
 *
 * APPROXIMATE ON PURPOSE, and documented as such. A local BPE tokenizer is a
 * megabyte of tables that still isn't the provider's, and the provider's own
 * count_tokens costs a round trip per keystroke. Characters-per-token is
 * close enough for a budget whose job is "refuse the obviously-too-big", and
 * budgets are set at a safety margin (see `withinBudget`) so the estimate
 * never needs to be exact to be safe.
 */

/** English prose runs ~3.7 chars/token; round down so we over-count slightly. */
const CHARS_PER_TOKEN = 3.7;

/** The safety margin: enforce budgets at 90% of the stated ceiling. */
const BUDGET_SAFETY = 0.9;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * True when `text` fits under `maxTokens` with the safety margin applied.
 * Publish and the editor both gate on this, so what saves is what ships.
 */
export function withinBudget(text: string, maxTokens: number): boolean {
  return estimateTokens(text) <= Math.floor(maxTokens * BUDGET_SAFETY);
}
