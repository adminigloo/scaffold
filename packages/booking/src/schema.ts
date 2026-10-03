import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * The booking data model. Every table carries a plain-text `tenant_id` and
 * every query in this package filters on it — that, and nothing cleverer, is
 * what makes a per-visitor sandbox tenant safe to hand to an anonymous
 * stranger on a marketing page. No FK to a tenants table (it lives in
 * @adminigloo/tenancy and an install may not have it); FKs only inside this
 * package, where a child row is meaningless without its parent.
 *
 * Wall clock vs instant: availability rows are wall-clock minutes in the
 * HOST's zone (that is how a person describes their week); bookings are UTC
 * instants (that is what every conflict check compares). The host zone is
 * also copied onto each booking so a host who moves zones does not rewrite
 * how past calls read.
 *
 * Secrets are stored as SHA-256 hex only — hold, manage and feed tokens alike.
 * The plaintext exists in exactly one response; a leaked dump yields nothing
 * that opens a booking.
 */

export type BookingMedium = "video" | "phone" | "prospect_hosted";
export type BookingStatus = "hold" | "requested" | "confirmed" | "cancelled" | "completed" | "no_show";
export type BookingExceptionKind = "off" | "hours" | "block";
export type BookingActor = "invitee" | "host" | "system";
export type BookingEventKind = "held" | "booked" | "confirmed" | "cancelled" | "rescheduled" | "outcome";

/** A person who takes calls, in their own IANA zone. */
export const bookingHosts = pgTable(
  "booking_hosts",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    displayName: text("display_name").notNull(),
    /** Where host notices go. Never returned by a public route. */
    email: text("email").notNull(),
    /** IANA zone, validated with Intl on every write. */
    timezone: text("timezone").notNull(),
    /** The host's standing video link (Zoom, Meet, Teams), for `video` calls. */
    meetingLink: text("meeting_link"),
    /** Caller ID for `phone` calls ("the call will come from …"), E.164. */
    phone: text("phone"),
    /** Where a prospect sends their own invite for `prospect_hosted` calls; null → email. */
    inviteMailbox: text("invite_mailbox"),
    /**
     * The host's secret iCal address (Google: Settings → Integrate calendar →
     * "Secret address in iCal format"). A bearer secret to their whole
     * calendar: never returned by a public route, masked in admin reads.
     */
    busyIcsUrl: text("busy_ics_url"),
    /** SHA-256 of the per-host subscribable feed token; rotating it kills old subscriptions. */
    feedTokenHash: text("feed_token_hash"),
    /** true → bookings land `confirmed`; false → `requested`, awaiting the host. */
    autoConfirm: boolean("auto_confirm").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Calendar-sync health (an addition to the 0.1 spec's column list, needed
     * to honour its "Calendar sync failing since …" requirement). Written only
     * when the state CHANGES, never on every slot read.
     */
    busySyncError: text("busy_sync_error"),
    busySyncFailingSince: timestamp("busy_sync_failing_since", { withTimezone: true }),
    busySyncOkAt: timestamp("busy_sync_ok_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("booking_hosts_tenant_idx").on(t.tenantId),
    uniqueIndex("booking_hosts_feed_token_idx").on(t.feedTokenHash),
  ],
);

/** Weekly hours: wall-clock minutes in the host's zone, on the 15-minute grid. */
export const bookingAvailability = pgTable(
  "booking_availability",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => bookingHosts.id, { onDelete: "cascade" }),
    /** 0 = Sunday … 6 = Saturday. */
    dayOfWeek: integer("day_of_week").notNull(),
    /** 0..1440, multiples of 15, start < end. */
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("booking_availability_host_idx").on(t.tenantId, t.hostId)],
);

/**
 * Dated overrides on the host's wall clock. Precedence (engine.resolveWindows):
 * 'off' wins outright; any 'hours' rows REPLACE the weekly windows for that
 * date; 'block' rows are then subtracted.
 */
export const bookingExceptions = pgTable(
  "booking_exceptions",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => bookingHosts.id, { onDelete: "cascade" }),
    /** The host-zone calendar date, YYYY-MM-DD. */
    date: date("date", { mode: "string" }).notNull(),
    kind: text("kind").$type<BookingExceptionKind>().notNull(),
    /** Null for 'off'. */
    startMinute: integer("start_minute"),
    endMinute: integer("end_minute"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("booking_exceptions_host_date_idx").on(t.tenantId, t.hostId, t.date)],
);

/** Tenant-wide dates nobody is bookable (holidays). */
export const bookingBlackouts = pgTable(
  "booking_blackouts",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("booking_blackouts_tenant_date_idx").on(t.tenantId, t.date)],
);

