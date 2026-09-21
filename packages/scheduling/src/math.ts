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
  /** The job immediately before this slot, if any — the drive-time anchor. */
  previousJob: { lat: number | null; lng: number | null; address: string } | null;
}

/**
 * The open gaps in a day large enough to fit `requiredMinutes`, each aligned to
 * the start of its gap and carrying the immediately-preceding booking as
 * `previousJob` (null for the first slot of the day). One slot per gap — the
 * scorer, not a rolling grid, is what ranks them.
 */
export function findFreeSlots(
  windowStart: string,
  windowEnd: string,
  existingBookings: BookingWindow[],
  requiredMinutes: number,
): FreeSlot[] {
  const sorted = [...existingBookings].sort((a, b) => a.start.localeCompare(b.start));
  const slots: FreeSlot[] = [];
  let currentTime = windowStart;
  let previousJob: FreeSlot["previousJob"] = null;

  for (const booking of sorted) {
    const gap = timeToMinutes(booking.start) - timeToMinutes(currentTime);
    if (gap >= requiredMinutes) {
      slots.push({
        startTime: currentTime,
        endTime: minutesToTime(timeToMinutes(currentTime) + requiredMinutes),
        previousJob,
      });
    }
    if (timeToMinutes(booking.end) > timeToMinutes(currentTime)) {
      currentTime = booking.end;
      previousJob = { lat: booking.lat, lng: booking.lng, address: booking.address };
    }
  }

  const finalGap = timeToMinutes(windowEnd) - timeToMinutes(currentTime);
  if (finalGap >= requiredMinutes) {
    slots.push({
      startTime: currentTime,
      endTime: minutesToTime(timeToMinutes(currentTime) + requiredMinutes),
      previousJob,
    });
  }

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
}

/**
 * Rank an open slot. Base 100, then: a long drive from the previous job costs
 * (>45 min −40, >30 min −20), a short one earns (<15 min +10); a morning start
 * (+5), the preferred resource (+20), and a first job close to home base
 * (<20 min +15). Higher is better; the orchestrator sorts by this.
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

  return score;
}

/** A candidate slot after scoring, ready to sort. */
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
