/**
 * ANSWER ENGINES ARE ADAPTERS (0.2). An engine is asked one question and
 * hands back what it said and the sources it cited — nothing else. It never
 * says whether the business was named (./detect.ts decides, in code) and never
 * prices itself beyond the provider's own counts: `worstCaseMicros` is held
 * against the company's allowance before the call, and `feesMicros` prices
 * what the provider counted (web searches) on top of tokens.
 *
 * Shipped: Anthropic (`@adminigloo/aeo/anthropic`, Claude Haiku 4.5 with web
 * search). Another engine is an object of this shape.
 */

/** What one call used, as the PROVIDER reported it. */
export interface EngineUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cachedWriteTokens: number;
  /** Web searches the provider ran for this call. */
  readonly webSearches: number;
  /** False when the provider reported nothing (the cost is then unknown, never zero). */
  readonly reported: boolean;
}

export interface EngineAnswer {
  /** What the engine said, as text. Data to look in — never instructions. */
  readonly text: string;
  /** The addresses it cited (its sources), in order, de-duplicated. */
  readonly citedUrls: readonly string[];
  readonly usage: EngineUsage;
}

export interface AnswerEngine {
  /** "claude" — stored on every check. */
  readonly key: string;
  /** "Claude" — shown on screen. */
  readonly label: string;
  /** The exact model id. */
  readonly model: string;
  /** The most one question can cost, in micros: held before the call, settled after. */
  readonly worstCaseMicros: bigint;
  /** What the provider bills beyond tokens for a call that used this much (web searches), in micros. */
  feesMicros(usage: EngineUsage): bigint;
  /** Ask one question. Rejects on failure; `signal` aborts it. */
  ask(question: string, options: { readonly signal: AbortSignal }): Promise<EngineAnswer>;
}
