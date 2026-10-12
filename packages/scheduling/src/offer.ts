import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveDayWindows } from "./availability.js";
import { emitEvents, type EventSpec } from "./events.js";
import { earliest, labelDate, labelOf, todayIn, visitInstants } from "./instants.js";
import {
  activeBookingsByDay,
  assertZone,
  availabilityFor,
  driveTimesBeforeLock,
  lockRequester,
  lockResource,
  lockSettingsShared,
  notOverdue,
  resourceDayKey,
  tryGeocode,
} from "./internal.js";
import { createHaversineMapsProvider, type DriveTime, type LatLng, type MapsProvider } from "./maps.js";
import {
  DEFAULT_SLOT_STEP_MINUTES,
  findFreeSlots,
  minutesToTime,
  scoreSlot,
  sortScoredSlots,
  timeToMinutes,
  type BookingWindow,
  type FreeSlot,
  type ScoredSlot,
} from "./math.js";
import { decodeSlotId, toPublicSlot, type PublicBookingPolicy, type ResolvedPublicBookingPolicy } from "./public.js";
import { listResources } from "./resources.js";
import { schedulingBookings } from "./schema.js";
import { findService } from "./services.js";
import { getSchedulingSettings, publicPolicyFor, type SchedulingSettings } from "./settings.js";
import { changeWindow } from "./snapshot.js";
import { publicLine, singleLine } from "./text.js";
import {
  BookingNotBookableError,
  invalidInput,
  SLOT_UNAVAILABLE,
  type AvailabilityRow,
  type BookingRow,
  type ResourceRow,
  type SchedulingDb,
  type SchedulingWriteOptions,
} from "./types.js";
import { validateBookingSlot } from "./validate.js";
import { insertManageToken, openVisitByToken } from "./visit-tokens.js";
import type { PublicSlot } from "./wire.js";
import { addDays, dateIn, eachDate, isValidDateString, type DateString } from "./zone.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// --- The finder: one resource, one day ---------------------------------------

interface ResourceDayInput {
  resource: ResourceRow;
  availability: AvailabilityRow[];
  /** The visits holding time on this resource's day, already read (see `activeBookingsByDay`). */
  active: BookingRow[];
  day: DateString;
  /** The tenant's zone: the day's wall clock is read in it. */
  timeZone: string;
  durationMinutes: number;
  stepMinutes: number;
  /**
   * Minutes kept clear before and after every visit, whatever its address —
   * the public offer's travel buffer. The staff finder passes none and checks
   * real drive times from `jobCoords` instead.
   */
  bufferMinutes?: number;
  jobCoords: LatLng | null;
  maps: MapsProvider;
  preferredResourceId?: string | null;
  /** Starts before this instant are not offered (the public notice; the staff finder's `notBefore`). */
  earliestStart?: Date | null;
  /** Starts after this instant are not offered (the public horizon). */
  latestStart?: Date | null;
}

/**
 * Every start one resource can take on one day, scored. The ONE place a slot
 * is decided: the staff finder, the public offer and the public request's
 * "is this still on offer?" re-check all call it, so what is offered and what
 * is accepted cannot drift apart. It reads nothing itself — the callers load a
 * whole range's visits and hours in one query each.
 *
 * Each of the day's windows is searched on its own grid and the results put
 * together, so a crew with a lunch break offers both halves of its day and
 * nothing that spans the break.
 *
 * The per-day cap is all-or-nothing: each start is an ALTERNATIVE, not
 * another job.
 *
 * Notice and horizon are compared on INSTANTS — the start's wall clock read in
 * the tenant's zone — so "24 hours' notice" is 24 real hours on the weekend
 * the clocks change.
 *
 * With job coordinates, a start the crew can't drive to in time (from the job
 * before its gap) or can't leave in time (for the job after) is not offered —
 * the same buffer `validateBookingSlot` refuses, checked once per gap.
 */
