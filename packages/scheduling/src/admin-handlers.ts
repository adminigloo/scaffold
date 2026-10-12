import { and, gt, inArray, isNull, or, gte, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  addTimeOff,
  availabilitySummaryOf,
  getAvailabilitySummary,
  listAvailability,
  removeTimeOff,
  setAvailability,
} from "./availability.js";
import { listCalendar, listCrewDay } from "./calendar.js";
import { resourceNames, type SchedulingActor, type SchedulingEvent, type SchedulingEventListener } from "./events.js";
import { expirePendingRequests } from "./expiry.js";
import {
  createThrottle,
  HttpError,
  isCrossSiteRequest,
  NOT_FOUND_MESSAGE,
  readJsonBody,
  safeDecode,
  toWireError,
} from "./http.js";
import { labelDate, todayIn, visitInstants } from "./instants.js";
import { getBookingRow, getResourceRow } from "./internal.js";
import { createHaversineMapsProvider, type MapsProvider } from "./maps.js";
import { minutesToTime, timeToMinutes } from "./math.js";
import { adminStatus, type DeliveryStatus } from "./notices.js";
import { findAvailableSlots } from "./offer.js";
import type { SchedulingPermission } from "./permissions.js";
import {
  createResource,
  deactivateResource,
  listResources,
  reactivateResource,
  toAdminResource,
  updateResource,
} from "./resources.js";
import { schedulingBookings } from "./schema.js";
import { findService } from "./services.js";
import { getSchedulingSettings, toSettingsWire, updateSchedulingSettings, type SchedulingSettings } from "./settings.js";
import { toVisitSnapshot } from "./snapshot.js";
import { clock12 } from "./words.js";
import { STAFF_SETTABLE_STATUSES } from "./status.js";
import { BookingNotBookableError, endTimeSchema, timeOfDaySchema, type BookingRow, type SchedulingDb } from "./types.js";
import {
  assignBooking,
  bookVisit,
  rescheduleBooking,
  setBookingStatus,
  updateBookingDetails,
} from "./visits.js";
import type {
  AvailabilityResponse,
  CalendarResponse,
  CrewDayResponse,
  AdminResource,
  ExpireResponse,
  PersonOption,
  StaffSlot,
  SuggestResponse,
  TimeOffResponse,
  VisitMutationResponse,
  VisitSnapshot,
} from "./wire.js";
import { addDays, isValidDateString } from "./zone.js";

/**
 * The HTTP surface the staff widgets (`<ScheduleCalendar>`, `<CrewDay>`,
 * `<SchedulingSettings>`) speak: every route under `{base}/v1/admin/`, one
 * `handle(req)` routed by path suffix.
 *
 *   // app/api/admin/schedule/[...path]/route.ts
 *   const { handle } = createSchedulingAdminHandlers({ db, tenantId, authorize });
 *   export { handle as GET, handle as POST, handle as OPTIONS };
 *
 * EVERY ROUTE ASKS `authorize(req, permission, tenantId)` for exactly one of
 * the package's permission keys (the table in the contract, section 4.2):
 * `false` is 403, a `Response` (a host's 401) is returned as it is, `true` or
 * `{ userId }` passes — and `userId` is who the event says acted.
 *
 * NEVER CROSS-ORIGIN. No CORS headers, ever, and every POST must pass the
 * same-site check: a staff session cookie must not be usable from another
 * site.
 */

export type AuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** A crew's linked person changed (Schedule settings → Crews → who opens this crew's route). */
export interface CrewMemberChange {
  tenantId: string;
  resource: AdminResource;
  /** The person now linked, or null when the link was cleared. */
  userId: string | null;
  /** Who was linked before, or null. */
  previousUserId: string | null;
  /** The staff member who made the change. */
  changedBy: string | null;
}

export type { DeliveryStatus, ReminderRuns } from "./notices.js";

