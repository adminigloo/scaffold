/**
 * The host's side — what a staff router in the host app calls behind its own
 * sign-in and the `booking.*` permissions. Every function takes the tenant in
 * its context and filters on it; an id from another tenant is `not_found`,
 * exactly like an id that does not exist.
 *
 * Reads return plain objects (Dates as Dates — the caller's serializer
 * decides the wire); mutations throw BookingError for a missing row.
 */

import { and, asc, desc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { BookingError, issuesFrom } from "../errors.js";
import type { WeeklyWindow } from "../engine.js";
import {
  dateSchema,
  emailSchema,
  httpsUrlSchema,
  icsUrlSchema,
  instantSchema,
  mediumSchema,
  minuteSchema,
  phoneSchema,
  timeZoneSchema,
  typeKeySchema,
} from "../fields.js";
import {
  bookingAvailability,
  bookingBlackouts,
  bookingBookings,
  bookingEvents,
  bookingExceptions,
  bookingHosts,
  bookingTypes,
  type BookingExceptionKind,
  type BookingStatus,
} from "../schema.js";
import { generateToken, hashToken } from "../tokens.js";
import {
  emit,
  eventHost,
  eventType,
  nowOf,
  recordEvent,
  requireHost,
  tenantOf,
  toAdminBooking,
  type AdminBooking,
  type BookingContext,
  type BookingRow,
  type HostRow,
  type TypeRow,
} from "./context.js";
import { moveBooking } from "./move.js";
import { lockHosts, recordSyncError, recordSyncOk } from "./slots.js";

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BookingError("invalid", "Some details need another look.", issuesFrom(result.error));
  return result.data;
}

/** An optional form field: "" means "clear it" (null), absent means "leave it". */
function clearable<T extends z.ZodTypeAny>(schema: T) {
  return z.union([z.literal("").transform(() => null), schema]).nullish();
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export interface AdminHost {
  id: string;
  displayName: string;
  email: string;
  timezone: string;
  meetingLink: string | null;
  phone: string | null;
  inviteMailbox: string | null;
  /** MASKED — "https://calendar.google.com/…ics ✓". The secret itself never leaves the server. */
  busyIcsUrl: string | null;
  busySync: { error: string | null; failingSince: Date | null; okAt: Date | null };
  hasFeedToken: boolean;
  autoConfirm: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Enough of a calendar address to recognise it, none of the secret: scheme,
 * host, and the last three characters of the path. A secret iCal address is
 * a bearer credential to the whole calendar, so even the admin UI shows it
 * this way — replacing it is the only edit, and that needs no reveal.
 */
export function maskIcsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/…${url.pathname.slice(-3)} ✓`;
  } catch {
    return "… ✓";
  }
}

export function toAdminHost(host: HostRow): AdminHost {
  return {
    id: host.id,
    displayName: host.displayName,
    email: host.email,
    timezone: host.timezone,
    meetingLink: host.meetingLink,
    phone: host.phone,
    inviteMailbox: host.inviteMailbox,
    busyIcsUrl: maskIcsUrl(host.busyIcsUrl),
    busySync: { error: host.busySyncError, failingSince: host.busySyncFailingSince, okAt: host.busySyncOkAt },
    hasFeedToken: host.feedTokenHash !== null,
    autoConfirm: host.autoConfirm,
    isActive: host.isActive,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
  };
}

export const upsertHostSchema = z.object({
  /** Present → update that host; absent → create one. */
  id: z.string().min(1).max(100).optional(),
  displayName: z.string().trim().min(1).max(120),
  email: emailSchema,
  timezone: timeZoneSchema,
  meetingLink: clearable(httpsUrlSchema),
  phone: clearable(phoneSchema),
  inviteMailbox: clearable(emailSchema),
  /** The secret iCal address. Absent → unchanged; "" or null → disconnected. */
  busyIcsUrl: clearable(icsUrlSchema),
  autoConfirm: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpsertHostInput = z.input<typeof upsertHostSchema>;

export async function upsertHost(ctx: BookingContext, input: UpsertHostInput): Promise<AdminHost> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(upsertHostSchema, input);
  const now = nowOf(ctx);
  const patch: Partial<typeof bookingHosts.$inferInsert> = {
    displayName: parsed.displayName,
    email: parsed.email,
    timezone: parsed.timezone,
    updatedAt: now,
  };
  if (parsed.meetingLink !== undefined) patch.meetingLink = parsed.meetingLink;
  if (parsed.phone !== undefined) patch.phone = parsed.phone;
  if (parsed.inviteMailbox !== undefined) patch.inviteMailbox = parsed.inviteMailbox;
  if (parsed.busyIcsUrl !== undefined) {
    patch.busyIcsUrl = parsed.busyIcsUrl;
    // A new (or no) address starts with a clean bill of health.
    patch.busySyncError = null;
    patch.busySyncFailingSince = null;
    patch.busySyncOkAt = null;
  }
  if (parsed.autoConfirm !== undefined) patch.autoConfirm = parsed.autoConfirm;
  if (parsed.isActive !== undefined) patch.isActive = parsed.isActive;

  if (parsed.id) {
    await requireHost(ctx.db, tenantId, parsed.id);
    const [row]: HostRow[] = await ctx.db
      .update(bookingHosts)
      .set(patch)
      .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.id, parsed.id)))
      .returning();
    if (!row) throw new BookingError("not_found");
    return toAdminHost(row);
  }
  const [row]: HostRow[] = await ctx.db
    .insert(bookingHosts)
    .values({
      tenantId,
      displayName: parsed.displayName,
      email: parsed.email,
      timezone: parsed.timezone,
      ...patch,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("host insert returned no row");
  return toAdminHost(row);
}

export async function listHosts(ctx: BookingContext): Promise<AdminHost[]> {
  const rows: HostRow[] = await ctx.db
    .select()
    .from(bookingHosts)
    .where(eq(bookingHosts.tenantId, tenantOf(ctx)))
    .orderBy(asc(bookingHosts.createdAt), asc(bookingHosts.id));
  return rows.map(toAdminHost);
}

/**
 * Mint a new subscribable-feed token for a host, invalidating the old one.
 * The plaintext is returned ONCE; only its hash is stored. The caller builds
 * the URL (`webcal://<host>/<base>/v1/feed/<token>.ics`).
 */
export async function rotateHostFeedToken(ctx: BookingContext, hostId: string): Promise<{ feedToken: string }> {
  const tenantId = tenantOf(ctx);
  await requireHost(ctx.db, tenantId, hostId);
  const feedToken = generateToken();
  await ctx.db
    .update(bookingHosts)
    .set({ feedTokenHash: await hashToken(feedToken), updatedAt: nowOf(ctx) })
    .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.id, hostId)));
  return { feedToken };
}

