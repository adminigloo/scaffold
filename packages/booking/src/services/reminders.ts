/**
 * REMINDERS (0.2): the calls of ONE tenant starting soon whose reminder has
 * not gone yet, and the claim that makes each go at most once.
 *
 *   for (const due of await dueReminders(ctx, { withinMs: 24 * 3_600_000 })) {
 *     if (!(await claimReminder(ctx, due.booking.id))) continue; // another run took it
 *     const mail = bookingEmailVars(due, { baseUrl, includeManageLink: false });
 *     await send(mail.to.invitee, renderBookingTemplate(bookingEmailTemplate("booking_reminder"), mail.invitee));
 *   }
 *
 * A reminder carries no manage link (only its hash is stored): it says "the
 * private link in your booking confirmation" instead — see emails.ts. The
 * claim is written BEFORE the send, so a crash between the two loses one
 * reminder rather than sending two; a call that moves gets a new one
 * (move.ts clears the claim).
 */

import { and, asc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { bookingBookings, bookingHosts, bookingTypes } from "../schema.js";
import {
  eventHost,
  eventType,
  nowOf,
  tenantOf,
  toAdminBooking,
  type BookingContext,
  type BookingRow,
  type DueReminder,
  type HostRow,
  type TypeRow,
} from "./context.js";

export type { DueReminder } from "./context.js";

/**
 * Confirmed calls of this tenant that start after now and within `withinMs`,
 * soonest first, whose reminder is unclaimed. Requested calls get none (the
 * host hasn't said yes), nor do calls with no email to send it to.
 */
export async function dueReminders(
  ctx: BookingContext,
  input: { withinMs: number; limit?: number },
): Promise<DueReminder[]> {
  const tenantId = tenantOf(ctx);
  const now = nowOf(ctx);
  const rows: BookingRow[] = await ctx.db
    .select()
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        eq(bookingBookings.status, "confirmed"),
        gt(bookingBookings.startUtc, now),
        lte(bookingBookings.startUtc, new Date(now.getTime() + Math.max(0, input.withinMs))),
        isNull(bookingBookings.remindedAt),
        lt(bookingBookings.reminderAttempts, MAX_REMINDER_ATTEMPTS),
      ),
    )
    .orderBy(asc(bookingBookings.startUtc))
    .limit(Math.min(Math.max(1, input.limit ?? 100), 500));
  const withEmail = rows.filter((row) => row.inviteeEmail);
  if (withEmail.length === 0) return [];
  const [hosts, types]: [HostRow[], TypeRow[]] = await Promise.all([
    ctx.db
      .select()
      .from(bookingHosts)
      .where(and(eq(bookingHosts.tenantId, tenantId), inArray(bookingHosts.id, [...new Set(withEmail.map((row) => row.hostId))]))),
    ctx.db
      .select()
      .from(bookingTypes)
      .where(and(eq(bookingTypes.tenantId, tenantId), inArray(bookingTypes.id, [...new Set(withEmail.map((row) => row.typeId))]))),
  ]);
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const typeById = new Map(types.map((type) => [type.id, type]));
  const due: DueReminder[] = [];
  for (const row of withEmail) {
    const host = hostById.get(row.hostId);
    const type = typeById.get(row.typeId);
    if (!host || !type) continue;
    due.push({ event: "booking.reminder", tenantId, booking: toAdminBooking(row, host, type), host: eventHost(host), type: eventType(type) });
  }
  return due;
}

/** Tries at one call's reminder before it's given up (0.2). */
export const MAX_REMINDER_ATTEMPTS = 3;

/**
 * Give a claimed reminder back after its send failed or was skipped (0.2):
 * the claim is cleared and the attempt counted, so the next run tries again,
 * up to MAX_REMINDER_ATTEMPTS.
 */
export async function releaseReminder(ctx: BookingContext, bookingId: string): Promise<void> {
  await ctx.db
    .update(bookingBookings)
    .set({ remindedAt: null, reminderAttempts: sql`${bookingBookings.reminderAttempts} + 1` })
    .where(and(eq(bookingBookings.tenantId, tenantOf(ctx)), eq(bookingBookings.id, bookingId)));
}

/** Claim one call's reminder: true for the one caller that gets to send it, false once anyone has. */
export async function claimReminder(ctx: BookingContext, bookingId: string): Promise<boolean> {
  const claimed: Array<{ id: string }> = await ctx.db
    .update(bookingBookings)
    .set({ remindedAt: nowOf(ctx) })
    .where(
      and(
        eq(bookingBookings.tenantId, tenantOf(ctx)),
        eq(bookingBookings.id, bookingId),
        eq(bookingBookings.status, "confirmed"),
        isNull(bookingBookings.remindedAt),
      ),
    )
    .returning({ id: bookingBookings.id });
  return claimed.length > 0;
}
