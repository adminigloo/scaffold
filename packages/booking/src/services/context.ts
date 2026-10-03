/**
 * What every service shares: the context object, the row → wire mappings,
 * the audit writer, and the event emitter. Kept apart from the services so
 * the public and admin halves map a booking the SAME way — the PublicBooking
 * a prospect sees and the AdminBooking a host sees come from one function
 * each, and a field added to one cannot quietly go missing from a route.
 */

import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { BusySource } from "../busy-source.js";
import { BookingError } from "../errors.js";
import { googleCalendarUrl, howWeMeet, icsLocation, SANDBOX_TITLE_PREFIX, sandboxEventDescription } from "../ics.js";
import {
  bookingBookings,
  bookingEvents,
  bookingHosts,
  bookingTypes,
  type BookingActor,
  type BookingEventKind,
  type BookingMedium,
  type BookingStatus,
} from "../schema.js";

/**
 * The loosest drizzle handle that runs these queries — the app's Neon
 * client, a transaction handle, PGlite in tests. Naming a concrete driver
 * type would reject all but one of them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BookingDb = PgDatabase<any, any, any>;

export type HostRow = typeof bookingHosts.$inferSelect;
export type TypeRow = typeof bookingTypes.$inferSelect;
export type BookingRow = typeof bookingBookings.$inferSelect;

/**
 * Everything a tenant-scoped service needs, passed explicitly. The tenant id
 * is not optional and not inferred: there is no code path in this package
 * that reads or writes a booking row without naming whose it is.
 */
export interface BookingContext {
  db: BookingDb;
  tenantId: string;
  /** The clock. Defaults to the wall clock per call; inject for tests. */
  now?: Date;
  /** External busy (a host's real calendar). Omitted → internal bookings only. */
  busySource?: BusySource | null;
  /**
   * Told about created / rescheduled / cancelled bookings, AFTER the
   * transaction commits — awaited (a serverless response must not end before
   * the listener's email is queued) and caught (a broken listener must never
   * fail the booking it announces). The handler factory never passes this in
   * sandbox mode.
   */
  onEvent?: (event: BookingEvent) => void | Promise<void>;
  /** Builds the prospect's manage link from a plaintext token, for links inside PublicBooking. */
  manageUrl?: (token: string) => string;
  /** Echoed into PublicBooking.sandbox. */
  sandbox?: boolean;
  /**
   * The country calling code ("1") assumed for a prospect's phone number
   * typed without "+" or "00" — see fields.normalizePhone. Omitted, or not a
   * calling code: the "+" is required. Advertised in the public config so the
   * widget applies the same rule before the round trip.
   */
  defaultCallingCode?: string | null;
  /**
   * Does this deployment email the prospect? Default true. With false, copy
   * the package writes never promises an email (`already_booked` points at
   * the confirmation page and `contactEmail` instead). Echoed in the config.
   */
  emailsEnabled?: boolean;
  /** A person to write to, which the host app chooses to show. Echoed in the config. */
  contactEmail?: string | null;
  /** Sandbox only: where a real booking is made, appended to sandbox calendar exports. */
  realBookingUrl?: string | null;
}

export function nowOf(ctx: Pick<BookingContext, "now">): Date {
  return ctx.now ?? new Date();
}

