import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createAssistantTransport, errorOf, type AssistantTransport } from "./client.js";
import { renderMarkdown } from "./markdown.js";
import { injectStyles } from "./styles.js";
import { useHostTheme, useStyles } from "./theme.js";
import {
  ERROR_COPY,
  type ActionWire,
  type AssistantConfig,
  type AssistantStatusWire,
  type ChatMessage,
  type ConversationSummaryWire,
  type WidgetStreamEvent,
} from "./types.js";

/**
 * The assistant's chat — a controlled component speaking the versioned SSE
 * protocol to the assistant's handler.
 *
 *   - Text streams live. When a step turns out to end in a tool call, its text
 *     was preamble ("Let me check…"), so it is cleared and the tool's label
 *     shown instead; the answer is whatever the last step said.
 *   - Stop ends the answer where it is (the server keeps and meters it).
 *   - On an empty conversation it offers starter questions — the site's, and
 *     the business's own FAQ questions, which are answered without AI.
 *   - Answers are rendered Markdown, safely (./markdown.tsx: no HTML ever).
 *   - ASK BEFORE ACTING: a change the assistant offers to make is a card with
 *     "Yes, do it" and "No". The buttons lock on the first click; the server
 *     answers each offer once, so a double click acts once.
 *   - The month's allowance: when it's used up the chat says so, in the
 *     server's words, and FAQ answers still work.
 *   - History: your own earlier conversations, to read or carry on.
 *
 * It follows the host page's light or dark theme (./theme.ts) and works at
 * 390 px.
 */

export interface AssistantChatProps {
  config: AssistantConfig;
  /** Swap the network for a test or a host's own client. */
  transport?: AssistantTransport;
  /** Shown as a close button in the header (the launcher passes it). */
  onClose?: () => void;
  /** Focus the question box on mount. */
  autoFocus?: boolean;
  /** The id the header's title gets, so a dialog can be labelled by it. */
  titleId?: string;
}

type Decision = { state: "busy" } | { state: "done" | "declined" | "failed"; message: string };

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
const ICON_CLOSE = "M6 6l12 12M18 6L6 18";
const ICON_HISTORY = "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2";
const ICON_NEW = "M12 5v14M5 12h14";

function whenWords(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * "ASK BEFORE ACTING", SHOWING EVERYTHING (0.3.0, review H3): the card shows
 * IN FULL, as plain text, exactly what the change will save — every field —
 * and "Change it" lets the person edit any of them first. What "Yes, do it"
 * saves is what they saw (their edits are sent with it); never text they
 * weren't shown.
 */
function ActionCard({
  action,
  decision,
  onDecide,
}: {
  action: ActionWire;
  decision: Decision | undefined;
  onDecide: (decision: "confirm" | "decline", edits?: Record<string, string>) => void;
}) {
  const fields = action.fields ?? [];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const settled = action.status !== "pending";
  const label =
    decision?.state === "done" || (!decision && action.status === "confirmed")
      ? "Done"
      : decision?.state === "declined" || (!decision && action.status === "declined")
        ? "Not done"
        : decision?.state === "failed" || (!decision && action.status === "failed")
          ? "Didn't go through"
          : !decision && action.status === "expired"
            ? "This offer ran out"
            : "The assistant would like to make a change";
  const result =
    decision && decision.state !== "busy" ? decision.message : settled && action.status === "expired" ? "Ask again and it will offer it fresh." : null;
  const open = !settled && (!decision || decision.state === "busy");
  const busy = decision?.state === "busy";
  const edits = Object.fromEntries(fields.filter((f) => values[f.key] !== f.value).map((f) => [f.key, values[f.key] ?? ""]));
  return (
    <div className="aia-action" data-state={decision?.state === "done" || action.status === "confirmed" ? "done" : undefined} data-aia-action={action.id}>
      <div className="aia-action-label">{label}</div>
      <div className="aia-action-summary">{action.summary}</div>
      {fields.length > 0 ? (
        <dl className="aia-action-fields">
          {fields.map((field) => (
            <div key={field.key} className="aia-action-field">
              <dt>{field.label}</dt>
              {open && editing ? (
                <dd>
                  <label className="aia-sr" htmlFor={`${action.id}-${field.key}`}>
                    {field.label}
                  </label>
                  {field.multiline ? (
                    <textarea
                      id={`${action.id}-${field.key}`}
                      className="aia-input"
                      rows={4}
                      value={values[field.key] ?? ""}
                      onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))}
                    />
                  ) : (
                    <input
                      id={`${action.id}-${field.key}`}
                      className="aia-input"
                      value={values[field.key] ?? ""}
                      onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))}
                    />
                  )}
                </dd>
              ) : (
                <dd data-aia-field={field.key}>{open ? (values[field.key] ?? field.value) : field.value}</dd>
              )}
            </div>
          ))}
        </dl>
      ) : null}
      {open ? (
        <div className="aia-action-buttons">
          <button type="button" className="aia-btn aia-btn-primary" disabled={busy} onClick={() => onDecide("confirm", edits)}>
            Yes, do it
          </button>
          {fields.length > 0 && !editing ? (
            <button type="button" className="aia-btn" disabled={busy} onClick={() => setEditing(true)}>
              Change it
            </button>
          ) : null}
          <button type="button" className="aia-btn" disabled={busy} onClick={() => onDecide("decline")}>
            No
          </button>
        </div>
      ) : null}
      {result ? (
        <p className="aia-action-result" role="status">
          {result}
        </p>
      ) : null}
    </div>
  );
}

