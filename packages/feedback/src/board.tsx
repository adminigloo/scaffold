import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { BoardStyles, useBoardStyles } from "./board-styles";
import {
  FeedbackAdminClient,
  FeedbackAdminError,
  type FeedbackBoardWire,
  type FeedbackCategoryWire,
  type FeedbackEventWire,
  type FeedbackMessageWire,
  type FeedbackPersonWire,
  type FeedbackTicketDetailWire,
  type TicketPatch,
} from "./board-client";
import { EMPTY_FILTERS, FILTER_PRIORITIES, PRIORITY_LABELS, SOURCE_LABELS, isUnfiltered, type FilterSource } from "./board-filters";
import {
  BoardToolbar,
  boardFilterFields,
  boardQuickFilters,
  filtersForRequest,
  useBoardFilters,
  windowFilterUrl,
  type BoardFilterUrl,
} from "./board-toolbar";
import { NewTicketDialog } from "./ticket-dialog";

export * from "./board-client";
export * from "./board-filters";
export * from "./board-toolbar";
export { NewTicketDialog, type NewTicketDialogProps } from "./ticket-dialog";

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
  /** All optional so a consumer on a pre-0.7 server still typechecks. */
  isTerminal?: boolean | null;
  wipLimit?: number | null;
  agingWarnHours?: number | null;
  agingStaleHours?: number | null;
}

export interface BoardTicketView {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category?: string | null;
  status: string;
  assignee?: string | null;
  /** The host's id of the assignee, when picked from the company's people (0.11.0). */
  assigneeId?: string | null;
  /** "widget" | "page" | "staff" (0.11.0): shown in the panel as where it came from. */
  source?: string | null;
  /** False (0.11.0): the reporter isn't emailed about it — the reply box says so. */
  notifyReporter?: boolean | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  /** Optional so a consumer on a pre-0.5 server half still typechecks. */
  hasUnreadReporterReply?: boolean | null;
  pagePathname?: string | null;
  screenshotUrl?: string | null;
  annotatedScreenshotUrl?: string | null;
  /** Date or ISO string — serialization boundaries turn Dates into strings. */
  createdAt: Date | string;
  /** When the ticket last changed column (0.7.0). Aging falls back to createdAt. */
  statusChangedAt?: Date | string | null;
  /** Set = archived. The card renders with a dashed edge and a badge; it never renders at all unless the consumer asked the server for archived rows. */
  archivedAt?: Date | string | null;
}

export interface TicketMessageView {
  id: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: Date | string;
}

/** The client context a report arrived with — the widget's clientMetadata. */
export interface TicketContextView {
  browser?: string | null;
  os?: string | null;
  viewport?: { width?: number | null; height?: number | null } | null;
  url?: string | null;
  pathname?: string | null;
  clickTrail?: Array<{
    type?: string | null;
    target?: string | null;
    value?: string | null;
    timestamp?: number | null;
  }> | null;
}

/** A browser error captured with the report — the widget's recentErrors. */
export interface TicketErrorView {
  type?: string | null;
  message?: string | null;
  url?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
}

/**
 * The heavy half of a ticket — the report body and the captured context — kept
 * OUT of the board payload (which caps at hundreds of cards) and fetched by the
 * consumer only when a panel opens. Hand it to `TicketPanel.detail`; absent,
 * the panel still shows the report's screenshot, which rides on the card.
 */
export interface TicketDetailView {
  description?: string | null;
  context?: TicketContextView | null;
  errors?: TicketErrorView[] | null;
}

/**
 * `auto` (the default) follows the viewer's OS setting; `light` / `dark` pin
 * it — pass `light` inside an admin that has no dark mode, or a dark-OS viewer
 * gets a dark board on a white page (0.9.0).
 */
export type BoardTheme = "auto" | "light" | "dark";

/**
 * What `onMoveMany` may resolve with (0.9.0) when SOME of a batch was refused:
 * only those cards go back, the rest stay moved. Resolving nothing means all
 * landed; throwing means none did.
 */
export interface BulkMoveResult {
  failed?: string[];
}

export interface FeedbackBoardProps {
  statuses: BoardStatusView[];
  tickets: BoardTicketView[];
  /**
   * Called on drop (and on Alt+← / Alt+→ from a focused card). Reject (throw)
   * to put the card back where it was: a promise that RESOLVES counts as a
   * landed move, so an API that reports failure as a value — a Next server
   * action's `{ ok: false }` — must be turned into a throw here.
   */
  onMove: (ticketId: string, statusKey: string) => void | Promise<void>;
  /**
   * Card click. Wire this to open the TicketPanel, or to navigate. With
   * `ticketHref` too, a plain click on the title calls this and a
   * modified click (new tab) follows the link.
   */
  onOpen?: (ticket: BoardTicketView) => void;
  /**
   * A real URL for each ticket (0.9.0). The card title becomes a link, so it
   * can be middle-clicked, copied, and reached from the keyboard as a link.
   */
  ticketHref?: (ticket: BoardTicketView) => string | undefined;
  /**
   * Bulk move (0.7.0). Providing this is what turns selection ON: cards grow
   * checkboxes, column headers a tri-state select-all, a bar appears when
   * anything is selected, and dragging a selected card carries the whole
   * selection. Absent, the board is exactly the single-drag board it was.
   * Same contract as `onMove` — throw to roll the whole batch back — or
   * resolve `{ failed: [ids] }` to roll back only those.
   */
  onMoveMany?: (ticketIds: string[], statusKey: string) => void | Promise<void | BulkMoveResult>;
  /**
   * A move was refused — `onMove`/`onMoveMany` threw (0.9.0). The cards are
   * already back where they were; this is where the consumer tells the person
   * why (a toast). Without it the rollback is silent.
   */
  onMoveError?: (error: unknown, ticketIds: string[], statusKey: string) => void;
  /**
   * New ticket in a column (0.11.0): each column's header grows a "+" that
   * calls this with the column's key. Absent, there is no "+".
   */
  onCreateInColumn?: (statusKey: string) => void;
  /** See `BoardTheme`. Default `auto`. */
  theme?: BoardTheme;
}


