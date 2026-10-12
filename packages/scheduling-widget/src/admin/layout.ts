import { addDays, dayOfWeek, minutesOf } from "../time.js";
import type { DateString, TimeOfDay } from "../types.js";

/**
 * The calendar's geometry, pure — so "a drag of 37 pixels on a 30-minute grid
 * lands on 10:00" and "two overlapping requests sit side by side" are unit
 * tests, not click paths.
 *
 * Every position is from the BUSINESS's wall clock (the wire's `startTime` /
 * `endTime`, already in its zone): a visit at 9:00 is drawn at 9:00 whatever
 * zone the browser is in, because that is when the crew knocks.
 */

/** Pixels per minute in the day view: a 30-minute visit is 48px tall, over the 44px touch target. */
export const PX_PER_MINUTE = 1.6;

/** The smallest a block is drawn, so even a 15-minute visit is a 44px target. */
export const MIN_BLOCK_PX = 44;

export interface DayRange {
  /** Minutes since midnight at the top of the grid. */
  startMinute: number;
  /** Minutes since midnight at the bottom of the grid. */
  endMinute: number;
}

/**
 * The hours a day view draws (contract 8.5): from the earliest window start
 * (or 07:00 when no crew works that day) to the latest window end (or 19:00),
 * widened to include any visit outside it, and rounded out to whole hours.
 */
export function dayRange(
  windows: ReadonlyArray<{ start: TimeOfDay; end: TimeOfDay }>,
  visits: ReadonlyArray<{ startTime: TimeOfDay; endTime: TimeOfDay }>,
): DayRange {
  const starts = windows.map((w) => minutesOf(w.start)).filter(Number.isFinite);
  const ends = windows.map((w) => minutesOf(w.end)).filter(Number.isFinite);
  let start = starts.length > 0 ? Math.min(...starts) : 7 * 60;
  let end = ends.length > 0 ? Math.max(...ends) : 19 * 60;
  for (const visit of visits) {
    const a = minutesOf(visit.startTime);
    const b = minutesOf(visit.endTime);
    if (Number.isFinite(a)) start = Math.min(start, a);
    if (Number.isFinite(b)) end = Math.max(end, b);
  }
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(1440, Math.ceil(end / 60) * 60);
  if (end <= start) end = Math.min(1440, start + 60);
  return { startMinute: start, endMinute: end };
}

/** Where a visit's block sits in a day column: `top` and `height` in pixels. */
export function positionVisit(
  visit: { startTime: TimeOfDay; endTime: TimeOfDay },
  range: DayRange,
  pxPerMinute = PX_PER_MINUTE,
  minHeight = MIN_BLOCK_PX,
): { top: number; height: number } {
  const start = Math.max(minutesOf(visit.startTime), range.startMinute);
  const end = Math.min(minutesOf(visit.endTime), range.endMinute);
  const top = (start - range.startMinute) * pxPerMinute;
  const height = Math.max((end - start) * pxPerMinute, minHeight);
  return { top, height };
}

/**
 * `minutes` on the `step` grid (nearest), clamped to [min, max]. With the
 * defaults, a drop can't start before midnight or run past the next one.
 */
export function snapMinutes(minutes: number, step: number, bounds: { min?: number; max?: number } = {}): number {
  const grid = step > 0 ? step : 5;
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1440;
  const snapped = Math.round(minutes / grid) * grid;
  // Clamp to the grid inside the bounds, so a clamped start is still a grid time.
  const lo = Math.ceil(min / grid) * grid;
  const hi = Math.floor(max / grid) * grid;
  return Math.max(lo, Math.min(hi, snapped));
}

/**
 * Where a day-view drag lands: the original start moved by the pointer's
 * vertical travel, snapped to the grid, and clamped so the whole visit stays
 * between 00:00 and 24:00.
 */
export function dragStart(
  original: { startTime: TimeOfDay; endTime: TimeOfDay },
  deltaPx: number,
  step: number,
  pxPerMinute = PX_PER_MINUTE,
): TimeOfDay {
  const start = minutesOf(original.startTime);
  const duration = Math.max(0, minutesOf(original.endTime) - start);
  const minutes = snapMinutes(start + deltaPx / pxPerMinute, step, { min: 0, max: 1440 - duration });
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The end that keeps a visit's length when its start moves. */
export function shiftEnd(original: { startTime: TimeOfDay; endTime: TimeOfDay }, newStart: TimeOfDay): TimeOfDay {
  const duration = minutesOf(original.endTime) - minutesOf(original.startTime);
  const end = Math.min(1440, minutesOf(newStart) + Math.max(0, duration));
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

export interface LaneItem {
  id: string;
  start: number;
  end: number;
}

/**
 * Side-by-side lanes for blocks that overlap in one column (two requests for
 * the same hour, say): each overlapping cluster is split into as many lanes as
 * it needs at its busiest, and every block in the cluster takes that width.
 */
export function layoutLanes(items: readonly LaneItem[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: Array<{ id: string; lane: number }> = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const member of cluster) out.set(member.id, { lane: member.lane, lanes });
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (item.start >= clusterEnd && cluster.length > 0) close();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    cluster.push({ id: item.id, lane });
    clusterEnd = Math.max(clusterEnd === -Infinity ? item.end : clusterEnd, item.end);
  }
  if (cluster.length > 0) close();
  return out;
}

/**
 * The seven dates of the week holding `date`, starting on `weekStartsOn`
 * (1 = Monday, the default: a crew's working week; 0 = Sunday).
 * CONTRACT: 8.5 doesn't say which day a week starts; Monday reads as a
 * crew's working week, with the weekend together at the end.
 */
export function weekDates(date: DateString, weekStartsOn: 0 | 1 = 1): DateString[] {
  const offset = (dayOfWeek(date) - weekStartsOn + 7) % 7;
  const first = addDays(date, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/** The hour lines a day column draws: every whole hour inside the range. */
export function hourMarks(range: DayRange): number[] {
  const out: number[] = [];
  for (let m = Math.ceil(range.startMinute / 60) * 60; m <= range.endMinute; m += 60) out.push(m);
  return out;
}