/**
 * "Test connection" for a host's calendar address: fetch the next two weeks
 * through the configured busy source and report how many busy blocks came
 * back, or why not. Updates the host's sync state either way.
 */
export async function testBusySource(
  ctx: BookingContext,
  hostId: string,
): Promise<{ ok: boolean; events: number; error?: string }> {
  const tenantId = tenantOf(ctx);
  const host = await requireHost(ctx.db, tenantId, hostId);
  if (!host.busyIcsUrl) return { ok: false, events: 0, error: "No calendar address is set for this host." };
  if (!ctx.busySource) return { ok: false, events: 0, error: "No busy source is configured on the server." };
  const now = nowOf(ctx);
  const to = new Date(now.getTime() + 14 * 86_400_000);
  // Called directly rather than through fetchExternalBusy so the error text
  // reaches the admin; the sync state is recorded by the same helpers.
  try {
    const busy = await ctx.busySource.busy({
      host: { id: host.id, timezone: host.timezone, busyIcsUrl: host.busyIcsUrl },
      from: now,
      to,
    });
    await recordSyncOk(ctx.db, host, now, { force: true });
    return { ok: true, events: busy.length };
  } catch (error) {
    await recordSyncError(ctx.db, host, error, now);
    return { ok: false, events: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const weeklyWindowSchema = z
  .object({ dayOfWeek: z.number().int().min(0).max(6), startMinute: minuteSchema, endMinute: minuteSchema })
  .refine((value) => value.startMinute < value.endMinute, "A window must end after it starts.");

export const setWeeklyAvailabilitySchema = z.object({
  hostId: z.string().min(1).max(100),
  windows: z.array(weeklyWindowSchema).max(70),
});

/** Replace a host's whole week in one transaction — never a half-saved week. */
export async function setWeeklyAvailability(
  ctx: BookingContext,
  input: z.input<typeof setWeeklyAvailabilitySchema>,
): Promise<WeeklyWindow[]> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(setWeeklyAvailabilitySchema, input);
  await requireHost(ctx.db, tenantId, parsed.hostId);
  const now = nowOf(ctx);
  await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, [parsed.hostId]);
    await tx
      .delete(bookingAvailability)
      .where(and(eq(bookingAvailability.tenantId, tenantId), eq(bookingAvailability.hostId, parsed.hostId)));
    if (parsed.windows.length > 0) {
      await tx.insert(bookingAvailability).values(
        parsed.windows.map((window) => ({ tenantId, hostId: parsed.hostId, ...window, createdAt: now })),
      );
    }
    await tx
      .update(bookingHosts)
      .set({ updatedAt: now })
      .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.id, parsed.hostId)));
  });
  return parsed.windows
    .map((window) => ({ ...window }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute);
}

