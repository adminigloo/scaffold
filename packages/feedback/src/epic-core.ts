import type { FeedbackEpicStatus } from "./schema.js";

/**
 * Epics as plain data (0.12.0): the statuses and the moves between them, the
 * colours, and THE ONE progress rule. No React, no database, no zod — the
 * server (epics-data.ts), the board (./board) and the epic screens (./epics)
 * share this file, so the list, an epic's page and its progress bar can
 * never disagree about what "done" means.
 *
 * Ask Lou's epics, with its known bugs designed out:
 *
 *   - Progress is by the COLUMN'S FLAGS, never by its name: done is a
 *     finished column (`isTerminal`), waiting is a column marked waiting
 *     (`isWaiting`), not started is the column new tickets land in, and
 *     everything else is in progress. Ask Lou bucketed by status name, so a
 *     renamed or custom column counted a ticket "done" in the totals and
 *     listed it under "In progress" on the same page.
 *   - The status picker only offers the moves the server allows (Ask Lou
 *     offered archived → in progress, and the refusal failed silently).
 *   - Nothing completes an epic by itself; "every ticket is done" is a
 *     question the epic's page asks (`allDone`).
 *   - AN ARCHIVED TICKET COUNTS AS DONE: it has been put away, whatever
 *     column it was in. (Review L4: an archived ticket that never finished
 *     held its epic below 100% for ever, with no way to move it.)
 */

export type EpicStatus = FeedbackEpicStatus;

export const EPIC_STATUSES: readonly EpicStatus[] = ["open", "in_progress", "completed", "archived"];

/** What a person reads for each status. */
export const EPIC_STATUS_LABELS: Readonly<Record<EpicStatus, string>> = Object.freeze({
  open: "Not started",
  in_progress: "In progress",
  completed: "Completed",
  archived: "Archived",
});

/**
 * The moves an epic may make (Ask Lou's table): any live status to any other,
 * and an archived epic only back to "not started" — restoring it, so its
 * stamps are cleared before anyone works on it again.
 */
export const EPIC_TRANSITIONS: Readonly<Record<EpicStatus, readonly EpicStatus[]>> = Object.freeze({
  open: ["in_progress", "completed", "archived"],
  in_progress: ["open", "completed", "archived"],
  completed: ["open", "in_progress", "archived"],
  archived: ["open"],
});

export function canMoveEpic(from: EpicStatus, to: EpicStatus): boolean {
  return from === to || (EPIC_TRANSITIONS[from]?.includes(to) ?? false);
}

/** Tickets can be added to an epic that is still being worked on — never to a finished or archived one. */
export function takesTickets(status: EpicStatus): boolean {
  return status === "open" || status === "in_progress";
}

/**
 * The colours an epic can be (Ask Lou's ten). Stored by NAME, so each theme
 * draws its own shade; the value here is the dot's colour, never text.
 */
export const EPIC_COLORS = Object.freeze({
  blue: "#2563eb",
  indigo: "#4f46e5",
  purple: "#9333ea",
  pink: "#db2777",
  red: "#dc2626",
  orange: "#ea580c",
  yellow: "#ca8a04",
  green: "#16a34a",
  teal: "#0d9488",
  gray: "#6b7280",
} as const);

export type EpicColor = keyof typeof EPIC_COLORS;
export const EPIC_COLOR_NAMES = Object.keys(EPIC_COLORS) as EpicColor[];

/** The dot's colour for a stored name; an unknown name (a row edited by hand) draws grey. */
export function epicColorOf(name: string | null | undefined): string {
  return (EPIC_COLORS as Record<string, string>)[name ?? ""] ?? EPIC_COLORS.gray;
}

/** Where a ticket stands, as an epic's progress counts it. */
export type EpicBucket = "open" | "in_progress" | "waiting" | "done";

export const EPIC_BUCKET_LABELS: Readonly<Record<EpicBucket, string>> = Object.freeze({
  open: "Not started",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
});

/** What the progress rule needs to know about a column. */
export interface EpicColumn {
  readonly key: string;
  readonly isTerminal?: boolean | null;
  readonly isWaiting?: boolean | null;
}

/** The column new tickets land in: the first unfinished one, else the first. */
export function landingColumnOf(columns: readonly EpicColumn[]): string | null {
  return columns.find((column) => !column.isTerminal)?.key ?? columns[0]?.key ?? null;
}

