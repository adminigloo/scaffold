/**
 * Moving a booking to a new start — ONE transaction, shared by the invitee's
 * reschedule-by-token and the host's reschedule from the admin, so the two
 * can never disagree about what a free time is or how a move is written.
 *
 * The SAME row moves: new start and end, sequence + 1, manage token and .ics
 * UID unchanged (D2), so the invitee's link keeps working and their calendar
 * updates the event it already has. Under the host lock the row is re-read,
 * the exact start is re-checked by the engine that offered it — excluding
 * the booking itself (and the invitee's own hold for the new time) — and
 * only then written. The current host keeps the call when free; otherwise
 * the held host, otherwise the fairest free one.
 */

import { and, eq } from "drizzle-orm";
import { BookingError } from "../errors.js";
import { bookingBookings, bookingHosts, bookingTypes, type BookingActor } from "../schema.js";
import {
  emit,
  eventHost,
  eventType,
  isChangeable,
  nowOf,
  recordEvent,
  tenantOf,
  toAdminBooking,
  type BookingContext,
  type BookingRow,
  type HostRow,
  type TypeRow,
} from "./context.js";
import {
  assignHost,
  deleteEventsFor,
  fetchExternalBusy,
  freeHostsAt,
  holdByTokenHash,
  lockHosts,
  poolHosts,
} from "./slots.js";

const DAY_MS = 86_400_000;

export interface MoveResult {
  row: BookingRow;
  host: HostRow;
  type: TypeRow;
  /** False when the new start was the old one: nothing was written or announced. */
  moved: boolean;
}

export interface MoveOptions {
  actor: Extract<BookingActor, "invitee" | "host">;
  /** The error for a booking that can no longer move — not_found on the public route, invalid in the admin. */
  notChangeable: () => BookingError;
  /** The invitee's plaintext token, passed on to `booking.rescheduled` (never stored). */
  manageToken?: string;
}

async function typeById(ctx: BookingContext, id: string): Promise<TypeRow | null> {
  const rows: TypeRow[] = await ctx.db
    .select()
    .from(bookingTypes)
    .where(and(eq(bookingTypes.tenantId, tenantOf(ctx)), eq(bookingTypes.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

async function hostById(ctx: BookingContext, id: string): Promise<HostRow | null> {
  const rows: HostRow[] = await ctx.db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.tenantId, tenantOf(ctx)), eq(bookingHosts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Move `found` to `start`, consuming the hold whose token hashes to
 * `holdHash` when one is given. Emits `booking.rescheduled` (with `by`) after
 * the commit when the call actually moved.
 */
export async function moveBooking(
  ctx: BookingContext,
  found: BookingRow,
  input: { start: Date; holdHash: string | null },
  options: MoveOptions,
): Promise<MoveResult> {
  const tenantId = tenantOf(ctx);
  const now = nowOf(ctx);
  if (!isChangeable(found, now)) throw options.notChangeable();
  const type = await typeById(ctx, found.typeId);
  if (!type) throw new BookingError("not_found");
  const previousStart = found.startUtc;
  const hosts = await poolHosts(ctx.db, tenantId, type);
  // The current host stays a candidate even if since removed from the pool.
  const current = await hostById(ctx, found.hostId);
  const candidates = current && !hosts.some((host) => host.id === current.id) && current.isActive ? [...hosts, current] : hosts;
  const external = await fetchExternalBusy(
    ctx,
    candidates,
    new Date(input.start.getTime() - DAY_MS),
    new Date(input.start.getTime() + DAY_MS),
  );
  const { holdHash } = input;

  const result = await ctx.db.transaction(async (tx) => {
    await lockHosts(tx, tenantId, [...candidates.map((host) => host.id), found.hostId]);
    const [fresh]: BookingRow[] = await tx
      .select()
      .from(bookingBookings)
      .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, found.id)))
      .limit(1);
    if (!fresh || !isChangeable(fresh, now)) throw options.notChangeable();
    if (fresh.startUtc.getTime() === input.start.getTime()) return { row: fresh, host: current, moved: false };

    const hold = holdHash ? await holdByTokenHash(tx, tenantId, holdHash) : null;
    const liveHold =
      hold &&
      hold.typeId === type.id &&
      hold.startUtc.getTime() === input.start.getTime() &&
      hold.holdExpiresAt !== null &&
      hold.holdExpiresAt.getTime() > now.getTime()
        ? hold
        : null;
    const free = await freeHostsAt({
      db: tx,
      tenantId,
      type,
      hosts: candidates,
      start: input.start,
      external,
      now,
      ...(liveHold ? { engineNow: liveHold.createdAt } : {}),
      excludeIds: [fresh.id, ...(hold ? [hold.id] : [])],
    });
    const host =
      free.find((candidate) => candidate.id === fresh.hostId) ??
      (liveHold ? free.find((candidate) => candidate.id === liveHold.hostId) : undefined) ??
      (await assignHost(tx, tenantId, free, now));
    if (!host) throw new BookingError(holdHash && !liveHold ? "hold_expired" : "slot_taken");

    if (hold) {
      await tx.delete(bookingBookings).where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, hold.id)));
      await deleteEventsFor(tx, tenantId, [hold.id]);
    }
    const [updated]: BookingRow[] = await tx
      .update(bookingBookings)
      .set({
        hostId: host.id,
        hostTimezone: host.timezone,
        startUtc: input.start,
        endUtc: new Date(input.start.getTime() + (fresh.endUtc.getTime() - fresh.startUtc.getTime())),
        sequence: fresh.sequence + 1,
        updatedAt: now,
      })
      .where(and(eq(bookingBookings.tenantId, tenantId), eq(bookingBookings.id, fresh.id)))
      .returning();
    if (!updated) throw new BookingError("not_found");
    await recordEvent(tx, {
      tenantId,
      bookingId: fresh.id,
      kind: "rescheduled",
      actor: options.actor,
      detail: {
        previousStart: fresh.startUtc.toISOString(),
        start: input.start.toISOString(),
        hostChanged: host.id !== fresh.hostId,
      },
      at: now,
    });
    return { row: updated, host, moved: true };
  });

  const host = result.host ?? (await hostById(ctx, result.row.hostId));
  if (!host) throw new BookingError("not_found");
  if (result.moved) {
    await emit(ctx, {
      event: "booking.rescheduled",
      tenantId,
      booking: toAdminBooking(result.row, host, type),
      host: eventHost(host),
      type: eventType(type),
      previousStart,
      by: options.actor,
      ...(options.manageToken ? { manageToken: options.manageToken } : {}),
    });
  }
  return { row: result.row, host, type, moved: result.moved };
}