export interface ExceptionRow {
  id: string;
  hostId: string;
  date: string;
  kind: BookingExceptionKind;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
}

export interface BlackoutRow {
  id: string;
  date: string;
  label: string | null;
}

/** A host's week and dated exceptions (from `fromDate`, default all), for the availability editor. */
export async function getAvailability(
  ctx: BookingContext,
  input: { hostId: string; fromDate?: string },
): Promise<{ weekly: WeeklyWindow[]; exceptions: ExceptionRow[] }> {
  const tenantId = tenantOf(ctx);
  await requireHost(ctx.db, tenantId, input.hostId);
  const [weekly, exceptions] = await Promise.all([
    ctx.db
      .select()
      .from(bookingAvailability)
      .where(and(eq(bookingAvailability.tenantId, tenantId), eq(bookingAvailability.hostId, input.hostId)))
      .orderBy(asc(bookingAvailability.dayOfWeek), asc(bookingAvailability.startMinute)) as Promise<
      Array<typeof bookingAvailability.$inferSelect>
    >,
    ctx.db
      .select()
      .from(bookingExceptions)
      .where(
        and(
          eq(bookingExceptions.tenantId, tenantId),
          eq(bookingExceptions.hostId, input.hostId),
          input.fromDate ? gte(bookingExceptions.date, input.fromDate) : undefined,
        ),
      )
      .orderBy(asc(bookingExceptions.date), asc(bookingExceptions.startMinute)) as Promise<
      Array<typeof bookingExceptions.$inferSelect>
    >,
  ]);
  return {
    weekly: weekly.map((row) => ({ dayOfWeek: row.dayOfWeek, startMinute: row.startMinute, endMinute: row.endMinute })),
    exceptions: exceptions.map((row) => ({
      id: row.id,
      hostId: row.hostId,
      date: row.date,
      kind: row.kind,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
      note: row.note,
    })),
  };
}

export const addExceptionSchema = z
  .object({
    hostId: z.string().min(1).max(100),
    date: dateSchema,
    kind: z.enum(["off", "hours", "block"]),
    startMinute: minuteSchema.nullish(),
    endMinute: minuteSchema.nullish(),
    note: z.string().trim().max(200).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "off") return;
    if (value.startMinute == null || value.endMinute == null) {
      ctx.addIssue({ code: "custom", path: ["startMinute"], message: "Hours and blocks need a start and an end." });
    } else if (value.startMinute >= value.endMinute) {
      ctx.addIssue({ code: "custom", path: ["endMinute"], message: "Must end after it starts." });
    }
  });

export async function addException(
  ctx: BookingContext,
  input: z.input<typeof addExceptionSchema>,
): Promise<ExceptionRow> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(addExceptionSchema, input);
  await requireHost(ctx.db, tenantId, parsed.hostId);
  const off = parsed.kind === "off";
  const [row]: Array<typeof bookingExceptions.$inferSelect> = await ctx.db
    .insert(bookingExceptions)
    .values({
      tenantId,
      hostId: parsed.hostId,
      date: parsed.date,
      kind: parsed.kind,
      startMinute: off ? null : (parsed.startMinute ?? null),
      endMinute: off ? null : (parsed.endMinute ?? null),
      note: parsed.note ?? null,
      createdAt: nowOf(ctx),
    })
    .returning();
  if (!row) throw new Error("exception insert returned no row");
  return {
    id: row.id,
    hostId: row.hostId,
    date: row.date,
    kind: row.kind,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    note: row.note,
  };
}