/** What can be booked — in 0.1 usually one row, "Intro call". */
export const bookingTypes = pgTable(
  "booking_types",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** Stable, URL-safe, unique per tenant: what the widget asks for. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    /** Slot grid, measured from each window's start. */
    stepMinutes: integer("step_minutes").notNull().default(30),
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(240),
    /** Whole host-zone days ahead that can be booked, today included. */
    horizonDays: integer("horizon_days").notNull().default(21),
    /** Live bookings of this type per host per day; null = uncapped. */
    maxPerDay: integer("max_per_day"),
    /** Subset of video | phone | prospect_hosted, in the order offered. */
    media: text("media").array().$type<BookingMedium[]>().notNull().default(sql`ARRAY['video']::text[]`),
    /** Host ids that take this type; empty = every active host. */
    hostIds: text("host_ids").array().$type<string[]>().notNull().default(sql`ARRAY[]::text[]`),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("booking_types_tenant_key_idx").on(t.tenantId, t.key)],
);

/**
 * A call — or, while status is 'hold', a ten-minute claim on one. An expired
 * hold is simply a 'hold' row past `holdExpiresAt`: ignored by every busy
 * check and deleted by purgeExpiredHolds, never counted as a cancellation
 * (Squire's abandoned holds inflated its cancellation numbers).
 *
 * A reschedule moves THIS row (new start/end, sequence + 1); the manage token
 * and the .ics UID never change — D2's fix.
 */
export const bookingBookings = pgTable(
  "booking_bookings",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    typeId: text("type_id").notNull(),
    hostId: text("host_id").notNull(),
    status: text("status").$type<BookingStatus>().notNull(),
    /** The meeting itself — buffers are never folded into these. */
    startUtc: timestamp("start_utc", { withTimezone: true }).notNull(),
    endUtc: timestamp("end_utc", { withTimezone: true }).notNull(),
    hostTimezone: text("host_timezone").notNull(),
    inviteeTimezone: text("invitee_timezone"),
    /**
     * The hold's token hash. KEPT once the hold becomes a booking, so a
     * second submit of the same form answers `already_booked` instead of
     * "your hold expired". Every release/purge/convert by hold token also
     * requires status 'hold', so a booked row is never touched through it.
     */
    holdTokenHash: text("hold_token_hash"),
    /** Set only while status is 'hold'. */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    /**
     * SHA-256 of who placed the hold, as the host app's `holdSubject` named
     * them (usually the client IP's rate-limit key), so one requester cannot
     * hold more than `maxHoldsPerSubject` times at once and blank the
     * calendar. Hashed, not stored in the clear — though an IP's hash is
     * brute-forceable, so treat it as personal data all the same. Set only
     * while status is 'hold'; cleared when the hold becomes a booking.
     */
    holdSubjectHash: text("hold_subject_hash"),
    /** Null until booked. The plaintext was returned once, in the book response. */
    manageTokenHash: text("manage_token_hash"),
    inviteeName: text("invitee_name"),
    inviteeEmail: text("invitee_email"),
    inviteePhone: text("invitee_phone"),
    inviteeCompany: text("invitee_company"),
    notes: text("notes"),
    medium: text("medium").$type<BookingMedium>(),
    /** utm/src the widget passed, scrubbed of anything person- or token-shaped, ≤ 100. */
    source: text("source"),
    /** The .ics SEQUENCE: bumped on every reschedule and cancellation. */
    sequence: integer("sequence").notNull().default(0),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").$type<BookingActor>(),
    cancelReason: text("cancel_reason"),
    outcome: text("outcome"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("booking_bookings_host_start_idx").on(t.tenantId, t.hostId, t.startUtc),
    index("booking_bookings_status_start_idx").on(t.tenantId, t.status, t.startUtc),
    index("booking_bookings_hold_expiry_idx").on(t.tenantId, t.holdExpiresAt),
    index("booking_bookings_hold_token_idx").on(t.tenantId, t.holdTokenHash),
    index("booking_bookings_hold_subject_idx").on(t.tenantId, t.holdSubjectHash),
    uniqueIndex("booking_bookings_manage_token_idx").on(t.manageTokenHash),
  ],
);

/**
 * Append-only audit of what invitees, hosts and the system did. `detail`
 * NEVER holds a token or the invitee's notes — the row is for "what happened
 * when", and it outlives the booking's personal data.
 */
export const bookingEvents = pgTable(
  "booking_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: text("tenant_id").notNull(),
    bookingId: text("booking_id").notNull(),
    kind: text("kind").$type<BookingEventKind>().notNull(),
    actor: text("actor").$type<BookingActor>().notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("booking_events_booking_idx").on(t.tenantId, t.bookingId, t.at)],
);
