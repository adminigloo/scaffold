import { addDays, daysBetween, zonedParts } from "../time.js";
import type { BookingStatus, Medium } from "../types.js";
import type {
  AdminBlackout,
  AdminBooking,
  AdminBookingType,
  AdminException,
  AdminHost,
  ExceptionKind,
  Instant,
  WeeklyWindow,
} from "./types.js";

/**
 * The admin screens' rules, pure — so "the Outcome button only shows for a
 * call that has started" and "a week off is one row in the list" are unit
 * tests, not click paths.
 *
 * Times are shown in the HOST's zone (the clock the host runs their day on),
 * availability is edited on the server's 15-minute grid, and calendar dates
 * ("YYYY-MM-DD") are zone-free labels, so date arithmetic runs in UTC.
 */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** 00:00 … 24:00 in 15-minute steps — the server's availability grid. */
export const MINUTE_OPTIONS: readonly number[] = Array.from({ length: 97 }, (_, i) => i * 15);

/** 600 → "10:00 AM"; 1440 → "12:00 AM (end of day)". */
export function minuteLabel(minute: number): string {
  if (minute === 1440) return "12:00 AM (end of day)";
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function toDate(value: Instant): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toIso(value: Instant): string {
  return toDate(value).toISOString();
}

/** "Wed, Oct 7 · 10:30 – 11:00 AM MDT" in `zone`. */
export function formatSlot(start: Instant, end: Instant, zone: string, locale = "en-US"): string {
  const s = toDate(start);
  const e = toDate(end);
  try {
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(s);
    const range = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
      timeZoneName: "short",
    }).formatRange(s, e);
    return `${day} · ${range}`;
  } catch {
    return `${s.toISOString()} – ${e.toISOString()}`;
  }
}

/** "Tue 9:30 AM GMT+1 for them (Europe/London)" — only when their zone differs from the host's. */
export function formatInviteeTime(start: Instant, inviteeZone: string | null, hostZone: string, locale = "en-US"): string | null {
  if (!inviteeZone || inviteeZone === hostZone) return null;
  try {
    const time = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      timeZone: inviteeZone,
      timeZoneName: "short",
    }).format(toDate(start));
    return `${time} for them (${inviteeZone.replace(/_/g, " ")})`;
  } catch {
    return null;
  }
}

/** A short date-and-time, in `zone`, for an audit trail. */
export function formatStamp(value: Instant, zone: string, locale = "en-US"): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
    }).format(toDate(value));
  } catch {
    return toIso(value);
  }
}

export const MEDIUM_LABEL: Record<Medium, string> = {
  video: "Video",
  phone: "Phone",
  prospect_hosted: "Their link",
};

export const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: "Confirmed",
  requested: "Requested",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  hold: "Hold",
};

export type Tone = "ok" | "warn" | "danger" | "muted";

export function statusTone(status: BookingStatus): Tone {
  if (status === "confirmed" || status === "completed") return "ok";
  if (status === "requested") return "warn";
  if (status === "cancelled" || status === "no_show") return "danger";
  return "muted";
}

