/**
 * The board's filters as plain data (0.11.0): what the toolbar edits, what the
 * address bar carries, and what the board route reads. No React, no database,
 * no zod — the browser (./board) and the server (.) share this one file, so a
 * filter the toolbar writes is exactly the filter the server parses.
 *
 * Ask Lou's model, with its rough edges filed off:
 *
 *   - OR within a field, AND across fields, and search ANDs with them too
 *     (Ask Lou's search silently dropped every other filter).
 *   - ONE set of names for the address bar and the request: `status`,
 *     `priority`, `category`, `assignee`, `source`, `q`, `from`, `to`,
 *     `archived` — so a shared link and a refresh read the same board.
 *   - `NONE` ("Unassigned", "No category") and `ME` ("Mine") are values in
 *     their field, not separate flags: the "Unassigned" option and the
 *     "Unassigned" quick filter are the same thing, and Clear clears both.
 *   - `ME` is resolved on the SERVER to whoever is asking, so a link saying
 *     "mine" means mine for whoever opens it.
 */

/** "Unassigned" / "No category": the field is empty. */
export const FILTER_NONE = "__none";
/** "Mine": assigned to whoever is looking. Resolved on the server. */
export const FILTER_ME = "__me";
/**
 * A name typed as the assignee in 0.10, not linked to anyone on the team
 * (0.11.0): `__name:Old Typed Name`. Its own choice in "Assigned to", so
 * every ticket is findable by who it's assigned to and the counts add up.
 */
export const FILTER_NAMED_PREFIX = "__name:";
export function namedAssignee(name: string): string {
  return `${FILTER_NAMED_PREFIX}${name}`;
}

export const FILTER_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type FilterPriority = (typeof FILTER_PRIORITIES)[number];

export const FILTER_SOURCES = ["widget", "page", "staff"] as const;
export type FilterSource = (typeof FILTER_SOURCES)[number];

/** What a person reads for each source, everywhere the board names one. */
export const SOURCE_LABELS: Readonly<Record<FilterSource, string>> = Object.freeze({
  widget: "Feedback button",
  page: "Feedback page",
  staff: "Your team",
});

export const PRIORITY_LABELS: Readonly<Record<FilterPriority, string>> = Object.freeze({
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
});

/** The fields that take several values. */
export const FILTER_FIELDS = ["status", "priority", "category", "assignee", "source"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface BoardFilters {
  /** Free text: ticket number, title, the report, the reporter's name or email. */
  q: string;
  status: string[];
  priority: string[];
  category: string[];
  assignee: string[];
  source: string[];
  /** Sent on or after this moment (ISO), inclusive. */
  from: string | null;
  /** Sent before this moment (ISO), exclusive — the toolbar sends the start of the day after. */
  to: string | null;
  /** Archived tickets too (greyed). */
  archived: boolean;
}

export const EMPTY_FILTERS: BoardFilters = Object.freeze({
  q: "",
  status: [],
  priority: [],
  category: [],
  assignee: [],
  source: [],
  from: null,
  to: null,
  archived: false,
}) as BoardFilters;

/** The most values one field takes, and the longest search: a link can't become a giant query. */
export const MAX_FILTER_VALUES = 50;
export const MAX_SEARCH_LENGTH = 200;

/** Every name this module reads or writes in a query string. */
export const FILTER_PARAM_NAMES: readonly string[] = [...FILTER_FIELDS, "q", "from", "to", "archived"];

function cleanValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0 || value.length > 200) continue;
    seen.add(value);
    if (seen.size >= MAX_FILTER_VALUES) break;
  }
  return [...seen];
}

/** A day ("2026-10-01") or a moment; anything else is no bound. */
function cleanMoment(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) return null;
  return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed;
}

/**
 * Read filters from a query string. Unknown names and empty values are
 * dropped; repeated names are a field's several values (`?status=open&status=done`).
 */
export function filtersFromSearchParams(params: URLSearchParams): BoardFilters {
  const many = (name: FilterField) => cleanValues(params.getAll(name));
  const archived = params.get("archived");
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH),
    status: many("status"),
    priority: many("priority").filter((value) => (FILTER_PRIORITIES as readonly string[]).includes(value)),
    category: many("category"),
    assignee: many("assignee"),
    source: many("source").filter((value) => (FILTER_SOURCES as readonly string[]).includes(value)),
    from: cleanMoment(params.get("from")),
    to: cleanMoment(params.get("to")),
    archived: archived === "1" || archived === "true",
  };
}

/** The filters as a query string's names and values: only what is set, so a clear board is a clean address. */
export function filtersToSearchParams(filters: BoardFilters, into: URLSearchParams = new URLSearchParams()): URLSearchParams {
  for (const name of FILTER_PARAM_NAMES) into.delete(name);
  if (filters.q.trim()) into.set("q", filters.q.trim());
  for (const field of FILTER_FIELDS) for (const value of filters[field]) into.append(field, value);
  if (filters.from) into.set("from", filters.from);
  if (filters.to) into.set("to", filters.to);
  if (filters.archived) into.set("archived", "1");
  return into;
}

/** Does the query string carry any filter at all? (A bare address restores the remembered ones.) */
export function hasFilterParams(params: URLSearchParams): boolean {
  return FILTER_PARAM_NAMES.some((name) => params.has(name));
}

/** How many things narrow the board: each field with a choice, the search, the dates, archived. */
export function activeFilterCount(filters: BoardFilters): number {
  return (
    FILTER_FIELDS.filter((field) => filters[field].length > 0).length +
    (filters.q.trim() ? 1 : 0) +
    (filters.from || filters.to ? 1 : 0) +
    (filters.archived ? 1 : 0)
  );
}

/** True when nothing but "show archived" (or nothing at all) is set: the board is the whole board. */
export function isUnfiltered(filters: BoardFilters): boolean {
  return activeFilterCount(filters) - (filters.archived ? 1 : 0) === 0;
}

export function sameFilters(a: BoardFilters, b: BoardFilters): boolean {
  return filtersToSearchParams(a).toString() === filtersToSearchParams(b).toString();
}
