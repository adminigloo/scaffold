import { SIGNED_OUT_MESSAGE, statusWords, type ClientError } from "../http.js";
import { addDays, clockIn, formatClock, minutesOf, timeOf } from "../time.js";
import type { VisitStatus } from "../types.js";
import type { CalendarResource, TimeOffDay, VisitSnapshot, WeeklyWindow } from "./types.js";

/**
 * The staff screens' rules and words, pure: which buttons a visit offers, what
 * a refusal says, how a week of hours is edited. Unit tests, not click paths.
 *
 * The words are for a business owner and their crew, never a developer: "Request",
 * "Start", "Done", "Crew A already has a visit 10:00 AM – 12:00 PM" — not status codes.
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<VisitStatus, string> = {
  pending: "Request",
  confirmed: "Confirmed",
  in_progress: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
  declined: "Declined",
  expired: "Not answered in time",
  no_show: "No-show",
};

/** The tag class for a status (colour is never the only signal: the tag always has words). */
export function statusTagClass(status: VisitStatus): string {
  switch (status) {
    case "pending":
      return "aisw-tag aisw-tag-pending";
    case "confirmed":
      return "aisw-tag aisw-tag-ok";
    case "in_progress":
      return "aisw-tag aisw-tag-progress";
    case "completed":
      return "aisw-tag aisw-tag-done";
    case "no_show":
      return "aisw-tag aisw-tag-muted";
    default:
      return "aisw-tag aisw-tag-danger";
  }
}

/** Only requests and confirmed visits move (the server refuses the rest with `not_changeable`). */
export function isMovable(visit: Pick<VisitSnapshot, "status">): boolean {
  return visit.status === "pending" || visit.status === "confirmed";
}

export const INACTIVE_STATUSES: ReadonlySet<VisitStatus> = new Set(["cancelled", "declined", "expired", "no_show"]);

export interface VisitAction {
  /** The status this moves to. */
  to: Exclude<VisitStatus, "expired">;
  label: string;
  /** Which route: accept / decline have their own; everything else is `status`. */
  route: "accept" | "decline" | "status";
  /** The customer hears about it (so the notify checkbox applies). */
  customerFacing: boolean;
  /** Asks for an optional reason first (decline, cancel). */
  asksReason: boolean;
  tone: "primary" | "secondary" | "danger";
}

/**
 * The buttons a visit's panel offers, from the server's `nextStatuses` — never
 * a move the server would refuse. A request offers only Accept and Decline
 * (the contract's words); "cancel" on a request is the same thing as
 * declining it, said worse.
 */
