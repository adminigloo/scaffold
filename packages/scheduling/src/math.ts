/**
 * The scheduling engine's pure math — no DB, no network, fully deterministic.
 * Ported from the SG Glass & Metal scheduler (a proven, unit-tested engine) and
 * generalized from "installers" to "resources" so it serves any mobile-service
 * business. The differentiator lives in `scoreSlot`: an open slot is worth more
 * when the drive from the previous job is short, so a day of visits clusters
 * instead of crisscrossing a metro area.
 */

const EARTH_RADIUS_MILES = 3959;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in miles between two lat/lng points. */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

/** "HH:MM" → minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** minutes since midnight → zero-padded "HH:MM". */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BookingWindow {
  /** "HH:MM" */
  start: string;
  /** "HH:MM" */
  end: string;
  lat: number | null;
  lng: number | null;
  address: string;
}

export interface FreeSlot {
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM" */
  endTime: string;
  /**
   * The job immediately before this slot, if any — the drive-time anchor.
   * `endTime` is when it finishes, so a caller can check there is time to drive
   * from it before `startTime`.
   */
  previousJob: { lat: number | null; lng: number | null; address: string; endTime: string } | null;
  /**
   * The job that closes the gap this slot sits in, if any — the other end of
   * the drive buffer (there must be time to get there after `endTime`).
   */
  nextJob: { lat: number | null; lng: number | null; address: string; startTime: string } | null;
  /** True for the first start in its gap: right after the previous job, or the day's first. */
  isGapStart: boolean;
}

/** The default grid between offered start times, in minutes. */
export const DEFAULT_SLOT_STEP_MINUTES = 30;

/**
 * Every start inside one gap. The gap's own start always comes first (it packs
 * the day — right after the previous job, or first thing in the morning); after
 * it, starts fall on the WINDOW's grid (`windowStart + k × step`), so a gap
 * opening at 10:45 offers 10:45, 11:00, 11:30… rather than 10:45, 11:15,
 * 11:45 — times a customer reads as a schedule rather than as noise.
 */
function startsInGap(
  windowStartMin: number,
  gapStartMin: number,
  gapEndMin: number,
  requiredMinutes: number,
  stepMinutes: number,
): number[] {
  if (gapEndMin - gapStartMin < requiredMinutes) return [];
  const starts = [gapStartMin];
  // A step that is not a positive finite number means one start per gap —
  // `Infinity` gets 0.2's behaviour back for a caller that wants it.
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0) return starts;
  const stepsIn = Math.floor((gapStartMin - windowStartMin) / stepMinutes) + 1;
  for (let t = windowStartMin + stepsIn * stepMinutes; t + requiredMinutes <= gapEndMin; t += stepMinutes) {
    starts.push(t);
  }
  return starts;
}

/**
 * Every start in a day that fits `requiredMinutes` between the existing
 * bookings, on a `stepMinutes` grid (default 30).
 *
 * A GRID, NOT ONE START PER GAP. 0.2 offered only the first minute of each gap,
 * so an empty day offered 08:00 and nothing else, and a customer who could only
 * do afternoons could never book online. The gap start is still offered first
 * and flagged `isGapStart`, which the scorer rewards — packing a day tightly is
 * still the preference, it's just no longer the only offer.
 *
 * Each start carries the booking before its gap (`previousJob`, null for the
 * day's first gap) and the booking that closes it (`nextJob`, null for the
 * last), which is what a drive-time score and a drive-buffer check need. A gap
 * never runs past `windowEnd`, even when the next booking starts later (a staff
 * booking outside the hours): the window is the crew's working day, whatever
 * else is on the calendar. 0.2 offered only the gap's first minute, so it never
 * mattered there; with a grid it would have offered times after closing.
 */