export async function removeException(ctx: BookingContext, id: string): Promise<{ removed: boolean }> {
  const rows: Array<{ id: string }> = await ctx.db
    .delete(bookingExceptions)
    .where(and(eq(bookingExceptions.tenantId, tenantOf(ctx)), eq(bookingExceptions.id, id)))
    .returning({ id: bookingExceptions.id });
  return { removed: rows.length > 0 };
}

export const addBlackoutSchema = z.object({ date: dateSchema, label: z.string().trim().max(120).nullish() });

/** A tenant-wide holiday. Adding a date that is already blacked out updates its label. */
export async function addBlackout(ctx: BookingContext, input: z.input<typeof addBlackoutSchema>): Promise<BlackoutRow> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(addBlackoutSchema, input);
  const [row]: Array<typeof bookingBlackouts.$inferSelect> = await ctx.db
    .insert(bookingBlackouts)
    .values({ tenantId, date: parsed.date, label: parsed.label ?? null, createdAt: nowOf(ctx) })
    .onConflictDoUpdate({
      target: [bookingBlackouts.tenantId, bookingBlackouts.date],
      set: { label: parsed.label ?? null },
    })
    .returning();
  if (!row) throw new Error("blackout insert returned no row");
  return { id: row.id, date: row.date, label: row.label };
}

export async function removeBlackout(ctx: BookingContext, id: string): Promise<{ removed: boolean }> {
  const rows: Array<{ id: string }> = await ctx.db
    .delete(bookingBlackouts)
    .where(and(eq(bookingBlackouts.tenantId, tenantOf(ctx)), eq(bookingBlackouts.id, id)))
    .returning({ id: bookingBlackouts.id });
  return { removed: rows.length > 0 };
}

export async function listBlackouts(ctx: BookingContext): Promise<BlackoutRow[]> {
  const rows: Array<typeof bookingBlackouts.$inferSelect> = await ctx.db
    .select()
    .from(bookingBlackouts)
    .where(eq(bookingBlackouts.tenantId, tenantOf(ctx)))
    .orderBy(asc(bookingBlackouts.date));
  return rows.map((row) => ({ id: row.id, date: row.date, label: row.label }));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const upsertTypeSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  key: typeKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(480)
    .refine((value) => value % 5 === 0, "Must be a multiple of 5 minutes."),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
  stepMinutes: z
    .number()
    .int()
    .min(5)
    .max(240)
    .refine((value) => value % 5 === 0, "Must be a multiple of 5 minutes.")
    .default(30),
  minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 60).default(240),
  horizonDays: z.number().int().min(1).max(365).default(21),
  maxPerDay: z.number().int().min(1).max(100).nullish(),
  media: z
    .array(mediumSchema)
    .min(1, "Offer at least one way to meet.")
    .max(3)
    .refine((value) => new Set(value).size === value.length, "Each way of meeting once."),
  /** Empty = every active host. */
  hostIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});
export type UpsertTypeInput = z.input<typeof upsertTypeSchema>;

/** Create or update a booking type — by `id` when given, otherwise by its tenant-unique `key`. */
export async function upsertType(ctx: BookingContext, input: UpsertTypeInput): Promise<TypeRow> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(upsertTypeSchema, input);
  const now = nowOf(ctx);
  if (parsed.hostIds.length > 0) {
    const known: Array<{ id: string }> = await ctx.db
      .select({ id: bookingHosts.id })
      .from(bookingHosts)
      .where(and(eq(bookingHosts.tenantId, tenantId), inArray(bookingHosts.id, parsed.hostIds)));
    if (known.length !== new Set(parsed.hostIds).size) {
      throw new BookingError("invalid", "Some details need another look.", [
        { path: ["hostIds"], message: "Every host must be one of this tenant's hosts." },
      ]);
    }
  }
  const values = {
    key: parsed.key,
    name: parsed.name,
    description: parsed.description ?? null,
    durationMinutes: parsed.durationMinutes,
    bufferBeforeMinutes: parsed.bufferBeforeMinutes,
    bufferAfterMinutes: parsed.bufferAfterMinutes,
    stepMinutes: parsed.stepMinutes,
    minNoticeMinutes: parsed.minNoticeMinutes,
    horizonDays: parsed.horizonDays,
    maxPerDay: parsed.maxPerDay ?? null,
    media: parsed.media,
    hostIds: [...new Set(parsed.hostIds)],
    isActive: parsed.isActive,
    sortOrder: parsed.sortOrder,
    updatedAt: now,
  };
  if (parsed.id) {
    const [row]: TypeRow[] = await ctx.db
      .update(bookingTypes)
      .set(values)
      .where(and(eq(bookingTypes.tenantId, tenantId), eq(bookingTypes.id, parsed.id)))
      .returning();
    if (!row) throw new BookingError("not_found");
    return row;
  }
  const [row]: TypeRow[] = await ctx.db
    .insert(bookingTypes)
    .values({ ...values, tenantId, createdAt: now })
    .onConflictDoUpdate({ target: [bookingTypes.tenantId, bookingTypes.key], set: values })
    .returning();
  if (!row) throw new Error("type upsert returned no row");
  return row;
}

