import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveDayWindows } from "./availability.js";
import { earliest, labelDate, labelOf, todayIn, visitInstants } from "./instants.js";
import { getResourceRow, notOverdue } from "./internal.js";
import { createHaversineMapsProvider, type DriveTime, type LatLng, type MapsProvider } from "./maps.js";
import { schedulingAvailability, schedulingBookings, schedulingResources } from "./schema.js";
import { getSchedulingSettings, rewriteInstants, type SchedulingSettings } from "./settings.js";
import { toVisitSnapshot } from "./snapshot.js";
import type { AvailabilityRow, BookingRow, ResourceRow, SchedulingDb } from "./types.js";
import type { CalendarResponse, CrewDayResponse, CrewStop, DayWindows } from "./wire.js";
import { addDays, eachDate, isValidDateString } from "./zone.js";

/**
 * The staff read models: the calendar (a range × the crews) and one crew's
 * day as a route. They return the section 7 wire shapes directly — strings for
 * dates and instants — so a handler sends them as they are.
 */

const MAX_CALENDAR_DAYS = 42;

const dateString = z.string().refine(isValidDateString, "Use a date like 2026-11-02.");

export const listCalendarSchema = z
  .object({
    from: dateString,
    to: dateString,
    resourceIds: z.array(z.string().min(1).max(200)).max(100).optional(),
    includeInactive: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!isValidDateString(value.from) || !isValidDateString(value.to)) return;
    if (value.to < value.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "The end of the range can't be before its start." });
      return;
    }
    if (eachDate(value.from, value.to, MAX_CALENDAR_DAYS + 1).length > MAX_CALENDAR_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Show up to ${MAX_CALENDAR_DAYS} days at a time.` });
    }
  });
export type ListCalendarInput = z.input<typeof listCalendarSchema>;

const SHOWN = ["pending", "confirmed", "in_progress", "completed", "no_show"];
const SHOWN_WITH_INACTIVE = [...SHOWN, "cancelled", "declined", "expired"];
const INBOX_LIMIT = 50;

/**
 * The schedule for a range of days (at most 42) across the crews: each
 * crew's working windows per day, every visit in the range, and the request
 * inbox.
 *
 * A FIXED NUMBER OF QUERIES, however many crews and days: the settings, the
 * crews, their hours, the range's visits, and the inbox. Five.
 *
 *   - `resources`: the active crews by name, plus any removed crew that still
 *     owns a visit in the range (`isActive: false`), so nothing on the
 *     calendar sits in a column nobody can see. `resourceIds` narrows it.
 *   - `visits`: pending, confirmed, in progress, completed and no-show
 *     visits — cancelled, declined and expired too with `includeInactive`.
 *     Unassigned visits are included with `resourceId: null`.
 *   - `pending`: every request still waiting (pending, not past its deadline)
 *     from today on, soonest first, at most 50, whatever the range.
 */
export async function listCalendar(
  db: SchedulingDb,
  tenantId: string,
  input: ListCalendarInput,
  options: { now?: Date; settings?: SchedulingSettings } = {},
): Promise<CalendarResponse> {
  const parsed = listCalendarSchema.parse(input);
  const now = options.now ?? new Date();
  const settings = options.settings ?? (await getSchedulingSettings(db, tenantId));
  const today = todayIn(now, settings.timeZone);
  // CONTRACT: `resourceIds` narrows the visits as well as the crews (and so
  // leaves unassigned visits out); the inbox stays business-wide.
  const filter = parsed.resourceIds && parsed.resourceIds.length > 0 ? parsed.resourceIds : null;
  const b = schedulingBookings;

  const [crews, hours, visits, inbox] = await Promise.all([
    db
      .select()
      .from(schedulingResources)
      .where(
        and(eq(schedulingResources.tenantId, tenantId), ...(filter ? [inArray(schedulingResources.id, filter)] : [])),
      )
      .orderBy(asc(schedulingResources.name), asc(schedulingResources.id)) as Promise<ResourceRow[]>,
    db
      .select()
      .from(schedulingAvailability)
      .where(
        and(
          eq(schedulingAvailability.tenantId, tenantId),
          ...(filter ? [inArray(schedulingAvailability.resourceId, filter)] : []),
        ),
      ) as Promise<AvailabilityRow[]>,
    db
      .select()
      .from(b)
      .where(
        and(
          eq(b.tenantId, tenantId),
          gte(b.scheduledDate, labelDate(parsed.from)),
          lt(b.scheduledDate, labelDate(addDays(parsed.to, 1))),
          inArray(b.status, parsed.includeInactive ? SHOWN_WITH_INACTIVE : SHOWN),
          ...(filter ? [inArray(b.resourceId, filter)] : []),
        ),
      )
      .orderBy(asc(b.scheduledDate), asc(b.startTime), asc(b.createdAt)) as Promise<BookingRow[]>,
    db
      .select()
      .from(b)
      .where(and(eq(b.tenantId, tenantId), eq(b.status, "pending"), gte(b.scheduledDate, labelDate(today)), notOverdue(now)))
      .orderBy(asc(b.scheduledDate), asc(b.startTime), asc(b.createdAt))
      .limit(INBOX_LIMIT) as Promise<BookingRow[]>,
  ]);

  const owning = new Set(visits.map((visit) => visit.resourceId).filter((id): id is string => !!id));
  const shown = crews.filter((crew) => crew.isActive || owning.has(crew.id));
  const names = new Map(crews.map((crew) => [crew.id, crew.name]));
  const hoursOf = new Map<string, AvailabilityRow[]>(shown.map((crew) => [crew.id, []]));
  for (const row of hours) hoursOf.get(row.resourceId)?.push(row);

  const dates = eachDate(parsed.from, parsed.to, MAX_CALENDAR_DAYS);
  const windows: DayWindows[] = [];
  for (const crew of shown) {
    for (const date of dates) {
      windows.push({ resourceId: crew.id, date, windows: resolveDayWindows(hoursOf.get(crew.id) ?? [], crew, date) });
    }
  }
  const snapshot = (row: BookingRow) =>
    toVisitSnapshot(row, { settings, resourceName: row.resourceId ? (names.get(row.resourceId) ?? null) : null });

  return {
    timeZone: settings.timeZone,
    today,
    from: parsed.from,
    to: parsed.to,
    slotStepMinutes: settings.slotStepMinutes,
    resources: shown.map((crew) => ({
      id: crew.id,
      name: crew.name,
      isActive: crew.isActive,
      acceptsPublicBookings: crew.acceptsPublicBookings,
      maxJobsPerDay: crew.maxJobsPerDay,
    })),
    windows,
    visits: visits.map(snapshot),
    pending: inbox.map(snapshot),
  };
}

export const listCrewDaySchema = z.object({
  resourceId: z.string().min(1).max(200),
  date: dateString,
});

const ON_ROUTE = ["confirmed", "in_progress", "completed", "no_show"];
const MAX_WAYPOINTS = 9;

function placeOf(address: string | null, lat: number | null, lng: number | null): string | null {
  if (address && address.trim()) return address.trim();
  if (lat != null && lng != null) return `${lat},${lng}`;
  return null;
}

/** "https://www.google.com/maps/dir/?api=1&destination=…&travelmode=driving" — no key needed. */
function directionsUrl(place: string | null): string | null {
  if (!place) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place)}&travelmode=driving`;
}