export interface CreateSchedulingAdminHandlersOptions {
  db: SchedulingDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Your auth: may this request do `permission` for `tenantId`? */
  authorize: (
    req: Request,
    permission: SchedulingPermission,
    tenantId: string,
  ) => AuthorizeResult | Promise<AuthorizeResult>;
  /** Geocoding, drive times and suggestions. Default keyless Haversine; use `selectMapsProvider`. */
  maps?: MapsProvider;
  onEvent?: SchedulingEventListener;
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /**
   * The crew the signed-in person drives with, for "today's route" without a
   * `resource` in the query. Default: the active crew whose `userId` is the
   * authorized `userId`.
   */
  currentResourceId?: (req: Request, tenantId: string, userId: string | null) => string | null | Promise<string | null>;
  /** The calendar route expires overdue requests, at most once a minute per tenant. Default true. */
  sweepExpired?: boolean;
  /**
   * Does anything the office does actually reach a customer? Read by `GET
   * status`, which the calendar and settings show as a banner, and which tells
   * the screens to stop offering "Email the customer" when no email would
   * leave. Default: emails and reminders on exactly when `onEvent` is given.
   * A host with comms passes the truth: is the sender configured, is the cron
   * scheduled, when does it run, did recent sends fail.
   */
  delivery?: (tenantId: string) => DeliveryStatus | Promise<DeliveryStatus>;
  /**
   * The people who can sign in, for "who opens this crew's route" in Schedule
   * settings: a picker of names instead of a box asking an owner for an
   * internal user id they have never seen. Without it the screen falls back to
   * typing the id.
   */
  listPeople?: (req: Request, tenantId: string) => PersonOption[] | Promise<PersonOption[]>;
  /**
   * Told after a crew's linked person changes. The host gives the person what
   * a crew member needs — create-app grants a crew-only staff role (today's
   * route, start and complete, nothing else) to somebody who holds none, and
   * takes it back when they're linked to no crew — so an owner can bring a
   * crew member on from Schedule settings without a developer.
   */
  onCrewMemberChange?: (change: CrewMemberChange, req: Request) => void | Promise<void>;
  now?: () => Date;
}

export interface SchedulingAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

type RouteKind =
  | "calendar"
  | "crew-day"
  | "health"
  | "people"
  | "progress"
  | "suggest"
  | "visit-create"
  | "visit-get"
  | "accept"
  | "decline"
  | "status"
  | "reschedule"
  | "assign"
  | "details"
  | "expire"
  | "settings-get"
  | "settings-update"
  | "resources-list"
  | "resource-create"
  | "resource-update"
  | "resource-deactivate"
  | "resource-reactivate"
  | "availability-get"
  | "availability-set"
  | "time-off-add"
  | "time-off-remove";

interface AdminRoute {
  kind: RouteKind;
  id?: string;
  exceptionId?: string;
}

/** The permission each route asks for — the contract's table, as data (the tests read it back). */
export const SCHEDULING_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<RouteKind, SchedulingPermission>> = {
  calendar: "schedule.view",
  // A crew member's own day. Another crew's day ALSO needs schedule.view
  // (asked in the route), so a crew-only login sees its own stops and no one
  // else's customers.
  "crew-day": "schedule.route",
  health: "schedule.view",
  people: "schedule.resources.manage",
  // Start / complete / couldn't-do / undo on a stop of the caller's OWN crew;
  // any other crew's stop also needs schedule.manage (asked in the route).
  progress: "schedule.route",
  suggest: "schedule.view",
  "visit-create": "schedule.manage",
  "visit-get": "schedule.view",
  accept: "schedule.manage",
  decline: "schedule.manage",
  status: "schedule.manage",
  reschedule: "schedule.manage",
  assign: "schedule.manage",
  details: "schedule.manage",
  expire: "schedule.manage",
  "settings-get": "schedule.view",
  "settings-update": "schedule.resources.manage",
  "resources-list": "schedule.view",
  "resource-create": "schedule.resources.manage",
  "resource-update": "schedule.resources.manage",
  "resource-deactivate": "schedule.resources.manage",
  "resource-reactivate": "schedule.resources.manage",
  "availability-get": "schedule.view",
  "availability-set": "schedule.resources.manage",
  "time-off-add": "schedule.resources.manage",
  "time-off-remove": "schedule.resources.manage",
};

