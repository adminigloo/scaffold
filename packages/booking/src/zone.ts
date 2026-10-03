/**
 * Time-zone arithmetic on nothing but `Intl`.
 *
 * WHY NOT A DATE LIBRARY. Squire (the scheduler this package is ported from)
 * leaned on dayjs + its tz plugin; that is a dependency, a plugin registry with
 * side effects, and a second copy of the IANA database that can disagree with
 * the runtime's. Every runtime this package targets already ships the zone
 * database inside `Intl.DateTimeFormat`, so the only thing missing is the
 * inverse — "this wall clock in that zone is which instant?" — and that is the
 * one function below worth reading slowly.
 *
 * THE RULE THE WHOLE PACKAGE FOLLOWS: every comparison, conflict check and sort
 * is on the absolute instant. Wall-clock dates and minutes are for describing
 * a host's week to a human and for nothing else. Storing or comparing only the
 * wall clock is how schedulers lose an hour twice a year.
 */

/** A calendar date, "YYYY-MM-DD". */
export type DateString = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An IANA zone name — "America/Denver", "UTC", "Etc/GMT+7". Deliberately NOT
 * an offset string: modern runtimes accept "+05:30" as a timeZone, but a fixed
 * offset is wrong half the year for anyone who observes DST, and the host who
 * typed it would only find out when a November call landed an hour off.
 */
const ZONE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    // Bounded: zones come from host rows and invitee browsers, and an
    // unbounded cache keyed by request input is a slow memory leak.
    if (formatterCache.size > 200) formatterCache.clear();
    formatterCache.set(zone, formatter);
  }
  return formatter;
}

/**
 * Whether `zone` is an IANA zone this runtime knows. Validated on WRITE (host
 * rows, invitee time zones) so a free-text "Mountain" or "MST7MDT-ish" never
 * reaches the slot engine — Squire stored the host zone unvalidated and a typo
 * silently fell back to the server's UTC.
 */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  if (!ZONE_NAME_PATTERN.test(zone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Is `value` a real calendar date in "YYYY-MM-DD" form (no 2026-02-30)? */
export function isValidDateString(value: unknown): value is DateString {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toISOString().slice(0, 10) === value;
}

function parseDate(date: DateString): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`not a YYYY-MM-DD date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts {
  /** The calendar date on the zone's clock, "YYYY-MM-DD". */
  date: DateString;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes since that date's midnight on the zone's clock (0..1439). */
  minuteOfDay: number;
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
}

/** An instant, read off the wall clock in `zone`. */
export function utcToZonedParts(instant: Date, zone: string): ZonedParts {
  const parts = partsFormatter(zone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  // Some engines render midnight as "24" even under h23; fold it back.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    date,
    year,
    month,
    day,
    hour,
    minute,
    second,
    minuteOfDay: hour * 60 + minute,
    dayOfWeek: WEEKDAYS[get("weekday")] ?? new Date(`${date}T00:00:00Z`).getUTCDay(),
  };
}

/** How far `zone`'s wall clock is ahead of UTC at `instantMs`, in ms (Denver in July: -6h). */
export function zoneOffsetMs(instantMs: number, zone: string): number {
  const p = utcToZonedParts(new Date(instantMs), zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Seconds precision on both sides: the formatter drops milliseconds.
  return wall - Math.floor(instantMs / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A wall-clock time on a calendar date in `zone` → the absolute instant.
 *
 * `minuteOfDay` runs 0..1440; 1440 is the following midnight, which is what
 * the end of an "until midnight" availability window means.
 *
 * THE TWO HARD DAYS, and what this returns on each (the same answers Temporal's
 * "compatible" disambiguation gives, so nobody has to learn a third rule):
 *
 *   - Spring forward (a wall time that never happens — 02:30 in Denver on
 *     2026-03-08): moved forward by the gap, to 03:30 MDT. A slot grid laid in
 *     instants (see generateSlots) never asks for one of these anyway; this is
 *     for a host whose window starts inside the gap.
 *   - Fall back (a wall time that happens twice — 01:30 in Denver on
 *     2026-11-01): the EARLIER of the two, 01:30 MDT. Consistent across zones
 *     east and west of UTC, which the usual one-guess-two-correction trick is
 *     not: it lands on the first occurrence in Denver and the second in London.
 *
 * Method: every offset the zone uses within a day either side of the guess is
 * a candidate; a candidate is real if converting back with it reproduces
 * itself. Several real → earliest instant. None real → the gap case, resolved
 * with the offset in force BEFORE the transition.
 */
export function zonedWallClockToUtc(date: DateString, minuteOfDay: number, zone: string): Date {
  const { year, month, day } = parseDate(date);
  const local = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0);
  const before = zoneOffsetMs(local - DAY_MS, zone);
  const candidates = new Set([before, zoneOffsetMs(local, zone), zoneOffsetMs(local + DAY_MS, zone)]);
  let best: number | null = null;
  for (const offset of candidates) {
    const instant = local - offset;
    if (zoneOffsetMs(instant, zone) === offset && (best === null || instant < best)) best = instant;
  }
  return new Date(best ?? local - before);
}

/**
 * The weekday of a calendar date (0 = Sunday), or of an instant as seen in
 * `zone`. A calendar date's weekday does not depend on any zone — 2026-03-08 is
 * a Sunday everywhere — so `zone` only matters when `date` is an instant: a
 * Tuesday 22:30 in Denver is already Wednesday in London.
 */
export function dayOfWeekIn(date: DateString | Date, zone: string): number {
  if (date instanceof Date) return utcToZonedParts(date, zone).dayOfWeek;
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `date` plus `n` calendar days. */
export function addDays(date: DateString, n: number): DateString {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10);
}

/** Calendar dates from `from` to `to` inclusive, guarded against an inverted or absurd range. */
export function eachDate(from: DateString, to: DateString, max = 400): DateString[] {
  const out: DateString[] = [];
  let cursor = from;
  while (cursor <= to && out.length < max) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** The instant `date` begins in `zone` — local midnight, as a UTC Date. */
export function startOfDayIn(date: DateString, zone: string): Date {
  return zonedWallClockToUtc(date, 0, zone);
}

/** The calendar date `instant` falls on in `zone`. */
export function dateIn(instant: Date, zone: string): DateString {
  return utcToZonedParts(instant, zone).date;
}
