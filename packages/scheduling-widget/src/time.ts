import type { DateString, Instant, PublicSlot, TimeOfDay } from "./types.js";

/**
 * Date and time helpers — pure, `Intl` only, no date library.
 *
 * THE ONE RULE, and it is the opposite of the booking widget's: a visit
 * happens at the CUSTOMER'S ADDRESS, in the business's town, so every time is
 * shown in the BUSINESS's zone, as the server sends it. The wire carries the
 * wall clock (`date` + `startTime`/`endTime`, already in that zone) and the
 * instants beside it; the wall clock is what a person reads, and the instant
 * only supplies the zone's name for that date ("MST" in November, "MDT" in
 * October). Nothing here converts a time into the viewer's zone, and there is
 * no zone picker: a customer in another state booking their mother's windows
 * still wants "9:00 AM", the time the crew will knock.
 *
 * Calendar dates ("YYYY-MM-DD") are zone-free labels, so date arithmetic on
 * them runs in UTC, where every day is 24 hours long.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Wall clock
// ---------------------------------------------------------------------------

/** "09:30" → 570; "24:00" → 1440. NaN for anything else. */
export function minutesOf(time: TimeOfDay): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** 570 → "09:30"; 1440 → "24:00". Clamped to 0…1440. */
export function timeOf(minutes: number): TimeOfDay {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function clockAnchor(time: TimeOfDay): Date {
  const minutes = minutesOf(time);
  return new Date(Date.UTC(2000, 0, 3, Math.floor(minutes / 60) % 24, minutes % 60));
}

/** "09:30" → "9:30 AM"; "24:00" → "midnight". */
export function formatClock(time: TimeOfDay, locale = "en-US"): string {
  const minutes = minutesOf(time);
  if (!Number.isFinite(minutes)) return time;
  if (minutes === 1440) return "midnight";
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(clockAnchor(time));
}

/**
 * "9:00 – 10:00 AM" (the shared "AM" said once, as Intl's range formatter
 * does), or "9:00 AM – midnight" for a day's last window.
 */
export function formatTimeRange(start: TimeOfDay, end: TimeOfDay, locale = "en-US"): string {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return `${start} – ${end}`;
  if (b === 1440 || b <= a) return `${formatClock(start, locale)} – ${formatClock(end, locale)}`;
  try {
    const format = new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
    if (typeof format.formatRange === "function") return format.formatRange(clockAnchor(start), clockAnchor(end));
  } catch {
    /* an engine without formatRange: the long form below */
  }
  return `${formatClock(start, locale)} – ${formatClock(end, locale)}`;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} minutes`;
}

/** "45 min", "1 h", "1 h 40 min" — for staff screens where space is short. */
export function formatDurationShort(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

function dateAnchor(date: DateString): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const anchor = dateAnchor(value);
  return !Number.isNaN(anchor.getTime()) && anchor.toISOString().slice(0, 10) === value;
}

export function addDays(date: DateString, days: number): DateString {
  return new Date(dateAnchor(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: DateString, b: DateString): number {
  return Math.round((dateAnchor(b).getTime() - dateAnchor(a).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, the wire's `dayOfWeek`. */
export function dayOfWeek(date: DateString): number {
  return dateAnchor(date).getUTCDay();
}

/** "Monday, November 2". */
export function formatLongDate(date: DateString, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(
    dateAnchor(date),
  );
}

/** "Mon, Nov 2". */
export function formatShortDate(date: DateString, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    dateAnchor(date),
  );
}

/** "Mon, Nov 2" or "Mon, Nov 2 – Fri, Nov 6". */
export function formatDateRange(from: DateString, to: DateString, locale = "en-US"): string {
  return from === to ? formatShortDate(from, locale) : `${formatShortDate(from, locale)} – ${formatShortDate(to, locale)}`;
}

/** The pieces of a date-strip tile: { weekday: "Mon", day: "2", month: "Nov" }. */
export function formatDayTile(date: DateString, locale = "en-US"): { weekday: string; day: string; month: string } {
  const anchor = dateAnchor(date);
  const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options }).format(anchor);
  return { weekday: fmt({ weekday: "short" }), day: fmt({ day: "numeric" }), month: fmt({ month: "short" }) };
}

// ---------------------------------------------------------------------------
// Zones (only ever the business's)
// ---------------------------------------------------------------------------

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date it is at `now` in `zone` (the business's "today"). */
export function todayIn(zone: string, now: number | Date = Date.now()): DateString {
  const at = typeof now === "number" ? new Date(now) : now;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: isValidTimeZone(zone) ? zone : "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** The wall clock at `instant` in `zone`: "14:05". */
export function clockIn(zone: string, instant: Instant | Date): TimeOfDay {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: isValidTimeZone(zone) ? zone : "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    return `${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}`;
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

function zoneNamePart(zone: string, at: Date, locale: string, style: "short" | "longGeneric"): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style } as Intl.DateTimeFormatOptions).formatToParts(at);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

function instantOrNow(at: Instant | Date | null | undefined): Date {
  if (at instanceof Date) return at;
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

/** "MST" on a November date, "MDT" in October. Empty when the runtime won't say. */
export function zoneAbbreviation(zone: string, at?: Instant | Date | null, locale = "en-US"): string {
  return zoneNamePart(zone, instantOrNow(at), locale, "short");
}

/**
 * The line under the times: "Mountain Time (MST)". The generic name comes from
 * Intl's `longGeneric`, the short one says which half of the year it is; an
 * engine without `longGeneric` gets the short name alone. `at` should be an
 * instant on the day in view, so a November date never claims daylight time.
 */
export function zoneLabel(zone: string, at?: Instant | Date | null, locale = "en-US"): string {
  const when = instantOrNow(at);
  const short = zoneNamePart(zone, when, locale, "short");
  const generic = zoneNamePart(zone, when, locale, "longGeneric");
  if (generic && short && generic !== short && !/^(GMT|UTC)[+−-]/.test(generic)) return `${generic} (${short})`;
  return generic || short || zone.replace(/_/g, " ");
}

/**
 * "Monday, November 2, 9:00 – 10:00 AM MST": a visit's when, in the business's
 * zone, with the zone's short name for that date.
 */
export function describeVisitWhen(
  visit: { date: DateString; startTime: TimeOfDay; endTime: TimeOfDay; startsAt?: Instant; timeZone: string },
  locale = "en-US",
): string {
  const abbreviation = zoneAbbreviation(visit.timeZone, visit.startsAt ?? null, locale);
  return `${formatLongDate(visit.date, locale)}, ${formatTimeRange(visit.startTime, visit.endTime, locale)}${abbreviation ? ` ${abbreviation}` : ""}`;
}

/** "Tue, Nov 3, 10:00 AM" — the reschedule question. */
export function describeShortWhen(slot: { date: DateString; startTime: TimeOfDay }, locale = "en-US"): string {
  return `${formatShortDate(slot.date, locale)}, ${formatClock(slot.startTime, locale)}`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type PartOfDay = "morning" | "afternoon" | "evening";

export const PART_OF_DAY_LABELS: Record<PartOfDay, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

const PART_ORDER: readonly PartOfDay[] = ["morning", "afternoon", "evening"];

/**
 * Morning before noon, afternoon before 5 PM, evening after, on the business's
 * clock. Takes "HH:MM" or minutes since midnight. Presentation only: a day on a
 * 30-minute grid is 18 buttons, which read better as three labelled rows.
 */
export function partOfDay(at: TimeOfDay | number): PartOfDay {
  const minutes = typeof at === "number" ? at : minutesOf(at);
  if (minutes < 12 * 60) return "morning";
  if (minutes < 17 * 60) return "afternoon";
  return "evening";
}

export interface SlotDay {
  date: DateString;
  slots: PublicSlot[];
}

/**
 * Slots by their (business-zone) date, in time order, duplicates dropped: two
 * overlapping fetch windows can return the same slot twice, and two identical
 * buttons read as a bug.
 */
export function groupSlotsByDay(slots: readonly PublicSlot[]): SlotDay[] {
  const seen = new Set<string>();
  const unique = slots.filter((slot) => {
    const key = `${slot.date}|${slot.startTime}`;
    if (seen.has(key) || seen.has(slot.slotId)) return false;
    seen.add(key);
    seen.add(slot.slotId);
    return true;
  });
  unique.sort((a, b) => a.date.localeCompare(b.date) || minutesOf(a.startTime) - minutesOf(b.startTime));
  const days = new Map<DateString, PublicSlot[]>();
  for (const slot of unique) {
    const list = days.get(slot.date) ?? [];
    list.push(slot);
    days.set(slot.date, list);
  }
  return [...days.entries()].map(([date, list]) => ({ date, slots: list }));
}

export interface PartGroup {
  part: PartOfDay;
  label: string;
  slots: PublicSlot[];
}

/** One day's slots as Morning / Afternoon / Evening, empty groups left out. */
export function groupByPartOfDay(slots: readonly PublicSlot[]): PartGroup[] {
  return PART_ORDER.map((part) => ({
    part,
    label: PART_OF_DAY_LABELS[part],
    slots: slots.filter((slot) => partOfDay(slot.startTime) === part),
  })).filter((group) => group.slots.length > 0);
}

// ---------------------------------------------------------------------------
// Calendar links
// ---------------------------------------------------------------------------

/** "2026-11-02T16:00:00.000Z" → "20261102T160000Z", Google's `dates` format. */
function googleStamp(iso: Instant): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * An "Add to Google Calendar" link, built in the browser from the instants
 * (so it lands at the right moment whatever zone the person's calendar is in)
 * and the address. Null when the instants are missing. Needs no key.
 */
export function googleCalendarUrl(input: {
  title: string;
  startsAt: Instant;
  endsAt: Instant;
  location?: string | null;
  details?: string | null;
  timeZone?: string | null;
}): string | null {
  const start = googleStamp(input.startsAt);
  const end = googleStamp(input.endsAt);
  if (!start || !end) return null;
  const params = new URLSearchParams({ action: "TEMPLATE", text: input.title, dates: `${start}/${end}` });
  if (input.location) params.set("location", input.location);
  if (input.details) params.set("details", input.details);
  if (input.timeZone && isValidTimeZone(input.timeZone)) params.set("ctz", input.timeZone);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
