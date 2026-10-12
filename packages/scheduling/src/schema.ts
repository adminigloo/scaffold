import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";
import type { SchedulingService } from "./services.js";

/**
 * The scheduler's data model — generalized from the SG Glass scheduler so it
 * fits any mobile-service business (a "resource" is a person or crew, not an
 * "installer"). Coordinates are `doublePrecision` (they are geo, not money);
 * times of day are "HH:MM" text as the pure math expects; `tenantId`/`resourceId`
 * are plain text with no cross-package FK, the house rule every schema follows.
 */

/** A schedulable person or crew, with a home base and skills. */
export const schedulingResources = pgTable(
  "scheduling_resources",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    /** The identity-provider user id this resource maps to, if any (plain text). */
    userId: text("user_id"),
    homeBaseAddress: text("home_base_address"),
    homeBaseLat: doublePrecision("home_base_lat"),
    homeBaseLng: doublePrecision("home_base_lng"),
    /** Free-form service tags this resource can do; empty = can do anything. */
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    workStartTime: text("work_start_time").notNull().default("08:00"),
    workEndTime: text("work_end_time").notNull().default("17:00"),
    maxJobsPerDay: integer("max_jobs_per_day").notNull().default(6),
    /**
     * Whether this resource's hours have ever been saved (`setAvailability`).
     * Until they have, it works Mon–Fri during `workStartTime`–`workEndTime`, so
     * a new crew is bookable at once; from then on its saved weekly rows are the
     * whole week, and a weekday with no row is a day off. 0.2 inferred "never
     * set" from "has no rows", so unticking every day and saving — the obvious
     * way to stop a crew — deleted every row and switched it back on Mon–Fri.
     */
    hoursConfigured: boolean("hours_configured").notNull().default(false),
    /**
     * Pause online booking for this resource without touching its hours: staff
     * can still book it, the public finder and request skip it. Separate from
     * `isActive`, which takes the crew off the schedule altogether.
     */
    acceptsPublicBookings: boolean("accepts_public_bookings").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduling_resources_tenant_idx").on(t.tenantId, t.isActive)],
);

/**
 * Availability, recurring or as a dated exception. The discriminator is
 * `specificDate IS NULL`: a null date with a `dayOfWeek` is the weekly pattern;
 * a set date is a one-off (time off, or special hours). `isAvailable=false`
 * blocks the day/window. Whether an EMPTY week means "never set" or "off every
 * day" is the resource's `hoursConfigured`, never the row count.
 */
export const schedulingAvailability = pgTable(
  "scheduling_availability",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id").notNull(),
    /** 0=Sun … 6=Sat for a recurring row; null for a dated exception. */
    dayOfWeek: integer("day_of_week"),
    /** Set only for a dated exception; null for a recurring row. */
    specificDate: timestamp("specific_date", { withTimezone: true }),
    startTime: text("start_time").notNull().default("08:00"),
    endTime: text("end_time").notNull().default("17:00"),
    isAvailable: boolean("is_available").notNull().default(true),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("scheduling_availability_resource_idx").on(t.resourceId)],
);

/** A booked visit. Coordinates come from geocoding the address. */
export const schedulingBookings = pgTable(
  "scheduling_bookings",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id"),
    /** Free-form: "measurement", "installation", "service call". */
    serviceType: text("service_type").notNull().default("visit"),
    title: text("title"),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    address: text("address"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /**
     * The visit's calendar date IN THE BUSINESS'S ZONE, stored as that date's
     * UTC midnight. A LABEL, NOT AN INSTANT: 2026-11-02 is stored as
     * 2026-11-02T00:00:00Z whether the business is in Denver or Sydney. Day
     * iteration, `resolveDayWindows` and the (tenant, crew, day) queries read
     * it; anything that compares against "now" reads `starts_at` instead.
     */
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }).notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(120),
    /**
     * pending | confirmed | in_progress | completed | cancelled | declined |
     * expired | no_show. Moves follow BOOKING_STATUS_TRANSITIONS
     * (`setBookingStatus`); a public request lands `pending` unless the
     * business auto-confirms. Only the system moves a visit to `expired`.
     */
    status: text("status").notNull().default("pending"),
    /** Optional link to the estimate that produced this visit (plain text, no FK). */
    estimateId: text("estimate_id"),
    notes: text("notes"),
    /**
     * Who made a public request, as the host told `requestPublicBooking` (the
     * caller's IP, say). Null for staff bookings and when the host passed
     * none. It is what `maxOpenRequestsPerRequester` counts: an email is
     * whatever the visitor typed, so it can't be the thing that is limited.
     */
    requesterKey: text("requester_key"),
    /**
     * The start instant: `scheduled_date` + `start_time` read on the wall
     * clock of the tenant's zone (`scheduling_settings.time_zone`). Every 0.4
     * insert and move writes it. Notice, the change cutoff, reminders and
     * expiry are measured against it, so "24 hours' notice" is 24 real hours
     * on the weekend the clocks change. Null only on a row written before 0.4
     * and not yet backfilled; readers fall back to `instantsOf`.
     */
    startsAt: timestamp("starts_at", { withTimezone: true }),
    /** The end instant. An end of "24:00" is the next local midnight. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** 'public' (a customer asked online) or 'staff' (booked from the admin). */
    origin: text("origin").notNull().default("staff"),
    /**
     * Goes up by one whenever the visit's time changes or it stops or starts
     * happening: reschedule, cancel, decline, expire, restore. NOT on a crew
     * change or a details edit: the customer's calendar entry doesn't move.
     * It is the .ics SEQUENCE (a calendar client updates its event instead of
     * keeping a stale copy), and it versions the queued reminder: a reminder
     * written for sequence 1 is skipped at send time once the visit is on 2.
     */
    sequence: integer("sequence").notNull().default(0),
    /**
     * When an unanswered request stops holding its time:
     * min(requested + `pendingExpiryHours`, `starts_at`). Set when a visit
     * lands `pending`, cleared when it is accepted, declined or cancelled. A
     * pending visit past this instant holds no time from that moment on,
     * whether or not the sweep (`expirePendingRequests`) has flipped it yet.
     */
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    /** When it was cancelled or declined. Cleared when it is restored. */
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** 'customer' | 'staff' | 'system'. */
    cancelledBy: text("cancelled_by"),
    /** Up to 500 characters, as typed. Shown to the customer as "Note from us". */
    cancelReason: text("cancel_reason"),
    /** The first move to `in_progress`. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** The move to `completed`; cleared when the visit is reopened. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("scheduling_bookings_tenant_date_idx").on(t.tenantId, t.scheduledDate),
    index("scheduling_bookings_resource_date_idx").on(t.resourceId, t.scheduledDate),
    index("scheduling_bookings_tenant_starts_idx").on(t.tenantId, t.startsAt),
    // The expiry sweep and the request inbox: pending rows, soonest deadline first.
    index("scheduling_bookings_pending_expiry_idx").on(t.tenantId, t.status, t.pendingExpiresAt),
  ],
);

/**
 * One row per tenant: how the business runs its online booking. A tenant that
 * never saved settings has no row and reads the defaults
 * (`DEFAULT_SCHEDULING_SETTINGS`), with the zone `UTC`, which is 0.3's
 * behaviour.
 *
 * WHY A ROW AND NOT A POLICY OBJECT IN CODE. 0.3 took the policy from the
 * host's source code, so the owner needed a developer to change the notice
 * period or switch auto-confirm on. These are the owner's decisions, so they
 * live in the database, and the settings screen edits them.
 */
