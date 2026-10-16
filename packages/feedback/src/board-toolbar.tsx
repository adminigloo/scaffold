import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  FILTER_FIELDS,
  FILTER_ME,
  FILTER_NAMED_PREFIX,
  FILTER_NONE,
  FILTER_PRIORITIES,
  FILTER_SOURCES,
  filtersFromSearchParams,
  filtersToSearchParams,
  hasFilterParams,
  isUnfiltered,
  PRIORITY_LABELS,
  SOURCE_LABELS,
  type BoardFilters,
  type FilterField,
} from "./board-filters";
import type { FeedbackFacetsWire } from "./board-client";
import { BoardStyles, useBoardStyles } from "./board-styles";

/**
 * The board's toolbar (0.11.0): Ask Lou's support-board filters — a search
 * box, a multi-select dropdown per field with a count beside each choice,
 * quick filters (Mine, Unassigned, Critical), the active filters as chips you
 * can remove one at a time, Clear, and "Showing X of Y" — with its rough
 * edges fixed:
 *
 *   - the search ANDs with the filters instead of silently dropping them;
 *   - the search box never goes stale (a link, Back, or a restored filter
 *     updates the box too);
 *   - "Unassigned" and "Mine" are choices in the Assigned-to field, so the
 *     quick filter and the dropdown can't disagree and Clear clears both;
 *   - every filter counts in the badge and Clear clears everything, archived
 *     included;
 *   - menus close on Escape, move with the arrow keys, and become a sheet
 *     along the bottom of a phone's screen;
 *   - nothing loads until remembered filters are restored (`isReady`), so the
 *     board never flashes unfiltered first.
 *
 * Controlled: it renders `filters` and reports changes through `onChange`.
 * `useBoardFilters` keeps them in the address bar and remembers them per
 * browser; `FeedbackWorkspace` wires both.
 */

// ---------------------------------------------------------------------------
// Keeping the filters: the address bar first, then what this browser remembers
// ---------------------------------------------------------------------------

/** Where the filters live in the address. Default: the page's own query string (`history.replaceState`). */
export interface BoardFilterUrl {
  read(): URLSearchParams;
  write(params: URLSearchParams): void;
  /** Told when the address changes from outside (Back, Forward); returns the unsubscribe. */
  subscribe?(onChange: () => void): () => void;
}

/** The page's own address, through the History API (Next's app router keeps its state in sync with it). */
export const windowFilterUrl: BoardFilterUrl = {
  read: () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
  write: (params) => {
    if (typeof window === "undefined") return;
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  },
  subscribe: (onChange) => {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  },
};

export interface UseBoardFiltersOptions {
  /** The address to keep them in; `false` keeps them in memory only. Default: the page's query string. */
  url?: BoardFilterUrl | false;
  /**
   * Remember the filters in this browser under this name, and bring them back
   * on a visit whose address has none (a shared link with filters always
   * wins). `false` remembers nothing.
   */
  persistKey?: string | false;
}

export interface BoardFiltersHandle {
  filters: BoardFilters;
  setFilters: (next: BoardFilters | ((current: BoardFilters) => BoardFilters)) => void;
  clear: () => void;
  /** Remembered filters have been restored: load the board now, not before. */
  isReady: boolean;
}

function readSaved(key: string): BoardFilters | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return filtersFromSearchParams(new URLSearchParams(raw));
  } catch {
    return null;
  }
}

function save(key: string, filters: BoardFilters): void {
  try {
    const query = filtersToSearchParams(filters).toString();
    if (query) window.localStorage.setItem(key, query);
    else window.localStorage.removeItem(key);
  } catch {
    /* a private window: the address bar still has them */
  }
}

