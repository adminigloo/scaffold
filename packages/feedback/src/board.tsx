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
  reporterName?: string | null;
  reporterEmail?: string | null;
  pagePathname?: string | null;
  screenshotUrl?: string | null;
  annotatedScreenshotUrl?: string | null;
  /** Date or ISO string — serialization boundaries turn Dates into strings. */
  createdAt: Date | string;
}

export interface FeedbackBoardProps {
  statuses: BoardStatusView[];
  tickets: BoardTicketView[];
  /** Called on drop. Reject (throw) to leave the card where it was. */
  onMove: (ticketId: string, statusKey: string) => void | Promise<void>;
}

const STYLE_ID = "aib-styles";

const CSS_TEXT = `
.aib-board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.aib-col { flex: 0 0 270px; background: #f4f5f7; border: 1px solid #e4e7ea; border-radius: 10px; }
.aib-col-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e4e7ea; }
.aib-col-dot { width: 9px; height: 9px; border-radius: 50%; }
.aib-col-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #40444b; }
.aib-col-count { margin-left: auto; font-size: 11px; color: #7c828a; font-variant-numeric: tabular-nums; }
.aib-col-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; min-height: 60px; }
.aib-col.aib-over { outline: 2px dashed #9aa4ff; outline-offset: -4px; }
.aib-card { background: #ffffff; border: 1px solid #e4e7ea; border-radius: 8px; padding: 10px 11px;
  cursor: grab; box-shadow: 0 1px 2px rgba(15,18,22,.05); }
.aib-card:active { cursor: grabbing; }
.aib-card.aib-dragging { opacity: .45; }
.aib-card.aib-busy { opacity: .55; pointer-events: none; }
.aib-card-top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.aib-num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: #7c828a; }
.aib-chip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  border: 1px solid; border-radius: 3px; padding: 1px 5px; margin-left: auto; }
.aib-chip-critical { color: #c02626; border-color: #c02626; }
.aib-chip-high { color: #b45f06; border-color: #b45f06; }
.aib-chip-medium, .aib-chip-low { color: #7c828a; border-color: #c9ced4; }
.aib-card-title { font-size: 13px; line-height: 1.4; color: #1a1d21; overflow-wrap: anywhere; }
.aib-card-meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: #7c828a; flex-wrap: wrap; }
.aib-card-meta a { color: #4655d4; text-decoration: none; }
.aib-card-meta a:hover { text-decoration: underline; }
.aib-empty { font-size: 12px; color: #9aa0a8; text-align: center; padding: 14px 0; }
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

function ageOf(createdAt: Date | string): string {
  const then = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

export function FeedbackBoard({ statuses, tickets, onMove }: FeedbackBoardProps): ReactElement {
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
                >
                  <div className="aib-card-top">
                    <span className="aib-num">{ticket.ticketNumber}</span>
                    <span className={`aib-chip aib-chip-${ticket.priority}`}>{ticket.priority}</span>
                  </div>
                  <div className="aib-card-title">{ticket.title}</div>
                  <div className="aib-card-meta">
                    <span>{ageOf(ticket.createdAt)}</span>
                    {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
                    {ticket.reporterName || ticket.reporterEmail ? (
                      <span>{ticket.reporterName ?? ticket.reporterEmail}</span>
                    ) : null}
                    {(ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl) ? (
                      <a
                        href={ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        draggable={false}
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
