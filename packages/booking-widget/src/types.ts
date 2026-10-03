/**
 * The wire contract with an AdminIgloo booking server (`@adminigloo/booking`'s
 * `createBookingHandlers`), declared HERE rather than imported.
 *
 * The widget deliberately does not depend on the server package: a buyer's
 * marketing site that embeds the widget against a booking API hosted somewhere
 * else should not install drizzle, zod and a Postgres driver to render a time
 * picker. The cost is that these shapes must be kept in step with the server's
 * by hand — they mirror the spec's "HTTP handler factory" section field for
 * field, and any change to either side is a wire change.
 *
 * All instants on the wire are ISO-8601 strings in UTC. Nothing here is a
 * wall-clock time: what a person reads is cut from the instant in whatever zone
 * they are viewing (see time.ts), which is how a scheduler stays right across
 * time zones and daylight-saving changes.
 */

/** How the call happens. */
export type Medium = "video" | "phone" | "prospect_hosted";

/** Every status a booking row can carry. A public read never returns `hold`. */
export type BookingStatus =
  | "hold"
  | "requested"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

/** Whether the host's external calendar was consulted for a slot list. */
export type BusySync = "ok" | "degraded" | "off";

/** The error codes the server answers with, and their HTTP statuses. */
export type BookingErrorCode =
  | "not_found" // 404
  | "slot_taken" // 409
  | "hold_expired" // 409
  | "already_booked" // 409 — the same form arrived twice; the first one booked
  | "invalid" // 400, with `issues`
  | "rate_limited" // 429
  | "unlicensed"; // 402

/**
 * One bookable thing, as `GET {base}/v1/config` lists it.
 *
 * Fields marked optional arrived after the first cut of the contract; a
 * server that predates them simply leaves them out, and the widget falls
 * back to inferring what it needs (see each field).
 */
export interface PublicBookingType {
  key: string;
  name: string;
  /** The spec leaves nullability open; the widget treats null and "" alike. */
  description: string | null;
  durationMinutes: number;
  media: Medium[];
  /** No start sooner than this many minutes after now. */
  minNoticeMinutes?: number;
  /**
   * Whole days ahead that can be booked, in the host's zone, today included.
   * The date strip runs exactly this far; without it the strip ends at the
   * last day that has a time.
   */
  horizonDays?: number;
}

/** `GET {base}/v1/config` */
export interface BookingConfig {
  sandbox: boolean;
  hostDisplayName: string;
  hostTimezone: string;
  types: PublicBookingType[];
  /**
   * The country calling code ("1") a phone number typed without "+" is read
   * in. Absent: the "+" and country code are required. The widget's
   * `defaultCallingCode` prop overrides it.
   */
  defaultCallingCode?: string;
  /**
   * Whether the server sends email at all (confirmations, reminders). Absent
   * means true — the old behaviour. False turns every "check your email"
   * into a pointer the visitor can actually follow: the manage link shown
   * as a copyable field, or `contactEmail`.
   */
  emailsEnabled?: boolean;
  /** A human fallback address the host app chooses to show; null or absent when it shows none. */
  contactEmail?: string | null;
}

/** One open start time. */
export interface Slot {
  start: string;
  end: string;
}

/**
 * `GET {base}/v1/slots?type=KEY&from=ISO&to=ISO[&manage=TOKEN]` — `manage`
 * (a reschedule) makes the invitee's own booking stop counting as busy, so
 * times next to it are offered. A server that predates it ignores it.
 */
export interface SlotsResponse {
  slots: Slot[];
  busySync: BusySync;
}

/** `POST {base}/v1/hold` */
export interface HoldRequest {
  type: string;
  start: string;
  /** The caller's previous hold, released in the same transaction. */
  previousHoldToken?: string;
  /**
   * Holding a new time for an existing booking (a reschedule): its manage
   * token, so the booking being moved does not block the hold. A token that
   * opens no booking answers `not_found`.
   */
  manageToken?: string;
}

export interface HoldResponse {
  holdToken: string;
  expiresAt: string;
  start: string;
  end: string;
}

/** `POST {base}/v1/hold/release` → `{ ok: true }` */
export interface ReleaseRequest {
  holdToken: string;
}

/** `POST {base}/v1/book` */
export interface BookRequest {
  type: string;
  start: string;
  holdToken?: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  notes?: string;
  medium: Medium;
  /** The IANA zone the invitee chose to see times in. */
  timezone: string;
  source?: string;
}

export interface BookResponse {
  booking: PublicBooking;
  manageToken: string;
  manageUrl: string;
}

/** `POST {base}/v1/manage/:token/cancel` */
export interface CancelRequest {
  reason?: string;
}

/** `POST {base}/v1/manage/:token/reschedule` */
export interface RescheduleRequest {
  start: string;
  holdToken?: string;
}

/** `GET {base}/v1/manage/:token`, and the cancel/reschedule responses. */
export interface ManageResponse {
  booking: PublicBooking;
}

/** The invitee-safe view of a booking. Never carries tokens or host email. */
export interface PublicBooking {
  status: BookingStatus;
  start: string;
  end: string;
  typeName: string;
  /**
   * The booking type's key, for the reschedule picker's slots and holds.
   * Absent from servers that predate it (the widget then matches the type by
   * name and duration); "" when the server no longer has the type.
   */
  typeKey?: string;
  durationMinutes: number;
  hostDisplayName: string;
  hostTimezone: string;
  inviteeName: string;
  inviteeTimezone: string;
  medium: Medium;
  /** video: the host's link; otherwise null. */
  meetingLink: string | null;
  /** phone: the caller ID the call will come from; otherwise null. */
  hostPhone: string | null;
  /** prospect_hosted: the mailbox to send the invite to; otherwise null. */
  inviteMailbox: string | null;
  googleCalendarUrl: string;
  canCancel: boolean;
  canReschedule: boolean;
  sandbox: boolean;
}

/** Every non-2xx JSON body. */
export interface BookingErrorBody {
  error: {
    code: BookingErrorCode;
    message: string;
    /** Present on `invalid`. Shape not pinned by the spec — see requests.ts. */
    issues?: unknown;
  };
}