function toDate(value: Date | string): Date | null {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The panel's default timestamp: the viewer's own locale and time zone. */
function defaultFormatTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** An unparseable date renders as written rather than crashing the panel (0.8.0 threw a RangeError). */
function timeOf(createdAt: Date | string, format: (date: Date) => string): string {
  const date = toDate(createdAt);
  return date ? format(date) : String(createdAt);
}

/** The card title with this ticket id, wherever its column now is. */
function findHandle(scope: ParentNode | null | undefined, ticketId: string): HTMLElement | null {
  if (!scope) return null;
  for (const el of scope.querySelectorAll<HTMLElement>("[data-aib-open]")) {
    if (el.dataset.aibOpen === ticketId) return el;
  }
  return null;
}

/** Keys that step a closed <select> to a neighbouring option. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type TicketPanelAction = "move" | "assign" | "archive" | "send" | "update";

/** One line of the activity trail, as the panel reads it (FeedbackEventWire is one). */
export interface TicketEventView {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  actorName: string;
  createdAt: Date | string;
}

export interface TicketPanelProps {
  ticket: BoardTicketView;
  messages: TicketMessageView[];
  statuses: BoardStatusView[];
  /**
   * The report body, captured context and browser errors, fetched on open.
   * Optional: without it the panel still shows the annotated screenshot (which
   * travels on the card) and the conversation — the detail simply fills in as
   * the consumer's fetch resolves.
   */
  detail?: TicketDetailView | null;
  /** Shown as the sender on messages this viewer writes. */
  currentUser: string;
  onClose: () => void;
  onSend: (body: string) => void | Promise<void>;
  onAssign: (assignee: string | null) => void | Promise<void>;
  onMove: (statusKey: string) => void | Promise<void>;
  /**
   * Archive / unarchive (0.7.0), rendered only when provided. Which of the
   * two the button means comes from the ticket's own archivedAt — the panel
   * reports the intent, the consumer flips the row.
   */
  onArchive?: () => void | Promise<void>;
  /**
   * One of the callbacks above threw or rejected (0.9.0). 0.8.0 let those
   * become unhandled promise rejections; now the panel catches them, keeps
   * the draft on a failed send, and hands the error here.
   */
  onError?: (error: unknown, action: TicketPanelAction) => void;
  /** How message times read (0.9.0). Default: the viewer's locale and time zone. */
  formatTime?: (date: Date) => string;
  /** See `BoardTheme`. Default `auto`. */
  theme?: BoardTheme;
  /**
   * Editing (0.11.0): given, the title, priority and category become
   * editable (and, with `people`, the assignee is picked from a list). Same
   * contract as the other callbacks — throw to refuse; the panel puts the
   * old value back and hands the error to `onError`.
   */
  onUpdate?: (patch: TicketPatch) => void | Promise<void>;
  /** The board's categories, for the editor's Category choice. */
  categories?: ReadonlyArray<{ key: string; label: string }>;
  /** The company's people: the assignee becomes a list (`onUpdate({ assigneeId })`) instead of a typed name. */
  people?: ReadonlyArray<{ id: string; name: string }> | null;
  /** The activity trail, oldest first; shown under the report. */
  events?: ReadonlyArray<TicketEventView> | null;
  /**
   * Does this board email the reporter when the team replies (0.11.0)? The
   * reply box says plainly who reads a reply — emailed to the customer, seen
   * under "My reports", or kept to the team. Pass false where no email is
   * sent (no mail set up). Default true.
   */
  emailsReporters?: boolean;
}

/**
 * Who reads a reply, in words, for the reply box (0.11.0): it must never be
 * a surprise that what you type goes to the customer.
 */
export function replyAudience(
  ticket: Pick<BoardTicketView, "reporterName" | "reporterEmail" | "source" | "notifyReporter">,
  emailsReporters = true,
): { label: string; note: string } {
  const who = ticket.reporterName?.trim() || ticket.reporterEmail?.trim() || null;
  const email = ticket.reporterEmail?.trim() || null;
  const emailed = emailsReporters && email !== null && ticket.notifyReporter !== false;
  if (ticket.source === "staff") {
    return emailed
      ? { label: `Reply to ${who}`, note: `Your reply is emailed to ${who === email ? email : `${who} (${email})`}.` }
      : { label: "Note for your team", note: "Only your team sees what you write here: the customer isn't told about this ticket." };
  }
  if (emailed) {
    return {
      label: `Reply to ${who}`,
      note: `Your reply is emailed to ${who === email ? email : `${who} (${email})`}, and shows under "My reports".`,
    };
  }
  return {
    label: `Reply to ${who ?? "the customer"}`,
    note: `${who ?? "The customer"} sees your reply under "My reports", on the device they sent this from. It isn't emailed.`,
  };
}

/** The assignee select's value for a name typed the 0.10 way (no person id). */
const TYPED_ASSIGNEE = "\u0000typed";

/** "Ada moved it from Open to In progress." — one trail line, in words. */
function eventWords(event: TicketEventView): string {
  const who = event.actorName;
  const from = event.fromValue;
  const to = event.toValue;
  switch (event.kind) {
    case "created":
      return `${who} filed it`;
    case "title":
      return `${who} renamed it to “${to ?? ""}”`;
    case "priority":
      return `${who} changed the priority from ${from ?? "none"} to ${to ?? "none"}`;
    case "category":
      return to ? `${who} filed it under ${to}${from ? ` (was ${from})` : ""}` : `${who} took it out of ${from ?? "its category"}`;
    case "assignee":
      return to ? `${who} assigned it to ${to}` : `${who} unassigned it${from ? ` (was ${from})` : ""}`;
    case "status":
      return `${who} moved it from ${from ?? "?"} to ${to ?? "?"}`;
    case "archived":
      return `${who} archived it`;
    case "unarchived":
      return `${who} brought it back from the archive`;
    default:
      return `${who} changed it`;
  }
}

/**
 * One ticket's working surface: the report, its conversation, and the two
 * controls triage actually uses (status, assignee). Controlled like the
 * board — it renders what it is given and reports intents; the consumer
 * owns fetching and refetching.
 *
 * 0.9.0: a modal dialog in fact as well as in look — focus moves into it on
 * open, Tab and Shift+Tab stay inside, Escape closes it, and focus returns to
 * whatever opened it.
 */
export function TicketPanel({
  ticket,
  messages,
  statuses,
  detail,
  currentUser,
  onClose,
  onSend,
  onAssign,
  onMove,
  onArchive,
  onError,
  formatTime = defaultFormatTime,
  theme = "auto",
  onUpdate,
  categories = [],
  people = null,
  events = null,
  emailsReporters = true,
}: TicketPanelProps): ReactElement {
  useBoardStyles();
  const [draft, setDraft] = useState("");
  /** The title being edited (null: not editing). */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  /** An applied edit shown until the `ticket` prop catches up (or the edit is refused). */
  const [pendingPatch, setPendingPatch] = useState<TicketPatch>({});
  const [sending, setSending] = useState(false);
  /** A keyboard choice not yet applied (arrows on the closed select). */
  const [statusDraft, setStatusDraft] = useState<string | null>(null);
  /** An applied choice shown until the `ticket` prop catches up with it. */
  const [statusSent, setStatusSent] = useState<string | null>(null);
  /** The NEXT change of the select is an arrow/typeahead step on a closed control. */
  const nextChangeIsStep = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const assigneeSent = useRef<string | null | undefined>(undefined);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (statusSent !== null && ticket.status === statusSent) setStatusSent(null);
  // A panel switched to another ticket starts clean.
  const [shownId, setShownId] = useState(ticket.id);
  if (shownId !== ticket.id) {
    setShownId(ticket.id);
    setStatusDraft(null);
    setStatusSent(null);
    setTitleDraft(null);
    setPendingPatch({});
    assigneeSent.current = undefined;
  }

  // Focus in on open; back out on close — to the opener, or, when the opener
  // is gone (the card changed column, or was clicked on its body rather than
  // its title), to this ticket's card title wherever it now is.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ticketId = ticket.id;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(".aib-panel-close")?.focus();

    // Focus can still fall to <body> (a control that disables itself, a
    // removed node). Keys aimed at <body> while the panel is open belong to
    // the panel: Escape closes it, Tab re-enters it. Keys aimed anywhere else
    // — a dialog stacked above — are left alone.
    const onBodyKeyDown = (event: KeyboardEvent) => {
      if (event.target !== document.body || event.defaultPrevented || !panel) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0];
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", onBodyKeyDown);

    return () => {
      document.removeEventListener("keydown", onBodyKeyDown);
      // A container around the card is no place to land: <body>, or the board
      // root, which a click on the card's body focuses (it is tabIndex=-1).
      // Look in the opener's own board first, so another board on the page
      // with the same ticket can't take the focus.
      const scope = opener?.isConnected ? (opener.closest(".aib-root") ?? document) : document;
      const handle = findHandle(scope, ticketId) ?? findHandle(document, ticketId);
      const container =
        opener === document.body || (handle !== null && opener !== handle && opener?.contains(handle) === true);
      const back = opener?.isConnected && !container ? opener : handle;
      back?.focus();
    };
    // Mount/unmount only: the panel's identity is the ticket it opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Escape and the Tab trap are handled ON the dialog, in the bubble phase,
   * and only for keys that reach it — a dialog stacked above this one (the
   * feedback widget's, say) keeps its own Tab and Escape. 0.8.x listened on
   * the whole document and stole both.
   */
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      // Handled here, so nothing around the board (a drawer, a host page's
      // own Escape handler) closes as well.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const panel = panelRef.current;
    if (event.key !== "Tab" || !panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel)) {
      event.preventDefault();
      first.focus();
    }
  };

  const run = async (action: TicketPanelAction, fn: () => void | Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      onError?.(error, action);
      return false;
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (await run("send", () => onSend(body))) {
        setDraft("");
        // Send disables itself once the draft is empty; keep focus in the
        // panel (on the box you'd type the next note in), not on <body>.
        composeRef.current?.focus();
      }
    } finally {
      setSending(false);
    }
  };

  const commitStatus = (next: string) => {
    setStatusDraft(null);
    if (next === ticket.status) return;
    setStatusSent(next);
    void run("move", () => onMove(next)).then((ok) => {
      if (!ok) setStatusSent(null);
    });
  };

  const commitAssignee = (raw: string) => {
    const next = raw.trim() || null;
    if (next === (ticket.assignee ?? null) || next === assigneeSent.current) return;
    assigneeSent.current = next;
    void run("assign", () => onAssign(next)).then((ok) => {
      if (!ok) assigneeSent.current = undefined;
    });
  };

  const knownStatus = statuses.some((status) => status.key === ticket.status);

  // An edit shows at once, and holds until the server's copy says the same.
  const shown = {
    title: pendingPatch.title ?? ticket.title,
    priority: pendingPatch.priority ?? ticket.priority,
    category: pendingPatch.category !== undefined ? pendingPatch.category : (ticket.category ?? null),
    assigneeId: pendingPatch.assigneeId !== undefined ? pendingPatch.assigneeId : (ticket.assigneeId ?? null),
  };
  const caughtUp =
    (pendingPatch.title === undefined || pendingPatch.title === ticket.title) &&
    (pendingPatch.priority === undefined || pendingPatch.priority === ticket.priority) &&
    (pendingPatch.category === undefined || pendingPatch.category === (ticket.category ?? null)) &&
    (pendingPatch.assigneeId === undefined || pendingPatch.assigneeId === (ticket.assigneeId ?? null));
  if (Object.keys(pendingPatch).length > 0 && caughtUp) setPendingPatch({});

  const applyPatch = (patch: TicketPatch) => {
    if (!onUpdate) return;
    setPendingPatch((current) => ({ ...current, ...patch }));
    void run("update", () => onUpdate(patch)).then((ok) => {
      if (!ok) {
        setPendingPatch((current) => {
          const next = { ...current };
          for (const key of Object.keys(patch) as Array<keyof TicketPatch>) delete next[key];
          return next;
        });
      }
    });
  };

  const saveTitle = () => {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (next && next !== ticket.title) applyPatch({ title: next });
  };

  const sourceLabel = ticket.source ? (SOURCE_LABELS[ticket.source as FilterSource] ?? null) : null;
  const audience = replyAudience(ticket, emailsReporters);
  const categoryKnown = shown.category === null || categories.some((category) => category.key === shown.category);
  const assigneeKnown = shown.assigneeId === null || (people ?? []).some((person) => person.id === shown.assigneeId);

  return (
    <div className="aib-panel-layer" data-aib-theme={theme}>
      <BoardStyles />
      <div className="aib-panel-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className="aib-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="aib-panel-head">
          <div>
            {titleDraft !== null ? (
              <div className="aib-title-edit">
                <h2 id={titleId} className="aib-sr">
                  {ticket.ticketNumber} — {shown.title}
                </h2>
                <input
                  className="aib-input"
                  aria-label="Title"
                  value={titleDraft}
                  maxLength={200}
                  autoFocus
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveTitle();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setTitleDraft(null);
                    }
                  }}
                />
                <button type="button" className="aib-tool-btn aib-tool-primary" onClick={saveTitle}>
                  Save
                </button>
                <button type="button" className="aib-tool-btn" onClick={() => setTitleDraft(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <h2 id={titleId} className="aib-panel-title">
                {ticket.ticketNumber} — {shown.title}
                {onUpdate ? (
                  <button type="button" className="aib-edit-btn" onClick={() => setTitleDraft(shown.title)}>
                    Edit<span className="aib-sr"> the title</span>
                  </button>
                ) : null}
              </h2>
            )}
            <div className="aib-panel-sub">
              <span>{ageOf(ticket.createdAt)}</span>
              {sourceLabel ? <span>{sourceLabel}</span> : null}
              {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
              {ticket.reporterName || ticket.reporterEmail ? (
                <span>from {ticket.reporterName ?? ticket.reporterEmail}</span>
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
            {/* Arrow keys (and type-ahead) on a CLOSED select change its value —
                and fire change — on every press in Chrome and Firefox on
                Windows; 0.8.0 sent a move per keystroke. Those steps only
                stage a draft, applied on Enter or when focus leaves; Escape
                reverts it. Everything else — a mouse pick, a pick from the
                open list (Space / Enter / Alt+↓), assistive tech — applies at
                once. */}
            <select
              key={ticket.id}
              className="aib-select"
              value={statusDraft ?? statusSent ?? ticket.status}
              onKeyDown={(event) => {
                if (event.key === "Enter" && statusDraft !== null) {
                  event.preventDefault();
                  commitStatus(statusDraft);
                  return;
                }
                if (event.key === "Escape" && statusDraft !== null) {
                  // First Escape reverts the draft; the next closes the panel.
                  event.preventDefault();
                  event.stopPropagation();
                  setStatusDraft(null);
                  return;
                }
                const step =
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  (STEP_KEYS.has(event.key) || (event.key.length === 1 && event.key !== " "));
                nextChangeIsStep.current = step;
              }}
              onPointerDown={() => {
                nextChangeIsStep.current = false;
              }}
              onChange={(event) => {
                const next = event.target.value;
                const step = nextChangeIsStep.current;
                nextChangeIsStep.current = false;
                if (step) setStatusDraft(next);
                else commitStatus(next);
              }}
              onBlur={() => {
                if (statusDraft !== null) commitStatus(statusDraft);
              }}
            >
              {/* A status no column knows still reads as itself (0.9.0) —
                  0.8.0's controlled select silently showed the first option. */}
              {knownStatus ? null : (
                <option value={ticket.status} disabled>
                  {ticket.status} (unrecognised)
                </option>
              )}
              {statuses.map((status) => (
                <option key={status.key} value={status.key}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          {onUpdate ? (
            <>
              <label>
                Priority
                <select
                  className="aib-select"
                  value={shown.priority}
                  onChange={(event) => applyPatch({ priority: event.target.value as TicketPatch["priority"] })}
                >
                  {(FILTER_PRIORITIES as readonly string[]).includes(shown.priority) ? null : (
                    <option value={shown.priority} disabled>
                      {shown.priority}
                    </option>
                  )}
                  {FILTER_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {PRIORITY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select
                  className="aib-select"
                  value={shown.category ?? ""}
                  onChange={(event) => applyPatch({ category: event.target.value || null })}
                >
                  <option value="">No category</option>
                  {categoryKnown ? null : (
                    <option value={shown.category ?? ""} disabled>
                      {shown.category} (not offered any more)
                    </option>
                  )}
                  {categories.map((category) => (
                    <option key={category.key} value={category.key}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {onUpdate && people && people.length > 0 ? (
            <label>
              Assigned to
              <select
                className="aib-select"
                // A name typed the 0.10 way is shown as itself (not "Nobody")
                // until someone picks a person from the list.
                value={shown.assigneeId ?? (pendingPatch.assigneeId === undefined && ticket.assignee ? TYPED_ASSIGNEE : "")}
                onChange={(event) => applyPatch({ assigneeId: event.target.value || null })}
              >
                <option value="">Nobody</option>
                {assigneeKnown ? null : (
                  <option value={shown.assigneeId ?? ""} disabled>
                    {ticket.assignee ?? "Someone not on the team"}
                  </option>
                )}
                {shown.assigneeId === null && ticket.assignee ? (
                  <option value={TYPED_ASSIGNEE} disabled>
                    {ticket.assignee}
                  </option>
                ) : null}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
          <label>
            Assignee
            <input
              // Keyed so a panel switched to another ticket (or refreshed with a
              // new assignee) shows that value, not the last one typed.
              key={`${ticket.id}:${ticket.assignee ?? ""}`}
              className="aib-input"
              defaultValue={ticket.assignee ?? ""}
              placeholder="unassigned"
              onBlur={(event) => commitAssignee(event.target.value)}
              onKeyDown={(event) => {
                // Apply in place — 0.9.0's first cut blurred here, which left
                // focus on <body> and the panel deaf to Escape and Tab.
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitAssignee((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          )}
          {onArchive ? (
            <button type="button" className="aib-archive-btn" onClick={() => void run("archive", onArchive)}>
              {ticket.archivedAt != null ? "Unarchive" : "Archive"}
            </button>
          ) : null}
        </div>

        <div className="aib-thread">
          <TicketReport ticket={ticket} detail={detail} />
          {events && events.length > 0 ? (
            <details className="aib-activity">
              <summary>Activity ({events.length})</summary>
              <ol>
                {events.map((event) => (
                  <li key={event.id}>
                    {eventWords(event)}
                    <time>{timeOf(event.createdAt, formatTime)}</time>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {messages.length === 0 ? (
            <div className="aib-thread-empty">
              {detail?.description ? "No notes yet — the report above is the whole story so far." : "No notes yet."}
            </div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`aib-msg aib-msg-${message.senderType}`}>
              {message.senderType === "system" ? (
                <span>
                  {message.body} — {message.senderName}, {timeOf(message.createdAt, formatTime)}
                </span>
              ) : (
                <>
                  <div className="aib-msg-meta">
                    <b>{message.senderName}</b>
                    <span>{timeOf(message.createdAt, formatTime)}</span>
                  </div>
                  <div className="aib-msg-body">{message.body}</div>
                </>
              )}
            </div>
          ))}
        </div>

        <p className="aib-compose-note" id={`${titleId}-audience`}>
          {audience.note}
        </p>
        <div className="aib-compose">
          <textarea
            ref={composeRef}
            value={draft}
            aria-label={audience.label}
            aria-describedby={`${titleId}-audience`}
            placeholder={`${audience.label}…`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
            }}
          />
          <button
            type="button"
            className="aib-send"
            aria-busy={sending || undefined}
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything the report itself carries, rendered inline at the top of the
 * panel: the body, the annotated screenshot as an image (annotated preferred,
 * click to enlarge — the original is never shown, only the marked-up one),
 * and the captured context as readable rows rather than a JSON dump. The
 * screenshot comes off the ticket (always present); the rest fills in from
 * `detail` when the consumer's fetch resolves.
 */
function TicketReport({
  ticket,
  detail,
}: {
  ticket: BoardTicketView;
  detail?: TicketDetailView | null;
}): ReactElement | null {
  const shot = ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl ?? null;
  const annotated = ticket.annotatedScreenshotUrl != null;
  const context = detail?.context ?? null;
  const errors = detail?.errors ?? [];
  const trail = Array.isArray(context?.clickTrail) ? context!.clickTrail! : [];
  const viewport = context?.viewport;

  if (!detail?.description && !shot && !context && errors.length === 0) return null;

  return (
    <div className="aib-detail">
      {detail?.description ? <div className="aib-report">{detail.description}</div> : null}

      {shot ? (
        <a className="aib-shot-wrap" href={shot} target="_blank" rel="noreferrer">
          <img
            className="aib-shot"
            src={shot}
            alt={`Screenshot for ${ticket.ticketNumber}`}
            loading="lazy"
          />
          <span className="aib-shot-label">
            {annotated ? "Annotated screenshot · click to enlarge" : "Screenshot · click to enlarge"}
          </span>
        </a>
      ) : null}

      {context ? (
        <div>
          <h3 className="aib-detail-h">Context</h3>
          <div className="aib-kv">
            {context.browser ? (
              <div>
                <b>
                  Browser
                  <span className="aib-sr">:</span>
                </b>
                {context.browser}
              </div>
            ) : null}
            {context.os ? (
              <div>
                <b>
                  OS
                  <span className="aib-sr">:</span>
                </b>
                {context.os}
              </div>
            ) : null}
            {viewport && (viewport.width || viewport.height) ? (
              <div>
                <b>
                  Viewport
                  <span className="aib-sr">:</span>
                </b>
                {viewport.width ?? "?"}×{viewport.height ?? "?"}
              </div>
            ) : null}
            {context.pathname || context.url ? (
              <div>
                <b>
                  Page
                  <span className="aib-sr">:</span>
                </b>
                {context.pathname ?? context.url}
              </div>
            ) : null}
          </div>

          {trail.length > 0 ? (
            <>
              <h3 className="aib-detail-h">Click trail</h3>
              <ul className="aib-trail">
                {trail.slice(-12).map((step, index) => (
                  <li key={index}>
                    [{step.type ?? "?"}] {step.target ?? ""}
                    {step.value ? ` "${step.value}"` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div>
          <h3 className="aib-detail-h">Browser errors</h3>
          <ul className="aib-errs">
            {errors.map((error, index) => (
              <li key={index} className="aib-err">
                <b>{error.type ?? "Error"}</b> {error.message ?? ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ageOf(createdAt: Date | string): string {
  const then = toDate(createdAt);
  if (!then) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

/** Hours a card has sat in its current column. Aging falls back to createdAt. */
function hoursInColumn(ticket: BoardTicketView): number {
  const then = toDate(ticket.statusChangedAt ?? ticket.createdAt);
  return then ? (Date.now() - then.getTime()) / 3_600_000 : 0;
}

/** "5 hours" under a day, "1 day", "6 days" — for the screen-reader text. */
function timeInColumnWords(ticket: BoardTicketView): string {
  const hours = Math.floor(hoursInColumn(ticket));
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function agingClass(ticket: BoardTicketView, status: BoardStatusView): string | null {
  const warn = status.agingWarnHours ?? null;
  const stale = status.agingStaleHours ?? null;
  if (warn === null && stale === null) return null;
  const hours = hoursInColumn(ticket);
  if (stale !== null && hours >= stale) return "aib-age-stale";
  if (warn !== null && hours >= warn) return "aib-age-warn";
  return null;
}

/**
 * An optimistic move: where the card was sent (`to`) and the server status it
 * was sent FROM (`base`). It shows only while the server still says `base` (or
 * an intermediate stop, `via`) — the moment the `tickets` prop says anything
 * else (the move landed, or someone else moved it), the server wins and the
 * entry is dropped. 0.8.0 kept
 * a bare status per card forever, so a card the board had touched ignored
 * every later change to the prop until the board remounted.
 */
interface PendingMove {
  to: string;
  base: string;
  /**
   * Earlier destinations of a card moved again before the server caught up
   * (0.9.0): while the server says `base` OR one of these, the latest move is
   * still on its way and the card keeps showing `to`.
   */
  via: string[];
  /** Which move this is — survives a rebase, so a rollback only ever undoes its own move. */
  seq: number;
}

/**
 * Should the card still show `move.to`? Not once the server says `to` (it
 * landed — the prop now agrees), nor once it says anything outside the
 * move's path (someone else moved it: the server wins).
 */
function stillPending(move: PendingMove | undefined, serverStatus: string | undefined): move is PendingMove {
  return (
    move !== undefined &&
    serverStatus !== undefined &&
    serverStatus !== move.to &&
    (serverStatus === move.base || move.via.includes(serverStatus))
  );
}

/** The server has reached an intermediate stop: start the path from there. */
function rebase(move: PendingMove, serverStatus: string): PendingMove {
  const at = move.via.indexOf(serverStatus);
  return at === -1 ? move : { ...move, base: serverStatus, via: move.via.slice(at + 1) };
}

let moveSeq = 0;

/** The trailing column for cards whose status no column has (0.9.0). */
const ORPHAN_KEY = "\u0000aib-orphan";

export function FeedbackBoard({
  statuses,
  tickets,
  onMove,
  onOpen,
  ticketHref,
  onMoveMany,
  onMoveError,
  onCreateInColumn,
  theme = "auto",
}: FeedbackBoardProps): ReactElement {
  useBoardStyles();
  const boardId = useId();
  const hintId = `${boardId}-move-hint`;

  const [pending, setPending] = useState<Record<string, PendingMove>>({});
  const [seenTickets, setSeenTickets] = useState(tickets);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [bulkTarget, setBulkTarget] = useState("");
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The latest server data, for work that finishes after an await.
  const ticketsRef = useRef(tickets);
  useEffect(() => {
    ticketsRef.current = tickets;
  }, [tickets]);

  // A live region only speaks when its text CHANGES; alternate an invisible
  // suffix so the same message twice ("2 tickets moved to Done.") is heard twice.
  const announce = useCallback((text: string) => setAnnouncement((prev) => ({ text, n: prev.n + 1 })), []);

  // New server data: drop every optimistic move the server has moved past,
  // and every ticked card that is no longer on the board. Done during render
  // ("storing information from previous renders"), so it is idempotent.
  if (seenTickets !== tickets) {
    setSeenTickets(tickets);
    const server = new Map(tickets.map((ticket) => [ticket.id, ticket.status]));
    let changed = false;
    const next: Record<string, PendingMove> = {};
    for (const [id, move] of Object.entries(pending)) {
      const status = server.get(id);
      if (!stillPending(move, status)) {
        changed = true;
        continue;
      }
      const moved = rebase(move, status!);
      if (moved !== move) changed = true;
      next[id] = moved;
    }
    if (changed) setPending(next);
    if ([...selected].some((id) => !server.has(id))) {
      setSelected(new Set([...selected].filter((id) => server.has(id))));
    }
  }

  const statusOf = useCallback(
    (ticket: BoardTicketView) => {
      const move = pending[ticket.id];
      return stillPending(move, ticket.status) ? move.to : ticket.status;
    },
    [pending],
  );

  const ordered = [...statuses].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  /**
   * Move a set of tickets optimistically. One code path for a single drag, a
   * drag that carries the selection, the bulk bar and the keyboard — the
   * rollback story must not differ between them. Resolves with the ids that
   * actually moved.
   */
  const moveSet = useCallback(
    async (ids: readonly string[], statusKey: string): Promise<string[]> => {
      const moving = ids.filter((id) => {
        const ticket = tickets.find((t) => t.id === id);
        return ticket !== undefined && !busy.has(id) && statusOf(ticket) !== statusKey;
      });
      if (moving.length === 0) return [];

      // A card moved again before the server caught up chains onto its
      // pending move instead of replacing it, so the earlier move's refresh
      // can't snap it back a column.
      const created = new Map<string, PendingMove>();
      const before = new Map<string, PendingMove | undefined>();
      for (const id of moving) {
        const server = tickets.find((t) => t.id === id)!.status;
        const prev = pending[id];
        before.set(id, prev);
        const seq = ++moveSeq;
        created.set(
          id,
          stillPending(prev, server)
            ? { to: statusKey, base: prev.base, via: [...prev.via, prev.to].filter((stop) => stop !== statusKey), seq }
            : { to: statusKey, base: server, via: [], seq },
        );
      }
      setPending((prev) => ({ ...prev, ...Object.fromEntries(created) }));
      setBusy((prev) => new Set([...prev, ...moving]));
      const label = statuses.find((status) => status.key === statusKey)?.label ?? statusKey;
      const numberOf = (id: string) => tickets.find((t) => t.id === id)?.ticketNumber ?? id;

      const rollBack = (failedIds: readonly string[]) => {
        // The rollback remounts a card's title in its old column; if that
        // title has focus (a keyboard move), keep it there, not on <body>.
        const active = document.activeElement;
        const focused = active instanceof HTMLElement ? active.dataset.aibOpen : undefined;
        if (focused !== undefined && failedIds.includes(focused)) setFocusId(focused);
        // Back to what the board showed before THIS move — never write a
        // status in, or the card would ignore the next refresh.
        setPending((prev) => {
          const next = { ...prev };
          for (const id of failedIds) {
            if (next[id]?.seq !== created.get(id)?.seq) continue;
            // Put back what showed before THIS move — unless the server has
            // since moved past it, in which case the server's word stands.
            const restore = before.get(id);
            const server = ticketsRef.current.find((t) => t.id === id)?.status;
            if (restore && stillPending(restore, server)) next[id] = rebase(restore, server!);
            else delete next[id];
          }
          return next;
        });
      };

      let failed: string[] = [];
      try {
        if (moving.length === 1) {
          await onMove(moving[0]!, statusKey);
        } else {
          // >1 ids only happens with onMoveMany: the selection UI does not
          // render without it.
          const result = await onMoveMany!(moving, statusKey);
          if (result && Array.isArray(result.failed)) {
            failed = result.failed.filter((id) => moving.includes(id));
          }
        }
      } catch (error) {
        rollBack(moving);
        announce(
          moving.length === 1
            ? `${numberOf(moving[0]!)} could not be moved.`
            : `${moving.length} tickets could not be moved.`,
        );
        onMoveError?.(error, [...moving], statusKey);
        return [];
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          for (const id of moving) next.delete(id);
          return next;
        });
      }

      const landed = moving.filter((id) => !failed.includes(id));
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of landed) next.delete(id);
        return next.size === prev.size ? prev : next;
      });
      if (failed.length > 0) {
        rollBack(failed);
        announce(
          landed.length === 0
            ? failed.length === 1
              ? `${numberOf(failed[0]!)} could not be moved.`
              : `${failed.length} tickets could not be moved.`
            : `${landed.length} moved to ${label}; ${failed.length === 1 ? numberOf(failed[0]!) : `${failed.length} tickets`} could not be moved.`,
        );
        onMoveError?.(
          new Error(`${failed.length} of ${moving.length} tickets could not be moved`),
          failed,
          statusKey,
        );
      } else {
        announce(
          landed.length === 1 ? `${numberOf(landed[0]!)} moved to ${label}.` : `${landed.length} tickets moved to ${label}.`,
        );
      }
      return landed;
    },
    [tickets, busy, pending, statusOf, onMove, onMoveMany, onMoveError, statuses, announce],
  );

  const handleDrop = useCallback(
    async (statusKey: string) => {
      setOverColumn(null);
      const ticketId = draggingId;
      setDraggingId(null);
      if (!ticketId) return;
      // Dragging a selected card carries the whole selection; dragging an
      // unselected one moves just it, leaving the selection alone.
      const ids = onMoveMany && selected.has(ticketId) ? [...selected] : [ticketId];
      await moveSet(ids, statusKey);
    },
    [draggingId, selected, onMoveMany, moveSet],
  );

  const barHasFocus = () => barRef.current?.contains(document.activeElement) ?? false;

  const applyBulk = useCallback(async () => {
    if (!bulkTarget || selected.size === 0) return;
    const hadFocus = barHasFocus();
    setApplying(true);
    try {
      const before = selected.size;
      const landed = await moveSet([...selected], bulkTarget);
      setBulkTarget("");
      // The bar unmounts when the selection empties; don't let focus fall to
      // <body> with it — go to the first moved card (or the board). If some
      // cards are still ticked the bar stays, and so does focus (on its select).
      if (hadFocus) {
        if (landed.length < before) barRef.current?.querySelector<HTMLElement>(".aib-select")?.focus();
        else if (landed[0]) setFocusId(landed[0]);
        else rootRef.current?.focus();
      }
    } finally {
      setApplying(false);
    }
  }, [bulkTarget, selected, moveSet]);

  const clearSelection = () => {
    const hadFocus = barHasFocus();
    const first = [...selected][0];
    setSelected(new Set());
    // Cleared cards don't move: land on the first of them, or the board.
    if (hadFocus) {
      if (first && findHandle(rootRef.current, first)) setFocusId(first);
      else rootRef.current?.focus();
    }
  };

  const toggleTicket = useCallback((ticketId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }, []);

  /** Alt+← / Alt+→ on a card's title moves it one column — the keyboard's drag. */
  const onCardKeyDown = (event: ReactKeyboardEvent, ticket: BoardTicketView) => {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    // Consumed even with no column that way: unhandled, Alt+← / Alt+→ is the
    // browser's Back / Forward on Windows and Linux, and one press past the
    // first column would navigate away from the board.
    event.preventDefault();
    if (busy.has(ticket.id)) {
      announce(`${ticket.ticketNumber} is still moving.`);
      return;
    }
    const at = ordered.findIndex((status) => status.key === statusOf(ticket));
    const target = ordered[at + (event.key === "ArrowRight" ? 1 : -1)];
    if (at === -1 || !target) {
      announce(
        at === -1
          ? `${ticket.ticketNumber}'s status has no column. Drag it to one, or open it and set its status.`
          : "No column that way.",
      );
      return;
    }
    setFocusId(ticket.id);
    void moveSet([ticket.id], target.key);
  };

  // The moved card re-renders in another column, which drops focus; put it
  // back on the card's title so a keyboard user can keep moving it.
  useEffect(() => {
    if (!focusId) return;
    const handle = findHandle(rootRef.current, focusId) ?? rootRef.current;
    if (handle && document.activeElement !== handle) handle.focus();
    setFocusId(null);
  }, [focusId, pending]);

  const openFromTitle = (event: ReactMouseEvent, ticket: BoardTicketView) => {
    event.stopPropagation();
    // A link with a modifier (new tab, new window) is the browser's job.
    if (ticketHref && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    if (onOpen) {
      event.preventDefault();
      onOpen(ticket);
    }
  };

  const keys = new Set(ordered.map((status) => status.key));
  const orphans = tickets.filter((ticket) => !keys.has(statusOf(ticket)));
  const columns: BoardStatusView[] =
    orphans.length > 0
      ? [...ordered, { key: ORPHAN_KEY, label: "Unrecognised status", color: null }]
      : ordered;

  return (
    <div
      ref={rootRef}
      className={`aib-root${onMoveMany && selected.size > 0 ? " aib-selecting" : ""}`}
      data-aib-theme={theme}
      tabIndex={-1}
      role="region"
      aria-label="Ticket board"
    >
      <BoardStyles />
      {/* `hidden`: read only as each title's description, never as stray text. */}
      <span id={hintId} hidden>
        Alt plus left or right arrow moves this ticket one column left or right.
      </span>
      <div className="aib-board">
        {columns.map((status, index) => {
          const isOrphan = status.key === ORPHAN_KEY;
          const cards = isOrphan ? orphans : tickets.filter((ticket) => statusOf(ticket) === status.key);
          const limit = status.wipLimit ?? null;
          const wipState =
            limit === null ? null : cards.length > limit ? "over" : cards.length === limit ? "full" : null;
          const selectedHere = cards.filter((card) => selected.has(card.id)).length;
          // By position, not key: a status key may contain spaces or collide.
          const titleId = `${boardId}-col-${index}`;
          const countWords =
            `${cards.length} ${cards.length === 1 ? "ticket" : "tickets"}` +
            (limit === null
              ? ""
              : `, limit ${limit}${wipState === "over" ? ", over the limit" : wipState === "full" ? ", at the limit" : ""}`);
          return (
            <div
              key={status.key}
              role="group"
              aria-labelledby={titleId}
              className={`aib-col${overColumn === status.key ? " aib-over" : ""}${isOrphan ? " aib-col-orphan" : ""}`}
              onDragOver={(event) => {
                // An unknown status is somewhere to drag FROM, never to.
                if (isOrphan) return;
                event.preventDefault();
                setOverColumn(status.key);
              }}
              onDragLeave={() => setOverColumn((current) => (current === status.key ? null : current))}
              onDrop={(event) => {
                if (isOrphan) return;
                event.preventDefault();
                void handleDrop(status.key);
              }}
            >
              <div className={`aib-col-head${wipState ? ` aib-wip-${wipState}` : ""}`}>
                {onMoveMany && cards.length > 0 ? (
                  <input
                    type="checkbox"
                    className="aib-check aib-col-check"
                    aria-label={`Select all in ${status.label}`}
                    checked={selectedHere > 0 && selectedHere === cards.length}
                    ref={(el) => {
                      // The tri-state: some-but-not-all renders as indeterminate,
                      // which only exists as a DOM property.
                      if (el) el.indeterminate = selectedHere > 0 && selectedHere < cards.length;
                    }}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        const all = selectedHere === cards.length;
                        for (const card of cards) {
                          if (all) next.delete(card.id);
                          else next.add(card.id);
                        }
                        return next;
                      })
                    }
                  />
                ) : null}
                <span
                  className="aib-col-dot"
                  aria-hidden="true"
                  style={{ background: status.color ?? "var(--aib-line-strong)" }}
                />
                <span id={titleId} className="aib-col-title">
                  {status.label}
                </span>
                <span
                  className={`aib-col-count${wipState ? ` aib-wip-${wipState}` : ""}`}
                  title={
                    wipState === "over"
                      ? "Over the WIP limit"
                      : wipState === "full"
                        ? "At the WIP limit"
                        : undefined
                  }
                >
                  <span aria-hidden="true">{limit === null ? cards.length : `${cards.length}/${limit}`}</span>
                  <span className="aib-sr">{countWords}</span>
                </span>
                {onCreateInColumn && !isOrphan ? (
                  <button
                    type="button"
                    className="aib-col-add"
                    aria-label={`New ticket in ${status.label}`}
                    title={`New ticket in ${status.label}`}
                    onClick={() => onCreateInColumn(status.key)}
                  >
                    +
                  </button>
                ) : null}
              </div>
              <div className="aib-col-body">
                {cards.length === 0 ? (
                  <div className="aib-empty">No tickets</div>
                ) : (
                  // role="list": Safari drops the list role from a list-style:none <ul>.
                  <ul role="list" className="aib-col-list">
                    {cards.map((ticket) => {
                      const age = isOrphan ? null : agingClass(ticket, status);
                      const archived = ticket.archivedAt != null;
                      const isBusy = busy.has(ticket.id);
                      const href = ticketHref?.(ticket);
                      const shot = ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl;
                      const days = Math.floor(hoursInColumn(ticket) / 24);
                      return (
                        <li
                          key={ticket.id}
                          className={`aib-card${draggingId === ticket.id ? " aib-dragging" : ""}${isBusy ? " aib-busy" : ""}${archived ? " aib-archived" : ""}`}
                          aria-busy={isBusy || undefined}
                          draggable={!isBusy}
                          onDragStart={(event) => {
                            // Firefox needs data on the transfer to start a drag;
                            // it is also what lands if the card is dropped outside.
                            event.dataTransfer.setData("text/plain", ticket.ticketNumber);
                            event.dataTransfer.effectAllowed = "move";
                            setDraggingId(ticket.id);
                          }}
                          onDragEnd={() => setDraggingId(null)}
                          onClick={onOpen ? () => onOpen(ticket) : undefined}
                          style={onOpen ? { cursor: "pointer" } : undefined}
                        >
                          <div className={`aib-card-top${onMoveMany ? " aib-has-check" : ""}`}>
                            {onMoveMany ? (
                              <input
                                type="checkbox"
                                className="aib-check"
                                aria-label={`Select ${ticket.ticketNumber}`}
                                checked={selected.has(ticket.id)}
                                onChange={() => toggleTicket(ticket.id)}
                                onClick={(event) => event.stopPropagation()}
                              />
                            ) : null}
                            {/* The mark ages with time-in-column against this
                                column's own thresholds — a Done column with no
                                thresholds never nags about finished work. */}
                            {age ? (
                              <>
                                <span className={`aib-age ${age}`} aria-hidden="true" title={`${days}d in this column`} />
                                <span className="aib-sr">
                                  {`${age === "aib-age-stale" ? "Stale" : "Aging"}: ${timeInColumnWords(ticket)} in this column.`}
                                </span>
                              </>
                            ) : null}
                            <span className="aib-num">{ticket.ticketNumber}</span>
                            {archived ? <span className="aib-archived-chip">archived</span> : null}
                            {/* The reporter answered and nobody has opened the ticket
                                since. THE signal triage scans for — opening the panel
                                clears it via the consumer's markRead call. */}
                            {ticket.hasUnreadReporterReply ? <span className="aib-unread">reply</span> : null}
                            <span className={`aib-chip aib-chip-${ticket.priority}`}>{ticket.priority}</span>
                          </div>
                          <div className="aib-card-title">
                            {href ? (
                              <a
                                className="aib-card-open"
                                href={href}
                                data-aib-open={ticket.id}
                                draggable={false}
                                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                                aria-describedby={isOrphan ? undefined : hintId}
                                onClick={(event) => openFromTitle(event, ticket)}
                                onKeyDown={(event) => onCardKeyDown(event, ticket)}
                              >
                                {ticket.title}
                              </a>
                            ) : onOpen ? (
                              <button
                                type="button"
                                className="aib-card-open"
                                data-aib-open={ticket.id}
                                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                                aria-describedby={isOrphan ? undefined : hintId}
                                onClick={(event) => openFromTitle(event, ticket)}
                                onKeyDown={(event) => onCardKeyDown(event, ticket)}
                              >
                                {ticket.title}
                              </button>
                            ) : (
                              ticket.title
                            )}
                          </div>
                          <div className="aib-card-meta">
                            <span>{ageOf(ticket.createdAt)}</span>
                            {isOrphan ? <span>status “{ticket.status}”</span> : null}
                            {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
                            {ticket.assignee ? <span className="aib-assignee">{ticket.assignee}</span> : null}
                            {ticket.reporterName || ticket.reporterEmail ? (
                              <span>{ticket.reporterName ?? ticket.reporterEmail}</span>
                            ) : null}
                            {shot ? (
                              <a
                                href={shot}
                                target="_blank"
                                rel="noreferrer"
                                draggable={false}
                                aria-label={`Screenshot for ${ticket.ticketNumber} (opens in a new tab)`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                screenshot ↗
                              </a>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="aib-sr" role="status">
        {announcement.text ? <span key={announcement.n}>{announcement.text}</span> : null}
      </div>

      {onMoveMany && selected.size > 0 ? (
        <div ref={barRef} className="aib-bulkbar" role="group" aria-label="Bulk actions">
          <span className="aib-bulkbar-count">{selected.size} selected</span>
          <select
            className="aib-select"
            aria-label="Move selection to"
            value={bulkTarget}
            onChange={(event) => setBulkTarget(event.target.value)}
          >
            <option value="">Move to…</option>
            {ordered.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="aib-bulk-apply"
            aria-busy={applying || undefined}
            disabled={!bulkTarget || applying}
            onClick={() => void applyBulk()}
          >
            {applying ? "Moving…" : "Apply"}
          </button>
          <button type="button" className="aib-bulk-clear" onClick={clearSelection}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The connected workspace (0.10.0) — the board, its toolbar and the ticket
// panel, talking to the staff routes through a base URL.
// ---------------------------------------------------------------------------

export interface FeedbackWorkspaceProps {
  /**
   * Where the staff routes are mounted: `/api/app/${company.id}/feedback` for
   * a company's board, `/api/admin/feedback` for the platform's own. The same
   * component serves both; only this differs.
   */
  baseUrl: string;
  /** Shown as the sender on messages this viewer writes, until the server's copy arrives. */
  currentUser?: string;
  /**
   * Offer the controls that change tickets (moving, replying, assigning,
   * archiving, New ticket, editing). Only what is OFFERED: the server refuses
   * them anyway to someone without the permission. Default true.
   */
  canManage?: boolean;
  /** A link to the board's settings (columns, categories, website keys), shown in the toolbar. */
  settingsHref?: string | null;
  /** A ticket to open on arrival — an alert's link (`?ticket=…`). */
  initialTicketId?: string | null;
  /** Told when the open ticket changes (null: closed), so a page can keep it in its address. */
  onOpenTicket?: (ticketId: string | null) => void;
  /**
   * Where the filters are kept (0.11.0): the page's own query string by
   * default (`?status=open&assignee=__me`, so a link shares the view and
   * Back undoes a filter), or your own adapter, or `false` for memory only.
   */
  filterUrl?: BoardFilterUrl | false;
  /**
   * The name filters are remembered under in this browser, so the board
   * opens the way it was left (a link with filters always wins). Default: one
   * per `baseUrl`. `false` remembers nothing.
   */
  rememberFiltersAs?: string | false;
  /** Does this board email the reporter on a reply (see TicketPanel)? Default true. */
  emailsReporters?: boolean;
  /** See `BoardTheme`. Default `auto`. */
  theme?: BoardTheme;
  /** A client to use instead of one over `baseUrl` (tests). */
  client?: FeedbackAdminClient;
}

const READ_ONLY_MESSAGE = "You can look at the board, but changing tickets needs permission to answer feedback.";

function messageOf(error: unknown): string {
  if (error instanceof FeedbackAdminError) return error.message;
  return "Something went wrong. Please try again.";
}

/** The panel's detail, from the ticket route's answer. */
function detailOf(ticket: FeedbackTicketDetailWire | null): TicketDetailView | null {
  if (!ticket) return null;
  return {
    description: ticket.description,
    context: (ticket.context as TicketContextView | null) ?? null,
    errors: (ticket.errors as TicketErrorView[]) ?? [],
  };
}

/**
 * A company's whole feedback board, connected: the toolbar (search, filters,
 * quick filters, New ticket), the columns and tickets (filtered on the
 * server), moving cards one at a time or as a selection, a "+" per column,
 * and the ticket panel — the report, the conversation, replies, the editor
 * (title, priority, category, assignee picked from the company's people) and
 * the activity trail. Every change goes through the staff routes at
 * `baseUrl`, then a fresh read, because the server's copy is the board.
 *
 *   <FeedbackWorkspace baseUrl={`/api/app/${company.id}/feedback`} canManage={can.includes("feedback.manage")} />
 *
 * Not included (next): epics; per-person saved views; custom fields.
 */
export function FeedbackWorkspace({
  baseUrl,
  currentUser = "You",
  canManage = true,
  settingsHref = null,
  initialTicketId = null,
  onOpenTicket,
  filterUrl,
  rememberFiltersAs,
  emailsReporters = true,
  theme = "auto",
  client: given,
}: FeedbackWorkspaceProps): ReactElement {
  useBoardStyles();
  const client = useMemo(() => given ?? new FeedbackAdminClient(baseUrl), [given, baseUrl]);
  const { filters, setFilters, isReady } = useBoardFilters({
    url: filterUrl === undefined ? windowFilterUrl : filterUrl,
    persistKey: rememberFiltersAs === undefined ? `aib-board:${baseUrl}` : rememberFiltersAs,
  });

  const [board, setBoard] = useState<FeedbackBoardWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackTicketDetailWire | null>(null);
  const [messages, setMessages] = useState<FeedbackMessageWire[]>([]);
  const [events, setEvents] = useState<FeedbackEventWire[]>([]);
  const [categories, setCategories] = useState<FeedbackCategoryWire[]>([]);
  const [people, setPeople] = useState<FeedbackPersonWire[]>([]);
  const [me, setMe] = useState<string | null>(null);
  /** The New ticket dialog: closed (null), or open on a column ("" = the default one). */
  const [creating, setCreating] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const refresh = useCallback(async (): Promise<FeedbackBoardWire | null> => {
    const seq = ++loadSeq.current;
    try {
      const next = await client.board({ filters: filtersForRequest(filtersRef.current) });
      if (seq !== loadSeq.current) return null;
      setBoard(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (seq !== loadSeq.current) return null;
      setLoadError(messageOf(error));
      return null;
    }
  }, [client]);

  // Not before remembered filters are back: no flash of the whole board first.
  useEffect(() => {
    if (isReady) void refresh();
  }, [isReady, filters, refresh]);

  // What the filters and the editor choose from: the categories and the
  // company's people. Either failing leaves the board working without it.
  useEffect(() => {
    void client.categories().then(setCategories, () => undefined);
    if (typeof client.people === "function") {
      void client.people().then(
        (answer) => {
          setPeople(answer.people);
          setMe(answer.me);
        },
        () => undefined,
      );
    }
  }, [client]);

  // Coming back to the tab is when someone expects new feedback to be there.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const loadTicket = useCallback(
    async (ticketId: string) => {
      try {
        const [ticket, thread, trail] = await Promise.all([
          client.ticket(ticketId),
          client.messages(ticketId),
          client.events(ticketId).catch(() => [] as FeedbackEventWire[]),
        ]);
        setDetail(ticket);
        setMessages(thread);
        setEvents(trail);
      } catch (error) {
        setNotice(messageOf(error));
        setOpenId(null);
      }
    },
    [client],
  );

  const reloadTrail = useCallback(
    async (ticketId: string) => {
      const [ticket, trail] = await Promise.all([client.ticket(ticketId), client.events(ticketId).catch(() => null)]);
      setDetail(ticket);
      if (trail) setEvents(trail);
    },
    [client],
  );

  const open = useCallback(
    (ticketId: string | null) => {
      setOpenId(ticketId);
      onOpenTicket?.(ticketId);
      setDetail(null);
      setMessages([]);
      setEvents([]);
      if (ticketId === null) return;
      void loadTicket(ticketId);
      // Opening the panel IS reading it: the card's reply mark clears the way
      // an inbox does — by looking, not by a chore.
      void client
        .markRead(ticketId)
        .then(() => refresh())
        .catch(() => undefined);
    },
    [client, loadTicket, onOpenTicket, refresh],
  );

  // The ticket an alert's link names, once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialTicketId) return;
    opened.current = true;
    open(initialTicketId);
  }, [initialTicketId, open]);

  const refuseReadOnly = (): never => {
    throw new FeedbackAdminError(READ_ONLY_MESSAGE, 403, "forbidden");
  };

  const handleMove = async (ticketId: string, statusKey: string) => {
    if (!canManage) refuseReadOnly();
    await client.move(ticketId, statusKey);
    await refresh();
    if (ticketId === openId) void reloadTrail(ticketId).catch(() => undefined);
  };

  const statuses: BoardStatusView[] = board?.statuses ?? [];
  const tickets: BoardTicketView[] = board?.tickets ?? [];
  const openCard: BoardTicketView | null =
    tickets.find((ticket) => ticket.id === openId) ?? (detail && detail.id === openId ? detail : null);
  const archivable = board?.archivableCount ?? 0;
  const fields = boardFilterFields({ statuses, categories, people, me, facets: board?.facets ?? null });
  const quick = boardQuickFilters({ me: people.length > 0 ? me : null, facets: board?.facets ?? null });
  const narrowed = !isUnfiltered(filters);

  return (
    <>
      <BoardToolbar
        filters={filters}
        onChange={setFilters}
        fields={fields}
        quickFilters={quick}
        theme={theme}
        totalCount={board?.totalCount ?? null}
        matchCount={board?.matchCount ?? null}
        shownCount={board ? board.tickets.length : null}
        truncated={board?.truncated ?? false}
        onCreate={canManage && board ? () => setCreating("") : null}
        actions={
          <>
            {canManage && archivable > 0 ? (
              <button
                type="button"
                className="aib-tool-btn"
                disabled={sweeping}
                onClick={() => {
                  setSweeping(true);
                  void client
                    .archiveDone()
                    .then(() => refresh())
                    .catch((error: unknown) => setNotice(messageOf(error)))
                    .finally(() => setSweeping(false));
                }}
              >
                {sweeping ? "Archiving…" : `Archive finished (${archivable})`}
              </button>
            ) : null}
            {settingsHref ? (
              <a className="aib-tool-btn" href={settingsHref}>
                Columns, categories and website keys
              </a>
            ) : null}
          </>
        }
      />
      <div className="aib-toolbar" data-aib-theme={theme === "auto" ? undefined : theme}>
        {notice ? (
          <div className="aib-notice" role="status">
            <span>{notice}</span>
            <button type="button" className="aib-tool-btn" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        ) : null}
        {loadError ? (
          <div className="aib-notice" role="alert">
            <span>The board didn&rsquo;t load: {loadError}</span>
            <button type="button" className="aib-tool-btn" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : null}
        {board === null && !loadError ? <p className="aib-toolbar-note">Loading the board…</p> : null}
        {board !== null && board.tickets.length === 0 ? (
          <p className="aib-toolbar-note">
            {narrowed
              ? "Nothing matches these filters. Remove one, or clear them all."
              : filters.archived
                ? "Nothing here yet, archived or not."
                : "No feedback yet. It appears here as soon as someone sends some."}
          </p>
        ) : null}
      </div>

      {board !== null ? (
        <FeedbackBoard
          statuses={statuses}
          tickets={tickets}
          theme={theme}
          onMove={handleMove}
          onOpen={(ticket) => open(ticket.id)}
          {...(canManage
            ? {
                onMoveMany: async (ticketIds: string[], statusKey: string) => {
                  const result = await client.moveMany(ticketIds, statusKey);
                  await refresh();
                  return result.failed.length > 0 ? { failed: result.failed } : undefined;
                },
                onCreateInColumn: (statusKey: string) => setCreating(statusKey),
              }
            : {})}
          onMoveError={(error) => setNotice(messageOf(error))}
        />
      ) : null}

      {creating !== null && board !== null ? (
        <NewTicketDialog
          statuses={statuses}
          categories={categories}
          people={people}
          defaultStatus={creating || null}
          theme={theme}
          onClose={() => setCreating(null)}
          onCreate={async (input) => {
            if (!canManage) refuseReadOnly();
            const created = await client.createTicket(input);
            const next = await refresh();
            // Made, but the filters may leave it off the board: say so (0.11.0 review).
            return { ...created, hidden: next !== null && !next.tickets.some((ticket) => ticket.id === created.id) };
          }}
          onClearFilters={() => setFilters(EMPTY_FILTERS)}
          onOpenTicket={(ticketId) => {
            setCreating(null);
            open(ticketId);
          }}
        />
      ) : null}

      {openId && openCard ? (
        <TicketPanel
          ticket={openCard}
          messages={messages}
          statuses={statuses}
          detail={detailOf(detail)}
          currentUser={currentUser}
          theme={theme}
          categories={categories}
          people={people.length > 0 ? people : null}
          events={events}
          emailsReporters={emailsReporters}
          onClose={() => open(null)}
          onSend={async (body) => {
            if (!canManage) refuseReadOnly();
            await client.reply(openId, body);
            setMessages(await client.messages(openId));
          }}
          onAssign={async (assignee) => {
            if (!canManage) refuseReadOnly();
            await client.assign(openId, assignee);
            const [thread] = await Promise.all([client.messages(openId), refresh(), reloadTrail(openId)]);
            setMessages(thread);
          }}
          onMove={async (statusKey) => {
            await handleMove(openId, statusKey);
          }}
          {...(canManage
            ? {
                onUpdate: async (patch: TicketPatch) => {
                  await client.updateTicket(openId, patch);
                  await Promise.all([refresh(), reloadTrail(openId)]);
                },
                onArchive: async () => {
                  if (openCard.archivedAt != null) {
                    await client.unarchive(openId);
                  } else {
                    await client.archive(openId);
                    // An archived ticket leaves the default board; close the
                    // panel rather than leave it over a card that vanished.
                    if (!filters.archived) open(null);
                  }
                  await refresh();
                },
              }
            : {})}
          onError={(error) => setNotice(messageOf(error))}
        />
      ) : null}
    </>
  );
}
