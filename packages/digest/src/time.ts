/**
 * Each person's clock (digest 0.1), from `Intl` alone: no date library, no
 * offsets kept by hand. Days are local calendar days written "YYYY-MM-DD";
 * instants are `Date`s.
 *
 * THE DELIVERY WINDOW. A person's digest for day D may go from D's delivery
 * moment (their hour, in their zone, on D) until the next day's delivery
 * moment. The windows are back to back and never overlap, so:
 *
 *   - a cron that runs every hour sends each person's digest within the hour
 *     after their hour;
 *   - a cron that runs once a day (Vercel Hobby) still reaches everybody
 *     once a day, in whichever window that run falls — late for some zones,
 *     never twice;
 *   - after an outage only the window open NOW is sent, never a backlog.
 *
 * DAYLIGHT SAVING. An hour that doesn't exist that day (2 AM when the
 * clocks go forward) is the first moment after the jump (3 AM); an hour that
 * happens twice (1 AM when they go back) is the first of the two.
 */

export class InvalidTimeZoneError extends Error {
  readonly name = "InvalidTimeZoneError";
  constructor(zone: unknown) {
    super(`${JSON.stringify(zone)} isn't a time zone: use an IANA name such as "America/Chicago".`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      calendar: "gregory",
      numberingSystem: "latn",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** Is this an IANA zone this runtime knows? */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    wallFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The zone, or throws InvalidTimeZoneError. */
export function assertTimeZone(zone: unknown): string {
  if (!isTimeZone(zone)) throw new InvalidTimeZoneError(zone);
  return zone;
}

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallOf(at: Date, zone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of wallFormatter(zone).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    // Some engines write midnight as 24 even with h23.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** The wall clock as if it were UTC, in milliseconds: what a zone's offset is measured against. */
function wallMillis(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** The zone's offset from UTC at an instant, in minutes. */
function offsetMinutes(at: Date, zone: string): number {
  const whole = new Date(Math.floor(at.getTime() / 1000) * 1000);
  return Math.round((wallMillis(wallOf(whole, zone)) - whole.getTime()) / 60_000);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is this a real calendar day, written "YYYY-MM-DD"? */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDay(day: string): { year: number; month: number; day: number } {
  if (!isDay(day)) throw new RangeError(`"${day}" isn't a day written YYYY-MM-DD`);
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return { year, month, day: date };
}

/** The local calendar day an instant falls on in a zone. */
export function localDay(at: Date, zone: string): string {
  const wall = wallOf(at, assertTimeZone(zone));
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** A day plus (or minus) whole days. */
export function addDays(day: string, days: number): string {
  const { year, month, day: date } = parseDay(day);
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return next.toISOString().slice(0, 10);
}

/**
 * The instant a local day and hour begins in a zone: `hour` o'clock on
 * `day`. In a gap (the clocks jumped over it), the first moment after the
 * jump; when it happens twice, the first.
 */
export function zonedInstant(day: string, hour: number, zone: string): Date {
  assertTimeZone(zone);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`hour must be a whole number from 0 to 23 (got ${hour})`);
  const { year, month, day: date } = parseDay(day);
  const target = Date.UTC(year, month - 1, date, hour, 0, 0);
  // Two candidates, from the offsets either side of the target: one of them
  // is the answer whenever the wall time exists.
  const before = target - offsetMinutes(new Date(target - 36 * 3_600_000), zone) * 60_000;
  const after = target - offsetMinutes(new Date(target + 36 * 3_600_000), zone) * 60_000;
  const first = target - offsetMinutes(new Date(target), zone) * 60_000;
  const candidates = [...new Set([first, before, after])].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (wallMillis(wallOf(new Date(candidate), zone)) === target) return new Date(candidate);
  }
  // A gap: the first instant whose wall clock is at or past the target,
  // between the earliest and the latest candidate, to the second.
  let low = candidates[0]!;
  let high = candidates[candidates.length - 1]!;
  if (wallMillis(wallOf(new Date(high), zone)) < target) high = target + 14 * 3_600_000;
  while (high - low > 1_000) {
    const middle = low + Math.floor((high - low) / 2);
    if (wallMillis(wallOf(new Date(middle), zone)) >= target) high = middle;
    else low = middle;
  }
  return new Date(Math.ceil(high / 1_000) * 1_000);
}

/** The window a person's digest may go in, at `now`: the day it is for, when it opened and when it closes. */
export interface DeliveryWindow {
  /** The local day the digest is for. */
  readonly day: string;
  /** The person's hour on that day. */
  readonly opensAt: Date;
  /** The person's hour on the next day: the next window. */
  readonly closesAt: Date;
}

/** Which day's window is open at `now`, for a person in `zone` whose hour is `hour`. */
export function deliveryWindow(now: Date, zone: string, hour: number): DeliveryWindow {
  const today = localDay(now, zone);
  const opensToday = zonedInstant(today, hour, zone);
  const day = now.getTime() >= opensToday.getTime() ? today : addDays(today, -1);
  const opensAt = day === today ? opensToday : zonedInstant(day, hour, zone);
  return { day, opensAt, closesAt: zonedInstant(addDays(day, 1), hour, zone) };
}

/** A local day, as a section sees it. */
export interface DigestDay {
  /** "2026-10-21". */
  readonly date: string;
  readonly timeZone: string;
  /** Local midnight that day, as an instant. */
  readonly start: Date;
  /** Local midnight the next day. */
  readonly end: Date;
  /** "Tuesday, October 21". */
  readonly label: string;
}

/** The day a digest is for, in the person's zone. */
export function digestDay(date: string, zone: string, locale = "en-US"): DigestDay {
  const start = zonedInstant(date, 0, zone);
  const end = zonedInstant(addDays(date, 1), 0, zone);
  const noon = zonedInstant(date, 12, zone);
  const label = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(noon);
  return Object.freeze({ date, timeZone: zone, start, end, label });
}

/** "7 AM", "12 PM", "11 PM". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}