export function AssistantChat({ config, transport: given, onClose, autoFocus, titleId }: AssistantChatProps) {
  // Keyed on the endpoints, not the config object: a host that passes a fresh
  // object each render must not re-fetch the status each render.
  const { baseUrl, chatUrl, confirmUrl } = config;
  const transport = useMemo(
    () => given ?? createAssistantTransport({ baseUrl, chatUrl, confirmUrl }),
    [given, baseUrl, chatUrl, confirmUrl],
  );
  useStyles(injectStyles);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useHostTheme(rootRef, config.theme ?? "auto");
  const fallbackTitleId = useId();
  const headingId = titleId ?? fallbackTitleId;

  const [view, setView] = useState<"chat" | "history">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [activity, setActivity] = useState<string[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatusWire | null>(null);
  const [history, setHistory] = useState<ConversationSummaryWire[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const deciding = useRef(new Set<string>());

  // Refused on OPEN (review L11): a closed plan, a suspended company, someone
  // signed out — said straight away, not only after they type a question.
  const [blocked, setBlocked] = useState<string | null>(null);
  const refreshStatus = useCallback(async () => {
    const res = await transport.status();
    if (res.ok) {
      setStatus(res.data);
      setBlocked(null);
    } else if (res.status === 401 || res.status === 403) {
      setBlocked(res.message || ERROR_COPY.forbidden!);
    }
  }, [transport]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    threadRef.current?.scrollTo?.({ top: threadRef.current.scrollHeight });
  }, [messages, liveText, activity, error]);
  // Leaving mid-answer stops it (the server keeps and meters what was said).
  useEffect(() => () => abortRef.current?.abort(), []);

  const decide = async (actionId: string, decision: "confirm" | "decline", edits?: Record<string, string>) => {
    // One answer per offer from this screen, whatever the clicking.
    if (deciding.current.has(actionId)) return;
    deciding.current.add(actionId);
    setDecisions((d) => ({ ...d, [actionId]: { state: "busy" } }));
    const res = await transport.decide(actionId, decision, edits);
    // An edit that doesn't fit leaves the offer open, to fix and try again.
    if (!res.ok && res.code === "invalid") {
      deciding.current.delete(actionId);
      setDecisions((d) => {
        const { [actionId]: _gone, ...rest } = d;
        return rest;
      });
      setError(res.message);
      return;
    }
    if (res.ok) {
      const state = res.data.status === "declined" ? "declined" : res.data.done ? "done" : "failed";
      setDecisions((d) => ({ ...d, [actionId]: { state, message: res.data.message } }));
    } else {
      setDecisions((d) => ({ ...d, [actionId]: { state: "failed", message: res.message } }));
    }
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setStreaming(true);
    setLiveText("");
    setActivity(null);

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    let finished = false;
    let currentConversation = conversationId;
    const collected: ActionWire[] = [];
    try {
      const res = await transport.chat(text, conversationId, controller.signal);
      if (!res.ok || !res.body) {
        const { code, message } = await errorOf(res);
        setError(message || ERROR_COPY[code] || ERROR_COPY.internal!);
        if (code === "allowance_used_up" || code === "site_limit") void refreshStatus();
        if (code === "not_found" && conversationId) setConversationId(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 2);
          if (!raw.startsWith("data:")) continue;
          let event: WidgetStreamEvent;
          try {
            event = JSON.parse(raw.slice(5).trim()) as WidgetStreamEvent;
          } catch {
            continue;
          }
          if (event.v !== 1) continue;
          if (event.type === "start") {
            currentConversation = event.conversationId;
            setConversationId(event.conversationId);
          } else if (event.type === "text") {
            acc += event.delta;
            setLiveText(acc);
          } else if (event.type === "step") {
            acc = "";
            setLiveText("");
            setActivity(event.tools.map((t) => t.label));
          } else if (event.type === "action") {
            collected.push({ id: event.actionId, summary: event.summary, status: "pending", fields: event.fields ?? [] });
          } else if (event.type === "error") {
            setError(ERROR_COPY[event.errorClass] ?? ERROR_COPY.internal!);
            if (acc) setMessages((m) => [...m, { role: "assistant", text: acc, status: "errored", actions: [...collected] }]);
            finished = true;
          } else if (event.type === "done") {
            currentConversation = event.meta.conversationId;
            setConversationId(event.meta.conversationId);
            const fromFaq = event.meta.answeredFrom === "faq";
            setMessages((m) => [
              ...m,
              {
                id: event.meta.messageId,
                role: "assistant",
                text: acc,
                status: event.meta.status === "truncated" ? "truncated" : "complete",
                actions: [...collected],
                fromFaq,
              },
            ]);
            finished = true;
            if (!fromFaq) void refreshStatus();
          }
        }
      }
    } catch {
      if (controller.signal.aborted) {
        // Stopped: keep what was said, marked as stopped.
        setMessages((m) => [...m, { role: "assistant", text: acc, status: "stopped", actions: [...collected] }]);
        if (currentConversation) setConversationId(currentConversation);
      } else {
        setError(ERROR_COPY.network!);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setLiveText("");
      setActivity(null);
    }
  };

  const stop = () => abortRef.current?.abort();

  const startNew = () => {
    abortRef.current?.abort();
    setMessages([]);
    setConversationId(null);
    setError(null);
    setDecisions({});
    deciding.current.clear();
    setView("chat");
    inputRef.current?.focus();
  };

  const openHistory = async () => {
    setView("history");
    setHistory(null);
    const res = await transport.conversations();
    setHistory(res.ok ? res.data : []);
  };

  const openConversation = async (id: string) => {
    const res = await transport.conversation(id);
    if (!res.ok) {
      setError(res.message);
      setView("chat");
      return;
    }
    setMessages(
      res.data.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        status: m.status,
        actions: m.actions,
        fromFaq: m.fromFaq,
      })),
    );
    setDecisions({});
    deciding.current.clear();
    setConversationId(res.data.id);
    setError(null);
    setView("chat");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const starters = (config.starters ?? status?.starters ?? []).slice(0, 6);
  const allowance = status?.allowance ?? null;
  // Used up: only the business's own answers still work (review L11).
  const freeStarters = new Set(status?.freeStarters ?? []);
  const starterOff = (starter: string) => Boolean(allowance?.usedUp) && !freeStarters.has(starter);
  const notConfigured = status && !status.configured ? status.notConfiguredMessage : null;
  const settingsHref = status?.canManage ? (config.settingsHref ?? null) : null;

  let body: ReactNode;
  if (view === "history") {
    body = (
      <div className="aia-history" aria-label="Your conversations">
        {history === null ? (
          <p className="aia-activity">
            <span className="aia-dot" />
            Loading…
          </p>
        ) : history.length === 0 ? (
          <p className="aia-notice aia-notice-info">No conversations yet.</p>
        ) : (
          history.map((item) => (
            <button key={item.id} type="button" className="aia-history-item" onClick={() => void openConversation(item.id)}>
              {item.title}
              <span className="aia-history-when">{whenWords(item.lastMessageAt)}</span>
            </button>
          ))
        )}
      </div>
    );
  } else {
    body = (
      <div className="aia-thread" ref={threadRef} aria-live="polite" aria-busy={streaming}>
        {messages.length === 0 && !streaming ? (
          <div className="aia-empty">
            <p>{config.greeting ?? "Ask about your schedule, your invoices or your prices. I'll ask before I change anything."}</p>
            {starters.length > 0 ? (
              <div className="aia-starters" aria-label="Try asking">
                {starters.map((starter) => (
                  <button key={starter} type="button" className="aia-starter" disabled={starterOff(starter) || blocked !== null} onClick={() => void send(starter)}>
                    {starter}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {messages.map((message, i) =>
          message.role === "user" ? (
            <div key={message.id ?? `u${i}`} className="aia-msg aia-user">
              {message.text}
            </div>
          ) : (
            <div key={message.id ?? `a${i}`} className="aia-msg aia-assistant" data-aia-message="assistant">
              {message.text ? <div className="aia-md">{renderMarkdown(message.text, { links: message.fromFaq ? "site" : "all" })}</div> : null}
              {message.status === "stopped" ? <p className="aia-msg-note">Stopped.</p> : null}
              {message.status === "truncated" || message.status === "errored" ? <p className="aia-msg-note">This answer was cut short.</p> : null}
              {message.fromFaq ? <p className="aia-msg-note">From your business's own answers.</p> : null}
              {message.actions?.map((action) => (
                <ActionCard key={action.id} action={action} decision={decisions[action.id]} onDecide={(d, edits) => void decide(action.id, d, edits)} />
              ))}
            </div>
          ),
        )}
        {streaming && liveText ? (
          <div className="aia-msg aia-assistant">
            <div className="aia-md">{renderMarkdown(liveText)}</div>
          </div>
        ) : null}
        {streaming && !liveText ? (
          <p className="aia-activity">
            <span className="aia-dot" />
            {activity && activity.length > 0 ? `${activity.join(", ")}…` : "Thinking…"}
          </p>
        ) : null}
        {error ? (
          <p className="aia-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="aia-root aia-chat" data-theme={theme}>
      <div className="aia-head">
        <div className="aia-head-title">
          <h2 className="aia-title" id={headingId}>
            {view === "history" ? "Your conversations" : (config.title ?? "Assistant")}
          </h2>
          {config.subtitle && view === "chat" ? <p className="aia-subtitle">{config.subtitle}</p> : null}
        </div>
        {settingsHref ? (
          <a className="aia-btn aia-btn-quiet" href={settingsHref}>
            Settings
          </a>
        ) : null}
        {transport.hasHistory ? (
          <button
            type="button"
            className="aia-btn aia-btn-quiet aia-icon-btn"
            aria-label={view === "history" ? "Back to the chat" : "Your conversations"}
            aria-pressed={view === "history"}
            onClick={() => (view === "history" ? setView("chat") : void openHistory())}
          >
            <Icon path={ICON_HISTORY} />
          </button>
        ) : null}
        <button type="button" className="aia-btn aia-btn-quiet aia-icon-btn" aria-label="New conversation" onClick={startNew}>
          <Icon path={ICON_NEW} />
        </button>
        {onClose ? (
          <button type="button" className="aia-btn aia-btn-quiet aia-icon-btn" aria-label="Close the assistant" onClick={onClose} data-aia-close="">
            <Icon path={ICON_CLOSE} />
          </button>
        ) : null}
      </div>
      {allowance?.usedUp && allowance.message ? (
        <p className="aia-notice aia-notice-warn" role="status" data-aia-allowance="used-up">
          {allowance.message} Answers your business has written in still work.
        </p>
      ) : null}
      {blocked ? (
        <p className="aia-notice aia-notice-warn" role="status" data-aia-blocked="">
          {blocked}
        </p>
      ) : null}
      {notConfigured ? (
        <p className="aia-notice aia-notice-info" role="status">
          {notConfigured}
        </p>
      ) : null}
      {body}
      <form
        className="aia-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <label className="aia-sr" htmlFor={`${headingId}-q`}>
          Your question
        </label>
        <textarea
          id={`${headingId}-q`}
          ref={inputRef}
          className="aia-input"
          rows={1}
          value={input}
          placeholder="Ask a question…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button type="button" className="aia-btn" onClick={stop} data-aia-stop="">
            Stop
          </button>
        ) : (
          <button type="submit" className="aia-btn aia-btn-primary" disabled={!input.trim() || blocked !== null}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
