import {
  ERROR_COPY,
  type AssistantChangesWire,
  type AssistantConfig,
  type AssistantSettingsWire,
  type AssistantStatusWire,
  type ConversationListWire,
  type ConversationSummaryWire,
  type ConversationWire,
  type DecideWire,
  type FaqWire,
  type GlossaryTermWire,
  type HouseRuleWire,
} from "./types.js";

/**
 * How the widget talks to the assistant's handler. Every path is one row of
 * @adminigloo/assistant's ASSISTANT_ADMIN_ROUTES (the wire-parity test checks
 * them), relative to `baseUrl`. Same-origin JSON, the session cookie along.
 * A failure is always a plain sentence: the server's own when it sent one,
 * else the widget's copy for its code.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string; status: number };

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

/** A response's error, as the person should read it. */
export async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } | string; errorClass?: unknown };
    const err = body.error;
    if (err && typeof err === "object") {
      const code = typeof err.code === "string" ? err.code : "internal";
      const message = typeof err.message === "string" && err.message ? err.message : (ERROR_COPY[code] ?? ERROR_COPY.internal!);
      return { code, message };
    }
    // 0.2's shape: { error: "…", errorClass }.
    const code = typeof body.errorClass === "string" ? body.errorClass : "internal";
    return { code, message: ERROR_COPY[code] ?? ERROR_COPY.internal! };
  } catch {
    const code = res.status === 401 || res.status === 403 ? "forbidden" : res.status === 404 ? "not_found" : "internal";
    return { code, message: ERROR_COPY[code] ?? ERROR_COPY.internal! };
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    return { ok: false, code: "network", message: ERROR_COPY.network!, status: 0 };
  }
  if (!res.ok) {
    const { code, message } = await errorOf(res);
    return { ok: false, code, message, status: res.status };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, code: "internal", message: ERROR_COPY.internal!, status: res.status };
  }
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export interface AssistantTransport {
  /** False on the 0.2 endpoints: no history, no starters, no allowance. */
  readonly hasHistory: boolean;
  status(): Promise<Result<AssistantStatusWire>>;
  /** The streamed answer (text/event-stream), or a refusal the caller reads with `errorOf`. */
  chat(message: string, conversationId: string | null, signal: AbortSignal): Promise<Response>;
  /** "Yes, do it" (with what the person changed on the card) or "No". */
  decide(actionId: string, decision: "confirm" | "decline", edits?: Record<string, string>): Promise<Result<DecideWire>>;
  conversations(): Promise<Result<ConversationSummaryWire[]>>;
  conversation(id: string): Promise<Result<ConversationWire>>;
}

export function createAssistantTransport(config: AssistantConfig): AssistantTransport {
  if (config.baseUrl) {
    const base = trimSlash(config.baseUrl);
    return {
      hasHistory: true,
      status: () => request<AssistantStatusWire>(`${base}/v1/status`),
      chat: (message, conversationId, signal) =>
        fetch(conversationId ? `${base}/v1/conversations/${segment(conversationId)}/messages` : `${base}/v1/chat`, {
          ...post({ message }),
          credentials: "same-origin",
          signal,
        }),
      decide: (actionId, decision, edits) =>
        request<DecideWire>(`${base}/v1/actions/${segment(actionId)}/${decision}`, post(edits && Object.keys(edits).length > 0 ? { edits } : {})),
      conversations: async () => {
        const list = await request<ConversationListWire>(`${base}/v1/conversations`);
        return list.ok ? { ok: true, data: list.data.conversations } : list;
      },
      conversation: (id) => request<ConversationWire>(`${base}/v1/conversations/${segment(id)}`),
    };
  }
  // 0.2's endpoints: one chat route and one confirm route.
  const chatUrl = config.chatUrl ?? "";
  const confirmUrl = config.confirmUrl ?? null;
  return {
    hasHistory: false,
    status: async () => ({ ok: false, code: "not_found", message: "", status: 404 }),
    chat: (message, conversationId, signal) =>
      fetch(chatUrl, { ...post({ message, conversationId }), credentials: "same-origin", signal }),
    decide: async (actionId, decision) => {
      if (!confirmUrl) return { ok: false, code: "not_found", message: "This change can't be confirmed here.", status: 404 };
      const res = await request<{ executed?: boolean; declined?: boolean; reason?: string }>(confirmUrl, post({ actionId, decision }));
      if (!res.ok) return res;
      if (decision === "decline") return { ok: true, data: { status: "declined", done: false, message: "Nothing was changed." } };
      return {
        ok: true,
        data: { status: "confirmed", done: Boolean(res.data.executed), message: res.data.executed ? "Done." : "That change didn't go through." },
      };
    },
    conversations: async () => ({ ok: true, data: [] }),
    conversation: async () => ({ ok: false, code: "not_found", message: ERROR_COPY.not_found!, status: 404 }),
  };
}

/** The settings screen's calls (./admin). */
export interface AssistantSettingsTransport {
  settings(): Promise<Result<AssistantSettingsWire>>;
  saveProfile(profile: string): Promise<Result<{ profile: string }>>;
  addRule(text: string): Promise<Result<HouseRuleWire>>;
  removeRule(id: string): Promise<Result<{ removed: true }>>;
  addTerm(term: string, meaning: string | null): Promise<Result<GlossaryTermWire>>;
  removeTerm(id: string): Promise<Result<{ removed: true }>>;
  saveFaq(input: { id?: string; question: string; answer: string }): Promise<Result<FaqWire>>;
  removeFaq(id: string): Promise<Result<{ removed: true }>>;
  changes(): Promise<Result<AssistantChangesWire>>;
}

export function createSettingsTransport(baseUrl: string): AssistantSettingsTransport {
  const base = trimSlash(baseUrl);
  return {
    settings: () => request(`${base}/v1/settings`),
    saveProfile: (profile) => request(`${base}/v1/settings/profile`, post({ profile })),
    addRule: (text) => request(`${base}/v1/settings/rules`, post({ text })),
    removeRule: (id) => request(`${base}/v1/settings/rules/${segment(id)}/remove`, post({})),
    addTerm: (term, meaning) => request(`${base}/v1/settings/glossary`, post({ term, meaning })),
    removeTerm: (id) => request(`${base}/v1/settings/glossary/${segment(id)}/remove`, post({})),
    saveFaq: ({ id, question, answer }) =>
      request(id ? `${base}/v1/settings/faqs/${segment(id)}` : `${base}/v1/settings/faqs`, post({ question, answer })),
    removeFaq: (id) => request(`${base}/v1/settings/faqs/${segment(id)}/remove`, post({})),
    changes: () => request(`${base}/v1/settings/changes`),
  };
}
