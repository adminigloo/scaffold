import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  FeedbackAdminClient,
  FeedbackAdminError,
  type EpicInput,
  type FeedbackBoardWire,
  type FeedbackEpicDetailWire,
  type FeedbackEpicTicketWire,
  type FeedbackEpicWire,
  type FeedbackPersonWire,
} from "./board-client";
import { FILTER_NONE } from "./board-filters";
import { BoardStyles, useBoardStyles } from "./board-styles";
import {
  EPIC_BUCKET_LABELS,
  EPIC_COLOR_NAMES,
  EPIC_STATUS_LABELS,
  EPIC_TRANSITIONS,
  epicColorOf,
  epicDayLabel,
  epicDueWords,
  epicIsLate,
  takesTickets,
  type EpicBucket,
  type EpicStatus,
} from "./epic-core";
import { EpicBadge, EpicProgressBar, EpicStatusPill } from "./epic-parts";
import { pageActionChannel } from "./page-actions";
import { useDialogFocus } from "./ticket-dialog";

export * from "./epic-core";
export { EpicBadge, EpicProgressBar, EpicStatusPill, type EpicBadgeProps, type EpicProgressBarProps } from "./epic-parts";
export type { EpicInput, FeedbackEpicDetailWire, FeedbackEpicTicketWire, FeedbackEpicWire } from "./board-client";

/**
 * `@adminigloo/feedback/epics` (0.12.0): the epic screens, as package UI —
 * the epics list (progress, status, owner, target date), an epic's page (its
 * tickets in the groups its progress counts them in, add and take out
 * tickets, move it along, the "every ticket is done — mark it completed?"
 * question) and the create/edit dialog. Included in @adminigloo/feedback.
 *
 *   <FeedbackEpics baseUrl={`/api/app/${company.id}/feedback`} epicsHref="/app/feedback/epics" boardHref="/app/feedback" />
 *   <FeedbackEpic  baseUrl={…} epicId={id} epicsHref="/app/feedback/epics" boardHref="/app/feedback" />
 *
 * Both speak a `FeedbackEpicsTransport` — `FeedbackAdminClient` over the
 * package's routes is one (pass `baseUrl`); a host with its own API passes
 * its own object. Every change is sent, then the epic is read again: the
 * server's copy is the epic.
 *
 * `canManage` only decides what is OFFERED; the server refuses every change
 * to someone without feedback.manage anyway (and to a company whose plan has
 * ended, which keeps reading its epics).
 *
 * Ask Lou's bugs, designed out here: the status picker offers only the moves
 * the server allows, and says why when one is refused; Delete waits for the
 * answer before leaving the page; "Add tickets" labels a ticket that's in
 * another epic and says it will move; a finished epic says "reopen it to add
 * tickets" instead of offering a button that fails.
 */

/** What the epic screens need (FeedbackAdminClient is one). */
export interface FeedbackEpicsTransport {
  epics(): Promise<FeedbackEpicWire[]>;
  epic(id: string): Promise<FeedbackEpicDetailWire>;
  createEpic(input: EpicInput & { name: string }): Promise<FeedbackEpicWire>;
  updateEpic(id: string, patch: EpicInput): Promise<void>;
  setEpicStatus(id: string, status: EpicStatus): Promise<void>;
  setEpicTickets(id: string, change: { add?: readonly string[]; remove?: readonly string[] }): Promise<{ added: number; movedFromOther: number; removed: number }>;
  deleteEpic(id: string): Promise<{ deleted: true; detached: number }>;
  /** The company's people (the owner picker) and who is looking. Absent: no owner picker. */
  people?(): Promise<{ people: FeedbackPersonWire[]; me: string | null }>;
  /** The board's tickets, for "Add tickets" (searched and filtered on the server). Absent: no "Add tickets". */
  board?(options: { filters?: Partial<{ q: string; epic: string[] }> }): Promise<FeedbackBoardWire>;
}

export interface EpicScreenProps {
  /** The routes' base (`/api/app/${company.id}/feedback`, `/api/admin/feedback`). */
  baseUrl?: string;
  /** Or your own transport; wins over `baseUrl`. */
  transport?: FeedbackEpicsTransport;
  /** Offer changes. Default true. */
  canManage?: boolean;
  theme?: "auto" | "light" | "dark";
}