export function findFreeSlots(
  windowStart: string,
  windowEnd: string,
  existingBookings: BookingWindow[],
  requiredMinutes: number,
  stepMinutes: number = DEFAULT_SLOT_STEP_MINUTES,
): FreeSlot[] {
  const sorted = [...existingBookings].sort((a, b) => a.start.localeCompare(b.start));
  const slots: FreeSlot[] = [];
  const windowStartMin = timeToMinutes(windowStart);
  const windowEndMin = timeToMinutes(windowEnd);
  let currentTime = windowStart;
  let previousJob: FreeSlot["previousJob"] = null;

  const offerGap = (gapEndMin: number, nextJob: FreeSlot["nextJob"]): void => {
    const starts = startsInGap(
      windowStartMin,
      timeToMinutes(currentTime),
      Math.min(gapEndMin, windowEndMin),
      requiredMinutes,
      stepMinutes,
    );
    starts.forEach((start, i) => {
      slots.push({
        startTime: minutesToTime(start),
        endTime: minutesToTime(start + requiredMinutes),
        previousJob,
        nextJob,
        isGapStart: i === 0,
      });
    });
  };

  for (const booking of sorted) {
    offerGap(timeToMinutes(booking.start), {
      lat: booking.lat,
      lng: booking.lng,
      address: booking.address,
      startTime: booking.start,
    });
    if (timeToMinutes(booking.end) > timeToMinutes(currentTime)) {
      currentTime = booking.end;
      previousJob = { lat: booking.lat, lng: booking.lng, address: booking.address, endTime: booking.end };
    }
  }

  offerGap(windowEndMin, null);

  return slots;
}

export interface ScoreSlotInput {
  /** Drive minutes from the previous job, or null if this is the day's first job. */
  driveMinutesFromPrevious: number | null;
  /** Drive minutes from the resource's home base — pass only for a first job with a known base. */
  homeBaseDriveMinutes: number | null;
  /** The slot's start, "HH:MM". */
  startTime: string;
  /** Whether this resource was the customer's preferred one. */
  isPreferredResource: boolean;
  /** The first start in its gap — right after the previous job, or the day's first. */
  isGapStart?: boolean;
}

/**
 * Rank an open slot. Base 100, then: a long drive from the previous job costs
 * (>45 min −40, >30 min −20), a short one earns (<15 min +10); a morning start
 * (+5), the preferred resource (+20), a first job close to home base
 * (<20 min +15), and a start at the very beginning of its gap (+5) — the bias
 * that used to be the ONLY offer, kept as a preference now that the rest of the
 * gap is offered too. Higher is better; the orchestrator sorts by this.
 */
export function scoreSlot(input: ScoreSlotInput): number {
  let score = 100;

  if (input.driveMinutesFromPrevious !== null) {
    if (input.driveMinutesFromPrevious > 45) score -= 40;
    else if (input.driveMinutesFromPrevious > 30) score -= 20;
    else if (input.driveMinutesFromPrevious < 15) score += 10;
  }

  const startHour = Number(input.startTime.split(":")[0]);
  if (startHour < 10) score += 5;

  if (input.isPreferredResource) score += 20;

  if (input.homeBaseDriveMinutes !== null && input.homeBaseDriveMinutes < 20) score += 15;

  if (input.isGapStart) score += 5;

  return score;
}

/**
 * A candidate slot after scoring, ready to sort. STAFF-ONLY: it names the crew
 * and carries the previous job's street address (the drive-time anchor), which
 * is another customer's home. A public route returns `PublicSlot`s from
 * `findPublicSlots` instead — never one of these.
 */
export interface ScoredSlot {
  date: string;
  startTime: string;
  endTime: string;
  resourceId: string;
  resourceName: string;
  driveMinutesFromPrevious: number | null;
  previousJobAddress: string | null;
  score: number;
}

/** Best first, ties broken by earliest date — the order slots are offered in. */
export function sortScoredSlots(slots: ScoredSlot[]): ScoredSlot[] {
  return [...slots].sort((a, b) => (b.score - a.score) || a.date.localeCompare(b.date));
}

/** Minutes of overlap logic: do [aStart,aEnd) and [bStart,bEnd) intersect? */
export function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}
