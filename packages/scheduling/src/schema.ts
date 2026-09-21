import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

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
 * blocks the day/window.
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
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }).notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(120),
    /** pending | confirmed | in_progress | completed | cancelled | no_show */
    status: text("status").notNull().default("pending"),
    /** Optional link to the estimate that produced this visit (plain text, no FK). */
    estimateId: text("estimate_id"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("scheduling_bookings_tenant_date_idx").on(t.tenantId, t.scheduledDate),
    index("scheduling_bookings_resource_date_idx").on(t.resourceId, t.scheduledDate),
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