function useTransport(props: EpicScreenProps): FeedbackEpicsTransport {
  const { baseUrl, transport } = props;
  return useMemo(() => {
    if (transport) return transport;
    if (!baseUrl) throw new Error("@adminigloo/feedback/epics: pass baseUrl or transport");
    return new FeedbackAdminClient(baseUrl);
  }, [baseUrl, transport]);
}

function sentence(error: unknown): string {
  if (error instanceof FeedbackAdminError) return error.message;
  if (error instanceof Error && error.message && !/^[A-Z_]+$/.test(error.message)) return error.message;
  return "That didn't save. Please try again.";
}

function Frame({ theme = "auto", children }: { theme?: "auto" | "light" | "dark"; children: ReactNode }): ReactElement {
  useBoardStyles();
  return (
    <div className="aib-admin aib-epics" data-aib-theme={theme}>
      <BoardStyles />
      {children}
    </div>
  );
}

function Notice({ text, onDismiss }: { text: string | null; onDismiss: () => void }): ReactElement | null {
  if (!text) return null;
  return (
    <div className="aib-notice" role="status">
      <span>{text}</span>
      <button type="button" className="aib-tool-btn" onClick={onDismiss}>
        OK
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The create / edit dialog
// ---------------------------------------------------------------------------

export interface EpicDialogProps {
  /** The epic being edited; absent: a new one. */
  epic?: Pick<FeedbackEpicWire, "name" | "description" | "targetDate" | "color" | "ownerId" | "ownerName"> | null;
  /** The company's people, for the owner. Empty hides the owner. */
  people?: ReadonlyArray<FeedbackPersonWire>;
  /** Who is looking: a new epic starts with them as its owner (they can choose nobody). */
  me?: string | null;
  /** Throw to keep the dialog open with what was typed (the message is shown as it is). */
  onSave: (input: EpicInput & { name: string }) => Promise<void>;
  onClose: () => void;
  theme?: "auto" | "light" | "dark";
}

/**
 * Make or edit an epic: its name (the only thing needed), what it's for, who
 * leads it, when it should be done and its colour. A new epic's owner starts
 * as whoever is making it — and that is what's saved, never a quiet "nobody"
 * (Ask Lou's "Me (default)" saved no owner at all).
 */
export function EpicDialog({ epic = null, people = [], me = null, onSave, onClose, theme = "auto" }: EpicDialogProps): ReactElement {
  useBoardStyles();
  const editing = epic !== null;
  const mine = me !== null && people.some((person) => person.id === me) ? me : "";
  const [name, setName] = useState(epic?.name ?? "");
  const [description, setDescription] = useState(epic?.description ?? "");
  const [ownerId, setOwnerId] = useState(editing ? (epic?.ownerId ?? "") : mine);
  const [targetDate, setTargetDate] = useState(epic?.targetDate ?? "");
  const [color, setColor] = useState(epic?.color ?? "blue");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const { ref, onKeyDown } = useDialogFocus(onClose);
  // The leader it has now, when they're no longer one of the team's people
  // (review M1): shown as such, kept unless another is picked.
  const departed = editing && epic?.ownerId && !people.some((person) => person.id === epic.ownerId) ? epic.ownerId : null;
  const startOwner = editing ? (epic?.ownerId ?? "") : null;

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        targetDate: targetDate || null,
        color,
        // The owner only when it changed (review M1): an epic led by someone
        // who has left can still be renamed or re-dated.
        ...(startOwner === null ? (people.length > 0 ? { ownerId: ownerId || null } : {}) : ownerId !== startOwner ? { ownerId: ownerId || null } : {}),
      });
    } catch (caught) {
      setError(sentence(caught));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <div className="aib-dialog-layer" data-aib-theme={theme}>
      <BoardStyles />
      <div className="aib-dialog-backdrop" onClick={onClose} />
      <div ref={ref} className="aib-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="aib-dialog-title">
          {editing ? "Edit the epic" : "New epic"}
        </h2>
        <form
          className="aib-dialog-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="aib-field aib-wide">
            Name
            <input
              className="aib-input"
              value={name}
              maxLength={120}
              required
              placeholder="New checkout, Spring price list"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="aib-field aib-wide">
            What it&rsquo;s for <span className="aib-hint">(optional)</span>
            <textarea value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} />
          </label>
          {people.length > 0 || (editing && epic?.ownerId) ? (
            <label className="aib-field">
              Who leads it
              <select className="aib-select" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
                <option value="">Nobody yet</option>
                {departed ? <option value={departed}>{`${epic?.ownerName ?? "Someone"} (no longer on the team)`}</option> : null}
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.id === me ? `${person.name} (you)` : person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="aib-field">
            Done by <span className="aib-hint">(optional)</span>
            <input className="aib-input" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
          </label>
          <div className="aib-field aib-wide">
            <span id={`${titleId}-colour`}>Colour</span>
            <div className="aib-color-pick" role="group" aria-labelledby={`${titleId}-colour`}>
              {EPIC_COLOR_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="aib-swatch"
                  style={{ background: epicColorOf(name) }}
                  aria-pressed={color === name}
                  aria-label={name}
                  title={name}
                  onClick={() => setColor(name)}
                />
              ))}
            </div>
          </div>
          {error ? (
            <p className="aib-error aib-wide" role="alert">
              {error}
            </p>
          ) : null}
          <div className="aib-dialog-actions aib-wide">
            <button type="button" className="aib-tool-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="aib-tool-btn aib-tool-primary" disabled={!name.trim() || saving} aria-busy={saving || undefined}>
              {saving ? "Saving…" : editing ? "Save" : "Make the epic"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type EpicListView = "active" | "completed" | "archived" | "all";

const VIEW_LABELS: Readonly<Record<EpicListView, string>> = {
  active: "Being worked on",
  completed: "Completed",
  archived: "Archived",
  all: "All",
};

function inView(epic: Pick<FeedbackEpicWire, "status">, view: EpicListView): boolean {
  if (view === "all") return true;
  if (view === "active") return takesTickets(epic.status);
  return epic.status === view;
}

export interface EpicListProps {
  epics: ReadonlyArray<FeedbackEpicWire>;
  /** A link per epic (its page). */
  epicHref?: (epic: FeedbackEpicWire) => string;
  /** Which epics show. Default "active" (not started and in progress). */
  view?: EpicListView;
  onViewChange?: (view: EpicListView) => void;
  /** "Today", for the due words. Default now. */
  today?: Date;
}

/** The epics as rows (cards on a phone): name, status, owner, when it's due, progress. Controlled. */
export function EpicList({ epics, epicHref, view = "active", onViewChange, today }: EpicListProps): ReactElement {
  useBoardStyles();
  const shown = epics.filter((epic) => inView(epic, view));
  return (
    <div className="aib-admin-section">
      {onViewChange ? (
        <div className="aib-tabs" role="group" aria-label="Which epics">
          {(Object.keys(VIEW_LABELS) as EpicListView[]).map((key) => (
            <button key={key} type="button" className="aib-tool-btn" aria-pressed={view === key} onClick={() => onViewChange(key)}>
              {VIEW_LABELS[key]} ({epics.filter((epic) => inView(epic, key)).length})
            </button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="aib-empty-state">
          {epics.length === 0
            ? "No epics yet. An epic groups tickets under a bigger piece of work — make one, then add tickets to it."
            : `No epics here. ${view === "active" ? "Every epic is completed or archived." : "Pick another view above."}`}
        </p>
      ) : (
        <ul className="aib-epic-list">
          {shown.map((epic) => {
            const due = epicDueWords(epic.targetDate, epic.status, today);
            const late = epicIsLate(epic.targetDate, epic.status, today);
            const href = epicHref?.(epic);
            return (
              <li key={epic.id} className="aib-epic-row">
                <div className="aib-epic-name">
                  <span className="aib-epic-dot" aria-hidden="true" style={{ background: epicColorOf(epic.color) }} />
                  {href ? <a href={href}>{epic.name}</a> : <span>{epic.name}</span>}
                </div>
                <div className="aib-epic-status">
                  <EpicStatusPill status={epic.status} />
                </div>
                <div className="aib-epic-meta">
                  <span>
                    Led by <b>{epic.ownerName ?? "nobody yet"}</b>
                  </span>
                  {epic.targetDate ? (
                    <span>
                      Done by <b>{epicDayLabel(epic.targetDate)}</b>
                      {due ? <span className={late ? " aib-late" : ""}> · {due}</span> : null}
                    </span>
                  ) : (
                    <span>No date</span>
                  )}
                </div>
                <EpicProgressBar progress={epic.progress} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface FeedbackEpicsProps extends EpicScreenProps {
  /** The epics page itself (`/app/feedback/epics`): each epic's page is `${epicsHref}/${id}`. */
  epicsHref: string;
  /** The board (`/app/feedback`), for "Back to the board". */
  boardHref?: string | null;
  /**
   * polish 3: the host page's header says "Epics" and carries "New epic"
   * (<FeedbackEpicsActions>) and its own "Back to the board", so the list
   * draws no heading or buttons of its own. Default false.
   */
  actionsInHeader?: boolean;
}

/** The list's header button, pressed in the host page's header (<FeedbackEpicsActions>). */
const epicsActions = pageActionChannel<"new">("aib-epics");

export interface FeedbackEpicsActionsProps {
  /** The host's button class (its page header's primary button). Default the board's own. */
  className?: string;
}

/**
 * "New epic" for the host page's header (polish 3), beside its title like
 * every other page's primary action: it opens the list's own New epic.
 * Render it only for someone who may change feedback (`feedback.manage`),
 * with `actionsInHeader` on the <FeedbackEpics>.
 */
export function FeedbackEpicsActions(props: FeedbackEpicsActionsProps): ReactElement | null {
  const { state, press } = epicsActions.useHeader();
  const button = state.new ?? {};
  if (button.hidden) return null;
  return (
    <button type="button" className={props.className ?? "aib-tool-btn aib-tool-primary"} disabled={button.disabled === true} data-aib-header-action="new" onClick={() => press("new")}>
      New epic
    </button>
  );
}

/** The epics list after a Delete: `?deleted=N`, N its tickets (still on the board). */
export function deletedHref(epicsHref: string, detached: number): string {
  return `${epicsHref}${epicsHref.includes("?") ? "&" : "?"}deleted=${Math.max(0, Math.floor(detached))}`;
}

/** What the list says after a Delete. */
export function deletedNotice(detached: number): string {
  if (detached <= 0) return "Deleted. It had no tickets.";
  return detached === 1 ? "Deleted. Its ticket is still on the board." : `Deleted. Its ${detached} tickets are still on the board.`;
}

/** The epics list, connected: the views, New epic, and each epic's progress. */
export function FeedbackEpics(props: FeedbackEpicsProps): ReactElement {
  const transport = useTransport(props);
  const canManage = props.canManage ?? true;
  const base = props.epicsHref.replace(/\/+$/, "");
  const [epics, setEpics] = useState<FeedbackEpicWire[] | null>(null);
  const [people, setPeople] = useState<FeedbackPersonWire[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [view, setView] = useState<EpicListView>("active");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  epicsActions.useScreen(props.actionsInHeader === true && canManage, () => setCreating(true), { new: { disabled: creating } });
  const refresh = useCallback(async () => {
    try {
      setEpics(await transport.epics());
    } catch (error) {
      setNotice(sentence(error));
    }
  }, [transport]);
  useEffect(() => {
    void refresh();
    if (transport.people) {
      void transport.people().then(
        (answer) => {
          setPeople(answer?.people ?? []);
          setMe(answer?.me ?? null);
        },
        () => undefined,
      );
    }
  }, [transport, refresh]);
  // Arrived from a Delete (`?deleted=N`): say so once, and take it off the address.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const deleted = url.searchParams.get("deleted");
    if (deleted === null || !/^\d{1,6}$/.test(deleted)) return;
    setNotice(deletedNotice(Number(deleted)));
    url.searchParams.delete("deleted");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  return (
    <Frame theme={props.theme ?? "auto"}>
      <section className="aib-admin-section">
        {props.actionsInHeader ? null : (
        <div className="aib-epics-head">
          <h2 className="aib-admin-h">Epics</h2>
          {props.boardHref ? (
            <a className="aib-tool-btn" href={props.boardHref}>
              Back to the board
            </a>
          ) : null}
          {canManage ? (
            <button type="button" className="aib-tool-btn aib-tool-primary" onClick={() => setCreating(true)}>
              New epic
            </button>
          ) : null}
        </div>
        )}
        <p className="aib-admin-sub">
          An epic groups tickets under a bigger piece of work. Its progress counts its tickets by the board&rsquo;s columns: done in
          a finished column (or archived), waiting in a column marked waiting, not started in the column new tickets land in.
        </p>
        <Notice text={notice} onDismiss={() => setNotice(null)} />
        {epics === null ? (
          <p className="aib-admin-sub">Loading the epics…</p>
        ) : (
          <EpicList epics={epics} view={view} onViewChange={setView} epicHref={(epic) => `${base}/${encodeURIComponent(epic.id)}`} />
        )}
      </section>
      {creating ? (
        <EpicDialog
          people={people}
          me={me}
          theme={props.theme ?? "auto"}
          onClose={() => setCreating(false)}
          onSave={async (input) => {
            const made = await transport.createEpic(input);
            setCreating(false);
            setView("active");
            await refresh();
            setNotice(`“${made.name}” is made. Open it to add tickets.`);
          }}
        />
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// An epic's page
// ---------------------------------------------------------------------------

const BUCKET_ORDER: readonly EpicBucket[] = ["open", "in_progress", "waiting", "done"];

/** What the status picker offers from a status: itself, then the moves the server allows — and nothing else. */
export function epicStatusChoices(status: EpicStatus): Array<{ value: EpicStatus; label: string }> {
  return [status, ...EPIC_TRANSITIONS[status]].map((value) => ({
    value,
    label: status === "archived" && value === "open" ? "Restore it (not started)" : EPIC_STATUS_LABELS[value],
  }));
}

export interface AddTicketsDialogProps {
  epic: Pick<FeedbackEpicWire, "id" | "name">;
  /** Search the board: the matching tickets, and the board's epics (to name the one a ticket is in now). */
  search: (input: { q: string; onlyWithoutEpic: boolean }) => Promise<FeedbackBoardWire>;
  /** Throw to keep the dialog open (the message is shown). */
  onAdd: (ticketIds: string[]) => Promise<void>;
  onClose: () => void;
  theme?: "auto" | "light" | "dark";
}

/**
 * "Add tickets": search the board, tick tickets, add them. Starts on the
 * tickets in no epic (Ask Lou's default); a ticket that's in another epic says
 * which, and the button says how many will move from one.
 */
export function AddTicketsDialog({ epic, search, onAdd, onClose, theme = "auto" }: AddTicketsDialogProps): ReactElement {
  useBoardStyles();
  const [q, setQ] = useState("");
  const [onlyLoose, setOnlyLoose] = useState(true);
  const [found, setFound] = useState<FeedbackBoardWire | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const { ref, onKeyDown } = useDialogFocus(onClose);
  const seq = useRef(0);

  useEffect(() => {
    const at = ++seq.current;
    const timer = setTimeout(() => {
      void search({ q: q.trim(), onlyWithoutEpic: onlyLoose }).then(
        (answer) => {
          if (at === seq.current) setFound(answer);
        },
        (caught: unknown) => {
          if (at === seq.current) setError(sentence(caught));
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [q, onlyLoose, search]);

  const names = new Map((found?.epics ?? []).map((other) => [other.id, other.name]));
  const tickets = (found?.tickets ?? []).filter((ticket) => ticket.epicId !== epic.id);
  const moving = tickets.filter((ticket) => picked.has(ticket.id) && ticket.epicId).length;
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = async () => {
    if (picked.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd([...picked]);
    } catch (caught) {
      setError(sentence(caught));
      setSaving(false);
    }
  };

  return (
    <div className="aib-dialog-layer" data-aib-theme={theme}>
      <BoardStyles />
      <div className="aib-dialog-backdrop" onClick={onClose} />
      <div ref={ref} className="aib-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="aib-dialog-title">
          Add tickets to {epic.name}
        </h2>
        <label className="aib-field">
          Find tickets
          <input
            className="aib-input"
            type="search"
            value={q}
            maxLength={200}
            placeholder="Number, title, report, name or email"
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <label className="aib-pick" style={{ padding: 0 }}>
          <input type="checkbox" checked={onlyLoose} onChange={(event) => setOnlyLoose(event.target.checked)} />
          <span className="aib-pick-text">Only tickets that aren&rsquo;t in an epic</span>
        </label>
        {found === null ? (
          <p className="aib-admin-sub">Looking…</p>
        ) : tickets.length === 0 ? (
          <p className="aib-admin-sub">{q.trim() ? "No tickets match that." : "No tickets to add."}</p>
        ) : (
          <ul className="aib-pick-list" aria-label="Tickets">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <label className="aib-pick">
                  <input type="checkbox" checked={picked.has(ticket.id)} onChange={() => toggle(ticket.id)} />
                  <span className="aib-pick-text">
                    <span className="aib-num">{ticket.ticketNumber}</span> {ticket.title}
                    {ticket.epicId ? (
                      <span className="aib-pick-note">
                        {" "}
                        — in {names.get(ticket.epicId) ?? "another epic"} now; it moves here
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {found?.truncated ? <p className="aib-admin-sub">More tickets match. Search to narrow them down.</p> : null}
        {error ? (
          <p className="aib-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="aib-dialog-actions">
          <button type="button" className="aib-tool-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="aib-tool-btn aib-tool-primary"
            disabled={picked.size === 0 || saving}
            aria-busy={saving || undefined}
            onClick={() => void add()}
          >
            {saving
              ? "Adding…"
              : picked.size === 0
                ? "Add tickets"
                : `Add ${picked.size} ticket${picked.size === 1 ? "" : "s"}${moving > 0 ? ` (${moving} from another epic)` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface EpicDetailProps {
  epic: FeedbackEpicDetailWire;
  canManage?: boolean;
  /** A ticket's link (the board with it open). */
  ticketHref?: (ticketId: string) => string;
  /** The board filtered to this epic. */
  boardHref?: string | null;
  onStatus?: (status: EpicStatus) => Promise<void>;
  onEdit?: () => void;
  /** Take tickets out of the epic (they stay on the board). */
  onRemove?: (ticketIds: string[]) => Promise<void>;
  /** Open "Add tickets". Absent: no button. */
  onAdd?: () => void;
  /** Delete the epic; resolves when it's gone. */
  onDelete?: () => Promise<void>;
  /** A change was refused: the sentence to show. */
  onError?: (error: unknown) => void;
  today?: Date;
}

/**
 * One epic: its name and words, status (only the moves allowed), owner and
 * date, its progress, its tickets in the groups the progress counts them in
 * (archived ones included, marked), and — when every ticket is done — the
 * question "mark it completed?". Nothing completes an epic by itself.
 * Controlled: `FeedbackEpic` connects it.
 */
export function EpicDetail({
  epic,
  canManage = true,
  ticketHref,
  boardHref = null,
  onStatus,
  onEdit,
  onRemove,
  onAdd,
  onDelete,
  onError,
  today,
}: EpicDetailProps): ReactElement {
  useBoardStyles();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const statusId = useId();
  const due = epicDueWords(epic.targetDate, epic.status, today);
  const late = epicIsLate(epic.targetDate, epic.status, today);
  const live = takesTickets(epic.status);
  const grouped = new Map<EpicBucket, FeedbackEpicTicketWire[]>(BUCKET_ORDER.map((bucket) => [bucket, []]));
  for (const ticket of epic.tickets) grouped.get(ticket.bucket)?.push(ticket);
  // Ticks for tickets no longer in the epic fall away.
  const present = new Set(epic.tickets.map((ticket) => ticket.id));
  const ticked = [...picked].filter((id) => present.has(id));

  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aib-epic-page">
      <div className="aib-admin-section">
        <h2 className="aib-epic-title">
          <span className="aib-epic-dot" aria-hidden="true" style={{ background: epicColorOf(epic.color) }} />
          {epic.name}
          <EpicStatusPill status={epic.status} />
        </h2>
        {epic.description ? <p className="aib-epic-desc">{epic.description}</p> : null}
        <dl className="aib-epic-facts">
          <div>
            <dt>Led by</dt>
            <dd>{epic.ownerName ?? "Nobody yet"}</dd>
          </div>
          <div>
            <dt>Done by</dt>
            <dd>
              {epic.targetDate ? epicDayLabel(epic.targetDate) : "No date"}
              {due ? <span className={late ? "aib-late" : ""}> · {due}</span> : null}
            </dd>
          </div>
        </dl>
        <EpicProgressBar progress={epic.progress} showKey />
        {epic.tickets.some((ticket) => ticket.archivedAt) ? (
          <p className="aib-admin-sub">An archived ticket counts as done: it has been put away.</p>
        ) : null}
      </div>

      {epic.progress.allDone && live && canManage && onStatus && !asked ? (
        <div className="aib-all-done" role="status">
          <span>Every ticket in this epic is done. Mark the epic completed?</span>
          <button type="button" className="aib-tool-btn aib-tool-primary" disabled={busy} onClick={() => void run(() => onStatus("completed"))}>
            Mark it completed
          </button>
          <button type="button" className="aib-tool-btn" onClick={() => setAsked(true)}>
            Not yet
          </button>
        </div>
      ) : null}

      <div className="aib-epic-actions">
        {canManage && onStatus ? (
          <label htmlFor={statusId} className="aib-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            Status
            <select
              id={statusId}
              className="aib-select"
              value={epic.status}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as EpicStatus;
                if (next !== epic.status) void run(() => onStatus(next));
              }}
            >
              {epicStatusChoices(epic.status).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {canManage && onEdit ? (
          <button type="button" className="aib-tool-btn" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        {canManage && onAdd && live ? (
          <button type="button" className="aib-tool-btn aib-tool-primary" onClick={onAdd}>
            Add tickets
          </button>
        ) : null}
        {boardHref ? (
          <a className="aib-tool-btn" href={boardHref}>
            Show on the board
          </a>
        ) : null}
        {canManage && onDelete ? (
          <button type="button" className="aib-tool-btn aib-tool-danger" disabled={busy} onClick={() => setDeleting(true)}>
            Delete
          </button>
        ) : null}
      </div>
      {canManage && !live ? (
        <p className="aib-admin-sub">
          {epic.status === "archived" ? "This epic is archived. Restore it to add tickets." : "This epic is completed. Reopen it to add tickets."}
        </p>
      ) : null}

      {deleting && onDelete ? (
        <div className="aib-notice" role="group" aria-label={`Delete ${epic.name}`}>
          <span>
            Delete this epic?{" "}
            {epic.progress.total === 0
              ? "It has no tickets."
              : `Its ${epic.progress.total === 1 ? "ticket stays" : `${epic.progress.total} tickets stay`} on the board — ${epic.progress.total === 1 ? "it just leaves" : "they just leave"} the epic.`}
          </span>
          <button
            type="button"
            className="aib-tool-btn aib-tool-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await onDelete();
              }).then((ok) => {
                if (!ok) setDeleting(false);
              })
            }
          >
            {busy ? "Deleting…" : "Delete it"}
          </button>
          <button type="button" className="aib-tool-btn" onClick={() => setDeleting(false)}>
            Keep it
          </button>
        </div>
      ) : null}

      {canManage && onRemove && ticked.length > 0 ? (
        <div className="aib-epic-actions" role="group" aria-label="Chosen tickets">
          <span className="aib-count-line">
            <b>{ticked.length}</b> chosen
          </span>
          <button
            type="button"
            className="aib-tool-btn"
            disabled={busy}
            onClick={() => void run(() => onRemove(ticked)).then((ok) => ok && setPicked(new Set()))}
          >
            Take {ticked.length === 1 ? "it" : "them"} out of the epic
          </button>
          <button type="button" className="aib-tool-btn" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {epic.tickets.length === 0 ? (
        <p className="aib-empty-state">No tickets in this epic yet.{canManage && onAdd && live ? " Add some from the board with “Add tickets”." : ""}</p>
      ) : (
        BUCKET_ORDER.map((bucket) => {
          const tickets = grouped.get(bucket) ?? [];
          if (tickets.length === 0) return null;
          return (
            <section key={bucket} className="aib-group" aria-label={`${EPIC_BUCKET_LABELS[bucket]}: ${tickets.length}`}>
              <h3 className="aib-group-h">
                {EPIC_BUCKET_LABELS[bucket]} <span className="aib-pill">{tickets.length}</span>
              </h3>
              <ul className="aib-group-list">
                {tickets.map((ticket) => (
                  <li key={ticket.id} className={`aib-epic-ticket${ticket.archivedAt ? " aib-archived" : ""}`}>
                    {canManage && onRemove ? (
                      <input
                        type="checkbox"
                        className="aib-check"
                        aria-label={`Choose ${ticket.ticketNumber}`}
                        checked={picked.has(ticket.id)}
                        onChange={() =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (next.has(ticket.id)) next.delete(ticket.id);
                            else next.add(ticket.id);
                            return next;
                          })
                        }
                      />
                    ) : null}
                    <span className="aib-num">{ticket.ticketNumber}</span>
                    <span className="aib-epic-ticket-title">
                      {ticketHref ? <a href={ticketHref(ticket.id)}>{ticket.title}</a> : ticket.title}
                    </span>
                    <span className="aib-pill">{ticket.statusLabel}</span>
                    {ticket.archivedAt ? <span className="aib-archived-chip">archived</span> : null}
                    {canManage && onRemove ? (
                      <button
                        type="button"
                        className="aib-tool-btn"
                        disabled={busy}
                        aria-label={`Take ${ticket.ticketNumber} out of the epic`}
                        onClick={() => void run(() => onRemove([ticket.id]))}
                      >
                        Take out
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
      {epic.truncated ? <p className="aib-admin-sub">The newest {epic.tickets.length} tickets are listed; the progress counts all {epic.progress.total}.</p> : null}
    </div>
  );
}

export interface FeedbackEpicProps extends EpicScreenProps {
  epicId: string;
  /** The epics page (`/app/feedback/epics`): "All epics", and where Delete lands. */
  epicsHref: string;
  /** The board (`/app/feedback`): "Show on the board" (`?epic=`) and each ticket's link (`?ticket=`). */
  boardHref?: string | null;
  /**
   * Where Delete goes once the epic is gone, told how many tickets left it.
   * Default: the epics list, which says "Deleted. Its N tickets are still on
   * the board." (`${epicsHref}?deleted=N`).
   */
  onDeleted?: (detached: number) => void;
}

/** One epic, connected: read, move along, edit, add and take out tickets, delete. */
export function FeedbackEpic(props: FeedbackEpicProps): ReactElement {
  const transport = useTransport(props);
  const canManage = props.canManage ?? true;
  const theme = props.theme ?? "auto";
  const [epic, setEpic] = useState<FeedbackEpicDetailWire | null>(null);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [people, setPeople] = useState<FeedbackPersonWire[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const board = props.boardHref ? props.boardHref.replace(/\/+$/, "") : null;

  const refresh = useCallback(async () => {
    try {
      setEpic(await transport.epic(props.epicId));
      setMissing(false);
    } catch (error) {
      if (error instanceof FeedbackAdminError && error.status === 404) setMissing(true);
      else setNotice(sentence(error));
    }
  }, [transport, props.epicId]);
  useEffect(() => {
    void refresh();
    if (transport.people) {
      void transport.people().then(
        (answer) => {
          setPeople(answer?.people ?? []);
          setMe(answer?.me ?? null);
        },
        () => undefined,
      );
    }
  }, [transport, refresh]);

  const search = useCallback(
    (input: { q: string; onlyWithoutEpic: boolean }) =>
      transport.board!({ filters: { q: input.q, epic: input.onlyWithoutEpic ? [FILTER_NONE] : [] } }),
    [transport],
  );
  // A refusal is said in words AND the epic is read again (review L3): a
  // refusal usually means it changed under you, and the page shows it as it is.
  const say = (error: unknown) => {
    setNotice(sentence(error));
    void refresh();
  };

  return (
    <Frame theme={theme}>
      <div className="aib-epics-head">
        <a className="aib-tool-btn" href={props.epicsHref}>
          All epics
        </a>
      </div>
      <Notice text={notice} onDismiss={() => setNotice(null)} />
      {missing ? (
        <p className="aib-empty-state">This epic isn&rsquo;t here. It may have been deleted, or the link is for another board.</p>
      ) : epic === null ? (
        <p className="aib-admin-sub">Loading the epic…</p>
      ) : (
        <EpicDetail
          epic={epic}
          canManage={canManage}
          {...(board ? { ticketHref: (ticketId: string) => `${board}?ticket=${encodeURIComponent(ticketId)}`, boardHref: `${board}?epic=${encodeURIComponent(epic.id)}` } : {})}
          onError={say}
          onStatus={async (status) => {
            await transport.setEpicStatus(epic.id, status);
            await refresh();
          }}
          onEdit={() => setEditing(true)}
          onRemove={async (ticketIds) => {
            const result = await transport.setEpicTickets(epic.id, { remove: ticketIds });
            await refresh();
            setNotice(`${result.removed} ticket${result.removed === 1 ? "" : "s"} taken out of the epic. ${result.removed === 1 ? "It's" : "They're"} still on the board.`);
          }}
          {...(transport.board ? { onAdd: () => setAdding(true) } : {})}
          onDelete={async () => {
            const { detached } = await transport.deleteEpic(epic.id);
            if (props.onDeleted) props.onDeleted(detached);
            // The list says what happened (review L6): `?deleted=N`.
            else if (typeof window !== "undefined") window.location.assign(deletedHref(props.epicsHref, detached));
          }}
        />
      )}
      {editing && epic ? (
        <EpicDialog
          epic={epic}
          people={people}
          me={me}
          theme={theme}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            await transport.updateEpic(epic.id, input);
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
      {adding && epic && transport.board ? (
        <AddTicketsDialog
          epic={epic}
          theme={theme}
          search={search}
          onClose={() => setAdding(false)}
          onAdd={async (ticketIds) => {
            const result = await transport.setEpicTickets(epic.id, { add: ticketIds });
            setAdding(false);
            await refresh();
            setNotice(
              `${result.added} ticket${result.added === 1 ? "" : "s"} added${result.movedFromOther > 0 ? ` (${result.movedFromOther} moved from another epic)` : ""}.`,
            );
          }}
        />
      ) : null}
    </Frame>
  );
}
