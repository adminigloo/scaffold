/**
 * Date ranges, comparisons and zero-filled series — the arithmetic every
 * report leans on, kept in one tested place. Trailcards' versions had the
 * classic slips: a "7 day" preset spanning 8 days, a custom end day silently
 * excluded, a year-ago that was a flat 365 days; these are the fixed shapes.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far `zone` is ahead of UTC at the instant `at`, in ms (Denver in summer: -6h). */
function zoneOffsetMs(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The calendar day `at` falls on in `zone`, YYYY-MM-DD. An unknown zone reads as UTC. */
export function dayInZone(at: Date, zone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** `day` plus `n` calendar days. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/**
 * The instant a calendar day begins in `zone` — midnight local, as a UTC Date.
 * Two passes, so a day that starts just after a DST change lands on the
 * offset in force at ITS midnight, not the one a few hours earlier.
 */
export function startOfDayIn(day: string, zone = "UTC"): Date {
  const guess = new Date(`${day}T00:00:00Z`).getTime();
  try {
    const first = guess - zoneOffsetMs(new Date(guess), zone);
    return new Date(guess - zoneOffsetMs(new Date(first), zone));
  } catch {
    return new Date(guess);
  }
}

/**
 * The last `days` whole calendar days in `zone`, today included: exactly
 * `days` days, from local midnight to local midnight — so a "30 days" range
 * drawn in Denver is 30 Denver days, not 31 partial ones.
 */
export function lastDays(days: number, now: Date = new Date(), zone = "UTC"): DateRange {
  const today = dayInZone(now, zone);
  return { from: startOfDayIn(addDays(today, 1 - days), zone), to: startOfDayIn(addDays(today, 1), zone) };
}

/** The window of the same length immediately before `range` (half-open [from, to)). */
export function priorPeriod(range: DateRange): DateRange {
  const length = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - length), to: new Date(range.from.getTime()) };
}

/** null when there is nothing to compare against — a 0 → 5 jump is not "+∞%". */
export function deltaPct(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return ((current - prior) / prior) * 100;
}

/** Below this, a rate or a delta is noise; reports mark it rather than hide it. */
export const SMALL_SAMPLE = 30;

export interface Kpi {
  current: number;
  prior: number;
  deltaPct: number | null;
  smallSample: boolean;
}

export function kpi(current: number, prior: number): Kpi {
  return { current, prior, deltaPct: deltaPct(current, prior), smallSample: current < SMALL_SAMPLE };
}

/** Every UTC calendar day in [from, to), as YYYY-MM-DD. */
export function daysIn(range: DateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
  while (cursor.getTime() < range.to.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Dense series over the range: days the query returned nothing for read as zero, never as a gap. */
export function zeroFill<T extends { date: string }>(range: DateRange, rows: T[], empty: (date: string) => T): T[] {
  const byDay = new Map(rows.map((row) => [row.date, row]));
  return daysIn(range).map((date) => byDay.get(date) ?? empty(date));
}