export function useBoardFilters(options: UseBoardFiltersOptions = {}): BoardFiltersHandle {
  const url = options.url === undefined ? windowFilterUrl : options.url;
  const persistKey = options.persistKey === undefined ? false : options.persistKey;
  const [filters, setState] = useState<BoardFilters>(EMPTY_FILTERS);
  const [isReady, setReady] = useState(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  // First: the address, or (a bare address) what this browser remembered.
  useEffect(() => {
    const params = url ? url.read() : new URLSearchParams();
    let initial = filtersFromSearchParams(params);
    if (!hasFilterParams(params) && persistKey) {
      const saved = readSaved(persistKey);
      if (saved) {
        initial = saved;
        if (url) url.write(filtersToSearchParams(saved, url.read()));
      }
    }
    setState(initial);
    setReady(true);
    if (!url || !url.subscribe) return;
    const at = url;
    // Back and Forward: the address is the truth.
    return at.subscribe!(() => setState(filtersFromSearchParams(at.read())));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey]);

  const setFilters = useCallback(
    (next: BoardFilters | ((current: BoardFilters) => BoardFilters)) => {
      setState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        const at = urlRef.current;
        // Other parameters of the page (?ticket=…) are left as they are.
        if (at) at.write(filtersToSearchParams(value, at.read()));
        if (persistKey) save(persistKey, value);
        return value;
      });
    },
    [persistKey],
  );

  const clear = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
  return { filters, setFilters, clear, isReady };
}

// ---------------------------------------------------------------------------
// What the dropdowns offer
// ---------------------------------------------------------------------------

export interface BoardFilterOption {
  value: string;
  label: string;
  count?: number;
}

export interface BoardFilterFieldDef {
  field: FilterField;
  /** The button's words: "Status", "Assigned to". */
  label: string;
  options: BoardFilterOption[];
  /** A search box inside the menu (long lists: people, categories). Default: more than 8 options. */
  searchable?: boolean;
}

export interface BoardQuickFilter {
  id: string;
  label: string;
  /** The values this quick filter means; on = every one of them is chosen. */
  set: Partial<Record<FilterField, string[]>>;
  count?: number;
}

/**
 * The standard dropdowns for a feedback board, from what the board knows: its
 * columns, its categories, the company's people, and the server's counts.
 * Hosts with their own fields build `BoardFilterFieldDef`s directly.
 */
export function boardFilterFields(input: {
  statuses: ReadonlyArray<{ key: string; label: string }>;
  categories?: ReadonlyArray<{ key: string; label: string }>;
  people?: ReadonlyArray<{ id: string; name: string }>;
  /** The viewer's own id, when the board knows it: "Me" heads the people. */
  me?: string | null;
  facets?: Partial<FeedbackFacetsWire> | null;
}): BoardFilterFieldDef[] {
  const facets = input.facets ?? {};
  const count = (field: keyof FeedbackFacetsWire, value: string) => facets[field]?.[value] ?? (facets[field] ? 0 : undefined);
  const people = input.people ?? [];
  const withCount = (field: keyof FeedbackFacetsWire, option: { value: string; label: string }): BoardFilterOption => {
    const n = count(field, option.value);
    return n === undefined ? option : { ...option, count: n };
  };
  const meCount = input.me ? count("assignee", input.me) : undefined;
  return [
    {
      field: "status",
      label: "Status",
      options: input.statuses.map((status) => withCount("status", { value: status.key, label: status.label })),
    },
    {
      field: "priority",
      label: "Priority",
      options: FILTER_PRIORITIES.map((priority) => withCount("priority", { value: priority, label: PRIORITY_LABELS[priority] })),
    },
    {
      field: "category",
      label: "Category",
      options: [
        ...(input.categories ?? []).map((category) => withCount("category", { value: category.key, label: category.label })),
        withCount("category", { value: FILTER_NONE, label: "No category" }),
      ],
    },
    {
      field: "assignee",
      label: "Assigned to",
      options: [
        withCount("assignee", { value: FILTER_NONE, label: "Unassigned" }),
        ...(input.me ? [meCount === undefined ? { value: FILTER_ME, label: "Me" } : { value: FILTER_ME, label: "Me", count: meCount }] : []),
        ...people
          .filter((person) => person.id !== input.me)
          .map((person) => withCount("assignee", { value: person.id, label: person.name })),
        // Names typed as the assignee before 0.11 that match nobody on the
        // team: their own choice, so every ticket is findable and the counts
        // add up to the board.
        ...Object.keys(facets.assignee ?? {})
          .filter((key) => key.startsWith(FILTER_NAMED_PREFIX))
          .sort()
          .map((key) => withCount("assignee", { value: key, label: namedLabel(key) })),
      ],
      searchable: people.length > 6,
    },
    {
      field: "source",
      // Not "From": that reads as the person who sent it.
      label: "Came in through",
      options: FILTER_SOURCES.map((source) => withCount("source", { value: source, label: SOURCE_LABELS[source] })),
    },
  ];
}