async function slotsForResourceDay(input: ResourceDayInput): Promise<ScoredSlot[]> {
  const { resource, jobCoords, maps } = input;
  const windows = resolveDayWindows(input.availability, resource, input.day);
  if (windows.length === 0) return [];
  if (input.active.length >= resource.maxJobsPerDay) return [];

  const buffer = input.bufferMinutes ?? 0;
  const busy: BookingWindow[] = input.active.map((b) => ({
    start: minutesToTime(Math.max(0, timeToMinutes(b.startTime) - buffer)),
    end: minutesToTime(Math.min(24 * 60, timeToMinutes(b.endTime) + buffer)),
    lat: b.lat,
    lng: b.lng,
    address: b.address ?? "",
  }));
  const free = windows.flatMap((w) =>
    findFreeSlots(w.start, w.end, busy, input.durationMinutes, input.stepMinutes),
  );

  // One drive lookup per gap end, not per start: every start in a gap shares
  // the same previous and next job objects.
  const fromPrevious = new Map<NonNullable<FreeSlot["previousJob"]>, Promise<DriveTime | null>>();
  const toNext = new Map<NonNullable<FreeSlot["nextJob"]>, Promise<DriveTime | null>>();
  let fromHomeBase: Promise<DriveTime | null> | null = null;
  const drive = (origin: LatLng, dest: LatLng): Promise<DriveTime | null> =>
    maps.driveTime(origin, dest).catch(() => null);

  const scored: ScoredSlot[] = [];
  for (const slot of free) {
    if (input.earliestStart || input.latestStart) {
      const { startsAt } = visitInstants(input.day, slot.startTime, slot.endTime, input.timeZone);
      if (input.earliestStart && startsAt.getTime() < input.earliestStart.getTime()) continue;
      if (input.latestStart && startsAt.getTime() > input.latestStart.getTime()) continue;
    }

    let driveMinutes: number | null = null;
    let homeBaseDrive: number | null = null;
    if (jobCoords) {
      const prev = slot.previousJob;
      if (prev && prev.lat != null && prev.lng != null) {
        if (!fromPrevious.has(prev)) fromPrevious.set(prev, drive({ lat: prev.lat, lng: prev.lng }, jobCoords));
        driveMinutes = (await fromPrevious.get(prev))?.durationMinutes ?? null;
        if (driveMinutes !== null && timeToMinutes(slot.startTime) - timeToMinutes(prev.endTime) < driveMinutes) {
          continue;
        }
      } else if (!prev && resource.homeBaseLat != null && resource.homeBaseLng != null) {
        fromHomeBase ??= drive({ lat: resource.homeBaseLat, lng: resource.homeBaseLng }, jobCoords);
        homeBaseDrive = (await fromHomeBase)?.durationMinutes ?? null;
      }
      const next = slot.nextJob;
      if (next && next.lat != null && next.lng != null) {
        if (!toNext.has(next)) toNext.set(next, drive(jobCoords, { lat: next.lat, lng: next.lng }));
        const onward = (await toNext.get(next))?.durationMinutes ?? null;
        if (onward !== null && timeToMinutes(next.startTime) - timeToMinutes(slot.endTime) < onward) continue;
      }
    }

    scored.push({
      date: input.day,
      startTime: slot.startTime,
      endTime: slot.endTime,
      resourceId: resource.id,
      resourceName: resource.name,
      driveMinutesFromPrevious: driveMinutes,
      previousJobAddress: slot.previousJob?.address ?? null,
      score: scoreSlot({
        driveMinutesFromPrevious: driveMinutes,
        homeBaseDriveMinutes: homeBaseDrive,
        startTime: slot.startTime,
        isPreferredResource: input.preferredResourceId === resource.id,
        isGapStart: slot.isGapStart,
      }),
    });
  }
  return scored;
}

function skillMatches(resource: ResourceRow, requiredSkill: string | null | undefined): boolean {
  return !requiredSkill || resource.skills.length === 0 || resource.skills.includes(requiredSkill);
}

/** A calendar date from a 0.3 `Date` (its UTC date) or a 0.4 "YYYY-MM-DD". */
function asDateString(value: Date | DateString): DateString {
  if (typeof value === "string") {
    if (!isValidDateString(value)) throw invalidInput(["from"], "Use a date like 2026-11-02.");
    return value;
  }
  return labelOf(value);
}

// --- The staff finder: scored slots ------------------------------------------

export interface FindSlotsOptions {
  tenantId: string;
  jobAddress?: string | null;
  jobLat?: number | null;
  jobLng?: number | null;
  durationMinutes: number;
  /** The first day (a calendar date, or a 0.3 label Date). */
  startDate: Date | DateString;
  /** The last day, inclusive. */
  endDate: Date | DateString;
  requiredSkill?: string | null;
  preferredResourceId?: string | null;
  /** Minutes between offered starts. Default 30; `Infinity` for one per gap. */
  slotStepMinutes?: number;
  /** Drop starts before this instant: the staff "suggest" passes now, so nothing in the past is offered. */
  notBefore?: Date;
  /** The clock, for "an overdue request holds no time". Default `notBefore`, else `new Date()`. */
  now?: Date;
}

/**
 * The whole point of the package: open slots across every resource, scored by
 * drive time from the previous job (via the injected maps provider), best
 * first. Falls back to the keyless Haversine provider if none is given. The
 * job's address is geocoded when the provider can and no coordinates were
 * given; a provider that throws leaves the job unplaced, and the slots
 * unscored, rather than failing.
 *
 * STAFF ONLY. Each `ScoredSlot` names the crew and carries the previous job's
 * address — another customer's home — and its drive filter depends on the
 * job's address. A public route uses `findPublicSlots`, which returns
 * `PublicSlot`s and nothing else.
 */
