import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { FILTER_PRIORITIES, PRIORITY_LABELS } from "./board-filters";
import type { NewTicketInput } from "./board-client";
import { BoardStyles, useBoardStyles } from "./board-styles";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside a dialog and close it on Escape — the TicketPanel's rules,
 * for the dialogs that open above the board (New ticket, "where should these
 * tickets go"). Focus goes in on open and back to the opener on close.
 */
export function useDialogFocus(onClose: () => void): {
  ref: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button");
    (first ?? ref.current)?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return { ref, onKeyDown };
}

export interface NewTicketDialogProps {
  /** The board's columns; the ticket lands in `defaultStatus`, or the first unfinished one. */
  statuses: ReadonlyArray<{ key: string; label: string; isTerminal?: boolean | null }>;
  categories?: ReadonlyArray<{ key: string; label: string }>;
  /** The company's people; absent or empty hides "Assigned to". */
  people?: ReadonlyArray<{ id: string; name: string }>;
  /** The column the "+" was pressed on. */
  defaultStatus?: string | null;
  /**
   * Make the ticket. Throw to keep the dialog open with what was typed (the
   * error's message is shown as it is — the server's sentence). Resolve with
   * the new ticket's number to show it, and `hidden: true` when the board's
   * filters leave it off the board (the dialog says so, with "Clear filters").
   */
  onCreate: (input: NewTicketInput) => Promise<{ id: string; ticketNumber: string; hidden?: boolean }>;
  /** Clear the board's filters: offered when the new ticket is hidden by them. */
  onClearFilters?: () => void;
  onClose: () => void;
  /** "Open it" after creating. */
  onOpenTicket?: (ticketId: string) => void;
  theme?: "auto" | "light" | "dark";
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "That didn't save. Please try again.";
}

/**
 * New ticket, filed by the team (0.11.0). Only a title is needed; the rest
 * defaults the way a report from the feedback button does (first unfinished
 * column, medium priority). After it's made, the number shows with "Open it"
 * and "Make another" — the dialog stays for the next one.
 */
export function NewTicketDialog({
  statuses,
  categories = [],
  people = [],
  defaultStatus = null,
  onCreate,
  onClose,
  onOpenTicket,
  onClearFilters,
  theme = "auto",
}: NewTicketDialogProps): ReactElement {
  useBoardStyles();
  const firstOpen = statuses.find((status) => !status.isTerminal)?.key ?? statuses[0]?.key ?? "";
  const initialStatus = defaultStatus && statuses.some((s) => s.key === defaultStatus) ? defaultStatus : firstOpen;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [priority, setPriority] = useState<NewTicketInput["priority"]>("medium");
  const [category, setCategory] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [forCustomer, setForCustomer] = useState(false);
  const [reporterName, setReporterName] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [tellThem, setTellThem] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; ticketNumber: string; hidden?: boolean } | null>(null);
  const titleId = useId();
  const { ref, onKeyDown } = useDialogFocus(onClose);
  const titleRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await onCreate({
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(status ? { status } : {}),
        priority,
        category: category || null,
        ...(assigneeId ? { assigneeId } : {}),
        ...(forCustomer && reporterName.trim() ? { reporterName: reporterName.trim() } : {}),
        ...(forCustomer && reporterEmail.trim() ? { reporterEmail: reporterEmail.trim() } : {}),
        ...(forCustomer && reporterEmail.trim() && tellThem ? { tellReporter: true } : {}),
      });
      setMade(created);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  };

  const another = () => {
    setMade(null);
    setTitle("");
    setDescription("");
    setReporterName("");
    setReporterEmail("");
    setTellThem(false);
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  return (
    <div className="aib-dialog-layer" data-aib-theme={theme}>
      <BoardStyles />
      <div className="aib-dialog-backdrop" onClick={onClose} />
      <div ref={ref} className="aib-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="aib-dialog-title">
          New ticket
        </h2>
        {made ? (
          <div className="aib-done" role="status">
            {made.hidden ? (
              <span>
                <span className="aib-done-num">{made.ticketNumber}</span> is made, but the filters on the board are hiding it.
              </span>
            ) : (
              <span>
                <span className="aib-done-num">{made.ticketNumber}</span> is on the board.
              </span>
            )}
            <div className="aib-dialog-actions">
              {made.hidden && onClearFilters ? (
                <button
                  type="button"
                  className="aib-tool-btn"
                  onClick={() => {
                    onClearFilters();
                    setMade({ ...made, hidden: false });
                  }}
                >
                  Clear filters
                </button>
              ) : null}
              {onOpenTicket ? (
                <button type="button" className="aib-tool-btn" onClick={() => onOpenTicket(made.id)}>
                  Open it
                </button>
              ) : null}
              <button type="button" className="aib-tool-btn" onClick={another}>
                Make another
              </button>
              <button type="button" className="aib-tool-btn aib-tool-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="aib-dialog-grid"
          >
            <label className="aib-field aib-wide">
              Title
              <input
                ref={titleRef}
                className="aib-input"
                value={title}
                maxLength={200}
                required
                placeholder="What needs doing"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="aib-field aib-wide">
              Details <span className="aib-hint">(optional)</span>
              <textarea value={description} maxLength={5000} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label className="aib-field">
              Column
              <select className="aib-select" value={status} onChange={(event) => setStatus(event.target.value)}>
                {statuses.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="aib-field">
              Priority
              <select
                className="aib-select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as NewTicketInput["priority"])}
              >
                {FILTER_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            {categories.length > 0 ? (
              <label className="aib-field">
                Category
                <select className="aib-select" value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="">No category</option>
                  {categories.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {people.length > 0 ? (
              <label className="aib-field">
                Assigned to
                <select className="aib-select" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
                  <option value="">Nobody yet</option>
                  {people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="aib-field aib-wide" style={{ flexDirection: "row", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0 }}>
              <input type="checkbox" checked={forCustomer} onChange={(event) => setForCustomer(event.target.checked)} />
              <span>Filing this for a customer</span>
            </label>
            {forCustomer ? (
              <>
                <label className="aib-field">
                  Their name
                  <input className="aib-input" value={reporterName} maxLength={120} onChange={(event) => setReporterName(event.target.value)} />
                </label>
                <label className="aib-field">
                  Their email <span className="aib-hint">(optional)</span>
                  <input
                    className="aib-input"
                    type="email"
                    value={reporterEmail}
                    maxLength={255}
                    onChange={(event) => setReporterEmail(event.target.value)}
                  />
                </label>
                <label
                  className="aib-field aib-wide"
                  style={{ flexDirection: "row", alignItems: "center", gap: 8, textTransform: "none", letterSpacing: 0 }}
                >
                  <input
                    type="checkbox"
                    checked={tellThem}
                    disabled={!reporterEmail.trim()}
                    onChange={(event) => setTellThem(event.target.checked)}
                  />
                  <span>Email them when you reply or move it (they answer by replying to the email)</span>
                </label>
              </>
            ) : null}
            {error ? (
              <p className="aib-error aib-wide" role="alert">
                {error}
              </p>
            ) : null}
            <div className="aib-dialog-actions aib-wide">
              <button type="button" className="aib-tool-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="aib-tool-btn aib-tool-primary" disabled={!title.trim() || saving} aria-busy={saving || undefined}>
                {saving ? "Saving…" : "Make the ticket"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
