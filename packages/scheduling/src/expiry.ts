import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { emitEvents, type SchedulingEvent, type SchedulingEventListener } from "./events.js";
import { schedulingBookings } from "./schema.js";
import { getSchedulingSettings, type SchedulingSettings } from "./settings.js";
import type { BookingRow, SchedulingDb } from "./types.js";

export interface ExpirePendingRequestsOptions {
  now?: Date;
  onEvent?: SchedulingEventListener;
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /** Most requests one call expires. Default 100; the next call takes the rest. */
  limit?: number;
  settings?: SchedulingSettings;
}

/**
 * Release requests nobody answered in time: every `pending` visit whose
 * deadline (`pending_expires_at`) has passed — or, for a row from before 0.4
 * with no deadline, whose start has — becomes `expired`, `sequence + 1`, and
 * `visit.expired` is emitted for each (actor system, `notify: true`), so the
 * customer is told and can pick another time.
 *
 * The SLOT IS ALREADY FREE before this runs: an overdue request holds no time
 * from its deadline on (see `notOverdue`). This sweep is about telling people,
 * and about the calendar reading true — never about correctness.
 *
 * ONE STATEMENT: an UPDATE over a `FOR UPDATE SKIP LOCKED` subselect, so two
 * sweeps at once split the work instead of expiring a row twice, and a second
 * run is a no-op. It takes no crew lock — it only frees time — and its
 * `status = 'pending'` guard makes a concurrent accept lose cleanly: that
 * accept re-reads the visit as `expired` and restores it with re-validation.
 *
 * The cron calls it unthrottled; the handlers call it at most once a minute
 * per tenant (`sweepExpired`).
 */
export async function expirePendingRequests(
  db: SchedulingDb,
  tenantId: string,
  options: ExpirePendingRequestsOptions = {},
): Promise<{ expired: number; visitIds: string[] }> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)));
  const b = schedulingBookings;
  // The batch is a CTE, not an `IN (subquery)`: Postgres may run a plain
  // subquery once per outer row, and with LIMIT, SKIP LOCKED and tied
  // deadlines each run can pick different rows — one call expired more than
  // its limit. A CTE with FOR UPDATE is evaluated exactly once.
  const due = db.$with("due").as(
    db
      .select({ id: b.id })
      .from(b)
      .where(
        and(
          eq(b.tenantId, tenantId),
          eq(b.status, "pending"),
          or(lte(b.pendingExpiresAt, now), and(isNull(b.pendingExpiresAt), lte(b.startsAt, now))),
        ),
      )
      .orderBy(asc(b.pendingExpiresAt), asc(b.id))
      .limit(limit)
      .for("update", { skipLocked: true }),
  );
  // CONTRACT: `pending_expires_at` is kept on an expired visit (the contract's
  // statement sets only status, sequence and updated_at): it is when the
  // request lapsed, which the calendar shows.
  const rows = (await db
    .with(due)
    .update(b)
    .set({ status: "expired", sequence: sql`${b.sequence} + 1`, updatedAt: now })
    .where(and(eq(b.tenantId, tenantId), eq(b.status, "pending"), inArray(b.id, db.select({ id: due.id }).from(due))))
    .returning()) as BookingRow[];

  if (rows.length > 0 && options.onEvent) {
    const settings = options.settings ?? (await getSchedulingSettings(db, tenantId));
    await emitEvents(
      db,
      tenantId,
      rows.map((row) => ({ type: "visit.expired" as const, row, actor: { type: "system" as const, id: null }, notify: true })),
      { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
  }
  return { expired: rows.length, visitIds: rows.map((row) => row.id) };
}