/** "tel:" + the digits, keeping a leading "+": "(801) 555-0143" → "tel:8015550143". */
function telUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  return `tel:${phone.trim().startsWith("+") ? "+" : ""}${digits}`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * One crew's day as a route, for the phone in the van: the stops in time
 * order (confirmed, in progress, completed and no-show visits — a request
 * nobody accepted isn't on a route), the drive into each one, a directions
 * link per address, a call link per customer, and the whole day as one Google
 * Maps route. Null when the crew isn't this tenant's.
 *
 * Drives go through `maps` — cached when it is `selectMapsProvider`'s Google
 * provider — from the crew's home base to stop 1 and from each stop to the
 * next; a drive with no coordinates at either end is null. `estimated` says
 * when a drive is a straight-line estimate (the keyless provider), so nobody
 * plans the day around it as if it were the road.
 */
export async function listCrewDay(
  db: SchedulingDb,
  tenantId: string,
  input: { resourceId: string; date: string },
  options: { maps?: MapsProvider; now?: Date; settings?: SchedulingSettings } = {},
): Promise<CrewDayResponse | null> {
  const parsed = listCrewDaySchema.parse(input);
  const resource = await getResourceRow(db, tenantId, parsed.resourceId);
  if (!resource) return null;
  const now = options.now ?? new Date();
  const maps = options.maps ?? createHaversineMapsProvider();
  const settings = options.settings ?? (await getSchedulingSettings(db, tenantId));
  const b = schedulingBookings;
  const [hours, visits] = await Promise.all([
    db
      .select()
      .from(schedulingAvailability)
      .where(and(eq(schedulingAvailability.tenantId, tenantId), eq(schedulingAvailability.resourceId, resource.id))) as Promise<
      AvailabilityRow[]
    >,
    db
      .select()
      .from(b)
      .where(
        and(
          eq(b.tenantId, tenantId),
          eq(b.resourceId, resource.id),
          eq(b.scheduledDate, labelDate(parsed.date)),
          inArray(b.status, ON_ROUTE),
        ),
      )
      .orderBy(asc(b.startTime), asc(b.createdAt)) as Promise<BookingRow[]>,
  ]);

  const home: LatLng | null =
    resource.homeBaseLat != null && resource.homeBaseLng != null
      ? { lat: resource.homeBaseLat, lng: resource.homeBaseLng }
      : null;
  const estimated = maps.estimates === true;
  const at = (visit: BookingRow): LatLng | null =>
    visit.lat != null && visit.lng != null ? { lat: visit.lat, lng: visit.lng } : null;
  const safeDrive = (origin: LatLng, dest: LatLng): Promise<DriveTime | null> =>
    maps.driveTime(origin, dest).catch(() => null);

  const drives = await Promise.all(
    visits.map(async (visit, index) => {
      const dest = at(visit);
      const origin = index === 0 ? home : at(visits[index - 1] as BookingRow);
      if (!origin || !dest) return null;
      const drive = await safeDrive(origin, dest);
      if (!drive) return null;
      return {
        minutes: drive.durationMinutes,
        miles: drive.distanceMiles,
        from: index === 0 ? ("home_base" as const) : ("previous_stop" as const),
        estimated,
      };
    }),
  );

  const stops: CrewStop[] = visits.map((visit, index) => ({
    order: index + 1,
    visit: toVisitSnapshot(visit, { settings, resourceName: resource.name }),
    driveFromPrevious: drives[index] ?? null,
    directionsUrl: directionsUrl(placeOf(visit.address, visit.lat, visit.lng)),
    telUrl: telUrl(visit.customerPhone),
  }));

  const counted = drives.filter((drive): drive is NonNullable<typeof drive> => drive !== null);
  const places = visits.map((visit) => placeOf(visit.address, visit.lat, visit.lng)).filter((p): p is string => !!p);
  let routeUrl: string | null = null;
  if (places.length >= 1) {
    const destination = places[places.length - 1] as string;
    const waypoints = places.slice(0, -1).slice(0, MAX_WAYPOINTS);
    const origin = placeOf(resource.homeBaseAddress, resource.homeBaseLat, resource.homeBaseLng);
    routeUrl =
      "https://www.google.com/maps/dir/?api=1" +
      (origin ? `&origin=${encodeURIComponent(origin)}` : "") +
      `&destination=${encodeURIComponent(destination)}` +
      (waypoints.length > 0 ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : "") +
      "&travelmode=driving";
  }

  return {
    timeZone: settings.timeZone,
    date: parsed.date,
    today: todayIn(now, settings.timeZone),
    resource: { id: resource.id, name: resource.name, homeBaseAddress: resource.homeBaseAddress },
    windows: resolveDayWindows(hours, resource, parsed.date),
    stops,
    totals: {
      visits: stops.length,
      driveMinutes: counted.reduce((sum, drive) => sum + drive.minutes, 0),
      distanceMiles: round1(counted.reduce((sum, drive) => sum + drive.miles, 0)),
      estimated: counted.some((drive) => drive.estimated),
    },
    routeUrl,
    // The model reads any day it is asked for; whether a CALLER may page to
    // another day is the staff handler's decision (it sets this).
    todayOnly: false,
  };
}

/**
 * Bring this tenant's pre-0.4 visits up to date from code, idempotently
 * (create-app's seed calls it; the README has the same as SQL):
 *
 *   - `starts_at`/`ends_at` from each visit's date and wall clock in the
 *     tenant's zone, where they are null;
 *   - `origin = 'public'` where the visit came from a public request
 *     (`requester_key` set);
 *   - a deadline for every pending request that has none:
 *     `pendingExpiryHours` after it was made, or its start if sooner.
 *
 * Returns how many visits it changed. A second run changes nothing.
 */
export async function backfillVisitInstants(db: SchedulingDb, tenantId: string): Promise<number> {
  const settings = await getSchedulingSettings(db, tenantId);
  const b = schedulingBookings;
  const touched = new Set<string>();

  const missing = (await db
    .select()
    .from(b)
    .where(and(eq(b.tenantId, tenantId), or(isNull(b.startsAt), isNull(b.endsAt))))) as BookingRow[];
  if (missing.length > 0) {
    const rows = missing.map((row) => {
      const { startsAt, endsAt } = visitInstants(labelOf(row.scheduledDate), row.startTime, row.endTime, settings.timeZone);
      const pendingExpiresAt =
        row.status === "pending" && row.pendingExpiresAt === null
          ? earliest(new Date(row.createdAt.getTime() + settings.pendingExpiryHours * 3_600_000), startsAt)
          : row.pendingExpiresAt;
      return { id: row.id, startsAt, endsAt, pendingExpiresAt, sequence: row.sequence };
    });
    await rewriteInstants(db, tenantId, rows);
    for (const row of rows) touched.add(row.id);
  }

  const origins = (await db
    .update(b)
    .set({ origin: "public" })
    .where(and(eq(b.tenantId, tenantId), isNotNull(b.requesterKey), ne(b.origin, "public")))
    .returning({ id: b.id })) as Array<{ id: string }>;
  for (const row of origins) touched.add(row.id);

  const deadlines = (await db
    .update(b)
    .set({
      pendingExpiresAt: sql`least(${b.createdAt} + make_interval(hours => ${settings.pendingExpiryHours}::int), ${b.startsAt})`,
    })
    .where(and(eq(b.tenantId, tenantId), eq(b.status, "pending"), isNull(b.pendingExpiresAt), isNotNull(b.startsAt)))
    .returning({ id: b.id })) as Array<{ id: string }>;
  for (const row of deadlines) touched.add(row.id);

  return touched.size;
}
