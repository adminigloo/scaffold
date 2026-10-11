// Type-only, so nothing from the server package reaches the browser bundle.
import type { BookingStatus } from "__SCOPE__/scheduling";

/**
 * The schedule board's presentation decisions, out of the page so they run
 * under test without a browser or a database (src/components/schedule/__tests__).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The range the board lists: from the start of today — UTC midnight, because
 * the scheduler's days are UTC — through `days` days on.
 *
 * It started at `new Date()`, the current moment. Every visit is stored at its
 * day's UTC midnight, so from the first minute of a day that day's visits were
 * already "before now" and fell off the board — on the one day staff move a
 * visit to in progress, completed or no-show, and with it any request nobody
 * had answered yet.
 */
export function scheduleRange(now: Date, days = 30): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from, to: new Date(from.getTime() + days * DAY_MS) };
}

/**
 * The words a small business uses for each status. `pending` is a web request
 * nobody has accepted yet — "Requested" — and the raw enum strings
 * (`in_progress`, `no_show`) are not what the office says.
 */
export const STATUS_LABELS: Readonly<Record<BookingStatus, string>> = {
  pending: "Requested",
  confirmed: "Confirmed",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export function statusLabel(status: string): string {
  return (STATUS_LABELS as Readonly<Record<string, string | undefined>>)[status] ?? status;
}

export interface CrewHoursSummary {
  readonly workStartTime: string;
  readonly workEndTime: string;
  /** Whether its hours were ever saved (`setAvailability`). */
  readonly hoursConfigured: boolean;
  /** How many weekdays its saved week works (the router counts them). */
  readonly weeklyDays: number;
}

/**
 * What a crew's row says about when it works, as the scheduler reads it
 * (`resolveDayWindow`): its saved week if it has one; Mon–Fri on its work
 * hours if its hours were never saved; and off every day if they were saved
 * with no days ticked.
 *
 * The row used to print `workStartTime–workEndTime` for every crew, so a crew
 * switched off every day still read "08:00–17:00", and a crew upgraded from
 * 0.2 with saved weekdays but the flag unset was labelled "default hours"
 * while it ran its saved week.
 */
export function crewHoursLabel(crew: CrewHoursSummary): { readonly text: string; readonly off: boolean } {
  if (crew.weeklyDays > 0) {
    return { text: `Works ${crew.weeklyDays} day${crew.weeklyDays === 1 ? "" : "s"} a week`, off: false };
  }
  if (crew.hoursConfigured) return { text: "Off every day", off: true };
  return { text: `${crew.workStartTime}–${crew.workEndTime}, Mon–Fri (default hours)`, off: false };
}
