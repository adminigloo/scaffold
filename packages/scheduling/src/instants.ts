import { timeToMinutes } from "./math.js";
import { dateIn, zonedWallClockToUtc, type DateString } from "./zone.js";

/**
 * Where a visit's wall clock meets real time. Pure.
 *
 * A visit is described twice, on purpose:
 *
 *   - as the business reads it: `scheduled_date` (a calendar date, stored as
 *     that date's UTC midnight — a LABEL) plus `start_time`/`end_time` as
 *     "HH:MM" text. The crew's day, the hours check and the calendar grid are
 *     built from these, and they never change when the clocks do.
 *   - as an instant: `starts_at`/`ends_at`, that wall clock read in the
 *     tenant's zone. Everything measured against "now" — notice, the change
 *     cutoff, reminders, expiry, "is it past" — reads these, so a 24-hour
 *     notice is 24 real hours on the weekend the clocks change.
 *
 * 0.3 had only the first and read it in UTC: for a business at UTC−7 the
 * 24-hour notice behaved like 17 or 31 hours, and "today" rolled over at
 * 5 pm.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A label Date (UTC midnight) for a calendar date. */
export function labelDate(date: DateString): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** The calendar date a label Date names ("YYYY-MM-DD"), read in UTC because a label is a UTC midnight. */
export function labelOf(date: Date): DateString {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString().slice(0, 10);
}

/**
 * A visit's start and end instants, from its calendar date and wall-clock
 * times in `timeZone`. "24:00" is minute 1440: the next local midnight.
 *
 * A wall time inside the spring-forward gap (02:30 in Denver on 2026-03-08)
 * resolves forward to 03:30 MDT, and one inside the fall-back hour (01:30 on
 * 2026-11-01) is the earlier of the two — booking's rules, from the shared
 * zone.ts. Crews rarely work at 2 am, but the rule is fixed, not undefined.
 */
export function visitInstants(
  date: DateString,
  startTime: string,
  endTime: string,
  timeZone: string,
): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: zonedWallClockToUtc(date, timeToMinutes(startTime), timeZone),
    endsAt: zonedWallClockToUtc(date, timeToMinutes(endTime), timeZone),
  };
}

/** The fields of a visit row the instants are read from. */
export interface InstantSource {
  scheduledDate: Date;
  startTime: string;
  endTime: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
}

/**
 * A row's own `starts_at`/`ends_at`, or — for a row written before 0.4 and
 * not yet backfilled — the same instants worked out from its wall clock in
 * `timeZone`. So nothing breaks between deploying 0.4 and running
 * `backfillVisitInstants`.
 */
export function instantsOf(row: InstantSource, timeZone: string): { startsAt: Date; endsAt: Date } {
  if (row.startsAt && row.endsAt) return { startsAt: row.startsAt, endsAt: row.endsAt };
  return visitInstants(labelOf(row.scheduledDate), row.startTime, row.endTime, timeZone);
}

/** Today's calendar date on the business's clock. At 20:00 in Denver it is still today, not UTC's tomorrow. */
export function todayIn(now: Date, timeZone: string): DateString {
  return dateIn(now, timeZone);
}

/** The earlier of two instants, ignoring a missing one (SQL's LEAST). */
export function earliest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