export async function findAvailableSlots(
  db: SchedulingDb,
  options: FindSlotsOptions,
  maps: MapsProvider = createHaversineMapsProvider(),
): Promise<ScoredSlot[]> {
  let jobCoords: LatLng | null =
    options.jobLat != null && options.jobLng != null ? { lat: options.jobLat, lng: options.jobLng } : null;
  if (!jobCoords && options.jobAddress) {
    jobCoords = (await tryGeocode(maps, options.jobAddress)).coords;
  }

  const settings = await getSchedulingSettings(db, options.tenantId);
  const resources = (await listResources(db, options.tenantId)).filter((r) => {
    if (options.preferredResourceId && r.id !== options.preferredResourceId) return false;
    return skillMatches(r, options.requiredSkill);
  });
  if (resources.length === 0) return [];

  const firstDay = asDateString(options.startDate);
  const lastDay = asDateString(options.endDate);
  const now = options.now ?? options.notBefore ?? new Date();
  // The range's hours and visits in one query each, not one per resource per day.
  const availability = await availabilityFor(db, options.tenantId, resources);
  const visits = await activeBookingsByDay(
    db,
    options.tenantId,
    resources.map((r) => r.id),
    labelDate(firstDay),
    labelDate(lastDay),
    { now },
  );

  const scored: ScoredSlot[] = [];
  for (const day of eachDate(firstDay, lastDay, 400)) {
    for (const resource of resources) {
      scored.push(
        ...(await slotsForResourceDay({
          resource,
          availability: availability.get(resource.id) ?? [],
          active: visits.get(resourceDayKey(resource.id, day)) ?? [],
          day,
          timeZone: settings.timeZone,
          durationMinutes: options.durationMinutes,
          stepMinutes: options.slotStepMinutes ?? DEFAULT_SLOT_STEP_MINUTES,
          jobCoords,
          maps,
          preferredResourceId: options.preferredResourceId ?? null,
          earliestStart: options.notBefore ?? null,
        })),
      );
    }
  }

  return sortScoredSlots(scored);
}

// --- The public offer ----------------------------------------------------------

export interface PublicOfferQuery {
  tenantId: string;
  durationMinutes: number;
  requiredSkill?: string | null;
  firstDay: DateString;
  /** Inclusive. */
  lastDay: DateString;
  policy: ResolvedPublicBookingPolicy;
  timeZone: string;
  earliestStart: Date;
  latestStart: Date;
  now: Date;
  /** The customer's own visit, being moved: it is not in its own way. */
  excludeBookingId?: string | null;
}

/**
 * THE PUBLIC OFFER: for each day and start, the one crew that takes it.
 * `findPublicSlots` shows it. `requestPublicBooking` and
 * `rescheduleVisitByToken` work it out again — once to find the crew, and once
 * more under that crew's lock — and book only a (day, start) that is in it, on
 * the crew it names. So everything that shapes the list also binds the
 * request: hours, notice, horizon, the daily cap, overlaps, the travel buffer,
 * the skill, which crew gets a shared time, and `maxSlotsPerDay`.
 *
 * IT NEVER DEPENDS ON WHO IS ASKING. No address, no drive time: every visit is
 * padded by the policy's `travelBufferMinutes`, the same for everybody. Scores
 * come only from each crew's own calendar — the start right after a visit, and
 * mornings, score higher — which is what picks the crew for a time two are
 * free at, and what `maxSlotsPerDay` keeps. A tie goes to the first crew in
 * `listResources` order, which is stable.
 *
 * Only active resources that accept public bookings are offered; a crew at its
 * daily cap offers nothing that day. Three queries whatever the range: the
 * crews, their hours, the range's visits.
 */