export async function listTypes(ctx: BookingContext): Promise<TypeRow[]> {
  return ctx.db
    .select()
    .from(bookingTypes)
    .where(eq(bookingTypes.tenantId, tenantOf(ctx)))
    .orderBy(asc(bookingTypes.sortOrder), asc(bookingTypes.name));
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

const STATUSES = ["hold", "requested", "confirmed", "cancelled", "completed", "no_show"] as const;

export const listBookingsSchema = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
  /** One status or several. Omitted → everything except holds. */
  status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES)).max(6)]).optional(),
  limit: z.number().int().min(1).max(1000).default(500),
});

async function hydrateMany(ctx: BookingContext, rows: BookingRow[]): Promise<AdminBooking[]> {
  if (rows.length === 0) return [];
  const tenantId = tenantOf(ctx);
  const [hosts, types] = await Promise.all([
    ctx.db
      .select()
      .from(bookingHosts)
      .where(and(eq(bookingHosts.tenantId, tenantId), inArray(bookingHosts.id, [...new Set(rows.map((r) => r.hostId))]))) as Promise<HostRow[]>,
    ctx.db
      .select()
      .from(bookingTypes)
      .where(and(eq(bookingTypes.tenantId, tenantId), inArray(bookingTypes.id, [...new Set(rows.map((r) => r.typeId))]))) as Promise<TypeRow[]>,
  ]);
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const typeById = new Map(types.map((type) => [type.id, type]));
  return rows.map((row) => toAdminBooking(row, hostById.get(row.hostId) ?? null, typeById.get(row.typeId) ?? null));
}

/** Bookings starting in [from, to), soonest first. */
export async function listBookings(
  ctx: BookingContext,
  input: z.input<typeof listBookingsSchema> = {},
): Promise<AdminBooking[]> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(listBookingsSchema, input);
  const statuses = parsed.status === undefined ? null : Array.isArray(parsed.status) ? parsed.status : [parsed.status];
  const rows: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        parsed.from ? gte(bookingBookings.startUtc, parsed.from) : undefined,
        parsed.to ? lt(bookingBookings.startUtc, parsed.to) : undefined,
        statuses ? inArray(bookingBookings.status, statuses) : ne(bookingBookings.status, "hold"),
      ),
    )
    .orderBy(asc(bookingBookings.startUtc))
    .limit(parsed.limit);
  return hydrateMany(ctx, rows);
}

export interface BookingAuditEntry {
  id: number;
  kind: string;
  actor: string;
  detail: Record<string, unknown> | null;
  at: Date;
}

/** One booking with its audit trail, or null when this tenant has no such booking. */
export async function getBooking(
  ctx: BookingContext,
  id: string,
): Promise<(AdminBooking & { events: BookingAuditEntry[] }) | null> {
  const tenantId = tenantOf(ctx);
  const [row]: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, id)))
    .limit(1);
  if (!row) return null;
  const [booking] = await hydrateMany(ctx, [row]);
  const events: BookingAuditEntry[] = await ctx.db
    .select({
      id: bookingEvents.id,
      kind: bookingEvents.kind,
      actor: bookingEvents.actor,
      detail: bookingEvents.detail,
      at: bookingEvents.at,
    })
    .from(bookingEvents)
    .where(and(eq(bookingEvents.tenantId, tenantId), eq(bookingEvents.bookingId, id)))
    .orderBy(desc(bookingEvents.at), desc(bookingEvents.id));
  return booking ? { ...booking, events } : null;
}