export function visitActions(visit: Pick<VisitSnapshot, "status" | "nextStatuses">): VisitAction[] {
  const next = new Set(visit.nextStatuses);
  const out: VisitAction[] = [];
  const add = (action: VisitAction) => {
    if (next.has(action.to)) out.push(action);
  };
  switch (visit.status) {
    case "pending":
      // CONTRACT: the server also offers pending → cancelled; the panel shows
      // only Accept and Decline (8.5's words) so a request has one way to say no.
      add({ to: "confirmed", label: "Accept", route: "accept", customerFacing: true, asksReason: false, tone: "primary" });
      add({ to: "declined", label: "Decline", route: "decline", customerFacing: true, asksReason: true, tone: "danger" });
      break;
    case "confirmed":
      add({ to: "in_progress", label: "Start", route: "status", customerFacing: false, asksReason: false, tone: "primary" });
      add({ to: "completed", label: "Complete", route: "status", customerFacing: false, asksReason: false, tone: "secondary" });
      add({ to: "no_show", label: "No-show", route: "status", customerFacing: false, asksReason: false, tone: "secondary" });
      add({ to: "cancelled", label: "Cancel visit", route: "status", customerFacing: true, asksReason: true, tone: "danger" });
      break;
    case "in_progress":
      add({ to: "completed", label: "Complete", route: "status", customerFacing: false, asksReason: false, tone: "primary" });
      add({ to: "confirmed", label: "Not started yet", route: "status", customerFacing: false, asksReason: false, tone: "secondary" });
      add({ to: "cancelled", label: "Cancel visit", route: "status", customerFacing: true, asksReason: true, tone: "danger" });
      break;
    case "completed":
      add({ to: "in_progress", label: "Reopen", route: "status", customerFacing: false, asksReason: false, tone: "secondary" });
      break;
    case "no_show":
      add({ to: "confirmed", label: "Restore", route: "status", customerFacing: true, asksReason: false, tone: "primary" });
      add({ to: "cancelled", label: "Cancel visit", route: "status", customerFacing: true, asksReason: true, tone: "danger" });
      break;
    default:
      // cancelled, declined, expired: put it back on the calendar.
      add({ to: "confirmed", label: "Restore", route: "status", customerFacing: true, asksReason: false, tone: "primary" });
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

/** Refusals whose server message is already the plain sentence ("Crew A already has a visit 10:00 AM – 12:00 PM"). */
const SAY_AS_IS = new Set<string>([
  "slot_unavailable",
  "outside_hours",
  "invalid_window",
  "resource_unavailable",
  "not_changeable",
  "transition_not_allowed",
  "too_soon",
  "too_far",
  "address_unresolved",
  "too_late",
]);

/** What staff read when a change didn't go through. */
export function adminErrorText(error: ClientError): string {
  // Signed out (a 401, or a sign-in page a redirect led to): say so, rather
  // than "you don't have permission" to a dispatcher whose session expired.
  if (error.status === 401) return SIGNED_OUT_MESSAGE;
  if (SAY_AS_IS.has(error.code) && error.message && error.message !== error.code) return error.message;
  switch (error.code) {
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    case "bad_response":
      return statusWords(error.status, "Something went wrong on our side. Please try again.");
    case "forbidden":
      return "You don't have permission to do that.";
    case "not_found":
      return "That visit or crew isn't there any more. The calendar has been refreshed.";
    case "rate_limited":
      return "That's a lot of changes in a short time. Wait a minute, then try again.";
    case "slot_unavailable":
      return "That time is already taken.";
    case "outside_hours":
      return "That's outside the crew's hours.";
    case "not_changeable":
      return "This visit can't be moved in its current state.";
    case "transition_not_allowed":
      return "That change isn't allowed from the visit's current state.";
    case "invalid":
      return error.issues && error.issues.length > 0
        ? error.issues.map((issue) => issue.message).join(" ")
        : error.message && error.message !== "invalid"
          ? error.message
          : "Some details weren't accepted. Check them and try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

/** Issues keyed by the first path segment that is a string (the wire field name). */
export function issuesByField(error: ClientError | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error?.issues ?? []) {
    const key = issue.path.map(String).join(".");
    const top = issue.path.find((part) => typeof part === "string");
    if (key && !out[key]) out[key] = issue.message;
    if (typeof top === "string" && !out[top]) out[top] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Crews, times and words
// ---------------------------------------------------------------------------

/** A crew's colour slot, 1–8, by its place in the list (stable while the list is). */
export function crewColor(resourceId: string | null, resources: readonly Pick<CalendarResource, "id">[]): string {
  if (!resourceId) return "var(--aisw-line-strong)";
  const index = resources.findIndex((r) => r.id === resourceId);
  return `var(--aisw-crew-${((index < 0 ? 0 : index) % 8) + 1})`;
}

/** "expires in 5 h" / "expires in 40 min" / "expires in 2 days" / "expires any minute". */
export function expiresIn(pendingExpiresAt: string | null, nowMs: number): string | null {
  if (!pendingExpiresAt) return null;
  const at = Date.parse(pendingExpiresAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 1) return "expires any minute";
  if (minutes < 60) return `expires in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `expires in ${hours} h`;
  return `expires in ${Math.round(hours / 24)} days`;
}

/**
 * A suggested time's drive, in words: "12 min drive from the previous job
 * (14 Elm St)", "about 12 min (estimate)" when the times are straight-line
 * estimates, or "First job of the day" when there's nothing before it.
 * CONTRACT: `StaffSlot` names the previous job's address, not its time, so
 * the label says "the previous job" and gives the address.
 */
export function driveLabel(slot: { driveMinutesFromPrevious: number | null; previousJobAddress: string | null }, estimated: boolean): string {
  if (slot.driveMinutesFromPrevious === null) return "No drive time to work out";
  const minutes = Math.round(slot.driveMinutesFromPrevious);
  const drive = estimated ? `about ${minutes} min drive (estimate)` : `${minutes} min drive`;
  return slot.previousJobAddress ? `${drive} from the previous job (${slot.previousJobAddress})` : `${drive} from the crew's base`;
}

/** "10:42 AM" on the business's clock, for "Done 10:42". */
export function stampTime(instant: string | null, timeZone: string, locale = "en-US"): string | null {
  if (!instant || !Number.isFinite(Date.parse(instant))) return null;
  return formatClock(clockIn(timeZone, instant), locale);
}

/** 00:00 … 24:00 on a 15-minute grid: the hours editor's choices. */
export const QUARTER_HOURS: readonly string[] = Array.from({ length: 97 }, (_, i) => timeOf(i * 15));

// ---------------------------------------------------------------------------
// Time zones by the names owners use
// ---------------------------------------------------------------------------

export interface ZoneChoice {
  zone: string;
  label: string;
}

/** The US zones first, by name and a city (contract 8.7). Arizona keeps standard time all year. */
export const US_TIME_ZONES: readonly ZoneChoice[] = [
  { zone: "America/New_York", label: "Eastern Time (New York)" },
  { zone: "America/Chicago", label: "Central Time (Chicago)" },
  { zone: "America/Denver", label: "Mountain Time (Denver)" },
  { zone: "America/Phoenix", label: "Mountain Time, no daylight saving (Phoenix)" },
  { zone: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
  { zone: "America/Anchorage", label: "Alaska Time (Anchorage)" },
  { zone: "Pacific/Honolulu", label: "Hawaii Time (Honolulu)" },
];

/** Every IANA zone the browser knows, for "Other…". */
export function allTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported === "function") return supported("timeZone");
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/London", "Europe/Paris", "Australia/Sydney", ...US_TIME_ZONES.map((z) => z.zone)];
}

// ---------------------------------------------------------------------------
// The weekly hours editor
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** The editor's row order: Monday first, the way a crew's week reads. */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

export interface EditWindow {
  start: string;
  end: string;
}

/** The wire's flat list as seven days of windows (index = dayOfWeek), each sorted. */
export function weekFromWindows(weekly: readonly WeeklyWindow[]): EditWindow[][] {
  const days: EditWindow[][] = WEEKDAYS.map(() => []);
  for (const row of weekly) days[row.dayOfWeek]?.push({ start: row.startTime, end: row.endTime });
  return days.map((windows) => windows.sort((a, b) => minutesOf(a.start) - minutesOf(b.start)));
}

/** Seven days of windows back to the wire's flat list. */
export function windowsFromWeek(days: readonly EditWindow[][]): WeeklyWindow[] {
  return days.flatMap((windows, dayOfWeek) => windows.map((w) => ({ dayOfWeek, startTime: w.start, endTime: w.end })));
}

/** A problem with the week as typed, or null: each window ends after it starts, none overlap, ≤ 50 in all. */
export function weekProblem(days: readonly EditWindow[][]): string | null {
  let total = 0;
  for (const [day, windows] of days.entries()) {
    total += windows.length;
    const sorted = [...windows].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
    for (const [i, window] of sorted.entries()) {
      if (minutesOf(window.end) <= minutesOf(window.start)) return `${WEEKDAYS[day]}: each block of hours has to end after it starts.`;
      const next = sorted[i + 1];
      if (next && minutesOf(next.start) < minutesOf(window.end)) return `${WEEKDAYS[day]}: two blocks of hours overlap.`;
    }
  }
  if (total > 50) return "That's more than 50 blocks of hours in a week. Combine some.";
  return null;
}

/** A sensible new block for a day: after the last one (a split shift), or 8:00–12:00 on an empty day. */
export function nextWindow(windows: readonly EditWindow[]): EditWindow {
  const last = windows[windows.length - 1];
  if (!last) return { start: "08:00", end: "12:00" };
  const start = Math.min(minutesOf(last.end) + 60, 23 * 60);
  return { start: timeOf(start), end: timeOf(Math.min(start + 240, 1440)) };
}

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

export interface TimeOffRange {
  /** Every row in the range — removing the range removes them all. */
  ids: string[];
  from: string;
  to: string;
  days: number;
  note: string | null;
}

/** Consecutive days off with the same note as one range: a week's vacation is one row. */
export function groupTimeOff(rows: readonly TimeOffDay[]): TimeOffRange[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const ranges: TimeOffRange[] = [];
  for (const row of sorted) {
    const note = row.note?.trim() || null;
    const last = ranges[ranges.length - 1];
    if (last && last.note === note && addDays(last.to, 1) === row.date) {
      last.ids.push(row.id);
      last.to = row.date;
      last.days += 1;
    } else {
      ranges.push({ ids: [row.id], from: row.date, to: row.date, days: 1, note });
    }
  }
  return ranges;
}

/** "3 visits are booked on those days. Move them from the calendar." */
export function strandedVisitsWarning(count: number): string | null {
  if (count <= 0) return null;
  return `${count} visit${count === 1 ? " is" : "s are"} booked on those days. Move them from the calendar.`;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** "Free estimate" → "free-estimate", the wire's key shape (/^[a-z0-9][a-z0-9-]{0,39}$/). */
export function serviceKeyFrom(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "service";
  let key = /^[a-z0-9]/.test(base) ? base : `s-${base}`.slice(0, 36);
  let n = 2;
  while (taken.includes(key)) key = `${base.slice(0, 36)}-${n++}`;
  return key;
}

/** Minutes as the owner enters notice: whole days when it divides, else hours. */
export function noticeParts(minutes: number): { amount: number; unit: "hours" | "days" } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  return { amount: Math.round((minutes / 60) * 100) / 100, unit: "hours" };
}

export function noticeMinutes(amount: number, unit: "hours" | "days"): number {
  return Math.round(amount * (unit === "days" ? 1440 : 60));
}

// ---------------------------------------------------------------------------
// Links a host hands in as patterns (Tenancy 2b-1)
// ---------------------------------------------------------------------------

/**
 * A host's link pattern with `{id}` filled in, URL-encoded (2a 7.10's rule):
 * "/app/schedule/visits/{id}/files" → "/app/schedule/visits/v%201/files". An
 * id can never add a "/", a "?" or a space to the path it lands in.
 */
export function fillIdPattern(pattern: string, id: string): string {
  return pattern.split("{id}").join(encodeURIComponent(id));
}