/**
 * THE RULE, in one place: an archived ticket is done (it's been put away); a
 * finished column is done; the column new tickets land in is "not started";
 * a column marked waiting is waiting; anything else — including a status no
 * column has any more — is in progress, so a ticket is always counted
 * somewhere (Ask Lou's catch-all, kept on purpose).
 */
export function epicBucketOf(
  status: string,
  columns: readonly EpicColumn[],
  landing: string | null = landingColumnOf(columns),
  archived = false,
): EpicBucket {
  if (archived) return "done";
  const column = columns.find((candidate) => candidate.key === status);
  if (column?.isTerminal) return "done";
  if (column && status === landing) return "open";
  if (column?.isWaiting) return "waiting";
  return "in_progress";
}

export interface EpicProgress {
  /** Every ticket in the epic, archived ones included. */
  total: number;
  done: number;
  inProgress: number;
  waiting: number;
  /** Not started: still in the column new tickets land in. */
  open: number;
  /** Whole percent done, rounded DOWN: 99.6% is 99, so 100% only ever means every ticket. */
  percent: number;
  /** Every ticket is done (and there is at least one): the page asks "mark it completed?". */
  allDone: boolean;
}

export const EMPTY_PROGRESS: EpicProgress = Object.freeze({
  total: 0,
  done: 0,
  inProgress: 0,
  waiting: 0,
  open: 0,
  percent: 0,
  allDone: false,
}) as EpicProgress;

/**
 * Progress from counts per column key of the un-archived tickets — what the
 * server's grouped query gives — and how many archived tickets there are
 * (counted as done).
 */
export function epicProgressFromCounts(counts: Readonly<Record<string, number>>, columns: readonly EpicColumn[], archived = 0): EpicProgress {
  const landing = landingColumnOf(columns);
  const archivedCount = Math.max(0, Number(archived) || 0);
  const out = { done: archivedCount, inProgress: 0, waiting: 0, open: 0 };
  let total = archivedCount;
  for (const [status, raw] of Object.entries(counts)) {
    const n = Number(raw) || 0;
    if (n <= 0) continue;
    total += n;
    const bucket = epicBucketOf(status, columns, landing);
    if (bucket === "done") out.done += n;
    else if (bucket === "waiting") out.waiting += n;
    else if (bucket === "open") out.open += n;
    else out.inProgress += n;
  }
  return {
    total,
    ...out,
    percent: total === 0 ? 0 : Math.floor((out.done * 100) / total),
    allDone: total > 0 && out.done === total,
  };
}

/** Progress from a list of tickets (each with its column key; an archived one counts as done). */
export function epicProgress(
  tickets: ReadonlyArray<{ readonly status: string; readonly archivedAt?: Date | string | null }>,
  columns: readonly EpicColumn[],
): EpicProgress {
  const counts: Record<string, number> = {};
  let archived = 0;
  for (const ticket of tickets) {
    if (ticket.archivedAt != null) archived += 1;
    else counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
  }
  return epicProgressFromCounts(counts, columns, archived);
}

/** "3 of 8 done (37%)" — the bar's words. */
export function progressWords(progress: EpicProgress): string {
  if (progress.total === 0) return "No tickets yet";
  return `${progress.done} of ${progress.total} done (${progress.percent}%)`;
}

/** A target day as "YYYY-MM-DD" in the viewer's calendar. */
function dayNumber(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/**
 * "Due in 3 days", "Due today", "2 days late" — against `today` in the
 * viewer's own calendar. Null when there is no date, or the epic is finished
 * (a completed epic isn't late).
 */
export function epicDueWords(targetDate: string | null | undefined, status: EpicStatus, today: Date = new Date()): string | null {
  if (!targetDate || status === "completed" || status === "archived") return null;
  const target = dayNumber(targetDate);
  if (target === null) return null;
  const now = Math.round(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000);
  const left = target - now;
  if (left === 0) return "Due today";
  if (left === 1) return "Due tomorrow";
  if (left > 1) return `Due in ${left} days`;
  return left === -1 ? "1 day late" : `${-left} days late`;
}

/** Is it past its date and not finished? (The list marks it.) */
export function epicIsLate(targetDate: string | null | undefined, status: EpicStatus, today: Date = new Date()): boolean {
  const words = epicDueWords(targetDate, status, today);
  return words !== null && words.endsWith("late");
}

/** A day as people read it: "30 Nov 2026". */
export function epicDayLabel(targetDate: string | null | undefined): string {
  if (!targetDate) return "";
  const n = dayNumber(targetDate);
  if (n === null) return targetDate;
  return new Date(n * 86_400_000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
