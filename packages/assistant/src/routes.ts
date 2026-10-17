import type { AssistantPermission } from "./permissions.js";

/**
 * One route of the assistant's handler, as data (the Tenancy 2a route-table
 * shape, 3.1). The package's tests read it back; a generated companies
 * project's isolation proof drives every row as ANOTHER company. Declared
 * here, never imported from a shared package.
 */
export interface AssistantRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/actions/{action}/confirm". */
  readonly path: string;
  /** The permission `authorize` is asked for. */
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type AssistantRouteKind =
  | "status"
  | "chat"
  | "conversations"
  | "conversation"
  | "continue"
  | "confirm"
  | "decline"
  | "settings"
  | "profile-save"
  | "rule-add"
  | "rule-remove"
  | "term-add"
  | "term-remove"
  | "faq-add"
  | "faq-update"
  | "faq-remove"
  | "changes";

/** The permission each route asks for, as data. */
export const ASSISTANT_ROUTE_PERMISSIONS: Readonly<Record<AssistantRouteKind, AssistantPermission>> = {
  status: "assistant.use",
  chat: "assistant.use",
  conversations: "assistant.use",
  conversation: "assistant.use",
  continue: "assistant.use",
  confirm: "assistant.use",
  decline: "assistant.use",
  settings: "assistant.settings.manage",
  "profile-save": "assistant.settings.manage",
  "rule-add": "assistant.settings.manage",
  "rule-remove": "assistant.settings.manage",
  "term-add": "assistant.settings.manage",
  "term-remove": "assistant.settings.manage",
  "faq-add": "assistant.settings.manage",
  "faq-update": "assistant.settings.manage",
  "faq-remove": "assistant.settings.manage",
  changes: "assistant.settings.manage",
};

function freeze<T extends readonly AssistantRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/assistant/). Entities: `{conversation}`, `{action}`
 * (a proposed change), `{house-rule}`, `{glossary-term}`, `{faq}`. A
 * placeholder in the PATH means the route reads that row: another company's
 * (or another person's) is "not found".
 */
export const ASSISTANT_ADMIN_ROUTES: readonly AssistantRoute<AssistantRouteKind>[] = freeze([
  { kind: "status", method: "GET", path: "v1/status", permission: "assistant.use" },
  { kind: "chat", method: "POST", path: "v1/chat", permission: "assistant.use", body: { message: "Isolation probe question" } },
  { kind: "conversations", method: "GET", path: "v1/conversations", permission: "assistant.use" },
  { kind: "conversation", method: "GET", path: "v1/conversations/{conversation}", permission: "assistant.use" },
  {
    kind: "continue",
    method: "POST",
    path: "v1/conversations/{conversation}/messages",
    permission: "assistant.use",
    body: { message: "Isolation probe follow-up" },
  },
  { kind: "confirm", method: "POST", path: "v1/actions/{action}/confirm", permission: "assistant.use", body: {} },
  { kind: "decline", method: "POST", path: "v1/actions/{action}/decline", permission: "assistant.use", body: {} },
  { kind: "settings", method: "GET", path: "v1/settings", permission: "assistant.settings.manage" },
  {
    kind: "profile-save",
    method: "POST",
    path: "v1/settings/profile",
    permission: "assistant.settings.manage",
    body: { profile: "Isolation probe profile." },
  },
  {
    kind: "rule-add",
    method: "POST",
    path: "v1/settings/rules",
    permission: "assistant.settings.manage",
    body: { text: "Isolation probe rule." },
  },
  { kind: "rule-remove", method: "POST", path: "v1/settings/rules/{house-rule}/remove", permission: "assistant.settings.manage", body: {} },
  {
    kind: "term-add",
    method: "POST",
    path: "v1/settings/glossary",
    permission: "assistant.settings.manage",
    body: { term: "Isolation probe term", meaning: "A probe." },
  },
  { kind: "term-remove", method: "POST", path: "v1/settings/glossary/{glossary-term}/remove", permission: "assistant.settings.manage", body: {} },
  {
    kind: "faq-add",
    method: "POST",
    path: "v1/settings/faqs",
    permission: "assistant.settings.manage",
    body: { question: "Isolation probe question?", answer: "Isolation probe answer." },
  },
  {
    kind: "faq-update",
    method: "POST",
    path: "v1/settings/faqs/{faq}",
    permission: "assistant.settings.manage",
    body: { question: "Isolation probe question?", answer: "Isolation probe answer." },
  },
  { kind: "faq-remove", method: "POST", path: "v1/settings/faqs/{faq}/remove", permission: "assistant.settings.manage", body: {} },
  { kind: "changes", method: "GET", path: "v1/settings/changes", permission: "assistant.settings.manage" },
] as const);

/** The same table under the name the assistant's docs use. */
export const ASSISTANT_ROUTES = ASSISTANT_ADMIN_ROUTES;