export async function publicOffer(db: SchedulingDb, query: PublicOfferQuery): Promise<ScoredSlot[]> {
  const { policy } = query;
  const resources = (await listResources(db, query.tenantId)).filter(
    (r) => r.acceptsPublicBookings && skillMatches(r, query.requiredSkill),
  );
  if (resources.length === 0) return [];
  const availability = await availabilityFor(db, query.tenantId, resources);
  const visits = await activeBookingsByDay(
    db,
    query.tenantId,
    resources.map((r) => r.id),
    labelDate(query.firstDay),
    labelDate(query.lastDay),
    { now: query.now, excludeBookingId: query.excludeBookingId ?? null },
  );
  // Never called: the public offer has no job coordinates. Passed because the
  // finder takes one.
  const noDrives = createHaversineMapsProvider();

  const best = new Map<string, ScoredSlot>();
  for (const day of eachDate(query.firstDay, query.lastDay, 400)) {
    for (const resource of resources) {
      const slots = await slotsForResourceDay({
        resource,
        availability: availability.get(resource.id) ?? [],
        active: visits.get(resourceDayKey(resource.id, day)) ?? [],
        day,
        timeZone: query.timeZone,
        durationMinutes: query.durationMinutes,
        stepMinutes: policy.slotStepMinutes,
        bufferMinutes: policy.travelBufferMinutes,
        jobCoords: null,
        maps: noDrives,
        earliestStart: query.earliestStart,
        latestStart: query.latestStart,
      });
      for (const slot of slots) {
        const key = `${slot.date} ${slot.startTime}`;
        const held = best.get(key);
        if (!held || slot.score > held.score) best.set(key, slot);
      }
    }
  }

  let offered = [...best.values()];
  if (policy.maxSlotsPerDay != null) {
    const perDay = new Map<string, ScoredSlot[]>();
    for (const slot of offered) perDay.set(slot.date, [...(perDay.get(slot.date) ?? []), slot]);
    offered = [...perDay.values()].flatMap((slots) =>
      [...slots]
        .sort((a, b) => b.score - a.score || a.startTime.localeCompare(b.startTime))
        .slice(0, policy.maxSlotsPerDay ?? undefined),
    );
  }
  return offered.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

// --- The public finder ----------------------------------------------------------

export interface PublicBookingOptions {
  /** The clock. Defaults to the wall clock per call; inject for tests. */
  now?: Date;
  /**
   * Overrides for the tenant's settings, field by field: the defaults, then
   * the settings, then whatever this defines. 0.3 callers that pass a policy
   * keep their numbers. The zone always comes from settings.
   */
  policy?: PublicBookingPolicy;
  /** The tenant's settings, already read. Default: read them. */
  settings?: SchedulingSettings;
}

export interface FindPublicSlotsInput {
  tenantId: string;
  /** A service key from the tenant's settings: it sets the length and the crew skill. */
  service?: string | null;
  /**
   * 0.3's way: a length from the policy's `durationsMinutes`. Give this or
   * `service` (service wins when both are given).
   */
  durationMinutes?: number | null;
  /**
   * With `durationMinutes`: only crews with this skill (or no skills listed).
   * Decide it on the server. With `service`, the service's skill is used.
   *
   * There is no address field on purpose: the offer is the same for every
   * visitor. The visitor's address is checked when the request is made.
   */
  requiredSkill?: string | null;
  /** First day to look at: a calendar date in the business's zone (or a 0.3 Date). Default: today there. */
  from?: Date | DateString | null;
  /** How many days to look across from the first day. Clamped to the horizon. Default: up to the horizon. */
  days?: number | null;
  /**
   * A customer moving their own visit: when this token opens a visit they can
   * still change, the offer uses that visit's length and skill and leaves the
   * visit itself out of the busy set, so the time right next to their own is
   * offered. A token that opens nothing is ignored — the same answer as no
   * token, so the list is no oracle for tokens.
   */
  manageToken?: string | null;
}

/** Everything the `slots` route answers with. */
export interface PublicSlotsResult {
  timeZone: string;
  service: string;
  from: DateString;
  to: DateString;
  closed: boolean;
  slots: PublicSlot[];
}

function assertPublicDuration(durationMinutes: number, policy: ResolvedPublicBookingPolicy): void {
  if (!policy.durationsMinutes.includes(durationMinutes)) {
    throw new BookingNotBookableError(
      `Visits can be booked online for ${policy.durationsMinutes.join(", ")} minutes.`,
      "invalid_duration",
    );
  }
}

/** What a public request or offer is for: the length, the crew skill, and the service key stored on the visit. */
interface PublicAskShape {
  durationMinutes: number;
  requiredSkill: string | null;
  serviceKey: string;
}

function shapeFromService(settings: SchedulingSettings, key: string): PublicAskShape {
  const service = findService(settings.services, key);
  if (!service) throw new BookingNotBookableError("We don't offer that service online. Please pick another.", "unknown_service");
  return { durationMinutes: service.durationMinutes, requiredSkill: service.requiredSkill ?? null, serviceKey: service.key };
}

/**
 * The public slots, with the window they cover — what the `slots` route sends.
 * See `findPublicSlots`.
 */
export async function publicSlotsFor(
  db: SchedulingDb,
  input: FindPublicSlotsInput,
  options: PublicBookingOptions = {},
): Promise<PublicSlotsResult> {
  const settings = options.settings ?? (await getSchedulingSettings(db, input.tenantId));
  const now = options.now ?? new Date();
  const zone = settings.timeZone;
  const today = todayIn(now, zone);
  const requestedFrom = input.from != null ? asDateString(input.from) : today;
  const days = input.days != null && Number.isFinite(input.days) ? Math.max(1, Math.trunc(input.days)) : null;
  const emptyWindow = (service: string): PublicSlotsResult => ({
    timeZone: zone,
    service,
    from: requestedFrom,
    to: addDays(requestedFrom, (days ?? 1) - 1),
    closed: !settings.publicBookingEnabled,
    slots: [],
  });

  // CONTRACT: closed for online booking, nothing is offered, whatever was
  // asked for — a missing or unknown service is not judged first.
  if (!settings.publicBookingEnabled) return emptyWindow(input.service ?? "");

  const policy = publicPolicyFor(settings, options.policy);

  // What is being offered: the customer's own visit (a reschedule), a
  // service, or 0.3's bare duration.
  let shape: PublicAskShape | null = null;
  let excludeBookingId: string | null = null;
  if (input.manageToken) {
    const own = await openVisitByToken(db, input.tenantId, input.manageToken);
    if (own && changeWindow(own, settings, now).changeable) {
      const service = findService(settings.services, own.serviceType);
      shape = {
        durationMinutes: own.durationMinutes,
        requiredSkill: service?.requiredSkill ?? null,
        serviceKey: own.serviceType,
      };
      excludeBookingId = own.id;
    }
  }
  if (!shape && input.service) shape = shapeFromService(settings, input.service);
  if (!shape && input.durationMinutes != null) {
    assertPublicDuration(input.durationMinutes, policy);
    shape = { durationMinutes: input.durationMinutes, requiredSkill: input.requiredSkill ?? null, serviceKey: "visit" };
  }
  if (!shape) throw invalidInput(["service"], "Pick a service.");

  const earliestStart = new Date(now.getTime() + policy.minNoticeMinutes * 60_000);
  const latestStart = new Date(now.getTime() + policy.horizonDays * DAY_MS);
  const earliestDay = dateIn(earliestStart, zone);
  const firstDay = requestedFrom > earliestDay ? requestedFrom : earliestDay;
  const horizonDay = dateIn(latestStart, zone);
  const wanted = days != null ? addDays(firstDay, days - 1) : horizonDay;
  const lastDay = wanted < horizonDay ? wanted : horizonDay;
  if (firstDay > lastDay) return emptyWindow(shape.serviceKey);

  const offer = await publicOffer(db, {
    tenantId: input.tenantId,
    durationMinutes: shape.durationMinutes,
    requiredSkill: shape.requiredSkill,
    firstDay,
    lastDay,
    policy,
    timeZone: zone,
    earliestStart,
    latestStart,
    now,
    excludeBookingId,
  });
  return {
    timeZone: zone,
    service: shape.serviceKey,
    from: firstDay,
    to: lastDay,
    closed: false,
    slots: offer.map((slot) => toPublicSlot(slot, zone)),
  };
}

/**
 * The slots an ANONYMOUS visitor may see: `PublicSlot`s (slot id, date,
 * start, end, and the same as instants) and nothing else — no crew, no score,
 * no drive time, no other customer's address. Every public route that lists
 * times must use this, never `findAvailableSlots`, whose staff `ScoredSlot`s
 * carry the previous job's street address.
 *
 * Times are the business's: the wall clock in the tenant's zone, offered only
 * when the start instant lies in [now + notice, now + horizon]. With online
 * booking switched off it returns []. Throws `BookingNotBookableError`
 * (`unknown_service`, `invalid_duration`) for something the business doesn't
 * offer, and a ZodError when neither a service nor a duration was given.
 */
export async function findPublicSlots(
  db: SchedulingDb,
  input: FindPublicSlotsInput,
  options: PublicBookingOptions = {},
): Promise<PublicSlot[]> {
  return (await publicSlotsFor(db, input, options)).slots;
}

// --- The public request ----------------------------------------------------------

export const requestPublicBookingSchema = z.object({
  tenantId: z.string().min(1).max(200),
  /** From a `PublicSlot`; the server re-derives the day and start from it and picks the crew. */
  slotId: z.string().min(1).max(500),
  /** A service key: sets the length, the crew skill and the visit's service. Wins over `durationMinutes`. */
  service: z.string().trim().min(1).max(40).optional(),
  /** 0.3's way: a length from the policy's `durationsMinutes`. */
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  /** With `durationMinutes`: the same skill the slots were listed with. Set it on the server. */
  requiredSkill: z.string().max(60).nullish(),
  /** With `durationMinutes`: stored on the visit. Default "visit". */
  serviceType: z.string().max(60).optional(),
  /**
   * ONE LINE, AND NO WEB ADDRESS — in the name, the phone and the address. The
   * acknowledgement echoes them to whatever email was typed, from the
   * business's own domain; a line break or a link there is a phishing email
   * the business sends (see text.ts).
   */
  customerName: publicLine(200, "your name").refine((name) => name.length > 0, "Enter your name."),
  customerEmail: z.string().trim().email().max(320),
  customerPhone: singleLine(60).nullish(),
  /** Geocoded server-side for the drive-time check; the request carries no coordinates. */
  address: publicLine(500, "the address").nullish(),
  /**
   * The customer was told the map can't find their address and chose to send
   * it anyway: book it without coordinates, and tell the office to check it
   * (`addressUnverified` on the event). Never needed when the map finds it.
   */
  addressAsTyped: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
  /** A pointer staff can follow to the estimate that led here. Never read for price or access. */
  estimateId: z.string().max(200).nullish(),
});
export type RequestPublicBookingInput = z.input<typeof requestPublicBookingSchema>;

export interface RequestPublicBookingOptions extends PublicBookingOptions {
  /** Geocoding and the drive-buffer check; defaults to keyless Haversine (no geocoding). */
  maps?: MapsProvider;
  /**
   * Who is asking, as the host can tell: the caller's IP address, say
   * (`"ip:203.0.113.7"`). Never from the request body. Stored on the visit,
   * and counted against `maxOpenRequestsPerRequester`. Null or omitted: no
   * per-requester cap.
   */
  requesterKey?: string | null;
}

/** What the visitor gets back: when, and whether it is confirmed or awaiting a person. Nothing about the crew. */
export interface PublicBookingReceipt {
  id: string;
  /** "YYYY-MM-DD" */
  date: string;
  startTime: string;
  endTime: string;
  status: "pending" | "confirmed";
}

/** The 0.4 receipt: the instants, the zone, a manage token for the customer's link, and whether this was a repeat. */
export type PublicVisitReceipt = PublicBookingReceipt & {
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  /**
   * The plaintext manage token. Put it in the customer's link; it is never
   * stored. NULL on a repeat: a repeat proves only that somebody typed this
   * email for this time a moment ago, and a key to the visit — its name, its
   * address, its cancel button — is not something that earns. The first
   * request's acknowledgement email already carries the link.
   */
  manageToken: string | null;
  /** True when this was the same request again (a double click, a retry): the first visit's time, no token. */
  repeated: boolean;
};

function receiptFor(row: BookingRow, timeZone: string, manageToken: string | null, repeated: boolean): PublicVisitReceipt {
  const startsAt = row.startsAt ?? visitInstants(labelOf(row.scheduledDate), row.startTime, row.endTime, timeZone).startsAt;
  const endsAt = row.endsAt ?? visitInstants(labelOf(row.scheduledDate), row.startTime, row.endTime, timeZone).endsAt;
  return {
    id: row.id,
    date: labelOf(row.scheduledDate),
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.status === "confirmed" ? "confirmed" : "pending",
    startsAt,
    endsAt,
    timeZone,
    manageToken,
    repeated,
  };
}

/**
 * Where a public visit is, from the address the visitor typed — geocoded here,
 * never taken from the client, and before any lock (a network call must not
 * hold up everyone else booking the crew).
 *
 * "NO SUCH PLACE" REFUSES — ONCE. An address a real geocoder can't place is
 * `address_unresolved` and the visitor is asked to check it: a visit with no
 * coordinates skips every drive check, its own and every later one against
 * it. But a new subdivision or a rural route often isn't on the map yet, and a
 * customer turned away at the last step is a lead the business never hears
 * about. So the visitor can send it anyway (`addressAsTyped`): it is booked
 * without coordinates and the office is told to check the address. A provider
 * that THREW (a timeout, a quota, a revoked key) is an outage that isn't the
 * visitor's fault: booked without coordinates, as before. A provider that
 * can't geocode at all (`geocodes: false`, the Haversine default) books
 * without coordinates too.
 */
async function locateVisit(
  address: string | null | undefined,
  maps: MapsProvider,
  policy: ResolvedPublicBookingPolicy,
  asTyped: boolean,
): Promise<{ coords: LatLng | null; unverified: boolean }> {
  if (!address) {
    if (policy.requireAddress) {
      throw new BookingNotBookableError("Enter the address for the visit.", "address_unresolved");
    }
    return { coords: null, unverified: false };
  }
  if (maps.geocodes === false) return { coords: null, unverified: false };
  const { coords, failed } = await tryGeocode(maps, address);
  if (failed) return { coords: null, unverified: false };
  if (!coords) {
    if (asTyped) return { coords: null, unverified: true };
    throw new BookingNotBookableError("We couldn't find that address. Check it and try again.", "address_unresolved");
  }
  return { coords, unverified: false };
}

/** How long a repeat of the same request gets the first one's receipt back. */
const REPEAT_WINDOW_MINUTES = 10;

interface PublicAsk {
  tenantId: string;
  day: Date;
  startTime: string;
  durationMinutes: number;
  customerEmail: string;
  requesterKey: string | null;
}

/**
 * The visit this same request made a few minutes ago, if there is one: same
 * day, start, length, email AND requester, still pending or confirmed.
 *
 * A double click, or a retry after a slow response, used to be refused
 * `slot_unavailable` — the first request was holding the time — so the visitor
 * read "that time is gone" about a booking that had landed. Now the repeat is
 * told it landed: `repeated: true`, the time — and nothing else of the
 * visit's. No new manage token and no stored name or address (the response is
 * built from what THIS caller typed): the first request's acknowledgement
 * email carries the link.
 *
 * ONLY WITH A REQUESTER KEY, and only the same one. A key function that
 * answers null for one request (no forwarding header — anything in front of
 * the app that omits it) used to drop the requester filter entirely, so
 * anybody who knew a customer's email could ask for the time that just
 * vanished from the list and get that visit's name, address and a working
 * cancel link back. With no key a repeat is not recognised at all: the time is
 * taken, so it is `slot_unavailable`, as before 0.4. The clock is the
 * database's — the one that stamped `created_at` — not the injectable `now`.
 */
async function recentRepeat(db: SchedulingDb, ask: PublicAsk): Promise<BookingRow | null> {
  if (!ask.requesterKey) return null;
  const [row] = (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, ask.tenantId),
        eq(schedulingBookings.scheduledDate, ask.day),
        eq(schedulingBookings.startTime, ask.startTime),
        eq(schedulingBookings.durationMinutes, ask.durationMinutes),
        sql`lower(${schedulingBookings.customerEmail}) = ${ask.customerEmail.toLowerCase()}`,
        inArray(schedulingBookings.status, ["pending", "confirmed"]),
        sql`${schedulingBookings.createdAt} > now() - interval '${sql.raw(String(REPEAT_WINDOW_MINUTES))} minutes'`,
        eq(schedulingBookings.requesterKey, ask.requesterKey),
      ),
    )
    .limit(1)) as BookingRow[];
  return row ?? null;
}

