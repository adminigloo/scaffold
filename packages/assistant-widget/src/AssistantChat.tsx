import { useEffect, useRef, useState } from "react";
import { injectStyles } from "./styles.js";
import {
  ERROR_COPY,
  type AssistantConfig,
  type ChatMessage,
  type WidgetStreamEvent,
} from "./types.js";

/**
 * The assistant's chat surface — a controlled component speaking the versioned
 * SSE protocol. Text streams live; when a step turns out to end in tool use,
 * that step's text was preamble, so the provisional bubble is CLEARED and tool
 * activity shown instead (the step-restart design). The final answer is
 * whatever text the ending step produced. Errors arrive as typed classes mapped
 * to copy — the widget never parses a message string.
 */
export function AssistantChat({ config }: { config: AssistantConfig }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [activity, setActivity] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Array<{ actionId: string; summary: string }>>([]);
  const [resolved, setResolved] = useState<Record<string, { status: "confirmed" | "declined" | "error"; note?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  /** Confirm or decline a proposed write against the confirm endpoint. */
  const act = async (actionId: string, decision: "confirm" | "decline") => {
    if (!config.confirmUrl || resolved[actionId]) return;
    try {
      const res = await fetch(config.confirmUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId, decision }),
      });
      const data = (await res.json().catch(() => ({}))) as { executed?: boolean; reason?: string; declined?: boolean };
      if (decision === "decline") {
        setResolved((r) => ({ ...r, [actionId]: { status: "declined" } }));
      } else {
        setResolved((r) => ({
          ...r,
          [actionId]: res.ok && data.executed ? { status: "confirmed" } : { status: "error", note: data.reason },
        }));
      }
    } catch {
      setResolved((r) => ({ ...r, [actionId]: { status: "error" } }));
    }
  };

  useEffect(() => injectStyles(), []);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, liveText, activity]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setStreaming(true);
    setLiveText("");
    setActivity(null);
    setPending([]);

    let acc = "";
    const collected: Array<{ actionId: string; summary: string }> = [];
    try {
      const res = await fetch(config.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, conversationId: conversationId.current }),
      });
      if (!res.ok || !res.body) {
        let cls = "internal";
        try {
          cls = ((await res.json()) as { errorClass?: string }).errorClass ?? "internal";
        } catch {
          /* keep default */
        }
        setError(ERROR_COPY[cls] ?? ERROR_COPY.internal!);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!raw.startsWith("data:")) continue;
          let ev: WidgetStreamEvent;
          try {
            ev = JSON.parse(raw.slice(5).trim()) as WidgetStreamEvent;
          } catch {
            continue;
          }
          if (ev.type === "text") {
            acc += ev.delta;
            setLiveText(acc);
          } else if (ev.type === "step") {
            // The text so far was preamble; clear it and show the activity.
            acc = "";
            setLiveText("");
            setActivity(ev.tools.map((t) => t.label));
          } else if (ev.type === "action") {
            collected.push({ actionId: ev.actionId, summary: ev.summary });
            setPending([...collected]);
          } else if (ev.type === "error") {
            setError(ERROR_COPY[ev.errorClass] ?? ev.message);
            finished = true;
          } else if (ev.type === "done") {
            conversationId.current = ev.meta.conversationId;
            setMessages((m) => [
              ...m,
              {
                role: "assistant",
                text: acc,
                status: ev.meta.status as ChatMessage["status"],
                actions: collected.length > 0 ? [...collected] : undefined,
              },
            ]);
            finished = true;
          }
        }
      }
    } catch {
      setError(ERROR_COPY.internal!);
    } finally {
      setStreaming(false);
      setLiveText("");
      setActivity(null);
      setPending([]);
    }
  };

  return (
    <div className="aia-root">
      <div className="aia-thread" ref={threadRef}>
        {messages.length === 0 && !streaming ? (
          <p className="aia-empty">{config.greeting ?? "Ask me anything about your account."}</p>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`aia-msg ${m.role === "user" ? "aia-user" : "aia-assistant"} ${m.status === "truncated" ? "aia-truncated" : ""}`}>
            {m.text || (m.status === "truncated" ? "(answer cut off)" : "")}
            {m.actions?.map((a) => {
              const r = resolved[a.actionId];
              const label =
                r?.status === "confirmed"
                  ? "Confirmed"
                  : r?.status === "declined"
                    ? "Declined"
                    : r?.status === "error"
                      ? `Couldn't complete${r.note ? ` (${r.note})` : ""}`
                      : "Needs your confirmation";
              return (
                <div key={a.actionId} className="aia-action" style={{ marginTop: 8 }}>
                  <div className="aia-action-label">{label}</div>
                  {a.summary}
                  {!r && config.confirmUrl ? (
                    <div className="aia-action-buttons">
                      <button type="button" className="aia-confirm" onClick={() => void act(a.actionId, "confirm")}>
                        Confirm
                      </button>
                      <button type="button" className="aia-decline" onClick={() => void act(a.actionId, "decline")}>
                        Decline
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {streaming && liveText ? <div className="aia-msg aia-assistant">{liveText}</div> : null}
        {streaming && activity ? (
          <div className="aia-activity">
            <span className="aia-dot" />
            {activity.length > 0 ? activity.join(", ") : "Working…"}
          </div>
        ) : null}
        {streaming && !liveText && !activity ? (
          <div className="aia-activity"><span className="aia-dot" />Thinking…</div>
        ) : null}
        {pending.map((a) => (
          <div key={a.actionId} className="aia-action">
            <div className="aia-action-label">Needs your confirmation</div>
            {a.summary}
          </div>
        ))}
        {error ? <p className="aia-error">{error}</p> : null}
      </div>
      <div className="aia-compose">
        <textarea
          className="aia-input"
          value={input}
          placeholder="Ask the assistant…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="aia-send" disabled={!input.trim() || streaming} onClick={() => void send()}>
          {streaming ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
