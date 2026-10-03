/**
 * The slot engine — pure. No database, no I/O, and `now` is always an
 * argument, never something this module reads. Every rule a prospect can feel
 * ("why can't I book 9:00?") lives here, testable in isolation; the services
 * only load rows and hand them in.
 *
 * TWO FRAMES, NEVER MIXED. A host describes their week in wall-clock minutes
 * in their OWN zone (weekly windows, dated exceptions) — that is the frame
 * `resolveWindows` works in. Everything after that — the grid, buffers, busy
 * intervals, notice, horizon — is absolute instants. Squire compared busy
 * blocks as minutes-of-day against windows, which is exactly right until a
 * meeting crosses midnight or a DST change, and then it is an hour wrong.
 *
 * Ported concepts (Squire src/lib/demoScheduling.ts): the step measured from
 * the window start, part-day blocks cut out of hours, "empty means empty" (no
 * implicit Mon–Fri fallback for an unconfigured host), notice and horizon
 * compared on instants, fair host assignment, and Squire's test-log D17 rule
 * for buffers: where two calls meet, the clear time between them is the
 * LARGER of the earlier call's after-buffer and the later call's
 * before-buffer, never the sum (see `generateSlots`). Not ported: dayjs and
 * the HH:MM-string arithmetic.
 */

import {
  addDays,
  dateIn,
  eachDate,
  startOfDayIn,
  zonedWallClockToUtc,
  type DateString,
} from "./zone.js";

/** The grid a host types availability on. Windows and exceptions are validated against it. */
export const AVAILABILITY_STEP_MINUTES = 15;

/** How long a hold keeps a slot while the prospect fills in the form. */
export const HOLD_MINUTES = 10;

/** `[startMinute, endMinute)` on one date's wall clock, 0..1440. */
export type MinuteRange = readonly [startMinute: number, endMinute: number];

