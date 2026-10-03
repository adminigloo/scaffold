/**
 * Sandbox and housekeeping: the functions a cron or a demo page calls, not a
 * prospect.
 *
 * THE SANDBOX MODEL. A marketing page can give every visitor their own
 * throwaway tenant ("demo-<random>"), seeded with a host, a week and a type,
 * and point the handler factory at it with `sandbox: true`. Because every
 * read and write in this package is tenant-scoped, a visitor can book, move
 * and cancel to their heart's content and touch nothing real — and because
 * the factory never calls `onEvent` or the busy source in sandbox mode,
 * nobody is emailed and no real calendar is read. `purgeTenants` sweeps the
 * leftovers.
 */

import { and, eq, inArray, like, lt, max, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { BookingError, issuesFrom } from "../errors.js";
import { emailSchema, httpsUrlSchema, phoneSchema, timeZoneSchema } from "../fields.js";
import {
  bookingAvailability,
  bookingBlackouts,
  bookingBookings,
  bookingEvents,
  bookingExceptions,
  bookingHosts,
  bookingTypes,
} from "../schema.js";
import type { BookingDb, HostRow } from "./context.js";
import { setWeeklyAvailabilitySchema, upsertTypeSchema } from "./admin.js";

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BookingError("invalid", "Some details need another look.", issuesFrom(result.error));
  return result.data;
}

export const seedSandboxTenantSchema = z.object({
  tenantId: z.string().min(1).max(200),
  /** No calendar address on purpose: a sandbox never reads a real calendar. */
  host: z.object({
    displayName: z.string().trim().min(1).max(120),
    email: emailSchema,
    timezone: timeZoneSchema,
    meetingLink: httpsUrlSchema.nullish(),
    phone: phoneSchema.nullish(),
    inviteMailbox: emailSchema.nullish(),
    autoConfirm: z.boolean().optional(),
  }),
  weekly: setWeeklyAvailabilitySchema.shape.windows,
  types: z.array(upsertTypeSchema.omit({ id: true, hostIds: true })).min(1).max(10),
});
export type SeedSandboxTenantInput = z.input<typeof seedSandboxTenantSchema>;

/**
 * Give a tenant a host, a week and its types — once. Idempotent under
 * concurrency: an advisory lock on the tenant serialises two first requests,
 * and a tenant that already has a host is returned as it is (a visitor who
 * reloads keeps their own bookings).
 *
 * `options.now` stamps the new rows (default: the database's clock), so a
 * caller with an injected clock — the sandbox wrapper, whose lifetime is
 * measured from the host row — ages sandboxes by the same clock it checks.
 */
export async function seedSandboxTenant(
  db: BookingDb,
  input: SeedSandboxTenantInput,
  options: { now?: Date } = {},
): Promise<{ hostId: string; typeKeys: string[]; created: boolean }> {
  const parsed = parse(seedSandboxTenantSchema, input);
  const { tenantId } = parsed;
  const stamp = options.now ? { createdAt: options.now, updatedAt: options.now } : {};
  const created = options.now ? { createdAt: options.now } : {};
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking-seed:${tenantId}`}))`);
    const existing: Array<Pick<HostRow, "id">> = await tx
      .select({ id: bookingHosts.id })
      .from(bookingHosts)
      .where(eq(bookingHosts.tenantId, tenantId))
      .limit(1);
    if (existing[0]) {
      const types: Array<{ key: string }> = await tx
        .select({ key: bookingTypes.key })
        .from(bookingTypes)
        .where(eq(bookingTypes.tenantId, tenantId));
      return { hostId: existing[0].id, typeKeys: types.map((type) => type.key), created: false };
    }
    const [host]: Array<Pick<HostRow, "id">> = await tx
      .insert(bookingHosts)
      .values({
        tenantId,
        displayName: parsed.host.displayName,
        email: parsed.host.email,
        timezone: parsed.host.timezone,
        meetingLink: parsed.host.meetingLink ?? null,
        phone: parsed.host.phone ?? null,
        inviteMailbox: parsed.host.inviteMailbox ?? null,
        autoConfirm: parsed.host.autoConfirm ?? true,
        ...stamp,
      })
      .returning({ id: bookingHosts.id });
    if (!host) throw new Error("sandbox host insert returned no row");
    if (parsed.weekly.length > 0) {
      await tx
        .insert(bookingAvailability)
        .values(parsed.weekly.map((window) => ({ tenantId, hostId: host.id, ...window, ...created })));
    }
    for (const type of parsed.types) {
      await tx
        .insert(bookingTypes)
        .values({
          tenantId,
          key: type.key,
          name: type.name,
          description: type.description ?? null,
          durationMinutes: type.durationMinutes,
          bufferBeforeMinutes: type.bufferBeforeMinutes,
          bufferAfterMinutes: type.bufferAfterMinutes,
          stepMinutes: type.stepMinutes,
          minNoticeMinutes: type.minNoticeMinutes,
          horizonDays: type.horizonDays,
          maxPerDay: type.maxPerDay ?? null,
          media: type.media,
          hostIds: [],
          isActive: type.isActive,
          sortOrder: type.sortOrder,
          ...stamp,
        })
        .onConflictDoNothing();
    }
    return { hostId: host.id, typeKeys: parsed.types.map((type) => type.key), created: true };
  });
}