/** Mine (when the board knows who's looking), Unassigned, Critical — with the server's counts. */
export function boardQuickFilters(input: { me?: string | null; facets?: Partial<FeedbackFacetsWire> | null }): BoardQuickFilter[] {
  const facets = input.facets ?? {};
  const n = (field: keyof FeedbackFacetsWire, value: string) => facets[field]?.[value];
  const counted = (filter: BoardQuickFilter, value: number | undefined): BoardQuickFilter =>
    value === undefined ? filter : { ...filter, count: value };
  return [
    ...(input.me ? [counted({ id: "mine", label: "Mine", set: { assignee: [FILTER_ME] } }, facets.assignee ? (n("assignee", input.me) ?? 0) : undefined)] : []),
    counted({ id: "unassigned", label: "Unassigned", set: { assignee: [FILTER_NONE] } }, facets.assignee ? (n("assignee", FILTER_NONE) ?? 0) : undefined),
    counted({ id: "critical", label: "Critical", set: { priority: ["critical"] } }, facets.priority ? (n("priority", "critical") ?? 0) : undefined),
  ];
}

/** "__name:Old Typed Name" → "Old Typed Name (not linked)". */
function namedLabel(value: string): string {
  return `${value.slice(FILTER_NAMED_PREFIX.length)} (not linked)`;
}

function quickIsOn(filters: BoardFilters, quick: BoardQuickFilter): boolean {
  return (Object.entries(quick.set) as Array<[FilterField, string[]]>).every(
    ([field, values]) => values.length === filters[field].length && values.every((value) => filters[field].includes(value)),
  );
}

function toggleQuick(filters: BoardFilters, quick: BoardQuickFilter): BoardFilters {
  const next = { ...filters };
  const on = quickIsOn(filters, quick);
  for (const [field, values] of Object.entries(quick.set) as Array<[FilterField, string[]]>) {
    next[field] = on ? [] : [...values];
  }
  return next;
}

// ---------------------------------------------------------------------------
// Dates: the address carries days; the server gets moments in the viewer's zone
// ---------------------------------------------------------------------------

function dayOf(value: string | null): string {
  if (!value) return "";
  return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? "";
}

function localMidnight(day: string, plusDays = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The filters as the server should read them: the address's days ("from
 * 1 Oct to 5 Oct", both inclusive) become moments in the viewer's own time
 * zone — the start of the first day, and the start of the day after the last.
 */
export function filtersForRequest(filters: BoardFilters): BoardFilters {
  const from = filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? localMidnight(filters.from) : filters.from;
  const to = filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? localMidnight(filters.to, 1) : filters.to;
  return { ...filters, from, to };
}

function dayLabel(day: string): string {
  const iso = localMidnight(day);
  if (!iso) return day;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// ---------------------------------------------------------------------------
// The dropdown
// ---------------------------------------------------------------------------

/** Close a menu when the pointer goes down anywhere outside it. */
function useOutside(ref: { current: HTMLElement | null }, open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) closeRef.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, ref]);
}