export interface WeeklyWindow {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export type ExceptionKind = "off" | "hours" | "block";

export interface DateException {
  date: DateString;
  kind: ExceptionKind;
  /** Null for "off". */
  startMinute: number | null;
  endMinute: number | null;
}

/** A tenant-wide holiday: a date string, or a row that carries one. */
export type Blackout = DateString | { date: DateString };

export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Something already occupying the host's time: the occupant's OWN interval
 * (a booked call's meeting time, never pre-padded), plus the clear time that
 * occupant asks for on each side — its own type's buffers. Omitted means it
 * asks for none, which is right for an external calendar event, whose needs
 * are unknown; the candidate's own buffers still apply against it.
 */
export interface BusyInterval extends Interval {
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
}

/** Merge overlapping or touching ranges, so 09–12 and 11–15 never offer the overlap twice. */
export function mergeRanges(ranges: readonly MinuteRange[]): MinuteRange[] {
  const sorted = ranges
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [start, end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Cut `blocks` out of `ranges` — "dentist 12:00–14:00 on an otherwise normal Wednesday". */
export function subtractRanges(
  ranges: readonly MinuteRange[],
  blocks: readonly MinuteRange[],
): MinuteRange[] {
  let current = mergeRanges(ranges).map(([s, e]) => [s, e] as [number, number]);
  for (const [blockStart, blockEnd] of blocks) {
    if (blockEnd <= blockStart) continue;
    const next: [number, number][] = [];
    for (const [start, end] of current) {
      if (blockEnd <= start || blockStart >= end) {
        next.push([start, end]);
        continue;
      }
      if (blockStart > start) next.push([start, blockStart]);
      if (blockEnd < end) next.push([blockEnd, end]);
    }
    current = next;
  }
  return current.filter(([start, end]) => end > start);
}

function blackoutDate(blackout: Blackout): DateString {
  return typeof blackout === "string" ? blackout : blackout.date;
}

/**
 * A host's bookable wall-clock windows on one of THEIR calendar dates.
 *
 * The precedence is the feature, and it is printed in this order wherever a
 * host edits availability, because it is invisible otherwise:
 *
 *   0. A tenant blackout (holiday)         → nothing.
 *   1. Any 'off' exception for the date    → nothing. Nothing else is consulted.
 *   2. Any 'hours' exceptions              → REPLACE the weekly windows.
 *   3. Otherwise                           → the weekly windows for that weekday.
 *   4. 'block' exceptions                  → subtracted from whatever 2 or 3 gave.
 *
 * And no step 5: a host who has entered nothing is unbookable. gs-glass fell
 * back to 08:00–17:00, which silently made an unconfigured host bookable.
 */
export function resolveWindows(
  date: DateString,
  weekly: readonly WeeklyWindow[],
  exceptions: readonly DateException[],
  blackouts: readonly Blackout[],
): MinuteRange[] {
  if (blackouts.some((blackout) => blackoutDate(blackout) === date)) return [];
  const forDate = exceptions.filter((exception) => exception.date === date);
  if (forDate.some((exception) => exception.kind === "off")) return [];

  const rangeOf = (row: { startMinute: number | null; endMinute: number | null }): MinuteRange | null =>
    row.startMinute === null || row.endMinute === null ? null : [row.startMinute, row.endMinute];

  const hours = forDate
    .filter((exception) => exception.kind === "hours")
    .map(rangeOf)
    .filter((range): range is MinuteRange => range !== null);
  // The weekday of a calendar date is the same in every zone, so no zone here.
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const base: MinuteRange[] =
    hours.length > 0
      ? hours
      : weekly
          .filter((window) => window.dayOfWeek === dayOfWeek)
          .map((window) => [window.startMinute, window.endMinute] as const);
  if (base.length === 0) return [];

  const blocks = forDate
    .filter((exception) => exception.kind === "block")
    .map(rangeOf)
    .filter((range): range is MinuteRange => range !== null);
  return subtractRanges(base, blocks);
}

/** `resolveWindows` for every date in a list, as the map `generateSlots` reads. */
export function windowsByDateFor(
  dates: readonly DateString[],
  weekly: readonly WeeklyWindow[],
  exceptions: readonly DateException[],
  blackouts: readonly Blackout[],
): Map<DateString, MinuteRange[]> {
  const out = new Map<DateString, MinuteRange[]>();
  for (const date of dates) out.set(date, resolveWindows(date, weekly, exceptions, blackouts));
  return out;
}

/** The booking type's scheduling rules — the subset of a type row the engine reads. */
export interface SlotRules {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Cadence of offered starts, measured from each window's start. */
  stepMinutes: number;
  /** No start sooner than this after `now`. */
  minNoticeMinutes: number;
  /** Whole calendar days in the host's zone, today included. */
  horizonDays: number;
  /** Live bookings of this type per host per day; null = uncapped. */
  maxPerDay: number | null;
}

export interface GenerateSlotsInput {
  host: { id: string; timezone: string };
  type: SlotRules;
  /** Wall-clock windows per host-zone date (from `windowsByDateFor`). A missing date has none. */
  windowsByDate: ReadonlyMap<DateString, readonly MinuteRange[]>;
  /**
   * Absolute busy intervals, UNPADDED: each carries its occupant's own
   * buffers as fields instead, because the gap rule needs both parties'
   * numbers separately (the larger wins). A plain `Interval` — an external
   * calendar event — asks for no buffer of its own.
   */
  busy: readonly BusyInterval[];
  /** Live bookings of this type per host-zone date, for `maxPerDay`. */
  bookedCountByDate?: ReadonlyMap<DateString, number>;
  now: Date;
  /** Inclusive lower bound on a start. */
  from: Date;
  /** Exclusive upper bound on a start. */
  to: Date;
}

export interface Slot {
  hostId: string;
  start: Date;
  end: Date;
}

/** The first instant past the horizon: midnight, host zone, `horizonDays` days after today. */
export function horizonEnd(now: Date, timezone: string, horizonDays: number): Date {
  return startOfDayIn(addDays(dateIn(now, timezone), Math.max(0, horizonDays)), timezone);
}

/**
 * Every bookable start for one host.
 *
 * A start is offered when ALL of these hold:
 *
 *   - it sits on the grid: window start + k × step, in real minutes. The step
 *     is measured from the WINDOW start, not the top of the hour, so a day
 *     that opens at 08:15 offers 08:15, 08:45 … which is what the host meant.
 *     Laying the grid in instants also makes the DST days right for free: a
 *     00:00–05:00 window on spring-forward day is four real hours, and on
 *     fall-back day six, and every offered start is a distinct real instant.
 *   - the MEETING itself, [start, start + duration], lies inside the window.
 *     Buffers do not have to: they are clear time between calls, not hours
 *     the host promised to be at a desk, so a 09:00–17:00 day with 15-minute
 *     buffers still offers 09:00 and 16:30;
 *   - the meeting keeps clear of every busy interval by the gap BOTH parties
 *     ask for (Squire's test-log D17). On the side where the candidate
 *     follows an occupant, the gap must be at least the larger of the
 *     candidate's before-buffer and the occupant's after-buffer; on the side
 *     where it precedes one, the larger of the candidate's after-buffer and
 *     the occupant's before-buffer. They do not add: fifteen minutes of
 *     lead-in and thirty of write-up meeting at one gap is thirty minutes of
 *     clear time, not forty-five. Touching is fine once that gap is met;
 *     overlapping never is. Buffers pad conflicts across a window edge too —
 *     a calendar event ending at 08:55 still keeps a 15-minute lead-in off
 *     a 09:00 start;
 *   - start ≥ max(from, now + minNotice), start < to, and start falls on a
 *     host-zone date inside the horizon;
 *   - the date has fewer than `maxPerDay` live bookings of this type.
 *
 * Returned sorted by start.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { host, type, now } = input;
  const zone = host.timezone;
  const minute = 60_000;
  const duration = type.durationMinutes * minute;
  const before = Math.max(0, type.bufferBeforeMinutes) * minute;
  const after = Math.max(0, type.bufferAfterMinutes) * minute;
  const step = type.stepMinutes * minute;
  if (duration <= 0 || step <= 0) return [];

  const earliest = Math.max(input.from.getTime(), now.getTime() + Math.max(0, type.minNoticeMinutes) * minute);
  const latest = Math.min(input.to.getTime(), horizonEnd(now, zone, type.horizonDays).getTime());
  if (latest <= earliest) return [];

  const busy = input.busy
    .map((interval) => ({
      start: interval.start.getTime(),
      end: interval.end.getTime(),
      before: Math.max(0, interval.bufferBeforeMinutes ?? 0) * minute,
      after: Math.max(0, interval.bufferAfterMinutes ?? 0) * minute,
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  /** Does the meeting [start, end) come closer to any occupant than the two of them allow? */
  const collides = (start: number, end: number): boolean =>
    busy.some((occupant) => {
      // Candidate AFTER the occupant: its lead-in vs the occupant's write-up.
      const clearBefore = Math.max(before, occupant.after);
      // Candidate BEFORE the occupant: its write-up vs the occupant's lead-in.
      const clearAfter = Math.max(after, occupant.before);
      return start - clearBefore < occupant.end && end + clearAfter > occupant.start;
    });

  const slots: Slot[] = [];
  const seen = new Set<number>();
  for (const date of eachDate(dateIn(new Date(earliest), zone), dateIn(new Date(latest - 1), zone))) {
    if (type.maxPerDay !== null && (input.bookedCountByDate?.get(date) ?? 0) >= type.maxPerDay) continue;
    for (const [startMinute, endMinute] of input.windowsByDate.get(date) ?? []) {
      const windowStart = zonedWallClockToUtc(date, startMinute, zone).getTime();
      const windowEnd = zonedWallClockToUtc(date, endMinute, zone).getTime();
      for (let start = windowStart; start + duration <= windowEnd; start += step) {
        if (start < earliest || start >= latest) continue;
        if (collides(start, start + duration)) continue;
        if (seen.has(start)) continue;
        seen.add(start);
        slots.push({ hostId: host.id, start: new Date(start), end: new Date(start + duration) });
      }
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * The union of several hosts' slots as distinct times — two hosts free at
 * 10:00 is ONE offer. The prospect picks a time, never a person; booking
 * decides who takes it.
 */
export function unionSlots(slots: readonly Slot[]): Array<{ start: Date; end: Date }> {
  const byStart = new Map<number, { start: Date; end: Date }>();
  for (const slot of slots) {
    if (!byStart.has(slot.start.getTime())) byStart.set(slot.start.getTime(), { start: slot.start, end: slot.end });
  }
  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface HostLoad {
  hostId: string;
  /** Live bookings in the next seven days. */
  upcoming: number;
}

/**
 * Which free host takes a booking: the fewest live bookings in the next seven
 * days, ties to the lowest id. A window rather than an all-time count, or a
 * host who joins later is "behind" forever and gets everything; a
 * deterministic tie-break, so the choice is reproducible in a test and in a
 * bug report. gs-glass took `availableInstallers[0]` — whoever the query
 * returned first took every booking.
 */
export function pickHost(candidates: readonly HostLoad[]): string | null {
  let best: HostLoad | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.upcoming < best.upcoming ||
      (candidate.upcoming === best.upcoming && candidate.hostId < best.hostId)
    ) {
      best = candidate;
    }
  }
  return best?.hostId ?? null;
}
