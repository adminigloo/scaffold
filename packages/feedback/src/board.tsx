import { useCallback, useEffect, useState, type ReactElement } from "react";

/**
 * The Kanban board — the `./board` entry, and the only client code in this
 * package. Controlled on purpose: it renders what it is given and reports
 * moves through `onMove`, so it works under tRPC, server actions, or plain
 * fetch — whatever the consuming app already uses. Styling is injected and
 * `aib-`-prefixed like the widget's, because a package class name means
 * nothing to the consumer's Tailwind build.
 */

export interface BoardStatusView {
  key: string;
  label: string;
  color?: string | null;
  sortOrder?: number;
}

export interface BoardTicketView {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category?: string | null;
  status: string;
  assignee?: string | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  /** Optional so a consumer on a pre-0.5 server half still typechecks. */
  hasUnreadReporterReply?: boolean | null;
  pagePathname?: string | null;
  screenshotUrl?: string | null;
  annotatedScreenshotUrl?: string | null;
  /** Date or ISO string — serialization boundaries turn Dates into strings. */
  createdAt: Date | string;
}

export interface TicketMessageView {
  id: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: Date | string;
}

export interface FeedbackBoardProps {
  statuses: BoardStatusView[];
  tickets: BoardTicketView[];
  /** Called on drop. Reject (throw) to leave the card where it was. */
  onMove: (ticketId: string, statusKey: string) => void | Promise<void>;
  /** Card click. Wire this to open the TicketPanel. */
  onOpen?: (ticket: BoardTicketView) => void;
}

const STYLE_ID = "aib-styles";

/*
 * The board's own token set, `--aib-*`, with a dark theme decided by
 * prefers-color-scheme — the same self-containment rule the widget follows
 * and for the same reason: this renders inside a consuming app whose theme it
 * cannot know, and a hardcoded white board in a dark admin reads as a foreign
 * object. Every colour resolves through a token; one bare hex is a rule
 * nobody re-tests in the other theme.
 */