function FilterMenu({
  def,
  selected,
  onChange,
}: {
  def: BoardFilterFieldDef;
  selected: readonly string[];
  onChange: (values: string[]) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const searchable = def.searchable ?? def.options.length > 8;
  const close = useCallback((focusButton = false) => {
    setOpen(false);
    setFind("");
    if (focusButton) buttonRef.current?.focus();
  }, []);
  useOutside(wrapRef, open, () => close(false));

  const shown = useMemo(() => {
    const needle = find.trim().toLowerCase();
    return needle ? def.options.filter((option) => option.label.toLowerCase().includes(needle)) : def.options;
  }, [def.options, find]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    // Into the menu: its search box, or its first choice.
    requestAnimationFrame(() => {
      const target = wrapRef.current?.querySelector<HTMLElement>(searchable ? ".aib-menu input[type=search]" : ".aib-option input");
      target?.focus();
    });
  }, [open, searchable]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const boxes = [...(listRef.current?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    if (boxes.length === 0) return;
    event.preventDefault();
    const at = boxes.findIndex((box) => box === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? boxes.length - 1
          : event.key === "ArrowDown"
            ? Math.min(boxes.length - 1, at + 1)
            : Math.max(0, at === -1 ? 0 : at - 1);
    boxes[next]?.focus();
    setActive(next);
  };

  const label =
    selected.length === 0
      ? def.label
      : selected.length === 1
        ? `${def.label}: ${def.options.find((option) => option.value === selected[0])?.label ?? "1 chosen"}`
        : `${def.label}: ${selected.length} chosen`;

  return (
    <div className="aib-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`aib-tool-btn aib-menu-btn${selected.length > 0 ? " aib-on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span>{label}</span>
        <span className="aib-caret" aria-hidden="true" />
      </button>
      {open ? (
        <>
          <div className="aib-sheet-scrim" aria-hidden="true" onClick={() => close(false)} />
          <div id={menuId} className="aib-menu" role="group" aria-labelledby={`${menuId}-title`} onKeyDown={onMenuKeyDown}>
            <h3 id={`${menuId}-title`} className="aib-menu-title">
              {def.label}
            </h3>
            <div className="aib-menu-head">
              <span>
                {selected.length === 0 ? `All ${def.options.length}` : `${selected.length} of ${def.options.length} chosen`}
              </span>
              <button type="button" className="aib-link" onClick={() => onChange(def.options.map((option) => option.value))}>
                All
              </button>
              <button type="button" className="aib-link" disabled={selected.length === 0} onClick={() => onChange([])}>
                Clear
              </button>
            </div>
            {searchable ? (
              <input
                type="search"
                className="aib-input"
                placeholder={`Find ${def.label.toLowerCase()}…`}
                aria-label={`Find in ${def.label}`}
                value={find}
                onChange={(event) => setFind(event.target.value)}
              />
            ) : null}
            <ul className="aib-menu-list" ref={listRef}>
              {shown.length === 0 ? <li className="aib-menu-empty">Nothing matches.</li> : null}
              {shown.map((option, index) => (
                <li key={option.value}>
                  <label className={`aib-option${index === active ? " aib-active" : ""}`}>
                    <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggle(option.value)} />
                    <span className="aib-option-label">{option.label}</span>
                    {option.count !== undefined ? <span className="aib-option-count">{option.count}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
            <div className="aib-menu-head">
              <button type="button" className="aib-link" style={{ marginLeft: "auto" }} onClick={() => close(true)}>
                Done
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function DatesMenu({ filters, onChange }: { filters: BoardFilters; onChange: (next: BoardFilters) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useOutside(wrapRef, open, () => setOpen(false));
  const from = dayOf(filters.from);
  const to = dayOf(filters.to);
  const on = Boolean(from || to);
  const label = on ? `Sent: ${from ? dayLabel(from) : "…"} – ${to ? dayLabel(to) : "…"}` : "Sent";
  return (
    <div className="aib-menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`aib-tool-btn aib-menu-btn${on ? " aib-on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <span className="aib-caret" aria-hidden="true" />
      </button>
      {open ? (
        <>
          <div className="aib-sheet-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            id={menuId}
            className="aib-menu"
            role="group"
            aria-labelledby={`${menuId}-title`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
          >
            <h3 id={`${menuId}-title`} className="aib-menu-title">
              When it was sent
            </h3>
            <div className="aib-dates">
              <label>
                From
                <input
                  type="date"
                  className="aib-input"
                  value={from}
                  max={to || undefined}
                  onChange={(event) => onChange({ ...filters, from: event.target.value || null })}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  className="aib-input"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => onChange({ ...filters, to: event.target.value || null })}
                />
              </label>
            </div>
            <div className="aib-menu-head">
              <button type="button" className="aib-link" disabled={!on} onClick={() => onChange({ ...filters, from: null, to: null })}>
                Any time
              </button>
              <button
                type="button"
                className="aib-link"
                style={{ marginLeft: "auto" }}
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
              >
                Done
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The toolbar
// ---------------------------------------------------------------------------

export interface BoardToolbarProps {
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
  /** The dropdowns, in order (`boardFilterFields` builds the standard ones). */
  fields: BoardFilterFieldDef[];
  /** One-click filters (`boardQuickFilters`). */
  quickFilters?: BoardQuickFilter[];
  /** Offer the "Sent" date range. Default true. */
  dates?: boolean;
  searchPlaceholder?: string;
  /** How long typing waits before searching; Enter searches at once. Default 300ms. */
  searchDebounceMs?: number;
  /** How many tickets match, how many the board has, how many are on screen (truncated: some aren't). */
  matchCount?: number | null;
  totalCount?: number | null;
  shownCount?: number | null;
  truncated?: boolean;
  /** "New ticket": shown when given. */
  onCreate?: (() => void) | null;
  /** More controls on the first row (Archive finished, a settings link). */
  actions?: ReactNode;
  /** See `BoardTheme` on the board. */
  theme?: "auto" | "light" | "dark";
}

function chipsOf(filters: BoardFilters, fields: BoardFilterFieldDef[]): Array<{ key: string; text: string; remove: (f: BoardFilters) => BoardFilters }> {
  const chips: Array<{ key: string; text: string; remove: (f: BoardFilters) => BoardFilters }> = [];
  if (filters.q.trim()) chips.push({ key: "q", text: `Search: “${filters.q.trim()}”`, remove: (f) => ({ ...f, q: "" }) });
  for (const field of FILTER_FIELDS) {
    const def = fields.find((candidate) => candidate.field === field);
    for (const value of filters[field]) {
      const label =
        def?.options.find((option) => option.value === value)?.label ??
        (value === FILTER_ME
          ? "Me"
          : value === FILTER_NONE
            ? "None"
            : value.startsWith(FILTER_NAMED_PREFIX)
              ? namedLabel(value)
              : "Someone not listed");
      chips.push({
        key: `${field}:${value}`,
        text: `${def?.label ?? field}: ${label}`,
        remove: (f) => ({ ...f, [field]: f[field].filter((v) => v !== value) }),
      });
    }
  }
  if (filters.from || filters.to) {
    const from = dayOf(filters.from);
    const to = dayOf(filters.to);
    chips.push({
      key: "dates",
      text: `Sent: ${from ? dayLabel(from) : "any time"} – ${to ? dayLabel(to) : "today"}`,
      remove: (f) => ({ ...f, from: null, to: null }),
    });
  }
  if (filters.archived) chips.push({ key: "archived", text: "Showing archived", remove: (f) => ({ ...f, archived: false }) });
  return chips;
}

export function BoardToolbar({
  filters,
  onChange,
  fields,
  quickFilters = [],
  dates = true,
  searchPlaceholder = "Search number, title, report, name or email",
  searchDebounceMs = 300,
  matchCount = null,
  totalCount = null,
  shownCount = null,
  truncated = false,
  onCreate = null,
  actions,
  theme = "auto",
}: BoardToolbarProps): ReactElement {
  useBoardStyles();
  const [draft, setDraft] = useState(filters.q);
  const committed = useRef(filters.q);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const searchId = useId();

  // A search that changed from OUTSIDE the box (a link, Back, Clear, a
  // restored filter) shows in the box — Ask Lou's box went stale here.
  if (filters.q !== committed.current) {
    committed.current = filters.q;
    if (draft !== filters.q) setDraft(filters.q);
  }

  const commit = useCallback((text: string) => {
    if (text.trim() === filtersRef.current.q.trim()) return;
    committed.current = text.trim();
    onChangeRef.current({ ...filtersRef.current, q: text.trim() });
  }, []);

  useEffect(() => {
    if (draft.trim() === filters.q.trim()) return;
    const timer = setTimeout(() => commit(draft), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [draft, filters.q, searchDebounceMs, commit]);

  const chips = chipsOf(filters, fields);
  const active = activeFilterCount(filters);
  const narrowed = !isUnfiltered(filters);

  let countLine: ReactNode = null;
  if (totalCount !== null) {
    countLine = narrowed ? (
      <span className="aib-count-line" role="status">
        Showing <b>{matchCount ?? shownCount ?? 0}</b> of <b>{totalCount}</b> {totalCount === 1 ? "ticket" : "tickets"}
      </span>
    ) : (
      <span className="aib-count-line" role="status">
        <b>{totalCount}</b> {totalCount === 1 ? "ticket" : "tickets"}
      </span>
    );
  }

  return (
    <div className="aib-toolbar aib-filterbar" data-aib-theme={theme === "auto" ? undefined : theme}>
      <BoardStyles />
      <div className="aib-filter-row">
        <div className="aib-search">
          <span className="aib-search-icon" aria-hidden="true" />
          <label htmlFor={searchId} className="aib-sr">
            Search tickets
          </label>
          <input
            id={searchId}
            type="search"
            className="aib-input"
            placeholder={searchPlaceholder}
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(draft);
              } else if (event.key === "Escape" && draft) {
                event.preventDefault();
                event.stopPropagation();
                setDraft("");
                commit("");
              }
            }}
          />
        </div>
        {onCreate ? (
          <button type="button" className="aib-tool-btn aib-tool-primary" onClick={onCreate}>
            New ticket
          </button>
        ) : null}
        {actions}
      </div>
      <div className="aib-filter-row" role="group" aria-label="Filters">
        {fields.map((def) => (
          <FilterMenu key={def.field} def={def} selected={filters[def.field]} onChange={(values) => onChange({ ...filters, [def.field]: values })} />
        ))}
        {dates ? <DatesMenu filters={filters} onChange={onChange} /> : null}
        {quickFilters.map((quick) => {
          const on = quickIsOn(filters, quick);
          return (
            <button
              key={quick.id}
              type="button"
              className="aib-tool-btn aib-quick"
              aria-pressed={on}
              onClick={() => onChange(toggleQuick(filters, quick))}
            >
              {quick.label}
              {quick.count !== undefined ? <span className="aib-quick-count">{quick.count}</span> : null}
            </button>
          );
        })}
        <button
          type="button"
          className="aib-tool-btn"
          aria-pressed={filters.archived}
          onClick={() => onChange({ ...filters, archived: !filters.archived })}
        >
          {filters.archived ? "Hide archived" : "Show archived"}
        </button>
      </div>
      {chips.length > 0 || countLine ? (
        <div className="aib-filter-row">
          {countLine}
          {chips.length > 0 ? (
            <div className="aib-chips" aria-label="Active filters">
              {chips.map((chip) => (
                <span key={chip.key} className="aib-fchip">
                  <span className="aib-fchip-text">{chip.text}</span>
                  <button type="button" aria-label={`Remove ${chip.text}`} onClick={() => onChange(chip.remove(filters))}>
                    ×
                  </button>
                </span>
              ))}
              <button type="button" className="aib-link" onClick={() => onChange(EMPTY_FILTERS)}>
                Clear {active > 1 ? `all ${active}` : "filter"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {truncated && shownCount !== null && matchCount !== null ? (
        <p className="aib-truncated" role="status">
          {matchCount} tickets match, and the newest {shownCount} are on the board. Narrow the filters or search to find the rest.
        </p>
      ) : null}
    </div>
  );
}
