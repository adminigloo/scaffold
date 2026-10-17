/**
 * The JSON the company handlers answer with (0.9.0), and what
 * @adminigloo/assistant-widget reads. COPIED, word for word between the
 * markers, into the widget's src/types.ts; a parity test in each package
 * fails when the two copies drift. The streamed chat itself speaks
 * ./events.ts (`AssistantStreamEvent`), which the widget mirrors the same way.
 */

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
