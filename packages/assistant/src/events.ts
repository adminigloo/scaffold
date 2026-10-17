/**
 * The wire protocol between @adminigloo/assistant and its widget.
 *
 * A SMALL VERSIONED VOCABULARY, owned here and nowhere else. Platform and
 * widget ship as separate packages and WILL skew; `v` is what lets a widget
 * say "this stream speaks a protocol I don't" instead of rendering garbage.
 * Anthropic's own event shapes never cross this boundary — the day the
 * provider changes its framing, the widget doesn't notice.
 *
 * STEP-RESTART IS THE STREAMING DESIGN. Text deltas stream live in every
 * step, so the user always sees motion. When a step turns out to end in tool
 * use, that step's text was preamble ("Let me check…") — the loop emits
 * `step` and the widget CLEARS its provisional bubble. The final answer is
 * whichever step ends the turn. This is the fix for the source system's
 * buffer-everything approach, which traded all streaming UX for narration
 * suppression; we keep the motion and still never persist the narration.
 */

export const ASSISTANT_PROTOCOL_VERSION = 1;

export type AssistantStreamEvent =
  | {
      /**
       * The first event of a turn (0.9.0): which conversation it belongs to,
       * so a widget whose person presses Stop mid-answer still continues the
       * same conversation next time. A widget that doesn't know it ignores it.
       */
      v: 1;
      type: "start";
      conversationId: string;
    }
  | { v: 1; type: "text"; delta: string }
  | {
      /** The step ended in tool use: clear provisional text, show activity. */
      v: 1;
      type: "step";
      step: number;
      tools: Array<{ name: string; label: string }>;
    }
  | {
      /** A pending write proposal awaiting human confirmation. */
      v: 1;
      type: "action";
      actionId: string;
      summary: string;
      /** Exactly what it will save, for the card to show in full and let the person edit (0.9.0). */
      fields?: Array<{ key: string; label: string; value: string; multiline: boolean }>;
    }
  | {
      v: 1;
      type: "error";
      /** The widget maps classes to copy; it never parses messages. */
      errorClass:
        | "budget_exhausted"
        | "rate_limited"
        | "provider_overloaded"
        | "provider_unreachable"
        | "input_too_large"
        | "not_configured"
        | "internal";
      message: string;
    }
  | {
      v: 1;
      type: "done";
      meta: {
        conversationId: string;
        messageId: string;
        status: "complete" | "truncated" | "errored";
        steps: number;
        usage: LoopUsage;
        /**
         * "faq" (0.9.0): answered from one of the company's own FAQs, word
         * for word, without calling the model — free, and outside the
         * monthly allowance. Absent: the model answered.
         */
        answeredFrom?: "faq";
      };
    };

/** Accumulated across every step of one turn, aborted steps included. */
export interface LoopUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Cache WRITES bill at a premium; a ledger that can't see them lies. */
  cacheWriteTokens: number;
  /**
   * True when every step that ran has counts — reported by the provider or,
   * for a step cut short, estimated (0.9.0). Every turn can then be priced:
   * a stopped question is never free.
   */
  complete: boolean;
  /** Some counts are estimates (a step cut short). */
  estimated?: boolean;
}

export function encodeSse(event: AssistantStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