function route(method: string, pathname: string): AdminRoute | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/").map(safeDecode);
  if (parts.some((part) => part === "")) return null;
  const [head, id, action, exceptionId, last] = parts;
  const get = method === "GET";
  const post = method === "POST";
  switch (head) {
    case "calendar":
      return get && parts.length === 1 ? { kind: "calendar" } : null;
    case "crew-day":
      return get && parts.length === 1 ? { kind: "crew-day" } : null;
    case "suggest":
      return get && parts.length === 1 ? { kind: "suggest" } : null;
    case "expire":
      return post && parts.length === 1 ? { kind: "expire" } : null;
    case "status":
      return get && parts.length === 1 ? { kind: "health" } : null;
    case "people":
      return get && parts.length === 1 ? { kind: "people" } : null;
    case "settings":
      if (parts.length !== 1) return null;
      return get ? { kind: "settings-get" } : post ? { kind: "settings-update" } : null;
    case "visits": {
      if (parts.length === 1) return post ? { kind: "visit-create" } : null;
      if (parts.length === 2) return get ? { kind: "visit-get", id: id as string } : null;
      if (parts.length === 3 && post) {
        const kinds: Record<string, RouteKind> = {
          accept: "accept",
          decline: "decline",
          status: "status",
          reschedule: "reschedule",
          assign: "assign",
          details: "details",
          progress: "progress",
        };
        const kind = kinds[action as string];
        return kind ? { kind, id: id as string } : null;
      }
      return null;
    }
    case "resources": {
      if (parts.length === 1) return get ? { kind: "resources-list" } : post ? { kind: "resource-create" } : null;
      if (parts.length === 2) return post ? { kind: "resource-update", id: id as string } : null;
      if (parts.length === 3) {
        if (action === "deactivate" && post) return { kind: "resource-deactivate", id: id as string };
        if (action === "reactivate" && post) return { kind: "resource-reactivate", id: id as string };
        if (action === "availability") {
          return get ? { kind: "availability-get", id: id as string } : post ? { kind: "availability-set", id: id as string } : null;
        }
        if (action === "time-off" && post) return { kind: "time-off-add", id: id as string };
        return null;
      }
      if (parts.length === 5 && action === "time-off" && last === "remove" && post) {
        return { kind: "time-off-remove", id: id as string, exceptionId: exceptionId as string };
      }
      return null;
    }
    default:
      return null;
  }
}

// --- Bodies (wire names, so issue paths are the widget's field names) ---------

const dateString = z.string().refine(isValidDateString, "Use a date like 2026-11-02.");
const notify = z.boolean().optional();

const createVisitBodySchema = z.object({
  resourceId: z.string().min(1).max(200).nullable(),
  date: dateString,
  startTime: timeOfDaySchema,
  endTime: endTimeSchema.optional(),
  service: z.string().trim().min(1).max(40).optional(),
  title: z.string().max(200).optional(),
  customerName: z.string().max(200).optional(),
  customerEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().email("Enter an email address.").max(320).optional(),
  ),
  customerPhone: z.string().max(60).optional(),
  address: z.string().max(500).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  notes: z.string().max(2000).optional(),
  estimateId: z.string().max(200).optional(),
  status: z.enum(["pending", "confirmed"]).optional(),
  notify,
});
const acceptBodySchema = z.object({ notify });
const declineBodySchema = z.object({ reason: z.string().trim().max(500).optional(), notify });
const statusBodySchema = z.object({ status: z.enum(STAFF_SETTABLE_STATUSES), reason: z.string().trim().max(500).optional(), notify });
const rescheduleBodySchema = z.object({
  date: dateString,
  startTime: timeOfDaySchema,
  endTime: endTimeSchema.optional(),
  resourceId: z.string().min(1).max(200).optional(),
  notify,
});
const assignBodySchema = z.object({ resourceId: z.string().min(1).max(200), notify });
const progressBodySchema = z.object({
  status: z.enum(["in_progress", "completed", "no_show", "confirmed"]),
  note: z.string().trim().max(500).optional(),
});