/** Fails loudly on a missing tenant instead of querying "every tenant whose id is ''". */
export function tenantOf(ctx: Pick<BookingContext, "tenantId">): string {
  if (typeof ctx.tenantId !== "string" || ctx.tenantId.length === 0 || ctx.tenantId.length > 200) {
    throw new Error("@adminigloo/booking: a non-empty tenantId is required for every call");
  }
  return ctx.tenantId;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** What a prospect may see about their own booking. The wire contract shared with the widget. */
export interface PublicBooking {
  status: BookingStatus;
  start: string;
  end: string;
  typeName: string;
  /**
   * The booking type's key — what the slots and hold routes take, so a
   * reschedule picker asks for the right type without matching on its name.
   * "" only if the type row itself is gone.
   */
  typeKey: string;
  durationMinutes: number;
  hostDisplayName: string;
  hostTimezone: string;
  inviteeName: string;
  inviteeTimezone: string;
  medium: BookingMedium;
  /** video: the host's link; otherwise null. */
  meetingLink: string | null;
  /** phone: the caller ID the call comes from; otherwise null. */
  hostPhone: string | null;
  /** prospect_hosted: where the prospect sends their invite; otherwise null. */
  inviteMailbox: string | null;
  googleCalendarUrl: string;
  canCancel: boolean;
  canReschedule: boolean;
  sandbox: boolean;
}

/** The host's view of a booking: every invitee field, never a token hash. */
export interface AdminBooking {
  id: string;
  tenantId: string;
  typeId: string;
  typeKey: string | null;
  typeName: string | null;
  hostId: string;
  hostDisplayName: string | null;
  status: BookingStatus;
  start: Date;
  end: Date;
  hostTimezone: string;
  inviteeTimezone: string | null;
  inviteeName: string | null;
  inviteeEmail: string | null;
  inviteePhone: string | null;
  inviteeCompany: string | null;
  notes: string | null;
  medium: BookingMedium | null;
  source: string | null;
  sequence: number;
  cancelledAt: Date | null;
  cancelledBy: BookingActor | null;
  cancelReason: string | null;
  outcome: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The host fields an event listener needs to write a notice — never the calendar secret. */
export interface EventHost {
  displayName: string;
  email: string;
  timezone: string;
  meetingLink: string | null;
  phone: string | null;
  inviteMailbox: string | null;
}

export interface EventType {
  id: string;
  key: string;
  name: string;
  durationMinutes: number;
}

interface EventBase {
  tenantId: string;
  booking: AdminBooking;
  host: EventHost;
  type: EventType;
}

/**
 * What `onEvent` receives. The discriminator is `event`, not `type` — the
 * spec's payload already uses `type` for the booking type.
 *
 * `manageToken` rides on created and rescheduled only, so the listener can
 * put the manage link in the confirmation email; it is the plaintext, so a
 * listener must not log the event object whole. A host's reschedule
 * (hostRescheduleBooking) has no token to give — only its hash is stored —
 * so there it is absent, and `by` says who moved the call.
 */
export type BookingEvent =
  | (EventBase & { event: "booking.created"; manageToken: string })
  | (EventBase & {
      event: "booking.rescheduled";
      previousStart: Date;
      manageToken?: string;
      /** Who moved it. Absent from events built before 0.1's host reschedule; read absent as "invitee". */
      by?: BookingActor;
    })
  | (EventBase & { event: "booking.cancelled"; by: BookingActor })
  | (EventBase & { event: "booking.confirmed" });

/** Live = it occupies time: confirmed, requested, or a hold that has not expired. */
export function isLive(row: Pick<BookingRow, "status" | "holdExpiresAt">, now: Date): boolean {
  if (row.status === "confirmed" || row.status === "requested") return true;
  return row.status === "hold" && row.holdExpiresAt !== null && row.holdExpiresAt.getTime() > now.getTime();
}

/** Can the prospect still change this call? Live, booked, and not started. */
export function isChangeable(row: Pick<BookingRow, "status" | "startUtc">, now: Date): boolean {
  return (row.status === "confirmed" || row.status === "requested") && row.startUtc.getTime() > now.getTime();
}

export function eventHost(host: HostRow): EventHost {
  return {
    displayName: host.displayName,
    email: host.email,
    timezone: host.timezone,
    meetingLink: host.meetingLink,
    phone: host.phone,
    inviteMailbox: host.inviteMailbox,
  };
}

export function eventType(type: TypeRow): EventType {
  return { id: type.id, key: type.key, name: type.name, durationMinutes: type.durationMinutes };
}

export function toAdminBooking(row: BookingRow, host: HostRow | null, type: TypeRow | null): AdminBooking {
  return {
    id: row.id,
    tenantId: row.tenantId,
    typeId: row.typeId,
    typeKey: type?.key ?? null,
    typeName: type?.name ?? null,
    hostId: row.hostId,
    hostDisplayName: host?.displayName ?? null,
    status: row.status,
    start: row.startUtc,
    end: row.endUtc,
    hostTimezone: row.hostTimezone,
    inviteeTimezone: row.inviteeTimezone,
    inviteeName: row.inviteeName,
    inviteeEmail: row.inviteeEmail,
    inviteePhone: row.inviteePhone,
    inviteeCompany: row.inviteeCompany,
    notes: row.notes,
    medium: row.medium,
    source: row.source,
    sequence: row.sequence,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    outcome: row.outcome,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The Google "add" link for a booking, worded for the invitee — or, for a
 * sandbox booking, the same unmistakable non-event the sandbox .ics is
 * (ics.ts SANDBOX_TITLE_PREFIX): prefixed title, the sandbox description, no
 * location and no manage link.
 */
function inviteeGoogleUrl(
  row: BookingRow,
  host: HostRow,
  typeName: string,
  medium: BookingMedium,
  options: { sandbox?: boolean; manageUrl?: string | null; realBookingUrl?: string | null },
): string {
  if (options.sandbox) {
    return googleCalendarUrl({
      title: `${SANDBOX_TITLE_PREFIX}${typeName} with ${host.displayName}`,
      start: row.startUtc,
      end: row.endUtc,
      details: sandboxEventDescription(options.realBookingUrl),
    });
  }
  return googleCalendarUrl({
    title: `${typeName} with ${host.displayName}`,
    start: row.startUtc,
    end: row.endUtc,
    details:
      howWeMeet({ medium, host, audience: "invitee" }) +
      (options.manageUrl ? `\n\nReschedule or cancel: ${options.manageUrl}` : ""),
    location: icsLocation(medium, host, "invitee"),
  });
}

export function toPublicBooking(
  row: BookingRow,
  host: HostRow,
  type: TypeRow | null,
  options: { now: Date; sandbox?: boolean; manageUrl?: string | null; realBookingUrl?: string | null },
): PublicBooking {
  const medium: BookingMedium = row.medium ?? "video";
  const live = row.status !== "cancelled";
  const typeName = type?.name ?? "Call";
  const changeable = isChangeable(row, options.now);
  return {
    status: row.status,
    start: row.startUtc.toISOString(),
    end: row.endUtc.toISOString(),
    typeName,
    typeKey: type?.key ?? "",
    durationMinutes: Math.round((row.endUtc.getTime() - row.startUtc.getTime()) / 60_000),
    hostDisplayName: host.displayName,
    hostTimezone: row.hostTimezone,
    inviteeName: row.inviteeName ?? "",
    inviteeTimezone: row.inviteeTimezone ?? row.hostTimezone,
    medium,
    // Only what THIS medium needs, and nothing once the call is off: a
    // cancelled booking's page should not keep handing out a meeting room.
    meetingLink: live && medium === "video" ? host.meetingLink : null,
    hostPhone: live && medium === "phone" ? host.phone : null,
    inviteMailbox: live && medium === "prospect_hosted" ? (host.inviteMailbox ?? host.email) : null,
    googleCalendarUrl: inviteeGoogleUrl(row, host, typeName, medium, options),
    canCancel: changeable,
    canReschedule: changeable,
    sandbox: options.sandbox ?? false,
  };
}

// ---------------------------------------------------------------------------
// Audit + events
// ---------------------------------------------------------------------------

/**
 * One audit row. `detail` is for facts like statuses and times — callers
 * pass no tokens and no notes, and the type of this function is the only
 * door into the table.
 */
export async function recordEvent(
  db: BookingDb,
  input: {
    tenantId: string;
    bookingId: string;
    kind: BookingEventKind;
    actor: BookingActor;
    detail?: Record<string, string | number | boolean | null>;
    at: Date;
  },
): Promise<void> {
  await db.insert(bookingEvents).values({
    tenantId: input.tenantId,
    bookingId: input.bookingId,
    kind: input.kind,
    actor: input.actor,
    detail: input.detail ?? null,
    at: input.at,
  });
}

/** Awaited and caught — see BookingContext.onEvent. */
export async function emit(ctx: Pick<BookingContext, "onEvent">, event: BookingEvent): Promise<void> {
  if (!ctx.onEvent) return;
  try {
    await ctx.onEvent(event);
  } catch {
    // A listener that throws must never fail the request it is announcing.
  }
}

/** A host row of this tenant, or the one not-found. */
export async function requireHost(db: BookingDb, tenantId: string, hostId: string): Promise<HostRow> {
  const rows: HostRow[] = await db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.id, hostId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new BookingError("not_found");
  return row;
}