/** `%` and `_` in a prefix are literal characters, not wildcards. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

const ACTIVITY: Array<{ table: PgTable; tenant: PgColumn; at: PgColumn }> = [
  { table: bookingHosts, tenant: bookingHosts.tenantId, at: bookingHosts.updatedAt },
  { table: bookingTypes, tenant: bookingTypes.tenantId, at: bookingTypes.updatedAt },
  { table: bookingBookings, tenant: bookingBookings.tenantId, at: bookingBookings.updatedAt },
  { table: bookingEvents, tenant: bookingEvents.tenantId, at: bookingEvents.at },
  { table: bookingAvailability, tenant: bookingAvailability.tenantId, at: bookingAvailability.createdAt },
  { table: bookingExceptions, tenant: bookingExceptions.tenantId, at: bookingExceptions.createdAt },
  { table: bookingBlackouts, tenant: bookingBlackouts.tenantId, at: bookingBlackouts.createdAt },
];

/** Children before parents, so the intra-package FKs never object. */
const PURGE_ORDER: Array<{ table: PgTable; tenant: PgColumn }> = [
  { table: bookingEvents, tenant: bookingEvents.tenantId },
  { table: bookingBookings, tenant: bookingBookings.tenantId },
  { table: bookingExceptions, tenant: bookingExceptions.tenantId },
  { table: bookingAvailability, tenant: bookingAvailability.tenantId },
  { table: bookingBlackouts, tenant: bookingBlackouts.tenantId },
  { table: bookingTypes, tenant: bookingTypes.tenantId },
  { table: bookingHosts, tenant: bookingHosts.tenantId },
];

export const purgeTenantsSchema = z.object({
  /** Required and at least 3 characters: an empty prefix would mean "every tenant". */
  prefix: z.string().min(3).max(100),
  olderThan: z.date(),
  /** Tenants deleted per transaction. */
  batchSize: z.number().int().min(1).max(1000).default(100),
});

/**
 * Delete every booking_* row of every tenant whose id starts with `prefix`
 * and whose NEWEST activity across all booking tables is older than
 * `olderThan` — so a sandbox someone is still clicking around in survives the
 * sweep, however old its first row is. Batched: `batchSize` tenants per
 * transaction. Returns how many tenants were removed.
 */
export async function purgeTenants(
  db: BookingDb,
  input: z.input<typeof purgeTenantsSchema>,
): Promise<{ tenants: number }> {
  const { prefix, olderThan, batchSize } = parse(purgeTenantsSchema, input);
  const pattern = likePrefix(prefix);
  const newest = new Map<string, number>();
  for (const { table, tenant, at } of ACTIVITY) {
    // `max()` of a timestamp maps back to a Date on most drivers; read both shapes.
    const rows = (await db
      .select({ tenantId: tenant, last: max(at) })
      .from(table)
      .where(like(tenant, pattern))
      .groupBy(tenant)) as Array<{ tenantId: string; last: Date | string | null }>;
    for (const row of rows) {
      if (row.last === null) continue;
      const ms = new Date(row.last).getTime();
      if (ms > (newest.get(row.tenantId) ?? Number.NEGATIVE_INFINITY)) newest.set(row.tenantId, ms);
    }
  }
  const stale = [...newest.entries()]
    .filter(([tenantId, last]) => tenantId.startsWith(prefix) && last < olderThan.getTime())
    .map(([tenantId]) => tenantId);
  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    await db.transaction(async (tx) => {
      for (const { table, tenant } of PURGE_ORDER) {
        await tx.delete(table).where(inArray(tenant, batch) as SQL);
      }
    });
  }
  return { tenants: stale.length };
}

export const purgeExpiredHoldsSchema = z.object({
  tenantId: z.string().min(1).max(200).optional(),
  /** Holds whose expiry is before this instant are deleted (with their audit rows). */
  olderThan: z.date(),
});

/**
 * Delete abandoned holds. They already free their time the moment they
 * expire (every busy check ignores them); this only keeps the table small.
 * Never turns them into cancellations — an abandoned form is not a cancelled
 * call. Omit `tenantId` to sweep every tenant from one cron.
 */
export async function purgeExpiredHolds(
  db: BookingDb,
  input: z.input<typeof purgeExpiredHoldsSchema>,
): Promise<{ deleted: number }> {
  const { tenantId, olderThan } = parse(purgeExpiredHoldsSchema, input);
  return db.transaction(async (tx) => {
    const removed: Array<{ id: string; tenantId: string }> = await tx
      .delete(bookingBookings)
      .where(
        and(
          eq(bookingBookings.status, "hold"),
          lt(bookingBookings.holdExpiresAt, olderThan),
          tenantId ? eq(bookingBookings.tenantId, tenantId) : undefined,
        ),
      )
      .returning({ id: bookingBookings.id, tenantId: bookingBookings.tenantId });
    for (let i = 0; i < removed.length; i += 500) {
      const ids = removed.slice(i, i + 500).map((row) => row.id);
      await tx.delete(bookingEvents).where(inArray(bookingEvents.bookingId, ids));
    }
    return { deleted: removed.length };
  });
}