/**
 * The moves a crew may make on its own stop, by target: what each can come
 * from. Start (confirmed → in progress), complete, "couldn't do it" (a no-show,
 * with a note), and the undo of each — a fat-fingered Complete used to mean
 * calling the office.
 */
const CREW_MOVES: Readonly<Record<"in_progress" | "completed" | "no_show" | "confirmed", readonly string[]>> = {
  in_progress: ["confirmed", "completed"],
  completed: ["in_progress"],
  no_show: ["confirmed", "in_progress"],
  confirmed: ["in_progress", "no_show"],
};
const weeklyBodySchema = z.object({
  weekly: z
    .array(z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: timeOfDaySchema, endTime: endTimeSchema }))
    .max(50, "Up to 50 windows a week."),
});
const timeOffBodySchema = z.object({ from: dateString, to: dateString, note: z.string().max(300).optional() });

const CREATE_VISIT_RENAMES = { scheduledDate: "date", serviceType: "service" } as const;

export function createSchedulingAdminHandlers(options: CreateSchedulingAdminHandlersOptions): SchedulingAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createSchedulingAdminHandlers: pass tenantId or resolveTenant");
  }
  if (typeof options.authorize !== "function") {
    throw new Error("createSchedulingAdminHandlers: pass authorize (your permission check)");
  }
  const maps = options.maps ?? createHaversineMapsProvider();
  const clock = () => options.now?.() ?? new Date();
  const sweep = createThrottle(60_000);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
  }
  function failure(error: unknown, renames: Record<string, string> = {}): Response {
    const wire = toWireError(error, renames);
    return json({ error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } }, wire.status);
  }
  const notFound = () => new HttpError("not_found", NOT_FOUND_MESSAGE);

  async function snapshotsOf(tenantId: string, settings: SchedulingSettings, rows: BookingRow[]): Promise<VisitSnapshot[]> {
    const names = await resourceNames(options.db, tenantId, rows.map((row) => row.resourceId));
    return rows.map((row) =>
      toVisitSnapshot(row, { settings, resourceName: row.resourceId ? (names.get(row.resourceId) ?? null) : null }),
    );
  }
  async function snapshotOf(tenantId: string, settings: SchedulingSettings, row: BookingRow): Promise<VisitSnapshot> {
    return (await snapshotsOf(tenantId, settings, [row]))[0] as VisitSnapshot;
  }

  async function defaultCrew(req: Request, tenantId: string, userId: string | null): Promise<string | null> {
    if (options.currentResourceId) return options.currentResourceId(req, tenantId, userId);
    if (!userId) return null;
    const crews = await listResources(options.db, tenantId);
    // As text on both sides: a host whose user ids are integers stores
    // "42" on the crew and may hand back 42 from `authorize`.
    return crews.find((crew) => crew.userId !== null && String(crew.userId) === String(userId))?.id ?? null;
  }

  /** Requests and confirmed visits still to come: what a time-zone change would move. */
  async function upcomingVisits(tenantId: string, now: Date, today: string): Promise<number> {
    const b = schedulingBookings;
    const [row] = await options.db
      .select({ count: sql<number>`count(*)::int` })
      .from(b)
      .where(
        and(
          eq(b.tenantId, tenantId),
          inArray(b.status, ["pending", "confirmed"]),
          or(gt(b.startsAt, now), and(isNull(b.startsAt), gte(b.scheduledDate, labelDate(today)))),
        ),
      );
    return Number(row?.count ?? 0);
  }

  async function crewMemberChanged(
    req: Request,
    tenantId: string,
    resource: AdminResource,
    previousUserId: string | null,
    changedBy: string | null,
  ): Promise<void> {
    if (!options.onCrewMemberChange || (resource.userId ?? null) === previousUserId) return;
    await options.onCrewMemberChange(
      { tenantId, resource, userId: resource.userId ?? null, previousUserId, changedBy },
      req,
    );
  }

  async function dispatch(
    req: Request,
    matched: AdminRoute,
    tenantId: string,
    userId: string | null,
    may: (permission: SchedulingPermission) => Promise<boolean>,
  ): Promise<Response> {
    const db = options.db;
    const now = clock();
    const settings = await getSchedulingSettings(db, tenantId);
    const actor: SchedulingActor = { type: "staff", id: userId };
    const events = {
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    };
    const params = new URL(req.url).searchParams;
    const today = todayIn(now, settings.timeZone);
    const id = matched.id ?? "";

    const mutation = async (result: { visit: BookingRow; warnings: string[] } | null): Promise<Response> => {
      if (!result) throw notFound();
      const body: VisitMutationResponse = { visit: await snapshotOf(tenantId, settings, result.visit), warnings: result.warnings };
      return json(body);
    };
    // CONTRACT: `notify` "defaults to true on every mutation body". A body
    // that omits it passes nothing, and each event takes its own default:
    // true for everything a customer hears about, false for started and
    // completed — so marking a visit in progress never emails the customer.
    const statusMove = async (status: (typeof STAFF_SETTABLE_STATUSES)[number], reason: string | undefined, notifyCustomer: boolean | undefined) => {
      const ok = await setBookingStatus(
        db,
        tenantId,
        { id, status, ...(reason !== undefined ? { reason } : {}) },
        { maps, now, settings, actor, ...events, ...(notifyCustomer !== undefined ? { notify: notifyCustomer } : {}) },
      );
      if (!ok) throw notFound();
      const row = await getBookingRow(db, tenantId, id);
      if (!row) throw notFound();
      return json({ visit: await snapshotOf(tenantId, settings, row) });
    };
    const summary = async (resourceId: string): Promise<AvailabilityResponse> => {
      const resource = await getResourceRow(db, tenantId, resourceId);
      if (!resource) throw notFound();
      return availabilitySummaryOf(resource, await listAvailability(db, tenantId, resourceId), today);
    };

    switch (matched.kind) {
      case "calendar": {
        // CONTRACT: a missing `from` is today and a missing `to` is a week on
        // (crew-day's `date` defaults to today, suggest's `days` to 7).
        const from = params.get("from") || today;
        const to = params.get("to") || addDays(isValidDateString(from) ? from : today, 6);
        const resources = (params.get("resources") ?? "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        if (options.sweepExpired !== false) {
          await sweep(tenantId, now.getTime(), () => expirePendingRequests(db, tenantId, { now, settings, ...events }));
        }
        const calendar: CalendarResponse = await listCalendar(
          db,
          tenantId,
          {
            from,
            to,
            ...(resources.length > 0 ? { resourceIds: resources } : {}),
            includeInactive: params.get("include") === "inactive",
          },
          { now, settings },
        );
        return json(calendar);
      }
      case "crew-day": {
        const date = params.get("date") || today;
        const own = await defaultCrew(req, tenantId, userId);
        const resource = params.get("resource") || own;
        if (!resource) throw new HttpError("invalid", "Pick a crew.", [{ path: ["resource"], message: "Pick a crew." }]);
        if (resource !== own && !(await may("schedule.view"))) {
          throw new HttpError("forbidden", "You can open your own crew's route only.");
        }
        const day: CrewDayResponse | null = await listCrewDay(db, tenantId, { resourceId: resource, date }, { maps, now, settings });
        if (!day) throw notFound();
        return json(day);
      }
      case "suggest": {
        const serviceKey = params.get("service") || null;
        const rawMinutes = params.get("minutes");
        let durationMinutes: number;
        let requiredSkill: string | null = null;
        if (serviceKey) {
          const service = findService(settings.services, serviceKey);
          if (!service) throw new BookingNotBookableError("No such service.", "unknown_service");
          durationMinutes = service.durationMinutes;
          requiredSkill = service.requiredSkill ?? null;
        } else if (rawMinutes) {
          durationMinutes = Number(rawMinutes);
          if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 720) {
            throw new HttpError("invalid", "Some details need another look.", [
              { path: ["minutes"], message: "Use 5 to 720 minutes." },
            ]);
          }
        } else {
          throw new HttpError("invalid", "Pick a service or a length.", [{ path: ["service"], message: "Pick a service." }]);
        }
        const from = params.get("from") || today;
        if (!isValidDateString(from)) {
          throw new HttpError("invalid", "Some details need another look.", [{ path: ["from"], message: "Use a date like 2026-11-02." }]);
        }
        const days = Math.min(14, Math.max(1, Math.trunc(Number(params.get("days") || 7)) || 7));
        const lat = params.get("lat");
        const lng = params.get("lng");
        const slots = await findAvailableSlots(
          db,
          {
            tenantId,
            jobAddress: params.get("address") || null,
            jobLat: lat !== null && lat !== "" && Number.isFinite(Number(lat)) ? Number(lat) : null,
            jobLng: lng !== null && lng !== "" && Number.isFinite(Number(lng)) ? Number(lng) : null,
            durationMinutes,
            startDate: from,
            endDate: addDays(from, days - 1),
            requiredSkill,
            preferredResourceId: params.get("resource") || null,
            slotStepMinutes: settings.slotStepMinutes,
            notBefore: now,
            now,
          },
          maps,
        );
        const best: StaffSlot[] = slots.slice(0, 20).map((slot) => {
          const { startsAt, endsAt } = visitInstants(slot.date, slot.startTime, slot.endTime, settings.timeZone);
          return {
            date: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            resourceId: slot.resourceId,
            resourceName: slot.resourceName,
            driveMinutesFromPrevious: slot.driveMinutesFromPrevious,
            previousJobAddress: slot.previousJobAddress,
            score: slot.score,
          };
        });
        const body: SuggestResponse = { timeZone: settings.timeZone, estimated: maps.estimates === true, slots: best };
        return json(body);
      }
      case "visit-create": {
        const body = createVisitBodySchema.parse(await readJsonBody(req));
        const service = body.service ? findService(settings.services, body.service) : null;
        if (body.service && !service) throw new BookingNotBookableError("No such service.", "unknown_service");
        let endTime = body.endTime;
        if (!endTime) {
          const end = timeToMinutes(body.startTime) + (service?.durationMinutes ?? 60);
          if (end > 24 * 60) {
            throw new BookingNotBookableError(`A visit starting at ${clock12(body.startTime)} would run past midnight`, "invalid_window");
          }
          endTime = minutesToTime(end);
        }
        const result = await bookVisit(
          db,
          {
            tenantId,
            resourceId: body.resourceId,
            serviceType: service?.key ?? "visit",
            title: body.title ?? null,
            customerName: body.customerName ?? null,
            customerEmail: body.customerEmail ?? null,
            customerPhone: body.customerPhone ?? null,
            address: body.address ?? null,
            lat: body.lat ?? null,
            lng: body.lng ?? null,
            scheduledDate: body.date,
            startTime: body.startTime,
            endTime,
            estimateId: body.estimateId ?? null,
            notes: body.notes ?? null,
            status: body.status ?? "confirmed",
          },
          { maps, now, settings, actor, ...events, ...(body.notify !== undefined ? { notify: body.notify } : {}) },
        );
        const response: VisitMutationResponse = {
          visit: await snapshotOf(tenantId, settings, result.visit),
          warnings: result.warnings,
        };
        return json(response, 201);
      }
      case "visit-get": {
        const row = await getBookingRow(db, tenantId, id);
        if (!row) throw notFound();
        return json({ visit: await snapshotOf(tenantId, settings, row) });
      }
      case "accept": {
        const body = acceptBodySchema.parse(await readJsonBody(req));
        return statusMove("confirmed", undefined, body.notify);
      }
      case "decline": {
        const body = declineBodySchema.parse(await readJsonBody(req));
        return statusMove("declined", body.reason, body.notify);
      }
      case "status": {
        const body = statusBodySchema.parse(await readJsonBody(req));
        return statusMove(body.status, body.reason, body.notify);
      }
      case "reschedule": {
        const body = rescheduleBodySchema.parse(await readJsonBody(req));
        return mutation(
          await rescheduleBooking(
            db,
            tenantId,
            {
              id,
              date: body.date,
              startTime: body.startTime,
              ...(body.endTime ? { endTime: body.endTime } : {}),
              ...(body.resourceId ? { resourceId: body.resourceId } : {}),
            },
            { maps, now, settings, actor, ...events, ...(body.notify !== undefined ? { notify: body.notify } : {}) },
          ),
        );
      }
      case "assign": {
        const body = assignBodySchema.parse(await readJsonBody(req));
        return mutation(
          await assignBooking(
            db,
            tenantId,
            { id, resourceId: body.resourceId },
            { maps, now, settings, actor, ...events, ...(body.notify !== undefined ? { notify: body.notify } : {}) },
          ),
        );
      }
      case "details": {
        const body = await readJsonBody(req);
        const notifyCustomer = typeof body["notify"] === "boolean" ? (body["notify"] as boolean) : undefined;
        return mutation(
          await updateBookingDetails(
            db,
            tenantId,
            { id, patch: body },
            { maps, now, settings, actor, ...events, ...(notifyCustomer !== undefined ? { notify: notifyCustomer } : {}) },
          ),
        );
      }
      case "progress": {
        const body = progressBodySchema.parse(await readJsonBody(req));
        const row = await getBookingRow(db, tenantId, id);
        if (!row) throw notFound();
        const own = await defaultCrew(req, tenantId, userId);
        if ((!own || row.resourceId !== own) && !(await may("schedule.manage"))) {
          throw new HttpError("forbidden", "This stop isn't on your crew's route.");
        }
        if (row.status !== body.status && !CREW_MOVES[body.status].includes(row.status)) {
          throw new HttpError("transition_not_allowed", "That can't be done from the stop's current state. Refresh the route.");
        }
        // Never emails the customer: starting and finishing are the crew's
        // business, and undoing a mistaken "couldn't do it" must not send a
        // "back on our schedule" email about a visit nobody was told was off.
        const ok = await setBookingStatus(
          db,
          tenantId,
          { id, status: body.status, ...(body.note ? { reason: body.note } : {}) },
          { maps, now, settings, actor, ...events, notify: false },
        );
        if (!ok) throw notFound();
        const after = await getBookingRow(db, tenantId, id);
        if (!after) throw notFound();
        return json({ visit: await snapshotOf(tenantId, settings, after) });
      }
      case "health": {
        const delivery: DeliveryStatus = options.delivery
          ? await options.delivery(tenantId)
          : { customerEmails: Boolean(options.onEvent), reminders: Boolean(options.onEvent) };
        return json(adminStatus(settings, delivery, await upcomingVisits(tenantId, now, today), now));
      }
      case "people": {
        const people = options.listPeople ? await options.listPeople(req, tenantId) : null;
        return json({
          people: people
            ? people.map((person) => ({
                userId: String(person.userId),
                name: person.name ?? null,
                email: person.email ?? null,
              }))
            : null,
        });
      }
      case "expire": {
        const result = await expirePendingRequests(db, tenantId, { now, settings, ...events });
        return json({ expired: result.expired } satisfies ExpireResponse);
      }
      case "settings-get":
        return json({ settings: toSettingsWire(settings) });
      case "settings-update": {
        const body = await readJsonBody(req);
        // Not a setting: whether to email upcoming visits' customers about a
        // time-zone correction (the settings screen asks when there are any).
        const notifyCustomers = body["notifyCustomers"] === true;
        const saved = await updateSchedulingSettings(db, tenantId, body, {
          now,
          actor,
          ...events,
          ...(notifyCustomers ? { notify: true } : {}),
        });
        return json({ settings: toSettingsWire(saved) });
      }
      case "resources-list": {
        const rows = await listResources(db, tenantId, { includeInactive: params.get("include") === "inactive" });
        return json({ resources: rows.map(toAdminResource) });
      }
      case "resource-create": {
        const body = await readJsonBody(req);
        const row = await createResource(db, { ...body, tenantId } as Parameters<typeof createResource>[1], { maps });
        const resource = toAdminResource(row);
        await crewMemberChanged(req, tenantId, resource, null, userId);
        return json({ resource }, 201);
      }
      case "resource-update": {
        const before = await getResourceRow(db, tenantId, id);
        if (!before) throw notFound();
        const row = await updateResource(db, tenantId, id, await readJsonBody(req), { maps });
        if (!row) throw notFound();
        const resource = toAdminResource(row);
        await crewMemberChanged(req, tenantId, resource, before.userId ?? null, userId);
        return json({ resource });
      }
      case "resource-deactivate":
      case "resource-reactivate": {
        const ok =
          matched.kind === "resource-deactivate"
            ? await deactivateResource(db, tenantId, id)
            : await reactivateResource(db, tenantId, id);
        const row = ok ? await getResourceRow(db, tenantId, id) : null;
        if (!row) throw notFound();
        return json({ resource: toAdminResource(row) });
      }
      case "availability-get": {
        const body = await getAvailabilitySummary(db, tenantId, id, { now, settings });
        if (!body) throw notFound();
        return json(body);
      }
      case "availability-set": {
        const body = weeklyBodySchema.parse(await readJsonBody(req));
        const ok = await setAvailability(db, {
          tenantId,
          resourceId: id,
          scope: "weekly",
          blocks: body.weekly.map((w) => ({ dayOfWeek: w.dayOfWeek, startTime: w.startTime, endTime: w.endTime })),
        });
        if (!ok) throw notFound();
        return json(await summary(id));
      }
      case "time-off-add": {
        const body = timeOffBodySchema.parse(await readJsonBody(req));
        const added = await addTimeOff(
          db,
          { tenantId, resourceId: id, from: body.from, to: body.to, ...(body.note ? { note: body.note } : {}) },
          { now },
        );
        if (!added) throw notFound();
        const response: TimeOffResponse = {
          ...(await summary(id)),
          visitsOnThoseDays: await snapshotsOf(tenantId, settings, added.visitsOnThoseDays),
        };
        return json(response);
      }
      case "time-off-remove": {
        const ok = await removeTimeOff(db, tenantId, { resourceId: id, exceptionId: matched.exceptionId ?? "" });
        if (!ok) throw notFound();
        return json(await summary(id));
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return failure(new HttpError("forbidden", "This request came from another site, so it was refused."));
    }
    const matched = route(req.method, new URL(req.url).pathname);
    if (!matched) return failure(notFound());
    try {
      const tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, SCHEDULING_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new HttpError("forbidden", "You don't have permission to do that."));
      }
      const raw = typeof verdict === "object" ? (verdict.userId ?? null) : null;
      const userId = raw === null ? null : String(raw);
      // A second permission, for a route that needs one only sometimes
      // (another crew's route, another crew's stop).
      const may = async (permission: SchedulingPermission): Promise<boolean> => {
        const answer = await options.authorize(req, permission, tenantId);
        return answer !== false && answer !== null && answer !== undefined && !(answer instanceof Response);
      };
      return await dispatch(req, matched, tenantId, userId, may);
    } catch (error) {
      return failure(error, matched.kind === "visit-create" ? CREATE_VISIT_RENAMES : {});
    }
  }

  return { handle };
}
