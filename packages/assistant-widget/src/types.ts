/**
 * The widget's whole vocabulary with the server. The region between the WIRE
 * markers is COPIED, word for word, from @adminigloo/assistant's src/wire.ts;
 * src/__tests__/wire-parity.test.ts fails when the two copies drift. Declared
 * here (not imported) so the widget ships without server code.
 */

/** The platform protocol version this widget understands. */
export const SUPPORTED_PROTOCOL = 1;

// WIRE:BEGIN
/** Where a company stands with its month of AI, in figures code worked out. */
export interface AssistantAllowanceWire {
  /** Questions answered by the model this month. */
  messagesUsed: number;
  /** The month's limit, or null for none. */
  messageLimit: number | null;
  /** Cents of AI spent this month (a whole number, as text). */
  centsUsed: string;
  centLimit: number | null;
  /** The day the allowance starts again (YYYY-MM-DD). */
  resetsOn: string;
  /** True when the month's allowance is spent: the chat answers only from FAQs until it resets. */
  usedUp: boolean;
  /**
   * What closed it: the month's messages, its spending limit, or the whole
   * site's day (when `resetsOn` is the site's next day). null while open.
   */
  limitedBy: "messages" | "cents" | "day" | "site" | null;
  /** The sentence to show when it's used up (or can't be checked), else null. */
  message: string | null;
}

export interface AssistantStatusWire {
  /** False when this site has no AI model switched on: the chat says so, settings still work. */
  configured: boolean;
  notConfiguredMessage: string | null;
  /** Questions to offer as one-tap starters. */
  starters: string[];
  /** The starters the business answered itself: answered with its words, no AI — they still work when the allowance is used up. */
  freeStarters: string[];
  allowance: AssistantAllowanceWire | null;
  /** May this person open the assistant's settings? */
  canManage: boolean;
}

/** "failed": the person said yes, but the change didn't go through (nothing was changed). */
export type ActionStatusWire = "pending" | "confirmed" | "declined" | "expired" | "failed";

/** One thing a proposed change will save, shown in full on the card and editable before "Yes, do it". */
export interface ActionFieldWire {
  key: string;
  label: string;
  value: string;
  /** Show it as several lines. */
  multiline: boolean;
}

export interface ActionWire {
  id: string;
  /** What will happen, in one plain sentence. */
  summary: string;
  status: ActionStatusWire;
  /** Exactly what will be saved (after any edit, what WAS saved). */
  fields: ActionFieldWire[];
}

export interface ChatMessageWire {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "truncated" | "errored";
  /** The changes this answer offered to make, with what was answered. */
  actions: ActionWire[];
  /** Answered from the business's own answers, word for word (no AI). */
  fromFaq: boolean;
}

export interface ConversationSummaryWire {
  id: string;
  title: string;
  /** ISO date-time. */
  lastMessageAt: string;
}

export interface ConversationListWire {
  conversations: ConversationSummaryWire[];
}

export interface ConversationWire {
  id: string;
  title: string;
  messages: ChatMessageWire[];
}

export interface DecideWire {
  status: "confirmed" | "declined";
  /** Did the change go through? (Always false for "declined".) */
  done: boolean;
  message: string;
}

export interface HouseRuleWire {
  id: string;
  text: string;
}

export interface GlossaryTermWire {
  id: string;
  term: string;
  meaning: string | null;
}

export interface FaqWire {
  id: string;
  question: string;
  answer: string;
}

export interface AssistantSettingsWire {
  /** What the owner wrote about the business ("" when nothing yet). */
  profile: string;
  profileMaxChars: number;
  rules: HouseRuleWire[];
  glossary: GlossaryTermWire[];
  faqs: FaqWire[];
  usage: AssistantAllowanceWire | null;
  configured: boolean;
}

export interface AssistantChangeWire {
  id: string;
  /** What changed, in plain words: "Added an answer: Do you work weekends?" */
  what: string;
  /** ISO date-time. */
  when: string;
}

export interface AssistantChangesWire {
  changes: AssistantChangeWire[];
}

export type AssistantErrorCodeWire =
  | "forbidden"
  | "not_found"
  | "invalid"
  | "cross_site"
  | "not_configured"
  | "allowance_used_up"
  | "site_limit"
  | "allowance_unavailable"
  | "already_answered"
  | "rate_limited"
  | "expired"
  | "unlicensed"
  | "internal";

export interface AssistantErrorWire {
  error: { code: AssistantErrorCodeWire; message: string };
}
// WIRE:END

/**
 * The streamed chat's events (mirrors @adminigloo/assistant's events.ts v:1).
 * An event the widget doesn't know is ignored.
 */
export type WidgetStreamEvent =
  | { v: 1; type: "start"; conversationId: string }
  | { v: 1; type: "text"; delta: string }
  | { v: 1; type: "step"; step: number; tools: Array<{ name: string; label: string }> }
  | { v: 1; type: "action"; actionId: string; summary: string; fields?: ActionFieldWire[] }
  | { v: 1; type: "error"; errorClass: string; message: string }
  | {
      v: 1;
      type: "done";
      meta: { conversationId: string; messageId: string; status: string; steps: number; answeredFrom?: "faq" };
    };

export interface AssistantConfig {
  /**
   * Where the assistant's handler is mounted, e.g. `/api/app/${company.id}/assistant`
   * (0.3.0). With it the widget has history, starters, the allowance and
   * "Yes, do it".
   */
  baseUrl?: string;
  /** 0.2's single chat endpoint, e.g. "/api/assistant/chat" (no history or starters). */
  chatUrl?: string;
  /** 0.2's confirm endpoint, used with `chatUrl`. */
  confirmUrl?: string;
  title?: string;
  subtitle?: string;
  /** Shown above the starters on an empty conversation. */
  greeting?: string;
  /** One-tap questions to offer; with `baseUrl` the server's list is used when this is absent. */
  starters?: readonly string[];
  /** A link to the assistant's settings, shown to people who may change them. */
  settingsHref?: string | null;
  /** "auto" follows the host page (default); "light" / "dark" force it. */
  theme?: "auto" | "light" | "dark";
}

/** A message as the widget shows it. */
export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  status?: "complete" | "truncated" | "errored" | "stopped";
  actions?: ActionWire[];
  /** Answered from one of the business's own FAQs (no AI used). */
  fromFaq?: boolean;
}

/** The sentence for each error class the stream or a refusal names. The widget never shows a raw message it wasn't meant to. */
export const ERROR_COPY: Record<string, string> = {
  budget_exhausted: "This month's assistant allowance is used up.",
  allowance_used_up: "This month's assistant allowance is used up.",
  site_limit: "The assistant has reached today's limit for this site. Try again tomorrow.",
  allowance_unavailable: "The assistant can't check its allowance right now. Try again in a minute.",
  rate_limited: "The assistant is busy right now. Try again in a moment.",
  provider_overloaded: "The assistant is busy right now. Please try again in a moment.",
  provider_unreachable: "Couldn't reach the assistant. Please try again shortly.",
  input_too_large: "This conversation is too long. Start a new one.",
  not_configured: "The assistant isn't switched on here yet.",
  forbidden: "You don't have permission to use the assistant here.",
  not_found: "That conversation isn't here any more. Start a new one.",
  network: "Couldn't reach the server. Check your connection and try again.",
  internal: "Something went wrong. Please try again.",
};