export const schedulingSettings = pgTable(
  "scheduling_settings",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** IANA zone ("America/Denver"), checked with isValidTimeZone on every write. */
    timeZone: text("time_zone").notNull().default("UTC"),
    businessName: text("business_name").notNull().default(""),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    /** Up to 5 addresses for new-request and customer-change notices. */
    staffNotifyEmails: jsonb("staff_notify_emails").$type<string[]>().notNull().default([]),
    /** 1–20 services; a visit's `service_type` holds a service key. */
    services: jsonb("services")
      .$type<SchedulingService[]>()
      .notNull()
      .default([{ key: "visit", name: "Visit", durationMinutes: 60 }]),
    slotStepMinutes: integer("slot_step_minutes").notNull().default(30),
    minNoticeMinutes: integer("min_notice_minutes").notNull().default(1440),
    horizonDays: integer("horizon_days").notNull().default(30),
    travelBufferMinutes: integer("travel_buffer_minutes").notNull().default(30),
    /** Null: every start that fits. */
    maxSlotsPerDay: integer("max_slots_per_day"),
    /** Null: no cap. */
    maxOpenRequestsPerRequester: integer("max_open_requests_per_requester").default(3),
    requireAddress: boolean("require_address").notNull().default(false),
    autoConfirm: boolean("auto_confirm").notNull().default(false),
    publicBookingEnabled: boolean("public_booking_enabled").notNull().default(true),
    pendingExpiryHours: integer("pending_expiry_hours").notNull().default(48),
    /** 0: no reminder. */
    reminderLeadHours: integer("reminder_lead_hours").notNull().default(24),
    /** 0: customers can change a visit online right up to its start. */
    cancelCutoffHours: integer("cancel_cutoff_hours").notNull().default(24),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scheduling_settings_tenant_idx").on(t.tenantId)],
);

/**
 * Customer manage links: one hashed token per message that carried a link.
 *
 * WHY SEVERAL PER VISIT. @adminigloo/booking keeps one hash per booking, so an
 * email sent after the first one has no link to give: a staff accept, a move,
 * a reminder a day later all had nothing. Here whoever needs a link mints a
 * fresh token for that one message (`issueManageToken`), and every token stays
 * valid for its visit. Events therefore never carry a secret.
 *
 * Only the SHA-256 hex is stored, so a database dump, a replica or an
 * over-broad admin query can't open anybody's visit. `visit_id` has no FK,
 * the house rule.
 */
export const schedulingVisitTokens = pgTable(
  "scheduling_visit_tokens",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    visitId: text("visit_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("scheduling_visit_tokens_hash_idx").on(t.tokenHash),
    index("scheduling_visit_tokens_visit_idx").on(t.tenantId, t.visitId),
  ],
);

/** Cached drive times, keyed by rounded coordinates, expired at read time. */
export const schedulingDriveCache = pgTable(
  "scheduling_drive_cache",
  {
    id: idColumn(),
    originLat: doublePrecision("origin_lat").notNull(),
    originLng: doublePrecision("origin_lng").notNull(),
    destLat: doublePrecision("dest_lat").notNull(),
    destLng: doublePrecision("dest_lng").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    distanceMiles: doublePrecision("distance_miles").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduling_drive_cache_key_idx").on(t.originLat, t.originLng, t.destLat, t.destLng),
  ],
);
