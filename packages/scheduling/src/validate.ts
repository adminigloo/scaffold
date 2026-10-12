import { listAvailability, resolveDayWindows } from "./availability.js";
import { activeBookingsOn, getResourceRow } from "./internal.js";
import { createHaversineMapsProvider, type MapsProvider } from "./maps.js";
import { timeToMinutes, windowsOverlap } from "./math.js";
import type { SchedulingDb, StaffRefusalCode } from "./types.js";
import { clock12, crewWord, dayWords, range12, weekdaysWord } from "./words.js";

export interface ValidateBookingInput {
  tenantId: string;
  resourceId: string;
  /** The visit's calendar date, as a label Date (its UTC midnight). */
  date: Date;
  startTime: string;
  endTime: string;
  lat?: number | null;
  lng?: number | null;
  /** A visit to leave out of the overlap and cap checks — the one being moved or re-validated. */
  excludeBookingId?: string | null;
  /**
   * The clock, for "an overdue request holds no time". Default `new Date()`.
   * A pending visit whose deadline has passed is not in the way.
   */
  now?: Date;
}

export interface ValidateBookingResult {
  valid: boolean;
  reason?: string;
  /** Set when `valid` is false: which kind of refusal (see `BookingRefusalCode`). */
  code?: StaffRefusalCode;
  warnings: string[];
}

/** "8:00 AM – 12:00 PM and 1:00 PM – 5:00 PM": a crew's hours, the way an owner says them. */
function describeWindows(windows: Array<{ start: string; end: string }>): string {
  const parts = windows.map((w) => range12(w.start, w.end));
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Refuse a booking outside the resource's hours, on a removed resource, past
 * its daily cap, that overlaps an existing one, or that leaves too little time
 * to drive between jobs; warn when the buffer is tight. Read-only: to make the
 * answer hold until the write, call it inside the writer's transaction under
 * the resource lock, as every writer here does — with drive times looked up
 * before the lock, since this calls `maps.driveTime` once per neighbouring
 * visit.
 *
 * The visit must sit inside ONE of the day's windows: a visit spanning a
 * crew's lunch break is outside its hours, though both ends are inside some
 * window.
 *
 * The reasons are for staff, in an owner's words: the crew's name, the
 * business's 12-hour clock and the day ("Crew A doesn't work on Saturday,
 * November 7"; "Crew A already has a visit 10:00 AM – 12:00 PM"). A staff
 * screen shows them as they come, so "Resource is not available on this day"
 * and "18:00–19:00 is outside availability (08:00–17:00)" — which read as a
 * software error — are gone. The public request maps every refusal to one
 * generic message.
 */
export async function validateBookingSlot(
  db: SchedulingDb,
  input: ValidateBookingInput,
  maps: MapsProvider = createHaversineMapsProvider(),
): Promise<ValidateBookingResult> {
  const warnings: string[] = [];
  const startMinutes = timeToMinutes(input.startTime);
  const endMinutes = timeToMinutes(input.endTime);

  if (endMinutes <= startMinutes) {
    return {
      valid: false,
      code: "invalid_window",
      reason: `The visit has to end after it starts (${range12(input.startTime, input.endTime)})`,
      warnings,
    };
  }

  // AVAILABILITY FIRST. A slot outside the resource's working windows — 3am, a
  // day off, lunch — is not bookable no matter what else is free. The finders
  // never OFFER such a slot, but this function is the guard on the DIRECT
  // paths (a staff booking, a move, an un-cancel) where the times are
  // caller-supplied and must be checked.
  const resource = await getResourceRow(db, input.tenantId, input.resourceId);
  if (!resource) {
    return { valid: false, code: "resource_unavailable", reason: "That crew isn't on the schedule any more", warnings };
  }
  // A removed crew is off the schedule for staff too, not only for the
  // finders; otherwise its visits sit on a crew no list shows.
  if (!resource.isActive) {
    return { valid: false, code: "resource_unavailable", reason: `${crewWord(resource.name)} has been removed from the schedule`, warnings };
  }
  const availability = await listAvailability(db, input.tenantId, input.resourceId);
  const windows = resolveDayWindows(availability, resource, input.date);
  if (windows.length === 0) {
    return { valid: false, code: "outside_hours", reason: `${crewWord(resource.name)} doesn't work on ${dayWords(input.date)}`, warnings };
  }
  // In minutes, never as text: text is chronological only for well-formed
  // times, and this function is exported to hosts with their own inputs.
  const inside = windows.some((w) => startMinutes >= timeToMinutes(w.start) && endMinutes <= timeToMinutes(w.end));
  if (!inside) {
    return {
      valid: false,
      code: "outside_hours",
      reason: `${crewWord(resource.name)} works ${describeWindows(windows)} on ${weekdaysWord(input.date)}; ${range12(input.startTime, input.endTime)} is outside those hours`,
      warnings,
    };
  }

  const active = await activeBookingsOn(db, input.tenantId, input.resourceId, input.date, {
    excludeBookingId: input.excludeBookingId ?? null,
    now: input.now ?? new Date(),
  });

  // The crew's own cap. The finder stops offering a full day; the direct path
  // asks too, so one request can't be the seventh visit of six.
  if (active.length >= resource.maxJobsPerDay) {
    return {
      valid: false,
      code: "slot_unavailable",
      reason: `${crewWord(resource.name)} is fully booked that day (${resource.maxJobsPerDay} visit${resource.maxJobsPerDay === 1 ? "" : "s"})`,
      warnings,
    };
  }

  for (const b of active) {
    if (windowsOverlap(input.startTime, input.endTime, b.startTime, b.endTime)) {
      return {
        valid: false,
        code: "slot_unavailable",
        reason: `${crewWord(resource.name)} already has a visit ${range12(b.startTime, b.endTime)}`,
        warnings,
      };
    }
  }

  const job = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
  if (job) {
    for (const b of active) {
      if (b.lat == null || b.lng == null) continue;
      const other = { lat: b.lat, lng: b.lng };
      // Existing job ends before the new one starts: is there time to drive FROM
      // it (other -> job) into the new slot?
      if (timeToMinutes(b.endTime) <= startMinutes) {
        const dt = await maps.driveTime(other, job);
        if (!dt) continue;
        const buffer = startMinutes - timeToMinutes(b.endTime);
        if (dt.durationMinutes > buffer) {
          return {
            valid: false,
            code: "slot_unavailable",
            reason: `Not enough time to drive from the ${clock12(b.startTime)} visit (${dt.durationMinutes} min drive, ${buffer} min gap)`,
            warnings,
          };
        }
        if (dt.durationMinutes > buffer - 15) {
          warnings.push(`Tight schedule: a ${dt.durationMinutes} min drive from the ${clock12(b.startTime)} visit into a ${buffer} min gap`);
        }
      } else if (timeToMinutes(b.startTime) >= endMinutes) {
        // Existing job starts after the new one ends: is there time to drive TO
        // it (job -> other)? The direction is reversed, and with an asymmetric
        // provider (real traffic, one-way streets) that is a different number.
        const dt = await maps.driveTime(job, other);
        if (!dt) continue;
        const buffer = timeToMinutes(b.startTime) - endMinutes;
        if (dt.durationMinutes > buffer) {
          return {
            valid: false,
            code: "slot_unavailable",
            reason: `Not enough time to drive to the ${clock12(b.startTime)} visit afterwards`,
            warnings,
          };
        }
      }
    }
  }

  return { valid: true, warnings };
}