/**
 * A requester's upcoming online visits: booked from the public page, pending
 * OR confirmed, on today (in the business's zone) or later, and not a request
 * past its deadline (an overdue request holds no time, so it doesn't hold a
 * place under the cap either).
 *
 * CONFIRMED COUNTS TOO. With auto-confirm on every request lands confirmed, and
 * a cap that counted only pending ones counted nothing: one script filled a
 * crew's online calendar with confirmed visits that hold their time until
 * somebody cancels them — and sent a confirmation email for each. The cap is
 * about what one caller holds on the calendar, whichever way the business
 * answers requests.
 */
async function openRequestsFrom(
  db: SchedulingDb,
  tenantId: string,
  requesterKey: string,
  today: DateString,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, tenantId),
        eq(schedulingBookings.requesterKey, requesterKey),
        eq(schedulingBookings.origin, "public"),
        inArray(schedulingBookings.status, ["pending", "confirmed"]),
        gte(schedulingBookings.scheduledDate, labelDate(today)),
        notOverdue(now),
      ),
    );
  return Number(row?.open ?? 0);
}

/** `requestPublicBooking`'s full result: the receipt, and the row (for a handler that answers with the visit). */
export interface PublicRequestOutcome {
  receipt: PublicVisitReceipt;
  row: BookingRow;
  settings: SchedulingSettings;
}