async function loadForUpdate(ctx: BookingContext, id: string): Promise<{ row: BookingRow; host: HostRow | null; type: TypeRow | null }> {
  const tenantId = tenantOf(ctx);
  const [row]: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, id)))
    .limit(1);
  if (!row || row.status === "hold") throw new BookingError("not_found");
  const [hosts, types]: [HostRow[], TypeRow[]] = await Promise.all([
    ctx.db.select().from(bookingHosts).where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.id, row.hostId))).limit(1),
    ctx.db.select().from(bookingTypes).where(and(eq(bookingTypes.tenantId, tenantId), eq(bookingTypes.id, row.typeId))).limit(1),
  ]);
  return { row, host: hosts[0] ?? null, type: types[0] ?? null };
}

export const hostCancelBookingSchema = z.object({
  id: z.string().min(1).max(100),
  reason: z.string().trim().max(500).nullish(),
});

/** The host calls it off. Idempotent; emits `booking.cancelled` (by: "host") once. */
export async function hostCancelBooking(
  ctx: BookingContext,
  input: z.input<typeof hostCancelBookingSchema>,
): Promise<AdminBooking> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(hostCancelBookingSchema, input);
  const now = nowOf(ctx);
  const { row: found, host, type } = await loadForUpdate(ctx, parsed.id);
  if (found.status === "cancelled") return toAdminBooking(found, host, type);
  if (found.status !== "confirmed" && found.status !== "requested") {
    throw new BookingError("invalid", "Only a booked call can be cancelled.");
  }
  // A call that is over cannot be called off: cancelling it would email the
  // invitee "had to cancel your call… sorry for the change" about a call
  // that already happened (or that they missed). Record how it went instead.
  if (found.endUtc.getTime() <= now.getTime()) {
    throw new BookingError("invalid", "This call has already happened. Record how it went instead of cancelling it.");
  }
  const updated = await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, [found.hostId]);
    const [row]: BookingRow[] = await tx
      .update(bookingBookings)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: "host",
        cancelReason: parsed.reason || null,
        sequence: found.sequence + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(bookingBookings.tenantId, tenantId),
          eq(bookingBookings.id, found.id),
          inArray(bookingBookings.status, ["confirmed", "requested"]),
        ),
      )
      .returning();
    if (!row) return null;
    await recordEvent(tx, { tenantId, bookingId: found.id, kind: "cancelled", actor: "host", detail: { from: found.status }, at: now });
    return row;
  });
  if (!updated) {
    const again = await loadForUpdate(ctx, parsed.id);
    return toAdminBooking(again.row, again.host, again.type);
  }
  const booking = toAdminBooking(updated, host, type);
  if (host && type) {
    await emit(ctx, { event: "booking.cancelled", tenantId, booking, host: eventHost(host), type: eventType(type), by: "host" });
  }
  return booking;
}

/**
 * Accept a `requested` booking (a host with autoConfirm off). Idempotent.
 * Emits `booking.confirmed` — an addition to the spec's three events, since
 * a request the host accepted is the moment the prospect should hear.
 */
export async function confirmBooking(ctx: BookingContext, id: string): Promise<AdminBooking> {
  const tenantId = tenantOf(ctx);
  const now = nowOf(ctx);
  const { row: found, host, type } = await loadForUpdate(ctx, id);
  if (found.status === "confirmed") return toAdminBooking(found, host, type);
  if (found.status !== "requested") throw new BookingError("invalid", "Only a requested call can be confirmed.");
  const [row]: BookingRow[] = await ctx.db
    .update(bookingBookings)
    .set({ status: "confirmed", updatedAt: now })
    .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, id), eq(bookingBookings.status, "requested")))
    .returning();
  if (!row) {
    const again = await loadForUpdate(ctx, id);
    return toAdminBooking(again.row, again.host, again.type);
  }
  await recordEvent(ctx.db, { tenantId, bookingId: id, kind: "confirmed", actor: "host", at: now });
  const booking = toAdminBooking(row, host, type);
  if (host && type) await emit(ctx, { event: "booking.confirmed", tenantId, booking, host: eventHost(host), type: eventType(type) });
  return booking;
}

export const setOutcomeSchema = z.object({
  id: z.string().min(1).max(100),
  /** Free text the host's pipeline understands: "won", "nurture", "not a fit". Null clears it. */
  outcome: z.string().trim().max(200).nullable(),
  /** Optionally close the call out at the same time. */
  status: z.enum(["completed", "no_show"]).optional(),
});