/** Every IANA zone the browser knows, `current` first when the list lacks it. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) {
    zones = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "Europe/London", "UTC"];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

/** The calendar date it is now in `zone`. */
export function todayIn(zone: string, nowMs = Date.now()): string {
  try {
    return zonedParts(new Date(nowMs), zone).date;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// What a booking may do now
// ---------------------------------------------------------------------------

export function isLive(status: BookingStatus): boolean {
  return status === "confirmed" || status === "requested";
}

/**
 * Completed / No-show only once the call has STARTED. Offered on a future
 * call, it closed the call out early: the slot stopped counting as busy (so
 * it could be double-booked), the invitee's reminder was never withdrawn,
 * and their manage page went read-only. A call in progress may be marked.
 */
export function canRecordOutcome(booking: Pick<AdminBooking, "status" | "start">, nowMs: number): boolean {
  return booking.status !== "cancelled" && booking.status !== "hold" && toDate(booking.start).getTime() <= nowMs;
}

/** A live call that has not ended. Cancelling one that already happened would email "sorry, I had to cancel" after the fact. */
export function canCancel(booking: Pick<AdminBooking, "status" | "end">, nowMs: number): boolean {
  return isLive(booking.status) && toDate(booking.end).getTime() > nowMs;
}

/** A live call that has not started, of a type the picker can ask about. */
export function canMove(booking: Pick<AdminBooking, "status" | "start" | "typeKey">, nowMs: number): boolean {
  return isLive(booking.status) && Boolean(booking.typeKey) && toDate(booking.start).getTime() > nowMs;
}

// ---------------------------------------------------------------------------
// Words that depend on whether email is wired
// ---------------------------------------------------------------------------

export function cancelButtonLabel(emailsEnabled: boolean): string {
  return emailsEnabled ? "Cancel the call and email them" : "Cancel the call";
}

export function confirmButtonLabel(emailsEnabled: boolean): string {
  return emailsEnabled ? "Confirm and email them" : "Confirm";
}

export function moveButtonLabel(emailsEnabled: boolean): string {
  return emailsEnabled ? "Move the call and email them" : "Move the call";
}

export function cancelReasonLabel(emailsEnabled: boolean, inviteeName: string | null): string {
  return emailsEnabled
    ? `A note for ${inviteeName ?? "them"} (optional, it goes in the email)`
    : "Why (optional, saved with the call)";
}

/**
 * A mailto: link prefilled for the host to tell the invitee themselves —
 * what the email-off buttons offer instead of silently changing a call the
 * other person still thinks stands.
 */
export function mailtoInvitee(email: string, subject: string, body?: string): string {
  const params = [`subject=${encodeURIComponent(subject)}`];
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return `mailto:${email}?${params.join("&")}`;
}

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

export interface EditWindow {
  start: number;
  end: number;
}

/** The server's flat list as seven days of windows, each day sorted. */
export function weekFrom(weekly: readonly WeeklyWindow[]): EditWindow[][] {
  const days: EditWindow[][] = WEEKDAYS.map(() => []);
  for (const row of weekly) days[row.dayOfWeek]?.push({ start: row.startMinute, end: row.endMinute });
  return days.map((windows) => windows.sort((a, b) => a.start - b.start));
}

/** Seven days of windows back to the server's flat list. */
export function weekToWindows(days: readonly EditWindow[][]): WeeklyWindow[] {
  return days.flatMap((windows, dayOfWeek) =>
    windows.map((window) => ({ dayOfWeek, startMinute: window.start, endMinute: window.end })),
  );
}

/** A problem with the week as typed, or null: every window ends after it starts and does not overlap the next. */
export function weekProblem(days: readonly EditWindow[][]): string | null {
  for (const [day, windows] of days.entries()) {
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    for (const [i, window] of sorted.entries()) {
      if (window.end <= window.start) return `${WEEKDAYS[day]}: each window has to end after it starts.`;
      const next = sorted[i + 1];
      if (next && next.start < window.end) return `${WEEKDAYS[day]}: two windows overlap.`;
    }
  }
  return null;
}

/** Whether two weeks are the same hours, whatever order the rows came in — for an app's `hoursAreDefault`. */
export function sameWeekly(a: readonly WeeklyWindow[], b: readonly WeeklyWindow[]): boolean {
  const key = (rows: readonly WeeklyWindow[]) =>
    rows
      .map((row) => `${row.dayOfWeek}:${row.startMinute}-${row.endMinute}`)
      .sort()
      .join("|");
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------
// Dated rows: ranges in, grouped rows out
// ---------------------------------------------------------------------------

/** The longest range one "Until" adds in a go — a quarter. Longer is a typo more often than a sabbatical. */
export const MAX_RANGE_DAYS = 92;

/**
 * Every date from `from` to `until`, both included. A missing or same-day
 * `until` is just `from`. Errors are sentences for the form.
 */
export function datesInRange(from: string, until?: string | null): { dates: string[] } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return { error: "Pick a date." };
  if (!until || until === from) return { dates: [from] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { error: "Pick an end date, or leave it empty for one day." };
  const span = daysBetween(from, until);
  if (span < 0) return { error: "The end date has to be on or after the start date." };
  if (span + 1 > MAX_RANGE_DAYS) return { error: `Add at most ${MAX_RANGE_DAYS} days at a time.` };
  return { dates: Array.from({ length: span + 1 }, (_, i) => addDays(from, i)) };
}

/** "Mon, Oct 12" — a cut date, read in UTC so it never shifts a day. */
export function formatShortDate(date: string, locale = "en-US"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

/** "Mon, Oct 12" or "Mon, Oct 12 – Sun, Oct 18". */
export function formatDateRange(from: string, to: string, locale = "en-US"): string {
  return from === to ? formatShortDate(from, locale) : `${formatShortDate(from, locale)} – ${formatShortDate(to, locale)}`;
}

export interface ExceptionGroup {
  /** Every row in the group — removing the group removes them all. */
  ids: string[];
  from: string;
  to: string;
  days: number;
  kind: ExceptionKind;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
}

/**
 * Consecutive dates with the same kind, hours and note as ONE row: a week
 * off reads "Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days" and goes away in
 * one click, instead of seven lookalike rows.
 */
export function groupExceptions(rows: readonly AdminException[]): ExceptionGroup[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.startMinute ?? -1) - (b.startMinute ?? -1));
  const groups: ExceptionGroup[] = [];
  for (const row of sorted) {
    const note = row.note?.trim() || null;
    const last = groups.find(
      (group) =>
        group.kind === row.kind &&
        group.startMinute === row.startMinute &&
        group.endMinute === row.endMinute &&
        group.note === note &&
        addDays(group.to, 1) === row.date,
    );
    if (last) {
      last.ids.push(row.id);
      last.to = row.date;
      last.days += 1;
    } else {
      groups.push({
        ids: [row.id],
        from: row.date,
        to: row.date,
        days: 1,
        kind: row.kind,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        note,
      });
    }
  }
  return groups.sort((a, b) => a.from.localeCompare(b.from));
}

export interface BlackoutGroup {
  ids: string[];
  from: string;
  to: string;
  days: number;
  label: string | null;
}

/** Holidays the same way: consecutive dates with the same label as one row. */
export function groupBlackouts(rows: readonly AdminBlackout[]): BlackoutGroup[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const groups: BlackoutGroup[] = [];
  for (const row of sorted) {
    const label = row.label?.trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.label === label && addDays(last.to, 1) === row.date) {
      last.ids.push(row.id);
      last.to = row.date;
      last.days += 1;
    } else {
      groups.push({ ids: [row.id], from: row.date, to: row.date, days: 1, label });
    }
  }
  return groups;
}

export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  off: "Day off",
  hours: "Different hours",
  block: "Blocked",
};

