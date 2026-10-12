import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { SchedulingActor, SchedulingEvent, SchedulingEventListener } from "./events.js";
import type { MapsProvider } from "./maps.js";
import type {
  schedulingAvailability,
  schedulingBookings,
  schedulingResources,
  schedulingSettings,
  schedulingVisitTokens,
} from "./schema.js";
import type { SchedulingSettings } from "./settings.js";
import { END_TIME_PATTERN, TIME_OF_DAY_PATTERN } from "./time.js";

/** Any drizzle Postgres handle whose driver supports interactive transactions. */
export type SchedulingDb = PgDatabase<any, any, any>;

export type ResourceRow = typeof schedulingResources.$inferSelect;
export type AvailabilityRow = typeof schedulingAvailability.$inferSelect;
export type BookingRow = typeof schedulingBookings.$inferSelect;
export type SettingsRow = typeof schedulingSettings.$inferSelect;
export type VisitTokenRow = typeof schedulingVisitTokens.$inferSelect;

/**
 * A start or opening time: zero-padded 24-hour "HH:MM", 00:00–23:59. Use it in
 * a host's own inputs so a form's times are checked the way the package checks
 * them ("9:00" and "16:99" are not times).
 */
export const timeOfDaySchema = z.string().regex(TIME_OF_DAY_PATTERN, "Use a 24-hour HH:MM time, like 09:30.");
/** An end or closing time: a time of day, or "24:00" for midnight at the end of the day. */
export const endTimeSchema = z.string().regex(END_TIME_PATTERN, "Use a 24-hour HH:MM time, like 17:00 (24:00 for midnight).");

// --- Refusals --------------------------------------------------------------

/**
 * Why a slot can't be booked or a visit can't be changed, for code to branch
 * on (`error.code`); the message is for a person.
 *
 * THE PUBLIC CODES ARE DELIBERATELY COARSE. `requestPublicBooking` says
 * `slot_unavailable` for "taken", "outside hours", "no time to drive there",
 * "this crew is paused" AND "no such slot in this tenant", so a refusal never
 * tells an anonymous caller whether an id exists or where another visit is.
 * The rest are about the request itself and say so: `too_soon`, `too_far`,
 * `invalid_duration`, `unknown_service`, `address_unresolved` (the provider
 * couldn't place the address, or the business wants one and none came),
 * `too_many_requests` (this requester already has the limit of requests
 * waiting) and `booking_closed` (the business has online booking off).
 *
 * THE CUSTOMER'S OWN VISIT says `too_late` when it is inside the change
 * cutoff, past, or already done — the message gives the business's phone.
 *
 * THE STAFF PATHS SAY MORE, because staff can act on it. `slot_unavailable`
 * only when another visit is in the way — an overlap, a drive that doesn't
 * fit, a day already at its cap — and `outside_hours`, `invalid_window` (the
 * end isn't after the start, or the visit would cross midnight),
 * `resource_unavailable` (no such crew, or removed) and `not_changeable` (the
 * visit's status doesn't allow a move) for the rest. A host answers
 * `slot_unavailable` with "pick another time"; given to a 03:00 booking that
 * can never succeed, that answer loops.
 */
export type BookingRefusalCode =
  | "slot_unavailable"
  | "too_soon"
  | "too_far"
  | "invalid_duration"
  | "address_unresolved"
  | "too_many_requests"
  | "outside_hours"
  | "invalid_window"
  | "resource_unavailable"
  | "booking_closed"
  | "unknown_service"
  | "too_late"
  | "not_changeable";

/** The codes a staff-path refusal carries (see `BookingRefusalCode`). */
export type StaffRefusalCode = "slot_unavailable" | "outside_hours" | "invalid_window" | "resource_unavailable";

export class BookingNotBookableError extends Error {
  readonly name = "BookingNotBookableError";
  readonly code: BookingRefusalCode;
  constructor(reason: string, code: BookingRefusalCode = "slot_unavailable") {
    super(reason);
    this.code = code;
  }
}

/** A status move BOOKING_STATUS_TRANSITIONS doesn't allow (completed → pending, say). */
export class BookingStatusTransitionError extends Error {
  readonly name = "BookingStatusTransitionError";
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`A visit can't move from ${from} to ${to}.`);
  }
}

export const SLOT_UNAVAILABLE = "That time is no longer available. Please pick another.";

/** A validation failure raised by hand, shaped like the ones zod raises (so handlers map it to `invalid`). */
export function invalidInput(path: Array<string | number>, message: string): z.ZodError {
  return new z.ZodError([{ code: "custom", path, message, input: undefined }]);
}

// --- The options every writer takes a subset of ----------------------------

/**
 * The common write options. Every writer takes the fields it uses.
 *
 * `settings` lets a caller that has already read the tenant's settings (the
 * handlers read them once per request) skip the read. `now` is read once per
 * call: notice, the change cutoff, expiry and event times all use the same
 * instant.
 */
export interface SchedulingWriteOptions {
  /** Geocoding and drive times. Default: `createHaversineMapsProvider()`. */
  maps?: MapsProvider;
  /** Called after commit for each event this call produced (see events.ts). */
  onEvent?: SchedulingEventListener;
  /** Told about a listener that threw or rejected. The action itself never fails for it. */
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /** Who did it. Default per function: customer (token routes), staff (staff writers), system (expiry). */
  actor?: SchedulingActor;
  /** Should the customer be told? Default per event type (see events.ts). */
  notify?: boolean;
  /** The clock, read once per call. Default `new Date()`. */
  now?: Date;
  /** The tenant's settings, already read. Default: read them. */
  settings?: SchedulingSettings;
}