/**
 * Record how a call went (and optionally mark it completed / no-show).
 *
 * Completed / no-show only once the call has STARTED. Marking a future call
 * closed took it out of every busy check (its slot reopened and could be
 * double-booked), emitted nothing (so the invitee's queued reminder stayed
 * queued), and flipped their manage page to "can't change" — for a call
 * that had not happened. A free-text outcome alone can be noted any time.
 */
export async function setOutcome(ctx: BookingContext, input: z.input<typeof setOutcomeSchema>): Promise<AdminBooking> {
  const tenantId = tenantOf(ctx);
  const parsed = parse(setOutcomeSchema, input);
  const now = nowOf(ctx);
  const { row: found, host, type } = await loadForUpdate(ctx, parsed.id);
  if (parsed.status && found.status === "cancelled") {
    throw new BookingError("invalid", "A cancelled call cannot be marked completed or no-show.");
  }
  if (parsed.status && found.startUtc.getTime() > now.getTime()) {
    throw new BookingError("invalid", "A call that hasn't started can't be marked completed or no-show.");
  }
  const patch: Partial<typeof bookingBookings.$inferInsert> = { outcome: parsed.outcome || null, updatedAt: now };
  if (parsed.status) patch.status = parsed.status as BookingStatus;
  const [row]: BookingRow[] = await ctx.db
    .update(bookingBookings)
    .set(patch)
    .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, parsed.id)))
    .returning();
  if (!row) throw new BookingError("not_found");
  await recordEvent(ctx.db, {
    tenantId,
    bookingId: parsed.id,
    kind: "outcome",
    actor: "host",
    detail: { outcome: (parsed.outcome || "").slice(0, 60) || null, status: parsed.status ?? found.status },
    at: now,
  });
  return toAdminBooking(row, host, type);
}

export const hostRescheduleBookingSchema = z.object({
  id: z.string().min(1).max(100),
  /** The new start: a Date, or an ISO-8601 instant with a zone. */
  start: z.union([z.date(), instantSchema]),
});

/**
 * The host moves a call — the same transaction as the invitee's reschedule
 * (move.ts), with actor "host": same row, same manage token, same .ics UID,
 * sequence + 1, and `booking.rescheduled` (with `by: "host"`) emitted after
 * the commit, so the app's listener emails the invitee and re-queues the
 * reminder exactly as it does for an invitee's move. Before this the only
 * way out of a clash was to cancel and hope the prospect rebooked.
 *
 * The new time obeys the rules the slot list does — hours, notice, horizon,
 * buffers, maxPerDay and the host's real calendar — so a host cannot move a
 * call onto something else by accident. To take a call outside the usual
 * hours, add an `hours` exception for that date first. The event carries no
 * `manageToken` (only its hash is stored); the invitee's link is unchanged.
 */
export async function hostRescheduleBooking(
  ctx: BookingContext,
  input: z.input<typeof hostRescheduleBookingSchema>,
): Promise<AdminBooking> {
  const parsed = parse(hostRescheduleBookingSchema, input);
  const { row: found } = await loadForUpdate(ctx, parsed.id);
  const result = await moveBooking(
    ctx,
    found,
    { start: parsed.start, holdHash: null },
    {
      actor: "host",
      notChangeable: () => new BookingError("invalid", "Only an upcoming booked call can be moved."),
    },
  );
  return toAdminBooking(result.row, result.host, result.type);
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

/**
 * How many holds are live right now, and how many distinct requesters
 * (by `holdSubject`) placed them. Holds never reach listBookings and emit no
 * events, so without this a calendar held empty by a script is invisible to
 * its host. A host app can show it, or refuse new holds above a ceiling of
 * its own (its `rateLimit` for the "hold" bucket can call this).
 */
export async function countLiveHolds(ctx: BookingContext): Promise<{ live: number; subjects: number }> {
  const now = nowOf(ctx);
  const rows: Array<{ live: number; subjects: number }> = await ctx.db
    .select({
      live: sql<number>`count(*)::int`,
      subjects: sql<number>`count(distinct ${bookingBookings.holdSubjectHash})::int`,
    })
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantOf(ctx)),
        eq(bookingBookings.status, "hold"),
        gt(bookingBookings.holdExpiresAt, now),
      ),
    );
  return { live: Number(rows[0]?.live ?? 0), subjects: Number(rows[0]?.subjects ?? 0) };
}