/** `requestPublicBooking`, returning the row too. The handlers use it; hosts use `requestPublicBooking`. */
export async function requestPublicVisit(
  db: SchedulingDb,
  input: RequestPublicBookingInput,
  options: RequestPublicBookingOptions & SchedulingWriteOptions = {},
): Promise<PublicRequestOutcome> {
  const parsed = requestPublicBookingSchema.parse(input);
  const settings = options.settings ?? (await getSchedulingSettings(db, parsed.tenantId));
  if (!settings.publicBookingEnabled) {
    throw new BookingNotBookableError("Online booking is closed right now. Please call or email us.", "booking_closed");
  }
  const policy = publicPolicyFor(settings, options.policy);
  let shape: PublicAskShape;
  if (parsed.service) {
    shape = shapeFromService(settings, parsed.service);
  } else if (parsed.durationMinutes !== undefined) {
    assertPublicDuration(parsed.durationMinutes, policy);
    shape = {
      durationMinutes: parsed.durationMinutes,
      requiredSkill: parsed.requiredSkill ?? null,
      serviceKey: parsed.serviceType ?? "visit",
    };
  } else {
    throw invalidInput(["service"], "Pick a service.");
  }

  const maps = options.maps ?? createHaversineMapsProvider();
  const requesterKey = options.requesterKey?.trim().slice(0, 200) || null;
  const now = options.now ?? new Date();
  const zone = settings.timeZone;
  const earliestStart = new Date(now.getTime() + policy.minNoticeMinutes * 60_000);
  const latestStart = new Date(now.getTime() + policy.horizonDays * DAY_MS);

  const slot = decodeSlotId(parsed.slotId);
  if (!slot) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const day = labelDate(slot.date);
  const startMinutes = timeToMinutes(slot.startTime);
  // Visits never cross midnight: a start this late for this length is no slot.
  if (startMinutes + shape.durationMinutes > 24 * 60) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const endTime = minutesToTime(startMinutes + shape.durationMinutes);
  const { startsAt, endsAt } = visitInstants(slot.date, slot.startTime, endTime, zone);
  if (startsAt.getTime() < earliestStart.getTime()) {
    throw new BookingNotBookableError("That time is too soon to book online. Please pick a later one.", "too_soon");
  }
  if (startsAt.getTime() > latestStart.getTime()) {
    throw new BookingNotBookableError("That date is too far ahead to book online.", "too_far");
  }

  const ask: PublicAsk = {
    tenantId: parsed.tenantId,
    day,
    startTime: slot.startTime,
    durationMinutes: shape.durationMinutes,
    customerEmail: parsed.customerEmail,
    requesterKey,
  };
  const repeated = (row: BookingRow): PublicRequestOutcome => {
    // No token and no event — the first request already told everybody, and
    // its email carries the link. The row handed back is the visit AS THIS
    // CALLER DESCRIBED IT: the stored name, phone, address and notes are
    // replaced with what this request typed, so nothing the first requester
    // wrote leaves the server.
    const asTyped: BookingRow = {
      ...row,
      customerName: parsed.customerName,
      customerPhone: parsed.customerPhone ?? null,
      address: parsed.address ?? null,
      notes: parsed.notes ?? null,
      lat: null,
      lng: null,
    };
    return { receipt: receiptFor(row, zone, null, true), row: asTyped, settings };
  };
  // A retry after the first request committed: the time is no longer on
  // offer, so this has to be asked before the offer is — and before a paid
  // geocode of an address that already has its visit.
  const repeat = await recentRepeat(db, ask);
  if (repeat) return repeated(repeat);

  const { coords, unverified } = await locateVisit(parsed.address, maps, policy, parsed.addressAsTyped === true);

  const query: PublicOfferQuery = {
    tenantId: parsed.tenantId,
    durationMinutes: shape.durationMinutes,
    requiredSkill: shape.requiredSkill,
    firstDay: slot.date,
    lastDay: slot.date,
    policy,
    timeZone: zone,
    earliestStart,
    latestStart,
    now,
  };
  const chosen = (await publicOffer(db, query)).find((s) => s.startTime === slot.startTime);
  if (!chosen) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const drives = await driveTimesBeforeLock(db, maps, {
    tenantId: parsed.tenantId,
    resourceId: chosen.resourceId,
    date: day,
    job: coords,
    now,
  });

  const status = policy.requestStatus;
  const outcome = await db.transaction(async (tx) => {
    // Settings (shared), then the requester, then the crew: the one order
    // every writer takes them in.
    await lockSettingsShared(tx, parsed.tenantId);
    if (requesterKey) await lockRequester(tx, parsed.tenantId, requesterKey);
    await lockResource(tx, parsed.tenantId, chosen.resourceId);
    await assertZone(tx, parsed.tenantId, zone);

    // A double click: both requests chose this crew, and this one waited on
    // the lock while the first wrote its visit.
    const doubled = await recentRepeat(tx, ask);
    if (doubled) return { row: doubled, token: null as string | null };

    if (requesterKey && policy.maxOpenRequestsPerRequester != null) {
      const open = await openRequestsFrom(tx, parsed.tenantId, requesterKey, todayIn(now, zone), now);
      if (open >= policy.maxOpenRequestsPerRequester) {
        throw new BookingNotBookableError(
          "You already have visits booked or waiting with us. Please call or email us to book another.",
          "too_many_requests",
        );
      }
    }

    // Ask the offer again, under the lock: this start must still be on it, on
    // this crew. A time somebody took a moment ago, or one another crew's new
    // visit now gives to that crew instead, is not.
    const still = (await publicOffer(tx, query)).find((s) => s.startTime === slot.startTime);
    if (!still || still.resourceId !== chosen.resourceId) {
      throw new BookingNotBookableError(SLOT_UNAVAILABLE);
    }
    // And the guard every staff booking passes — with the visitor's real
    // coordinates, the drive in and out — so the two paths can never disagree
    // about what a double booking is.
    const check = await validateBookingSlot(
      tx,
      {
        tenantId: parsed.tenantId,
        resourceId: chosen.resourceId,
        date: day,
        startTime: slot.startTime,
        endTime,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        now,
      },
      drives,
    );
    if (!check.valid) throw new BookingNotBookableError(SLOT_UNAVAILABLE);

    const [row] = (await tx
      .insert(schedulingBookings)
      .values({
        tenantId: parsed.tenantId,
        resourceId: chosen.resourceId,
        serviceType: shape.serviceKey,
        customerName: parsed.customerName,
        customerEmail: parsed.customerEmail,
        customerPhone: parsed.customerPhone ?? null,
        address: parsed.address ?? null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        scheduledDate: day,
        startTime: slot.startTime,
        endTime,
        durationMinutes: shape.durationMinutes,
        status,
        estimateId: parsed.estimateId ?? null,
        notes: parsed.notes ?? null,
        requesterKey,
        startsAt,
        endsAt,
        origin: "public",
        // CONTRACT: the deadline counts from the action's `now` (the injected
        // clock), not the database's created_at, so a test clock and the
        // deadline agree.
        pendingExpiresAt:
          status === "pending" ? earliest(new Date(now.getTime() + settings.pendingExpiryHours * 3_600_000), startsAt) : null,
      })
      .returning()) as BookingRow[];
    // The customer's first manage link, in the same transaction as the visit.
    const token = await insertManageToken(tx, parsed.tenantId, (row as BookingRow).id);
    return { row: row as BookingRow, token: token as string | null };
  });

  if (outcome.token === null) return repeated(outcome.row);

  const specs: EventSpec[] = [
    {
      type: "visit.requested",
      row: outcome.row,
      actor: options.actor ?? { type: "customer", id: null },
      via: "online",
      ...(options.notify !== undefined ? { notify: options.notify } : {}),
      ...(unverified ? { addressUnverified: true } : {}),
    },
  ];
  if (outcome.row.status === "confirmed") {
    specs.push({
      type: "visit.confirmed",
      row: outcome.row,
      actor: { type: "system", id: null },
      via: "auto",
      ...(options.notify !== undefined ? { notify: options.notify } : {}),
      ...(unverified ? { addressUnverified: true } : {}),
    });
  }
  await emitEvents(db, parsed.tenantId, specs, {
    settings,
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  return { receipt: receiptFor(outcome.row, zone, outcome.token, false), row: outcome.row, settings };
}

/**
 * An anonymous visitor asks for a slot from `findPublicSlots`.
 *
 * Nothing about WHEN comes from the client but the slot id and the service:
 * the day and start are decoded from the id, the end is start + the service's
 * length, the crew is the one the public offer gives that time to, and the
 * coordinates are geocoded here from the address. The (day, start) must be in
 * the public offer right now — same notice, horizon, hours, cap, overlap,
 * travel buffer, skill, crew choice and `maxSlotsPerDay` — and the real drive
 * from the neighbouring visits must fit, all checked and inserted in ONE
 * transaction under the crew's advisory lock, so two visitors racing for one
 * time get one booking and one `slot_unavailable`. The visit lands `pending`
 * (with a deadline: `pendingExpiryHours`, or its start if sooner) unless the
 * business auto-confirms.
 *
 * The receipt carries a fresh MANAGE TOKEN — the customer's key to view, move
 * or cancel this visit — inserted (as a hash) in the same transaction. After
 * commit it emits `visit.requested` (and `visit.confirmed` when auto-confirmed).
 *
 * With a `requesterKey`, a requester already holding the limit of pending
 * requests is refused `too_many_requests`. A repeat of a request made in the
 * last few minutes returns the first visit's receipt with `repeated: true`.
 *
 * Throws `BookingNotBookableError` (`code` says why) and a zod error for a
 * malformed body. An unknown slot, another tenant's slot, a paused crew, a
 * start the offer doesn't hold, a drive that doesn't fit and a taken time are
 * all the same `slot_unavailable`.
 */
export async function requestPublicBooking(
  db: SchedulingDb,
  input: RequestPublicBookingInput,
  options: RequestPublicBookingOptions & SchedulingWriteOptions = {},
): Promise<PublicVisitReceipt> {
  return (await requestPublicVisit(db, input, options)).receipt;
}