/** "Mon, Oct 12 – Sun, Oct 18 · Day off · 7 days". */
export function describeExceptionGroup(group: ExceptionGroup, locale = "en-US"): string {
  const parts = [formatDateRange(group.from, group.to, locale), EXCEPTION_LABEL[group.kind]];
  if (group.startMinute !== null && group.endMinute !== null) {
    parts.push(`${minuteLabel(group.startMinute)} – ${minuteLabel(group.endMinute)}`);
  }
  if (group.days > 1) parts.push(`${group.days} days`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// "Finish setting up"
// ---------------------------------------------------------------------------

export type AdminTab = "upcoming" | "past" | "availability" | "settings";

export interface ChecklistItem {
  key: "no-type" | "meeting-link" | "calendar" | "default-hours" | "feed" | "emails";
  text: string;
  /** The button that goes to the fix; absent when the fix is outside these screens. */
  action?: { label: string; tab: AdminTab; target: string };
}

/** Whether a type is offered by this host: an empty host list means every active host. */
export function typeIsForHost(type: Pick<AdminBookingType, "hostIds">, hostId: string): boolean {
  return type.hostIds.length === 0 || type.hostIds.includes(hostId);
}

/**
 * What is still unfinished, in the order it hurts. Each item is something a
 * prospect would otherwise discover first: a video call with no link, a
 * slot booked over a dentist appointment, placeholder hours that look real.
 */
export function setupChecklist(input: {
  host: AdminHost;
  types: readonly AdminBookingType[];
  emailsEnabled: boolean;
  hoursAreDefault: boolean;
}): ChecklistItem[] {
  const { host, types } = input;
  const offered = types.filter((type) => type.isActive && typeIsForHost(type, host.id));
  const items: ChecklistItem[] = [];
  if (offered.length === 0) {
    items.push({
      key: "no-type",
      text: "Nothing is bookable yet: there's no active call type.",
      action: { label: "Set up a call type", tab: "settings", target: "types" },
    });
  }
  if (offered.some((type) => type.media.includes("video")) && !host.meetingLink) {
    items.push({
      key: "meeting-link",
      text: "People who choose video are promised a link, and you haven't saved one.",
      action: { label: "Add your meeting link", tab: "settings", target: "host" },
    });
  }
  if (!host.busyIcsUrl) {
    items.push({
      key: "calendar",
      text: "Your real calendar isn't connected, so people can book over your appointments.",
      action: { label: "Connect your calendar", tab: "settings", target: "calendar" },
    });
  }
  if (input.hoursAreDefault) {
    items.push({
      key: "default-hours",
      text: "Your hours are still the placeholder defaults, and people can book them.",
      action: { label: "Set your hours", tab: "availability", target: "week" },
    });
  }
  if (!host.hasFeedToken) {
    items.push({
      key: "feed",
      text: "Booked calls won't show up in your calendar until you subscribe to your feed.",
      action: { label: "Get your feed link", tab: "settings", target: "feed" },
    });
  }
  if (!input.emailsEnabled) {
    items.push({
      key: "emails",
      text:
        "Emails aren't set up, so nobody hears from you: no confirmations, reminders or notices. People see their booking on screen only. Configure a mail provider on the server to turn them on.",
    });
  }
  return items;
}