const CSS_TEXT = `
.aib-board, .aib-panel, .aib-panel-backdrop {
  --aib-surface: #ffffff;
  --aib-surface-2: #f5f7f9;
  --aib-ink: #0e161c;
  --aib-ink-muted: #55636f;
  --aib-ink-faint: #8494a1;
  --aib-line: #e1e7ec;
  --aib-line-strong: #c3ced7;
  --aib-accent: #0f766e;
  --aib-accent-strong: #0c5f59;
  --aib-accent-soft: #d9efec;
  --aib-danger: #a02e21;
  --aib-warn: #7d5a0c;
  --aib-on-accent: #ffffff;
  --aib-shadow-card: 0 1px 2px rgba(14,22,28,.06);
  --aib-shadow-panel: -12px 0 40px rgba(14,22,28,.2);
  --aib-scrim: rgba(10,14,17,.45);
}
@media (prefers-color-scheme: dark) {
  .aib-board, .aib-panel, .aib-panel-backdrop {
    --aib-surface: #161d23;
    --aib-surface-2: #0f1418;
    --aib-ink: #e8edf1;
    --aib-ink-muted: #93a2ae;
    --aib-ink-faint: #61707c;
    --aib-line: #29343d;
    --aib-line-strong: #3c4a55;
    --aib-accent: #45c4ad;
    --aib-accent-strong: #6cd6c3;
    --aib-accent-soft: #113029;
    --aib-danger: #e08272;
    --aib-warn: #cfa14e;
    --aib-on-accent: #0e161c;
    --aib-shadow-card: 0 1px 2px rgba(0,0,0,.4);
    --aib-shadow-panel: -12px 0 40px rgba(0,0,0,.55);
    --aib-scrim: rgba(0,0,0,.55);
  }
}

.aib-board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--aib-ink); }
.aib-col { flex: 0 0 270px; background: var(--aib-surface-2); border: 1px solid var(--aib-line); border-radius: 12px; }
.aib-col-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--aib-line); }
.aib-col-dot { width: 9px; height: 9px; border-radius: 50%; }
.aib-col-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--aib-ink-muted); }
.aib-col-count { margin-left: auto; font-size: 11px; color: var(--aib-ink-faint); font-variant-numeric: tabular-nums; }
.aib-col-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; min-height: 60px; }
.aib-col.aib-over { outline: 2px dashed var(--aib-accent); outline-offset: -4px; }
.aib-card { background: var(--aib-surface); border: 1px solid var(--aib-line); border-radius: 10px; padding: 10px 11px;
  cursor: grab; box-shadow: var(--aib-shadow-card); transition: border-color .12s ease; }
.aib-card:hover { border-color: var(--aib-line-strong); }
.aib-card:active { cursor: grabbing; }
.aib-card.aib-dragging { opacity: .45; }
.aib-card.aib-busy { opacity: .55; pointer-events: none; }
.aib-card-top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.aib-num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--aib-ink-faint); }
.aib-chip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  border: 1px solid; border-radius: 999px; padding: 1px 6px; margin-left: auto; }
.aib-chip-critical { color: var(--aib-danger); border-color: var(--aib-danger); }
.aib-chip-high { color: var(--aib-warn); border-color: var(--aib-warn); }
.aib-chip-medium, .aib-chip-low { color: var(--aib-ink-faint); border-color: var(--aib-line-strong); }
.aib-card-title { font-size: 13px; line-height: 1.4; color: var(--aib-ink); overflow-wrap: anywhere; }
.aib-card-meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--aib-ink-muted); flex-wrap: wrap; }
.aib-card-meta a { color: var(--aib-accent); text-decoration: none; }
.aib-card-meta a:hover { text-decoration: underline; }
.aib-empty { font-size: 12px; color: var(--aib-ink-faint); text-align: center; padding: 14px 0; }
.aib-assignee { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--aib-accent);
  background: var(--aib-accent-soft); border-radius: 999px; padding: 1px 8px; }
.aib-unread { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; color: var(--aib-on-accent);
  background: var(--aib-accent); border-radius: 999px; padding: 1px 7px; }

/* Ticket panel */
.aib-panel-backdrop { position: fixed; inset: 0; z-index: 2147483002; background: var(--aib-scrim); }
.aib-panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483003; width: min(480px, 96vw);
  background: var(--aib-surface); border-left: 1px solid var(--aib-line); box-shadow: var(--aib-shadow-panel);
  display: flex; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--aib-ink); }
.aib-panel-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid var(--aib-line); }
.aib-panel-title { font-size: 15px; font-weight: 700; line-height: 1.35; letter-spacing: -.01em; overflow-wrap: anywhere; }
.aib-panel-sub { margin-top: 3px; font-size: 12px; color: var(--aib-ink-muted); display: flex; gap: 8px; flex-wrap: wrap; }
.aib-panel-sub a { color: var(--aib-accent); }
.aib-panel-close { margin-left: auto; flex: none; border: 0; background: transparent; cursor: pointer;
  font-size: 18px; line-height: 1; color: var(--aib-ink-muted); padding: 2px 6px; border-radius: 8px; }
.aib-panel-close:hover { background: var(--aib-surface-2); color: var(--aib-ink); }
.aib-panel-controls { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--aib-line); }
.aib-panel-controls label { display: flex; flex-direction: column; gap: 3px; flex: 1; font-size: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--aib-ink-muted); }
.aib-select, .aib-input { border: 1px solid var(--aib-line-strong); border-radius: 8px; padding: 6px 8px; font: inherit;
  font-size: 13px; background: var(--aib-surface); color: var(--aib-ink); width: 100%; box-sizing: border-box; }
.aib-thread { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.aib-msg { border: 1px solid var(--aib-line); border-radius: 10px; padding: 8px 11px; font-size: 13px; }
.aib-msg-staff { background: var(--aib-accent-soft); border-color: transparent; }
.aib-msg-reporter { background: var(--aib-surface); }
.aib-msg-system { background: transparent; border-style: dashed; color: var(--aib-ink-muted); font-size: 12px; }
.aib-msg-meta { display: flex; gap: 8px; font-size: 11px; color: var(--aib-ink-muted); margin-bottom: 3px; }
.aib-msg-meta b { color: var(--aib-ink); }
.aib-msg-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.aib-thread-empty { font-size: 12px; color: var(--aib-ink-faint); text-align: center; padding: 18px 0; }
.aib-compose { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--aib-line); }
.aib-compose textarea { flex: 1; min-height: 58px; resize: vertical; border: 1px solid var(--aib-line-strong);
  border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
  background: var(--aib-surface); color: var(--aib-ink); }
.aib-send { align-self: flex-end; border: 0; border-radius: 8px; background: var(--aib-accent); color: var(--aib-on-accent);
  font-size: 13px; font-weight: 600; padding: 9px 14px; cursor: pointer; transition: background .12s ease; }
.aib-send:hover { background: var(--aib-accent-strong); }
.aib-send:disabled { background: var(--aib-ink-faint); cursor: default; }
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

function timeOf(createdAt: Date | string): string {
  const then = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return then.toISOString().replace("T", " ").slice(0, 16);
}

export interface TicketPanelProps {
  ticket: BoardTicketView;
  messages: TicketMessageView[];
  statuses: BoardStatusView[];
  /** Shown as the sender on messages this viewer writes. */
  currentUser: string;
  onClose: () => void;
  onSend: (body: string) => void | Promise<void>;
  onAssign: (assignee: string | null) => void | Promise<void>;
  onMove: (statusKey: string) => void | Promise<void>;
}

/**
 * One ticket's working surface: the report, its conversation, and the two
 * controls triage actually uses (status, assignee). Controlled like the
 * board — it renders what it is given and reports intents; the consumer
 * owns fetching and refetching.
 */
export function TicketPanel({
  ticket,
  messages,
  statuses,
  currentUser,
  onClose,
  onSend,
  onAssign,
  onMove,
}: TicketPanelProps): ReactElement {
  useEffect(() => {
    injectStyles();
  }, []);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="aib-panel-backdrop" onClick={onClose} />
      <aside className="aib-panel" aria-label={`Ticket ${ticket.ticketNumber}`}>
        <div className="aib-panel-head">
          <div>
            <div className="aib-panel-title">
              {ticket.ticketNumber} — {ticket.title}
            </div>
            <div className="aib-panel-sub">
              <span>{ageOf(ticket.createdAt)}</span>
              {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
              {ticket.reporterName || ticket.reporterEmail ? (
                <span>from {ticket.reporterName ?? ticket.reporterEmail}</span>
              ) : null}
              {(ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl) ? (
                <a
                  href={ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                >
                  screenshot ↗
                </a>
              ) : null}
            </div>
          </div>
          <button type="button" className="aib-panel-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="aib-panel-controls">
          <label>
            Status
            <select
              className="aib-select"
              value={ticket.status}
              onChange={(event) => void onMove(event.target.value)}
            >
              {statuses.map((status) => (
                <option key={status.key} value={status.key}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <input
              className="aib-input"
              defaultValue={ticket.assignee ?? ""}
              placeholder="unassigned"
              onBlur={(event) => {
                const next = event.target.value.trim() || null;
                if (next !== (ticket.assignee ?? null)) void onAssign(next);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") (event.target as HTMLInputElement).blur();
              }}
            />
          </label>
        </div>

        <div className="aib-thread">
          {messages.length === 0 ? (
            <div className="aib-thread-empty">No notes yet — the report above is the whole story so far.</div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`aib-msg aib-msg-${message.senderType}`}>
              {message.senderType === "system" ? (
                <span>
                  {message.body} — {message.senderName}, {timeOf(message.createdAt)}
                </span>
              ) : (
                <>
                  <div className="aib-msg-meta">
                    <b>{message.senderName}</b>
                    <span>{timeOf(message.createdAt)}</span>
                  </div>
                  <div className="aib-msg-body">{message.body}</div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="aib-compose">
          <textarea
            value={draft}
            placeholder={`Note as ${currentUser}…`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
            }}
          />
          <button type="button" className="aib-send" disabled={!draft.trim() || sending} onClick={() => void send()}>
            {sending ? "…" : "Send"}
          </button>
        </div>
      </aside>
    </>
  );
}

function ageOf(createdAt: Date | string): string {
  const then = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

export function FeedbackBoard({ statuses, tickets, onMove, onOpen }: FeedbackBoardProps): ReactElement {
  useEffect(() => {
    injectStyles();
  }, []);

  // The board's own copy of ticket→status, so a drop lands instantly and a
  // rejected move snaps back — optimistic UI without owning the data.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const statusOf = useCallback(
    (ticket: BoardTicketView) => overrides[ticket.id] ?? ticket.status,
    [overrides],
  );

  const handleDrop = useCallback(
    async (statusKey: string) => {
      setOverColumn(null);
      const ticketId = draggingId;
      setDraggingId(null);
      if (!ticketId) return;
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket || statusOf(ticket) === statusKey) return;

      const previous = statusOf(ticket);
      setOverrides((prev) => ({ ...prev, [ticketId]: statusKey }));
      setBusyId(ticketId);
      try {
        await onMove(ticketId, statusKey);
      } catch {
        setOverrides((prev) => ({ ...prev, [ticketId]: previous }));
      } finally {
        setBusyId(null);
      }
    },
    [draggingId, tickets, statusOf, onMove],
  );

  const ordered = [...statuses].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return (
    <div className="aib-board">
      {ordered.map((status) => {
        const cards = tickets.filter((ticket) => statusOf(ticket) === status.key);
        return (
          <div
            key={status.key}
            className={`aib-col${overColumn === status.key ? " aib-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverColumn(status.key);
            }}
            onDragLeave={() => setOverColumn((current) => (current === status.key ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              void handleDrop(status.key);
            }}
          >
            <div className="aib-col-head">
              <span className="aib-col-dot" style={{ background: status.color ?? "#9aa0a8" }} />
              <span className="aib-col-title">{status.label}</span>
              <span className="aib-col-count">{cards.length}</span>
            </div>
            <div className="aib-col-body">
              {cards.length === 0 ? <div className="aib-empty">No tickets</div> : null}
              {cards.map((ticket) => (
                <div
                  key={ticket.id}
                  className={`aib-card${draggingId === ticket.id ? " aib-dragging" : ""}${busyId === ticket.id ? " aib-busy" : ""}`}
                  draggable
                  onDragStart={() => setDraggingId(ticket.id)}
                  onDragEnd={() => setDraggingId(null)}
                  onClick={onOpen ? () => onOpen(ticket) : undefined}
                  style={onOpen ? { cursor: "pointer" } : undefined}
                >
                  <div className="aib-card-top">
                    <span className="aib-num">{ticket.ticketNumber}</span>
                    {/* The reporter answered and nobody has opened the ticket
                        since. THE signal triage scans for — opening the panel
                        clears it via the consumer's markRead call. */}
                    {ticket.hasUnreadReporterReply ? (
                      <span className="aib-unread">reply</span>
                    ) : null}
                    <span className={`aib-chip aib-chip-${ticket.priority}`}>{ticket.priority}</span>
                  </div>
                  <div className="aib-card-title">{ticket.title}</div>
                  <div className="aib-card-meta">
                    <span>{ageOf(ticket.createdAt)}</span>
                    {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
                    {ticket.assignee ? <span className="aib-assignee">{ticket.assignee}</span> : null}
                    {ticket.reporterName || ticket.reporterEmail ? (
                      <span>{ticket.reporterName ?? ticket.reporterEmail}</span>
                    ) : null}
                    {(ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl) ? (
                      <a
                        href={ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        draggable={false}
                        onClick={(event) => event.stopPropagation()}
                      >
                        screenshot ↗
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
