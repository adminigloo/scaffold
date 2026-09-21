/** The platform protocol version this widget understands. */
export const SUPPORTED_PROTOCOL = 1;

export interface AssistantConfig {
  /** The chat endpoint, e.g. "/api/assistant/chat". */
  chatUrl: string;
  /**
   * The confirm endpoint, e.g. "/api/assistant/confirm". When set, a proposed
   * write shows Confirm/Decline buttons; without it, the proposal is shown but
   * can't be acted on from the widget.
   */
  confirmUrl?: string;
  title?: string;
  subtitle?: string;
  /** Sent as the opening message when the panel first opens, if set. */
  greeting?: string;
}

/**
 * The wire vocabulary, re-declared here (not imported from the server package)
 * so the widget ships without server code and can refuse a protocol it doesn't
 * speak. Mirrors @adminigloo/assistant's events.ts v:1.
 */
export type WidgetStreamEvent =
  | { v: 1; type: "text"; delta: string }
  | { v: 1; type: "step"; step: number; tools: Array<{ name: string; label: string }> }
  | { v: 1; type: "action"; actionId: string; summary: string }
  | { v: 1; type: "error"; errorClass: string; message: string }
  | {
      v: 1;
      type: "done";
      meta: { conversationId: string; messageId: string; status: string; steps: number };
    };

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  status?: "complete" | "truncated" | "errored";
  actions?: Array<{ actionId: string; summary: string }>;
}

export const ERROR_COPY: Record<string, string> = {
  budget_exhausted: "You've hit today's usage limit for the assistant. Try again tomorrow.",
  rate_limited: "Too many requests just now — give it a moment and try again.",
  provider_overloaded: "The model is busy right now. Please try again in a moment.",
  provider_unreachable: "Couldn't reach the model. Please try again shortly.",
  input_too_large: "That message is too long — please shorten it.",
  not_configured: "The assistant isn't switched on here yet.",
  internal: "Something went wrong. Please try again.",
};
